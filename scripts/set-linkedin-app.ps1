# Puts the founder LinkedIn app's Client ID and Client Secret into .env.staging (the real system).
# Default: nothing to type. The owner clicks LinkedIn's own "copy" buttons on the app's Auth tab and this window picks
# each value up from the clipboard. The secret is never shown, is written only to .env.staging (git-ignored, never
# backed up), and the clipboard is cleared afterwards. Nothing is sent to LinkedIn from here; this script does not
# drive the LinkedIn website, it only opens the page in the owner's browser.
# Usage (Claude opens this window for you):
#   powershell -ExecutionPolicy Bypass -File scripts\set-linkedin-app.ps1 [-Done <marker file>] [-Type]
#   -Type: type or paste the values at hidden prompts instead of using the clipboard.
param([string]$Done = "", [switch]$Type)
$ErrorActionPreference = "Stop"
$Host.UI.RawUI.WindowTitle = "ActTrident LinkedIn Branding - LinkedIn app details"
Set-Location (Join-Path $PSScriptRoot "..")
function Write-Done($text) { if ($Done) { Set-Content -Path $Done -Value $text -Encoding ascii } }
$Redirect = "https://localhost:8443/api/oauth/linkedin/callback"
$EnvFile = Join-Path (Get-Location) ".env.staging"
Add-Type -AssemblyName System.Windows.Forms

function Test-Id($v) { return ($v -match '^[A-Za-z0-9]{8,40}$') }
function Test-Secret($v) { return ($v.Length -ge 8 -and $v.Length -le 200 -and $v -notmatch '[\s"''`#\\]') }
function Get-ClipText { try { return [string][System.Windows.Forms.Clipboard]::GetText() } catch { return "" } }
function Clear-Clip { try { [System.Windows.Forms.Clipboard]::Clear() } catch { } }

# Waits until the clipboard changes to a value that passes $valid (and is not $notThis). Never prints the value.
function Wait-Clipboard([scriptblock]$valid, [string]$notThis, [int]$minutes = 15) {
  $deadline = (Get-Date).AddMinutes($minutes)
  $last = Get-ClipText
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 400
    $now = Get-ClipText
    if ($now -ne $last) {
      $last = $now
      $v = $now.Trim()
      if ($v -and $v -ne $notThis -and (& $valid $v)) { return $v }
      if ($v) { Write-Host "    That copied text is not the expected value. Use the copy button next to it on the Auth tab." -ForegroundColor Yellow }
    }
  }
  return $null
}

function Read-Hidden($label, [scriptblock]$valid) {
  for ($i = 1; $i -le 3; $i++) {
    $s = Read-Host "  $label (hidden; paste with right-click or Ctrl+V)" -AsSecureString
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { $v = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
    if (& $valid $v) { return $v }
    $v = $null
    Write-Host "  That does not look right. Try again." -ForegroundColor Yellow
  }
  return $null
}

function Set-EnvValues([hashtable]$values) {
  $text = [IO.File]::ReadAllText($EnvFile)
  $nl = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
  $lines = [Collections.Generic.List[string]]($text -split "\r?\n")
  foreach ($key in $values.Keys) {
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($lines[$i] -match "^$key=") { $lines[$i] = "$key=$($values[$key])"; $found = $true }
    }
    if (-not $found) { $lines.Insert([Math]::Max(0, $lines.Count - 1), "$key=$($values[$key])") }
  }
  # Same file, same permissions; UTF-8 without a byte-order mark, original line endings.
  [IO.File]::WriteAllText($EnvFile, ($lines -join $nl), (New-Object Text.UTF8Encoding $false))
}

Write-Host ""
Write-Host "  ActTrident LinkedIn Branding - founder LinkedIn app (real system)" -ForegroundColor Cyan
Write-Host "  ----------------------------------------------------------------"
Write-Host "  Nothing is sent to LinkedIn from this window. Posting stays OFF."
Write-Host ""
if (-not (Test-Path $EnvFile)) { Write-Host "  .env.staging is missing - tell Claude." -ForegroundColor Red; Write-Done "failed: no .env.staging"; Read-Host "  Press Enter to close"; exit 1 }

Start-Process "https://www.linkedin.com/developers/apps"
try { [System.Windows.Forms.Clipboard]::SetText($Redirect) } catch { }
Write-Host "  1. In the browser: log in to LinkedIn, open your FOUNDER app, then the 'Auth' tab." -ForegroundColor White
Write-Host "     If 'Authorized redirect URLs' does not list $Redirect"
Write-Host "     click the pencil, 'Add redirect URL', and paste (Ctrl+V): it is already on your clipboard."
Write-Host ""

if ($Type) {
  $id = Read-Hidden "Client ID" ${function:Test-Id}
  $secret = if ($id) { Read-Hidden "Primary Client Secret" ${function:Test-Secret} } else { $null }
} else {
  Write-Host "  2. Click the COPY button next to 'Client ID'..." -ForegroundColor White
  $id = Wait-Clipboard ${function:Test-Id} ""
  if ($id) {
    Write-Host "     Client ID received." -ForegroundColor Green
    Write-Host "  3. Click the COPY button next to 'Primary Client Secret'..." -ForegroundColor White
    $secret = Wait-Clipboard ${function:Test-Secret} $id
    Clear-Clip
    if ($secret) { Write-Host "     Client Secret received (not shown). Clipboard cleared." -ForegroundColor Green }
  }
}
if (-not $id -or -not $secret) {
  Write-Host "  Nothing was saved (timed out or cancelled). Tell Claude, or run this again." -ForegroundColor Yellow
  Write-Done "failed: founder credentials not received"; Read-Host "  Press Enter to close"; exit 1
}

try {
  Set-EnvValues @{ "LBE_LINKEDIN_FOUNDER_CLIENT_ID" = $id; "LBE_LINKEDIN_FOUNDER_CLIENT_SECRET" = $secret; "LBE_LINKEDIN_REDIRECT_URI" = $Redirect }
  $ok = $true
} catch {
  $ok = $false
  Write-Host "  Could not update .env.staging: $($_.Exception.Message)" -ForegroundColor Red
} finally {
  $secret = $null
}
Write-Host ""
if ($ok) {
  Write-Host "  Saved to .env.staging (this PC only). Claude takes it from here; you can close this window." -ForegroundColor Green
  Write-Host "  (The company page needs a separate app approved for the Community Management API; it stays on mock until then.)"
  Write-Done "ok founder=yes"
} else {
  Write-Done "failed: could not write .env.staging"
}
Start-Sleep -Seconds 8
