# Sulfur editor display and external changes

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
