//go:build !unix

package runner

import "os/exec"

// signalOf is a no-op fallback on non-unix platforms.
func signalOf(_ *exec.ExitError) string { return "" }
