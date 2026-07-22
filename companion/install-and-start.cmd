@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "NODE_EXE=%CD%\runtime\node.exe"
if exist "%NODE_EXE%" goto install

echo Installing a private Node.js runtime for WatchPair...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CD%\install-runtime.ps1"
if errorlevel 1 goto failed

:install
if not exist "%CD%\node_modules\webtorrent" (
  echo Installing WatchPair Companion dependencies...
  call "%CD%\runtime\npm.cmd" install --omit=dev
  if errorlevel 1 goto failed
)

echo Starting WatchPair Companion...
"%NODE_EXE%" server.mjs
if errorlevel 1 goto failed
goto end

:failed
echo.
echo WatchPair Companion could not start.
pause
exit /b 1

:end
endlocal
