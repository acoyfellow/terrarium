// Package run is a pure, testable single-run terminal decision core.
//
// It is a faithful Go port of src/run-machine.js. Like the TS original it has
// no clocks, processes, files, callbacks, prompts, output, or environment
// access. Inputs are already-observed facts; adapters own real I/O. Decisions
// are inert descriptions; production adapters own all effects.
package run

import "fmt"

// MachineVersion mirrors RUN_MACHINE_VERSION in src/run-machine.js. Keep these
// in lockstep across the TS and Go cores.
const MachineVersion = 1

// Phase is the lifecycle phase of a single run.
type Phase string

const (
	PhaseRunning  Phase = "running"
	PhaseTerminal Phase = "terminal"
)

// Receipt classification states. "pending"/"not-required" are internal
// starting states; the rest mirror the ReceiptObserved input statuses.
type ReceiptStatus string

const (
	ReceiptPending     ReceiptStatus = "pending"
	ReceiptNotRequired ReceiptStatus = "not-required"
	ReceiptVerified    ReceiptStatus = "verified"
	ReceiptMissing     ReceiptStatus = "missing"
	ReceiptMismatch    ReceiptStatus = "mismatch"
	ReceiptMalformed   ReceiptStatus = "malformed"
)

// TerminalStatus is the final classification of a run.
type TerminalStatus string

const (
	StatusDone         TerminalStatus = "done"
	StatusFailed       TerminalStatus = "failed"
	StatusCancelled    TerminalStatus = "cancelled"
	StatusError        TerminalStatus = "error"
	StatusInconclusive TerminalStatus = "inconclusive"
)

// ChildExit captures the observed child process result.
type ChildExit struct {
	ExitCode int     `json:"exitCode"`
	Signal   *string `json:"signal"`
	Error    string  `json:"error,omitempty"`
}

// State is the serializable run-machine state.
type State struct {
	Version         int            `json:"version"`
	Phase           Phase          `json:"phase"`
	RequireReceipt  bool           `json:"requireReceipt"`
	CancelRequested bool           `json:"cancelRequested"`
	DeadlineReached bool           `json:"deadlineReached"`
	ChildExit       *ChildExit     `json:"childExit"`
	Receipt         ReceiptStatus  `json:"receipt"`
	ReceiptSummary  string         `json:"receiptSummary,omitempty"`
	RuntimeError    string         `json:"runtimeError,omitempty"`
	Terminal        *TerminalState `json:"terminal"`
}

// TerminalState is the committed terminal decision recorded on State.
type TerminalState struct {
	Status             TerminalStatus `json:"status"`
	OK                 bool           `json:"ok"`
	ExitCode           int            `json:"exitCode"`
	Signal             *string        `json:"signal"`
	TaskContractStatus string         `json:"taskContractStatus,omitempty"`
	TaskResultSummary  string         `json:"taskResultSummary,omitempty"`
	Error              string         `json:"error,omitempty"`
	Note               string         `json:"note,omitempty"`
	Reason             string         `json:"reason,omitempty"`
}

// InitialState mirrors initialRunState(). requireReceipt defaults true at the
// call site in the CLI; pass it explicitly here.
func InitialState(requireReceipt bool) State {
	receipt := ReceiptPending
	if !requireReceipt {
		receipt = ReceiptNotRequired
	}
	return State{
		Version:        MachineVersion,
		Phase:          PhaseRunning,
		RequireReceipt: requireReceipt,
		Receipt:        receipt,
	}
}

// Input types mirror the JS observed inputs.
type InputType string

const (
	InputCancelRequested   InputType = "CancelRequested"
	InputDeadlineReached   InputType = "DeadlineReached"
	InputReceiptObserved   InputType = "ReceiptObserved"
	InputChildExited       InputType = "ChildExited"
	InputProcessTerminated InputType = "ProcessTerminated"
	InputRuntimeError      InputType = "RuntimeError"
)

// Input is an already-observed fact fed to the machine.
type Input struct {
	Type     InputType
	ExitCode *int
	Signal   *string
	Status   ReceiptStatus // for ReceiptObserved
	Summary  *string       // for verified ReceiptObserved
	Error    string        // for RuntimeError
}

