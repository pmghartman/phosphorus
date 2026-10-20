---
name: mesh-files
description: Finds, reads, edits, copies and organizes files in the Phosphorus mesh's shares across hosts. Use for "find the file", "where is X", "open X", "edit X on the mesh", "copy X to <host>", "what's in <share>".
argument-hint: "<what to find or do>"
---

Files on the mesh: `$ARGUMENTS`.

1. Unknown location: `files_search` `query` (names) or `content: true` with a `glob`, no host to cover every host. Known location: `files_list` or `files_stat`.
2. Read with `files_read`, paging with `from`. Binary or over 512KB: describe from `files_stat`, inspect with `terminal_run` if needed.
3. Edit with `files_write` `old`/`new` on an exact passage read just before; whole `text` only for new files. `open: true` shows it to the user.
4. Organize with `files_change` (`mkdir`, `rename`, `delete`, or `steps`). Delete is permanent: only on the user's word, listing what goes.
5. Across hosts or binary: `files_copy` `from`/`to` `{host, share, path}`; `files_stat` the target first since it is overwritten.
6. Report host, share and path for every file touched.
