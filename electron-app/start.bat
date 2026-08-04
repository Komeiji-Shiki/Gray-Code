@echo off
rem ===========================================================================
rem  GrayCode Desktop - quick launcher (Windows)
rem  Double-click this file (or run `start.bat` from a terminal) to start the
rem  app. It installs dependencies and builds the frontend/main process only
rem  when needed, so subsequent launches are fast.
rem
rem  Usage:  start.bat [--rebuild]
rem          --rebuild  force a full rebuild (frontend + patch + main process)
rem ===========================================================================
setlocal
cd /d "%~dp0"

if not exist node_modules\.bin\electron.cmd (
  echo [GrayCode] Dependencies not found. Installing...
  call npm install
  if errorlevel 1 (
    echo [GrayCode] npm install failed. Please make sure Node.js ^>= 20 is installed.
    pause
    exit /b 1
  )
)

set NEEDS_BUILD=0
if "%~1"=="--rebuild" set NEEDS_BUILD=1
if not exist dist\main.js set NEEDS_BUILD=1
if not exist ..\frontend\dist\index.html set NEEDS_BUILD=1

if "%NEEDS_BUILD%"=="1" (
  rem NOTE: cmd.exe's block parser treats unescaped parens in echo text as block
  rem boundaries, which breaks parsing (hangs / exit 255). Escaped with ^( ^).
  echo [GrayCode] Building frontend + main process ^(first launch or sources changed^)...
  call npm run build:all
  if errorlevel 1 (
    echo [GrayCode] Build failed.
    pause
    exit /b 1
  )
)

echo [GrayCode] Starting GrayCode Desktop...
call node_modules\.bin\electron.cmd .
exit /b %errorlevel%