// Decision is an inert description of an effect for adapters to perform.
type Decision struct {
	Type           string         `json:"type"`
	Reason         string         `json:"reason,omitempty"`
	InputType      InputType      `json:"inputType,omitempty"`
	TerminalStatus TerminalStatus `json:"terminalStatus,omitempty"`
	Summary        string         `json:"summary,omitempty"`
	Status         TerminalStatus `json:"status,omitempty"`
	OK             *bool          `json:"ok,omitempty"`
	// Finalize carries the full terminal fields.
	ExitCode           *int    `json:"exitCode,omitempty"`
	Signal             *string `json:"signal,omitempty"`
	TaskContractStatus string  `json:"taskContractStatus,omitempty"`
	TaskResultSummary  string  `json:"taskResultSummary,omitempty"`
	Error              string  `json:"error,omitempty"`
	Note               string  `json:"note,omitempty"`
}

// Result is the return of Transition.
type Result struct {
	State     State
	Decisions []Decision
}

// Transition applies one observed input and returns the next state plus inert
// decisions. It is a faithful port of transition() in src/run-machine.js.
func Transition(previous State, input Input) (Result, error) {
	if err := assertState(previous); err != nil {
		return Result{}, err
	}
	if err := assertInput(input); err != nil {
		return Result{}, err
	}

	state := previous // value copy; pointers are reassigned below, never mutated in place
	var decisions []Decision

	if state.Phase == PhaseTerminal {
		decisions = append(decisions, Decision{
			Type:           "IgnoreLateInput",
			InputType:      input.Type,
			TerminalStatus: state.Terminal.Status,
		})
		return Result{State: state, Decisions: decisions}, nil
	}

	switch input.Type {
	case InputCancelRequested:
		if !state.CancelRequested {
			state.CancelRequested = true
			decisions = append(decisions, Decision{Type: "TerminateChild", Reason: "cancel-requested"})
		}

	case InputDeadlineReached:
		if !state.DeadlineReached {
			state.DeadlineReached = true
			decisions = append(decisions, Decision{Type: "TerminateChild", Reason: "deadline-reached"})
		}

	case InputReceiptObserved:
		if state.Receipt != ReceiptPending {
			decisions = append(decisions, Decision{Type: "IgnoreLateInput", InputType: input.Type, Reason: "receipt-already-observed"})
			break
		}
		state.Receipt = input.Status
		if input.Status == ReceiptVerified {
			if input.Summary != nil {
				state.ReceiptSummary = *input.Summary
			}
			decisions = append(decisions, Decision{Type: "AcceptReceipt", Summary: state.ReceiptSummary})
		}

	case InputChildExited:
		if state.ChildExit != nil {
			decisions = append(decisions, Decision{Type: "IgnoreLateInput", InputType: input.Type, Reason: "child-exit-already-observed"})
			break
		}
		state.ChildExit = &ChildExit{ExitCode: *input.ExitCode, Signal: input.Signal}

	case InputProcessTerminated:
		// Acknowledges a previously-requested termination; child exit remains
		// the authoritative process result and is required before finalization.

	case InputRuntimeError:
		code := 127
		if input.ExitCode != nil {
			code = *input.ExitCode
		}
		state.ChildExit = &ChildExit{ExitCode: code, Signal: nil, Error: input.Error}
		state.RuntimeError = input.Error
	}

	if final := terminalDecision(&state); final != nil {
		state.Phase = PhaseTerminal
		state.Terminal = final
		ok := final.OK
		decisions = append(decisions, Decision{
			Type:               "Finalize",
			Status:             final.Status,
			OK:                 &ok,
			ExitCode:           &final.ExitCode,
			Signal:             final.Signal,
			TaskContractStatus: final.TaskContractStatus,
			TaskResultSummary:  final.TaskResultSummary,
			Error:              final.Error,
			Note:               final.Note,
			Reason:             final.Reason,
		})
		decisions = append(decisions, Decision{Type: "QueueCallback", Status: final.Status, OK: &ok})
	}

	return Result{State: state, Decisions: decisions}, nil
}

