# readers for config/hesperus.ini, config/services.export and .env, from the
# checkout root, dot-sourced by run, rebuild, update, game-control and hesperus

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

# installed from a release: no .git, VERSION the release's own
function Test-HesperusInstalled { -not (Test-Path .git) }

# a release: VERSION, a checkout: VERSION's <major>.<minor>, then the commit count
function Get-HesperusVersion {
    if (Test-HesperusInstalled) { return (Get-Content VERSION -First 1).Trim() }
    $n = Invoke-Quiet { git rev-list --count HEAD }
    "$((Get-Content VERSION -First 1).Trim()).$(if ($n) { $n } else { 0 })"
}

# the release's images pulled and tagged as compose names them, cuda per [model] gpu
function Invoke-HesperusPull {
    $v = Get-HesperusVersion
    $sfx = if (Test-HesperusModelGpu) { "-cuda" } else { "" }
    foreach ($p in @(@("hesperus:$v$sfx", "hesperus:latest"), @("hesperus-git:$v", "hesperus-git:latest"))) {
        $from = "ghcr.io/pmghartman/$($p[0])"
        docker pull -q $from | Out-Null
        if ($LASTEXITCODE) { return $false }
        docker tag $from $p[1]
        if ($LASTEXITCODE) { return $false }
    }
    $true
}

function Get-HesperusIniPath { if (Test-Path config/hesperus.ini) { "config/hesperus.ini" } }

function Get-HesperusValue([string]$Section, [string]$Key) { Get-IniValue (Get-HesperusIniPath) $Section $Key }

function Test-HesperusGitHost { (Get-HesperusValue "git" "host") -eq "true" }

# skip-worktree: an update restores this host's hesperus.ini verbatim, so
# sections added upstream are appended here
function Add-HesperusMissingSections {
    $file = Get-HesperusIniPath
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
        Write-Host "[hesperus.ini] added the [files] section, set dir to publish a directory"
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
        Write-Host "[hesperus.ini] added the [model] section, set host and url on the one host with the memory and disk for the model"
    }
}

# [model] gpu: the image built with llama.cpp's cuda backend
function Test-HesperusModelHost { (Get-HesperusValue "model" "host") -eq "true" }
function Test-HesperusModelGpu { (Get-HesperusValue "model" "gpu") -eq "true" }

# absolute host path published on the frontend's Files tab, the repo's own
# files/ when [files] dir is blank, so the mount always resolves
function Get-HesperusFilesDir {
    $dir = Get-HesperusValue "files" "dir"
    if (-not $dir) { return (Join-Path (Get-Location) "files") }
    if ([System.IO.Path]::IsPathRooted($dir)) { return $dir }
    return (Join-Path (Get-Location) $dir)
}

# [files] dir, one absolute host path per entry, empty when unset, relative
# entries off -Base, the checkout
function Get-HesperusFilesDirList([string]$Base) {
    $raw = Get-HesperusValue "files" "dir"
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
function Get-HesperusFilesPermList {
    $raw = Get-HesperusValue "files" "priv"
    if (-not $raw) { return @() }
    return @($raw.Split(",") | ForEach-Object { $_.Trim() })
}

# shares in an override beside compose (no variable mount count there),
# rewritten every build, never committed
$HesperusFilesOverride = "docker-compose.files.yml"

# $true when it wrote one and the caller should add it to COMPOSE_FILE
function Write-HesperusFilesOverride([string]$Base) {
    $dirs = @()
    foreach ($d in (Get-HesperusFilesDirList $Base)) {
        if (-not (Test-Path -PathType Container $d)) {
            Write-Host "[files] skipping '$d'; no such directory on this host"
            continue
        }
        $dirs += $d
    }
    if (-not $dirs.Count) {
        if (Test-Path $HesperusFilesOverride) { Remove-Item $HesperusFilesOverride -Force }
        return $false
    }

    $perms = Get-HesperusFilesPermList
    $lines = @(
        "# generated from [files] in config/hesperus.ini, rewritten every build",
        "services:",
        "  hesperus:",
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
    $lines += "      HESPERUS_FILES_DIRS: `"$($dirs -join ',')`""
    $lines += "      HESPERUS_FILES_PERMS: `"$($permList -join ',')`""
    $lines += "    volumes:"
    $lines += $mounts
    Set-Content -Path $HesperusFilesOverride -Value $lines
    return $true
}
