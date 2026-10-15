# readers for config/phosphorus.ini, config/services.export and .env, from the
# home, dot-sourced by run, rebuild, update, game-control and phosphorus

# `key = value` lines under `[section]`, blank when unset or the file is missing
function Get-IniValue([string]$File, [string]$Section, [string]$Key) {
    if (-not $File -or -not (Test-Path $File)) { return "" }
    $sec = ""
    foreach ($line in Get-Content $File) {
        if ($line.StartsWith("[")) { $sec = $line; continue }
        if ($sec -eq "[$Section]" -and $line.StartsWith("$Key =")) {
            return $line.Substring($Key.Length + 2).Trim().Replace('"', '')
        }
    }
    return ""
}

# blank when unset
function Get-EnvValue([string]$Key) {
    if (-not (Test-Path .env)) { return "" }
    foreach ($line in Get-Content .env) {
        if ($line.StartsWith("$Key=")) { return $line.Substring($Key.Length + 1) }
    }
    return ""
}

# stderr dropped: under Stop, Windows PowerShell turning any of it into a throw
function Invoke-Quiet([scriptblock]$Cmd) { $ErrorActionPreference = "Continue"; & $Cmd 2>$null }

# the release's own, stamped by CI
function Get-PhosphorusVersion { (Get-Content VERSION -First 1).Trim() }

# the release's images pulled and tagged as compose names them, cuda per [model] gpu
function Invoke-PhosphorusPull {
    $v = Get-PhosphorusVersion
    $sfx = if (Test-PhosphorusModelGpu) { "-cuda" } else { "" }
    foreach ($p in @(@("phosphorus:$v$sfx", "phosphorus:latest"), @("phosphorus-git:$v", "phosphorus-git:latest"))) {
        $from = "ghcr.io/pmghartman/$($p[0])"
        docker pull -q $from | Out-Null
        if ($LASTEXITCODE) { return $false }
        docker tag $from $p[1]
        if ($LASTEXITCODE) { return $false }
    }
    $true
}

function Get-PhosphorusIniPath { if (Test-Path config/phosphorus.ini) { "config/phosphorus.ini" } }

function Get-PhosphorusValue([string]$Section, [string]$Key) { Get-IniValue (Get-PhosphorusIniPath) $Section $Key }

function Test-PhosphorusGitHost { (Get-PhosphorusValue "git" "host") -eq "true" }

# the installer never overwrites this host's phosphorus.ini, so sections added
# since are appended here
function Add-PhosphorusMissingSections {
    $file = Get-PhosphorusIniPath
    if (-not $file) { return }
    if ((Get-Content $file) -notcontains "[home]") {
        Add-Content $file @(
            "",
            "[home]",
            "# dir: where usr/ (each user's home, shared/) and sys/ live, blank: the home's state/",
            "# changed: both copied there on the next rebuild and the old ones deleted",
            "dir ="
        )
        Write-Host "[phosphorus.ini] added the [home] section"
    }
    if ((Get-Content $file) -notcontains "[files]") {
        Add-Content $file @(
            "",
            "[files]",
            "# host directories on the Files tab, comma separated, blank: the home's files/",
            "# priv: one r/w/d set per dir, same order, r browse and download,",
            "# w upload, new folder and rename, d delete, none: rwd",
            "dir =",
            "priv ="
        )
        Write-Host "[phosphorus.ini] added the [files] section, set dir to publish a directory"
    }
    if ((Get-Content $file) -notcontains "[model]") {
        Add-Content $file @(
            "",
            "[model]",
            "# host: true downloads the mesh model here and runs it for every host",
            "# gpu: true offloads it to this host's nvidia gpu",
            "# url: download link to the model's .gguf, no default",
            "host = false",
            "gpu = false",
            "url ="
        )
        Write-Host "[phosphorus.ini] added the [model] section, set host and url on the one host with the memory and disk for the model"
    }
}

