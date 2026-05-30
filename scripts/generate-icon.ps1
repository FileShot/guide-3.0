# Regenerate build/icon.ico and build/icon.png from frontend/public/zzz.png (taskbar + electron-builder).
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$pngPath = Join-Path $root 'frontend\public\zzz.png'
$icoPath = Join-Path $root 'build\icon.ico'
$pngOut = Join-Path $root 'build\icon.png'
if (-not (Test-Path $pngPath)) { throw "Missing $pngPath" }

Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile($pngPath)
$size = 256
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($src, 0, 0, $size, $size)
$g.Dispose()
$src.Dispose()
$bmp.Save($pngOut, [System.Drawing.Imaging.ImageFormat]::Png)
$hIcon = $bmp.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($hIcon)
$fs = [System.IO.File]::Create($icoPath)
$icon.Save($fs)
$fs.Close()
$bmp.Dispose()
$icon.Dispose()
Write-Host "Wrote $icoPath and $pngOut from zzz.png"
