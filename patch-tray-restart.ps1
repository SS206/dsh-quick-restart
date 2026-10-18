# DSH tray "Restart" patch - helper that requests elevation automatically.
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$patchTool = Join-Path $scriptDir 'patch-tray-restart.mjs'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'Requesting administrator privileges...'
  Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $MyInvocation.MyCommand.Path) -Verb RunAs
  exit
}

$node = $null
$fromPath = Get-Command node -ErrorAction SilentlyContinue
if ($fromPath) { $node = $fromPath.Source }

$candidates = New-Object System.Collections.Generic.List[string]
if ($env:ProgramFiles) { $candidates.Add((Join-Path $env:ProgramFiles 'nodejs\node.exe')) }
$programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
if ($programFilesX86) { $candidates.Add((Join-Path $programFilesX86 'nodejs\node.exe')) }
if ($env:LOCALAPPDATA) { $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')) }
foreach ($candidate in $candidates) {
  if (-not $node -and (Test-Path -LiteralPath $candidate)) { $node = $candidate }
}

if (-not $node -and $env:USERPROFILE) {
  $runtimes = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes'
  if (Test-Path -LiteralPath $runtimes) {
    Get-ChildItem -LiteralPath $runtimes -Directory | ForEach-Object {
      $bundled = Join-Path $_.FullName 'dependencies\node\bin\node.exe'
      if (-not $node -and (Test-Path -LiteralPath $bundled)) { $node = $bundled }
    }
  }
}

if (-not $node) {
  Write-Host 'Node.js was not found on this machine.'
  Write-Host 'Run the tool manually from an elevated prompt:'
  Write-Host ('    node "' + $patchTool + '"')
  Read-Host 'Press Enter to close'
  exit 1
}

Write-Host ('Using Node.js: ' + $node)
& $node $patchTool @args
$exitCode = $LASTEXITCODE
Write-Host ''
if ($exitCode -ne 0) { Write-Host ('Patch tool exited with code ' + $exitCode) }
Read-Host 'Press Enter to close'
exit $exitCode
