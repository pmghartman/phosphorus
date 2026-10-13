# release files into this host's home, per-host ones kept, then bring-up or the rebuild
# run by the Hesperus app, or -Headless over ssh: detached, logged, no prompts
param([switch]$Update, [string]$From = "", [string]$HesperusHome = "", [switch]$Headless)
$ErrorActionPreference = "Stop"

function Say($msg) { Write-Host "[install] $msg" }
function Fail($msg) { Write-Host "[install] ERROR: $msg" -ForegroundColor Red; exit 1 }

# outside the ssh session via WMI: the migration stopping the old tailnet, and
# sshd taking a dropped session's whole process tree with it
if ($Headless) {
    $Log = Join-Path $env:TEMP "hesperus-install.log"
    $Argv = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
    if ($Update) { $Argv += "-Update" }
    if ($From) { $Argv += @("-From", "`"$From`"") }
    if ($HesperusHome) { $Argv += @("-HesperusHome", "`"$HesperusHome`"") }
    Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = "cmd /c set HESPERUS_NONINTERACTIVE=1&& powershell $($Argv -join ' ') > `"$Log`" 2>&1"
    } | Out-Null
    Say "installing in the background, this terminal may drop"
    Say "Get-Content -Wait $Log to follow"
    exit 0
}

$Payload = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
# not %LOCALAPPDATA%\Hesperus: the app's own install dir, wiped by its uninstaller
$HomeDir = if ($HesperusHome) { $HesperusHome } elseif ($env:HESPERUS_HOME) { $env:HESPERUS_HOME } else { Join-Path $env:USERPROFILE "hesperus" }
if (Test-Path (Join-Path $Payload ".git")) { Fail "$Payload is a git clone, not a release: install from the latest release" }
if ($HomeDir.TrimEnd('\').StartsWith((Split-Path -Parent $Payload).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
    Fail "$HomeDir is inside the app's install dir, which its uninstaller removes"
}
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

# Docker Desktop's VM spelling of a Windows path, /run/desktop/mnt/host/c/x, back to C:\x
function ConvertFrom-VmPath([string]$P) {
    if ($P -match '^/run/desktop/mnt/host/([a-z])(/.*)?$') { return "$($Matches[1].ToUpper()):$(($Matches[2] -replace '/', '\'))" }
    $P
}

# any earlier checkout's /repo (phosphorus, git-era hesperus), from its container
function Find-OldCheckout {
    $ErrorActionPreference = "Continue"
    foreach ($c in @(docker ps -a --format '{{.Names}}' 2>$null)) {
        $ErrorActionPreference = "Continue"
        $src = ConvertFrom-VmPath (docker inspect $c --format '{{range .Mounts}}{{if eq .Destination "/repo"}}{{.Source}}{{end}}{{end}}' 2>$null)
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

# new containers gone, the migrated ones restarted, .env set aside so a rerun migrates again
function Undo-Migration {
    Say "rolling back to the old install"
    $ErrorActionPreference = "Continue"
    foreach ($c in @("hesperus-git", "hesperus", "hesperus-search")) { docker rm -f $c 2>$null | Out-Null }
    $Was = Join-Path $HomeDir ".hesperus-migrated-containers"
    $Old = @(if (Test-Path $Was) { Get-Content $Was })
    # git last, after its frontend
    [array]::Reverse($Old)
    foreach ($c in $Old) {
        docker update --restart=unless-stopped $c 2>$null | Out-Null
        docker start $c 2>$null | Out-Null
        if (-not $LASTEXITCODE) { Say "restarted $c" }
    }
    Move-Item $EnvFile (Join-Path $HomeDir ".env.failed-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())") -Force
    Remove-Item $Was -ErrorAction SilentlyContinue
    Say "old install running again; fix the error above and rerun the installer"
}

if ($Update) {
    & (Join-Path $HomeDir "scripts/windows/rebuild.ps1")
    if ($LASTEXITCODE) { Fail "rebuild failed, still running the previous version" }
} else {
    & (Join-Path $HomeDir "scripts/windows/run.ps1")
    if ($LASTEXITCODE) {
        if (Test-Path (Join-Path $HomeDir ".hesperus-migrated-containers")) { Undo-Migration }
        Fail "bring-up failed, see above"
    }
}
Remove-Item (Join-Path $HomeDir ".hesperus-migrated-containers") -ErrorAction SilentlyContinue
Set-Content (Join-Path $HomeDir ".hesperus-installed") $Version
# the tray app is this host's update agent: at every login, and running now
# (after the marker above, or it would rerun this install on launch)
$App = Join-Path $env:LOCALAPPDATA "Hesperus\Hesperus.exe"
if (Test-Path $App) {
    Set-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "Hesperus" -Value "`"$App`""
    if (-not (Get-Process -Name Hesperus -ErrorAction SilentlyContinue)) { Start-Process $App }
    Say "Hesperus app running, mesh updates go through it"
}
