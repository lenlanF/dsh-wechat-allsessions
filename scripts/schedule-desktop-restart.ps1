[CmdletBinding()]
param([Parameter(Mandatory=$true)][string] $TicketPath)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Task Scheduler runs this user's interactive-token task outside Electron's
# Windows Job Object. Creating a normal detached child of DSH is insufficient:
# the Desktop shuts down its descendants when the main process exits.
if (-not [IO.Path]::IsPathRooted($TicketPath) -or $TicketPath.Contains('"') -or
    -not (Test-Path -LiteralPath $TicketPath -PathType Leaf)) { exit 20 }
$workerScript = Join-Path $PSScriptRoot 'restart-desktop.ps1'
if (-not (Test-Path -LiteralPath $workerScript -PathType Leaf)) { exit 21 }
try {
  $ticket = Get-Content -LiteralPath $TicketPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($ticket.version -ne 1 -or $ticket.phase -ne 'armed' -or
      $ticket.requestId -notmatch '^[0-9a-f-]{36}$' -or
      $ticket.expiresAt -le [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) {
    exit 22
  }
} catch { exit 22 }

$taskName = 'DSHWechatRestart-' + [string] $ticket.requestId
$created = $false
$acknowledged = $false
try {
  $service = New-Object -ComObject Schedule.Service
  $service.Connect()
  $root = $service.GetFolder('\')
  $definition = $service.NewTask(0)
  $definition.RegistrationInfo.Description = 'One-shot DSH Desktop restart requested by bound WeChat owner'
  $definition.Settings.Enabled = $true
  $definition.Settings.AllowDemandStart = $true
  $definition.Settings.ExecutionTimeLimit = 'PT3M'
  $definition.Settings.DisallowStartIfOnBatteries = $false
  $definition.Settings.StopIfGoingOnBatteries = $false
  $definition.Principal.UserId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $definition.Principal.LogonType = 3  # TASK_LOGON_INTERACTIVE_TOKEN; no elevated rights.
  $definition.Principal.RunLevel = 0   # TASK_RUNLEVEL_LUA; do not escalate.
  $action = $definition.Actions.Create(0)
  $action.Path = (Get-Command powershell.exe -ErrorAction Stop).Source
  $action.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
    $workerScript + '" -Mode Execute -TicketPath "' + $TicketPath + '"'
  $root.RegisterTaskDefinition($taskName, $definition, 2, $null, $null, 3, $null) | Out-Null
  $created = $true
  $root.GetTask($taskName).Run($null) | Out-Null

  # Do not report successful launch just because Task Scheduler accepted Run.
  # Require an actual independent worker to update the same durable ticket.
  for ($i = 0; $i -lt 70; $i++) {
    Start-Sleep -Milliseconds 200
    $current = Get-Content -LiteralPath $TicketPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($current.requestId -ne $ticket.requestId) { throw 'restart-ticket-replaced' }
    if (@('executing','restarted','notified') -contains [string] $current.phase) {
      $acknowledged = $true
      [pscustomobject]@{ workerStarted = $true } | ConvertTo-Json -Compress
      break
    }
    if (@('failed','cancelled','timed-out') -contains [string] $current.phase) {
      throw 'restart-worker-failed-before-start'
    }
  }
  if (-not $acknowledged) { throw 'restart-worker-start-timeout' }
  exit 0
} catch {
  # If it never started, cancel the request. An unexpectedly late worker must
  # see phase != armed and is forbidden to stop any process.
  if (-not $acknowledged) {
    try {
      $current = Get-Content -LiteralPath $TicketPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($current.requestId -eq $ticket.requestId -and $current.phase -eq 'armed') {
        $current.phase = 'failed'
        $current.failureCode = 'restart-worker-not-started'
        $current.finishedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $tmp = $TicketPath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
        $backup = $TicketPath + '.' + [guid]::NewGuid().ToString('N') + '.bak'
        try {
          [IO.File]::WriteAllText($tmp, ($current | ConvertTo-Json -Depth 5 -Compress),
            (New-Object Text.UTF8Encoding($false)))
          [IO.File]::Replace($tmp, $TicketPath, $backup)
        } finally {
          Remove-Item -LiteralPath $tmp,$backup -Force -ErrorAction SilentlyContinue
        }
      }
    } catch { }
    if ($created) {
      try { $root.DeleteTask($taskName, 0) } catch { }
    }
  }
  exit 23
}
