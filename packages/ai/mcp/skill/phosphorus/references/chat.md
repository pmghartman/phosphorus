# Chat

Reads and posts to the mesh chat and direct messages, and waits for replies.

- Who's on: `people`.
- Read: `chat_history` with `channel: mesh` or `dm:<name>`; summarize, quoting what matters.
- Send: `send_message` posts as the signed-in user. Send exactly what the user asked, never invented content.
- Wait for a reply: take `since` from the last line's `ms`, then `chat_history` with `channel`, `since`, `wait_s: 300`, repeating until the other person answers or the user stops.
- Fix or withdraw a line: `chat_edit` with `ref` from `chat_history`.
