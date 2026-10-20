# Run on hosts

Runs a shell command or script on a Phosphorus host as the user and reports the result. Use for "run X on <host>", "on <host>, ...", "check <thing> on every host".

1. Take the host from the request, or every phosphorus host from `mesh_hosts` for "all" or "every host". Confirm the name against `mesh_hosts`.
2. `terminal_run` `host`, `command`. Defaults: persistent session; `mode: ssh` when state from earlier calls could interfere. Fan out over hosts in parallel for `all`.
3. Anything that changes the machine (installs, restarts, deletes, writes outside /tmp) runs only when the user's message plainly asks for it.
4. Long jobs: background with `nohup`, return the pid and log path, poll on request.
5. Report the exit code and the relevant output; trim noise, keep errors verbatim. For `all`, one row per host.
6. No saved login for the host: say so; the user adds it in Phosphorus, profile, saved hosts.
