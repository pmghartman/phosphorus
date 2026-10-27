# Run on hosts

Runs a command or script on one host or every host as the user, through `terminal_run`.

1. Host from the request, checked against `mesh_hosts`; "all" means every phosphorus host, called in parallel.
2. `terminal_run` `host`, `command`. With a saved login it defaults to a persistent session (cwd and env carry over between calls; `reset` starts fresh); `mode: ssh` for a clean shell when earlier state could interfere. Scripts and file content go through `stdin` (`cat > path`), never quoted into the command.
3. Anything that changes the machine (installs, restarts, deletes, writes outside /tmp) only when the user plainly asks.
4. Long jobs: `wait_s` caps at 600, so `nohup cmd > /tmp/job.log 2>&1 & echo $!`, then poll `tail -n 50 /tmp/job.log; kill -0 <pid> && echo running`.
5. The user wants to watch, or has no saved login for the host: `open_terminal`, then `terminal_run` `mode: tab` (one line per call, read each screen before the next) and `terminal_screen` with `wait_s` to follow output.
6. Report the exit code and the relevant output, errors verbatim; for "all", one row per host. A non-zero exit is the result, not a reason to retry. No saved login and no tab wanted: say so; the user saves one in Phosphorus under profile, saved hosts.
