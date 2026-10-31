@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
if errorlevel 1 (
  echo.
  echo Uninstall failed. See the message above.
) else (
  echo.
  echo Done. Restart DeepSeek Harness if the menu row is still visible.
)
pause
