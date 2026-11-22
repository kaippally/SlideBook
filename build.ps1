$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Push-Location web
npx tsc --noEmit
if ($LASTEXITCODE) { exit $LASTEXITCODE }
npx vite build
if ($LASTEXITCODE) { exit $LASTEXITCODE }
Pop-Location

$version = (Select-String -Path app\desktop.py -Pattern "VERSION = '([^']+)'").Matches[0].Groups[1].Value
$out = Join-Path $env:TEMP 'slidebook_pbuild'
& .venv\Scripts\python.exe -m PyInstaller app/desktop.py --onefile --noconsole --noconfirm --name SlideBook `
  --paths "$PSScriptRoot/app" --hidden-import server --hidden-import core --hidden-import db --hidden-import analysis --hidden-import relay --hidden-import bot --hidden-import videos --hidden-import paths `
  --collect-all yt_dlp --collect-all yt_dlp_ejs --collect-submodules google.genai --collect-submodules aiohttp --collect-submodules telegram `
  --collect-submodules youtube_transcript_api --collect-all pymupdf --hidden-import fitz `
  --add-data "$PSScriptRoot/web/dist;dist" `
  --distpath "$out\dist" --workpath "$out\work" --specpath "$out"
if ($LASTEXITCODE) { exit $LASTEXITCODE }

Get-Process 'SlideBook' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500
Copy-Item "$out\dist\SlideBook.exe" . -Force
"Built SlideBook $version -> $PSScriptRoot\SlideBook.exe"
