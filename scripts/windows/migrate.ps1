# old checkout (phosphorus, git-era hesperus) into a home: env, config, data, tailnet id
# the old tree kept
param([Parameter(Mandatory)][string]$Old, [Parameter(Mandatory)][string]$HesperusHome)
$ErrorActionPreference = "Stop"

function Say($msg) { Write-Host "[migrate] $msg" }
function Fail($msg) { Write-Host "[migrate] ERROR: $msg" -ForegroundColor Red; exit 1 }
function Quiet([scriptblock]$Cmd) { $ErrorActionPreference = "Continue"; & $Cmd 2>$null }
# Docker Desktop's VM spelling of a Windows path, /run/desktop/mnt/host/c/x, back to C:\x
function ConvertFrom-VmPath([string]$P) {
    if ($P -match '^/run/desktop/mnt/host/([a-z])(/.*)?$') { return "$($Matches[1].ToUpper()):$(($Matches[2] -replace '/', '\'))" }
    $P
}

$Old = (Resolve-Path $Old).Path
$HomeDir = (Resolve-Path $HesperusHome).Path
if ($Old -eq $HomeDir) { Fail "old checkout and home are the same directory" }
if (-not (Test-Path (Join-Path $Old ".env"))) { Fail "no .env in $Old" }
if (Test-Path (Join-Path $HomeDir ".env")) { Fail "$HomeDir already has a .env, migrated before?" }

