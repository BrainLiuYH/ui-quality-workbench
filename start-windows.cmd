@echo off
setlocal
set PYTHONUTF8=1
py -3 --version >nul 2>&1
if not errorlevel 1 (
  py -3 "%~dp0start.py" %*
  goto finished
)
python --version >nul 2>&1
if not errorlevel 1 (
  python "%~dp0start.py" %*
  goto finished
)
echo Python 3.9 or newer is required. Install Python from https://www.python.org/downloads/windows/
echo Then reopen this launcher.
pause
exit /b 1
:finished
if errorlevel 1 (
  echo The toolbox could not finish. Check the error above.
  pause
  exit /b 1
)
endlocal