func terminalDecision(state *State) *TerminalState {
	if state.ChildExit == nil {
		return nil
	}
	ce := state.ChildExit

	contractOrNA := func() string {
		if state.Receipt == ReceiptPending {
			return "not-applicable"
		}
		return string(state.Receipt)
	}

	// Cancellation/deadline intent wins if observed before terminal commit,
	// independent of exit code or receipt arrival ordering.
	if state.CancelRequested {
		return &TerminalState{Status: StatusCancelled, OK: false, ExitCode: ce.ExitCode, Signal: ce.Signal, TaskContractStatus: contractOrNA(), Reason: "cancel-requested"}
	}
	if state.DeadlineReached {
		return &TerminalState{Status: StatusFailed, OK: false, ExitCode: ce.ExitCode, Signal: ce.Signal, TaskContractStatus: contractOrNA(), Reason: "deadline-reached"}
	}
	if state.RuntimeError != "" {
		return &TerminalState{Status: StatusError, OK: false, ExitCode: ce.ExitCode, Signal: nil, Error: state.RuntimeError, TaskContractStatus: string(state.Receipt), Reason: "runtime-error"}
	}

	// For receipt-requiring runs, defer finalization until receipt
	// classification is observed (ChildExited -> ReceiptObserved determinism).
	if state.RequireReceipt && state.Receipt == ReceiptPending {
		return nil
	}
	if state.RequireReceipt && state.Receipt != ReceiptVerified {
		status := StatusInconclusive
		if ce.ExitCode != 0 {
			status = StatusFailed
		}
		return &TerminalState{
			Status:             status,
			OK:                 false,
			ExitCode:           ce.ExitCode,
			Signal:             ce.Signal,
			TaskContractStatus: string(state.Receipt),
			Note:               fmt.Sprintf("Task contract %s; process exit is not accepted as task success.", state.Receipt),
			Reason:             "receipt-" + string(state.Receipt),
		}
	}

	status := StatusDone
	ok := true
	if ce.ExitCode != 0 {
		status = StatusFailed
		ok = false
	}
	reason := "process-exit"
	if state.Receipt == ReceiptVerified {
		reason = "verified-receipt"
	}
	return &TerminalState{
		Status:             status,
		OK:                 ok,
		ExitCode:           ce.ExitCode,
		Signal:             ce.Signal,
		TaskContractStatus: string(state.Receipt),
		TaskResultSummary:  state.ReceiptSummary,
		Reason:             reason,
	}
}

func assertState(state State) error {
	if state.Version != MachineVersion {
		return fmt.Errorf("invalid run machine state: version %d", state.Version)
	}
	if state.Phase != PhaseRunning && state.Phase != PhaseTerminal {
		return fmt.Errorf("invalid run machine state: phase %q", state.Phase)
	}
	return nil
}

func assertInput(input Input) error {
	switch input.Type {
	case InputChildExited:
		if input.ExitCode == nil {
			return fmt.Errorf("ChildExited requires integer exitCode")
		}
	case InputReceiptObserved:
		switch input.Status {
		case ReceiptVerified, ReceiptMissing, ReceiptMismatch, ReceiptMalformed, ReceiptNotRequired:
		default:
			return fmt.Errorf("invalid receipt status: %q", input.Status)
		}
		if input.Status == ReceiptVerified && input.Summary != nil {
			if trimmed := trimSpace(*input.Summary); trimmed == "" {
				return fmt.Errorf("verified receipt summary must be a non-empty string")
			}
		}
	case InputCancelRequested, InputDeadlineReached, InputProcessTerminated, InputRuntimeError:
	default:
		return fmt.Errorf("invalid observed run input: %q", input.Type)
	}
	return nil
}

func trimSpace(s string) string {
	start, end := 0, len(s)
	for start < end && isSpace(s[start]) {
		start++
	}
	for end > start && isSpace(s[end-1]) {
		end--
	}
	return s[start:end]
}

func isSpace(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\r' || b == '\v' || b == '\f'
}
