# Run on hosts

Runs a command or script on one host or every host as the user.

1. Host from the request, checked against `mesh_hosts`; "all" means every phosphorus host, in parallel.
2. `terminal_run` `host`, `command`. The default session keeps cwd and env; `mode: ssh` when earlier state could interfere. Scripts and file content go through `stdin` (`cat > path`), never quoted into the command.
3. Anything that changes the machine (installs, restarts, deletes, writes outside /tmp) only when the user plainly asks.
4. Long jobs: `wait_s` caps at 600, so `nohup cmd > /tmp/job.log 2>&1 & echo $!`, then poll `tail -n 50 /tmp/job.log; kill -0 <pid> && echo running`.
5. Watching with the user: `open_terminal`, then `terminal_run` `mode: tab` or `terminal_type` (they press Enter), `terminal_screen` `wait_s` to follow.
6. Report the exit code and the relevant output, errors verbatim; for "all", one row per host. A non-zero exit is the result, not a reason to retry. No saved login: say so; the user adds it in Phosphorus, profile, saved hosts.
