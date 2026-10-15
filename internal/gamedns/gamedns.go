// Package gamedns: <game>.phosphorus to its host's tailnet IP, for the split
// DNS domain mesh keeps pointed here
package gamedns

import (
	"encoding/binary"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pmghartman/phosphorus/internal/util"
)

// Zone fixed, GAME_ZONE retired
const (
	Zone    = "phosphorus"
	ttlS    = 5
	retryMS = 10000
)

var port = util.EnvInt("GAME_DNS_PORT", 53)

type question struct {
	labels []string
	qtype  uint16
	end    int
}

func readQuestion(msg []byte) *question {
	if len(msg) < 12 || binary.BigEndian.Uint16(msg[4:]) < 1 {
		return nil
	}
	labels := []string{}
	off := 12
	for {
		if off >= len(msg) {
			return nil
		}
		l := int(msg[off])
		if l == 0 {
			off++
			break
		}
		if l > 63 || off+1+l > len(msg) {
			return nil
		}
		b := msg[off+1 : off+1+l]
		r := make([]rune, len(b))
		for i, c := range b {
			r[i] = rune(c)
		}
		labels = append(labels, strings.ToLower(string(r)))
		off += 1 + l
	}
	if off+4 > len(msg) {
		return nil
	}
	return &question{labels, binary.BigEndian.Uint16(msg[off:]), off + 4}
}

func reply(msg []byte, q *question, rcode byte, ip string) []byte {
	h := make([]byte, 12)
	copy(h, msg[:2])
	h[2] = 0x80 | (msg[2] & 0x78) | 0x04 | (msg[2] & 0x01)
	h[3] = rcode
	binary.BigEndian.PutUint16(h[4:], 1)
	if ip != "" {
		binary.BigEndian.PutUint16(h[6:], 1)
	}
	out := append(h, msg[12:q.end]...)
	if ip == "" {
		return out
	}
	rr := make([]byte, 16)
	binary.BigEndian.PutUint16(rr[0:], 0xc00c)
	binary.BigEndian.PutUint16(rr[2:], 1)
	binary.BigEndian.PutUint16(rr[4:], 1)
	binary.BigEndian.PutUint32(rr[6:], ttlS)
	binary.BigEndian.PutUint16(rr[10:], 4)
	for i, o := range strings.Split(ip, ".") {
		if i < 4 {
			n, _ := strconv.Atoi(o)
			rr[12+i] = byte(n)
		}
	}
	return append(out, rr...)
}

// Answer one query, nil to stay silent
func Answer(msg []byte, lookup func(string) string) []byte {
	if len(msg) < 12 || msg[2]&0x80 != 0 {
		return nil
	}
	q := readQuestion(msg)
	if q == nil {
		return nil
	}
	if msg[2]&0x78 != 0 {
		return reply(msg, q, 4, "")
	}
	if len(q.labels) == 0 || q.labels[len(q.labels)-1] != Zone {
		return reply(msg, q, 5, "")
	}
	ip := ""
	if len(q.labels) == 2 {
		ip = lookup(q.labels[0])
	}
	if ip == "" {
		return reply(msg, q, 3, "")
	}
	if q.qtype == 1 || q.qtype == 255 {
		return reply(msg, q, 0, ip)
	}
	return reply(msg, q, 0, "")
}

// Server the .phosphorus listener, rebound on an IP change
type Server struct {
	lookup   func(string) string
	note     func(key, msg string)
	mu       sync.Mutex
	conn     *net.UDPConn
	boundIP  string
	failedAt int64
}

// New with lookup(name) -> IPv4 or ""
func New(lookup func(string) string, note func(string, string)) *Server {
	return &Server{lookup: lookup, note: note}
}

// Bind every tick, rebinding on a change
func (s *Server) Bind(ip string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ip == s.boundIP && (s.conn != nil || util.Now()-s.failedAt < retryMS) {
		return
	}
	if s.conn != nil {
		s.conn.Close()
		s.conn = nil
	}
	s.boundIP = ip
	if ip == "" {
		return
	}
	c, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.ParseIP(ip), Port: port})
	if err != nil {
		s.note("dns", fmt.Sprintf("can't serve .%s names on %s:%d, retrying: %v", Zone, ip, port, err))
		s.failedAt = util.Now()
		return
	}
	s.note("dns", fmt.Sprintf("serving .%s names on %s:%d", Zone, ip, port))
	s.conn = c
	go func() {
		buf := make([]byte, 1500)
		for {
			n, from, err := c.ReadFromUDP(buf)
			if err != nil {
				s.mu.Lock()
				if s.conn == c {
					s.conn = nil
					s.failedAt = util.Now()
					s.note("dns", fmt.Sprintf("can't serve .%s names on %s:%d, retrying: %v", Zone, ip, port, err))
				}
				s.mu.Unlock()
				return
			}
			out := func() (o []byte) {
				defer func() { recover() }()
				return Answer(append([]byte{}, buf[:n]...), s.lookup)
			}()
			if out != nil {
				c.SetWriteDeadline(time.Now().Add(time.Second))
				c.WriteToUDP(out, from)
			}
		}
	}()
}
