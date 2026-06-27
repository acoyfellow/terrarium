// Package protocol defines the JSON command protocol for the Go core CLI.
//
// Shard 1 implements three read-only / inert commands: dry-run, status, and
// version. The protocol is intentionally a thin, stable envelope so TS adapters
// can call the Go core over stdin/stdout without coupling to internals.
package protocol

import (
	"encoding/json"
	"fmt"
	"io"

	"github.com/cloudflare/terrarium/internal/run"
)

// Version strings mirror src/versions.js. Keep in lockstep across cores.
const (
	APIVersion  = "terrarium-api-2026-06-26"
	CoreVersion = "terrarium-go-core-2026-06-27.shard1"
)

// CommandType enumerates the supported commands in shard 1.
type CommandType string

const (
	CmdDryRun  CommandType = "dry-run"
	CmdStatus  CommandType = "status"
	CmdVersion CommandType = "version"
	CmdReplay  CommandType = "replay"
)

// Command is the JSON request envelope read from stdin.
type Command struct {
	Command CommandType `json:"command"`
	// DryRun fields.
	Task           string   `json:"task,omitempty"`
	Agent          string   `json:"agent,omitempty"`
	Args           []string `json:"args,omitempty"`
	Cwd            string   `json:"cwd,omitempty"`
	RequireReceipt *bool    `json:"requireReceipt,omitempty"`
	// Status fields.
	RunID string `json:"runId,omitempty"`
	// Replay fields: an ordered sequence of already-observed inputs driven
	// through the pure run machine. Inert: no clocks, processes, or I/O.
	Inputs []ReplayInput `json:"inputs,omitempty"`
}

// ReplayInput is the JSON shape of one observed run input for the replay
// command. It mirrors the input objects accepted by transition() in
// src/run-machine.js so the same sequence can drive both cores.
type ReplayInput struct {
	Type     string  `json:"type"`
	ExitCode *int    `json:"exitCode,omitempty"`
	Signal   *string `json:"signal,omitempty"`
	Status   string  `json:"status,omitempty"`
	Summary  *string `json:"summary,omitempty"`
	Error    string  `json:"error,omitempty"`
}

// Response is the JSON response envelope written to stdout.
type Response struct {
	OK         bool        `json:"ok"`
	Command    CommandType `json:"command"`
	APIVersion string      `json:"apiVersion"`
	Error      string      `json:"error,omitempty"`
	// Command-specific payloads.
	DryRun  *DryRunPayload  `json:"dryRun,omitempty"`
	Status  *StatusPayload  `json:"status,omitempty"`
	Version *VersionPayload `json:"version,omitempty"`
	Replay  *ReplayPayload  `json:"replay,omitempty"`
}

// ReplayPayload is the deterministic result of driving a fixed input sequence
// through the pure run machine. It carries the final state plus the decision
// list emitted at each step, so a TS conformance harness can assert the Go and
// TS cores agree byte-for-byte on the same sequence.
type ReplayPayload struct {
	MachineVer int                `json:"machineVersion"`
	Steps      []ReplayStep       `json:"steps"`
	FinalState run.State          `json:"finalState"`
	Terminal   *run.TerminalState `json:"terminal"`
}

// ReplayStep records the decisions emitted by one applied input.
type ReplayStep struct {
	Input     string         `json:"input"`
	Decisions []run.Decision `json:"decisions"`
}

// DryRunPayload describes the child invocation that would run, without running
// it. It mirrors the inert --dry-run behavior of the TS CLI.
type DryRunPayload struct {
	Task           string    `json:"task"`
	Agent          string    `json:"agent"`
	Args           []string  `json:"args"`
	Cwd            string    `json:"cwd"`
	RequireReceipt bool      `json:"requireReceipt"`
	InitialState   run.State `json:"initialState"`
}

// StatusPayload is a minimal status projection. Shard 1 has no persistent
// store, so it returns the initial running state for the requested run id.
type StatusPayload struct {
	RunID string    `json:"runId"`
	Phase run.Phase `json:"phase"`
	State run.State `json:"state"`
}

// VersionPayload reports core/protocol versions.
type VersionPayload struct {
	Core       string `json:"core"`
	API        string `json:"api"`
	MachineVer int    `json:"machineVersion"`
	Protocol   string `json:"protocol"`
}

// DefaultAgent is the documented default child runner.
const DefaultAgent = "opencode run"

