@echo off
setlocal EnableExtensions
set "ROOT=%~dp0"
set "VENV=%ROOT%\.venv"
set "REQ=%ROOT%\requirements.txt"

REM Create venv with py if available; fallback to python
if not exist "%VENV%" (
  echo Creating virtual environment...
  py -3 -m venv "%VENV%" 2>nul
  if errorlevel 1 (
    echo py not found, trying python...
    python -m venv "%VENV%"
  )
)

set "VENV_PY=%VENV%\Scripts\python.exe"
if not exist "%VENV_PY%" (
  echo Venv python not found at "%VENV_PY%"
  exit /b 1
)

"%VENV_PY%" -m pip install --upgrade pip
"%VENV_PY%" -m pip install -r "%REQ%"
"%VENV_PY%" -m uvicorn backend.main:app --app-dir "%ROOT%" --reload --reload-dir "%ROOT%" --port 8000
endlocal
