param(
  [Parameter(Mandatory = $true)][int]$Modifiers,
  [Parameter(Mandatory = $true)][int]$Vk,
  [Parameter(Mandatory = $true)][int]$Port
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class DshGlobalHotkey
{
    [DllImport("user32.dll")]
    public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll")]
    public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    [DllImport("user32.dll")]
    public static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    public static extern bool TranslateMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    public static extern IntPtr DispatchMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);

    [DllImport("user32.dll")]
    public static extern bool FlashWindowEx(ref FLASHWINFO info);

    [DllImport("user32.dll")]
    public static extern UIntPtr SetTimer(IntPtr hWnd, UIntPtr nIDEvent, uint uElapse, IntPtr lpTimerFunc);

    [DllImport("user32.dll")]
    public static extern bool KillTimer(IntPtr hWnd, UIntPtr uIDEvent);

    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public UIntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int ptX;
        public int ptY;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct FLASHWINFO
    {
        public uint cbSize;
        public IntPtr hwnd;
        public uint dwFlags;
        public uint uCount;
        public uint dwTimeout;
    }

    public static IntPtr FindDshWindow()
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            if (!IsWindowVisible(hWnd)) return true;
            StringBuilder text = new StringBuilder(512);
            GetWindowText(hWnd, text, 512);
            if (text.ToString().Contains("DeepSeek Harness"))
            {
                found = hWnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static void FocusDsh()
    {
        IntPtr hwnd = FindDshWindow();
        if (hwnd == IntPtr.Zero) return;
        ShowWindow(hwnd, 9);
        if (!SetForegroundWindow(hwnd)) SwitchToThisWindow(hwnd, true);
        FLASHWINFO info = new FLASHWINFO();
        info.cbSize = (uint)Marshal.SizeOf(typeof(FLASHWINFO));
        info.hwnd = hwnd;
        info.dwFlags = 0x00000002 | 0x00000004;
        info.uCount = 1;
        info.dwTimeout = 0;
        FlashWindowEx(ref info);
    }
}
'@

if (-not [DshGlobalHotkey]::RegisterHotKey([IntPtr]::Zero, 1, [uint32]$Modifiers, [uint32]$Vk)) {
  [Console]::Error.WriteLine('RegisterHotKey failed: the combination is probably owned by another program.')
  exit 2
}

$token = $env:DSH_SCREEN_TOKEN
if ([string]::IsNullOrWhiteSpace($token)) {
  [Console]::Error.WriteLine('DSH_SCREEN_TOKEN is missing.')
  exit 3
}

$uri = "http://127.0.0.1:$Port/dsh-screen-7421/global"
$statusUri = "http://127.0.0.1:$Port/dsh-screen-7421/status"
$msg = New-Object DshGlobalHotkey+MSG

# Watchdog: exit when the host is gone, so a crashed DSH does not leave the
# global hotkey stolen forever. Two consecutive failed health checks win.
$timerId = [DshGlobalHotkey]::SetTimer([IntPtr]::Zero, [UIntPtr]::new(2), 30000, [IntPtr]::Zero)
$misses = 0

while ($true) {
  $ret = [DshGlobalHotkey]::GetMessage([ref]$msg, [IntPtr]::Zero, 0, 0)
  if ($ret -le 0) { break }

  if ($msg.message -eq 0x0113) {
    try {
      Invoke-WebRequest -Uri $statusUri -UseBasicParsing -TimeoutSec 3 | Out-Null
      $misses = 0
    } catch {
      $misses++
      if ($misses -ge 2) { break }
    }
    continue
  }

  if ($msg.message -ne 0x0312) { continue }

  try {
    Invoke-RestMethod -Uri $uri -Method Post -Headers @{ 'x-dsh-screen-token' = $token } -ContentType 'application/json' -Body '{}' -TimeoutSec 30 | Out-Null
  } catch {
    [Console]::Error.WriteLine($_.Exception.Message)
  }

  # The host has already captured the screen by now; bring DSH forward to show the result.
  try {
    [DshGlobalHotkey]::FocusDsh()
  } catch {
    [Console]::Error.WriteLine($_.Exception.Message)
  }
}

[DshGlobalHotkey]::UnregisterHotKey([IntPtr]::Zero, 1) | Out-Null
if ($timerId -ne [UIntPtr]::Zero) {
  [DshGlobalHotkey]::KillTimer([IntPtr]::Zero, $timerId) | Out-Null
}
