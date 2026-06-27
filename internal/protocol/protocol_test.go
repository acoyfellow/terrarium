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
