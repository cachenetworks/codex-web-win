import { spawn, type ChildProcess } from "node:child_process";

/**
 * Keep Playwright's runtime Chrome genuinely headed on Windows while removing
 * its window from the user's desktop. This avoids true-headless browser
 * behavior while leaving the dedicated setup/login Chrome completely visible.
 *
 * The watcher targets only Chrome browser processes launched by Playwright,
 * identified by --remote-debugging-pipe. Normal user Chrome windows are not
 * touched.
 */
export function startHiddenRuntimeChromeWatcher(): { stop: () => void } | undefined {
  if (process.platform !== "win32") return undefined;

  const script = String.raw`
$signature = @'
using System;
using System.Runtime.InteropServices;
public static class CodexChromeWindow {
  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
'@
Add-Type -TypeDefinition $signature -ErrorAction SilentlyContinue
$SW_MINIMIZE = 6
$SWP_NOZORDER = 0x0004
$SWP_NOACTIVATE = 0x0010
$SWP_SHOWWINDOW = 0x0040
while ($true) {
  try {
    $targets = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine.Contains('--remote-debugging-pipe') })
    foreach ($target in $targets) {
      $proc = Get-Process -Id ([int]$target.ProcessId) -ErrorAction SilentlyContinue
      if ($proc -and $proc.MainWindowHandle -ne 0) {
        $hwnd = [IntPtr]$proc.MainWindowHandle
        [CodexChromeWindow]::SetWindowPos($hwnd, [IntPtr]::Zero, -32000, -32000, 1280, 900, $SWP_NOZORDER -bor $SWP_NOACTIVATE -bor $SWP_SHOWWINDOW) | Out-Null
        [CodexChromeWindow]::ShowWindowAsync($hwnd, $SW_MINIMIZE) | Out-Null
      }
    }
  } catch {}
  Start-Sleep -Milliseconds 200
}
`;

  const child: ChildProcess = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
    {
      windowsHide: true,
      stdio: "ignore",
    },
  );
  child.unref();

  return {
    stop: () => {
      if (child.exitCode !== null || child.killed) return;
      try { child.kill(); } catch {}
    },
  };
}
