[CmdletBinding()]
param(
  [ValidateSet('Check', 'Execute')]
  [string] $Mode = 'Check',
  [string] $TicketPath = ''
)

# This helper is started detached from the DSH Host. The Host process itself
# cannot call Electron app.relaunch(), which is private to the Desktop main
# process; restart only the validated Desktop main PID and let its packaged
# executable start a fresh application/Host.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-DesktopMain {
  # Electron utility/renderer processes and even nested Node workers can have
  # the identical exe name. Some utility workers lack the --type flag entirely.
  # Identify the ONE root of the executable process tree instead of assuming
  # that every process without --type is a Desktop main.
  $instances = @(Get-CimInstance Win32_Process -Filter "Name = 'DeepSeek Harness.exe'" |
    Where-Object {
      $_.ExecutablePath -and
      [IO.Path]::GetFileName($_.ExecutablePath) -eq 'DeepSeek Harness.exe'
    })
  if ($instances.Count -eq 0) { throw 'desktop-process-not-running' }
  $allPids = [System.Collections.Generic.HashSet[int]]::new()
  foreach ($instance in $instances) { [void] $allPids.Add([int] $instance.ProcessId) }
  $roots = @($instances | Where-Object { -not $allPids.Contains([int] $_.ParentProcessId) })
  if ($roots.Count -ne 1) { throw 'desktop-root-process-not-unique' }
  $item = $roots[0]
  $folder = Split-Path -Parent $item.ExecutablePath
  if (-not (Test-Path -LiteralPath (Join-Path $folder 'resources\app.asar') -PathType Leaf)) {
    throw 'desktop-bundle-not-found'
  }
  return [pscustomobject]@{
    pid = [int] $item.ProcessId
    exePath = [string] $item.ExecutablePath
  }
}

function Get-DesktopTree([int] $mainPid, [string] $exePath) {
  # Only inspect this EXACT installed executable. The detached PowerShell
  # watchdog and unrelated Node.exe processes must never be terminated.
  $instances = @(Get-CimInstance Win32_Process -Filter "Name = 'DeepSeek Harness.exe'" |
    Where-Object { $_.ExecutablePath -eq $exePath })
  $levels = @{}
  $levels[$mainPid] = 0
  for ($i = 0; $i -lt $instances.Count; $i++) {
    $updated = $false
    foreach ($pr in $instances) {
      $pidValue = [int] $pr.ProcessId
      $parentPid = [int] $pr.ParentProcessId
      if (-not $levels.ContainsKey($pidValue) -and $levels.ContainsKey($parentPid)) {
        $levels[$pidValue] = $levels[$parentPid] + 1
        $updated = $true
      }
    }
    if (-not $updated) { break }
  }
  if ($levels.Count -ne $instances.Count) { throw 'desktop-tree-incomplete' }
  $list = foreach ($pr in $instances) {
    [pscustomobject]@{
      pid = [int] $pr.ProcessId
      parentPid = [int] $pr.ParentProcessId
      depth = [int] $levels[[int] $pr.ProcessId]
    }
  }
  return $list | Sort-Object depth -Descending
}

function Write-Ticket([object] $item) {
  $json = $item | ConvertTo-Json -Depth 5 -Compress
  $suffix = [guid]::NewGuid().ToString('N')
  $tmp = $TicketPath + '.worker-' + $suffix + '.tmp'
  $backup = $TicketPath + '.worker-' + $suffix + '.bak'
  try {
    # Do not overwrite a completion that the new Host already acknowledged.
    $current = Get-Content -LiteralPath $TicketPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($current.requestId -eq $item.requestId -and $current.phase -eq 'notified' -and
        $item.phase -eq 'restarted') { return }
    [IO.File]::WriteAllText($tmp, $json, (New-Object Text.UTF8Encoding($false)))
    # .NET Framework on Windows requires a nonempty backupFileName.
    # A null backup path fails with "The path is empty".
    [IO.File]::Replace($tmp, $TicketPath, $backup)
  } finally {
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue }
  }
}

if ($Mode -eq 'Check') {
  try {
    $main = Get-DesktopMain
    $tree = @(Get-DesktopTree ([int]$main.pid) ([string]$main.exePath))
    [pscustomobject]@{
      pid = [int] $main.pid
      exePath = [string] $main.exePath
      treeCount = $tree.Count
    } | ConvertTo-Json -Compress
    exit 0
  } catch {
    # Distinguishable, fixed error codes: never echo private paths or args.
    $reason = [string] $_.Exception.Message
    if ($reason -eq 'desktop-process-not-running') { exit 10 }
    if ($reason -eq 'desktop-root-process-not-unique') { exit 11 }
    if ($reason -eq 'desktop-bundle-not-found') { exit 12 }
    exit 13
  }
}

