package host

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/pmghartman/phosphorus/internal/envfile"
)

// the containers of releases before phosphorus left docker, here only to
// move a host off them on its first update and clean up after

const registry = "ghcr.io/pmghartman"

var (
	oldContainers = []string{"phosphorus-git", "phosphorus-model", "phosphorus"}
	drivePath     = regexp.MustCompile(`^([A-Za-z]):[\\/]?(.*)$`)
	vmDrive       = regexp.MustCompile(`^/run/desktop/mnt/host/([a-z])(/.*)?$`)
	ourImage      = regexp.MustCompile(`^(phosphorus(-model|-git)?|` + regexp.QuoteMeta(registry) + `/phosphorus(-model|-git)?|(docker\.io/)?searxng/searxng|[^ ]*hesperus[^/: ]*):`)
	sandboxRule   = regexp.MustCompile(`^-A (DOCKER-USER .*-i phosphorus-sandbox0 .*)$`)
	// the old container's tailnet node, for its device to be handed over
	oldNode struct{ ID, Name string }
)

func docker(args ...string) *exec.Cmd {
	c := exec.Command("docker", args...)
	hide(c)
	return c
}

func dockerOut(args ...string) string {
	c := docker(args...)
	c.Stderr = nil
	b, err := c.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func dockerQuiet(args ...string) bool { return docker(args...).Run() == nil }

func dockerUp() bool { return dockerQuiet("info", "--format", "{{.ServerVersion}}") }

func isRunning(name string) bool {
	return dockerOut("inspect", "-f", "{{.State.Running}}", name) == "true"
}

func containerExists(name string) bool {
	return dockerOut("ps", "-aq", "-f", "name=^"+name+"$") != ""
}

// dockerEra the containers of an earlier release still here; an idle docker
// started first, or its restart policy would bring them back later
func dockerEra() bool {
	if !has("docker") {
		return false
	}
	if !dockerUp() && startDocker() {
		say("starting docker to find the old containers...")
		for i := 0; i < 45 && !dockerUp(); i++ {
			time.Sleep(2 * time.Second)
		}
	}
	if !dockerUp() {
		return false
	}
	for _, c := range append(oldContainers, "phosphorus-search") {
		if containerExists(c) {
			return true
		}
	}
	return false
}

func mountOf(container, dest string) string {
	return dockerOut("inspect", container, "--format", `{{range .Mounts}}{{if eq .Destination "`+dest+`"}}{{.Source}}{{end}}{{end}}`)
}

// hostSpelling Docker Desktop's VM path back to the Windows drive
func hostSpelling(p string) string {
	if m := vmDrive.FindStringSubmatch(p); m != nil {
		return strings.ToUpper(m[1]) + `:\` + strings.ReplaceAll(strings.TrimPrefix(m[2], "/"), "/", `\`)
	}
	return p
}

// vmPath a Windows path as Docker Desktop's VM mounts it
func vmPath(p string) string {
	if m := drivePath.FindStringSubmatch(p); m != nil {
		return "/run/desktop/mnt/host/" + strings.ToLower(m[1]) + "/" + strings.ReplaceAll(m[2], `\`, "/")
	}
	return p
}

// containerHome the [home] dir the old frontend container ran on
func containerHome() string {
	if h := mountOf("phosphorus", "/homefs"); h != "" {
		return filepath.Clean(hostSpelling(h))
	}
	return ""
}

// stopContainers git first for its hand-off, none restarted by docker after;
// the frontend's tailnet node noted first, for its device to be handed over
func stopContainers() {
	var st struct {
		Self struct{ ID, DNSName string }
	}
	if json.Unmarshal([]byte(dockerOut("exec", "phosphorus", "tailscale", "status", "--json")), &st) == nil && st.Self.ID != "" {
		oldNode.ID = st.Self.ID
		oldNode.Name, _, _ = strings.Cut(st.Self.DNSName, ".")
	}
	for _, c := range oldContainers {
		if !containerExists(c) {
			continue
		}
		dockerQuiet("update", "--restart=no", c)
		if isRunning(c) {
			say("stopping %s...", c)
			dockerQuiet("stop", "-t", "30", c)
		}
	}
}

func startContainers() {
	for i := len(oldContainers) - 1; i >= 0; i-- {
		c := oldContainers[i]
		if containerExists(c) {
			dockerQuiet("update", "--restart=unless-stopped", c)
			dockerQuiet("start", c)
		}
	}
}

// carryOver what lived only inside docker: the tailnet identity where it can
// move, the model on Windows' volume, forgejo's config for a rollback
func carryOver() error {
	if b, err := os.ReadFile(at("git", "data", "conf", "app.ini")); err == nil {
		os.WriteFile(at("state", "app.ini.docker"), b, 0o600)
	}
	if isWindows && dockerQuiet("volume", "inspect", "phosphorus-models") {
		say("copying the model out of docker's volume...")
		os.MkdirAll(at("state", "models"), 0o755)
		if !dockerQuiet("run", "--rm", "-v", "phosphorus-models:/m", "-v", vmPath(at("state", "models"))+":/out",
			"--entrypoint", "sh", "phosphorus:latest", "-c", "cp -a /m/. /out/") {
			return fail("couldn't copy the model out of the phosphorus-models volume")
		}
	}
	if carried, err := carryTailnet(); err != nil || carried {
		return err
	}
	return handOverDevice()
}

// handOverDevice the old container's node deleted and its name given to this
// machine's, so the mesh keeps the host's name; TS_API_KEY needed
func handOverDevice() error {
	if oldNode.ID == "" {
		return nil
	}
	key := envfile.Read(envPath())["TS_API_KEY"]
	if key == "" {
		say("no TS_API_KEY: the old container's tailnet node %s stays, this machine may join under another name; delete it in the Tailscale admin console", oldNode.Name)
		return nil
	}
	call := func(method, path string, body any) error {
		var rd *bytes.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		} else {
			rd = bytes.NewReader(nil)
		}
		req, _ := http.NewRequest(method, "https://api.tailscale.com/api/v2"+path, rd)
		req.SetBasicAuth(key, "")
		req.Header.Set("Content-Type", "application/json")
		r, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
		if err != nil {
			return err
		}
		r.Body.Close()
		if r.StatusCode >= 300 {
			return fmt.Errorf("tailscale answered %d", r.StatusCode)
		}
		return nil
	}
	if err := call("DELETE", "/device/"+oldNode.ID, nil); err != nil {
		say("couldn't delete the old tailnet node %s: %v", oldNode.Name, err)
		return nil
	}
	say("deleted the old container's tailnet node %s", oldNode.Name)
	var st struct {
		Self struct{ ID, DNSName string }
	}
	out, _ := exec.Command(tailscaleCLI(), "status", "--json").Output()
	if json.Unmarshal(out, &st) != nil || st.Self.ID == "" {
		return nil
	}
	if name, _, _ := strings.Cut(st.Self.DNSName, "."); name != oldNode.Name {
		if err := call("POST", "/device/"+st.Self.ID+"/name", map[string]string{"name": oldNode.Name}); err != nil {
			say("couldn't rename this machine's node to %s: %v", oldNode.Name, err)
		} else {
			say("this machine's tailnet node renamed %s, the host's name in the mesh", oldNode.Name)
		}
	}
	return nil
}

// rollback the containers back where the migration found them
func rollback(migrating bool, err error) error {
	if !migrating {
		return err
	}
	say("rolling back to the containers")
	svcStop()
	tailscaleStop()
	gitDown()
	if b, e := os.ReadFile(at("state", "app.ini.docker")); e == nil && fileExists(at("git", "data", "conf")) {
		os.WriteFile(at("git", "data", "conf", "app.ini"), b, 0o644)
		os.Chown(at("git", "data", "conf", "app.ini"), 4001, 4000)
	}
	os.Remove(at("git", "data", "obj", ".phosphorus-hooks"))
	os.RemoveAll(at("tailscale"))
	os.Remove(at("state", "native-sig"))
	startContainers()
	// hooks back on the image's forgejo, native git having rewritten them
	if containerExists("phosphorus-git") {
		dockerQuiet("exec", "-u", "git", "phosphorus-git", "sh", "-c",
			"HOME=/var/lib/phosphorus/git forgejo -w /var/lib/phosphorus/git -c /var/lib/phosphorus/git/conf/app.ini admin regenerate hooks")
	}
	return fail("%v; the containers are running again", err)
}

// cleanupDocker everything earlier releases left in docker: containers,
// images, volumes, networks and the sandbox fence's rules; docker itself kept
func cleanupDocker() {
	if !has("docker") || !dockerUp() {
		return
	}
	gone := map[string]bool{}
	ids := []string{}
	for _, c := range []string{"phosphorus", "phosphorus-git", "phosphorus-model", "phosphorus-search", "phosphorus-updater"} {
		if containerExists(c) {
			ids = append(ids, c)
		}
	}
	for _, f := range []string{"label=org.phosphorus", "label=org.phosphorus.sandbox", "name=^phosphorus-sandbox-"} {
		ids = append(ids, strings.Fields(dockerOut("ps", "-aq", "--filter", f))...)
	}
	for _, id := range ids {
		if !gone[id] && dockerQuiet("rm", "-f", id) {
			gone[id] = true
			say("removed container %s", id)
		}
	}
	for _, l := range strings.Split(dockerOut("images", "--format", "{{.Repository}}:{{.Tag}} {{.ID}}"), "\n") {
		f := strings.Fields(l)
		if len(f) == 2 && ourImage.MatchString(f[0]) && dockerQuiet("rmi", "-f", f[0]) {
			say("removed image %s", f[0])
		}
	}
	for _, v := range []string{"phosphorus_tailscale-state", "phosphorus-git-data", "phosphorus-git-db", "phosphorus-models"} {
		// the tailnet identity only once carried over, or no longer needed
		if v == "phosphorus_tailscale-state" && !identityCarried() {
			continue
		}
		if dockerQuiet("volume", "inspect", v) && dockerQuiet("volume", "rm", v) {
			say("removed volume %s", v)
		}
	}
	for _, n := range []string{"phosphorus_default", "phosphorus-sandbox"} {
		if dockerQuiet("network", "inspect", n) && dockerQuiet("network", "rm", n) {
			say("removed network %s", n)
		}
	}
	for _, bin := range []string{"iptables", "ip6tables"} {
		if !isLinux || !has(bin) {
			continue
		}
		for _, l := range strings.Split(output(bin, "-S", "DOCKER-USER"), "\n") {
			if m := sandboxRule.FindStringSubmatch(strings.TrimSpace(l)); m != nil {
				quiet(bin, append([]string{"-D"}, strings.Fields(m[1])...)...)
			}
		}
	}
	for _, f := range []string{"docker-compose.yml", "state/docker-compose.files.yml"} {
		os.Remove(at(filepath.FromSlash(f)))
	}
}

// cleanupLitefs litefs's store and mount point, once the git daemon has the db off it
func cleanupLitefs() {
	if st, err := os.Stat(at("git", "db", "forgejo.db")); err != nil || st.Size() == 0 {
		return
	}
	if fileExists(at("git", "litefs-internal")) {
		os.RemoveAll(at("git", "litefs-internal"))
		say("removed litefs's old db store")
	}
	os.Remove(at("git", "litefs"))
}
