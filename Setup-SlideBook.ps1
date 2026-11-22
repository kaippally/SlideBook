#Requires -Version 5.1
<#
  SlideBook setup. Per-user install, no admin needed.
    .\Setup-SlideBook.ps1                 install / update
    .\Setup-SlideBook.ps1 -CopyData       also copy this folder's data\ (books, media, settings) into the install
    .\Setup-SlideBook.ps1 -GeminiKey KEY  store GEMINI_API_KEY for the user
    .\Setup-SlideBook.ps1 -Uninstall      remove the app (asks before deleting data\)
#>
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\SlideBook'),
  [switch]$CopyData,
  [string]$GeminiKey,
  [switch]$NoPrereqs,
  [switch]$NoDesktopShortcut,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$Src = $PSScriptRoot
$StartMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\SlideBook.lnk'
$Desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'SlideBook.lnk'
$UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SlideBook'

function Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "    $m" -ForegroundColor Yellow }

function Stop-SlideBook {
  Get-Process SlideBook -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Milliseconds 500
}

if ($Uninstall) {
  Step "Uninstalling SlideBook from $InstallDir"
  Stop-SlideBook
  Remove-Item $StartMenu, $Desktop -ErrorAction SilentlyContinue
  Remove-Item $UninstallKey -Recurse -ErrorAction SilentlyContinue
  if (Test-Path $InstallDir) {
    $data = Join-Path $InstallDir 'data'
    $keep = $false
    if (Test-Path $data) {
      $keep = (Read-Host "Keep your books and media in $data ? [Y/n]") -notmatch '^[nN]'
    }
    Get-ChildItem $InstallDir | Where-Object { -not ($keep -and $_.Name -eq 'data') } |
      Remove-Item -Recurse -Force
    if (-not $keep) { Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue }
  }
  Write-Host 'SlideBook removed.' -ForegroundColor Green
  return
}

foreach ($need in 'SlideBook.exe', 'fonts') {
  if (-not (Test-Path (Join-Path $Src $need))) { throw "$need not found beside this script ($Src). Build first: pwsh -File build.ps1" }
}

function Test-WebView2 {
  $id = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
  foreach ($k in "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$id",
                 "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$id",
                 "HKCU:\Software\Microsoft\EdgeUpdate\Clients\$id") {
    $v = (Get-ItemProperty $k -ErrorAction SilentlyContinue).pv
    if ($v -and $v -ne '0.0.0.0') { return $true }
  }
  $false
}

function Get-NodeMajor {
  foreach ($n in @((Get-Command node -ErrorAction SilentlyContinue).Source, 'C:\Program Files\nodejs\node.exe')) {
    if ($n -and (Test-Path $n)) {
      try { return [int]((& $n --version) -replace '^v', '' -split '\.')[0] } catch {}
    }
  }
  0
}

function Install-Winget($id, $what) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Warn "winget not available; install $what by hand."
    return
  }
  Step "Installing $what ($id)"
  winget install --id $id -e --accept-package-agreements --accept-source-agreements --silent
  if ($LASTEXITCODE) { Warn "winget returned $LASTEXITCODE for $id" }
}

if (-not $NoPrereqs) {
  Step 'Checking prerequisites'
  if (Test-WebView2) { '    WebView2 runtime: ok' } else { Install-Winget 'Microsoft.EdgeWebView2Runtime' 'WebView2 runtime (draws the app window)' }

  $ffBeside = Test-Path (Join-Path $Src 'tools\ffmpeg.exe')
  if ($ffBeside -or (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { '    ffmpeg: ok' }
  else { Install-Winget 'Gyan.FFmpeg' 'ffmpeg (video download, clips, posters)' }

  $major = Get-NodeMajor
  if ($major -ge 22) { "    Node.js: v$major ok" }
  else {
    if ($major) { Warn "Node.js v$major is too old; yt-dlp's YouTube solver needs 22+." }
    Install-Winget 'OpenJS.NodeJS.LTS' 'Node.js LTS (YouTube downloads)'
  }
}

Step "Installing to $InstallDir"
Stop-SlideBook
New-Item -ItemType Directory -Force $InstallDir | Out-Null
Copy-Item (Join-Path $Src 'SlideBook.exe') $InstallDir -Force
Copy-Item (Join-Path $Src 'fonts') $InstallDir -Recurse -Force
foreach ($opt in 'obs', 'tools', 'README.md') {
  $p = Join-Path $Src $opt
  if (Test-Path $p) { Copy-Item $p $InstallDir -Recurse -Force }
}
Copy-Item $PSCommandPath $InstallDir -Force

if ($CopyData) {
  $srcData = Join-Path $Src 'data'
  $dstData = Join-Path $InstallDir 'data'
  if (-not (Test-Path $srcData)) { Warn 'No data\ folder beside this script; nothing copied.' }
  elseif ((Resolve-Path $srcData).Path -eq [IO.Path]::GetFullPath($dstData)) { '    data\ is already in place' }
  else {
    if (Test-Path (Join-Path $dstData 'slidebook.db')) {
      if ((Read-Host "$dstData already has a library. Overwrite it? [y/N]") -notmatch '^[yY]') { Warn 'Kept the installed library.'; $CopyData = $false }
    }
    if ($CopyData) {
      Step 'Copying library (data\)'
      Copy-Item $srcData $InstallDir -Recurse -Force
    }
  }
}

if ($GeminiKey) {
  Step 'Saving GEMINI_API_KEY for this user'
  [Environment]::SetEnvironmentVariable('GEMINI_API_KEY', $GeminiKey, 'User')
}

Step 'Creating shortcuts'
$exe = Join-Path $InstallDir 'SlideBook.exe'
$shell = New-Object -ComObject WScript.Shell
$links = @($StartMenu); if (-not $NoDesktopShortcut) { $links += $Desktop }
foreach ($l in $links) {
  $s = $shell.CreateShortcut($l)
  $s.TargetPath = $exe
  $s.WorkingDirectory = $InstallDir
  $s.IconLocation = "$exe,0"
  $s.Save()
}

$version = '0.0.0'
try { $version = (Get-Item $exe).VersionInfo.ProductVersion; if (-not $version) { $version = '0.1.0' } } catch {}
New-Item $UninstallKey -Force | Out-Null
$u = "`"$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`" -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $InstallDir 'Setup-SlideBook.ps1')`" -Uninstall -InstallDir `"$InstallDir`""
@{ DisplayName = 'SlideBook'; DisplayVersion = $version; Publisher = 'Kaipps'; InstallLocation = $InstallDir
   DisplayIcon = $exe; UninstallString = $u; NoModify = 1; NoRepair = 1 }.GetEnumerator() | ForEach-Object {
  $type = if ($_.Value -is [int]) { 'DWord' } else { 'String' }
  New-ItemProperty $UninstallKey -Name $_.Key -Value $_.Value -PropertyType $type -Force | Out-Null
}

Write-Host ''
Write-Host "SlideBook installed: $exe" -ForegroundColor Green
'  OBS: Browser Source 1920x1080 -> http://127.0.0.1:8780/output'
"  OBS hotkeys: Tools -> Scripts -> + -> $(Join-Path $InstallDir 'obs\slidebook-keys.lua')"
if (-not $GeminiKey -and -not [Environment]::GetEnvironmentVariable('GEMINI_API_KEY', 'User')) {
  '  Gemini key: set it in the app (Settings) or re-run with -GeminiKey <key>.'
}
'  Telegram links (optional) need StudioMate''s bot running on this machine (:5001).'
