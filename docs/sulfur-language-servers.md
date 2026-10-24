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

The language host is Go, in the phosphorus binary: Sulfur runs it in its own
process for this computer, and as `phosphorus sulfur-language` over the saved
login on a mesh host, which needs `phosphorus` on that login's PATH (the
installers put it there). No interpreter is required. All installation
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
  are supported. Snippets expand to code with the first tab stop selected;
  subsequent linked placeholder editing and Tab navigation are not yet supported.
  The selected candidate is also previewed inline when **Completion: IntelliSense Inline Preview** is enabled.
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
- Pull diagnostics are also supported, including current csharp-ls releases.
  Errors, warnings, and informational hints keep their severity in the explorer,
  gutter, underlines, and Problems. Hover an underline to see its diagnostic code,
  source, and message; gutter markers also show messages on hover.
- Diagnostics wait until typing has paused for one second by default. Old
  underlines clear as the buffer changes, so unfinished lines are not immediately
  flagged. Adjust **Editor: Diagnostic Delay** (`editor.diagnostics.delay`,
  300–5000 ms) to change this quiet period.
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

## AI inline completion

Web and desktop Sulfur also share a dedicated AI completion harness. IntelliSense
continues to use the owning host's optional language server for symbols, types,
members, and imports. The AI predicts insertions, from an expression to a short
function, displayed as muted ghost text. Both use the editor's existing batch
operations, collaboration, and undo history.

AI suggestions are enabled by default in **Settings → Editor: AI Inline
Suggestions** (`editor.inlineSuggest.enabled`). After a typing pause of 750 ms
(`editor.inlineSuggest.delay`, configurable from 200–5000 ms), Sulfur asks the
selected completion model through the existing mesh Messages gateway. The
default is `chimp`. The gateway uses the
configured Chimp when ready, otherwise another ready mesh model. Its Chimp
profile disables thinking. A desktop client uses the linked mesh proxy and login;
without a connected mesh, host-local IntelliSense and word suggestions still work.
Automatic requests follow meaningful typed characters. Creating blank lines,
pressing Enter, adding indentation, and deleting text do not request predictions.
Explicit AI completion remains available at those positions.

**Settings → Editor: Completion Machine / Model** has separate Machine and Model
selectors. Automatic routing offers Chimp and Orangutan; selecting a machine
pins completion to its configured model, shown by filename, and requires that
machine to have the model ready. This selection does not change the machine's
model installation or the chat model. The saved `editor.inlineSuggest.model`
value is `chimp`, `orangutan`, or `phosphorus/<host>`. Use **Refresh machines and
models** to refresh availability.

- **Tab** accepts a visible IntelliSense choice first, or an AI suggestion when
  the list is closed. Without a suggestion, Tab keeps its usual indentation.
- **Escape** dismisses the visible suggestion. **Enter** accepts an IntelliSense
  choice; it does not accept AI ghost text. Shift+Tab keeps outdenting.
- **Ctrl+Space** requests IntelliSense. **Alt+\\** requests an AI suggestion
  explicitly. Both commands are in the command palette, including when the OS
  reserves a shortcut. **Toggle AI Inline Suggestions** turns AI prediction off.

The fixed `v2` harness has its own instructions, no conversation history, and no
tools. It is independent of the Chat/Claude Code/opencode selection. It sends up
to 6,000 characters before the caret, 2,000 after it, two related open files of
the same language (1,500 characters each), and up to twelve available symbol
hints. It does not scan the repository or start an agent session. Disable inline
suggestions to stop these requests; `chat.includeActiveFile` controls chat only.

One request can run at a time in the workbench. Predictions appear as a complete
ghost-text suggestion, with a 512-token budget and a fifteen-second deadline.
Input JSON echoed by a model is discarded. Typing, selection changes,
collaborator edits, focus changes, acceptance, and workspace changes invalidate
or cancel the prediction. A small, one-minute cache stays in memory and clears
with workspace/settings resets. Automatic failures back off briefly; explicit
requests show the error in the status bar. Source is not added to chat history
or persisted in the prediction cache. Latency and code quality depend on the
loaded mesh model and host hardware.

**Completion: IntelliSense Inline Preview** (`editor.suggest.inlinePreview`) controls
language completion ghost text independently of AI. The **AI On/Off** status item
also toggles AI suggestions. Member access, imports and strong symbol prefixes
favor IntelliSense; weak matches at expression and statement boundaries allow
AI generation. Explicit IntelliSense requests and list navigation take priority.

## Formatting and pane layout

`Ctrl+Shift+F` formats the document; `Shift+Alt+F` is an alternative. `Ctrl+F` is
Find, and Find in Files is on `Ctrl+Shift+H`. **Formatting** settings control tabs/spaces,
tab width, opening braces on the same/next line and block-content indentation.
Indentation detection can be disabled to use these preferences while typing.
Formatting uses the language server when available, then applies supported
whitespace preferences in one undo step. Strings, comments and JavaScript
return/newline semantics are preserved. Python, Go and other unsupported local
formatters rely on their language server; preprocessor conditionals remain under
the project-aware server's formatter.

## Pane layout

Use **Appearance → Customize Layout**, or search Settings for **Layout**.
The primary sidebar can be left or right, with Chat on the opposite side.
Terminal, Output and Problems can span the editor, extend under either sidebar,
or span both sidebars. Preferences use the same user settings file in the web
and desktop app. Resize separators support both dragging and arrow keys; Shift
uses smaller keyboard steps. Narrow windows retain the existing drawer layout.

## Focused verification without an application build

```text
node --test web/tests/*.test.mjs
go test ./internal/sulfur
```

The Go tests cover the installer, the manifest and lock handling, archive
safety, document gating and UTF-8 framing through a stand-in server. They never
download a real language server or compile the application. The other platform-specific
servers and mesh SSH transport should additionally be exercised on the user's
target hosts after the user builds the application.
