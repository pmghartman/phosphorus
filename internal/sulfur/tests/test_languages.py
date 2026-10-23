"""Focused adapter tests; optional real npm server smoke test, no app build.

python -B -m unittest discover -s internal/sulfur/tests -v
SULFUR_LSP_SMOKE=1 additionally installs Pyright and TypeScript into a temporary
directory, exercises real LSP requests, then removes those test installations.
"""
import base64
import contextlib
import importlib.util
import io
import json
import os
import pathlib
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import zipfile
import zlib

SOURCE = pathlib.Path(__file__).resolve().parents[1] / "languages.py"
spec = importlib.util.spec_from_file_location("languages", SOURCE)
languages = importlib.util.module_from_spec(spec)
spec.loader.exec_module(languages)


class AdapterTests(unittest.TestCase):
    def test_metadata_reads_require_a_server_returned_uri_and_do_not_enable_writes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp).resolve()
            virtual = "csharp:/project.csproj/decompiled/Engine.cs"
            self.assertTrue(languages.document_allowed((root / "App.cs").as_uri(), "textDocument/didOpen", root, set()))
            self.assertFalse(languages.document_allowed((root.parent / "outside.cs").as_uri(), "textDocument/didOpen", root, set()))
            self.assertFalse(languages.document_allowed(virtual, "csharp/metadata", root, set()))
            self.assertTrue(languages.document_allowed(virtual, "csharp/metadata", root, {virtual}))
            self.assertTrue(languages.document_allowed(virtual, "textDocument/semanticTokens/full", root, {virtual}))
            for method in ("textDocument/didOpen", "textDocument/didChange", "textDocument/rename", "textDocument/formatting"):
                self.assertFalse(languages.document_allowed(virtual, method, root, {virtual}))

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = pathlib.Path(self.temp.name) / "extensions"
        self.patch = patch.object(languages, "HOME", self.home)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        languages.cancelled.clear()

    def test_status_is_offline_optional_and_exactly_ten(self):
        with patch.object(languages, "fetch", side_effect=AssertionError("network accessed")):
            items = languages.status()
        self.assertEqual(len(items), 10)
        self.assertTrue(all(not x["installed"] for x in items))
        self.assertFalse(self.home.exists())

    def test_enable_disable_uninstall_are_scoped_and_preserve_external_binaries(self):
        target = self.home / "cpp"
        target.mkdir(parents=True)
        binary = pathlib.Path(self.temp.name) / "clangd"
        binary.write_text("external")
        (target / "manifest.json").write_text(json.dumps(dict(enabled=True, external=True, entry=str(binary))))
        with contextlib.redirect_stdout(io.StringIO()):
            languages.main(dict(op="disable", language="cpp"))
            self.assertFalse(languages.load("cpp")["enabled"])
            languages.main(dict(op="enable", language="cpp"))
            self.assertTrue(languages.load("cpp")["enabled"])
            languages.main(dict(op="uninstall", language="cpp"))
        self.assertFalse(target.exists())
        self.assertEqual(binary.read_text(), "external")

    def test_failed_install_preserves_working_version_and_releases_lock(self):
        target = self.home / "python"
        target.mkdir(parents=True)
        (target / "manifest.json").write_text('{"enabled":true,"version":"old"}')
        with patch.object(languages, "install", side_effect=RuntimeError("registry offline")):
            with self.assertRaisesRegex(RuntimeError, "registry offline"):
                languages.main(dict(op="install", language="python"))
        self.assertEqual(languages.load("python")["version"], "old")
        self.assertFalse((self.home / ".lock-python").exists())

    def test_concurrent_install_is_refused(self):
        (self.home / ".lock-python").mkdir(parents=True)
        with self.assertRaisesRegex(RuntimeError, "Another operation"):
            languages.main(dict(op="install", language="python"))

    def test_archive_traversal_is_refused(self):
        data = io.BytesIO()
        with zipfile.ZipFile(data, "w") as z:
            z.writestr("../escaped", "bad")
        destination = self.home / "stage"
        destination.mkdir(parents=True)
        with patch.object(languages, "fetch", return_value=data.getvalue()), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(ValueError, "escapes"):
                languages.unpack("https://example.test/server.zip", destination, {})
        self.assertFalse((self.home / "escaped").exists())

    def test_disabled_server_and_nonexistent_root_never_spawn(self):
        with patch.object(languages.subprocess, "Popen", side_effect=AssertionError("spawned")):
            with self.assertRaisesRegex(RuntimeError, "not installed and enabled"):
                languages.launch(languages.BY_ID["python"], None, dict(root=self.temp.name))
            with self.assertRaisesRegex(RuntimeError, "absolute project"):
                languages.launch(languages.BY_ID["python"], dict(enabled=True), dict(root="relative/path"))

    def test_launch_commands_do_not_use_shells_or_network_and_preserve_config_paths(self):
        item = languages.BY_ID["cpp"]
        args = languages.command(item, dict(entry="clangd"), dict(buildDirectory="D:/space & data/Release"))
        self.assertEqual(args[-1], "--compile-commands-dir=D:/space & data/Release")
        with patch.object(languages, "executable", return_value="node"):
            args = languages.command(languages.BY_ID["typescript"], dict(entry="cli.mjs"), {})
        self.assertIn("--tsserver-path", args)
        self.assertNotIn("npx", args)


