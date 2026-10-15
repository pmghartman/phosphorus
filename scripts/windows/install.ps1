# release files into this host's home, per-host ones kept, then bring-up or the rebuild
# run by the Phosphorus app, or -Headless over ssh: detached, logged, no prompts
param([switch]$Update, [string]$PhosphorusHome = "", [switch]$Headless)
$ErrorActionPreference = "Stop"

function Say($msg) { Write-Host "[install] $msg" }
function Fail($msg) { Write-Host "[install] ERROR: $msg" -ForegroundColor Red; exit 1 }

# outside the ssh session via WMI: sshd taking a dropped session's whole
# process tree with it
if ($Headless) {
    $Log = Join-Path $env:TEMP "phosphorus-install.log"
    $Argv = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
    if ($Update) { $Argv += "-Update" }
    if ($PhosphorusHome) { $Argv += @("-PhosphorusHome", "`"$PhosphorusHome`"") }
    Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = "cmd /c set PHOSPHORUS_NONINTERACTIVE=1&& powershell $($Argv -join ' ') > `"$Log`" 2>&1"
    } | Out-Null
    Say "installing in the background, this terminal may drop"
    Say "Get-Content -Wait $Log to follow"
    exit 0
}

$Payload = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
# not %LOCALAPPDATA%\Phosphorus: the app's own install dir, wiped by its uninstaller
$HomeDir = if ($PhosphorusHome) { $PhosphorusHome } elseif ($env:PHOSPHORUS_HOME) { $env:PHOSPHORUS_HOME } else { Join-Path $env:USERPROFILE "phosphorus" }
if (Test-Path (Join-Path $Payload ".git")) { Fail "$Payload is a git clone, not a release: install from the latest release" }
if ($HomeDir.TrimEnd('\').StartsWith((Split-Path -Parent $Payload).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
    Fail "$HomeDir is inside the app's install dir, which its uninstaller removes"
}
New-Item -ItemType Directory -Force $HomeDir | Out-Null

# every release file into home, what the last one shipped and this one doesn't
# removed, this host's config and share never overwritten
$Manifest = Join-Path $HomeDir ".phosphorus-manifest"
$Next = @(Get-ChildItem -Path $Payload -Recurse -File -Force |
    ForEach-Object { $_.FullName.Substring($Payload.Length + 1) -replace '\\', '/' } |
    Where-Object { -not ((Split-Path -Leaf $_).StartsWith(".phosphorus-")) } | Sort-Object)
foreach ($f in $Next) {
    $dst = Join-Path $HomeDir $f
    if ($f -in @("config/services.export", "config/phosphorus.ini") -or $f.StartsWith("files/")) {
        if (Test-Path $dst) { continue }
    }
    New-Item -ItemType Directory -Force (Split-Path -Parent $dst) | Out-Null
    Copy-Item (Join-Path $Payload $f) $dst -Force
}
if (Test-Path $Manifest) {
    foreach ($f in (Get-Content $Manifest)) {
        if ($f -in $Next -or $f.StartsWith("config/") -or $f.StartsWith("files/")) { continue }
        Remove-Item (Join-Path $HomeDir $f) -Force -ErrorAction SilentlyContinue
        # its folder too, once nothing else is in it
        $d = Split-Path -Parent (Join-Path $HomeDir $f)
        while ($d.Length -gt $HomeDir.Length -and (Test-Path $d) -and -not (Get-ChildItem -Force $d)) {
            Remove-Item $d -Force -ErrorAction SilentlyContinue
            $d = Split-Path -Parent $d
        }
    }
}
Set-Content $Manifest $Next
$Version = (Get-Content (Join-Path $HomeDir "VERSION") -First 1).Trim()
Say "phosphorus $Version in $HomeDir"

$EnvFile = Join-Path $HomeDir ".env"
if (-not (Test-Path $EnvFile)) { Copy-Item (Join-Path $HomeDir ".env.example") $EnvFile }
$Domain = (Get-Content $EnvFile | Where-Object { $_.StartsWith("BASE_DOMAIN=") } | Select-Object -First 1)
if (-not $Domain -or $Domain -in @("BASE_DOMAIN=", "BASE_DOMAIN=example.com")) {
    Say "fill in $EnvFile, then: phosphorus start"
    Set-Content (Join-Path $HomeDir ".phosphorus-installed") $Version
    exit 0
}

if ($Update) {
    & (Join-Path $HomeDir "scripts/windows/rebuild.ps1")
    if ($LASTEXITCODE) { Fail "rebuild failed, still running the previous version" }
} else {
    & (Join-Path $HomeDir "scripts/windows/run.ps1")
    if ($LASTEXITCODE) { Fail "bring-up failed, see above" }
}
Set-Content (Join-Path $HomeDir ".phosphorus-installed") $Version
# the tray app is this host's update agent: at every login, and running now
# (after the marker above, or it would rerun this install on launch)
$App = Join-Path $env:LOCALAPPDATA "Phosphorus\Phosphorus.exe"
if (Test-Path $App) {
    Set-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "Phosphorus" -Value "`"$App`""
    if (-not (Get-Process -Name Phosphorus -ErrorAction SilentlyContinue)) { Start-Process $App }
    Say "Phosphorus app running, mesh updates go through it"
}
