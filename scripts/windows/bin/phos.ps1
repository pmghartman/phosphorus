# phos: the cli with no args, else start / stop / restart / update, the cli
# in the phosphorus container, the host needing nothing past docker
$Scripts = Split-Path -Parent $PSScriptRoot
. "$Scripts/lib/Config.ps1"

function Usage {
    Write-Host "usage: phos              the cli: services, files, git, stats, model, mesh update"
    Write-Host "       phos start        bring this host up (run.ps1)"
    Write-Host "       phos stop         stop phosphorus until the next phos start"
    Write-Host "       phos restart      restart phosphorus (and phosphorus-git), picks up a host rename"
    Write-Host "       phos update       update this host only"
    Write-Host "       phos update all   update the whole mesh, one host at a time"
}

function Started { Invoke-Quiet { docker inspect -f '{{.State.Running}} {{.State.StartedAt}}' phosphorus } }

# a mesh update swaps this container out from under the cli: the new one
# waited for and reattached, on the same tab
function Cli([string[]]$CliArgs) {
    while ($true) {
        $before = Started
        if (-not "$before".StartsWith("true")) {
            Write-Host "phosphorus isn't running, start it with: phos start" -ForegroundColor Red
            exit 1
        }
        docker exec -it -e TERM=xterm-256color -e COLORTERM=truecolor phosphorus node /opt/frontend/cli/phos.js @CliArgs
        $code = $LASTEXITCODE
        if ((Started) -eq $before) { exit $code }
        Write-Host "phosphorus is restarting, reattaching (ctrl-c to quit)..."
        while (-not "$(Started)".StartsWith("true")) { Start-Sleep 1 }
        if ($CliArgs -and $CliArgs[0] -eq "update-all") { $CliArgs = @("--tab", "update") }
    }
}

# PHOS_UPDATE_PASSWORD from .env, as the web and cli ask it, unset: open
function Ask-Password {
    $envFile = Join-Path (Split-Path -Parent $Scripts) ".env"
    $line = if (Test-Path $envFile) { Get-Content $envFile | Where-Object { $_.StartsWith("PHOS_UPDATE_PASSWORD=") } | Select-Object -First 1 }
    $want = if ($line) { $line.Substring("PHOS_UPDATE_PASSWORD=".Length) }
    if (-not $want) { return }
    $got = [Net.NetworkCredential]::new("", (Read-Host "update password" -AsSecureString)).Password
    if ($got -ne $want) { Write-Host "wrong password" -ForegroundColor Red; exit 1 }
}

switch ("$($args[0])|$($args[1])") {
    "|"           { Cli @() }
    "start|"      { & "$Scripts/run.ps1"; exit $LASTEXITCODE }
    "stop|"       {
        # git first, so a master hands off before the frontend goes
        foreach ($c in @("phosphorus-git", "phosphorus", "phosphorus-search")) {
            if ((Invoke-Quiet { docker inspect -f '{{.State.Running}}' $c }) -ne "true") { continue }
            Write-Host "stopping $c..."
            docker stop -t 30 $c | Out-Null
            if ($LASTEXITCODE) { exit 1 }
        }
        Write-Host "phosphorus stopped, phos start starts it again"
    }
    "restart|"    {
        # git stopped first for the handoff, started again once phosphorus is back
        $gitUp = (Invoke-Quiet { docker inspect -f '{{.State.Running}}' phosphorus-git }) -eq "true"
        if ($gitUp) {
            Write-Host "stopping phosphorus-git..."
            docker stop -t 30 phosphorus-git | Out-Null
            if ($LASTEXITCODE) { exit 1 }
        }
        Write-Host "restarting phosphorus..."
        docker restart -t 30 phosphorus | Out-Null
        if ($LASTEXITCODE) { exit 1 }
        if ($gitUp) {
            Write-Host "starting phosphorus-git..."
            docker start phosphorus-git | Out-Null
            if ($LASTEXITCODE) { exit 1 }
        }
        Write-Host "phosphorus restarted"
    }
    "update|"     { Ask-Password; & "$Scripts/update.ps1"; exit $LASTEXITCODE }
    "update|all"  { Cli @("update-all") }
    default       { Usage; if ($args[0] -notin @("help", "-h", "-help", "--help")) { exit 2 } }
}
