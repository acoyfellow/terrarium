package runner

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// withTempHome points TERRARIUM_HOME at a fresh temp dir for the duration of a
// test and returns the path.
func withTempHome(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("TERRARIUM_HOME", dir)
	return dir
}

func readResultJSON(t *testing.T, path string) *Result {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read run json: %v", err)
	}
	var r Result
	if err := json.Unmarshal(data, &r); err != nil {
		t.Fatalf("unmarshal run json (%s): %v", string(data), err)
	}
	return &r
}

func TestHomeResolution(t *testing.T) {
	dir := withTempHome(t)
	if got := Home(); got != dir {
		t.Fatalf("Home() = %q, want %q", got, dir)
	}
	if got, want := LogDir(), filepath.Join(dir, "runs"); got != want {
		t.Fatalf("LogDir() = %q, want %q", got, want)
	}
	if got, want := LogPath("abc"), filepath.Join(dir, "runs", "abc.log"); got != want {
		t.Fatalf("LogPath() = %q, want %q", got, want)
	}
	if got, want := JSONPath("abc"), filepath.Join(dir, "runs", "abc.json"); got != want {
		t.Fatalf("JSONPath() = %q, want %q", got, want)
	}
}

func TestHomeDefaultsToTerrarium(t *testing.T) {
	t.Setenv("TERRARIUM_HOME", "")
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no user home dir")
	}
	if got, want := Home(), filepath.Join(home, ".terrarium"); got != want {
		t.Fatalf("Home() = %q, want %q", got, want)
	}
}

func TestRunSuccessCapturesOutputAndPersists(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses sh")
	}
	withTempHome(t)
	res, err := Run(context.Background(), Spec{
		RunID:   "ok-run",
		Task:    "echo hello",
		Command: []string{"sh", "-c", "echo out-line; echo err-line 1>&2"},
	})
	if err != nil {
		t.Fatalf("Run error: %v", err)
	}
	if res.Status != StatusDone || !res.OK || res.ExitCode != 0 {
		t.Fatalf("unexpected terminal: status=%s ok=%v code=%d", res.Status, res.OK, res.ExitCode)
	}
	if !strings.Contains(res.StdoutTail, "out-line") {
		t.Fatalf("stdout tail missing: %q", res.StdoutTail)
	}
	if !strings.Contains(res.StderrTail, "err-line") {
		t.Fatalf("stderr tail missing: %q", res.StderrTail)
	}
	if res.DurationMs < 0 {
		t.Fatalf("negative duration: %d", res.DurationMs)
	}

	// Log file exists and contains header + streamed output + footer.
	logData, err := os.ReadFile(res.LogPath)
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	logStr := string(logData)
	for _, want := range []string{"run: ok-run", "out-line", "err-line", "status: done"} {
		if !strings.Contains(logStr, want) {
			t.Fatalf("log missing %q in:\n%s", want, logStr)
		}
	}

	// Persisted run JSON matches the returned receipt.
	persisted := readResultJSON(t, res.JSONPath)
	if persisted.RunID != "ok-run" || persisted.Status != StatusDone || !persisted.OK {
		t.Fatalf("persisted mismatch: %+v", persisted)
	}
	// No leftover temp file.
	if _, err := os.Stat(res.JSONPath + ".tmp"); !os.IsNotExist(err) {
		t.Fatalf("temp json not cleaned up")
	}
}

func TestRunNonZeroExitIsError(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses sh")
	}
	withTempHome(t)
	res, err := Run(context.Background(), Spec{
		RunID:   "fail-run",
		Command: []string{"sh", "-c", "echo boom 1>&2; exit 3"},
	})
	if err != nil {
		t.Fatalf("Run error: %v", err)
	}
	if res.Status != StatusError || res.OK || res.ExitCode != 3 {
		t.Fatalf("unexpected: status=%s ok=%v code=%d", res.Status, res.OK, res.ExitCode)
	}
	if !strings.Contains(res.StderrTail, "boom") {
		t.Fatalf("stderr tail missing boom: %q", res.StderrTail)
	}
	persisted := readResultJSON(t, res.JSONPath)
	if persisted.ExitCode != 3 || persisted.Status != StatusError {
		t.Fatalf("persisted mismatch: %+v", persisted)
	}
}

func TestRunTimeout(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses sleep")
	}
	withTempHome(t)
	start := time.Now()
	res, err := Run(context.Background(), Spec{
		RunID:   "timeout-run",
		Command: []string{"sleep", "10"},
		Timeout: 100 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("Run error: %v", err)
	}
	if res.Status != StatusTimeout || res.OK {
		t.Fatalf("expected timeout, got status=%s ok=%v", res.Status, res.OK)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("timeout did not fire promptly: %v", elapsed)
	}
	persisted := readResultJSON(t, res.JSONPath)
	if persisted.Status != StatusTimeout {
		t.Fatalf("persisted status = %s, want timeout", persisted.Status)
	}
}

