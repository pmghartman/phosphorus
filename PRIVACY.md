# Privacy policy

This covers the Phosphorus plugin for Claude Code and the Phosphorus mesh it connects to. Last updated 28 October 2026.

## Who runs what

Phosphorus is self-hosted software. You run the mesh on your own machines. The plugin's author runs no server, so no data from the plugin or your mesh reaches the author.

## What the plugin sends, and where

- **Your mesh domain.** You type it when you enable the plugin. Claude Code keeps it in its own settings on your computer.
- **Tool calls.** Claude Code sends each call straight to your mesh at that domain over HTTPS. A call holds the tool's arguments, such as a host name, a file path or a command. Your mesh's answer goes back to Claude Code the same way.
- **Your sign-in.** You enter your mesh username and password on your mesh's own sign-in page, never in Claude Code or the plugin. Your mesh returns an access token to Claude Code, which stores it on your computer.

Nothing else is collected. The plugin has no analytics, no telemetry and no third-party services.

## What your mesh keeps

Your mesh stores this on your own machines:

- **One access key per user.** All of that user's signed-in agents share it. Sign-in hands Claude Code a sealed copy of this key. Together with the mesh's own secret, that copy opens the host logins you saved in your vault, so agents can act with them. **sign out agents** in the agent tray voids the key, and so does a password change. Either way, every agent has to sign in again.
- **An audit log of every change an agent makes.** For each change it records the time, user, tool, arguments (each cut to 400 bytes) and result. Each host keeps its own log in `state/mcp-audit.jsonl`, readable only by Phosphorus. Once a log grows past 4 MB, its older half is dropped.
- **Recent calls for the agent tray.** Each host keeps up to the last 40 calls per user in memory. This list is lost when Phosphorus restarts.

Registering a client and signing in store nothing beyond the access key above. Client registrations and sign-in codes are sealed with your mesh's secret and kept nowhere.

## Anthropic

Claude Code sends the conversation to Anthropic, including what your mesh returns to tool calls. Anthropic handles that data under its own [privacy policy](https://www.anthropic.com/legal/privacy) and the terms of your Claude plan. The plugin doesn't change that.

## Your control

- **Sign out agents:** use **sign out agents** in the agent tray, or change your password.
- **Remove the plugin:** run `/plugin uninstall phosphorus@phosphorus`.
- **Delete what the mesh keeps:** delete the audit log on each host, or uninstall Phosphorus.

## Contact

Open an issue at https://github.com/pmghartman/phosphorus/issues.
