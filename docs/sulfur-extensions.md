# Writing extensions for Sulfur

Sulfur is phosphorus's code editor, a VS Code-shaped workbench in a phosphorus desktop window. Extensions add commands, keys, status bar items, output channels, runners, webviews and chat agents to it. If you've written a VS Code extension, most of this will feel familiar. The API is smaller, and every call is asynchronous.

This guide is also in Sulfur itself, under **Help → Extension Guide**.

For indentation guides, whitespace markers and external-file reloads, see
[Editor display and external changes](sulfur-editor.md).

## Quick start

### Use native SQLite

SQLite is built into Sulfur and appears in the Extensions pane. Choose
**Create Database…** there, or run **SQLite: Create Database in Project…** from
the command palette. Enter a project-relative filename such as `app.sqlite`.
Existing files are never overwritten; parent folders must already exist.

Open a `.sqlite`, `.sqlite3`, `.db` or `.db3` file to browse its tables and views.
Rows load in pages of 200. **New Table** inserts an editable SQL template;
**Execute SQL** applies the whole batch in a transaction and rolls it back on
error. Do not include `BEGIN`, `COMMIT` or `SAVEPOINT` in the batch. **Run Query**
(`Ctrl+Enter`, or `Cmd+Enter` on macOS) opens the database read-only. Query
results stop at 200 rows or 8 MiB, with previews for large strings and blobs;
queries time out after ten seconds. Integers outside JavaScript's exact range
are displayed as strings.

Desktop databases run locally without another executable or extension download.
For mesh projects, SQLite runs on the file's host under your saved SSH login;
update Phosphorus on that host to enable the helper. The database stays there.
Use **Reopen Editor With…** to choose a converted SQLite viewer instead.

### Convert extensions from Open VSX

Open **Extensions → Browse Open VSX…** (or the library button in the Extensions
pane), search the registry, and choose **Convert & Install**. Sulfur previews
the contribution points and records a conversion report on the extension's page.
The package is checked against the registry's SHA-256 checksum before conversion.
Missing or invalid checksums stop installation. Search cancels superseded requests
and caches recent pages. Installation uploads to a staging folder with bounded
parallelism, then replaces the installed directory; a failed replacement restores
the previous directory. Updating a disabled extension keeps it disabled.

Color themes, file icons, language definitions, TextMate grammars and snippets
become native Sulfur contributions. They use the existing editor, completion and
theme machinery without running the original extension's code. Bundled language
servers use Sulfur's language host on the selected machine.

When an extension supplies a browser build for commands or custom editors,
Sulfur runs that build in an isolated extension frame. Its compatible API calls
use Sulfur's command palette, dialogs, output, status bar and webview tabs. Its
declarative contributions still use the native editor features. Executable
extensions require the same trust decision as extensions written for Sulfur.
Use **Reopen Editor With…** to select an installed custom editor for a file.

Webview views and tree data providers use native Sulfur sidebar containers.
Webviews resolve lazily when their container opens and retain their state while
hidden. Tree views support children, refresh, selection, expansion, collapse and
item commands. Custom view menus, conditional visibility, drag and drop, and
revealing unloaded tree ancestors are not translated. Tree child lists currently
show up to 1,000 items per parent.

Webview CSS variables follow Sulfur's current colors and fonts when the theme
changes. Local stylesheets and their fonts/images load through the extension's
resource bridge, as do explicit local `fetch` and Worker requests for resources
such as WebAssembly. Explicit `localResourceRoots` restrict those reads. Browser
module loading and relative worker imports still require a bundled entry point.

Select a registry result to open its native compatibility preview, with the
translation plan and current conflicts before installation. Installed extension
pages list competing commands, shortcuts, runners, view IDs, file editors,
language associations and language servers, plus missing or disabled dependencies.
Checks include built-in SQLite and installed native language servers on the
selected host. Enabling an extension with conflicts shows a notification;
existing command and runner owners retain their handlers. File editor conflicts
compare declared patterns, so different glob patterns may still overlap.

