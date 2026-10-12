# pull, then the rebuild in rebuild.ps1, the git repo as the distribution
# mechanism
$ErrorActionPreference = "Stop"
$Dir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Dir

function Say($msg) { Write-Host "[update] $msg" }
function Fail($msg) { Write-Host "[update] ERROR: $msg" -ForegroundColor Red; exit 1 }

# $ErrorActionPreference skips native commands, exit codes checked by hand
if (-not (Test-Path config/services.export)) { Fail "config/services.export not found, are you running this from inside the hesperus clone?" }

# the public repo, every host's origin, no credentials needed
$Upstream = "https://github.com/pmghartman/hesperus.git"
if ((git remote get-url origin) -ne $Upstream) { git remote set-url origin $Upstream }

Say "pulling latest..."
# origin briefly unreachable, 2 min waited out
for ($Tries = 1; ; $Tries++) {
    git fetch origin
    if (-not $LASTEXITCODE) { break }
    if ($Tries -ge 24) { Fail "couldn't fetch origin, nothing changed" }
    Say "origin unreachable, retrying in 5s"
    Start-Sleep 5
}

# .env untracked but a reset off a commit still tracking it deletes it,
# so saved and put back too
$EnvSaved = $null
if (Test-Path .env) {
    $EnvSaved = [System.IO.Path]::GetTempFileName()
    Copy-Item .env $EnvSaved -Force
}

# reset ignoring skip-worktree: each per-host file saved, reset with the
# flag off, then put back
$Keep = @{}
foreach ($f in @("config/services.export", "config/hesperus.ini")) {
    if (-not (Test-Path $f)) { continue }
    $Keep[$f] = [System.IO.Path]::GetTempFileName()
    Copy-Item $f $Keep[$f] -Force
    git update-index --no-skip-worktree $f
}
git reset --hard origin/main
$Reset = -not $LASTEXITCODE
foreach ($f in $Keep.Keys) {
    if ($Reset) { Copy-Item $Keep[$f] $f -Force }
    Remove-Item $Keep[$f] -ErrorAction SilentlyContinue
    git update-index --skip-worktree $f
}
if ($EnvSaved) {
    Copy-Item $EnvSaved .env -Force
    Remove-Item $EnvSaved -ErrorAction SilentlyContinue
}
if (-not $Reset) { Fail "couldn't reset to origin/main, nothing changed" }

$Version = (Get-Content VERSION -Raw).Trim()

# main's copy of rebuild.ps1, post-reset: reads hesperus.ini itself, announces
# the swap to the frontend, or skips it when nothing changed
Say "restarting onto $Version, a few minutes"
& "$PSScriptRoot/rebuild.ps1"
if ($LASTEXITCODE) { Fail "rebuild failed, still running the previous version" }
