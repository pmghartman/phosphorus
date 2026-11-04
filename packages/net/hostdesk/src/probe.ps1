# phosphorus host desktop probe: requests id`tcmd`tbase64(arg) on stdin, replies
# id`tok|err`tbase64(json) on stdout, one line each

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = New-Object Text.UTF8Encoding $false
$sh = New-Object -ComObject WScript.Shell
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$script:iconsReady = $false
$script:appx = $null

function Reg($path, $name, $def) {
  try { (Get-ItemProperty -LiteralPath $path -Name $name -ErrorAction Stop).$name } catch { $def }
}

function Ver($p) {
  try { [string](Get-Item -LiteralPath $p -Force).LastWriteTimeUtc.Ticks } catch { '' }
}

# a cloud placeholder not on disk: read only by its attributes, never hydrated
# offline 0x1000, recall on open 0x40000, recall on data access 0x400000
function Cloud($p) {
  try { ([int][IO.File]::GetAttributes($p) -band 0x441000) -ne 0 } catch { $false }
}

# the PE header's subsystem: 2 a window, 3 a console
function Subsys($p) {
  if (Cloud $p) { return 0 }
  try {
    $fs = [IO.File]::OpenRead($p)
    try {
      $b = New-Object byte[] 4096
      $n = $fs.Read($b, 0, 4096)
      if ($n -lt 64 -or $b[0] -ne 0x4D -or $b[1] -ne 0x5A) { return 0 }
      $o = [BitConverter]::ToInt32($b, 0x3C)
      if ($o -lt 0 -or $o + 0x5E -ge $n) { return 0 }
      return [BitConverter]::ToUInt16($b, $o + 0x5C)
    } finally { $fs.Close() }
  } catch { 0 }
}

# a launcher's target: kind, what it runs, its icon spec
function Describe($p, $group) {
  $it = [ordered]@{ name = [IO.Path]::GetFileNameWithoutExtension($p); path = $p; kind = 'file'; icon = "f:$p"; iv = (Ver $p) }
  if ($group) { $it.group = $group }
  $ext = [IO.Path]::GetExtension($p).ToLower()
  if (Test-Path -LiteralPath $p -PathType Container) {
    $it.name = [IO.Path]::GetFileName($p); $it.kind = 'folder'; return $it
  }
  if (Cloud $p) {
    $it.icon = "a:$p"
    if ($ext -in '.lnk', '.url', '.exe') { $it.kind = 'gui' } else { $it.name = [IO.Path]::GetFileName($p) }
    return $it
  }
  if ($ext -eq '.lnk') {
    try { $s = $sh.CreateShortcut($p) } catch { $it.kind = 'gui'; return $it }
    $t = [string]$s.TargetPath
    $loc = [string]$s.IconLocation
    if ($loc -and $loc -notmatch '^,') {
      $f = $loc -replace ',-?\d+$', ''
      $f = [Environment]::ExpandEnvironmentVariables($f)
      if (Test-Path -LiteralPath $f) { $it.icon = "l:$([Environment]::ExpandEnvironmentVariables($loc))"; $it.iv = (Ver $f) }
    }
    $it.target = $t
    $it.args = [string]$s.Arguments
    if (-not $t) { $it.kind = 'gui'; return $it }
    if ($t -match '^https?://') { $it.kind = 'web'; $it.url = $t; return $it }
    if (Test-Path -LiteralPath $t -PathType Container) { $it.kind = 'folder'; $it.path = $t; return $it }
    $te = [IO.Path]::GetExtension($t).ToLower()
    if ($te -eq '.exe' -or $te -eq '.com') {
      if ((Subsys $t) -eq 3) { $it.kind = 'cli' } else { $it.kind = 'gui' }
    } elseif ($te -in '.bat', '.cmd', '.ps1') { $it.kind = 'cli' }
    elseif ($te -in '.msc', '.cpl', '.scr') { $it.kind = 'gui' }
    else { $it.kind = 'file'; $it.target = $t }
    return $it
  }
  if ($ext -eq '.url') {
    try {
      $u = (Get-Content -LiteralPath $p -ErrorAction Stop | Where-Object { $_ -match '^URL=' } | Select-Object -First 1) -replace '^URL=', ''
      if ($u -match '^https?://') { $it.kind = 'web'; $it.url = $u }
    } catch {}
    return $it
  }
  if ($ext -eq '.exe' -or $ext -eq '.com') {
    if ((Subsys $p) -eq 3) { $it.kind = 'cli' } else { $it.kind = 'gui' }
    $it.target = $p
  }
  $it.name = [IO.Path]::GetFileName($p)
  if ($ext -in '.lnk', '.url', '.exe') { $it.name = [IO.Path]::GetFileNameWithoutExtension($p) }
  $it
}

