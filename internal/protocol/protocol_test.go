package protocol

import (
	"bytes"
	"strings"
	"testing"

	"github.com/cloudflare/terrarium/internal/run"
)

func TestVersionCommand(t *testing.T) {
	resp := Handle(Command{Command: CmdVersion})
	if !resp.OK || resp.Version == nil {
		t.Fatalf("version command failed: %+v", resp)
	}
	if resp.Version.Core != CoreVersion || resp.Version.API != APIVersion {
		t.Fatalf("unexpected version payload: %+v", resp.Version)
	}
	if resp.Version.MachineVer != run.MachineVersion {
		t.Fatalf("machine version mismatch: %d", resp.Version.MachineVer)
	}
}

func TestDryRunDefaults(t *testing.T) {
	resp := Handle(Command{Command: CmdDryRun, Task: "write a haiku"})
	if !resp.OK || resp.DryRun == nil {
		t.Fatalf("dry-run failed: %+v", resp)
	}
	d := resp.DryRun
	if d.Agent != DefaultAgent {
		t.Fatalf("want default agent, got %q", d.Agent)
	}
	if d.Cwd != "." {
		t.Fatalf("want default cwd '.', got %q", d.Cwd)
	}
	if !d.RequireReceipt {
		t.Fatal("requireReceipt should default true")
	}
	if d.InitialState.Receipt != run.ReceiptPending {
		t.Fatalf("initial state should be pending, got %q", d.InitialState.Receipt)
	}
	if d.Args == nil {
		t.Fatal("args should be non-nil empty slice")
	}
}

func TestDryRunOverrides(t *testing.T) {
	f := false
	resp := Handle(Command{
		Command:        CmdDryRun,
		Task:           "task",
		Agent:          "pi -p --no-session",
		Cwd:            "/tmp/work",
		RequireReceipt: &f,
	})
	d := resp.DryRun
	if d.Agent != "pi -p --no-session" || d.Cwd != "/tmp/work" || d.RequireReceipt {
		t.Fatalf("overrides not applied: %+v", d)
	}
	if d.InitialState.Receipt != run.ReceiptNotRequired {
		t.Fatalf("want not-required, got %q", d.InitialState.Receipt)
	}
}

func TestDryRunRequiresTask(t *testing.T) {
	resp := Handle(Command{Command: CmdDryRun})
	if resp.OK || resp.Error == "" {
		t.Fatalf("expected error for empty task: %+v", resp)
	}
}

func TestStatusCommand(t *testing.T) {
	resp := Handle(Command{Command: CmdStatus, RunID: "ter_123"})
	if !resp.OK || resp.Status == nil {
		t.Fatalf("status failed: %+v", resp)
	}
	if resp.Status.RunID != "ter_123" || resp.Status.Phase != run.PhaseRunning {
		t.Fatalf("unexpected status payload: %+v", resp.Status)
	}
}

func TestStatusRequiresRunID(t *testing.T) {
	resp := Handle(Command{Command: CmdStatus})
	if resp.OK || resp.Error == "" {
		t.Fatalf("expected error for missing runId: %+v", resp)
	}
}

func TestUnknownAndEmptyCommand(t *testing.T) {
	if r := Handle(Command{Command: "bogus"}); r.OK {
		t.Fatal("expected failure for unknown command")
	}
	if r := Handle(Command{}); r.OK {
		t.Fatal("expected failure for empty command")
	}
}