# names by era: containers, volumes, ini
$Pre = "phosphorus"; $Ini = "phos.ini"
# whichever container mounts this checkout names the era
foreach ($c in @(Quiet { docker ps -a --format '{{.Names}}' })) {
    $src = ConvertFrom-VmPath (Quiet { docker inspect $c --format '{{range .Mounts}}{{if eq .Destination "/repo"}}{{.Source}}{{end}}{{end}}' })
    if ($c -and $src -and ($src.TrimEnd('\') -eq $Old.TrimEnd('\'))) { $Pre = $c; break }
}
if (-not (Test-Path (Join-Path $Old "config/phos.ini"))) { $Ini = "hesperus.ini" }
$Project = Quiet { docker inspect $Pre --format '{{index .Config.Labels "com.docker.compose.project"}}' }
if (-not $Project) { $Project = ((Split-Path -Leaf $Old).ToLower() -replace '[^a-z0-9_-]', '') }
Say "moving $Old ($Pre, compose project $Project) into $HomeDir"

# git first so a master hands off; never restarted by docker, kept for a rollback
foreach ($c in @("$Pre-git", $Pre, "$Pre-search")) {
    Quiet { docker inspect $c } | Out-Null
    if ($LASTEXITCODE) { continue }
    Say "stopping $c"
    Add-Content (Join-Path $HomeDir ".hesperus-migrated-containers") $c
    Quiet { docker update --restart=no $c } | Out-Null
    Quiet { docker stop -t 30 $c } | Out-Null
    if ($Pre -eq "hesperus") { Quiet { docker rm $c } | Out-Null }
}
foreach ($id in @(Quiet { docker ps -aq --filter "label=org.$Pre.sandbox" })) { if ($id) { Quiet { docker rm -f $id } | Out-Null } }
if ($Pre -eq "phosphorus") { Quiet { docker network rm phos-sandbox } | Out-Null }

# .env as it was, PHOS_ renamed, games under the hesperus zone
# GIT_* (update.sh's private git host) dropped with their comment block
$EnvLines = [System.Collections.Generic.List[string]]::new()
$Buf = @()
foreach ($l in (Get-Content (Join-Path $Old ".env"))) {
    if ($l -match '^#' -or $l -eq "") { $Buf += $l; continue }
    if ($l -match '^GIT_(USERNAME|EMAIL|PASSWORD)=') { $Buf = @(); continue }
    $Buf | ForEach-Object { $EnvLines.Add($_) }; $Buf = @()
    $EnvLines.Add(($l -replace '^PHOS_', 'HESPERUS_' -replace '^GAME_ZONE=.*', 'GAME_ZONE=hesperus'))
}
$Buf | ForEach-Object { $EnvLines.Add($_) }
if (-not ($EnvLines -match '^GAME_ZONE=')) { $EnvLines.Add("GAME_ZONE=hesperus") }
Set-Content (Join-Path $HomeDir ".env") $EnvLines

New-Item -ItemType Directory -Force (Join-Path $HomeDir "config") | Out-Null
$src = Join-Path $Old "config/services.export"
if (Test-Path $src) { Copy-Item $src (Join-Path $HomeDir "config/services.export") -Force }
$src = Join-Path $Old "config/$Ini"
if (Test-Path $src) { Copy-Item $src (Join-Path $HomeDir "config/hesperus.ini") -Force }

foreach ($d in @("state", "files", "git/data", "models")) {
    $s = Join-Path $Old $d
    if (-not (Test-Path $s)) { continue }
    Say "copying $d"
    $t = Join-Path $HomeDir $d
    New-Item -ItemType Directory -Force $t | Out-Null
    robocopy $s $t /E /COPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS | Out-Null
    if ($LASTEXITCODE -ge 8) { Fail "couldn't copy $d" }
}
# a share an in-container rebuild bound off the docker VM's disk (/repo/files), not the drive
$FilesSrc = Quiet { docker inspect $Pre --format '{{range .Mounts}}{{if eq .Destination "/files"}}{{.Source}}{{end}}{{end}}' }
if ($FilesSrc -and -not $FilesSrc.StartsWith("/run/desktop/mnt/host/") -and $FilesSrc -notmatch '^[A-Za-z]:') {
    Say "copying files out of the docker VM's $FilesSrc"
    New-Item -ItemType Directory -Force (Join-Path $HomeDir "files") | Out-Null
    docker run --rm -v "${FilesSrc}:/from:ro" -v "$(Join-Path $HomeDir 'files'):/to" alpine:3 cp -a /from/. /to/
    if ($LASTEXITCODE) { Fail "couldn't copy $FilesSrc out of the docker VM" }
}
Remove-Item (Join-Path $HomeDir "state/ssh_config"), (Join-Path $HomeDir "state/machine.json") -ErrorAction SilentlyContinue

# tailnet identity: same node and ip, no auth key needed
function Copy-Volume([string]$From, [string]$To) {
    Quiet { docker volume inspect $From } | Out-Null
    if ($LASTEXITCODE) { return }
    Quiet { docker volume inspect $To } | Out-Null
    if (-not $LASTEXITCODE) { Say "volume $To already there, leaving it"; return }
    Say "copying volume $From to $To"
    docker volume create $To | Out-Null
    docker run --rm -v "${From}:/from:ro" -v "${To}:/to" alpine:3 cp -a /from/. /to/
    if ($LASTEXITCODE) { Fail "couldn't copy volume $From" }
}
Copy-Volume "${Project}_tailscale-state" "hesperus_tailscale-state"
Copy-Volume "$Pre-git-data" "hesperus-git-data"
Copy-Volume "$Pre-git-db" "hesperus-git-db"
Copy-Volume "$Pre-models" "hesperus-models"

# the old ssh include and PATH entry, the new ones put back by bring-up
$SshConf = Join-Path $env:ProgramData "ssh\ssh_config"
$OldInc = "Include `"$($Old -replace '\\', '/')/state/ssh_config`""
if (Test-Path $SshConf) {
    $lines = @(Get-Content $SshConf)
    if ($lines -contains $OldInc) { Quiet { Set-Content $SshConf @($lines | Where-Object { $_ -ne $OldInc }) } }
}
$OldBin = Join-Path $Old "scripts\windows\bin"
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($UserPath -split ';') -contains $OldBin) {
    [Environment]::SetEnvironmentVariable("Path", (($UserPath -split ';') | Where-Object { $_ -and $_ -ne $OldBin }) -join ';', "User")
}

Set-Content (Join-Path $HomeDir ".hesperus-migrated-from") $Old
Say "done, $Old left as it was: delete it once hesperus is up"
exit 0
