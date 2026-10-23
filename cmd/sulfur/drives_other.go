//go:build !windows

package main

// drives the system's root alone
func drives() []string { return []string{"/"} }
