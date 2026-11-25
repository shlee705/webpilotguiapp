param([Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$BrowserProcessId)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$edgeProcess = Get-Process -Id $BrowserProcessId -ErrorAction Stop
if ($edgeProcess.ProcessName -ne 'msedge') { throw 'Only the managed Microsoft Edge process may be focused.' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WebPilotEdgeFocus {
  public delegate bool WindowVisitor(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumWindows(WindowVisitor visitor, IntPtr data);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint command);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hwnd, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint first, uint second, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

  public static bool Focus(uint expectedPid) {
    IntPtr target = IntPtr.Zero;
    EnumWindows((hwnd, data) => {
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      if (pid == expectedPid && IsWindowVisible(hwnd) && GetWindow(hwnd, 4) == IntPtr.Zero) {
        target = hwnd;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    if (target == IntPtr.Zero) return false;
    if (GetForegroundWindow() == target) return true;
    if (IsIconic(target)) ShowWindowAsync(target, 3);
    uint unused;
    uint currentThread = GetCurrentThreadId();
    uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out unused);
    uint targetThread = GetWindowThreadProcessId(target, out unused);
    bool joinedForeground = false, joinedTarget = false;
    try {
      if (foregroundThread != 0 && foregroundThread != currentThread) joinedForeground = AttachThreadInput(currentThread, foregroundThread, true);
      if (targetThread != currentThread && targetThread != foregroundThread) joinedTarget = AttachThreadInput(currentThread, targetThread, true);
      BringWindowToTop(target);
      SetForegroundWindow(target);
    } finally {
      if (joinedTarget) AttachThreadInput(currentThread, targetThread, false);
      if (joinedForeground) AttachThreadInput(currentThread, foregroundThread, false);
    }
    return GetForegroundWindow() == target;
  }
}
'@
@{ ok = [WebPilotEdgeFocus]::Focus([uint32]$BrowserProcessId) } | ConvertTo-Json -Compress
