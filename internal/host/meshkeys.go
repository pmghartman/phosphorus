package host

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/pmghartman/phosphorus/internal/envfile"
	"github.com/pmghartman/phosphorus/internal/util"
)

// meshKeys a joining host's missing keys from the first peer that has them,
// into the home's .env and printed as exports for supervisor.sh
func meshKeys() error {
	want := []string{}
	for _, k := range envfile.Keys {
		if k.Mesh && os.Getenv(k.Name) == "" {
			want = append(want, k.Name)
		}
	}
	if len(want) == 0 {
		return nil
	}
	var status struct {
		Peer map[string]struct {
			TailscaleIPs []string
			Online       bool
		}
	}
	if err := json.Unmarshal([]byte(output("tailscale", "--socket=/var/run/tailscale/tailscaled.sock", "status", "--json")), &status); err != nil {
		return fail("can't list tailnet peers: %v", err)
	}
	c := &http.Client{Timeout: 3 * time.Second}
	for _, p := range status.Peer {
		if !p.Online {
			continue
		}
		for _, ip := range p.TailscaleIPs {
			if !strings.Contains(ip, ".") {
				continue
			}
			r, err := c.Get(fmt.Sprintf("http://%s:%d/internal/keys", ip, util.FrontendPort))
			if err != nil {
				continue
			}
			got := map[string]string{}
			err = json.NewDecoder(r.Body).Decode(&got)
			r.Body.Close()
			if err != nil || r.StatusCode != 200 || got["BASE_DOMAIN"] == "" {
				continue
			}
			vals := map[string]string{}
			for _, k := range want {
				if got[k] != "" {
					vals[k] = got[k]
				}
			}
			if err := envfile.Set(envPath(), vals); err != nil {
				fmt.Fprintf(os.Stderr, "can't save the keys into %s: %v\n", envPath(), err)
			}
			for k, v := range vals {
				fmt.Printf("export %s='%s'\n", k, strings.ReplaceAll(v, "'", `'\''`))
			}
			fmt.Fprintf(os.Stderr, "copied %s from %s\n", strings.Join(keysOf(vals), ", "), ip)
			return nil
		}
	}
	return fail("no peer on the tailnet has the keys")
}

func keysOf(m map[string]string) []string {
	out := []string{}
	for _, k := range envfile.Keys {
		if m[k.Name] != "" {
			out = append(out, k.Name)
		}
	}
	return out
}
