@echo off
REM ===================================================================
REM  BuildTrack Video Factory - one-click launcher for Windows
REM
REM  Double-click this file. It installs dependencies the first time,
REM  provisions the local renderer, checks the environment and then
REM  opens the app in your default browser.
REM ===================================================================
setlocal
cd /d "%~dp0"

title BuildTrack Video Factory

echo.
echo  ==========================================================
echo   BuildTrack Video Factory
echo  ==========================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  [X] Node.js is not installed or not on PATH.
  echo.
  echo      Install the LTS build from https://nodejs.org/ then
  echo      double-click this file again.
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODEV=%%v
echo  [ok] Node.js %NODEV%

if not exist "node_modules" (
  echo.
  echo  [..] First run: installing dependencies. This takes a few minutes.
  call npm install
  if errorlevel 1 (
    echo  [X] npm install failed. See the message above.
    pause
    exit /b 1
  )
) else (
  echo  [ok] Dependencies already installed
)

if not exist ".browser\chrome.exe" (
  echo.
  echo  [..] First run: preparing the local video renderer.
  call npm run provision
  if errorlevel 1 (
    echo  [X] Could not prepare the renderer. See the message above.
    pause
    exit /b 1
  )
) else (
  echo  [ok] Video renderer already prepared
)

REM `npm run build` compiles the core library *and* the interface. The API
REM imports @buildtrack/core from its dist, so skipping the core build makes
REM the server fail to start with ERR_MODULE_NOT_FOUND.
if not exist "packages\core\dist\index.js" goto build
if not exist "apps\web\dist\index.html" goto build
goto built
:build
echo.
echo  [..] Building the core library and the interface.
call npm run build
if errorlevel 1 (
  echo  [X] The build failed. See the message above.
  pause
  exit /b 1
)
:built

echo.
echo  Checking the environment...
call npm run doctor
echo.

echo  ==========================================================
echo   Starting. The app will open in your browser.
echo   Leave this window open while you work.
echo  ==========================================================
echo.

start "" http://localhost:3000
call npm start

echo.
echo  The app has stopped. Press any key to close this window.
pause >nul
