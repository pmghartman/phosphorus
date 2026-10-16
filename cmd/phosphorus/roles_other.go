//go:build !linux

package main

func role(string, []string) (int, bool) { return 0, false }
