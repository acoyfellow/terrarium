//go:build unix

package runner

import (
	"os/exec"
	"syscall"
)

// signalOf extracts the terminating signal name from an exec.ExitError on unix
// platforms, returning "" when the process was not signalled.
func signalOf(exitErr *exec.ExitError) string {
	status, ok := exitErr.Sys().(syscall.WaitStatus)
	if !ok || !status.Signaled() {
		return ""
	}
	return status.Signal().String()
}
