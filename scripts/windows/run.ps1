# first bring-up for a Windows host, safe to re-run

$ErrorActionPreference = "Stop"
$Dir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Dir
. "$PSScriptRoot/lib/Config.ps1"

function Say($msg) { Write-Host "[run-windows] $msg" }
function Fail($msg) { Write-Error "[run-windows] ERROR: $msg"; exit 1 }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail "docker not found, install Docker Desktop first (see README)" }

if (-not (Test-Path .env)) { Fail ".env not found in $Dir, copy .env.example to it and fill it in" }
if (-not (Test-Path config/services.export)) { Fail "config/services.export not found in $Dir" }

# --- native tailscaled conflict check ----------------------------------------
# the container's tailscaled on this machine's network, a native client
# fighting it for the TUN interface
$phosphorusRunning = (Invoke-Quiet { docker inspect -f '{{.State.Running}}' phosphorus }) -eq "true"
$tsService = Get-Service -Name Tailscale -ErrorAction SilentlyContinue
if ($phosphorusRunning) {
    Say "phosphorus is already running, skipping the native-client check"
} elseif ($tsService -and $tsService.Status -eq "Running") {
    Fail "native Tailscale service running, colliding with phosphorus's own tailscaled, stop it first (Stop-Service Tailscale) and quit the tray app"
}

# --- docker's ram -----------------------------------------------------------
# wsl2 capping its vm at half the machine, every byte the container sees,
# so with no memory= of their own, the whole machine
$machineMiB = [int]((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1MB)
$wantGB = [Math]::Floor($machineMiB / 1024)
$machineGB = [Math]::Round($machineMiB / 1024)
$wslConf = Join-Path $env:USERPROFILE ".wslconfig"
$wslLines = @(if (Test-Path $wslConf) { Get-Content $wslConf })
$setMem = @($wslLines | Where-Object { $_ -match '^\s*memory\s*=' })
$wslRestart = $false
if ($setMem.Count) {
    Say "$wslConf already sets '$($setMem[0].Trim())'; leaving it, and the model sees that much of ${machineGB}GB"
} elseif ($wantGB -lt 1) {
    Say "this machine has ${machineGB}GB, too little to hand any of it to docker"
} else {
    Say "giving docker's wsl vm all ${wantGB}GB this machine has"
    $add = @("memory=${wantGB}GB")
    # so the vm hands ram back to windows instead of holding its peak
    if (-not ($wslLines -match '^\s*autoMemoryReclaim\s*=')) { $add += "autoMemoryReclaim=gradual" }
    $out = [System.Collections.Generic.List[string]]::new()
    $placed = $false
    foreach ($l in $wslLines) {
        $out.Add($l)
        if (-not $placed -and $l.Trim() -eq "[wsl2]") { $add | ForEach-Object { $out.Add($_) }; $placed = $true }
    }
    if (-not $placed) {
        if ($out.Count) { $out.Add("") }
        $out.Add("[wsl2]")
        $add | ForEach-Object { $out.Add($_) }
    }
    Set-Content $wslConf $out
    $wslRestart = $true
}
# hyper-V backend: .wslconfig read by nothing
$kernel = Invoke-Quiet { docker info --format '{{.KernelVersion}}' }
if ($kernel -and $kernel -notmatch "WSL") {
    Say "docker here isn't on the wsl2 backend, set the vm's memory in Docker Desktop > Settings > Resources instead"
    $wslRestart = $false
}
if ($wslRestart -and $phosphorusRunning) {
    Say "it applies on the next 'wsl --shutdown', which stops phosphorus and every other wsl distro for a moment"
} elseif ($wslRestart -and $env:PHOSPHORUS_NONINTERACTIVE) {
    # no Docker Desktop to bring it back headless, never shut down unattended
    Say "it applies on the next reboot or 'wsl --shutdown'"
} elseif ($wslRestart) {
    Say "restarting wsl so it takes effect..."
    wsl --shutdown
    # docker desktop bringing its own distro back, the engine waited on
    $engine = $false
    for ($i = 0; $i -lt 60; $i++) {
        if (Invoke-Quiet { docker info --format '{{.ServerVersion}}' }) { $engine = $true; break }
        Start-Sleep -Seconds 2
    }
    if (-not $engine) { Fail "docker never came back after wsl --shutdown, start Docker Desktop and run phosphorus start again" }
}
# what the model tab shows against the vm's own ram
New-Item -ItemType Directory -Force -Path state | Out-Null
Set-Content -Path state/machine.json -Value "{`"ram`":$([int64]$machineMiB * 1MB)}"

# --- local SSH server (OpenSSH Server) --------------------------------------
# for the frontend's terminals, which log in over ssh
$sshCap = Get-WindowsCapability -Online -Name "OpenSSH.Server~~~~0.0.1.0"
if ($sshCap.State -ne "Installed") {
    Say "installing OpenSSH Server..."
    Add-WindowsCapability -Online -Name "OpenSSH.Server~~~~0.0.1.0" | Out-Null
}
Set-Service -Name sshd -StartupType Automatic
if ((Get-Service sshd).Status -ne "Running") {
    Say "starting sshd..."
    Start-Service sshd
} else {
    Say "sshd already running, skipping"
}

# --- ssh <host> from this host's terminals -------------------------------
# state/ssh_config the frontend's, one Host per tailnet peer, the Include first
# since it only counts ahead of every Host block
$sshConf = Join-Path $env:ProgramData "ssh\ssh_config"
$include = "Include `"$($Dir -replace '\\', '/')/state/ssh_config`""
$current = @(if (Test-Path $sshConf) { Get-Content $sshConf })
if ($current -contains $include) {
    Say "ssh to hosts by name already set up, skipping"
} else {
    Say "letting ssh reach hosts by name..."
    Set-Content $sshConf (@($include) + $current)
}

# --- phosphorus on PATH -------------------------------------------------------------
$phosphorusBin = Join-Path $PSScriptRoot "bin"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ';') -contains $phosphorusBin) {
    Say "phosphorus already on PATH, skipping"
} else {
    Say "putting phosphorus on PATH, new shells pick it up"
    [Environment]::SetEnvironmentVariable("Path", (@($userPath, $phosphorusBin) | Where-Object { $_ }) -join ';', "User")
}

