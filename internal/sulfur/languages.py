"""User-scoped language server installer and stdio adapter (Python 3.10+).

Only install accesses the network. Registry versions and downloaded artifact
hashes are recorded in each manifest; staging prevents a failed install from
replacing a working one. This file is embedded in both Go hosts.
"""
import base64
import hashlib
import json
import os
import pathlib
import platform
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import threading
import urllib.parse
import urllib.request
import zipfile

CATALOG = [
    dict(id="typescript", name="TypeScript", server="TypeScript Language Server", packages=["typescript-language-server", "typescript"], entry="typescript-language-server/lib/cli.mjs", prerequisites="Python 3.10+, Node.js 22+ and npm"),
    dict(id="python", name="Python", server="Pyright", packages=["pyright"], entry="pyright/langserver.index.js", prerequisites="Python 3.10+, Node.js 22+ and npm; select a project virtual environment in pyrightconfig.json"),
    dict(id="javascript", name="JavaScript", server="TypeScript Language Server", packages=["typescript-language-server", "typescript"], entry="typescript-language-server/lib/cli.mjs", prerequisites="Python 3.10+, Node.js 22+ and npm"),
    dict(id="java", name="Java", server="Eclipse JDT LS", prerequisites="Python 3.10+, JDK 21+ (JAVA_HOME or java on PATH); Maven/Gradle projects may need cached dependencies"),
    dict(id="csharp", name="C#", server="csharp-ls", prerequisites="Python 3.10+, .NET 10 SDK; project dependencies must be restored for offline use"),
    dict(id="php", name="PHP", server="Intelephense", packages=["intelephense"], entry="intelephense/lib/intelephense.js", prerequisites="Python 3.10+, Node.js 22+ and npm; free server features only"),
    dict(id="shell", name="Shell (Bash)", server="Bash Language Server", packages=["bash-language-server"], entry="bash-language-server/out/cli.js", prerequisites="Python 3.10+, Node.js 22+, npm and Bash (Windows: Git Bash or WSL host); shellcheck optional"),
    dict(id="cpp", name="C / C++", server="clangd", prerequisites="Python 3.10+; platform clangd binary or x86-64 release, C/C++ toolchain and compile_commands.json; native ARM hosts can provide clangd on PATH"),
    dict(id="hcl", name="HCL / Terraform", server="terraform-ls", prerequisites="Python 3.10+; Terraform CLI recommended; cached Terraform providers for offline use"),
    dict(id="go", name="Go", server="gopls", prerequisites="Python 3.10+, current Go SDK; installation compiles gopls; cache project modules for offline use"),
]
BY_ID = {x["id"]: x for x in CATALOG}
HOME = pathlib.Path(os.environ.get("SULFUR_LANGUAGE_HOME", pathlib.Path.home() / ".sulfur" / "languages"))
write_lock = threading.Lock()
cancelled = threading.Event()
process_lock = threading.Lock()
running_process = None


def terminate(child):
    if child.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(child.pid)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
    else:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def watch_disconnect():
    while os.read(sys.stdin.fileno(), 65536):
        pass
    cancelled.set()
    with process_lock:
        if running_process:
            terminate(running_process)


def check_cancelled():
    if cancelled.is_set():
        raise RuntimeError("Installation cancelled: client disconnected")


def emit(kind, **values):
    with write_lock:
        print(json.dumps(dict(_sulfur=kind, **values)), flush=True)


def executable(name):
    found = shutil.which(name)
    if not found:
        raise RuntimeError("Missing runtime: " + name + ". Install it on this host and add it to the user's PATH.")
    return found


def run(args, **kwargs):
    global running_process
    check_cancelled()
    emit("log", text="Running " + " ".join(map(str, args)))
    with process_lock:
        check_cancelled()
        child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=os.name != "nt", **kwargs)
        running_process = child
    try:
        output, _ = child.communicate(timeout=900)
    except BaseException:
        terminate(child)
        child.wait()
        raise
    finally:
        with process_lock:
            running_process = None
    check_cancelled()
    emit("log", text=output[-24000:])
    if child.returncode:
        raise RuntimeError("Installer exited with " + str(child.returncode) + ": " + output[-3000:])


def fetch(url):
    check_cancelled()
    if not url.startswith("https://"):
        raise ValueError("Downloads require HTTPS")
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Sulfur-language-extensions"}), timeout=90) as response:
        return response.read(512 * 1024 * 1024)


def get_json(url):
    return json.loads(fetch(url))


