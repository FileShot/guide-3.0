# Regenerate build/icon.ico (multi-size) and build/icon.png from frontend/public/zzz.png.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$pngPath = Join-Path $root 'frontend\public\zzz.png'
$icoPath = Join-Path $root 'build\icon.ico'
$pngOut = Join-Path $root 'build\icon.png'
if (-not (Test-Path $pngPath)) { throw "Missing $pngPath" }

$magick = Get-Command magick -ErrorAction SilentlyContinue
if ($magick) {
  & magick $pngPath -background none -define icon:auto-resize=256,128,64,48,32,24,16 $icoPath
  & magick $pngPath -resize 512x512! $pngOut
  Write-Host "Wrote multi-size $icoPath and 512px $pngOut via ImageMagick"
  exit 0
}

# Fallback when ImageMagick is unavailable (local dev)
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile($pngPath)
$size = 512
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
Write-Warning 'ImageMagick not found - wrote 512px png but icon.ico may be low-res. CI uses ImageMagick for multi-size icons.'