// Handle dispatches one command and returns a Response. It never performs I/O
// beyond what each inert command requires (none in shard 1).
func Handle(cmd Command) Response {
	switch cmd.Command {
	case CmdDryRun:
		return handleDryRun(cmd)
	case CmdStatus:
		return handleStatus(cmd)
	case CmdVersion:
		return handleVersion()
	case CmdReplay:
		return handleReplay(cmd)
	case "":
		return errResponse(cmd.Command, "missing command")
	default:
		return errResponse(cmd.Command, fmt.Sprintf("unknown command %q", cmd.Command))
	}
}

func handleDryRun(cmd Command) Response {
	if cmd.Task == "" {
		return errResponse(CmdDryRun, "dry-run requires a non-empty task")
	}
	agent := cmd.Agent
	if agent == "" {
		agent = DefaultAgent
	}
	requireReceipt := true
	if cmd.RequireReceipt != nil {
		requireReceipt = *cmd.RequireReceipt
	}
	cwd := cmd.Cwd
	if cwd == "" {
		cwd = "."
	}
	args := cmd.Args
	if args == nil {
		args = []string{}
	}
	return Response{
		OK:         true,
		Command:    CmdDryRun,
		APIVersion: APIVersion,
		DryRun: &DryRunPayload{
			Task:           cmd.Task,
			Agent:          agent,
			Args:           args,
			Cwd:            cwd,
			RequireReceipt: requireReceipt,
			InitialState:   run.InitialState(requireReceipt),
		},
	}
}

func handleReplay(cmd Command) Response {
	requireReceipt := true
	if cmd.RequireReceipt != nil {
		requireReceipt = *cmd.RequireReceipt
	}
	state := run.InitialState(requireReceipt)
	steps := make([]ReplayStep, 0, len(cmd.Inputs))
	for i, ri := range cmd.Inputs {
		input, err := toRunInput(ri)
		if err != nil {
			return errResponse(CmdReplay, fmt.Sprintf("inputs[%d]: %v", i, err))
		}
		res, err := run.Transition(state, input)
		if err != nil {
			return errResponse(CmdReplay, fmt.Sprintf("inputs[%d]: %v", i, err))
		}
		state = res.State
		decisions := res.Decisions
		if decisions == nil {
			decisions = []run.Decision{}
		}
		steps = append(steps, ReplayStep{Input: ri.Type, Decisions: decisions})
	}
	return Response{
		OK:         true,
		Command:    CmdReplay,
		APIVersion: APIVersion,
		Replay: &ReplayPayload{
			MachineVer: run.MachineVersion,
			Steps:      steps,
			FinalState: state,
			Terminal:   state.Terminal,
		},
	}
}

// toRunInput converts the JSON replay input into the typed machine input.
func toRunInput(ri ReplayInput) (run.Input, error) {
	in := run.Input{
		Type:     run.InputType(ri.Type),
		ExitCode: ri.ExitCode,
		Signal:   ri.Signal,
		Status:   run.ReceiptStatus(ri.Status),
		Summary:  ri.Summary,
		Error:    ri.Error,
	}
	if ri.Type == "" {
		return in, fmt.Errorf("input type is required")
	}
	return in, nil
}

func handleStatus(cmd Command) Response {
	if cmd.RunID == "" {
		return errResponse(CmdStatus, "status requires a runId")
	}
	st := run.InitialState(true)
	return Response{
		OK:         true,
		Command:    CmdStatus,
		APIVersion: APIVersion,
		Status: &StatusPayload{
			RunID: cmd.RunID,
			Phase: st.Phase,
			State: st,
		},
	}
}

func handleVersion() Response {
	return Response{
		OK:         true,
		Command:    CmdVersion,
		APIVersion: APIVersion,
		Version: &VersionPayload{
			Core:       CoreVersion,
			API:        APIVersion,
			MachineVer: run.MachineVersion,
			Protocol:   "json-stdin-stdout-v1",
		},
	}
}

func errResponse(cmd CommandType, msg string) Response {
	return Response{OK: false, Command: cmd, APIVersion: APIVersion, Error: msg}
}

// Decode reads one JSON command from r.
func Decode(r io.Reader) (Command, error) {
	var cmd Command
	dec := json.NewDecoder(r)
	if err := dec.Decode(&cmd); err != nil {
		return Command{}, err
	}
	return cmd, nil
}

// Encode writes a Response as indented JSON to w.
func Encode(w io.Writer, resp Response) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(resp)
}