class HelperProcess:
    def __init__(self, request, home, *, command=None, stdin_encoding=None):
        bootstrap = "import sys,base64,zlib;exec(zlib.decompress(base64.b64decode(sys.stdin.buffer.readline())))"
        payload = base64.b64encode(json.dumps(request).encode()).decode()
        env = dict(os.environ, SULFUR_LANGUAGE_HOME=str(home), PYTHONDONTWRITEBYTECODE="1")
        if stdin_encoding:
            env["PYTHONIOENCODING"] = stdin_encoding
        source = SOURCE.read_bytes()
        if command:
            source = source.replace(b'\nif __name__ == "__main__":', ("\ncommand = lambda *args: " + repr(command) + '\nif __name__ == "__main__":').encode("utf-8"))
        self.process = subprocess.Popen([sys.executable, "-u", "-c", bootstrap, payload], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, text=True, encoding="utf-8")
        self.process.stdin.write(base64.b64encode(zlib.compress(source)).decode() + "\n")
        self.process.stdin.flush()
        self.messages = queue.Queue()
        self.seen = []
        def read():
            for line in self.process.stdout:
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                self.messages.put(message)
        self.reader = threading.Thread(target=read, daemon=True)
        self.reader.start()

    def send(self, message):
        self.process.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
        self.process.stdin.flush()

    def until(self, predicate, timeout=90):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            try:
                message = self.messages.get(timeout=.1)
            except queue.Empty:
                if self.process.poll() is not None:
                    raise AssertionError("Adapter exited: " + self.process.stderr.read() + str(self.seen[-5:]))
                continue
            self.seen.append(message)
            if message.get("_sulfur") == "error":
                raise AssertionError(message["error"])
            if message.get("method") and "id" in message:
                result = [{} for _ in message.get("params", {}).get("items", [])] if message["method"] == "workspace/configuration" else None
                self.send(dict(jsonrpc="2.0", id=message["id"], result=result))
            if predicate(message):
                return message
        raise AssertionError("Timed out waiting for language server: " + str(self.seen[-5:]))

    def close(self):
        if not self.process.stdin.closed:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.reader.join(timeout=2)
        self.process.stdout.close()
        self.process.stderr.close()


