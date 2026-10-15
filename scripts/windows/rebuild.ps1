# phosphorus built and the running container swapped onto the new image,
# shared by run.ps1, install.ps1 and reconfig, the one step that can kill its caller
$ErrorActionPreference = "Stop"
$Dir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Dir

function Say($msg) { Write-Host "[rebuild] $msg" }
function Fail($msg) { Write-Host "[rebuild] ERROR: $msg" -ForegroundColor Red; exit 1 }

. "$PSScriptRoot/lib/Config.ps1"

# no credential vault over ssh ("logon session does not exist"): a throwaway
# config with a dummy auths entry, the real ~/.docker left alone
if ($env:SSH_CONNECTION -and -not $env:DOCKER_CONFIG) {
    $Real = Join-Path $env:USERPROFILE ".docker"
    $SshCfg = Join-Path $env:TEMP "phosphorus-docker"
    New-Item -ItemType Directory -Force $SshCfg | Out-Null
    $Ctx = "desktop-linux"
    $RealJson = Join-Path $Real "config.json"
    if (Test-Path $RealJson) {
        $c = (Get-Content $RealJson -Raw | ConvertFrom-Json).currentContext
        if ($c) { $Ctx = $c }
    }
    if (Test-Path (Join-Path $Real "contexts")) {
        Copy-Item (Join-Path $Real "contexts") $SshCfg -Recurse -Force
    }
    @{
        auths               = @{ "phosphorus.invalid" = @{} }
        currentContext      = $Ctx
        cliPluginsExtraDirs = @(
            (Join-Path $env:ProgramFiles "Docker\Docker\resources\cli-plugins"),
            (Join-Path $Real "cli-plugins")
        )
    } | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $SshCfg "config.json") -Encoding ascii
    $env:DOCKER_CONFIG = $SshCfg
}

# git tracks no ACLs: .env locked to the current user every build, (M) for
# delete since the container's git replaces it on a reset
icacls .env /inheritance:r /grant:r "$($env:USERNAME):(M)" /grant:r "SYSTEM:(F)" | Out-Null
Add-PhosphorusMissingSections
# Docker Desktop's VM always "docker-desktop", the mesh name this
# machine's unless .env pins one
if (-not (Get-EnvValue "TS_HOSTNAME")) { $env:TS_HOSTNAME = $env:COMPUTERNAME.ToLower() }
$env:COMPOSE_PROFILES = (@(if (Test-PhosphorusGitHost) { "git-host" }) + @(if (Test-PhosphorusModelHost) { "model-host" })) -join ","
# git data on docker volumes, rsync pulls over the NTFS share a minute long
$env:PHOSPHORUS_GIT_DATA = "git-data"
$env:PHOSPHORUS_GIT_DB = "git-db"
# the model's gguf likewise, mmapped off a volume
$env:PHOSPHORUS_MODEL_DIR = "models"
# every drive as Docker Desktop's VM mounts it, for the status tab's disk
$env:PHOSPHORUS_HOST_ROOT = "/run/desktop/mnt/host"

# each [files] dir its own mount, written out as a compose override,
# /files keeping the repo's own share underneath, whatever else is published
$env:COMPOSE_FILE = "docker-compose.yml"
$FilesDir = Get-PhosphorusFilesDir
if (Write-PhosphorusFilesOverride $Dir) {
    $env:COMPOSE_FILE = "docker-compose.yml;$PhosphorusFilesOverride"
    $FilesDir = Join-Path $Dir "files"
    Say "publishing the shares in [files] dir"
} elseif (-not (Test-Path $FilesDir)) {
    # else a missing directory created by docker
    Say "[files] dir '$FilesDir' doesn't exist, publishing $Dir\files instead"
    $FilesDir = Join-Path $Dir "files"
}
New-Item -ItemType Directory -Force $FilesDir *> $null
$env:PHOSPHORUS_FILES_DIR = $FilesDir

