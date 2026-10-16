//go:build !windows

package envfile

import "os"

// Lock 0600, root's when root writes it (Linux), else the docker user's (macOS)
func Lock(file string) error {
	if os.Geteuid() == 0 {
		if err := os.Chown(file, 0, 0); err != nil {
			return err
		}
	}
	return os.Chmod(file, 0o600)
}