class TransportTests(unittest.TestCase):
    def test_utf8_documents_survive_a_windows_legacy_stdin_encoding(self):
        # Echo the framed payload after it passes through the real bootstrap and
        # adapter. Browser JSON contains literal UTF-8, unlike json.dumps' default.
        echo = """import json, sys
while True:
    size = None
    while True:
        line = sys.stdin.buffer.readline()
        if not line: sys.exit()
        if line == b'\\r\\n': break
        if line.lower().startswith(b'content-length:'): size = int(line.split(b':', 1)[1])
    message = json.loads(sys.stdin.buffer.read(size))
    data = json.dumps(dict(jsonrpc='2.0', id=message['id'], result=message['params']), ensure_ascii=False).encode('utf-8')
    sys.stdout.buffer.write(b'Content-Length: ' + str(len(data)).encode() + b'\\r\\n\\r\\n' + data)
    sys.stdout.buffer.flush()
"""
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / "project-café"
            root.mkdir()
            home = pathlib.Path(tmp) / "languages"
            (home / "csharp").mkdir(parents=True)
            (home / "csharp" / "manifest.json").write_text('{"enabled":true}')
            server = HelperProcess(dict(op="launch", language="csharp", root=str(root)), home,
                                   command=[sys.executable, "-u", "-c", echo], stdin_encoding="cp1252")
            try:
                server.until(lambda m: m.get("_sulfur") == "ready")
                uri = (root / "Type-π-😀.cs").as_uri()
                for sequence, method in enumerate(("textDocument/didOpen", "textDocument/didChange"), 1):
                    text = "\ufeffusing System;\r\n// café π 😀 漢字\r\nclass C {}\r\n" + " " * sequence
                    params = dict(textDocument=dict(uri=uri, languageId="csharp", version=sequence, text=text)) if sequence == 1 else dict(textDocument=dict(uri=uri, version=sequence), contentChanges=[dict(text=text)])
                    server.send(dict(jsonrpc="2.0", id=sequence, method=method, params=params))
                    result = server.until(lambda m: m.get("id") == sequence)
                    self.assertEqual(result["result"], params)
            finally:
                server.close()


@unittest.skipUnless(os.environ.get("SULFUR_LSP_SMOKE") == "1", "Set SULFUR_LSP_SMOKE=1 for real npm LSP checks")
class RealServerTests(unittest.TestCase):
    def test_pyright_and_typescript_install_and_complete_over_framed_stdio(self):
        with tempfile.TemporaryDirectory(prefix="sulfur-lsp-smoke-") as tmp:
            home = pathlib.Path(tmp) / "languages"
            project = pathlib.Path(tmp) / "project"
            project.mkdir()
            for language in ("python", "typescript"):
                control = HelperProcess(dict(op="install", language=language), home)
                try:
                    status = control.until(lambda m: m.get("_sulfur") == "status", timeout=180)
                    self.assertTrue(next(x for x in status["extensions"] if x["id"] == language)["enabled"])
                finally:
                    control.close()
                text = 'value = "hello"\nvalue.' if language == "python" else 'const value = "hello";\nvalue.'
                filename = "main.py" if language == "python" else "main.ts"
                (project / filename).write_text(text)
                if language == "typescript":
                    (project / "tsconfig.json").write_text('{"compilerOptions":{"strict":true},"include":["*.ts"]}')
                server = HelperProcess(dict(op="launch", language=language, root=str(project), configuration="Debug"), home)
                try:
                    ready = server.until(lambda m: m.get("_sulfur") == "ready")
                    uri = ready["rootUri"] + "/" + filename
                    server.send(dict(jsonrpc="2.0", id=1, method="initialize", params=dict(processId=None, rootUri=ready["rootUri"], capabilities=dict(general=dict(positionEncodings=["utf-16"]), workspace=dict(configuration=True), textDocument=dict(completion=dict(completionItem=dict(snippetSupport=False)))))))
                    initialized = server.until(lambda m: m.get("id") == 1)
                    self.assertIn("completionProvider", initialized["result"]["capabilities"])
                    server.send(dict(jsonrpc="2.0", method="initialized", params={}))
                    server.send(dict(jsonrpc="2.0", method="textDocument/didOpen", params=dict(textDocument=dict(uri=uri, languageId=language, version=1, text=text))))
                    server.send(dict(jsonrpc="2.0", id=2, method="textDocument/completion", params=dict(textDocument=dict(uri=uri), position=dict(line=1, character=6))))
                    result = server.until(lambda m: m.get("id") == 2)
                    self.assertNotIn("error", result)
                    items = result["result"] if isinstance(result["result"], list) else result["result"]["items"]
                    expected = "upper" if language == "python" else "toUpperCase"
                    self.assertIn(expected, [x["label"] for x in items])
                finally:
                    server.close()


if __name__ == "__main__":
    unittest.main()
