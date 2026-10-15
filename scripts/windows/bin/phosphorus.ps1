# phosphorus: the cli with no args, else start / stop / restart / update, the cli
# in the phosphorus container, the host needing nothing past docker
$Scripts = Split-Path -Parent $PSScriptRoot
. "$Scripts/lib/Config.ps1"

function Usage {
    Write-Host "usage: phos             the cli"
    Write-Host "       phos start       start host"
    Write-Host "       phos stop        stop host"
    Write-Host "       phos restart     restart host"
    Write-Host "       phos update      update host"
    Write-Host "       phos update all  update mesh"
}

function Started { Invoke-Quiet { docker inspect -f '{{.State.Running}} {{.State.StartedAt}}' phosphorus } }

# the binary's cli, node's on an image from before it
# no double quotes, powershell 5 drops them on the way to docker
$Cli = 'command -v phosphorus >/dev/null && exec phosphorus cli $@; exec node /opt/frontend/cli/phosphorus.js $@'

# a mesh update swaps this container out from under the cli: the new one
# waited for and reattached, on the same tab
function Invoke-Cli([string[]]$CliArgs) {
    while ($true) {
        $before = Started
        if (-not "$before".StartsWith("true")) {
            Write-Host "phosphorus isn't running, run: phos start" -ForegroundColor Red
            exit 1
        }
        docker exec -it -e TERM=xterm-256color -e COLORTERM=truecolor phosphorus sh -c $Cli sh @CliArgs
        $code = $LASTEXITCODE
        if ((Started) -eq $before) { exit $code }
        Write-Host "phosphorus is restarting, reattaching (ctrl-c to quit)..."
        while (-not "$(Started)".StartsWith("true")) { Start-Sleep 1 }
        if ($CliArgs -and $CliArgs[0] -eq "update-all") { $CliArgs = @("--tab", "update") }
    }
}

# ADMIN_PASS from .env (PHOSPHORUS_UPDATE_PASSWORD before it), unset: open
function Ask-Password {
    $envFile = Join-Path (Split-Path -Parent $Scripts) ".env"
    $want = $null
    foreach ($key in @("ADMIN_PASS=", "PHOSPHORUS_UPDATE_PASSWORD=")) {
        $line = if (Test-Path $envFile) { Get-Content $envFile | Where-Object { $_.StartsWith($key) } | Select-Object -First 1 }
        if ($line -and -not $want) { $want = $line.Substring($key.Length) }
    }
    if (-not $want) { return }
    $got = [Net.NetworkCredential]::new("", (Read-Host "admin password" -AsSecureString)).Password
    if ($got -ne $want) { Write-Host "wrong password" -ForegroundColor Red; exit 1 }
}

# handed to the Phosphorus app, its verdict waited on
function Request-Update {
    $Root = Split-Path -Parent $Scripts
    $State = Join-Path $Root "state"
    New-Item -ItemType Directory -Force $State | Out-Null
    $Id = "cli-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())-$PID"
    Set-Content (Join-Path $State "update-request.json") "{`"id`":`"$Id`",`"at`":$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())}"
    Write-Host "update requested, checking the release feed..."
    $Out = Join-Path $State "update-agent.json"
    for ($i = 1; $i -le 1800; $i++) {
        $a = $null
        try { $a = Get-Content $Out -Raw -ErrorAction Stop | ConvertFrom-Json } catch {}
        if ($a -and $a.id -eq $Id) {
            if ($a.state -eq "failed") { Write-Host "update failed: $($a.error)" -ForegroundColor Red; exit 1 }
            if ($a.state -eq "ok") { if ($a.current) { Write-Host "already up to date" } else { Write-Host "updated to $($a.version)" }; exit 0 }
        }
        if ($i -eq 30 -and -not $a) { Write-Host "nothing picked it up yet: is the Phosphorus app running?" }
        Start-Sleep 1
    }
    Write-Host "gave up waiting, see $Out" -ForegroundColor Red; exit 1
}

# reruns this command outside the ssh session via WMI and follows its log:
# sshd taking a dropped session's process tree with it, git left stopped
function Invoke-Detached([string]$Cmd) {
    if ($env:PHOSPHORUS_DETACHED) { return }
    $State = Join-Path (Split-Path -Parent $Scripts) "state"
    New-Item -ItemType Directory -Force $State | Out-Null
    $Log = Join-Path $State "$Cmd.log"
    Set-Content $Log ""
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = "cmd /c set PHOSPHORUS_DETACHED=1&& powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" $Cmd > `"$Log`" 2>&1"
    }
    $seen = 0
    do {
        Start-Sleep -Milliseconds 500
        $lines = @(Get-Content $Log -ErrorAction SilentlyContinue)
        $lines | Select-Object -Skip $seen | ForEach-Object { Write-Host $_ }
        $seen = $lines.Count
    } while (Get-Process -Id $r.ProcessId -ErrorAction SilentlyContinue)
    exit 0
}

switch ("$($args[0])|$($args[1])") {
    "|"           { Invoke-Cli @() }
    "start|"      { & "$Scripts/run.ps1"; exit $LASTEXITCODE }
    "stop|"       {
        Invoke-Detached "stop"
        # git first, so a master hands off before the frontend goes
        foreach ($c in @("phosphorus-git", "phosphorus", "phosphorus-search")) {
            if ((Invoke-Quiet { docker inspect -f '{{.State.Running}}' $c }) -ne "true") { continue }
            Write-Host "stopping $c..."
            docker stop -t 30 $c | Out-Null
            if ($LASTEXITCODE) { exit 1 }
        }
        Write-Host "phosphorus stopped, phos start to resume"
    }
    "restart|"    {
        Invoke-Detached "restart"
        # git stopped first for the handoff, started again once phosphorus is back
        $gitUp = (Invoke-Quiet { docker inspect -f '{{.State.Running}}' phosphorus-git }) -eq "true"
        if ($gitUp) {
            Write-Host "stopping phosphorus-git..."
            docker stop -t 30 phosphorus-git | Out-Null
            if ($LASTEXITCODE) { exit 1 }
        }
        Write-Host "restarting phosphorus..."
        $rc = 0
        docker restart -t 30 phosphorus | Out-Null
        if ($LASTEXITCODE) { Write-Host "couldn't restart phosphorus" -ForegroundColor Red; $rc = 1 }
        # git back whatever became of phosphorus, else it stays stopped
        if ($gitUp) {
            Write-Host "starting phosphorus-git..."
            docker start phosphorus-git | Out-Null
            if ($LASTEXITCODE) { Write-Host "couldn't start phosphorus-git" -ForegroundColor Red; $rc = 1 }
        }
        if (-not $rc) { Write-Host "phosphorus restarted" }
        exit $rc
    }
    "update|"     { Ask-Password; Request-Update }
    "update|all"  { Invoke-Cli @("update-all") }
    default       { Usage; if ($args[0] -notin @("help", "-h", "-help", "--help")) { exit 2 } }
}
