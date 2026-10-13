# hesperus: the cli with no args, else start / stop / restart / update, the cli
# in the hesperus container, the host needing nothing past docker
$Scripts = Split-Path -Parent $PSScriptRoot
. "$Scripts/lib/Config.ps1"

function Usage {
    Write-Host "usage: hesperus              the cli: services, files, git, stats, model, mesh update"
    Write-Host "       hesperus start        bring this host up (run.ps1)"
    Write-Host "       hesperus stop         stop hesperus until the next hesperus start"
    Write-Host "       hesperus restart      restart hesperus (and hesperus-git), picks up a host rename"
    Write-Host "       hesperus update       update this host only"
    Write-Host "       hesperus update all   update the whole mesh, one host at a time"
}

function Started { Invoke-Quiet { docker inspect -f '{{.State.Running}} {{.State.StartedAt}}' hesperus } }

# a mesh update swaps this container out from under the cli: the new one
# waited for and reattached, on the same tab
function Invoke-Cli([string[]]$CliArgs) {
    while ($true) {
        $before = Started
        if (-not "$before".StartsWith("true")) {
            Write-Host "hesperus isn't running, start it with: hesperus start" -ForegroundColor Red
            exit 1
        }
        docker exec -it -e TERM=xterm-256color -e COLORTERM=truecolor hesperus node /opt/frontend/cli/hesperus.js @CliArgs
        $code = $LASTEXITCODE
        if ((Started) -eq $before) { exit $code }
        Write-Host "hesperus is restarting, reattaching (ctrl-c to quit)..."
        while (-not "$(Started)".StartsWith("true")) { Start-Sleep 1 }
        if ($CliArgs -and $CliArgs[0] -eq "update-all") { $CliArgs = @("--tab", "update") }
    }
}

# HESPERUS_UPDATE_PASSWORD from .env, as the web and cli ask it, unset: open
function Ask-Password {
    $envFile = Join-Path (Split-Path -Parent $Scripts) ".env"
    $line = if (Test-Path $envFile) { Get-Content $envFile | Where-Object { $_.StartsWith("HESPERUS_UPDATE_PASSWORD=") } | Select-Object -First 1 }
    $want = if ($line) { $line.Substring("HESPERUS_UPDATE_PASSWORD=".Length) }
    if (-not $want) { return }
    $got = [Net.NetworkCredential]::new("", (Read-Host "update password" -AsSecureString)).Password
    if ($got -ne $want) { Write-Host "wrong password" -ForegroundColor Red; exit 1 }
}

# handed to the Hesperus app, its verdict waited on
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
        if ($i -eq 30 -and -not $a) { Write-Host "nothing picked it up yet: is the Hesperus app running?" }
        Start-Sleep 1
    }
    Write-Host "gave up waiting, see $Out" -ForegroundColor Red; exit 1
}

# reruns this command outside the ssh session via WMI and follows its log:
# sshd taking a dropped session's process tree with it, git left stopped
function Invoke-Detached([string]$Cmd) {
    if ($env:HESPERUS_DETACHED) { return }
    $State = Join-Path (Split-Path -Parent $Scripts) "state"
    New-Item -ItemType Directory -Force $State | Out-Null
    $Log = Join-Path $State "$Cmd.log"
    Set-Content $Log ""
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = "cmd /c set HESPERUS_DETACHED=1&& powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" $Cmd > `"$Log`" 2>&1"
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
        foreach ($c in @("hesperus-git", "hesperus", "hesperus-search")) {
            if ((Invoke-Quiet { docker inspect -f '{{.State.Running}}' $c }) -ne "true") { continue }
            Write-Host "stopping $c..."
            docker stop -t 30 $c | Out-Null
            if ($LASTEXITCODE) { exit 1 }
        }
        Write-Host "hesperus stopped, hesperus start starts it again"
    }
    "restart|"    {
        Invoke-Detached "restart"
        # git stopped first for the handoff, started again once hesperus is back
        $gitUp = (Invoke-Quiet { docker inspect -f '{{.State.Running}}' hesperus-git }) -eq "true"
        if ($gitUp) {
            Write-Host "stopping hesperus-git..."
            docker stop -t 30 hesperus-git | Out-Null
            if ($LASTEXITCODE) { exit 1 }
        }
        Write-Host "restarting hesperus..."
        $rc = 0
        docker restart -t 30 hesperus | Out-Null
        if ($LASTEXITCODE) { Write-Host "couldn't restart hesperus" -ForegroundColor Red; $rc = 1 }
        # git back whatever became of hesperus, else it stays stopped
        if ($gitUp) {
            Write-Host "starting hesperus-git..."
            docker start hesperus-git | Out-Null
            if ($LASTEXITCODE) { Write-Host "couldn't start hesperus-git" -ForegroundColor Red; $rc = 1 }
        }
        if (-not $rc) { Write-Host "hesperus restarted" }
        exit $rc
    }
    "update|"     { Ask-Password; Request-Update }
    "update|all"  { Invoke-Cli @("update-all") }
    default       { Usage; if ($args[0] -notin @("help", "-h", "-help", "--help")) { exit 2 } }
}
