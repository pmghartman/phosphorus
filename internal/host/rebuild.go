package host

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// the copy run with phosphorus stopped, old at /mv/old, new at /mv/new: home/
// copied whole, only then the old one deleted; one dir spelt two ways left alone
const homeMove = `set -e
m=".phosphorus-move-$$"; touch /mv/old/$m
if [ -e /mv/new/$m ]; then rm -f /mv/old/$m; exit 0; fi
rm -f /mv/old/$m
[ -d /mv/old/home ] || exit 0
mkdir -p /mv/new/home && cp -a /mv/old/home/. /mv/new/home/
rm -rf /mv/old/home`

// shares in an override (no variable mount count in compose), rewritten every build
const filesOverride = "state/docker-compose.files.yml"

var drivePath = regexp.MustCompile(`^([A-Za-z]):[\\/]?(.*)$`)

// vmPath a Windows path as Docker Desktop's VM mounts it, others as they are
func vmPath(p string) string {
	if m := drivePath.FindStringSubmatch(p); m != nil {
		return "/run/desktop/mnt/host/" + strings.ToLower(m[1]) + "/" + strings.ReplaceAll(m[2], `\`, "/")
	}
	return p
}

func absTo(base, p string) string {
	p = strings.TrimRight(strings.TrimSpace(p), `/\`)
	if strings.HasPrefix(p, "/") || drivePath.MatchString(p) {
		return p
	}
	return strings.TrimRight(base, `/\`) + "/" + p
}

// rebuild the release's images pulled and the running containers swapped onto
// them, compose itself always run from the image; the one step that can kill
// its caller, so the swap is handed to a sibling container
func rebuild() error {
	if native() {
		return nativeRebuild()
	}
	tag = "rebuild"
	if err := os.Chdir(home); err != nil {
		return err
	}
	if !inContainer {
		lockEnv()
		if err := ensureEngine(); err != nil {
			return err
		}
	}
	addMissingSections()
	if isWindows && !inContainer {
		sshDockerConfig()
	}
	profiles := []string{}
	if isGitHost() {
		profiles = append(profiles, "git-host")
	}
	if isModelHost() {
		profiles = append(profiles, "model-host")
	}

	// the home as the docker host sees it, compose resolving binds there
	repo := os.Getenv("HOST_REPO")
	if repo == "" {
		if inContainer {
			repo = dockerOut("inspect", "phosphorus", "--format", `{{range .Mounts}}{{if eq .Destination "/repo"}}{{.Source}}{{end}}{{end}}`)
		} else {
			repo, _ = filepath.Abs(home)
		}
	}
	// a Windows bind, reported as C:\path or already in the VM's form
	windows := drivePath.MatchString(repo) || strings.HasPrefix(repo, "/run/desktop/mnt/host/")
	repo = vmPath(repo)
	if !strings.HasPrefix(repo, "/") {
		return fail("can't tell where this home lives on the host ('%s'); set HOST_REPO and retry", repo)
	}
	if !isGitHost() {
		// git/ only on a git host, its empty folders gone elsewhere
		os.Remove(at("git", "data"))
		os.Remove(at("git"))
	}

	// each [files] dir its own mount, /files the home's own share underneath
	composeFile := "docker-compose.yml"
	filesDir := repo + "/files"
	if n, err := writeFilesOverride(repo, !inContainer); err != nil {
		return err
	} else if n > 0 {
		composeFile += ":" + filesOverride
		say("publishing %d shares from [files] dir", n)
	}
	os.MkdirAll(at("files"), 0o755)

	// [home] dir as the docker host sees it, moved from where the running container has it
	homeTo := repo + "/files"
	if d := iniGet("home", "dir"); d != "" {
		homeTo = vmPath(absTo(repo, d))
		if !inContainer {
			os.MkdirAll(absTo(home, d), 0o755)
		}
	}
	homeFrom := ""
	if containerExists("phosphorus") {
		homeFrom = strings.TrimRight(vmPath(dockerOut("inspect", "phosphorus", "--format", `{{range .Mounts}}{{if eq .Destination "/homefs"}}{{.Source}}{{end}}{{end}}`)), "/")
	}
	if homeFrom == homeTo {
		homeFrom = ""
	}
	if homeFrom != "" && strings.HasPrefix(homeTo+"/", homeFrom+"/home/") {
		return fail("[home] dir can't be inside the folders it moves")
	}
	if homeFrom != "" {
		say("moving home/ from %s to %s with this swap", homeFrom, homeTo)
	}

	tsHost := os.Getenv("TS_HOSTNAME")
	if tsHost == "" && isWindows {
		// Docker Desktop's VM always docker-desktop, the mesh name this machine's
		tsHost = strings.ToLower(os.Getenv("COMPUTERNAME"))
	}
	env := map[string]string{
		"COMPOSE_PROFILES": strings.Join(profiles, ","), "COMPOSE_FILE": composeFile, "TS_HOSTNAME": tsHost,
		"PHOSPHORUS_FILES_DIR": filesDir, "PHOSPHORUS_HOME_DIR": homeTo,
	}
	if windows {
		// git data and the model's gguf on docker volumes, off the slow NTFS share;
		// every drive under the VM's mount for the status tab's disk
		env["PHOSPHORUS_GIT_DATA"], env["PHOSPHORUS_GIT_DB"], env["PHOSPHORUS_MODEL_DIR"] = "git-data", "git-db", "models"
		env["PHOSPHORUS_HOST_ROOT"] = "/run/desktop/mnt/host"
	} else if dockerOut("info", "--format", "{{.OperatingSystem}}") != "Docker Desktop" {
		env["PHOSPHORUS_HOST_ROOT"] = "/"
	}

	// the release's images pulled, nothing stopped, a failed pull changing nothing
	v := version()
	say("pulling phosphorus %s...", v)
	for _, n := range []string{"phosphorus", "phosphorus-model", "phosphorus-git"} {
		from := registry + "/" + n + ":" + v
		if !dockerQuiet("pull", "-q", from) || !dockerQuiet("tag", from, n+":latest") {
			return fail("pull failed, still running the previous version")
		}
	}

	// nvidia gpus handed in wherever a probe off the new image gets them
	if dockerQuiet("run", "--rm", "--gpus", "all", "--network", "none", "--entrypoint", "true", "phosphorus:latest") {
		env["COMPOSE_FILE"] += ":container/docker-compose.gpu.yml"
		say("handing the nvidia gpu to phosphorus")
	}

	// no longer a git host: skipped by compose as a disabled profile, still
	// running (and voting) otherwise, a clean stop for a master's hand-off
	if !isGitHost() && containerExists("phosphorus-git") {
		say("no longer a git host, removing phosphorus-git")
		dockerQuiet("stop", "-t", "30", "phosphorus-git")
		dockerQuiet("rm", "phosphorus-git")
	}
	// likewise the model, the fetched tools gone with it, the gguf kept
	if !isModelHost() {
		if containerExists("phosphorus-model") {
			say("no longer a model host, removing phosphorus-model")
			dockerQuiet("stop", "-t", "30", "phosphorus-model")
			dockerQuiet("run", "--rm", "--volumes-from", "phosphorus-model", "--entrypoint", "rm", "phosphorus:latest", "-rf", "/models/tools")
			dockerQuiet("rm", "phosphorus-model")
		}
	}
	// searxng, from releases that still had web search
	dockerQuiet("rm", "-f", "phosphorus-search")

	// leftovers of earlier runs, from the new image's sweep.sh, host pids and
	// an unconfined profile for signals to processes outside any container
	dockerLines("run", "--rm", "--pid=host", "--security-opt", "apparmor=unconfined",
		"-v", "/var/run/docker.sock:/var/run/docker.sock", "--entrypoint", "sh", "phosphorus:latest", "/opt/phosphorus/sweep.sh")

	// Windows: git/data onto the volumes once
	if windows && isGitHost() && fileExists(at("git", "data", "GIT_VERSION")) && !dockerQuiet("volume", "inspect", "phosphorus-git-data") {
		say("moving git data onto a docker volume...")
		dockerQuiet("stop", "-t", "30", "phosphorus-git")
		if dockerShow("run", "--rm", "-v", repo+"/git/data:/src:ro", "-v", "phosphorus-git-data:/data", "-v", "phosphorus-git-db:/db",
			"--entrypoint", "sh", "phosphorus:latest", "-c",
			"tar -C /src --exclude=./litefs --exclude=./litefs-internal -cf - . | tar -C /data -xf - && { [ ! -d /src/litefs-internal ] || cp -a /src/litefs-internal/. /db/; }") != nil {
			dockerQuiet("volume", "rm", "phosphorus-git-data", "phosphorus-git-db")
			dockerQuiet("start", "phosphorus-git")
			return fail("couldn't copy git/data onto a volume, still running the previous version")
		}
	}

	// images earlier swaps replaced; earlier releases' tags and hesperus's
	// too, docker refusing any still in use
	dockerQuiet("image", "prune", "-f")
	old := regexp.MustCompile(`^` + regexp.QuoteMeta(registry) + `/phosphorus(-model|-git)?:|(^|/)hesperus[^/:]*:`)
	for _, img := range strings.Split(dockerOut("images", "--format", "{{.Repository}}:{{.Tag}}"), "\n") {
		if old.MatchString(img) && !strings.HasSuffix(img, ":"+v) {
			dockerQuiet("rmi", img)
		}
	}

	flags := []string{}
	for k, x := range env {
		flags = append(flags, "-e", k+"="+x)
	}
	compose := func(detach bool, extra []string, script string) []string {
		a := []string{"run"}
		if detach {
			a = append(a, "-d", "--name", "phosphorus-updater")
		} else {
			a = append(a, "--rm")
		}
		a = append(a, flags...)
		a = append(a, extra...)
		return append(a, "-v", "/var/run/docker.sock:/var/run/docker.sock", "-v", repo+":"+repo, "-w", repo,
			"--entrypoint", "sh", "phosphorus:latest", "-c", script)
	}

	// nothing running, nothing for the swap to kill, finished here for the caller to wait on
	if !isRunning("phosphorus") {
		if homeFrom != "" && !dockerQuiet("run", "--rm", "-v", homeFrom+":/mv/old", "-v", homeTo+":/mv/new", "--entrypoint", "sh", "phosphorus:latest", "-c", homeMove) {
			say("couldn't move the homes, keeping them in %s", homeFrom)
			flags = append(flags, "-e", "PHOSPHORUS_HOME_DIR="+homeFrom)
		}
		say("phosphorus isn't running, starting it here")
		if dockerShow(compose(false, nil, "docker compose up -d --remove-orphans")...) != nil {
			return fail("couldn't start phosphorus")
		}
		return nil
	}

	// the swap planned where it'll run: every container on its image and
	// config already, no restart and no git hand-off
	plan := docker(compose(false, nil, "command -v docker >/dev/null || exit 127; docker compose up -d --remove-orphans --dry-run 2>&1")...)
	out, err := plan.Output()
	if plan.ProcessState != nil && plan.ProcessState.ExitCode() == 127 {
		return fail("the phosphorus image has no docker CLI; finish by hand with 'docker compose up -d'")
	}
	if err == nil && upToDate(string(out)) {
		say("already up to date, nothing to swap")
		return nil
	}

	// the git elector told while the frontend is still up, best effort
	dockerQuiet("exec", "phosphorus", "sh", "-c", `curl -fsS -m 3 -X POST -H 'Content-Type: application/json' -d '{}' 127.0.0.1:${FRONTEND_PORT:-8090}/internal/status/updating`)

	// the swap killing whatever drives it but not the sibling, left behind
	// (not --rm'd) so docker logs records a failure; a [home] move done there
	// with phosphorus stopped, a failed copy leaving it where it was
	say("swapping containers in phosphorus-updater, this terminal may drop")
	dockerQuiet("rm", "-f", "phosphorus-updater")
	mv := []string{"-e", "MV_FROM=" + homeFrom, "-e", "MV_TO=" + homeTo, "-e", "MV_CMD=" + homeMove}
	if !dockerQuiet(compose(true, mv, `if [ -n "$MV_FROM" ]; then docker stop -t 30 phosphorus >/dev/null
  docker run --rm -v "$MV_FROM:/mv/old" -v "$MV_TO:/mv/new" --entrypoint sh phosphorus:latest -c "$MV_CMD" \
    || export PHOSPHORUS_HOME_DIR="$MV_FROM"; fi
docker compose up -d --remove-orphans`)...) {
		return fail("couldn't start phosphorus-updater, still running the previous version")
	}
	// docker run -d back once it starts, a beat waited for an early fall-over
	state := ""
	for i := 0; i < 25; i++ {
		state = dockerOut("inspect", "-f", "{{.State.Status}}:{{.State.ExitCode}}", "phosphorus-updater")
		if strings.HasPrefix(state, "exited:") {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if state != "" && !strings.HasPrefix(state, "running:") && state != "exited:0" {
		return fail("phosphorus-updater exited early (%s), see: docker logs phosphorus-updater", state)
	}
	say("swap under way")
	return nil
}

// upToDate every line of a dry run a Running one
func upToDate(plan string) bool {
	seen := false
	for _, l := range strings.Split(plan, "\n") {
		if l = strings.TrimSpace(l); l == "" {
			continue
		}
		if !strings.HasSuffix(l, " Running") {
			return false
		}
		seen = true
	}
	return seen
}

// writeFilesOverride each [files] dir its own mount, read only where its
// perms never write; the count written, 0 with the override removed
func writeFilesOverride(repo string, vet bool) (int, error) {
	os.MkdirAll(at("state"), 0o755)
	split := func(v string) []string {
		out := []string{}
		for _, x := range strings.Split(v, ",") {
			out = append(out, strings.TrimSpace(x))
		}
		return out
	}
	raw := iniGet("files", "dir")
	perms := split(iniGet("files", "priv"))
	dirs, ps := []string{}, []string{}
	if raw != "" {
		for i, d := range split(raw) {
			if d = strings.TrimRight(d, `/\`); d == "" {
				continue
			}
			if vet && !fileExists(absTo(home, d)) {
				fmt.Fprintf(os.Stderr, "[files] skipping '%s'; no such directory on this host\n", d)
				continue
			}
			p := "rwd"
			if i < len(perms) && perms[i] != "" {
				p = perms[i]
			}
			dirs = append(dirs, vmPath(absTo(repo, d)))
			ps = append(ps, p)
		}
	}
	file := at(filepath.FromSlash(filesOverride))
	if len(dirs) == 0 {
		os.Remove(file)
		return 0, nil
	}
	q := func(s string) string { b, _ := json.Marshal(s); return string(b) }
	mounts := ""
	for i, d := range dirs {
		ro := ""
		// nothing that writes: kernel-enforced too, not just the frontend
		if !strings.ContainsAny(ps[i], "wd") {
			ro = ":ro"
		}
		mounts += fmt.Sprintf("      - %s\n", q(fmt.Sprintf("%s:/shares/%d%s", d, i, ro)))
	}
	text := "# generated from [files] in config/phosphorus.ini, rewritten every build\nservices:\n  phosphorus:\n    environment:\n" +
		"      PHOSPHORUS_FILES_DIRS: " + q(strings.Join(dirs, ",")) + "\n      PHOSPHORUS_FILES_PERMS: " + q(strings.Join(ps, ",")) + "\n" +
		"    volumes:\n" + mounts +
		// opencode's, the same shares
		"  model:\n    volumes:\n" + mounts
	return len(dirs), os.WriteFile(file, []byte(text), 0o644)
}
