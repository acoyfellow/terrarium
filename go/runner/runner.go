// Package runner is a prototype Go process runner for Terrarium's core
// migration (shard 2). It owns a single bounded task: spawn one command,
// capture stdout/stderr, honor a timeout / cancellation context, and persist a
// run JSON record plus a run log under TERRARIUM_HOME.
//
// This mirrors the existing Node core layout:
//
//	$TERRARIUM_HOME/runs/<runId>.json   terminal run metadata
//	$TERRARIUM_HOME/runs/<runId>.log    streamed stdout/stderr + header/footer
//
// It is a prototype only. It is not wired into deployment and intentionally
// keeps the one-child-per-run contract: one Run produces one correlated
// receipt (the run JSON).
package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// Status enumerates the terminal states a run can finish in.
type Status string

const (
	// StatusDone is a clean exit (exit code 0).
	StatusDone Status = "done"
	// StatusError is a non-zero exit or a spawn/runtime failure.
	StatusError Status = "error"
	// StatusTimeout is a deadline exceeded before the child exited.
	StatusTimeout Status = "timeout"
	// StatusCancelled is an explicit context cancellation before exit.
	StatusCancelled Status = "cancelled"
)

// Spec describes one bounded task to run.
type Spec struct {
	// RunID correlates the child process, log, and run JSON. Required.
	RunID string
	// Command is the executable and its arguments. Command[0] is the binary.
	Command []string
	// Cwd is the working directory for the child. Defaults to the current
	// process working directory when empty.
	Cwd string
	// Env is the environment for the child. When nil the parent environment is
	// inherited.
	Env []string
	// Timeout bounds the child's wall-clock runtime. Zero means no timeout.
	Timeout time.Duration
	// Task is the human-readable objective, recorded in the run JSON.
	Task string
}

// Result is the terminal receipt for a run. It is the in-memory twin of the
// persisted run JSON.
type Result struct {
	RunID      string    `json:"runId"`
	Task       string    `json:"task,omitempty"`
	Command    []string  `json:"command"`
	Cwd        string    `json:"cwd"`
	Status     Status    `json:"status"`
	OK         bool      `json:"ok"`
	ExitCode   int       `json:"exitCode"`
	Signal     string    `json:"signal,omitempty"`
	Error      string    `json:"error,omitempty"`
	StdoutTail string    `json:"stdoutTail"`
	StderrTail string    `json:"stderrTail"`
	StartedAt  time.Time `json:"startedAt"`
	FinishedAt time.Time `json:"finishedAt"`
	DurationMs int64     `json:"durationMs"`
	LogPath    string    `json:"logPath"`
	JSONPath   string    `json:"jsonPath"`
}

// tailBytes caps how much stdout/stderr is retained in the receipt tails.
const tailBytes = 16 * 1024

// Home resolves TERRARIUM_HOME, falling back to ~/.terrarium, mirroring the
// Node core resolution.
func Home() string {
	if h := os.Getenv("TERRARIUM_HOME"); h != "" {
		abs, err := filepath.Abs(h)
		if err == nil {
			return abs
		}
		return h
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".terrarium"
	}
	return filepath.Join(home, ".terrarium")
}

// LogDir returns $TERRARIUM_HOME/runs.
func LogDir() string { return filepath.Join(Home(), "runs") }

// LogPath returns the run log path for a given run ID.
func LogPath(runID string) string { return filepath.Join(LogDir(), runID+".log") }

// JSONPath returns the run JSON path for a given run ID.
func JSONPath(runID string) string { return filepath.Join(LogDir(), runID+".json") }

