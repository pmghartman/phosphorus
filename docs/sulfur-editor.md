# Sulfur editor display and external changes

## Editing as in VS Code

Sulfur provides VS Code's everyday editor behaviors, with the same commands, keys and
setting names:

| Feature | Keys | Setting |
|---|---|---|
| Hover: language-server docs under the problems at the mouse | `Ctrl+K Ctrl+I` at the caret | `editor.hover.enabled` |
| Parameter hints while typing a call | `Ctrl+Shift+Space` | `editor.parameterHints.enabled` |
| Quick Fix, Refactor, Source Action, Organize Imports | `Ctrl+.`, `Ctrl+Shift+R`, `Shift+Alt+O` | |
| Matching bracket highlighted; Go to / Select to Bracket | `Ctrl+Shift+\` | `editor.matchBrackets` |
| Current line and line number highlighted | | `editor.renderLineHighlight` |
| Other occurrences of the word or short selection highlighted | | `editor.occurrencesHighlight`, `editor.selectionHighlight` |
| Overview ruler over the scrollbar (problems, matches, bookmarks, caret) | | `editor.overviewRuler.enabled` |
| Rulers at given columns | | `editor.rulers` (`"80, 120"` or `[80, 120]`) |
| Expand / Shrink Selection over the syntax tree | `Shift+Alt+→` / `Shift+Alt+←` | |
| Toggle Block Comment (CSS, HTML and XML use it for `Ctrl+/` too) | `Shift+Alt+A` | |
| Copy or cut the whole line when nothing is selected | `Ctrl+C`, `Ctrl+X` | `editor.emptySelectionClipboard` |
| Find in Selection, Preserve Case, search history | `Alt+L`, `Alt+P`, `↑`/`↓` in the find box | |
| Convert indentation; change the file's line ending | status bar | |
| Format, trim trailing whitespace and settle final newlines on save | | `editor.formatOnSave`, `files.trimTrailingWhitespace`, `files.insertFinalNewline`, `files.trimFinalNewlines` |

Typing also follows VS Code. Home moves between the first non-blank character and the line
start. A closing bracket typed on a blank line outdents to its opener. Enter after `/**`
opens a doc comment, and Enter on a ` * ` line continues it. Enter on a line holding only
indentation leaves that line empty. Hover, parameter hints and code actions need a
language server installed for the file (Extensions); everything else works in every file,
offline.

Indentation guides are enabled by default. Toggle them from **View → Indentation
Guides**, or set `editor.guides.indentation` in Settings. **View → Whitespace
Markers** and `Ctrl+R Ctrl+W` toggle dots for spaces and arrows for tabs. Settings
also offers a boundary mode that shows indentation, trailing whitespace and
repeated spaces, while leaving ordinary single spaces unmarked.

```json
{
  "editor.guides.indentation": true,
  "editor.renderWhitespace": "boundary"
}
```

These are display options; they never insert characters into files. The shared
web and desktop editor draws guides and markers only around the visible viewport.
Tabs use a compact height in both layout modes. Syntax and semantic colors for
unchanged text stay visible while updated highlighting is pending.

Open files on a workspace machine are checked for external saves once a second
by one watcher on that machine. Unchanged files require metadata checks only.
Clean buffers reload automatically through the collaboration protocol, retaining
mapped cursors and updating language services. Atomic file replacements are
detected as well as ordinary writes.

If an external change conflicts with unsaved editor changes, autosave pauses.
The banner lets you review the disk version, keep the editor version, or reload
the disk version. A newer external save invalidates an older review. Deleting a
file or replacing it with binary/oversized content preserves the editor buffer
and requires a decision. Read-only shares remain read-only. Unresolved drafts
remain in the host session when their last editor disconnects, until resolved
or the host process exits.

This watcher applies to workspace-machine files. Browser-local files imported
through **Open from This Device** are snapshots; browsers do not grant ongoing
access to the original path through a regular file input.

For Windows detection reports and release validation, see
[Windows security](sulfur-windows-security.md).