function Do-desktop($a) {
  $cv = 'HKCU:\Software\Microsoft\Windows\CurrentVersion'
  $build = [int](Reg 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' 'CurrentBuildNumber' 0)
  $wp = [string](Reg 'HKCU:\Control Panel\Desktop' 'WallPaper' '')
  if (-not $wp -or -not (Test-Path -LiteralPath $wp)) {
    $t = Join-Path $env:APPDATA 'Microsoft\Windows\Themes\TranscodedWallpaper'
    if (Test-Path -LiteralPath $t) { $wp = $t } else { $wp = '' }
  }
  $style = [string](Reg 'HKCU:\Control Panel\Desktop' 'WallpaperStyle' '10')
  $tile = [string](Reg 'HKCU:\Control Panel\Desktop' 'TileWallpaper' '0')
  $bg = [string](Reg 'HKCU:\Control Panel\Colors' 'Background' '0 0 0')
  $light = [int](Reg "$cv\Themes\Personalize" 'SystemUsesLightTheme' 0)
  $appsLight = [int](Reg "$cv\Themes\Personalize" 'AppsUseLightTheme' 1)
  $accent = Reg "$cv\Explorer\Accent" 'AccentColorMenu' $null
  if ($null -eq $accent) { $accent = Reg 'HKCU:\Software\Microsoft\Windows\DWM' 'AccentColor' $null }
  $al = [int](Reg "$cv\Explorer\Advanced" 'TaskbarAl' 1)
  $hide = [int](Reg "$cv\Explorer\Advanced" 'HideIcons' 0)
  $binHidden = [int](Reg "$cv\Explorer\HideDesktopIcons\NewStartPanel" '{645FF040-5081-101B-9F08-00AA002F954E}' 0)
  $stuck = Reg "$cv\Explorer\StuckRects3" 'Settings' $null
  $edge = 3
  if ($stuck -is [byte[]] -and $stuck.Length -gt 12) { $edge = [int]$stuck[12] }
  $icons = @()
  $dirs = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory')) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  if (-not $hide) {
    foreach ($d in $dirs) {
      foreach ($f in Get-ChildItem -LiteralPath $d -Force -ErrorAction SilentlyContinue) {
        if ($f.Attributes -band [IO.FileAttributes]::Hidden) { continue }
        if ($f.Name -ieq 'desktop.ini') { continue }
        $icons += Describe $f.FullName ''
      }
    }
  }
  $pins = @()
  $pd = Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
  if (Test-Path -LiteralPath $pd) {
    foreach ($f in Get-ChildItem -LiteralPath $pd -Filter '*.lnk' -Force -ErrorAction SilentlyContinue) { $pins += Describe $f.FullName '' }
  }
  $full = $false
  foreach ($b in Bins) { if (Get-ChildItem -LiteralPath $b -Force -Filter '$R*' -ErrorAction SilentlyContinue | Select-Object -First 1) { $full = $true } }
  [ordered]@{
    user = $env:USERNAME
    home = $env:USERPROFILE
    build = $build
    wallpaper = $wp
    wpv = (Ver $wp)
    style = $style
    tile = $tile
    bg = $bg
    light = $light
    appsLight = $appsLight
    accent = $accent
    align = $al
    bin = (-not $binHidden)
    binFull = $full
    desktops = $dirs
    icons = $icons
    pins = $pins
    sshShell = [string](Reg 'HKLM:\SOFTWARE\OpenSSH' 'DefaultShell' '')
    iconSize = [int](Reg 'HKCU:\Software\Microsoft\Windows\Shell\Bags\1\Desktop' 'IconSize' 48)
    search = [int](Reg "$cv\Search" 'SearchboxTaskbarMode' 1)
    taskView = [int](Reg "$cv\Explorer\Advanced" 'ShowTaskViewButton' 1)
    widgets = [int](Reg "$cv\Explorer\Advanced" 'TaskbarDa' 1)
    small = [int](Reg "$cv\Explorer\Advanced" 'TaskbarSmallIcons' 0)
    seconds = [int](Reg "$cv\Explorer\Advanced" 'ShowSecondsInSystemClock' 0)
    edge = $edge
    transparent = [int](Reg "$cv\Themes\Personalize" 'EnableTransparency' 1)
    time = [string](Reg 'HKCU:\Control Panel\International' 'sShortTime' 'h:mm tt')
  }
}

