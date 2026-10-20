# phosphorus plugin

Skills and an agent for the mesh at {{BASE}}, written for **{{USER}}**{{ADMIN_NOTE}}. Built {{BUILT}} against phosphorus {{VERSION}}.

No key or server is in it. It works through the Phosphorus connector you already have: in claude.ai, Settings, Connectors, a custom connector with the url from **copy mcp url** in the agent tray (Claude Code: `claude mcp add --transport http phosphorus <url>`). Refreshing the key means pasting the new url into the connector; the plugin stays as it is.

## Install

Claude Code, as a local marketplace:

```
unzip phosphorus.plugin -d ~/.claude/phosphorus-plugin
claude plugin marketplace add ~/.claude/phosphorus-plugin
claude plugin install phosphorus@phosphorus
```

Or for one session: `claude --plugin-dir ~/.claude/phosphorus-plugin`.

Claude desktop and Cowork: drop `phosphorus.plugin` into a chat, or add it under Settings, Plugins.

Check it with `/phosphorus:mesh-status`.

## What's in it

- `phosphorus` skill: how the mesh fits together, which tool for which job, the rules for writes
- `references/tools.md`: every tool {{USER}}'s key sees, generated from the live server
- `references/playbooks.md`: step by step for the common jobs
- slash skills: `mesh-status`, `mesh-diagnose`, `mesh-run`, `mesh-files`, `mesh-service`, `mesh-update`, `mesh-chat`, `mesh-git`
- `mesh-operator` agent: multi-step mesh work in its own context
