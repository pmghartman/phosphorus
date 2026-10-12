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
function Cli([string[]]$CliArgs) {
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

switch ("$($args[0])|$($args[1])") {
    "|"           { Cli @() }
    "start|"      { & "$Scripts/run.ps1"; exit $LASTEXITCODE }
    "stop|"       {
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
        # git stopped first for the handoff, started again once hesperus is back
        $gitUp = (Invoke-Quiet { docker inspect -f '{{.State.Running}}' hesperus-git }) -eq "true"
        if ($gitUp) {
            Write-Host "stopping hesperus-git..."
            docker stop -t 30 hesperus-git | Out-Null
            if ($LASTEXITCODE) { exit 1 }
        }
        Write-Host "restarting hesperus..."
        docker restart -t 30 hesperus | Out-Null
        if ($LASTEXITCODE) { exit 1 }
        if ($gitUp) {
            Write-Host "starting hesperus-git..."
            docker start hesperus-git | Out-Null
            if ($LASTEXITCODE) { exit 1 }
        }
        Write-Host "hesperus restarted"
    }
    "update|"     { Ask-Password; & "$Scripts/update.ps1"; exit $LASTEXITCODE }
    "update|all"  { Cli @("update-all") }
    default       { Usage; if ($args[0] -notin @("help", "-h", "-help", "--help")) { exit 2 } }
}
