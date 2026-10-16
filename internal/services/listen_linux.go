package services

import (
	"context"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// listening the TCP ports open on ip or every address
func listening(ip string) map[int]bool {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "ss", "-Htln").Output()
	if err != nil {
		return nil
	}
	ports := map[int]bool{}
	re := regexp.MustCompile(`^(.*):(\d+)$`)
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		if len(f) < 4 {
			continue
		}
		m := re.FindStringSubmatch(f[3])
		if m != nil && (m[1] == "0.0.0.0" || m[1] == "*" || m[1] == "[::]" || m[1] == ip) {
			n, _ := strconv.Atoi(m[2])
			ports[n] = true
		}
	}
	return ports
}
