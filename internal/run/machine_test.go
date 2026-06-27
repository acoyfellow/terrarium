package run

import "testing"

func intPtr(i int) *int       { return &i }
func strPtr(s string) *string { return &s }

func mustTransition(t *testing.T, s State, in Input) Result {
	t.Helper()
	r, err := Transition(s, in)
	if err != nil {
		t.Fatalf("unexpected transition error: %v", err)
	}
	return r
}

func TestInitialStateReceiptRequired(t *testing.T) {
	s := InitialState(true)
	if s.Receipt != ReceiptPending {
		t.Fatalf("want pending, got %q", s.Receipt)
	}
	if s.Phase != PhaseRunning || s.Version != MachineVersion {
		t.Fatalf("unexpected initial state: %+v", s)
	}

	s2 := InitialState(false)
	if s2.Receipt != ReceiptNotRequired {
		t.Fatalf("want not-required, got %q", s2.Receipt)
	}
}

// Receipt-requiring run defers terminal until receipt observed.
func TestChildExitThenVerifiedReceiptIsDone(t *testing.T) {
	s := InitialState(true)
	r := mustTransition(t, s, Input{Type: InputChildExited, ExitCode: intPtr(0)})
	if r.State.Phase == PhaseTerminal {
		t.Fatal("should not be terminal before receipt observed")
	}

	r = mustTransition(t, r.State, Input{Type: InputReceiptObserved, Status: ReceiptVerified, Summary: strPtr("did the thing")})
	if r.State.Phase != PhaseTerminal {
		t.Fatal("should be terminal after verified receipt")
	}
	if r.State.Terminal.Status != StatusDone || !r.State.Terminal.OK {
		t.Fatalf("want done/ok, got %+v", r.State.Terminal)
	}
	if r.State.Terminal.TaskResultSummary != "did the thing" {
		t.Fatalf("summary not propagated: %q", r.State.Terminal.TaskResultSummary)
	}
	if r.State.Terminal.Reason != "verified-receipt" {
		t.Fatalf("want verified-receipt, got %q", r.State.Terminal.Reason)
	}
	assertHasDecision(t, r.Decisions, "Finalize")
	assertHasDecision(t, r.Decisions, "QueueCallback")
}

func TestZeroExitMissingReceiptIsInconclusive(t *testing.T) {
	s := InitialState(true)
	r := mustTransition(t, s, Input{Type: InputChildExited, ExitCode: intPtr(0)})
	r = mustTransition(t, r.State, Input{Type: InputReceiptObserved, Status: ReceiptMissing})
	if r.State.Terminal.Status != StatusInconclusive {
		t.Fatalf("want inconclusive, got %q", r.State.Terminal.Status)
	}
	if r.State.Terminal.OK {
		t.Fatal("inconclusive must not be ok")
	}
}

func TestNonZeroExitMissingReceiptIsFailed(t *testing.T) {
	s := InitialState(true)
	r := mustTransition(t, s, Input{Type: InputChildExited, ExitCode: intPtr(3)})
	r = mustTransition(t, r.State, Input{Type: InputReceiptObserved, Status: ReceiptMismatch})
	if r.State.Terminal.Status != StatusFailed {
		t.Fatalf("want failed, got %q", r.State.Terminal.Status)
	}
}

func TestNoReceiptRunFinalizesOnExit(t *testing.T) {
	s := InitialState(false)
	r := mustTransition(t, s, Input{Type: InputChildExited, ExitCode: intPtr(0)})
	if r.State.Phase != PhaseTerminal {
		t.Fatal("no-receipt run should finalize on exit")
	}
	if r.State.Terminal.Status != StatusDone || !r.State.Terminal.OK {
		t.Fatalf("want done/ok, got %+v", r.State.Terminal)
	}
	if r.State.Terminal.Reason != "process-exit" {
		t.Fatalf("want process-exit, got %q", r.State.Terminal.Reason)
	}
}

func TestCancelWinsOverVerifiedReceipt(t *testing.T) {
	s := InitialState(true)
	r := mustTransition(t, s, Input{Type: InputCancelRequested})
	assertHasDecision(t, r.Decisions, "TerminateChild")
	r = mustTransition(t, r.State, Input{Type: InputReceiptObserved, Status: ReceiptVerified, Summary: strPtr("done anyway")})
	r = mustTransition(t, r.State, Input{Type: InputChildExited, ExitCode: intPtr(0)})
	if r.State.Terminal.Status != StatusCancelled || r.State.Terminal.OK {
		t.Fatalf("want cancelled/not-ok, got %+v", r.State.Terminal)
	}
	if r.State.Terminal.Reason != "cancel-requested" {
		t.Fatalf("want cancel-requested, got %q", r.State.Terminal.Reason)
	}
}

