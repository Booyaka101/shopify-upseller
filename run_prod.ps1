param(
  [int]$Port = 8000,
  [string]$BindAddress = '127.0.0.1',
  [int]$Workers = 1,
  [string]$LogLevel = 'info'
)

function Resolve-Python {
  foreach ($cmd in @('py','python')) {
    $infos = Get-Command $cmd -All -ErrorAction SilentlyContinue
    foreach ($info in $infos) {
      if ($info.Path -and ($info.Path -notmatch 'WindowsApps')) { return $info.Path }
    }
  }
  $paths = @(
    "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
    "$env:ProgramFiles\Python312\python.exe",
    "$env:ProgramFiles\Python311\python.exe"
  )
  foreach ($p in $paths) { if (Test-Path $p) { return $p } }
  $found = Get-ChildItem "$env:LOCALAPPDATA\Programs\Python" -Recurse -Filter python.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
  if ($found) { return $found }
  throw "Python not found. Install Python 3.12 and/or install Python Launcher: winget install -e --id Python.Launcher"
}

$ScriptRoot = $PSScriptRoot
if (-not $ScriptRoot) { $ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path }
$Root = $ScriptRoot
$Venv = Join-Path $Root '.venv'
$Req  = Join-Path $Root 'requirements.txt'

$py = Resolve-Python
if (!(Test-Path $Venv)) { Write-Host 'Creating virtual environment...' -ForegroundColor Cyan; & $py -m venv $Venv }
$venvPy = Join-Path (Join-Path $Venv 'Scripts') 'python.exe'
if (!(Test-Path $venvPy)) { throw "Venv python not found at $venvPy" }

& $venvPy -m pip install --upgrade pip
& $venvPy -m pip install -r $Req

$env:ENV = 'prod'
Write-Host ("Starting BooPug (prod) on http://{0}:{1} with {2} worker(s)..." -f $BindAddress, $Port, $Workers) -ForegroundColor Green
& $venvPy -m uvicorn backend.main:app --app-dir $Root --host $BindAddress --port $Port --workers $Workers --log-level $LogLevel
