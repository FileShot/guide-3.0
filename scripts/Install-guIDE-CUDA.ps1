# Install guIDE CUDA portable build to Program Files and create a desktop shortcut.
param(
  [string]$InstallDir = "$env:ProgramFiles\guIDE"
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path "$here\guIDE.exe")) {
  Write-Error "Run this from the extracted guIDE folder (guIDE.exe not found)."
}

Write-Host "Installing guIDE to $InstallDir ..."
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Path "$here\*" -Destination $InstallDir -Recurse -Force

$shell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = $shell.CreateShortcut("$desktop\guIDE.lnk")
$lnk.TargetPath = "$InstallDir\guIDE.exe"
$lnk.WorkingDirectory = $InstallDir
$lnk.Save()

Write-Host "Done. Launch guIDE from your desktop or $InstallDir\guIDE.exe"
