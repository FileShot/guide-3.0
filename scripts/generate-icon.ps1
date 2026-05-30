# Regenerate build/icon.ico (multi-size) and build/icon.png from frontend/public/zzz.png.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$pngPath = Join-Path $root 'frontend\public\zzz.png'
$icoPath = Join-Path $root 'build\icon.ico'
$pngOut = Join-Path $root 'build\icon.png'
if (-not (Test-Path $pngPath)) { throw "Missing $pngPath" }

Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
public static class GuideIconWriter {
  public static void Write(string pngPath, string icoPath, string pngOutPath) {
    int[] sizes = new int[] { 16, 24, 32, 48, 64, 128, 256 };
    using (Image src = Image.FromFile(pngPath)) {
      List<Bitmap> bitmaps = new List<Bitmap>();
      foreach (int s in sizes) {
        Bitmap bmp = new Bitmap(s, s);
        using (Graphics g = Graphics.FromImage(bmp)) {
          g.DrawImage(src, 0, 0, s, s);
        }
        bitmaps.Add(bmp);
      }
      using (FileStream fs = File.Create(icoPath))
      using (BinaryWriter bw = new BinaryWriter(fs)) {
        bw.Write((short)0);
        bw.Write((short)1);
        bw.Write((short)bitmaps.Count);
        int offset = 6 + 16 * bitmaps.Count;
        List<byte[]> imageData = new List<byte[]>();
        foreach (Bitmap bmp in bitmaps) {
          using (MemoryStream ms = new MemoryStream()) {
            bmp.Save(ms, ImageFormat.Png);
            imageData.Add(ms.ToArray());
          }
        }
        for (int i = 0; i < bitmaps.Count; i++) {
          Bitmap bmp = bitmaps[i];
          bw.Write((byte)(bmp.Width >= 256 ? 0 : bmp.Width));
          bw.Write((byte)(bmp.Height >= 256 ? 0 : bmp.Height));
          bw.Write((byte)0);
          bw.Write((byte)0);
          bw.Write((short)1);
          bw.Write((short)32);
          bw.Write((int)imageData[i].Length);
          bw.Write((int)offset);
          offset += imageData[i].Length;
        }
        foreach (byte[] data in imageData) bw.Write(data);
      }
      bitmaps[bitmaps.Count - 1].Save(pngOutPath, ImageFormat.Png);
      foreach (Bitmap bmp in bitmaps) bmp.Dispose();
    }
  }
}
"@

[GuideIconWriter]::Write($pngPath, $icoPath, $pngOut)
Write-Host "Wrote multi-size $icoPath and $pngOut from zzz.png"
