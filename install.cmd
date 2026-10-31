@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  echo.
  echo Install failed. See the message above.
) else (
  echo.
  echo Done. Open any conversation's "..." menu to find the red Delete row.
)
pause