Converted code can discover installed native and converted extensions through
`vscode.extensions`, with change events as their state changes. Dependency
metadata is preserved; dependencies are converted separately. Executable exports
are not shared between isolated extension frames.

Compatibility depends on the APIs the extension uses. Node-only extension code,
debug adapters and notebooks are not supported. Language-feature providers
implemented in JavaScript are not yet native contributions; check the conversion
report and extension output for unsupported features. Unsupported API use also
shows a compatibility notification and is listed on the extension's page. Disabling an
extension removes its native contributions and stops its executable host.

### Write a Sulfur extension

For optional completion, semantic navigation, rename, and diagnostics, open
**Extensions → Optional language extensions**. Select languages and a host, then
**Install selected**. These use native language servers on that host, with
enable/disable/uninstall controls. See [Language servers](sulfur-language-servers.md)
for the ten-language selection, runtime prerequisites, and offline behavior.

1. Run **Extensions: Create New Extension…** from the command palette (`Ctrl+Shift+P`). Name it, for example `word-count`.
2. Sulfur writes `~/.sulfur/extensions/word-count/` into your home: a `package.json`, an `extension.js` and a `README.md`. It enables the extension and opens `extension.js`.
3. Edit `extension.js`, save, and run **Developer: Reload Extensions**.
4. Find your commands in the palette under the extension's name. Its log is in the **Output** panel, under *Extension: word-count*.

`~` here means your own folder in the phosphorus home (`<you>/.sulfur/extensions`). The home is merged across hosts, so your extensions follow you to every browser and every host.

## How an extension runs

Each enabled extension runs in a frame of its own, sandboxed off the page's origin. From inside that frame it has:

- no phosphorus cookies, so it can't call the phosphorus API as you;
- no access to the page, the other windows, or other extensions;
- one message port to the workbench. The `api` object handed to `activate` is built on that port.

Everything an extension does goes through that `api`. Sulfur answers each call with your rights, within your space (your folder and `shared/`). That is still a lot of power: an extension can write your files, type into terminals on the hosts you're logged into, and answer as an agent. So the first time you enable an extension, Sulfur asks you to trust it. Enable only extensions you wrote or trust.

An extension's main module is one ES module, loaded from a blob URL. That means:

- **One file.** Relative `import`s don't resolve. Bundle first if you need libraries (esbuild: `--bundle --format=esm`).
- **512 KB at most.** That's the largest text file the home serves in one read.
- `fetch` works, but from an opaque `null` origin. A server you call has to allow that with CORS (`Access-Control-Allow-Origin: *`).

## The folder

```
~/.sulfur/extensions/word-count/
  package.json     the manifest
  extension.js     the main module (package.json's "main")
  README.md        shown on the extension's page in Sulfur
```

The folder's name is the extension's id. It may contain letters, digits, `.`, `_` and `-`.

## package.json

```json
{
  "name": "word-count",
  "displayName": "Word Count",
  "version": "0.1.0",
  "description": "Counts the words in the active file.",
  "main": "extension.js",
  "contributes": {
    "commands": [
      { "command": "word-count.count", "title": "Count Words", "category": "Word Count" }
    ],
    "keybindings": [
      { "command": "word-count.count", "key": "ctrl+alt+w", "mac": "cmd+alt+w" }
    ],
    "runners": {
      "zig": "zig run \"$f\""
    }
  }
}
```

| field | meaning |
|---|---|
| `name` | The extension's name. Its id is the folder's name. |
| `displayName` | Shown in the Extensions view. |
| `version`, `description` | Shown in the Extensions view and on its page. |
| `main` | The main module, relative to the folder. Defaults to `extension.js`. |
| `contributes.commands` | `{command, title, category}` entries, listed in the palette before the extension runs. Running one while the extension is off does nothing. |
| `contributes.keybindings` | `{command, key, mac}` entries. Key syntax is below. |
| `contributes.runners` | File extension → shell command. See *Runners*. |

JSON with comments is fine, as it is in VS Code's settings.

## The main module

