# Chat

Reads and posts to the mesh chat and direct messages, and waits for replies.

- Who's on: `people`.
- Read: `chat_history` `channel: mesh` or `dm:<name>`, `limit` up to 50; summarize, quoting what matters.
- Send: `send_message` `text` (markdown), `to` for a direct message. It posts as {{USER}}: exactly what the user asked, never invented content.
- Wait: `since` from the last line's `ms`, then `chat_wait` `channel` `since` `wait_s: 300`, repeating until the other person answers or the user stops.
- Fix or withdraw a line: `chat_edit` `ref` from `chat_history`. Nudge the user's open windows: `notify`.