func TestDecodeEncodeRoundTrip(t *testing.T) {
	in := strings.NewReader(`{"command":"dry-run","task":"do the thing","agent":"opencode run"}`)
	cmd, err := Decode(in)
	if err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if cmd.Command != CmdDryRun || cmd.Task != "do the thing" {
		t.Fatalf("decoded wrong: %+v", cmd)
	}

	resp := Handle(cmd)
	var buf bytes.Buffer
	if err := Encode(&buf, resp); err != nil {
		t.Fatalf("encode error: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, `"ok": true`) || !strings.Contains(out, `"agent": "opencode run"`) {
		t.Fatalf("encoded response missing expected fields:\n%s", out)
	}
}

func TestDecodeInvalidJSON(t *testing.T) {
	if _, err := Decode(strings.NewReader("{not json")); err == nil {
		t.Fatal("expected decode error")
	}
}

func intp(i int) *int       { return &i }
func strp(s string) *string { return &s }

func TestReplayVerifiedReceiptFinalizesDone(t *testing.T) {
	resp := Handle(Command{
		Command: CmdReplay,
		Inputs: []ReplayInput{
			{Type: "ChildExited", ExitCode: intp(0)},
			{Type: "ReceiptObserved", Status: "verified", Summary: strp("done")},
		},
	})
	if !resp.OK || resp.Replay == nil || resp.Replay.Terminal == nil {
		t.Fatalf("replay failed: %+v", resp)
	}
	term := resp.Replay.Terminal
	if term.Status != run.StatusDone || !term.OK || term.TaskContractStatus != "verified" {
		t.Fatalf("unexpected terminal: %+v", term)
	}
	if resp.Replay.MachineVer != run.MachineVersion {
		t.Fatalf("machine version mismatch: %d", resp.Replay.MachineVer)
	}
	if len(resp.Replay.Steps) != 2 {
		t.Fatalf("want 2 steps, got %d", len(resp.Replay.Steps))
	}
}

func TestReplayCancelAfterVerifiedReceiptIsNotApplicable(t *testing.T) {
	// Pins the Go side of the cancelled/deadlined-receipt truth fix: a verified
	// receipt observed before cancellation must NOT survive as a verified task
	// contract on the cancelled terminal record.
	resp := Handle(Command{
		Command: CmdReplay,
		Inputs: []ReplayInput{
			{Type: "ReceiptObserved", Status: "verified", Summary: strp("win")},
			{Type: "CancelRequested"},
			{Type: "ChildExited", ExitCode: intp(0)},
		},
	})
	if !resp.OK || resp.Replay == nil || resp.Replay.Terminal == nil {
		t.Fatalf("replay failed: %+v", resp)
	}
	term := resp.Replay.Terminal
	if term.Status != run.StatusCancelled || term.OK {
		t.Fatalf("want cancelled+!ok, got %+v", term)
	}
	if term.TaskContractStatus != "not-applicable" {
		t.Fatalf("want not-applicable contract, got %q", term.TaskContractStatus)
	}
	if term.TaskResultSummary != "" {
		t.Fatalf("cancelled run must not leak a summary, got %q", term.TaskResultSummary)
	}
}

func TestReplayMissingReceiptInconclusive(t *testing.T) {
	resp := Handle(Command{
		Command: CmdReplay,
		Inputs: []ReplayInput{
			{Type: "ChildExited", ExitCode: intp(0)},
			{Type: "ReceiptObserved", Status: "missing"},
		},
	})
	if !resp.OK || resp.Replay.Terminal == nil {
		t.Fatalf("replay failed: %+v", resp)
	}
	if resp.Replay.Terminal.Status != run.StatusInconclusive || resp.Replay.Terminal.TaskContractStatus != "missing" {
		t.Fatalf("unexpected terminal: %+v", resp.Replay.Terminal)
	}
}

func TestReplayRejectsBadInput(t *testing.T) {
	resp := Handle(Command{
		Command: CmdReplay,
		Inputs:  []ReplayInput{{Type: "ChildExited"}}, // missing exitCode
	})
	if resp.OK || resp.Error == "" {
		t.Fatalf("expected error for ChildExited without exitCode: %+v", resp)
	}
	if !strings.Contains(resp.Error, "inputs[0]") {
		t.Fatalf("error should index the bad input: %q", resp.Error)
	}
}

func TestReplayEmptyInputsStaysRunning(t *testing.T) {
	resp := Handle(Command{Command: CmdReplay})
	if !resp.OK || resp.Replay == nil {
		t.Fatalf("replay failed: %+v", resp)
	}
	if resp.Replay.FinalState.Phase != run.PhaseRunning || resp.Replay.Terminal != nil {
		t.Fatalf("empty replay should remain running with no terminal: %+v", resp.Replay)
	}
}
