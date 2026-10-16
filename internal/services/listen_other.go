//go:build !linux

package services

import "github.com/shirou/gopsutil/v4/net"

// listening the TCP ports open on ip or every address
func listening(ip string) map[int]bool {
	cs, err := net.Connections("tcp")
	if err != nil {
		return nil
	}
	ports := map[int]bool{}
	for _, c := range cs {
		a := c.Laddr.IP
		if c.Status == "LISTEN" && (a == "0.0.0.0" || a == "::" || a == "*" || a == ip) {
			ports[int(c.Laddr.Port)] = true
		}
	}
	return ports
}