# [model] gpu: the image built with llama.cpp's cuda backend
function Test-PhosphorusModelHost { (Get-PhosphorusValue "model" "host") -eq "true" }
function Test-PhosphorusModelGpu { (Get-PhosphorusValue "model" "gpu") -eq "true" }

# absolute host path published on the frontend's Files tab, the repo's own
# files/ when [files] dir is blank, so the mount always resolves
# [home] dir, where usr/ and sys/ live, the home's state\ when blank
function Get-PhosphorusHomeDir {
    $dir = (Get-PhosphorusValue "home" "dir")
    if ($dir) { $dir = $dir.TrimEnd("/", "\") }
    if (-not $dir) { return (Join-Path (Get-Location) "state") }
    if ([System.IO.Path]::IsPathRooted($dir)) { return $dir }
    return (Join-Path (Get-Location) $dir)
}

# a Windows path as Docker Desktop's VM mounts it
function ConvertTo-VmPath([string]$Path) {
    "/run/desktop/mnt/host/" + $Path.Substring(0, 1).ToLower() + ($Path.Substring(2) -replace '\\', '/')
}

function Get-PhosphorusFilesDir {
    $dir = Get-PhosphorusValue "files" "dir"
    if (-not $dir) { return (Join-Path (Get-Location) "files") }
    if ([System.IO.Path]::IsPathRooted($dir)) { return $dir }
    return (Join-Path (Get-Location) $dir)
}

# [files] dir, one absolute host path per entry, empty when unset, relative
# entries off -Base, the home
function Get-PhosphorusFilesDirList([string]$Base) {
    $raw = Get-PhosphorusValue "files" "dir"
    if (-not $raw) { return @() }
    if (-not $Base) { $Base = (Get-Location).Path }
    $out = @()
    foreach ($d in $raw.Split(",")) {
        $d = $d.Trim().TrimEnd("/", "\")
        if (-not $d) { continue }
        if ([System.IO.Path]::IsPathRooted($d)) { $out += $d }
        else { $out += (Join-Path $Base $d) }
    }
    return $out
}

# [files] priv, one entry per dir in the same order, none means rwd
function Get-PhosphorusFilesPermList {
    $raw = Get-PhosphorusValue "files" "priv"
    if (-not $raw) { return @() }
    return @($raw.Split(",") | ForEach-Object { $_.Trim() })
}

# shares in an override beside compose (no variable mount count there),
# rewritten every build, never committed
$PhosphorusFilesOverride = "docker-compose.files.yml"

# $true when it wrote one and the caller should add it to COMPOSE_FILE
function Write-PhosphorusFilesOverride([string]$Base) {
    $dirs = @()
    foreach ($d in (Get-PhosphorusFilesDirList $Base)) {
        if (-not (Test-Path -PathType Container $d)) {
            Write-Host "[files] skipping '$d'; no such directory on this host"
            continue
        }
        $dirs += $d
    }
    if (-not $dirs.Count) {
        if (Test-Path $PhosphorusFilesOverride) { Remove-Item $PhosphorusFilesOverride -Force }
        return $false
    }

    $perms = Get-PhosphorusFilesPermList
    $lines = @(
        "# generated from [files] in config/phosphorus.ini, rewritten every build",
        "services:",
        "  phosphorus:",
        "    environment:"
    )
    $permList = @()
    $mounts = @()
    for ($i = 0; $i -lt $dirs.Count; $i++) {
        $perm = if ($i -lt $perms.Count -and $perms[$i]) { $perms[$i] } else { "rwd" }
        $permList += $perm
        # nothing that writes: docker-enforced too, not just the frontend
        $mode = if ($perm -match "[wd]") { "" } else { ":ro" }
        $mounts += "      - `"$($dirs[$i]):/shares/$i$mode`""
    }
    $lines += "      PHOSPHORUS_FILES_DIRS: `"$($dirs -join ',')`""
    $lines += "      PHOSPHORUS_FILES_PERMS: `"$($permList -join ',')`""
    $lines += "    volumes:"
    $lines += $mounts
    Set-Content -Path $PhosphorusFilesOverride -Value $lines
    return $true
}