func TestRunCancel(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses sleep")
	}
	withTempHome(t)
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(100 * time.Millisecond)
		cancel()
	}()
	res, err := Run(ctx, Spec{
		RunID:   "cancel-run",
		Command: []string{"sleep", "10"},
	})
	if err != nil {
		t.Fatalf("Run error: %v", err)
	}
	if res.Status != StatusCancelled || res.OK {
		t.Fatalf("expected cancelled, got status=%s ok=%v", res.Status, res.OK)
	}
	persisted := readResultJSON(t, res.JSONPath)
	if persisted.Status != StatusCancelled {
		t.Fatalf("persisted status = %s, want cancelled", persisted.Status)
	}
}

func TestRunCancelTakesPrecedenceOverTimeout(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses sleep")
	}
	withTempHome(t)
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()
	// Timeout is generous; cancel should win.
	res, err := Run(ctx, Spec{
		RunID:   "cancel-precedence",
		Command: []string{"sleep", "10"},
		Timeout: 30 * time.Second,
	})
	if err != nil {
		t.Fatalf("Run error: %v", err)
	}
	if res.Status != StatusCancelled {
		t.Fatalf("expected cancelled to win, got %s", res.Status)
	}
}

func TestRunSpawnFailure(t *testing.T) {
	withTempHome(t)
	res, err := Run(context.Background(), Spec{
		RunID:   "nobin-run",
		Command: []string{"this-binary-does-not-exist-xyz"},
	})
	if err != nil {
		t.Fatalf("Run error: %v", err)
	}
	if res.Status != StatusError || res.OK {
		t.Fatalf("expected error, got status=%s ok=%v", res.Status, res.OK)
	}
	if res.Error == "" {
		t.Fatalf("expected spawn error message")
	}
	// Receipt is still persisted on spawn failure.
	if _, statErr := os.Stat(res.JSONPath); statErr != nil {
		t.Fatalf("run json not persisted on spawn failure: %v", statErr)
	}
}

func TestRunValidation(t *testing.T) {
	withTempHome(t)
	if _, err := Run(context.Background(), Spec{Command: []string{"echo"}}); err == nil {
		t.Fatal("expected error for missing RunID")
	}
	if _, err := Run(context.Background(), Spec{RunID: "x"}); err == nil {
		t.Fatal("expected error for missing Command")
	}
}

func TestRunRespectsCwdAndEnv(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses sh")
	}
	withTempHome(t)
	workdir := t.TempDir()
	res, err := Run(context.Background(), Spec{
		RunID:   "cwd-env-run",
		Command: []string{"sh", "-c", "pwd; echo $TERRARIUM_PROBE"},
		Cwd:     workdir,
		Env:     append(os.Environ(), "TERRARIUM_PROBE=probe-value"),
	})
	if err != nil {
		t.Fatalf("Run error: %v", err)
	}
	// macOS /tmp symlinks to /private/tmp; compare resolved paths.
	wantCwd, _ := filepath.EvalSymlinks(workdir)
	gotCwd, _ := filepath.EvalSymlinks(strings.TrimSpace(strings.SplitN(res.StdoutTail, "\n", 2)[0]))
	if gotCwd != wantCwd {
		t.Fatalf("cwd = %q, want %q", gotCwd, wantCwd)
	}
	if !strings.Contains(res.StdoutTail, "probe-value") {
		t.Fatalf("env not applied: %q", res.StdoutTail)
	}
}

func TestTailWriterBounds(t *testing.T) {
	var tw tailWriter
	tw.limit = 10
	if _, err := tw.Write([]byte("0123456789ABCDEF")); err != nil {
		t.Fatalf("write: %v", err)
	}
	got := tw.String()
	if len(got) != 10 || got != "6789ABCDEF" {
		t.Fatalf("tail = %q (len %d), want last 10 bytes", got, len(got))
	}
}

func TestRunStdoutTailTruncation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses sh")
	}
	withTempHome(t)
	// Emit more than tailBytes; tail must be capped, full log retained.
	res, err := Run(context.Background(), Spec{
		RunID:   "big-out",
		Command: []string{"sh", "-c", "for i in $(seq 1 5000); do echo line-$i; done"},
	})
	if err != nil {
		t.Fatalf("Run error: %v", err)
	}
	if len(res.StdoutTail) > tailBytes {
		t.Fatalf("stdout tail exceeded cap: %d > %d", len(res.StdoutTail), tailBytes)
	}
	// Full output is preserved in the log file.
	info, err := os.Stat(res.LogPath)
	if err != nil {
		t.Fatalf("stat log: %v", err)
	}
	if info.Size() <= int64(tailBytes) {
		t.Fatalf("log unexpectedly small: %d", info.Size())
	}
}