# --- git-host opt-in ---------------------------------------------------
if (-not (Get-PhosphorusIniPath) -and [Environment]::UserInteractive -and -not $env:PHOSPHORUS_NONINTERACTIVE) {
    $ans = Read-Host "make this host a git host (forgejo/litefs)? [y/N]"
    $host_ = if ($ans -match '^[Yy]') { "true" } else { "false" }
    Set-Content -Path config/phosphorus.ini -Value "[git]", "host = $host_"
}

# on a live host, a swap detached through WMI by rebuild.ps1, nothing to
# wait on
$Bootstrap = ((Invoke-Quiet { docker inspect -f '{{.State.Running}}' phosphorus }) -ne "true")
Say "building and starting phosphorus..."
& "$PSScriptRoot/rebuild.ps1"
if ($LASTEXITCODE) { Fail "build failed, nothing changed" }

# --- verify the frontend came up inside the container -----------------------
# everything after tailscaled waiting on its login, real time allowed
if ($Bootstrap) {
    Say "waiting for the frontend..."
    $up = $false
    for ($i = 0; $i -lt 30; $i++) {
        docker compose exec -T phosphorus curl -s -o /dev/null "http://127.0.0.1:8090/"
        if ($LASTEXITCODE -eq 0) { $up = $true; break }
        Start-Sleep -Seconds 2
    }
    if (-not $up) { Fail "the frontend never came up, check: docker compose logs -f" }
    Say "the frontend is up"
} else {
    Say "swapping containers in the background, Get-Content -Wait $env:TEMP\phosphorus-update.log to follow"
}

Say "done. 'docker compose logs -f' to watch phosphorus come up."
