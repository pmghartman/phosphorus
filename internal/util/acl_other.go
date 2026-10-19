//go:build !windows

package util

// LockACL nothing off Windows, file modes do it there
func LockACL(string, bool) error { return nil }
