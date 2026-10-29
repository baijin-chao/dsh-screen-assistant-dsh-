param(
  [Parameter(Mandatory = $true)][string]$OutPath,
  [Parameter(Mandatory = $true)][string]$MetaPath,
  [int]$MaxEdge = 2560
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class DshScreenNative
{
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@

# Make GDI report physical pixels instead of virtualized coordinates.
[DshScreenNative]::SetProcessDPIAware() | Out-Null

$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($bounds.Width -le 0 -or $bounds.Height -le 0) {
  throw 'No interactive desktop is available to capture.'
}

$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
} finally {
  $graphics.Dispose()
}

$scale = [Math]::Min(1.0, [double]$MaxEdge / [Math]::Max($bitmap.Width, $bitmap.Height))
$output = $bitmap
$resized = $null
try {
  if ($scale -lt 1.0) {
    $width = [Math]::Max(1, [int][Math]::Round($bitmap.Width * $scale))
    $height = [Math]::Max(1, [int][Math]::Round($bitmap.Height * $scale))
    $resized = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $resizeGraphics = [System.Drawing.Graphics]::FromImage($resized)
    try {
      $resizeGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $resizeGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $resizeGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $resizeGraphics.DrawImage($bitmap, 0, 0, $width, $height)
    } finally {
      $resizeGraphics.Dispose()
    }
    $output = $resized
  }

  $dir = [System.IO.Path]::GetDirectoryName($OutPath)
  if ($dir -and -not [System.IO.Directory]::Exists($dir)) {
    [System.IO.Directory]::CreateDirectory($dir) | Out-Null
  }
  $output.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)

  # Write the result to a sidecar JSON file instead of stdout: the host may
  # run in a sandbox that forbids anonymous pipes.
  $metaObject = [pscustomobject]@{
    path = $OutPath
    width = $output.Width
    height = $output.Height
    sourceWidth = $bitmap.Width
    sourceHeight = $bitmap.Height
    scale = [Math]::Round($scale, 4)
  }
  $meta = ConvertTo-Json -InputObject $metaObject -Compress
  [System.IO.File]::WriteAllText($MetaPath, $meta, [System.Text.Encoding]::UTF8)
} finally {
  if ($resized) { $resized.Dispose() }
  $bitmap.Dispose()
}