def unpack(url, destination, manifest):
    emit("log", text="Downloading " + url)
    data = fetch(url)
    manifest.update(source=url, sha256=hashlib.sha256(data).hexdigest())
    archive = destination / "download"
    archive.write_bytes(data)
    def safe(name):
        target = (destination / name).resolve()
        if not target.is_relative_to(destination.resolve()):
            raise ValueError("Archive path escapes installation")
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as z:
            for info in z.infolist():
                safe(info.filename)
                if (info.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError("Archive symlink refused")
            z.extractall(destination)
    else:
        with tarfile.open(archive) as t:
            for info in t.getmembers():
                safe(info.name)
                if not info.isfile() and not info.isdir():
                    raise ValueError("Archive links/devices refused")
            t.extractall(destination)
    archive.unlink()


def load(item):
    try:
        return json.loads((HOME / item / "manifest.json").read_text())
    except (OSError, ValueError):
        return None


def status():
    result = []
    for item in CATALOG:
        installed = load(item["id"])
        result.append(dict(item, installed=bool(installed), enabled=bool(installed and installed.get("enabled")), manifest=installed))
    return result


def install(item):
    HOME.mkdir(parents=True, exist_ok=True)
    target = HOME / item["id"]
    if target.is_symlink():
        raise RuntimeError("Installation directory must not be a symlink")
    manifest = dict(enabled=True, server=item["server"])
    with tempfile.TemporaryDirectory(prefix=".install-", dir=HOME) as tmp:
        stage = pathlib.Path(tmp)
        if item.get("packages"):
            executable("node")
            node_version = subprocess.check_output([executable("node"), "--version"], text=True).strip()
            if tuple(map(int, node_version.lstrip("v").split(".")[:3])) < (22, 22, 2):
                raise RuntimeError("Node.js 22.22.2 or newer is required (Node.js 24 LTS recommended)")
            packages = []
            for package in item["packages"]:
                if package == "typescript":
                    # TypeScript 7's native distribution does not provide the
                    # legacy tsserver.js consumed by typescript-language-server.
                    versions = get_json("https://registry.npmjs.org/typescript")["versions"]
                    version = max((v for v in versions if re.fullmatch(r"6\.\d+\.\d+", v)), key=lambda v: tuple(map(int, v.split("."))))
                else:
                    version = get_json("https://registry.npmjs.org/" + package + "/latest")["version"]
                packages.append(package + "@" + version)
            npm = [executable("npm")]
            if os.name == "nt":
                # Invoke npm's JS entry directly; never send a user home path
                # through cmd.exe's metacharacter expansion.
                npm_cli = pathlib.Path(npm[0]).parent / "node_modules" / "npm" / "bin" / "npm-cli.js"
                if not npm_cli.is_file():
                    raise RuntimeError("Install the official Node.js distribution with npm beside node.exe")
                npm = [executable("node"), str(npm_cli)]
            run([*npm, "install", "--prefix", str(stage), "--registry=https://registry.npmjs.org", "--fetch-retries=1", "--fetch-timeout=60000", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", *packages], cwd=stage)
            manifest.update(packages=packages, entry="node_modules/" + item["entry"])
        elif item["id"] == "go":
            env = dict(os.environ, GOBIN=str(stage))
            run([executable("go"), "install", "golang.org/x/tools/gopls@latest"], env=env)
            manifest["entry"] = "gopls.exe" if os.name == "nt" else "gopls"
        elif item["id"] == "csharp":
            run([executable("dotnet"), "tool", "install", "csharp-ls", "--tool-path", str(stage)])
            manifest["entry"] = "csharp-ls.exe" if os.name == "nt" else "csharp-ls"
        elif item["id"] == "java":
            java = java_executable()
            v = subprocess.run([java, "-version"], capture_output=True, text=True)
            match = re.search(r'version "(\d+)', v.stderr + v.stdout)
            if not match or int(match[1]) < 21:
                raise RuntimeError("JDT LS requires JDK 21 or newer")
            base = "https://download.eclipse.org/jdtls/milestones/"
            listing = fetch(base).decode()
            versions = re.findall(r'href=[\'\"](?:[^\'\"]*/)?(\d+\.\d+\.\d+)/?[\'\"]', listing)
            if not versions:
                raise RuntimeError("Eclipse JDT LS download service is unavailable; retry installation later")
            version = max(versions, key=lambda x: tuple(map(int, x.split("."))))
            listing = fetch(base + version + "/").decode()
            artifact = re.search(r'jdt-language-server-[\w.\-]+\.tar\.gz', listing)[0]
            unpack(base + version + "/" + artifact, stage, manifest)
            manifest["entry"] = "jdtls"
        elif item["id"] == "cpp":
            existing = shutil.which("clangd")
            if existing:
                manifest.update(entry=existing, external=True)
            else:
                if platform.machine().lower() not in ("amd64", "x86_64"):
                    raise RuntimeError("Install a native clangd on PATH for this architecture, then retry")
                release = get_json("https://api.github.com/repos/clangd/clangd/releases/latest")
                system = {"Windows": "windows", "Darwin": "mac", "Linux": "linux"}[platform.system()]
                asset = next(x for x in release["assets"] if x["name"].startswith("clangd-" + system + "-") and x["name"].endswith(".zip"))
                unpack(asset["browser_download_url"], stage, manifest)
                entry = next(stage.rglob("clangd.exe" if os.name == "nt" else "clangd"))
                entry.chmod(0o755)
                manifest["entry"] = str(entry.relative_to(stage))
        elif item["id"] == "hcl":
            release = get_json("https://checkpoint-api.hashicorp.com/v1/check/terraform-ls")["current_version"]
            system = {"Windows": "windows", "Darwin": "darwin", "Linux": "linux"}[platform.system()]
            arch = {"amd64": "amd64", "x86_64": "amd64", "arm64": "arm64", "aarch64": "arm64"}.get(platform.machine().lower())
            if not arch:
                raise RuntimeError("No Terraform LS binary for " + platform.machine())
            unpack(f"https://releases.hashicorp.com/terraform-ls/{release}/terraform-ls_{release}_{system}_{arch}.zip", stage, manifest)
            manifest["entry"] = "terraform-ls.exe" if os.name == "nt" else "terraform-ls"
            (stage / manifest["entry"]).chmod(0o755)
        (stage / "manifest.json").write_text(json.dumps(manifest, indent=2))
        check_cancelled()
        backup = HOME / (".old-" + item["id"])
        if backup.exists():
            shutil.rmtree(backup)
        if target.exists():
            target.rename(backup)
        try:
            stage.rename(target)
        except BaseException:
            if backup.exists():
                backup.rename(target)
            raise
        if backup.exists():
            shutil.rmtree(backup)


def java_executable():
    if os.environ.get("JAVA_HOME"):
        return str(pathlib.Path(os.environ["JAVA_HOME"]) / "bin" / ("java.exe" if os.name == "nt" else "java"))
    return executable("java")


def command(item, manifest, request):
    folder = HOME / item["id"]
    entry = str(folder / manifest["entry"])
    if item.get("packages"):
        args = [executable("node"), entry]
        if item["id"] in ("typescript", "javascript"):
            return args + ["--stdio", "--tsserver-path", str(folder / "node_modules" / "typescript" / "lib" / "tsserver.js")]
        return args + (["start"] if item["id"] == "shell" else ["--stdio"])
    if item["id"] == "java":
        system = {"Windows": "win", "Darwin": "mac", "Linux": "linux"}[platform.system()]
        arch = "_arm" if platform.machine().lower() in ("arm64", "aarch64") else ""
        config = folder / ("config_" + system + arch)
        if not config.exists():
            config = folder / ("config_" + system)
        # Every root AND active configuration has a separate writable JDT workspace.
        key = hashlib.sha256((request["root"] + request.get("configuration", "")).encode()).hexdigest()[:24]
        return [java_executable(), "-Declipse.application=org.eclipse.jdt.ls.core.id1", "-Dosgi.bundles.defaultStartLevel=4", "-Declipse.product=org.eclipse.jdt.ls.core.product", "-Xmx1G", "--add-modules=ALL-SYSTEM", "--add-opens", "java.base/java.util=ALL-UNNAMED", "--add-opens", "java.base/java.lang=ALL-UNNAMED", "-jar", str(next((folder / "plugins").glob("org.eclipse.equinox.launcher_*.jar"))), "-configuration", str(config), "-data", str(HOME / ".workspaces" / key)]
    if item["id"] == "cpp":
        args = [entry, "--background-index"]
        if request.get("buildDirectory"):
            args.append("--compile-commands-dir=" + request["buildDirectory"])
        return args
    return [entry] + (["serve"] if item["id"] == "hcl" else [])


def document_allowed(uri, method, root, virtual_documents):
    if uri in virtual_documents and method in (
            "csharp/metadata", "textDocument/semanticTokens/full", "textDocument/definition", "textDocument/hover", "textDocument/documentSymbol"):
        return True
    parsed = urllib.parse.urlparse(uri)
    path = urllib.request.url2pathname(parsed.path)
    return parsed.scheme == "file" and not parsed.netloc and pathlib.Path(path).resolve().is_relative_to(root)


def launch(item, manifest, request):
    if not manifest or not manifest.get("enabled"):
        raise RuntimeError("Extension is not installed and enabled")
    root = pathlib.Path(request["root"])
    if not root.is_absolute() or not root.is_dir():
        raise RuntimeError("Open an existing absolute project folder on this host")
    root = root.resolve()
    request["root"] = str(root)
    child = subprocess.Popen(command(item, manifest, request), cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=None, start_new_session=os.name != "nt")
    # Virtual documents are only readable after this server has returned them
    # as a location. They are not arbitrary paths on the host's filesystem.
    virtual_documents = set()
    virtual_lock = threading.Lock()
    def remember_locations(value):
        if isinstance(value, dict):
            for key, part in value.items():
                if key in ("uri", "targetUri") and isinstance(part, str) and part.startswith("csharp:/"):
                    with virtual_lock:
                        virtual_documents.add(part)
                elif isinstance(part, (dict, list)):
                    remember_locations(part)
        elif isinstance(value, list):
            for part in value:
                remember_locations(part)
    emit("ready", rootUri=root.as_uri())
    def read_server():
        try:
            while True:
                size = None
                while True:
                    line = child.stdout.readline(8192)
                    if not line:
                        return
                    if line == b"\r\n":
                        break
                    if line.lower().startswith(b"content-length:"):
                        size = int(line.split(b":", 1)[1])
                if size is None or not 0 <= size <= 32 * 1024 * 1024:
                    raise ValueError("Invalid LSP Content-Length")
                data = child.stdout.read(size)
                if len(data) != size:
                    return
                message = json.loads(data)
                if item["id"] == "csharp":
                    remember_locations(message)
                with write_lock:
                    print(json.dumps(message), flush=True)
        except Exception as error:
            emit("error", error=str(error))
        finally:
            # Wake the owning websocket even if the editor is otherwise idle.
            emit("stopped", code=child.poll())
    reader = threading.Thread(target=read_server, daemon=True)
    reader.start()
    try:
        for line in sys.stdin:
            message = json.loads(line)
            # Client-provided document URIs must remain in this actual project,
            # including through symlinks. Server locations are also gated by UI.
            doc = (message.get("params") or {}).get("textDocument", {})
            if "uri" in doc:
                with virtual_lock:
                    allowed = document_allowed(doc["uri"], message.get("method"), root, virtual_documents)
                if not allowed:
                    raise ValueError("Document is outside the project")
            data = json.dumps(message, ensure_ascii=False).encode("utf-8")
            child.stdin.write(b"Content-Length: " + str(len(data)).encode() + b"\r\n\r\n" + data)
            child.stdin.flush()
    finally:
        terminate(child)
        child.wait()
        reader.join(timeout=2)


def main(request):
    operation = request["op"]
    if operation == "status":
        emit("status", extensions=status(), platform=platform.system())
        return
    item = BY_ID[request["language"]]
    # mkdir is also the cross-process installer lock, shared by local/mesh UIs.
    if operation == "launch":
        launch(item, load(item["id"]), request)
        return
    HOME.mkdir(parents=True, exist_ok=True)
    lock = HOME / (".lock-" + item["id"])
    try:
        lock.mkdir()
    except FileExistsError:
        raise RuntimeError("Another operation is using this extension; retry when it finishes")
    try:
        if operation == "install":
            install(item)
        elif operation == "uninstall":
            target = HOME / item["id"]
            if target.is_symlink():
                raise RuntimeError("Refusing a symlink installation directory")
            if target.exists():
                shutil.rmtree(target)
        elif operation in ("enable", "disable"):
            manifest = load(item["id"])
            if not manifest:
                raise RuntimeError("Install the extension first")
            manifest["enabled"] = operation == "enable"
            (HOME / item["id"] / "manifest.json").write_text(json.dumps(manifest, indent=2))
        else:
            raise ValueError("Unknown operation")
        emit("status", extensions=status(), platform=platform.system())
    finally:
        lock.rmdir()


if __name__ == "__main__":
    try:
        request = json.loads(base64.b64decode(sys.argv[1]))
        if request["op"] != "launch":
            threading.Thread(target=watch_disconnect, daemon=True).start()
        main(request)
    except Exception as error:
        emit("error", error=str(error))
        sys.exit(1)