```js
export function activate(api, context) {
  // context: { id, extensionPath, user, workspace, host }
  api.commands.register('word-count.count', async () => {
    const ed = await api.editor.active();
    if (!ed) return api.window.showWarningMessage('Open a file first.');
    const n = (ed.text.match(/\S+/g) || []).length;
    api.window.showInformationMessage(`${n} words in ${ed.path}`);
  });
}

export function deactivate() {
  // optional: called when the extension is disabled or reloaded
}
```

`activate` may be `async`. Sulfur waits up to 15 seconds for it, then marks the extension failed and shows why in its output channel. Anything you `console.log` goes to the same output channel, *Extension: name*.

`context` contains:

| key | value |
|---|---|
| `id` | The folder's name. |
| `extensionPath` | The folder's path in the home, e.g. `ryan/.sulfur/extensions/word-count`. |
| `user` | The phosphorus user running Sulfur. |
| `workspace` | The workspace folder when the extension started. |
| `host` | The host serving this desktop. |

## The API

Every method returns a Promise, except `register…`, `create…` and `on…`. Those return their object, or a disposable with `dispose()`, at once. Values cross the port by structured clone, so pass plain data: no functions, DOM nodes or class instances.

### Paths

Workspace paths are relative to the open workspace folder, e.g. `src/main.c`. A path starting with `/` is taken from the top of the home instead, e.g. `/ryan/notes/todo.md`. Any path outside your folder or `shared/` is refused.

### api.commands

| call | does |
|---|---|
| `register(id, fn)` | Adds a command. `fn(...args)` may return a value or a Promise. A command listed in `contributes.commands` gets its title and category from there; any other shows by its id. Registering an id that already belongs to Sulfur or another extension is refused. |
| `execute(id, ...args)` | Runs any command: Sulfur's own (`workbench.action.terminal.new`, `sulfur.run.file`, `actions.find`, …) or another extension's. Resolves with what the command returned, if it can be cloned. **Help → Keyboard Shortcuts** lists every command's id. |

### api.window

| call | does |
|---|---|
| `showInformationMessage(text, ...actions)` | A notification in the corner. Resolves with the action button pressed, or `undefined` once it's closed. |
| `showWarningMessage(text, ...actions)` | The same, as a warning. |
| `showErrorMessage(text, ...actions)` | The same, as an error. Errors stay up until closed. |
| `showQuickPick(items, {placeholder, title, matchOnDescription})` | The palette as a picker, with fuzzy filtering. Items are strings or `{label, description, detail}`. Resolves with the item, or `undefined` on Escape. |
| `showInputBox({prompt, value, placeholder, title})` | One line of input. Resolves with the text, or `undefined` on Escape. |
| `setStatusBarMessage(text)` | Flashes text in the status bar for a few seconds. |
| `createStatusBarItem({text, tooltip, command, align, priority})` | A status bar item. `align` is `'left'` or `'right'`; a higher `priority` sits further out. Returns `{update(props), show(), hide(), dispose()}`. |
| `createOutputChannel(name)` | Returns `{append, appendLine, clear, show}`. It's listed in the Output panel as *name: channel*. |
| `createWebviewPanel({title, html})` | An editor tab holding your HTML in its own sandboxed frame. See *Webviews*. |
| `onDidChangeActiveEditor(fn)` | `fn({path, language})` whenever another tab comes to the front, or `fn(null)` when none is left. |

### api.workspace

| call | does |
|---|---|
| `root()` | The workspace folder's path in its place: the home, or a folder a machine publishes. |
| `readFile(path)` | The file's text. An open editor's live text if the file is open, else from disk. Text files up to 512 KB. |
| `writeFile(path, text)` | Writes the file, making its folders. If someone has the file open, the write is typed into their editor live, as an agent's edit is. |
| `list(path)` | `[{name, dir, size, mtime, hosts}]`: in the home merged across every online host, in a machine's folder that machine's. |
| `openFile(path, {line, col})` | Opens the file in an editor tab. |
| `onDidSaveFile(fn)` | `fn({path})` after an open file's edits reach the disk. |
| `onDidOpenFile(fn)` | `fn({path})` when a file gets a tab. |

