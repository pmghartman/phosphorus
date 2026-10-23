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
  are supported. The selected candidate is also previewed inline. Sulfur
  advertises that snippet navigation is unsupported; servers that still return
  basic snippets have their defaults and choices inserted as plain code.
  Unsupported snippet transforms are filtered out.
- **Go to Definition** and Ctrl+click (Cmd+click on macOS) use server locations,
  including other project files. **Find All References** uses server results.
  C# DLL types open as read-only decompiled source through `csharp/metadata`.
  The host adapter accepts only virtual URIs already returned by that server,
  for read operations. Other locations outside the project remain refused.
- **Rename Symbol** uses the server's workspace edits, opens affected files,
  and offers an apply/cancel review. It validates every range, checks supplied
  document versions and current file text, and refuses file create/delete/move
  operations. Changes use one undo entry per file. The server's edits are the
  precise occurrence set; unsupported servers retain Sulfur's syntax preview.
- Published and pulled diagnostics appear in **Problems**, the gutter, and source
  underlines. Versioned diagnostics that do not match the current document
  version are ignored. Syntax parsing remains the fallback when no enabled
  server supplies diagnostics.
- Semantic tokens add project-aware colors, including C# types from referenced
  assemblies. Document analysis is debounced and obsolete responses are ignored.
  Servers supporting workspace diagnostics also supply errors in unopened
  project files, with cached result IDs and no continuous polling loop.
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

## C# solutions and engine DLLs

The existing `csharp-ls` extension uses Roslyn. Sulfur negotiates semantic tokens,
pull diagnostics and virtual metadata URIs, and enables Roslyn/project analyzers
by default. **C#: Roslyn Analyzers** can disable the extra analyzer work while
retaining compiler diagnostics. Its upstream settings and metadata protocol are
documented in the [csharp-ls README](https://github.com/razzmatazz/csharp-language-server#settings).

Open the folder containing the `.sln` / `.slnx` or `.csproj`. Project references,
DLL `HintPath` entries and analyzer references are resolved by Roslyn on that
file's host. The referenced DLLs and restored SDK/package dependencies must
exist there. Analysis does not build the game or generate missing engine DLLs.
Errors loading a project are available in **Output → Languages: host**.

For multiple solutions or advanced configuration:

```json
{
  "sulfur.languageServerSettings": {
    "csharp": {
      "csharp": {
        "solutionPathOverride": "D:/Projects/games/stellara/stellara.sln"
      }
    }
  }
}
```

## Inline completion and formatting

**Completion: IntelliSense Inline Preview** controls language-completion ghost
text. **Completion: Agent Suggestions**, or **AI On/Off** in the status bar,
enables the mesh model for generated code. It is off by default. Settings choose
the model role/host and idle delay. Only the nearby prefix (up to 12,000
characters) and suffix (4,000 characters), file path and language are sent.

Routing uses the current context and language-server candidates: member access,
imports and strong non-keyword prefix matches favor IntelliSense; expression
boundaries, new statements and weak/no symbol matches allow generation. Explicit
IntelliSense requests and navigating its list take priority. `Ctrl+Space` requests
IntelliSense; `Alt+\` requests an agent suggestion when enabled. Tab accepts a
suggestion, Escape dismisses it. Responses are discarded after text/selection
changes, blur, disable or tab closure. Generated text becomes a normal,
collaborative undoable edit only after acceptance. Multiline previews are shown
at the end of a line; suggestions before existing code are limited to one line.

`Ctrl+F` formats the document; `Shift+Alt+F` is an alternative. Find remains in
the Edit menu and on `Ctrl+Alt+F`. **Formatting** settings control tabs/spaces,
tab width, opening braces on the same/next line and block-content indentation.
Indentation detection can be disabled to use these preferences while typing.
Formatting uses the language server when available, then applies supported
whitespace preferences in one undo step. Strings, comments and JavaScript
return/newline semantics are preserved. Python, Go and other unsupported local
formatters rely on their language server; preprocessor conditionals remain under
the project-aware server's formatter.

## Pane layout

Use **View → Appearance → Customize Layout**, or search Settings for **Layout**.
The primary sidebar can be left or right, with Chat on the opposite side.
Terminal, Output and Problems can span the editor, extend under either sidebar,
or span both sidebars. Preferences use the same user settings file in the web
and desktop app. Resize separators support both dragging and arrow keys; Shift
uses smaller keyboard steps. Narrow windows retain the existing drawer layout.

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
