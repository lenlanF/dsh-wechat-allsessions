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
  $candidates = @(Get-CimInstance Win32_Process -Filter "Name = 'DeepSeek Harness.exe'" |
    Where-Object {
      $_.ExecutablePath -and
      [IO.Path]::GetFileName($_.ExecutablePath) -eq 'DeepSeek Harness.exe' -and
      $_.CommandLine -notmatch '(?i)--type=|--expose-internals'
    })
  if ($candidates.Count -ne 1) { throw 'desktop-main-process-not-unique' }
  $item = $candidates[0]
  $folder = Split-Path -Parent $item.ExecutablePath
  if (-not (Test-Path -LiteralPath (Join-Path $folder 'resources\app.asar') -PathType Leaf)) {
    throw 'desktop-bundle-not-found'
  }
  return [pscustomobject]@{
    pid = [int] $item.ProcessId
    exePath = [string] $item.ExecutablePath
  }
}

function Write-Ticket([object] $item) {
  $json = $item | ConvertTo-Json -Depth 5 -Compress
  $tmp = $TicketPath + '.worker-' + [guid]::NewGuid().ToString('N') + '.tmp'
  try {
    [IO.File]::WriteAllText($tmp, $json, (New-Object Text.UTF8Encoding($false)))
    [IO.File]::Replace($tmp, $TicketPath, $null)
  } finally {
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
  }
}

if ($Mode -eq 'Check') {
  try {
    Get-DesktopMain | ConvertTo-Json -Compress
    exit 0
  } catch {
    [Console]::Error.WriteLine('desktop-restart-unavailable')
    exit 3
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

  # The installed production build exposes Electron relaunch only inside its
  # main process (not over a safe plugin API). Never use taskkill /T: this
  # detached watchdog is a descendant and would kill itself with the tree.
  Stop-Process -Id ([int]$ticket.oldMainPid) -Force -ErrorAction Stop
  $stopped = $false
  for ($i = 0; $i -lt 60; $i++) {
    if (-not (Get-Process -Id ([int]$ticket.oldMainPid) -ErrorAction SilentlyContinue)) {
      $stopped = $true
      break
    }
    Start-Sleep -Milliseconds 500
  }
  if (-not $stopped) { throw 'desktop-main-did-not-stop' }

  $exe = [string]$ticket.exePath
  Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe) | Out-Null

  $newMainPid = 0
  for ($i = 0; $i -lt 150; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $main = Get-DesktopMain
      if ($main.pid -ne [int]$ticket.oldMainPid -and $main.exePath -eq $exe) {
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
      $ticket.phase = 'failed'
      # Do not persist raw exceptions, process arguments or private paths.
      $ticket.failureCode = 'desktop-restart-failed'
      $ticket.finishedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      Write-Ticket $ticket
    }
  } catch { }
  exit 5
}
