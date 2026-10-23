package main

import "golang.org/x/sys/windows"

// drives the fixed drives, asked of the system alone: no probing of a removable or network drive
func drives() []string {
	mask, err := windows.GetLogicalDrives()
	if err != nil {
		return []string{`C:\`}
	}
	out := []string{}
	for i := 0; i < 26; i++ {
		if mask&(1<<i) == 0 {
			continue
		}
		d := string(rune('A'+i)) + `:\`
		p, _ := windows.UTF16PtrFromString(d)
		if windows.GetDriveType(p) == windows.DRIVE_FIXED {
			out = append(out, d)
		}
	}
	return out
}