func TestDeadlineWins(t *testing.T) {
	s := InitialState(true)
	r := mustTransition(t, s, Input{Type: InputDeadlineReached})
	r = mustTransition(t, r.State, Input{Type: InputChildExited, ExitCode: intPtr(0)})
	if r.State.Terminal.Status != StatusFailed {
		t.Fatalf("want failed, got %q", r.State.Terminal.Status)
	}
	if r.State.Terminal.Reason != "deadline-reached" {
		t.Fatalf("want deadline-reached, got %q", r.State.Terminal.Reason)
	}
}

func TestRuntimeErrorIsError(t *testing.T) {
	s := InitialState(true)
	r := mustTransition(t, s, Input{Type: InputRuntimeError, Error: "spawn ENOENT"})
	if r.State.Terminal.Status != StatusError {
		t.Fatalf("want error, got %q", r.State.Terminal.Status)
	}
	if r.State.Terminal.Error != "spawn ENOENT" {
		t.Fatalf("error not propagated: %q", r.State.Terminal.Error)
	}
	if r.State.Terminal.ExitCode != 127 {
		t.Fatalf("want default exit 127, got %d", r.State.Terminal.ExitCode)
	}
}

func TestLateInputAfterTerminalIsIgnored(t *testing.T) {
	s := InitialState(false)
	r := mustTransition(t, s, Input{Type: InputChildExited, ExitCode: intPtr(0)})
	r = mustTransition(t, r.State, Input{Type: InputReceiptObserved, Status: ReceiptVerified, Summary: strPtr("late")})
	assertHasDecision(t, r.Decisions, "IgnoreLateInput")
	if r.State.Terminal.Status != StatusDone {
		t.Fatalf("terminal status changed by late input: %+v", r.State.Terminal)
	}
}

func TestDuplicateChildExitIgnored(t *testing.T) {
	s := InitialState(true)
	r := mustTransition(t, s, Input{Type: InputChildExited, ExitCode: intPtr(1)})
	r2 := mustTransition(t, r.State, Input{Type: InputChildExited, ExitCode: intPtr(0)})
	assertHasDecision(t, r2.Decisions, "IgnoreLateInput")
}

func TestInputValidation(t *testing.T) {
	s := InitialState(true)
	if _, err := Transition(s, Input{Type: InputChildExited}); err == nil {
		t.Fatal("expected error for ChildExited without exitCode")
	}
	if _, err := Transition(s, Input{Type: InputReceiptObserved, Status: "bogus"}); err == nil {
		t.Fatal("expected error for invalid receipt status")
	}
	if _, err := Transition(s, Input{Type: InputReceiptObserved, Status: ReceiptVerified, Summary: strPtr("   ")}); err == nil {
		t.Fatal("expected error for blank verified summary")
	}
	if _, err := Transition(s, Input{Type: "Nope"}); err == nil {
		t.Fatal("expected error for unknown input type")
	}
}

func TestStateValidation(t *testing.T) {
	if _, err := Transition(State{Version: 99, Phase: PhaseRunning}, Input{Type: InputProcessTerminated}); err == nil {
		t.Fatal("expected error for bad version")
	}
	if _, err := Transition(State{Version: MachineVersion, Phase: "weird"}, Input{Type: InputProcessTerminated}); err == nil {
		t.Fatal("expected error for bad phase")
	}
}

// Transition must not mutate the caller's input state (value semantics).
func TestTransitionDoesNotMutateInput(t *testing.T) {
	s := InitialState(true)
	_ = mustTransition(t, s, Input{Type: InputCancelRequested})
	if s.CancelRequested {
		t.Fatal("input state was mutated")
	}
	if s.Phase != PhaseRunning {
		t.Fatal("input phase mutated")
	}
}

func assertHasDecision(t *testing.T, ds []Decision, typ string) {
	t.Helper()
	for _, d := range ds {
		if d.Type == typ {
			return
		}
	}
	t.Fatalf("expected decision %q in %+v", typ, ds)
}
