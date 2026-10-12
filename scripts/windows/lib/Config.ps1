# readers for config/phos.ini, config/services.export and .env, from the
# checkout root, dot-sourced by run, rebuild, update, game-control and phos

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

# VERSION's <major>.<minor>, then the commit count
function Get-PhosVersion {
    $n = Invoke-Quiet { git rev-list --count HEAD }
    "$((Get-Content VERSION -First 1).Trim()).$(if ($n) { $n } else { 0 })"
}

function Get-PhosIniPath { if (Test-Path config/phos.ini) { "config/phos.ini" } }

function Get-PhosValue([string]$Section, [string]$Key) { Get-IniValue (Get-PhosIniPath) $Section $Key }

function Test-PhosGitHost { (Get-PhosValue "git" "host") -eq "true" }

# skip-worktree: an update restores this host's phos.ini verbatim, so
# sections added upstream are appended here
function Add-PhosMissingSections {
    $file = Get-PhosIniPath
    if (-not $file) { return }
    if ((Get-Content $file) -notcontains "[files]") {
        Add-Content $file @(
            "",
            "[files]",
            "# host directories on the Files tab, comma separated, blank: the repo's files/",
            "# priv: one r/w/d set per dir, same order, r browse and download,",
            "# w upload, new folder and rename, d delete, none: rwd",
            "dir =",
            "priv ="
        )
        Write-Host "[phos.ini] added the [files] section, set dir to publish a directory"
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
        Write-Host "[phos.ini] added the [model] section, set host and url on the one host with the memory and disk for the model"
    }
}

# [model] gpu: the image built with llama.cpp's cuda backend
function Test-PhosModelHost { (Get-PhosValue "model" "host") -eq "true" }
function Test-PhosModelGpu { (Get-PhosValue "model" "gpu") -eq "true" }

# absolute host path published on the frontend's Files tab, the repo's own
# files/ when [files] dir is blank, so the mount always resolves
function Get-PhosFilesDir {
    $dir = Get-PhosValue "files" "dir"
    if (-not $dir) { return (Join-Path (Get-Location) "files") }
    if ([System.IO.Path]::IsPathRooted($dir)) { return $dir }
    return (Join-Path (Get-Location) $dir)
}

# [files] dir, one absolute host path per entry, empty when unset, relative
# entries off -Base, the checkout
function Get-PhosFilesDirList([string]$Base) {
    $raw = Get-PhosValue "files" "dir"
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
function Get-PhosFilesPermList {
    $raw = Get-PhosValue "files" "priv"
    if (-not $raw) { return @() }
    return @($raw.Split(",") | ForEach-Object { $_.Trim() })
}

# shares in an override beside compose (no variable mount count there),
# rewritten every build, never committed
$PhosFilesOverride = "docker-compose.files.yml"

# $true when it wrote one and the caller should add it to COMPOSE_FILE
function Write-PhosFilesOverride([string]$Base) {
    $dirs = @()
    foreach ($d in (Get-PhosFilesDirList $Base)) {
        if (-not (Test-Path -PathType Container $d)) {
            Write-Host "[files] skipping '$d'; no such directory on this host"
            continue
        }
        $dirs += $d
    }
    if (-not $dirs.Count) {
        if (Test-Path $PhosFilesOverride) { Remove-Item $PhosFilesOverride -Force }
        return $false
    }

    $perms = Get-PhosFilesPermList
    $lines = @(
        "# generated from [files] in config/phos.ini, rewritten every build",
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
    $lines += "      PHOS_FILES_DIRS: `"$($dirs -join ',')`""
    $lines += "      PHOS_FILES_PERMS: `"$($permList -join ',')`""
    $lines += "    volumes:"
    $lines += $mounts
    Set-Content -Path $PhosFilesOverride -Value $lines
    return $true
}
