# release files into this host's home, per-host ones kept, then bring-up or the rebuild
# run by the Hesperus app
param([switch]$Update, [string]$From = "", [string]$HesperusHome = "")
$ErrorActionPreference = "Stop"

function Say($msg) { Write-Host "[install] $msg" }
function Fail($msg) { Write-Host "[install] ERROR: $msg" -ForegroundColor Red; exit 1 }

$Payload = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$HomeDir = if ($HesperusHome) { $HesperusHome } elseif ($env:HESPERUS_HOME) { $env:HESPERUS_HOME } else { Join-Path $env:LOCALAPPDATA "Hesperus" }
if (Test-Path (Join-Path $Payload ".git")) { Fail "$Payload is a checkout, run scripts/windows/run.ps1 there" }
New-Item -ItemType Directory -Force $HomeDir | Out-Null

# every release file into home, what the last one shipped and this one doesn't
# removed, this host's config and share never overwritten
$Manifest = Join-Path $HomeDir ".hesperus-manifest"
$Next = @(Get-ChildItem -Path $Payload -Recurse -File -Force |
    ForEach-Object { $_.FullName.Substring($Payload.Length + 1) -replace '\\', '/' } |
    Where-Object { -not ((Split-Path -Leaf $_).StartsWith(".hesperus-")) } | Sort-Object)
foreach ($f in $Next) {
    $dst = Join-Path $HomeDir $f
    if ($f -in @("config/services.export", "config/hesperus.ini") -or $f.StartsWith("files/")) {
        if (Test-Path $dst) { continue }
    }
    New-Item -ItemType Directory -Force (Split-Path -Parent $dst) | Out-Null
    Copy-Item (Join-Path $Payload $f) $dst -Force
}
if (Test-Path $Manifest) {
    foreach ($f in (Get-Content $Manifest)) {
        if ($f -in $Next -or $f.StartsWith("config/") -or $f.StartsWith("files/")) { continue }
        Remove-Item (Join-Path $HomeDir $f) -Force -ErrorAction SilentlyContinue
    }
}
Set-Content $Manifest $Next
$Version = (Get-Content (Join-Path $HomeDir "VERSION") -First 1).Trim()
Say "hesperus $Version in $HomeDir"

# a phosphorus or git-era hesperus checkout's /repo, from its container
function Find-OldCheckout {
    foreach ($c in @("phosphorus", "hesperus")) {
        $ErrorActionPreference = "Continue"
        $src = docker inspect $c --format '{{range .Mounts}}{{if eq .Destination "/repo"}}{{.Source}}{{end}}{{end}}' 2>$null
        if ($src -and $src -ne $HomeDir -and (Test-Path (Join-Path $src ".env"))) { return $src }
    }
    ""
}

$EnvFile = Join-Path $HomeDir ".env"
if (-not (Test-Path $EnvFile)) {
    if (-not $From) { $From = Find-OldCheckout }
    if ($From) {
        & (Join-Path $HomeDir "scripts/windows/migrate.ps1") -Old $From -HesperusHome $HomeDir
        if ($LASTEXITCODE) { Fail "migration from $From failed, it's still there as it was" }
    }
}
if (-not (Test-Path $EnvFile)) { Copy-Item (Join-Path $HomeDir ".env.example") $EnvFile }
$Domain = (Get-Content $EnvFile | Where-Object { $_.StartsWith("BASE_DOMAIN=") } | Select-Object -First 1)
if (-not $Domain -or $Domain -in @("BASE_DOMAIN=", "BASE_DOMAIN=example.com")) {
    Say "fill in $EnvFile, then: hesperus start"
    Set-Content (Join-Path $HomeDir ".hesperus-installed") $Version
    exit 0
}

if ($Update) {
    & (Join-Path $HomeDir "scripts/windows/rebuild.ps1")
    if ($LASTEXITCODE) { Fail "rebuild failed, still running the previous version" }
} else {
    & (Join-Path $HomeDir "scripts/windows/run.ps1")
    if ($LASTEXITCODE) { Fail "bring-up failed, see above" }
}
Set-Content (Join-Path $HomeDir ".hesperus-installed") $Version
