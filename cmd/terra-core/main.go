// Command terra-core is the minimal Go core CLI for Terrarium (shard 1).
//
// It exposes the inert subset of the run lifecycle over a JSON command
// protocol: dry-run, status, and version. It deliberately performs no process
// spawning, no deployment, and no mutation of persistent state. TS adapters
// remain the production execution path; this binary is the seed of the Go core.
//
// Usage:
//
//	terra-core version
//	terra-core dry-run "task text" [--agent "opencode run"] [--cwd .]
//	terra-core status <runId>
//	terra-core --stdin       # read one JSON Command from stdin, write Response
package main

import (
	"fmt"
	"os"

	"github.com/cloudflare/terrarium/internal/protocol"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

func run(argv []string, stdin *os.File, stdout, stderr *os.File) int {
	if len(argv) == 0 {
		fmt.Fprintln(stderr, usage)
		return 2
	}

	// JSON protocol mode: one command on stdin, one response on stdout.
	if argv[0] == "--stdin" {
		cmd, err := protocol.Decode(stdin)
		if err != nil {
			fmt.Fprintf(stderr, "terra-core: invalid JSON command: %v\n", err)
			return 2
		}
		resp := protocol.Handle(cmd)
		if err := protocol.Encode(stdout, resp); err != nil {
			fmt.Fprintf(stderr, "terra-core: encode error: %v\n", err)
			return 1
		}
		if !resp.OK {
			return 1
		}
		return 0
	}

	cmd, err := parseArgs(argv)
	if err != nil {
		fmt.Fprintf(stderr, "terra-core: %v\n\n%s\n", err, usage)
		return 2
	}

	resp := protocol.Handle(cmd)
	if err := protocol.Encode(stdout, resp); err != nil {
		fmt.Fprintf(stderr, "terra-core: encode error: %v\n", err)
		return 1
	}
	if !resp.OK {
		return 1
	}
	return 0
}

// parseArgs converts CLI flags/positionals into a protocol.Command.
func parseArgs(argv []string) (protocol.Command, error) {
	var cmd protocol.Command
	sub := argv[0]
	rest := argv[1:]

	switch sub {
	case "version", "--version", "-v":
		cmd.Command = protocol.CmdVersion
		return cmd, nil

	case "status":
		cmd.Command = protocol.CmdStatus
		if len(rest) < 1 {
			return cmd, fmt.Errorf("status requires a runId")
		}
		cmd.RunID = rest[0]
		return cmd, nil

	case "dry-run":
		cmd.Command = protocol.CmdDryRun
		i := 0
		for i < len(rest) {
			a := rest[i]
			switch a {
			case "--agent":
				if i+1 >= len(rest) {
					return cmd, fmt.Errorf("--agent requires a value")
				}
				cmd.Agent = rest[i+1]
				i += 2
			case "--cwd":
				if i+1 >= len(rest) {
					return cmd, fmt.Errorf("--cwd requires a value")
				}
				cmd.Cwd = rest[i+1]
				i += 2
			case "--no-receipt":
				f := false
				cmd.RequireReceipt = &f
				i++
			default:
				if cmd.Task == "" {
					cmd.Task = a
				} else {
					cmd.Task = cmd.Task + " " + a
				}
				i++
			}
		}
		if cmd.Task == "" {
			return cmd, fmt.Errorf("dry-run requires a task")
		}
		return cmd, nil

	default:
		return cmd, fmt.Errorf("unknown command %q", sub)
	}
}

const usage = `terra-core - Terrarium Go core (shard 1, inert commands)

Usage:
  terra-core version
  terra-core dry-run "task" [--agent "opencode run"] [--cwd .] [--no-receipt]
  terra-core status <runId>
  terra-core --stdin            read one JSON Command, write JSON Response

All commands are inert: no process spawning, no deployment, no state mutation.`
