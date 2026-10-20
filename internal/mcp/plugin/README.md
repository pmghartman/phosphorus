# phosphorus plugin

The mesh at {{BASE}} for Claude, keyed to **{{USER}}**{{ADMIN_NOTE}}. Built {{BUILT}} against phosphorus {{VERSION}}.

The key is inside `.mcp.json`. Treat this folder as a password: anyone holding it acts on the mesh as {{USER}}. Refreshing the key in the agent tray kills it; download the plugin again after.

## Install

Claude Code, as a local marketplace:

```
unzip phosphorus.plugin -d ~/.claude/phosphorus-plugin
claude plugin marketplace add ~/.claude/phosphorus-plugin
claude plugin install phosphorus@phosphorus
```

Or for one session: `claude --plugin-dir ~/.claude/phosphorus-plugin`.

Claude desktop and Cowork: drop `phosphorus.plugin` into a chat, or add it under Settings, Plugins.

Check it with `/mcp` (phosphorus connected) and `/phosphorus:mesh-status`.

## What's in it

- `phosphorus` skill: how the mesh fits together, which tool for which job, the rules for writes
- `references/tools.md`: every tool this key sees, generated from the live server
- `references/playbooks.md`: step by step for the common jobs
- slash skills: `mesh-status`, `mesh-diagnose`, `mesh-run`, `mesh-files`, `mesh-service`, `mesh-update`, `mesh-chat`, `mesh-git`
- `mesh-operator` agent: multi-step mesh work in its own context
