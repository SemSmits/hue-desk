@echo off
REM Builds the Windows installer + portable exe into the "dist" folder.
REM Requires Node.js 18+ (https://nodejs.org).
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)

echo Installing dependencies...
call npm install || goto :error

echo Running tests...
call npm test || goto :error

REM electron-builder's winCodeSign archive contains macOS symlinks that Windows
REM can't create without admin/Developer Mode. Pre-extract it without the darwin folder.
set "WCS=%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0"
if not exist "%WCS%\" (
  echo Preparing winCodeSign tools...
  curl -L -s -o "%TEMP%\winCodeSign-2.6.0.7z" https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z || goto :error
  "node_modules\7zip-bin\win\x64\7za.exe" x -y -bd "-xr!darwin" "%TEMP%\winCodeSign-2.6.0.7z" "-o%WCS%" >nul || goto :error
  del "%TEMP%\winCodeSign-2.6.0.7z"
)

echo Building installer...
call npm run dist || goto :error

echo.
echo Done! Your installer is in the dist folder.
explorer dist
pause
exit /b 0

:error
echo.
echo Build failed, check the output above.
pause
exit /b 1
