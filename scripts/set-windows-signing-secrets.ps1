#Requires -Version 5.1
<#
Uploads your code-signing certificate to GitHub Actions for FileShot/guide-3.0.

IMPORTANT
  GitHub never lets anyone read secret values back — not from the API and not from me.
  So your old repo's WIN_* secrets cannot be "copied" automatically. You must point this
  script at the same .pfx file you used before (or create secrets manually in the repo UI).

Secrets created (must match .github/workflows/build.yml):
  WIN_CSC_LINK           Base64 of the .pfx file (electron-builder accepts Base64 in CSC_LINK),
                         OR use -SigningUrl if your .pfx is hosted at an HTTPS URL instead.
  WIN_CSC_KEY_PASSWORD   Plain-text export password for that .pfx / URL resource.

GitHub limits encrypted secrets to ~48 KB. If Base64(.pfx) exceeds that, use -SigningUrl.

Prerequisites: GitHub CLI (`gh`) authenticated (`gh auth login`).

Examples:
  .\scripts\set-windows-signing-secrets.ps1 -Repo FileShot/guide-3.0 -PfxPath C:\certs\GraySoft_codesign.pfx
  .\scripts\set-windows-signing-secrets.ps1 -Repo FileShot/guide-3.0 -SigningUrl 'https://.../cert.pfx?sv=...'
#>
param(
  [Parameter(Mandatory = $true)][string]$Repo,
  [string]$PfxPath,
  [string]$SigningUrl
)

$ErrorActionPreference = 'Stop'

if (-not $PfxPath -and -not $SigningUrl) {
  throw 'Specify either -PfxPath or -SigningUrl.'
}
if ($PfxPath -and $SigningUrl) {
  throw 'Use only one of -PfxPath or -SigningUrl.'
}

function Ensure-Gh {
  $gh = Get-Command gh -ErrorAction SilentlyContinue
  if (-not $gh) { throw 'Install GitHub CLI: https://cli.github.com/ then run gh auth login.' }
}

Ensure-Gh

if ($SigningUrl) {
  $SigningUrl | gh secret set WIN_CSC_LINK --repo $Repo
}
else {
  $resolved = Resolve-Path $PfxPath
  $bytes = [System.IO.File]::ReadAllBytes($resolved.Path)
  $b64 = [Convert]::ToBase64String($bytes)
  # GitHub Actions encrypted secrets max ~48 KB — Base64 expands ~4/3 of raw file size
  if ($b64.Length -gt 45000) {
    throw @"
PFX Base64 length $($b64.Length) exceeds GitHub secret limit (~48KB).
Host the .pfx at a private HTTPS URL (SAS, etc.) and rerun with -SigningUrl instead.
"@
  }
  $b64 | gh secret set WIN_CSC_LINK --repo $Repo
}

$secure = Read-Host 'PFX / signing password (WIN_CSC_KEY_PASSWORD)' -AsSecureString
$BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)
} finally {
  [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BSTR)
}

$plain | gh secret set WIN_CSC_KEY_PASSWORD --repo $Repo

Write-Host ''
Write-Host 'Secrets WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD are set on' $Repo
Write-Host 'Trigger "Build & Release". CI verifies the NSIS *-setup.exe (what SmartScreen sees), not only win-unpacked/guIDE.exe.'