if ([string]::IsNullOrWhiteSpace($TicketPath) -or -not [IO.Path]::IsPathRooted($TicketPath)) {
  exit 4
}

try {
  $ticket = Get-Content -LiteralPath $TicketPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($ticket.phase -ne 'armed' -or $ticket.version -ne 1 -or
      $ticket.requestId -notmatch '^[0-9a-f-]{36}$' -or
      $ticket.oldMainPid -le 0 -or
      [string]::IsNullOrWhiteSpace($ticket.exePath) -or
      $ticket.expiresAt -lt [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) {
    throw 'restart-ticket-invalid'
  }
  $original = Get-DesktopMain
  if ($original.pid -ne [int]$ticket.oldMainPid -or
      $original.exePath -ne [string]$ticket.exePath) {
    throw 'desktop-process-changed'
  }

  # Give the incoming /restart handler time to persist its getUpdates cursor,
  # after the WeChat "正在重启" acknowledgement has been sent.
  Start-Sleep -Milliseconds 1500
  $original = Get-DesktopMain
  if ($original.pid -ne [int]$ticket.oldMainPid) { throw 'desktop-process-changed' }

  # Stop only the verified Desktop executable process tree, deepest workers
  # first; otherwise orphaned Electron workers can be mistaken for a second
  # root when the new main process starts. Never use taskkill /T: that could
  # terminate this separate watchdog along with the Desktop process.
  $tree = @(Get-DesktopTree ([int]$ticket.oldMainPid) ([string]$ticket.exePath))
  foreach ($entry in $tree) {
    $current = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $entry.pid)
    if (-not $current) { continue }
    if ($current.ExecutablePath -ne [string]$ticket.exePath -or
        [int]$current.ParentProcessId -ne $entry.parentPid) {
      throw 'desktop-process-changed'
    }
    try {
      Stop-Process -Id $entry.pid -Force -ErrorAction Stop
    } catch {
      # Child workers can exit between the CIM probe and Stop-Process.
      # Only ignore the error if the exact PID has already disappeared.
      if (Get-Process -Id $entry.pid -ErrorAction SilentlyContinue) {
        throw 'desktop-process-stop-failed'
      }
    }
  }
  $stopped = $false
  for ($i = 0; $i -lt 60; $i++) {
    if (-not (Get-Process -Id ([int]$ticket.oldMainPid) -ErrorAction SilentlyContinue)) {
      $stopped = $true
      break
    }
    Start-Sleep -Milliseconds 500
  }
  if (-not $stopped) { throw 'desktop-main-did-not-stop' }

  $exe = [string] $ticket.exePath
  $newMainPid = 0
  $oldTreePids = @($tree | ForEach-Object { [int] $_.pid })
  # The packaged Desktop may relaunch automatically during shutdown.
  # Reuse the genuine new root rather than launching a second instance.
  for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $candidate = Get-DesktopMain
      if ($candidate.pid -ne [int]$ticket.oldMainPid -and
          $candidate.exePath -eq $exe -and
          $oldTreePids -notcontains [int]$candidate.pid) {
        $newMainPid = $candidate.pid
        break
      }
    } catch { }
  }
  if ($newMainPid -le 0) {
    Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe) | Out-Null
  }
  for ($i = 0; $i -lt 150 -and $newMainPid -le 0; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $main = Get-DesktopMain
      if ($main.pid -ne [int]$ticket.oldMainPid -and $main.exePath -eq $exe -and
          $oldTreePids -notcontains [int]$main.pid) {
        $newMainPid = $main.pid
        break
      }
    } catch { }
  }
  if ($newMainPid -le 0) { throw 'desktop-new-main-not-detected' }
  $ticket.phase = 'restarted'
  $ticket.newMainPid = [int]$newMainPid
  $ticket.finishedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  Write-Ticket $ticket
  exit 0
} catch {
  try {
    $ticket = Get-Content -LiteralPath $TicketPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($ticket.phase -eq 'armed') {
      $oldAlive = [bool](Get-Process -Id ([int]$ticket.oldMainPid) -ErrorAction SilentlyContinue)
      $replacement = $null
      if (-not $oldAlive) {
        try { $replacement = Get-DesktopMain } catch { }
      }
      if ($replacement -and $replacement.pid -ne [int]$ticket.oldMainPid -and
          $replacement.exePath -eq [string]$ticket.exePath) {
        # A new Desktop is already running; the Host will independently
        # verify connectivity before it emits its completion message.
        $ticket.phase = 'restarted'
        $ticket.newMainPid = [int]$replacement.pid
      } else {
        $ticket.phase = 'failed'
        $ticket.failureCode = 'desktop-restart-failed'
      }
      $ticket.finishedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      Write-Ticket $ticket
    }
  } catch { }
  exit 5
}
