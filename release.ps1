#Requires -Version 7
# Packages the built SlideBook.exe into release\SlideBook-<version>.zip (portable) and
# release\SlideBook-<version>-Setup.exe (self-extracting, runs Setup-SlideBook). Build first: pwsh -File build.ps1
# -Publish also tags v<version> and creates the GitHub release that installed copies update from. Its notes
# are every commit since the previous release, which is the change list the app shows when it updates.
param([switch]$Publish)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$version = (Select-String -Path app\desktop.py -Pattern "VERSION = '([^']+)'").Matches[0].Groups[1].Value
if (-not (Test-Path SlideBook.exe)) { throw 'SlideBook.exe not found. Run build.ps1 first.' }
$newest = Get-ChildItem app, web\src -Recurse -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($newest.LastWriteTime -gt (Get-Item SlideBook.exe).LastWriteTime) {
  Write-Warning "SlideBook.exe is older than $($newest.FullName). Run build.ps1 for the latest code."
}

$rel = Join-Path $PSScriptRoot 'release'
$stage = Join-Path $rel 'stage'
$sfx = Join-Path $rel 'sfx'
Remove-Item $stage, $sfx -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $stage, $sfx | Out-Null

Copy-Item SlideBook.exe, README.md, Setup-SlideBook.ps1, Setup-SlideBook.cmd $stage
Copy-Item fonts, obs $stage -Recurse
if (Test-Path tools) { Copy-Item tools $stage -Recurse }
if (Test-Path SlideBookVideos.exe) { Copy-Item SlideBookVideos.exe $stage }
Copy-Item sfx $stage -Recurse

$zip = Join-Path $rel "SlideBook-$version.zip"
Remove-Item $zip -ErrorAction SilentlyContinue
Compress-Archive -Path "$stage\*" -DestinationPath $zip -CompressionLevel Optimal

# IExpress packs flat files only, so the folder tree travels as one zip that install.cmd unpacks.
Copy-Item $zip (Join-Path $sfx 'payload.zip')
@'
@echo off
set "D=%TEMP%\SlideBookSetup"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Remove-Item -Recurse -Force -LiteralPath $env:D -ErrorAction SilentlyContinue; Expand-Archive -LiteralPath '%~dp0payload.zip' -DestinationPath $env:D -Force"
call "%D%\Setup-SlideBook.cmd"
'@ | Set-Content (Join-Path $sfx 'install.cmd') -Encoding ascii

$exe = Join-Path $rel "SlideBook-$version-Setup.exe"
Remove-Item $exe -ErrorAction SilentlyContinue
$sed = Join-Path $sfx 'setup.sed'
@"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=0
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=%InstallPrompt%
DisplayLicense=%DisplayLicense%
FinishMessage=%FinishMessage%
TargetName=%TargetName%
FriendlyName=%FriendlyName%
AppLaunched=%AppLaunched%
PostInstallCmd=%PostInstallCmd%
AdminQuietInstCmd=%AdminQuietInstCmd%
UserQuietInstCmd=%UserQuietInstCmd%
SourceFiles=SourceFiles
[Strings]
InstallPrompt=SlideBook is built by Nishad Kaippally (KaippsCafe@gmail.com) and given away free, so content creators are never charged for making shorts. Install SlideBook $version?
DisplayLicense=
FinishMessage=
TargetName=$exe
FriendlyName=SlideBook $version Setup
AppLaunched=cmd /c install.cmd
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
FILE0="install.cmd"
FILE1="payload.zip"
[SourceFiles]
SourceFiles0=$sfx\
[SourceFiles0]
%FILE0%=
%FILE1%=
"@ | Set-Content $sed -Encoding ascii

& "$env:SystemRoot\System32\iexpress.exe" /N /Q $sed | Out-Null
for ($i = 0; $i -lt 600 -and -not (Test-Path $exe); $i++) { Start-Sleep -Milliseconds 500 }
Get-Process iexpress, makecab -ErrorAction SilentlyContinue | Wait-Process -Timeout 600
if (-not (Test-Path $exe)) { throw 'IExpress did not produce the setup exe.' }

Remove-Item $stage, $sfx -Recurse -Force
"SlideBook $version"
"  installer: $exe"
"  portable:  $zip"

if ($Publish) {
  $tag = "v$version"
  if (git tag --list $tag) { throw "$tag already exists. Bump VERSION in app/desktop.py first." }
  if (git status --porcelain) { throw 'Commit your changes first: the release notes are built from the commits.' }
  $prev = git describe --tags --abbrev=0 2>$null
  $range = if ($prev) { "$prev..HEAD" } else { 'HEAD' }
  $notes = Join-Path $rel "notes-$version.md"
  $lines = git log $range --no-merges --reverse --pretty=format:'- %s'
  @("Changes since $(if ($prev) { $prev } else { 'the first build' }):", '') + $lines | Set-Content $notes -Encoding utf8
  git tag $tag
  git push origin $tag
  gh release create $tag $zip $exe --title "SlideBook $version" --notes-file $notes
  "  published: https://github.com/kaippally/SlideBook/releases/tag/$tag"
}
