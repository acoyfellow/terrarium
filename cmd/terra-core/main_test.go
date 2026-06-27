package main

import (
	"strings"
	"testing"

	"github.com/cloudflare/terrarium/internal/protocol"
)

func TestParseVersion(t *testing.T) {
	for _, a := range []string{"version", "--version", "-v"} {
		cmd, err := parseArgs([]string{a})
		if err != nil || cmd.Command != protocol.CmdVersion {
			t.Fatalf("parse %q: cmd=%v err=%v", a, cmd.Command, err)
		}
	}
}

func TestParseDryRunFlags(t *testing.T) {
	cmd, err := parseArgs([]string{"dry-run", "write", "a", "haiku", "--agent", "pi -p", "--cwd", "/tmp", "--no-receipt"})
	if err != nil {
		t.Fatalf("parse error: %v", err)
	}
	if cmd.Command != protocol.CmdDryRun {
		t.Fatalf("want dry-run, got %q", cmd.Command)
	}
	if cmd.Task != "write a haiku" {
		t.Fatalf("task joined wrong: %q", cmd.Task)
	}
	if cmd.Agent != "pi -p" || cmd.Cwd != "/tmp" {
		t.Fatalf("flags not parsed: %+v", cmd)
	}
	if cmd.RequireReceipt == nil || *cmd.RequireReceipt {
		t.Fatal("--no-receipt should set RequireReceipt=false")
	}
}

func TestParseDryRunRequiresTask(t *testing.T) {
	if _, err := parseArgs([]string{"dry-run", "--agent", "x"}); err == nil {
		t.Fatal("expected error for missing task")
	}
}

func TestParseStatus(t *testing.T) {
	cmd, err := parseArgs([]string{"status", "ter_abc"})
	if err != nil || cmd.RunID != "ter_abc" {
		t.Fatalf("status parse failed: cmd=%+v err=%v", cmd, err)
	}
	if _, err := parseArgs([]string{"status"}); err == nil {
		t.Fatal("expected error for missing runId")
	}
}

func TestParseUnknown(t *testing.T) {
	if _, err := parseArgs([]string{"frobnicate"}); err == nil {
		t.Fatal("expected error for unknown command")
	}
}

func TestParseMissingFlagValues(t *testing.T) {
	if _, err := parseArgs([]string{"dry-run", "t", "--agent"}); err == nil {
		t.Fatal("expected error for dangling --agent")
	}
	if _, err := parseArgs([]string{"dry-run", "t", "--cwd"}); err == nil {
		t.Fatal("expected error for dangling --cwd")
	}
}

func TestUsageMentionsCommands(t *testing.T) {
	for _, want := range []string{"version", "dry-run", "status", "--stdin", "inert"} {
		if !strings.Contains(usage, want) {
			t.Fatalf("usage missing %q", want)
		}
	}
}
