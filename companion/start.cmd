@echo off
setlocal
cd /d "%~dp0"

if exist "%CD%\runtime\node.exe" (
  "%CD%\runtime\node.exe" server.mjs
  goto end
)

:missing
echo Run install-and-start.cmd first.
pause

:end
endlocal
