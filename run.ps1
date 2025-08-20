param([int]$Port=8000)

function Resolve-Python {
  # Try commands first
  foreach ($cmd in @('py','python')) {
    $infos = Get-Command $cmd -All -ErrorAction SilentlyContinue
    foreach ($info in $infos) {
      if ($info.Path -and ($info.Path -notmatch 'WindowsApps')) {
        return $info.Path
      }
    }
  }
  # Try common install paths
  $paths = @(
    "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
    "$env:ProgramFiles\Python312\python.exe",
    "$env:ProgramFiles\Python311\python.exe"
  )
  foreach ($p in $paths) { if (Test-Path $p) { return $p } }
  # Last resort: search under LocalAppData\Programs\Python
  $found = Get-ChildItem "$env:LOCALAPPDATA\Programs\Python" -Recurse -Filter python.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
  if ($found) { return $found }
  throw "Python not found. Install Python 3.12 and/or install Python Launcher: winget install -e --id Python.Launcher"
}

# Resolve script directory (works even if run from a different CWD)
if (-not $PSScriptRoot) { $PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path }
$Root   = $PSScriptRoot
$Venv   = Join-Path $Root '.venv'
$Req    = Join-Path $Root 'requirements.txt'

$py = Resolve-Python
if (!(Test-Path $Venv)) { Write-Host 'Creating virtual environment...'; & $py -m venv $Venv }
$venvPy = Join-Path (Join-Path $Venv 'Scripts') 'python.exe'
if (!(Test-Path $venvPy)) { throw "Venv python not found at $venvPy" }
& $venvPy -m pip install --upgrade pip
& $venvPy -m pip install -r $Req
& $venvPy -m uvicorn backend.main:app --app-dir $Root --reload --reload-dir $Root --port $Port