### api.editor

These act on the active editor tab, if it's a text file.

| call | does |
|---|---|
| `active()` | `{path, language, text, selection: [from, to], line, col, host}`, or `null`. Offsets are UTF-16 code units, as in JavaScript strings. |
| `insert(text)` / `replaceSelection(text)` | Replaces the selection, or inserts at the caret. `Ctrl+Z` undoes it. Resolves `false` if the file is read-only. |
| `select(from, to)` | Moves the selection and scrolls it into view. |

### api.terminal

| call | does |
|---|---|
| `hosts()` | The hosts this desktop is logged into: the ones a terminal can open on. |
| `run(command, {host, name, cwd})` | Types `command` into a terminal named `name` (default *extension: host*) on `host` (default: the status bar's host). An existing terminal of that name is reused; otherwise a new one opens in `cwd` (a workspace path, default the workspace). |

### api.runners

`register(ext, command)` sets what **Run Active File** does for files ending `.ext`. **F5** uses this runner when the active file has no project; project files use their active target. In `command`, `$f` is the file's absolute path on the host, and `$o` is a fresh output path in a temporary folder (for compilers). The command runs in the file's folder. Examples from the built-in set:

```
c    gcc "$f" -O2 -o "$o" && "$o"
py   python3 "$f"
rs   rustc "$f" -o "$o" && "$o"
```

`contributes.runners` in `package.json` does the same without code. Your own `sulfur.runners` setting overrides both.

### api.agents

`registerProvider({id, label}, handler)` adds a chat agent. It shows in the chat's **Harness** picker, under Chat and the harnesses the mesh's code service offers. When someone asks it something, Sulfur calls:

```js
handler({ text, history, file, progress }) // → Promise<string>
```

| field | meaning |
|---|---|
| `text` | What was asked. |
| `history` | The conversation so far: `[{role: 'user' or 'assistant', text}]`. |
| `file` | `{path, language, text}` of the active file, or `null` when the user keeps it out (the chip above the chat box). |
| `progress(text)` | Optional. Call it with the answer so far to stream it into the chat. |

Resolve with the whole answer as markdown. Throw to show an error in the conversation. Stop is the user's: Sulfur drops the answer if it arrives after they stop it.

The code service's harnesses (Claude Code, opencode) come from the mesh, each an optional install on a host: they run in the project on one of your machines, and their edits are typed into the editor as they make them. This hook is for anything else that answers over HTTP and allows the `null` origin. See the example below. To change files the way they do, call `api.workspace.writeFile`: an open file gets the write typed in live.

### api.onDidRunFile

`onDidRunFile(fn)` calls `fn({path, host})` each time a file is run.

## Builds and tasks

The desktop app always serves this computer. Connecting a mesh adds its machines, models, agents and Forgejo beside it. **Open Folder** and **Open File** use the same folder dialog, with local and mesh places together; a typed path works with Enter or the Open button. Losing the mesh does not prevent local editing, terminals or builds.

Standalone Sulfur defaults to the same Phosphorus palette as the desktop. **Light** and **Dark** in the Color Theme picker select Phosphorus's corresponding appearance; every other theme in the library (`internal/theme/themes.json`), and a custom one made in the desktop, remain available separately. The titlebar keeps its height and window controls visible as the window narrows or shortens.

**Ctrl+B** builds the project. The first time, Sulfur looks at what the project is (CMake, a .NET solution or project, MSBuild, Cargo, Go, npm, Make, Meson, Python) and at the compilers each of your machines has. Where the project says how it builds, as Visual Studio reads it, Sulfur builds that way without asking:

- **CMakeSettings.json**: its configurations (`x64-Debug`, `x64-Release`, …) are the configurations, each built in its own `buildRoot` with its generator, variables and arguments, under the Visual Studio that configured its tree (the compiler in its `CMakeCache.txt`) and that Visual Studio's own CMake.
- **CMakePresets.json** and **CMakeUserPresets.json**: the presets are the configurations, built with `cmake --preset` and their build presets.
- **A tree already configured** (`build`, `out/build/*`, `cmake-build-*` with a `CMakeCache.txt`): built incrementally with its generator. Multi-configuration trees offer their `CMAKE_CONFIGURATION_TYPES`; other trees offer their current build type and Debug, Release, RelWithDebInfo and MinSizeRel. Selecting another build type reconfigures the tree before building.
- **A solution**: C++ in it (`.vcxproj`) builds with MSBuild under the Visual Studio its `# Visual Studio Version` names; C# alone with `dotnet`. Its own configurations (`Debug|Any CPU`, `Release|x64`, …) are the configurations, and `global.json`'s SDK is said if it's not installed.

Otherwise it asks which to build with. **Run › Select Toolchain…** always asks. The pick is kept in the project's `.sulfur/build.json`, so it goes with the project when it's copied:

```json
{
  "host": "d6",
  "toolchain": { "id": "cmake-msvc", "label": "CMake · MSVC 14.51.36231", "vcvars": "C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\VC\\Auxiliary\\Build\\vcvars64.bat" },
  "configuration": "Release",
  "defaultTask": "build",
  "tasks": [
    { "label": "Package", "command": "cpack -C Release", "group": "other" }
  ]
}
```

| field | meaning |
|---|---|
| `host` | The machine the build runs on, under your login there. |
| `toolchain` | What builds it, as the picker wrote it. Its `id` picks the built-in tasks: `cmake-vs` (CMakeSettings.json), `cmake-preset`, `cmake-tree` (a configured tree, its `dir`), `cmake-msvc`, `cmake-gcc`, `cmake-clang`, `dotnet`, `msbuild`, `cargo`, `go`, `npm`, `make`, `meson` or `python`. An MSVC toolchain also carries `vcvars`, the Visual Studio script each task runs under, and `cmake`, that Visual Studio's own CMake. |
| `configuration` | The project's own configuration: a CMakeSettings configuration or preset's name, a solution's `Debug\|Any CPU`, else `Debug` or `Release`. **Run › Select Configuration…** lists them. |
| `startup` | What **Ctrl+F5** (Run › Start Without Debugging) runs: `{label, command, build}`, the project built first when `build` is true. Asked for the first time from what the build made (its programs, a .NET project's `dotnet run`, `cargo run`, `npm start`), **Run › Select Startup Item…** to change it. |
| `defaultTask` | The task Ctrl+B runs, by id: `build`, `rebuild`, `test`, … |
| `tasks` | Your own tasks: `{label, command, group}`, the command run in the project's folder. `group` is `build`, `test`, `run` or `other`. |

Each task runs in a terminal of its own in the Terminal panel. Errors and warnings from MSVC, MSBuild, dotnet, gcc, clang, Go, Rust and CMake land in the Problems panel, linked to their lines. Editing the file and saving it takes effect at once; **Run › Select Toolchain…** and **Add a Task** (under **Run › Run Task…** and in the Run and Build view) write it for you.

The green **Run** arrow and **F5** follow the active file's project and selected configuration. CMake projects use the [CMake File API](https://cmake.org/cmake/help/latest/manual/cmake-file-api.7.html) to map executable targets to their actual output paths, including `OUTPUT_NAME`, custom output directories and multi-configuration builds. Source files in libraries follow their dependencies to an application target. A remembered startup target or the application matching the project name takes precedence when several applications share a library; **Select Startup Item…** chooses another target. Switching from a standalone source file to a project file updates the Run view and arrow immediately. Run launches an already-built executable; **Ctrl+F5** retains the build-then-run workflow. An unbuilt executable prompts you to build with Ctrl+B. Older CMake trees without metadata acquire a Sulfur codemodel query on the next requested build or configure.

A source file without a project builds alone. Compiler output, including MSVC object and debug files, goes into a unique writable temporary folder; the terminal prints its location. The source folder can be read-only.

## Code navigation

Hold **Ctrl** (**Cmd** on macOS) over a source identifier to underline the definition link before clicking it. The underline follows the pointer without moving the caret or requesting definitions; Ctrl+click routes to that same identifier. Releasing the modifier, leaving the editor, scrolling or editing clears the preview.

The editor's **Types** and **Methods and fields** pickers follow the caret and jump to declarations in the current file. Longer lists have a search box. Installed language servers supply semantic document symbols, including Roslyn's C# declarations and scopes. Without a server, syntax parsers provide navigation for C/C++, JavaScript/TypeScript, Java, Python, Go and Rust; C# falls back to the Java grammar as an approximation. Navigation parses files up to 2 MB.

**Go → Go to Symbol in File…** (Ctrl+Shift+O) searches the file's symbols. **Go to Workspace Symbol…** (Ctrl+T) searches the language server's project index. **Go to Declaration**, **Go to Type Definition**, **Go to Implementation** (Ctrl+F12), and **Call Hierarchy…** (Shift+Alt+H) use the installed server when it supports those requests. Call Hierarchy expands incoming or outgoing calls on demand; click a symbol to open its definition or expand **Call sites** to jump to a particular call. Refresh recomputes the displayed tree. Changing its direction discards pending requests from the previous tree.

**Go → Bookmarks** works with or without language servers: toggle with Ctrl+K, Ctrl+K; next with Ctrl+K, Ctrl+N; previous with Ctrl+K, Ctrl+P; clear this workspace's bookmarks with Ctrl+K, Ctrl+L. Gutter marks follow edits and undo, are saved in this browser's workbench state, and can be listed by file and line.

## Layout modes

Explorer, tabs, breadcrumbs, search results and source-control rows use descriptive inline file icons: source-language badges, separate header/project/solution icons, and recognizable build, configuration, document and asset glyphs. A folder whose loaded listing contains a project file receives that project's icon without additional directory scans.

In a Git workspace, Explorer colors changed file names and shows status badges: **M** modified, **A** added, **U** untracked, **R** renamed, **C** copied, and **!** conflicted. Parent folders show a colored dot and a tooltip with their changed-file count and statuses, including deleted files that are no longer present in the tree. Decorations refresh with Source Control, saves and Explorer refresh; clean files retain their normal color. A workspace opened beneath a repository root only decorates paths inside that workspace.

**Appearance → Layout Mode** or **Settings → Layout: Mode** selects **Default (activity bar)** or **Visual Studio (compact toolbar)**. Default remains the initial layout. The compact mode replaces the activity rail with a thin toolbar for file actions, history, undo/redo, workspace machine, build configuration, the named run target, all sidebar views, symbols and bookmarks. Both layouts expose the same actions through menus, shortcuts and the command palette. The run button names its selected target in both modes.

Layout mode is independent of the theme. **Layout: Primary Sidebar → Layout default** places Explorer on the left in Default mode and the right in Visual Studio mode. Explicit left/right choices and **Layout: Console Span** remain effective in either mode. Narrow windows scroll the toolbar horizontally instead of overlapping controls.

Undo and redo belong to the document rather than the browser's textarea buffer. An animated agent replacement is one undo step, earlier local edits remain undoable, and incoming collaborator changes rebase the history instead of clearing it. Incoming agent edits are recognized on hosts with the updated collaboration service.

Right-click a method or variable for **Go to Definition** (F12), **Find All References** (Shift+F12) and **Rename…** (Ctrl+R, Ctrl+R). Ctrl+click (Cmd+click on macOS) searches the active project and opens the definition, including in a different file. C++ function prototypes and forward declarations defer to definitions when available. Multiple matching definitions show a picker. References and rename search matching syntax identifiers in the workspace's searchable files, excluding comments and strings. These are syntax matches, so unrelated names can appear. Rename previews each occurrence with a checkbox, checks that files have not changed, and applies edits through the editor for review and undo. It refuses a truncated search. Server search excludes files over 1 MB and the configured search exclusions.

## Key syntax

Keys are written as VS Code writes them: modifiers, then the key, joined by `+`. The modifiers are `ctrl`, `shift`, `alt`, and `cmd` (`meta` for the Ctrl key on a Mac). Two keys in a row, separated by a space, make a chord: `ctrl+k ctrl+c`. `ctrl` means `Cmd` on a Mac.

The browser keeps some keys for itself, and no page can take them: `ctrl+n`, `ctrl+t`, `ctrl+w` and `ctrl+tab` in most browsers. Your own keybindings live in `~/.sulfur/keybindings.json`, which **Preferences: Open Keyboard Shortcuts (JSON)** opens:

```json
[
  { "key": "ctrl+alt+r", "command": "sulfur.run.file" },
  { "key": "ctrl+r", "command": "-workbench.action.openRecent" }
]
```

A `-` before a command removes its default key.

## Webviews

```js
const view = api.window.createWebviewPanel({
  title: 'Hosts',
  html: `<h1>Hosts</h1><ul id="list"></ul>
    <script>
      phosphorus.onMessage((hosts) => {
        document.getElementById('list').innerHTML = hosts.map((h) => '<li>' + h + '</li>').join('');
      });
      phosphorus.post('ready');
    </script>`,
});
view.onMessage(async (msg) => {
  if (msg === 'ready') view.post(await api.terminal.hosts());
});
```

A webview's page runs sandboxed, like the extension. It gets `window.phosphorus.post(msg)` and `phosphorus.onMessage(fn)` to talk to its extension, plus Sulfur's colours as CSS variables: `--ide-bg`, `--ide-fg`, `--ide-muted`, `--ide-accent`, `--ide-border`, `--ide-input`, `--ide-button`, `--ide-button-fg`. `setHtml(html)` replaces the page; `dispose()` closes the tab.

## Examples

### A runner and a command

```js
export function activate(api) {
  api.runners.register('ts', 'npx --yes tsx "$f"');
  api.commands.register('ts-tools.check', () =>
    api.terminal.run('npx --yes tsc --noEmit', { name: 'tsc' }));
}
```

### An agent bridged from an HTTP endpoint

```js
// asks a harness that answers POST /ask with {answer}, its CORS open to the null origin
const URL_ = 'https://harness.example.net/ask';

export function activate(api) {
  api.agents.registerProvider({ id: 'harness', label: 'harness' }, async ({ text, history, file, progress }) => {
    progress('thinking…');
    const res = await fetch(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, history, file }),
    });
    if (!res.ok) throw new Error(`the harness said ${res.status}`);
    return (await res.json()).answer;
  });
}
```

### Format the selection

```js
export function activate(api) {
  api.commands.register('tidy.sortWords', async () => {
    const ed = await api.editor.active();
    if (!ed || ed.selection[0] === ed.selection[1]) return;
    const [a, b] = ed.selection;
    const words = ed.text.slice(a, b).split(/\s+/).filter(Boolean).sort();
    await api.editor.replaceSelection(words.join(' '));
  });
}
```

## Debugging

- **Output panel → *Extension: name*** has the extension's `console` output, uncaught errors, and why it failed to activate.
- **Developer: Reload Extensions** restarts every extension after you edit one. **Restart Extension**, from an extension's gear menu, restarts just that one.
- The extension's frame is a page of its own, so the browser's devtools can debug it. Pick the frame titled *extension host: id* from the console's context menu.

## How it differs from VS Code

- Every API call is asynchronous and crosses a message port: `await` them.
- There's no `vscode` module to import. The API is the `api` argument to `activate`.
- One editor group. Optional native language servers provide completion, semantic colors, navigation and diagnostics; the extension API does not expose VS Code's language-provider, decoration or debugger APIs.
- Settings live in `~/.sulfur/settings.json` and keys in `~/.sulfur/keybindings.json`, both in your phosphorus home. Enabling an extension is remembered per browser.
- Your editors are live sessions: anyone with the same file open, an agent included, edits the same text you see.