// Run spawns the spec's command, streams its output to the run log, captures
// tails for the receipt, honors the spec timeout and the supplied context for
// cancellation, then persists the run JSON. It always attempts to persist a
// terminal receipt, even on spawn failure.
func Run(ctx context.Context, spec Spec) (*Result, error) {
	if spec.RunID == "" {
		return nil, errors.New("runner: RunID is required")
	}
	if len(spec.Command) == 0 {
		return nil, errors.New("runner: Command is required")
	}
	if ctx == nil {
		ctx = context.Background()
	}

	cwd := spec.Cwd
	if cwd == "" {
		if wd, err := os.Getwd(); err == nil {
			cwd = wd
		}
	}

	if err := os.MkdirAll(LogDir(), 0o755); err != nil {
		return nil, fmt.Errorf("runner: create run dir: %w", err)
	}

	logPath := LogPath(spec.RunID)
	jsonPath := JSONPath(spec.RunID)

	logFile, err := os.Create(logPath)
	if err != nil {
		return nil, fmt.Errorf("runner: create log: %w", err)
	}
	defer logFile.Close()

	startedAt := time.Now().UTC()
	header := fmt.Sprintf("terrarium-go\nrun: %s\ntask: %s\ncommand: %v\ncwd: %s\nlog: %s\n\n",
		spec.RunID, spec.Task, spec.Command, cwd, logPath)
	if _, err := logFile.WriteString(header); err != nil {
		return nil, fmt.Errorf("runner: write log header: %w", err)
	}

	// Apply timeout on top of the caller's context. The merged context drives
	// both timeout and explicit cancellation.
	runCtx := ctx
	var cancel context.CancelFunc
	if spec.Timeout > 0 {
		runCtx, cancel = context.WithTimeout(ctx, spec.Timeout)
		defer cancel()
	}

	cmd := exec.CommandContext(runCtx, spec.Command[0], spec.Command[1:]...)
	cmd.Dir = cwd
	if spec.Env != nil {
		cmd.Env = spec.Env
	}

	// Capture bounded tails while teeing everything to the log file.
	var outTail, errTail tailWriter
	outTail.limit, errTail.limit = tailBytes, tailBytes
	cmd.Stdout = newTee(logFile, &outTail)
	cmd.Stderr = newTee(logFile, &errTail)

	result := &Result{
		RunID:     spec.RunID,
		Task:      spec.Task,
		Command:   spec.Command,
		Cwd:       cwd,
		StartedAt: startedAt,
		LogPath:   logPath,
		JSONPath:  jsonPath,
	}

	runErr := cmd.Run()
	finishedAt := time.Now().UTC()
	result.FinishedAt = finishedAt
	result.DurationMs = finishedAt.Sub(startedAt).Milliseconds()
	result.StdoutTail = outTail.String()
	result.StderrTail = errTail.String()

	classify(result, runCtx, ctx, runErr)

	footer := fmt.Sprintf("\nexit: %d%s status: %s\n", result.ExitCode, signalSuffix(result.Signal), result.Status)
	_, _ = logFile.WriteString(footer)

	if err := persist(jsonPath, result); err != nil {
		return result, fmt.Errorf("runner: persist run json: %w", err)
	}
	return result, nil
}

// classify maps the command outcome and context state to a terminal status.
func classify(r *Result, runCtx, parentCtx context.Context, runErr error) {
	switch {
	case runErr == nil:
		r.Status = StatusDone
		r.OK = true
		r.ExitCode = 0
		return
	case parentCtx.Err() == context.Canceled:
		// Explicit cancel from the caller takes precedence over a timeout that
		// may have fired concurrently.
		r.Status = StatusCancelled
		r.ExitCode = exitCodeFrom(runErr, 130)
	case errors.Is(runCtx.Err(), context.DeadlineExceeded):
		r.Status = StatusTimeout
		r.ExitCode = exitCodeFrom(runErr, 124)
	default:
		r.Status = StatusError
		r.ExitCode = exitCodeFrom(runErr, 1)
	}
	r.OK = false

	var exitErr *exec.ExitError
	if errors.As(runErr, &exitErr) {
		if sig := signalOf(exitErr); sig != "" {
			r.Signal = sig
		}
		// A real exit code overrides the status default when the process
		// actually ran and exited.
		if exitErr.ExitCode() >= 0 && r.Status == StatusError {
			r.ExitCode = exitErr.ExitCode()
		}
	} else {
		// Spawn failure (e.g. binary not found): record the error message.
		r.Error = runErr.Error()
	}
}

func exitCodeFrom(err error, fallback int) int {
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() >= 0 {
		return exitErr.ExitCode()
	}
	return fallback
}

func signalSuffix(sig string) string {
	if sig == "" {
		return ""
	}
	return " signal: " + sig
}

func persist(path string, r *Result) error {
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	// Atomic-ish: write to temp then rename, mirroring the Node core's
	// write-then-rename discipline.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// tee writes to all underlying writers, used to stream child output to the log
// while accumulating a bounded tail.
type tee struct{ ws []writer }

type writer interface{ Write(p []byte) (int, error) }

func newTee(ws ...writer) *tee { return &tee{ws: ws} }

func (t *tee) Write(p []byte) (int, error) {
	for _, w := range t.ws {
		if _, err := w.Write(p); err != nil {
			return 0, err
		}
	}
	return len(p), nil
}

// tailWriter retains only the last `limit` bytes written to it.
type tailWriter struct {
	buf   bytes.Buffer
	limit int
}

func (t *tailWriter) Write(p []byte) (int, error) {
	t.buf.Write(p)
	if t.limit > 0 && t.buf.Len() > t.limit {
		over := t.buf.Len() - t.limit
		t.buf.Next(over)
	}
	return len(p), nil
}

func (t *tailWriter) String() string { return t.buf.String() }
