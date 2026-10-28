# Phosphorus for Claude Code

The Phosphorus skill and connector together, so Claude Code can read and operate your self-hosted mesh: hosts, services, files in shares, terminals, logs, Forgejo, the mesh chat and updates.

## Install

```
/plugin marketplace add pmghartman/phosphorus
/plugin install phosphorus@phosphorus
```

Claude Code asks for your **mesh domain**, the address you open your mesh at (such as `mesh.example.com`). Then run `/mcp`, pick **phosphorus** and sign in: your browser opens the mesh's own sign-in page, where you enter your mesh user and password and allow the agent. Claude Code keeps the token; your password never leaves the mesh.

The skill updates with the plugin. The tools and their descriptions come live from your mesh, so they always match the version it runs.

## Signing out

**sign out agents** in the agent tray of your mesh's desktop signs out every agent you've signed in. Changing your password does the same.

## Data

Calls go from Claude Code straight to your mesh at the domain you entered, and run with your mesh user's rights and saved host logins. Nothing goes anywhere else. See the [privacy policy](https://github.com/pmghartman/phosphorus/blob/main/PRIVACY.md).
