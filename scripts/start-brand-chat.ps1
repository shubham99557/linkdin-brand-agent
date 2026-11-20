# Starts the ActTrident brand research chat: Claude Code running on THIS PC, shown in the browser at
# https://claude.ai/code through Remote Control. Remote Control makes outbound connections only; nothing on this PC
# becomes reachable from outside, and the code and data stay here.
#
# Least privilege: the chat sessions may use exactly three things: the read-only connector tool get_brand_brain,
# web search and web fetch. Shell, file reading and file changes are denied by a settings file kept outside the chat
# folder (sessions cannot change it: they have no file-writing tools). Approving, publishing, STOP and Brand Brain
# changes are not reachable at all: the connector key works in one read-only database function (P11-01a).
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts\start-brand-chat.ps1 [-Environment development|staging] [-SetupOnly]
param([ValidateSet("development", "staging")][string]$Environment = "development", [switch]$SetupOnly)
$ErrorActionPreference = "Stop"
$Host.UI.RawUI.WindowTitle = "ActTrident brand chat - keep this window open while you chat"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$workspace = Join-Path $env:USERPROFILE "acttrident-brand-chat"
$configDir = Join-Path $env:LOCALAPPDATA "ActTrident\brand-chat"
$settings = Join-Path $configDir "settings.json"
$node = (Get-Command node).Source
$claude = (Get-Command claude).Source
$bridge = Join-Path $repo "services\api\src\connector-bridge.ts"
$keyFile = Join-Path $repo "secrets\claude-connector-$Environment.json"

function Stop-WithMessage($text) {
  Write-Host "  $text" -ForegroundColor Red
  if (-not $SetupOnly) { Read-Host "  Press Enter to close" }
  exit 1
}

# 1. The chat folder and its instructions (refreshed from the project each time).
New-Item -ItemType Directory -Force $workspace, $configDir | Out-Null
Copy-Item (Join-Path $repo "tools\claude-brand-chat\CLAUDE.md") (Join-Path $workspace "CLAUDE.md") -Force

# 2. The permission policy for chat sessions (deny wins over any allow). The chat reads untrusted web pages, so the
#    owner's personal connectors (mail, calendar, files, meetings) are kept out of its reach; any other tool asks first.
$personal = @("Gmail", "Google_Calendar", "Google_Drive", "Google_Docs", "Google_Sheets", "Google_Slides", "Meetings",
  "Claude_Data", "Claude_Docs", "Box", "Atlassian", "Asana", "Notion", "Slack", "HubSpot", "Intercom", "Linear", "monday_com",
  "Canva", "Figma", "Framer", "UXKIN") | ForEach-Object { "mcp__claude_ai_$_" }
$policy = [ordered]@{
  permissions = [ordered]@{
    allow = @("mcp__acttrident-brand-brain__get_brand_brain", "WebSearch", "WebFetch")
    deny  = @("Bash", "PowerShell", "Read", "Glob", "Grep", "Edit", "Write", "NotebookEdit",
      # Claude Code extras a research chat does not need (scheduled/cloud agents, workflows, publishing, worktrees).
      "CronCreate", "CronDelete", "RemoteTrigger", "ScheduleWakeup", "Workflow", "PublishPlugin", "ShareOnboardingGuide",
      "DesignSync", "EnterWorktree", "ExitWorktree") + $personal
  }
}
[IO.File]::WriteAllText($settings, ($policy | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))

# 3. The connector, registered for the chat folder only (local scope).
# (Windows PowerShell turns a program's error text into a terminating error under Stop, so relax it here.)
Push-Location $workspace
$ErrorActionPreference = "Continue"
try {
  & $claude mcp remove acttrident-brand-brain --scope local 2>&1 | Out-Null   # nothing to remove the first time
  $added = & $claude mcp add acttrident-brand-brain --scope local -- $node $bridge --environment $Environment 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { Stop-WithMessage "Could not register the connector with Claude Code: $added" }
} finally {
  $ErrorActionPreference = "Stop"
  Pop-Location
}

# 4. Pre-checks: a connector key for this environment that has not expired.
if (-not (Test-Path $keyFile)) {
  Stop-WithMessage "No connector key for $Environment. In the dashboard: System health -> Claude connector -> Create key (needs LBE_CONNECTOR=on)."
}
$expires = [DateTimeOffset]::Parse((Get-Content $keyFile -Raw | ConvertFrom-Json).expires_at)
if ($expires -lt [DateTimeOffset]::UtcNow) {
  Stop-WithMessage "The $Environment connector key expired at $($expires.ToLocalTime()). Create a new one in the dashboard (System health -> Claude connector)."
}

Write-Host ""
Write-Host "  ActTrident brand chat ($Environment Brand Brain) is set up." -ForegroundColor Cyan
Write-Host "  Chat folder:   $workspace"
Write-Host "  Allowed tools: get_brand_brain (read-only), web search, web fetch. No shell, no file access."
Write-Host "  Connector key valid until $($expires.ToLocalTime())."
if ($SetupOnly) { exit 0 }

# 5. Remote Control: keep this window open; open https://claude.ai/code in your browser and pick the session.
Write-Host ""
Write-Host "  Starting Remote Control. Then open https://claude.ai/code in your browser and pick 'ActTrident brand chat'." -ForegroundColor White
Write-Host "  If it asks whether to trust the folder, answer yes. If it says Remote Control is turned off for your"
Write-Host "  organization: claude.ai -> Admin settings -> Claude Code -> turn on Remote Control, then run this again."
Write-Host ""
Set-Location $workspace
# If Remote Control is switched off for the organization (Team plan default), it exits at once with a message. Retry
# every 30 seconds, so it starts by itself as soon as the owner switches it on.
for ($attempt = 1; $attempt -le 120; $attempt++) {
  $started = Get-Date
  & $claude remote-control --name "ActTrident brand chat" --settings $settings
  if ($LASTEXITCODE -eq 0 -or ((Get-Date) - $started).TotalSeconds -gt 60) { break }   # it ran, then was stopped
  Write-Host ""
  Write-Host "  Remote Control did not start (message above). If it says 'disabled by your organization's policy':" -ForegroundColor Yellow
  Write-Host "  claude.ai -> Admin settings -> Claude Code -> turn on Remote Control. Trying again in 30 seconds..." -ForegroundColor Yellow
  Start-Sleep -Seconds 30
}
Write-Host ""
Read-Host "  Remote Control stopped. Press Enter to close"
