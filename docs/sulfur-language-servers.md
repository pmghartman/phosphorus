# Optional language servers

Open **Extensions** (`Ctrl+Shift+X`). The **Optional language extensions** checklist
lets you choose a host and select languages, then **Install selected**. Each row
shows its prerequisites, installation result, enabled/running state, and errors.
Use **Enable**, **Disable**, **Uninstall**, or **Refresh status** for that host.
Installer and server logs appear in **Output → Languages: host**. Nothing is
installed automatically. Installing an extension downloads and executes trusted
third-party language tooling as your operating-system user.

## Which ten?

As of October 22, 2026, the catalog follows the latest complete GitHub Octoverse
language ranking, [Octoverse 2025](https://github.blog/news-insights/octoverse/octoverse-a-new-developer-joins-github-every-second-as-ai-leads-typescript-to-1/).
Its top-ten chart uses monthly contributors and lists TypeScript, Python,
JavaScript, Java, C#, PHP, Shell, C++, HCL, and Go. This is a reasonable measure
of languages in active repositories, rather than a claim of one universal top
ten. C support comes with the same clangd extension as C++.

The newer [2026 Stack Overflow survey](https://survey.stackoverflow.co/2026/technology/data)
uses a different population and groups programming, query, scripting, and markup
languages together. That ranking would produce a different catalog; we use one
consistent repository-activity measure rather than mixing the two rankings.

## Servers and runtime prerequisites

Every host needs **Python 3.10+** on its user's PATH. Sulfur sends a small embedded
adapter to that interpreter; Python itself is never downloaded automatically.
Windows recognizes `python3`, `python`, or `py`; Linux/macOS also recognize
`python3` and `python`. Windows Store launcher placeholders are ignored locally.
An SSH host must expose the interpreter to the saved login. All installation
directories belong to that login, at `~/.sulfur/languages/<extension id>` in its
actual OS home. These executable packages are separate from the merged-home
sandboxed JavaScript extensions.

| Extension id | Language | Server | Additional prerequisites on Windows, Linux, and macOS |
|---|---|---|---|
| `typescript` | TypeScript, TSX | [TypeScript Language Server](https://github.com/typescript-language-server/typescript-language-server) + TypeScript | Node.js **22.22.2+**, npm (Node 24 LTS recommended). Both packages are installed privately; the server uses its installed tsserver. |
| `python` | Python | [Pyright](https://github.com/microsoft/pyright) | Node.js 22.22.2+, npm. Project Python and dependencies for accurate analysis; configure virtual environments in `pyrightconfig.json` or the server settings. |
| `javascript` | JavaScript, JSX | TypeScript Language Server + TypeScript | Node.js 22.22.2+, npm. Separate optional installation from TypeScript. |
| `java` | Java | [Eclipse JDT LS](https://github.com/eclipse-jdtls/eclipse.jdt.ls) | JDK **21+** through `JAVA_HOME` or `java` on PATH. Downloads the newest Eclipse milestone distribution. Uses platform-specific configuration and a separate JDT workspace per project and active configuration. |
| `csharp` | C# | [csharp-ls](https://github.com/razzmatazz/csharp-language-server) | **.NET 10 SDK+**. Installs a private .NET tool, without changing global tools. Existing solution/project dependencies must be restored for offline analysis. |
| `php` | PHP | [Intelephense](https://intelephense.com/) | Node.js 22.22.2+, npm. Free features; paid features require the vendor's license and are not supplied by Sulfur. |
| `shell` | Bash shell scripts | [Bash Language Server](https://github.com/bash-lsp/bash-language-server) | Node.js 22.22.2+, npm, Bash. Windows needs Git Bash on PATH, or use a Linux/WSL machine as a linked host. `shellcheck` is optional for additional diagnostics. PowerShell and Zsh-specific syntax are outside this extension. |
| `cpp` | C, C++ | [clangd](https://clangd.llvm.org/installation) | C/C++ compiler/toolchain and compilation database. Uses `clangd` on PATH if present; otherwise downloads the official x86-64 Windows/Linux/macOS release. ARM hosts need native clangd on PATH (for example LLVM on Apple Silicon). |
| `hcl` | HCL / Terraform | [terraform-ls](https://github.com/hashicorp/terraform-ls) | Official Windows/Linux/macOS amd64/arm64 binary; Terraform CLI and initialized provider schemas recommended. |
| `go` | Go | [gopls](https://go.dev/gopls/) | Current Go SDK. The user's requested installation runs `go install golang.org/x/tools/gopls@latest` into the private directory. Sulfur development verification does not run this installer or build the application. |

Windows npm is invoked through Node and npm's JavaScript entry point, avoiding
shell interpretation of home-directory names. POSIX SSH sessions include common
user toolchain directories in PATH, including Homebrew, Go, and .NET.
Missing runtimes or unsupported binary architectures produce a visible error
with the prerequisite to install; Sulfur does not silently elevate privileges.

Installers stage packages in a temporary sibling directory and replace the
installation only after success. Concurrent changes to the same extension are
locked. npm dependencies use exact resolved versions and a package lock;
downloaded distributions record their URL and SHA-256 in `manifest.json`.
An install requires network access. Startup, status, enable/disable, and
uninstall do not. Servers may still need cached project SDKs, modules, schemas,
or Maven/Gradle/NuGet dependencies to analyze a project without network access.
Uninstalling an extension removes only its private installation; an existing
clangd on PATH is left alone. JDT workspace caches are kept separately under
`~/.sulfur/languages/.workspaces`.

## Editor behavior

- Completion opens while typing, or with `Ctrl+Space` (`Cmd+Space` on macOS if
  the OS does not reserve it). Use Up/Down, Enter or Tab to insert, Escape to
  dismiss. Plain-text insert/replace edits and additional edits such as imports
  are supported. Sulfur advertises that snippets are unsupported and does not
  insert snippet placeholders as literal code.
- **Go to Definition** and Ctrl+click (Cmd+click on macOS) use server locations,
  including other project files. **Find All References** uses server results.
  Locations outside the project and virtual/decompiled documents are refused.
- **Rename Symbol** uses the server's workspace edits, opens affected files,
  and offers an apply/cancel review. It validates every range, checks supplied
  document versions and current file text, and refuses file create/delete/move
  operations. Changes use one undo entry per file. The server's edits are the
  precise occurrence set; unsupported servers retain Sulfur's syntax preview.
- Published diagnostics appear in **Problems**, the gutter, and source
  underlines. Versioned diagnostics that do not match the current document
  version are ignored. Syntax parsing remains the fallback when no enabled
  server supplies diagnostics.
- Completion and rename use the custom editor's batch-edit history. Unchanged
  spans remain retained operations, so undo/redo can preserve collaborator edits
  between a completion and its additional import edits.

Sessions belong to a host, project folder, language, settings, and active build
configuration. Sulfur uses the existing nearest-project detection, stopping at
the open workspace boundary. A file remains on its owning host even when the
selected build host differs. For C/C++, the active configuration's build
directory on that host is passed to clangd as its compilation-database folder.
Generating `compile_commands.json` remains part of the user's normal build
configuration; Sulfur never runs a build merely to provide completion.
Other servers receive active configuration and build directory in their
`sulfur` initialization/configuration section; their own project files govern
language-specific analysis.

Advanced settings are in `sulfur.languageServerSettings`, keyed by extension id.
For example:

```json
{
  "sulfur.languageServerSettings": {
    "python": { "python": { "analysis": { "typeCheckingMode": "basic" } } },
    "java": { "java": { "configuration": { "updateBuildConfiguration": "interactive" } } }
  }
}
```

The LSP client negotiates UTF-16, keeps increasing per-document versions,
sends open/change/save/close notifications, supports full and incremental sync,
cancels obsolete completion requests, and times out requests. Workspace or
configuration changes and disable/uninstall stop the associated sessions.
Websocket closure terminates the host adapter's server process tree. Remote
connections use the existing saved SSH login and linked-mesh API routing;
local sessions never depend on a mesh connection.

## Focused verification without an application build

```text
node --test web/tests/*.test.mjs
python -B -m unittest discover -s internal/sulfur/tests -v
```

With `SULFUR_LSP_SMOKE=1`, the Python test also downloads Pyright and the
TypeScript server into a temporary directory and checks real LSP completion
through the same embedded adapter/bootstrap. It removes these test packages
afterward. It does not compile the application. The other platform-specific
servers and mesh SSH transport should additionally be exercised on the user's
target hosts after the user builds the application.
