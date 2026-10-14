# forced command for phosphorus's game-control key: a game's start/stop line
# from config/services.export, run on the host

$ErrorActionPreference = "Stop"
$Dir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ServicesFile = Join-Path $Dir "config/services.export"
$LogDir = Join-Path $Dir "state/game-control"
. "$PSScriptRoot/lib/Config.ps1"

function Fail($msg) { [Console]::Error.WriteLine($msg); exit 1 }

# "<start|stop> <name>", nothing else, the key never reaching a shell
$parts = @("$env:SSH_ORIGINAL_COMMAND".Trim() -split '\s+')
if ($parts.Count -ne 2 -or $parts[0] -notin @("start", "stop")) { Fail "usage: start|stop <name>" }
$action, $name = $parts
if ($name -cnotmatch '^[a-z0-9][a-z0-9-]*$') { Fail "bad game name" }

$cmd = ""
if ((Get-IniValue $ServicesFile $name "type") -eq "game") { $cmd = Get-IniValue $ServicesFile $name $action }
if (-not $cmd) { Fail "$name has no $action command in services.export" }

# output to a file, not the ssh channel a backgrounded server would hold open
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$log = Join-Path $LogDir "$name.log"
Add-Content $log "--- $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ${action}: $cmd"
& powershell -NoProfile -Command $cmd *>> $log
if ($LASTEXITCODE) {
    Get-Content $log -Tail 5 | ForEach-Object { [Console]::Error.WriteLine($_) }
    exit $LASTEXITCODE
}