# [home] dir as the VM sees it, moved from where the running container has it
$HomeDir = Get-PhosphorusHomeDir
New-Item -ItemType Directory -Force $HomeDir *> $null
$HomeTo = ConvertTo-VmPath $HomeDir
$HomeFrom = ""
if (docker ps -aq -f "name=^phosphorus$") {
    $HomeFrom = Invoke-Quiet { docker inspect phosphorus --format '{{range .Mounts}}{{if eq .Destination "/homefs"}}{{.Source}}{{end}}{{end}}' }
    if (-not $HomeFrom) { $HomeFrom = ConvertTo-VmPath (Join-Path $Dir "state") }
    $HomeFrom = "$HomeFrom".Trim().TrimEnd("/", "\")
    if ($HomeFrom -match '^[A-Za-z]:') { $HomeFrom = ConvertTo-VmPath $HomeFrom }
    if ($HomeFrom -eq $HomeTo) { $HomeFrom = "" }
}
if ($HomeFrom -and ("$HomeTo/".StartsWith("$HomeFrom/home/") -or "$HomeTo/".StartsWith("$HomeFrom/usr/") -or "$HomeTo/".StartsWith("$HomeFrom/sys/") -or "$HomeTo/".StartsWith("$HomeFrom/shared/"))) {
    Fail "[home] dir can't be inside the folders it moves"
}
$env:PHOSPHORUS_HOME_DIR = $HomeDir

# $ErrorActionPreference skips native commands, exit codes checked by hand
$Running = ((Invoke-Quiet { docker inspect -f '{{.State.Running}}' phosphorus }) -eq "true")

# the release's images pulled beside the old container, a failed pull
# changing nothing, in this session for a real exit code
Say "pulling phosphorus $(Get-PhosphorusVersion)..."
if (-not (Invoke-PhosphorusPull)) { Fail "pull failed, still running the previous version" }

# nvidia gpus handed in wherever a probe off the new image gets them
Invoke-Quiet { docker run --rm --gpus all --network none --entrypoint true phosphorus:latest } | Out-Null
if (-not $LASTEXITCODE) {
    $env:COMPOSE_FILE += ";container/docker-compose.gpu.yml"
    Say "handing the nvidia gpu to phosphorus"
}

# no longer a git host: skipped by compose as a disabled profile, still
# running (and voting) otherwise, a clean stop for a master's hand-off
if (-not (Test-PhosphorusGitHost) -and (docker ps -aq -f "name=^phosphorus-git$")) {
    Say "no longer a git host, removing phosphorus-git"
    Invoke-Quiet { docker stop -t 30 phosphorus-git } | Out-Null
    Invoke-Quiet { docker rm phosphorus-git } | Out-Null
}
# likewise the search, model hosts' alone
if (-not (Test-PhosphorusModelHost) -and (docker ps -aq -f "name=^phosphorus-search$")) {
    Say "no longer a model host, removing phosphorus-search"
    Invoke-Quiet { docker rm -f phosphorus-search } | Out-Null
}

# leftovers of earlier runs, from the new image's sweep.sh, in Docker
# Desktop's VM, the home as that VM sees it
$VmRepo = "/run/desktop/mnt/host/" + $Dir.Substring(0, 1).ToLower() + ($Dir.Substring(2) -replace '\\', '/')
Invoke-Quiet { docker run --rm --pid=host -v /var/run/docker.sock:/var/run/docker.sock `
    --entrypoint sh phosphorus:latest /opt/phosphorus/sweep.sh $VmRepo } | ForEach-Object { Say $_ }

# git/data onto the volumes once, git stopped first so a master hands off
Invoke-Quiet { docker volume inspect phosphorus-git-data } | Out-Null
if ($LASTEXITCODE -and (Test-PhosphorusGitHost) -and ((Test-Path git/data/GIT_VERSION) -or (Test-Path git/data/MU_GIT_VERSION))) {
    Say "moving git data onto a docker volume..."
    Invoke-Quiet { docker stop -t 30 phosphorus-git } | Out-Null
    docker run --rm -v "${VmRepo}/git/data:/src:ro" -v phosphorus-git-data:/data -v phosphorus-git-db:/db `
        --entrypoint sh phosphorus:latest -c `
        'tar -C /src --exclude=./litefs --exclude=./litefs-internal -cf - . | tar -C /data -xf - && { [ ! -d /src/litefs-internal ] || cp -a /src/litefs-internal/. /db/; }'
    if ($LASTEXITCODE) {
        Invoke-Quiet { docker volume rm phosphorus-git-data phosphorus-git-db } | Out-Null
        Invoke-Quiet { docker start phosphorus-git } | Out-Null
        Fail "couldn't copy git/data onto a volume, still running the previous version"
    }
}

# images earlier swaps replaced, and those the sweep freed, in-use ones
# never dangling, so never hit
Invoke-Quiet { docker image prune -f } | Out-Null

# home/ moved with phosphorus stopped, a failed copy leaving them put
if ($HomeFrom) {
    Say "moving home/ from $HomeFrom to $HomeTo..."
    Invoke-Quiet { docker stop -t 30 phosphorus } | Out-Null
    $Move = "set -e`nm=.phosphorus-move-`$`$; touch /mv/old/`$m`nif [ -e /mv/new/`$m ]; then rm -f /mv/old/`$m; exit 0; fi`nrm -f /mv/old/`$m`nif [ -d /mv/old/home/sys ]; then names=home; elif [ -d /mv/old/usr/shared ]; then names='usr sys'; else names='sys shared'`n  for f in /mv/old/sys/etc/passwd/*.json; do [ -f `$f ] && names=`$names' '`$(basename `$f .json); done; fi`nfor d in `$names; do [ -d /mv/old/`$d ] && mkdir -p /mv/new/`$d && cp -a /mv/old/`$d/. /mv/new/`$d/; done`nfor d in `$names; do rm -rf /mv/old/`$d; done"
    docker run --rm -v "${HomeFrom}:/mv/old" -v "${HomeTo}:/mv/new" --entrypoint sh phosphorus:latest -c $Move
    if ($LASTEXITCODE) {
        Say "couldn't move the homes, keeping them in $HomeFrom"
        $env:PHOSPHORUS_HOME_DIR = $HomeFrom
    }
    $Running = $false
}

if (-not $Running) {
    # nothing for the swap to kill, the caller free to wait on this
    Say "starting phosphorus..."
    docker compose up -d --remove-orphans
    if ($LASTEXITCODE) { Fail "couldn't start phosphorus" }
    exit 0
}

# every container already on its image and config: no restart, no git handoff,
# merged in cmd since 2>&1 on a native command throws under Stop
$Plan = @(cmd /c "docker compose up -d --remove-orphans --dry-run 2>&1") | Where-Object { $_.Trim() }
if (-not $LASTEXITCODE -and $Plan -and -not ($Plan | Where-Object { $_ -notmatch ' Running\s*$' })) {
    Say "already up to date, nothing to swap"
    exit 0
}

# the git elector told while the frontend is still up, best effort
$Announce = "curl -fsS -m 3 -X POST -H 'Content-Type: application/json' -d '{}' 127.0.0.1:`${FRONTEND_PORT:-8090}/internal/status/updating"
Invoke-Quiet { docker exec phosphorus sh -c $Announce } | Out-Null

# outside the ssh session via WMI: the swap dropping the frontend's terminals,
# Windows' sshd taking a dropped session's whole process tree with it
$Log = Join-Path $env:TEMP "phosphorus-update.log"
Say "swapping containers, this terminal may drop"
Say "Get-Content -Wait $Log to follow."
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine      = "cmd /c set COMPOSE_PROFILES=$($env:COMPOSE_PROFILES)&& set DOCKER_CONFIG=$($env:DOCKER_CONFIG)&& set TS_HOSTNAME=$($env:TS_HOSTNAME)&& set PHOSPHORUS_GIT_DATA=git-data&& set PHOSPHORUS_GIT_DB=git-db&& set PHOSPHORUS_MODEL_DIR=models&& set PHOSPHORUS_HOST_ROOT=$($env:PHOSPHORUS_HOST_ROOT)&& set PHOSPHORUS_FILES_DIR=$FilesDir&& set PHOSPHORUS_HOME_DIR=$($env:PHOSPHORUS_HOME_DIR)&& set COMPOSE_FILE=$($env:COMPOSE_FILE)&& docker compose up -d --remove-orphans > `"$Log`" 2>&1"
    CurrentDirectory = $Dir
} | Out-Null

exit 0
