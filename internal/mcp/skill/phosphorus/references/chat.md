# Chat

Reads and posts to the Phosphorus mesh chat and direct messages, and waits for replies. Use for "what's in chat", "tell <person> X", "message the mesh", "wait for <person> to answer", "who's on".

- Who's on: `people`.
- Read: `chat_history` `channel: mesh` or `dm:<name>`, `limit` up to 50. Summarize, quoting what matters.
- Send: `send_message` `text` (markdown), `to` for a direct message. It posts as {{USER}}; send exactly what the user asked, never invented content.
- Wait for a reply: take `since` from the last line's `ms`, then `chat_wait` `channel` `since` `wait_s: 300`, repeating until a line from the other person lands or the user stops.
- Fix or withdraw a line: `chat_edit` `ref` from `chat_history`.
- Nudge the user elsewhere: `notify` `title`, `body`.
