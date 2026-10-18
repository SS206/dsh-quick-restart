@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title DSH tray "Restart" patch

rem ---- Elevate: relaunch this script through UAC when not elevated ----
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator privileges...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs" >nul 2>&1
  exit /b
)

cd /d "%~dp0"

rem ---- Locate Node.js: PATH, then common install dirs, then the bundled DSH runtime ----
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do (
  if not defined NODE_EXE set "NODE_EXE=%%i"
)
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE (
  for /d %%d in ("%USERPROFILE%\.dsh\dsh-runtimes\*") do (
    if not defined NODE_EXE if exist "%%~fd\dependencies\node\bin\node.exe" set "NODE_EXE=%%~fd\dependencies\node\bin\node.exe"
  )
)

if not defined NODE_EXE (
  echo.
  echo Node.js was not found on this machine.
  echo Run the tool manually from an elevated prompt:
  echo     node "%~dp0patch-tray-restart.mjs"
  echo.
  pause
  exit /b 1
)

echo Using Node.js: %NODE_EXE%
echo.
"%NODE_EXE%" "%~dp0patch-tray-restart.mjs" %*
set "PATCH_EXIT=%errorlevel%"

echo.
if not "%PATCH_EXIT%"=="0" echo Patch tool exited with code %PATCH_EXIT%.
pause
