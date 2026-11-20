# Puts the LinkedIn app credentials into .env.staging (the real system), asking for them in this window.
# The client secret is typed hidden, written only to .env.staging (git-ignored, never backed up), and never shown
# or logged. Nothing is sent to LinkedIn here. The staging server picks the values up on its next start.
# Usage (Claude opens this window for you):
#   powershell -ExecutionPolicy Bypass -File scripts\set-linkedin-app.ps1 [-Done <marker file>]
param([string]$Done = "")
$ErrorActionPreference = "Stop"
$Host.UI.RawUI.WindowTitle = "ActTrident LinkedIn Branding - LinkedIn app details"
Set-Location (Join-Path $PSScriptRoot "..")
function Write-Done($text) { if ($Done) { Set-Content -Path $Done -Value $text -Encoding ascii } }
$Redirect = "https://localhost:8443/api/oauth/linkedin/callback"
$EnvFile = Join-Path (Get-Location) ".env.staging"

function Read-YesNo($question) {
  do { $a = (Read-Host "  $question [y/n]").Trim().ToLower() } while ($a -ne "y" -and $a -ne "n")
  return ($a -eq "y")
}
function Test-Value($v) { return ($v.Length -ge 8 -and $v.Length -le 200 -and $v -notmatch '[\s"''`#\\]') }
function Read-ClientId($label) {
  for ($i = 1; $i -le 3; $i++) {
    $v = (Read-Host "  $label Client ID (Auth tab, 'Client ID')").Trim()
    if (Test-Value $v) { return $v }
    Write-Host "  That does not look like a Client ID (8-200 characters, no spaces or quotes). Try again." -ForegroundColor Yellow
  }
  return $null
}
function Read-Secret($label) {
  for ($i = 1; $i -le 3; $i++) {
    $s = Read-Host "  $label Primary Client Secret (hidden while you type)" -AsSecureString
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { $v = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
    if (Test-Value $v) { return $v }
    $v = $null
    Write-Host "  That does not look like a client secret (8-200 characters, no spaces or quotes). Try again." -ForegroundColor Yellow
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
Write-Host "  ActTrident LinkedIn Branding - LinkedIn app details (real system, staging)" -ForegroundColor Cyan
Write-Host "  ------------------------------------------------------------------------"
Write-Host "  Open https://www.linkedin.com/developers/apps -> your FOUNDER app."
Write-Host "  Nothing is sent to LinkedIn from this window. Posting stays OFF."
Write-Host ""
if (-not (Test-Path $EnvFile)) { Write-Host "  .env.staging is missing - tell Claude." -ForegroundColor Red; Write-Done "failed: no .env.staging"; Read-Host "  Press Enter to close"; exit 1 }

Write-Host "  Check the founder app first:" -ForegroundColor Cyan
Write-Host "   - Products tab: 'Share on LinkedIn' and 'Sign In with LinkedIn using OpenID Connect' (nothing else)"
Write-Host "   - Auth tab -> Authorized redirect URLs: exactly"
Write-Host "       $Redirect" -ForegroundColor White
Write-Host ""
$products = Read-YesNo "Are both products added (status 'Added' or approved)?"
$redirectOk = Read-YesNo "Did LinkedIn accept that redirect URL (it is listed in the Auth tab)?"
if (-not $redirectOk) {
  Write-Host "  Add the redirect URL first (Auth tab -> pencil icon -> Add redirect URL), then run this again." -ForegroundColor Yellow
  Write-Done "failed: redirect url not added (products=$products)"; Read-Host "  Press Enter to close"; exit 1
}

$id = Read-ClientId "Founder app"
$secret = if ($id) { Read-Secret "Founder app" } else { $null }
if (-not $id -or -not $secret) { Write-Done "failed: founder credentials not entered"; Read-Host "  Press Enter to close"; exit 1 }
$values = @{ "LBE_LINKEDIN_FOUNDER_CLIENT_ID" = $id; "LBE_LINKEDIN_FOUNDER_CLIENT_SECRET" = $secret; "LBE_LINKEDIN_REDIRECT_URI" = $Redirect }

Write-Host ""
Write-Host "  Company page: this needs a SEPARATE app with only the 'Community Management API', approved by LinkedIn." -ForegroundColor Cyan
$company = Read-YesNo "Has LinkedIn already APPROVED the Community Management API for that separate app?"
if ($company) {
  $cid = Read-ClientId "Company app"
  $csecret = if ($cid) { Read-Secret "Company app" } else { $null }
  if ($cid -and $csecret) { $values["LBE_LINKEDIN_COMPANY_CLIENT_ID"] = $cid; $values["LBE_LINKEDIN_COMPANY_CLIENT_SECRET"] = $csecret }
  else { $company = $false; Write-Host "  Skipped the company app; the company page stays on mock publishing." -ForegroundColor Yellow }
} else {
  Write-Host "  OK - the company page stays on mock publishing until LinkedIn approves it."
}

try {
  Set-EnvValues $values
  $ok = $true
} catch {
  $ok = $false
  Write-Host "  Could not update .env.staging: $($_.Exception.Message)" -ForegroundColor Red
} finally {
  $secret = $null; $csecret = $null; $values = $null
}
Write-Host ""
if ($ok) {
  Write-Host "  Saved to .env.staging (this PC only). The secret was not shown or logged." -ForegroundColor Green
  Write-Host "  LIVE posting is still OFF. Claude will now restart the real system and run the pre-flight check."
  Write-Host "  You can close this window."
  Write-Done "ok founder=yes company=$(if ($company) {'yes'} else {'no'}) products=$(if ($products) {'yes'} else {'no'}) redirect=yes"
} else {
  Write-Done "failed: could not write .env.staging"
}
Read-Host "  Press Enter to close"
