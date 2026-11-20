# Creates the owner's admin login in the STAGING (real) database, asking for name, email and password in this
# window. The password is typed hidden, kept only in memory for the one command, and never shown or logged.
# The staging server must be stopped while this runs (the embedded database allows one program at a time).
# Usage (Claude opens this window for you):
#   powershell -ExecutionPolicy Bypass -File scripts\create-staging-admin.ps1 -Founder <account-id> -Company <account-id> [-Done <marker file>]
param(
  [Parameter(Mandatory = $true)][string]$Founder,
  [Parameter(Mandatory = $true)][string]$Company,
  [string]$Done = ""
)
$ErrorActionPreference = "Stop"
$Host.UI.RawUI.WindowTitle = "ActTrident LinkedIn Branding - create your login"
Set-Location (Join-Path $PSScriptRoot "..")
function Write-Done($text) { if ($Done) { Set-Content -Path $Done -Value $text -Encoding ascii } }

Write-Host ""
Write-Host "  ActTrident LinkedIn Branding - your administrator login (real system, staging)" -ForegroundColor Cyan
Write-Host "  -----------------------------------------------------------------------------"
Write-Host "  You will sign in with this email and password at https://localhost:8443"
Write-Host "  The password is hidden while you type. Use at least 12 characters."
Write-Host ""

$client = New-Object System.Net.Sockets.TcpClient
try { $client.Connect("127.0.0.1", 8443); $running = $true } catch { $running = $false } finally { $client.Dispose() }
if ($running) {
  Write-Host "  The staging server is running. Stop it first (Ctrl+C in its window), then run this again." -ForegroundColor Red
  Write-Done "failed: server running"; Read-Host "  Press Enter to close"; exit 1
}

do { $name = (Read-Host "  Your full name (shown on approvals)").Trim() } while ($name.Length -lt 2)
do { $email = (Read-Host "  Your email (used to sign in)").Trim() } while ($email -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$')

$plain = $null
for ($try = 1; $try -le 3; $try++) {
  $p1 = Read-Host "  Choose a password (12+ characters)" -AsSecureString
  $p2 = Read-Host "  Type the password again" -AsSecureString
  $b1 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($p1)
  $b2 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($p2)
  try {
    $s1 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b1)
    $s2 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b2)
    if ($s1 -ne $s2) { Write-Host "  The two passwords differ. Try again." -ForegroundColor Yellow }
    elseif ($s1.Length -lt 12) { Write-Host "  Too short: use at least 12 characters." -ForegroundColor Yellow }
    else { $plain = $s1 }
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b1); [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b2)
    $s1 = $null; $s2 = $null
  }
  if ($plain) { break }
}
if (-not $plain) { Write-Done "failed: no password"; Read-Host "  Press Enter to close"; exit 1 }

Write-Host ""
Write-Host "  Creating your login..." -ForegroundColor Cyan
$env:LBE_NEW_USER_PASSWORD = $plain
try {
  & node scripts/run-staging.mjs services/api/src/cli/create-user.ts --email $email --name $name --role admin --approver-for $Founder --approver-for $Company
  $ok = ($LASTEXITCODE -eq 0)
} finally {
  Remove-Item Env:LBE_NEW_USER_PASSWORD -ErrorAction SilentlyContinue
  $plain = $null
}
Write-Host ""
if ($ok) {
  Write-Host "  Done. Your login is ready: $email" -ForegroundColor Green
  Write-Host "  You approve posts for both the company page and the founder profile (change this later on the Users page)."
  Write-Host "  Claude will now start the system and open it in your browser. You can close this window."
  Write-Done "ok"
} else {
  Write-Host "  That did not work (see the message above). Nothing was changed. Tell Claude what it says." -ForegroundColor Red
  Write-Done "failed: create-user"
}
Read-Host "  Press Enter to close"
