# Files

Finds, reads, edits, copies and organizes files in the mesh's shares. A share is host + share id + path from its root; `files_list` with no host gives every share and its `rwd` perms. `home` is the merged per-user share, and on a key only the user's own part shows.

1. Unknown location: `files_search` `query` (names) or `content: true` with a `glob`, no host to cover every host. Known: `files_list` (with `stat: true` for one path).
2. Read with `files_read`, paging with `from`. Binary or over 512KB: describe from `files_list` `stat: true`, inspect with `terminal_run` if needed.
3. Edit with `files_write` `old`/`new` on an exact passage read just before; whole `text` only for new files. `open: true` shows it to the user, `show_file` to someone else.
4. Organize with `files_change` (`mkdir`, `rename`, `delete`, or `steps`). Delete is permanent: only on the user's word, listing what goes.
5. Across hosts or binary: `files_copy` `from`/`to` `{host, share, path}`; folders copy whole, `move: true` drops the source. `files_list` `stat: true` the target first since it is replaced.
6. Report host, share and path for every file touched.