function Do-apps($a) {
  $out = @()
  $seen = @{}
  foreach ($root in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonPrograms'))) {
    if (-not $root -or -not (Test-Path -LiteralPath $root)) { continue }
    foreach ($f in Get-ChildItem -LiteralPath $root -Recurse -Force -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in '.lnk', '.url' }) {
      $rel = $f.DirectoryName.Substring($root.Length).Trim('\')
      $key = $f.BaseName.ToLower()
      if ($seen[$key]) { continue }
      $seen[$key] = $true
      $out += Describe $f.FullName $rel
    }
  }
  try {
    foreach ($s in Get-StartApps) {
      if ($seen[$s.Name.ToLower()]) { continue }
      if ($s.AppID -notmatch '!') { continue }
      $seen[$s.Name.ToLower()] = $true
      $out += [ordered]@{ name = $s.Name; kind = 'gui'; icon = "u:$($s.AppID)"; iv = 'u'; id = $s.AppID }
    }
  } catch {}
  , $out
}

$iconSrc = @'
using System; using System.IO; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;
public static class PhIcon {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct SFI { public IntPtr h; public int i; public uint a; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string d; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string t; }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SHGetFileInfo(string p, uint at, ref SFI s, uint cb, uint f);
  [DllImport("shell32.dll", EntryPoint = "SHGetFileInfoW")] static extern IntPtr SHGetFileInfoP(IntPtr p, uint at, ref SFI s, uint cb, uint f);
  [DllImport("shell32.dll")] static extern int SHGetSpecialFolderLocation(IntPtr h, int csidl, out IntPtr pidl);
  [DllImport("shell32.dll", EntryPoint = "#727")] static extern int SHGetImageList(int i, ref Guid g, out IntPtr p);
  [DllImport("comctl32.dll")] static extern IntPtr ImageList_GetIcon(IntPtr h, int i, int f);
  [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint PrivateExtractIcons(string f, int i, int cx, int cy, IntPtr[] h, int[] id, uint n, uint fl);
  [DllImport("ole32.dll")] static extern void CoTaskMemFree(IntPtr p);
  static string Png(IntPtr h) {
    if (h == IntPtr.Zero) return null;
    try { using (var i = Icon.FromHandle(h)) using (var b = i.ToBitmap()) using (var m = new MemoryStream()) { b.Save(m, ImageFormat.Png); return Convert.ToBase64String(m.ToArray()); } }
    finally { DestroyIcon(h); }
  }
  static string Index(int idx) {
    var g = new Guid("46EB5926-582E-4017-9FDF-E8998DAA0950"); IntPtr il;
    if (SHGetImageList(2, ref g, out il) != 0) return null;
    return Png(ImageList_GetIcon(il, idx, 1));
  }
  public static string File(string p) { var s = new SFI(); if (SHGetFileInfo(p, 0, ref s, (uint)Marshal.SizeOf(s), 0x4000) == IntPtr.Zero) return null; return Index(s.i); }
  public static string Bin() {
    IntPtr pidl; if (SHGetSpecialFolderLocation(IntPtr.Zero, 0x0a, out pidl) != 0) return null;
    try { var s = new SFI(); if (SHGetFileInfoP(pidl, 0, ref s, (uint)Marshal.SizeOf(s), 0x4008) == IntPtr.Zero) return null; return Index(s.i); }
    finally { CoTaskMemFree(pidl); }
  }
  public static string Attr(string p) { var s = new SFI(); if (SHGetFileInfo(p, 0x80, ref s, (uint)Marshal.SizeOf(s), 0x4010) == IntPtr.Zero) return null; return Index(s.i); }
  public static string Loc(string f, int i) { var h = new IntPtr[1]; var id = new int[1]; if (PrivateExtractIcons(f, i, 48, 48, h, id, 1, 0) == 0 || h[0] == IntPtr.Zero) return null; return Png(h[0]); }
}
'@

# compiled in a runspace of its own from the start, so the first icon pays no csc
# the slow lane draws no icons
if ($lane -ne 'slow') {
  $script:iconJob = [powershell]::Create().AddScript({ param($src) Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition $src }).AddArgument($iconSrc)
  $script:iconWait = $script:iconJob.BeginInvoke()
}

function IconsReady {
  if ($script:iconsReady) { return }
  if ($script:iconJob) { try { $script:iconJob.EndInvoke($script:iconWait) | Out-Null } catch {} }
  if (-not ('PhIcon' -as [type])) { Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition $iconSrc }
  $script:iconsReady = $true
}

# a store app's tile logo, the 48px plated one first
function Uwp($aumid) {
  $fam, $app = $aumid -split '!', 2
  if ($null -eq $script:appx) { $script:appx = @{}; foreach ($p in Get-AppxPackage) { $script:appx[$p.PackageFamilyName] = $p.InstallLocation } }
  $dir = $script:appx[$fam]
  if (-not $dir) { return $null }
  [xml]$m = Get-Content -LiteralPath (Join-Path $dir 'AppxManifest.xml') -Raw
  $logo = $null
  foreach ($x in $m.Package.Applications.Application) {
    if ($x.Id -ne $app) { continue }
    foreach ($v in $x.ChildNodes) { if ($v.LocalName -eq 'VisualElements') { $logo = $v.GetAttribute('Square44x44Logo') } }
  }
  if (-not $logo) { return $null }
  $full = Join-Path $dir $logo
  $base = [IO.Path]::GetFileNameWithoutExtension($full)
  $ext = [IO.Path]::GetExtension($full)
  $cands = Get-ChildItem -LiteralPath ([IO.Path]::GetDirectoryName($full)) -Filter "$base*$ext" -ErrorAction SilentlyContinue
  foreach ($want in 'targetsize-48_altform-unplated', 'targetsize-48', 'scale-200', 'scale-100', '') {
    $hit = $cands | Where-Object { $_.Name -like "*$want*" } | Select-Object -First 1
    if ($hit) { return [Convert]::ToBase64String([IO.File]::ReadAllBytes($hit.FullName)) }
  }
  $null
}

function Do-icon($a) {
  IconsReady
  $k = $a.Substring(0, 2)
  $v = $a.Substring(2)
  $png = $null
  switch ($k) {
    'f:' { if (Cloud $v) { $png = [PhIcon]::Attr($v) } else { $png = [PhIcon]::File($v) } }
    'a:' { $png = [PhIcon]::Attr($v) }
    'b:' { $png = [PhIcon]::Bin() }
    'u:' { $png = Uwp $v }
    'l:' {
      $m = [regex]::Match($v, '^(.*),(-?\d+)$')
      if ($m.Success) { $png = [PhIcon]::Loc($m.Groups[1].Value, [int]$m.Groups[2].Value) } else { $png = [PhIcon]::Loc($v, 0) }
    }
  }
  @{ png = $png }
}

# many icons in one answer, a miss as null
function Do-icons($a) {
  $r = @()
  $list = $a | ConvertFrom-Json
  foreach ($k in $list) {
    $png = $null
    try { $png = (Do-icon ([string]$k)).png } catch {}
    $r += [ordered]@{ k = [string]$k; png = $png }
  }
  , $r
}

# fixed drives only: a network or removable one never waited on
function Bins {
  foreach ($d in [IO.DriveInfo]::GetDrives()) {
    if ($d.DriveType -ne 'Fixed' -or -not $d.IsReady) { continue }
    $b = Join-Path $d.RootDirectory.FullName ('$Recycle.Bin\' + $sid)
    if (Test-Path -LiteralPath $b) { $b }
  }
}

function Do-trash($a) {
  $r = @()
  foreach ($b in Bins) {
    foreach ($i in Get-ChildItem -LiteralPath $b -Force -Filter '$I*' -ErrorAction SilentlyContinue) {
      $rp = Join-Path $b ('$R' + $i.Name.Substring(2))
      if (-not (Test-Path -LiteralPath $rp)) { continue }
      $r += [ordered]@{ bin = $b; i = $i.Name; dir = (Test-Path -LiteralPath $rp -PathType Container); data = [Convert]::ToBase64String([IO.File]::ReadAllBytes($i.FullName)) }
    }
  }
  , $r
}

function BinOf($b) {
  foreach ($x in Bins) { if ($x -ieq $b) { return $x } }
  throw 'not a recycle bin of this login'
}

function Do-restore($a) {
  $o = $a | ConvertFrom-Json
  $b = BinOf $o.bin
  if ($o.i -notmatch '^\$I[A-Z0-9]{6}(\.[^\\/:*?"<>|]{1,64})?$') { throw 'not in the recycle bin' }
  $rp = Join-Path $b ('$R' + $o.i.Substring(2))
  if (Test-Path -LiteralPath $o.to) { throw "something is already at $($o.to)" }
  $parent = Split-Path -LiteralPath $o.to -Parent
  if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  Move-Item -LiteralPath $rp -Destination $o.to
  Remove-Item -LiteralPath (Join-Path $b $o.i) -Force
  @{ ok = $true }
}

function Do-empty($a) {
  foreach ($b in Bins) {
    foreach ($f in Get-ChildItem -LiteralPath $b -Force -ErrorAction SilentlyContinue) {
      if ($f.Name -like '$R*' -or $f.Name -like '$I*') { Remove-Item -LiteralPath $f.FullName -Recurse -Force }
    }
  }
  @{ ok = $true }
}

function Do-stat($a) {
  $it = Get-Item -LiteralPath $a -Force
  $size = 0
  if ($it.PSIsContainer) { $size = (Get-ChildItem -LiteralPath $a -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum }
  else { $size = $it.Length }
  $root = [IO.Path]::GetPathRoot($it.FullName)
  $bin = Join-Path $root ('$Recycle.Bin\' + $sid)
  @{ path = $it.FullName; dir = $it.PSIsContainer; size = [int64]$size; bin = $(if (Test-Path -LiteralPath $bin) { $bin } else { '' }) }
}

# path, the bin, the shared name, the $I bytes
function Do-delete($a) {
  $o = $a | ConvertFrom-Json
  $b = BinOf $o.bin
  if ($o.name -notmatch '^[A-Z0-9]{6}(\.[^\\/:*?"<>|]{1,64})?$') { throw 'bad recycle name' }
  if ([IO.Path]::GetPathRoot($o.path) -ine [IO.Path]::GetPathRoot($b)) { throw "it's on another drive than its recycle bin, so nothing was deleted" }
  if (-not (Test-Path -LiteralPath $o.path)) { throw "not found: $($o.path)" }
  $ip = Join-Path $b ('$I' + $o.name)
  $rp = Join-Path $b ('$R' + $o.name)
  if ((Test-Path -LiteralPath $ip) -or (Test-Path -LiteralPath $rp)) { throw 'that recycle name is taken, try again' }
  [IO.File]::WriteAllBytes($ip, [Convert]::FromBase64String($o.info))
  try { Move-Item -LiteralPath $o.path -Destination $rp } catch { Remove-Item -LiteralPath $ip -Force; throw }
  @{ ok = $true }
}

function Do-open($a) { Describe $a '' }

function Do-ls($a) {
  $r = @()
  foreach ($f in Get-ChildItem -LiteralPath $a -Force -ErrorAction Stop) {
    if ($f.Attributes -band [IO.FileAttributes]::System -and $f.Attributes -band [IO.FileAttributes]::Hidden) { continue }
    $r += [ordered]@{ name = $f.Name; path = $f.FullName; dir = $f.PSIsContainer; size = $(if ($f.PSIsContainer) { 0 } else { $f.Length }); mtime = [int64]($f.LastWriteTimeUtc - [datetime]'1970-01-01').TotalMilliseconds }
  }
  , $r
}

function Do-images($a) {
  $r = @()
  foreach ($d in @("$env:WINDIR\Web\Wallpaper", "$env:WINDIR\Web\4K\Wallpaper", [Environment]::GetFolderPath('MyPictures'))) {
    if (-not $d -or -not (Test-Path -LiteralPath $d)) { continue }
    foreach ($f in Get-ChildItem -LiteralPath $d -Recurse -Force -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in '.jpg', '.jpeg', '.png', '.bmp', '.webp' } | Select-Object -First 300) { $r += $f.FullName }
  }
  , $r
}

# the change in the user's own session: a task run once where they're signed in
function Live($ps) {
  $n = 'phosphorus-desk-' + [guid]::NewGuid().ToString('n').Substring(0, 8)
  $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($ps))
  try {
    $act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $enc"
    $who = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive
    Register-ScheduledTask -TaskName $n -Action $act -Principal $who -Force | Out-Null
    Start-ScheduledTask -TaskName $n
    Start-Sleep -Milliseconds 2500
    Unregister-ScheduledTask -TaskName $n -Confirm:$false
    $true
  } catch {
    try { Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction SilentlyContinue } catch {}
    $false
  }
}

$liveHead = @'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class PhLive { [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int SystemParametersInfo(int a, int b, string c, int d); [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, int m, IntPtr w, string l, int f, int t, out IntPtr r); }'
'@

function Do-set($a) {
  $o = $a | ConvertFrom-Json
  $cv = 'HKCU:\Software\Microsoft\Windows\CurrentVersion'
  $live = $liveHead + "`n"
  if ($null -ne $o.wallpaper) {
    if (-not (Test-Path -LiteralPath $o.wallpaper -PathType Leaf)) { throw "not found: $($o.wallpaper)" }
    Set-ItemProperty -LiteralPath 'HKCU:\Control Panel\Desktop' -Name WallPaper -Value $o.wallpaper
    $q = $o.wallpaper -replace "'", "''"
    $live += "[void][PhLive]::SystemParametersInfo(20, 0, '$q', 3)`n"
  }
  if ($null -ne $o.dark) {
    $v = [int](-not $o.dark)
    $k = "$cv\Themes\Personalize"
    if (-not (Test-Path -LiteralPath $k)) { New-Item -Path $k -Force | Out-Null }
    Set-ItemProperty -LiteralPath $k -Name AppsUseLightTheme -Value $v -Type DWord
    Set-ItemProperty -LiteralPath $k -Name SystemUsesLightTheme -Value $v -Type DWord
  }
  if ($null -ne $o.accent) {
    if ($o.accent -notmatch '^#[0-9a-fA-F]{6}$') { throw "not a colour: $($o.accent)" }
    $r = [Convert]::ToInt32($o.accent.Substring(1, 2), 16); $g = [Convert]::ToInt32($o.accent.Substring(3, 2), 16); $bl = [Convert]::ToInt32($o.accent.Substring(5, 2), 16)
    $abgr = [BitConverter]::ToInt32([byte[]]@($r, $g, $bl, 0xFF), 0)
    $argb = [BitConverter]::ToInt32([byte[]]@($bl, $g, $r, 0xC4), 0)
    $k = "$cv\Explorer\Accent"
    if (-not (Test-Path -LiteralPath $k)) { New-Item -Path $k -Force | Out-Null }
    Set-ItemProperty -LiteralPath $k -Name AccentColorMenu -Value $abgr -Type DWord
    Set-ItemProperty -LiteralPath $k -Name StartColorMenu -Value $abgr -Type DWord
    Set-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\DWM' -Name AccentColor -Value $abgr -Type DWord
    Set-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\DWM' -Name ColorizationColor -Value $argb -Type DWord
    Set-ItemProperty -LiteralPath 'HKCU:\Control Panel\Desktop' -Name AutoColorization -Value '0'
  }
  $live += '$r = [IntPtr]::Zero; [void][PhLive]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [IntPtr]::Zero, ''ImmersiveColorSet'', 2, 3000, [ref]$r)' + "`n"
  @{ live = (Live $live) }
}

$cmds = 'desktop', 'apps', 'icon', 'icons', 'trash', 'restore', 'empty', 'stat', 'delete', 'open', 'ls', 'images', 'set'
$out = [Console]::Out
while ($true) {
  $l = [Console]::In.ReadLine()
  if ($null -eq $l) { break }
  $p = $l.Split("`t")
  if ($p.Length -lt 3) { continue }
  $st = 'ok'
  try {
    if ($cmds -notcontains $p[1]) { throw "no such request: $($p[1])" }
    $arg = $utf8.GetString([Convert]::FromBase64String($p[2]))
    $r = & "Do-$($p[1])" $arg
    $txt = ConvertTo-Json -InputObject $r -Compress -Depth 6
  } catch {
    $st = 'err'
    $txt = $_.Exception.Message
  }
  $out.WriteLine($p[0] + "`t" + $st + "`t" + [Convert]::ToBase64String($utf8.GetBytes([string]$txt)))
  $out.Flush()
}
