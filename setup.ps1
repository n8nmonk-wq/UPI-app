# One-shot Windows setup for YOUPI PG + the one-page Rupee Store.
# Installs, asks for your UPI ID, starts the gateway, connects the store and opens it.
# 'Continue': Windows PowerShell 5.1 treats Node's stderr warnings as errors under 'Stop'.
$ErrorActionPreference = 'Continue'
$repo = 'https://github.com/bhaviksiddhapura/UPI-app.git'
$branch = 'claude/gifted-ritchie-m9zzjp'
$dir = Join-Path $HOME 'UPI-app'

function Test-Up($url) {
  try { Invoke-RestMethod $url -TimeoutSec 2 | Out-Null; return $true } catch { return $false }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js is not installed. Installing with winget...'
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

# 1. Get or update the code
if (Test-Path (Join-Path $dir '.git')) {
  Set-Location $dir
  git pull origin $branch
} elseif (Test-Path (Join-Path $dir 'package.json')) {
  Set-Location $dir
} elseif (Get-Command git -ErrorAction SilentlyContinue) {
  git clone -b $branch $repo $dir
  Set-Location $dir
} else {
  Write-Host 'Git not found, downloading the project as a zip...'
  $zip = Join-Path $env:TEMP 'upi-app.zip'
  $tmp = Join-Path $env:TEMP 'upi-app-extract'
  Invoke-WebRequest "https://github.com/bhaviksiddhapura/UPI-app/archive/refs/heads/$branch.zip" -OutFile $zip
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  Expand-Archive $zip -DestinationPath $tmp
  Move-Item (Get-ChildItem $tmp | Select-Object -First 1).FullName $dir
  Set-Location $dir
}

# 2. Install
npm install
if ($LASTEXITCODE -ne 0 -or -not (Test-Path 'node_modules\@youpi\common')) {
  Write-Host "`nnpm install did not finish (workspace packages are not linked). Scroll up for the first npm error and send it over." -ForegroundColor Red
  return
}
if (-not (Test-Path '.env')) { Copy-Item '.env.example' '.env' }

# 3. Your receiving UPI ID and (optionally) the online store on Vercel
$credFile = 'data\.secrets\rupee_store.json'
$upi = $null
$storeArgs = @()
if (-not (Test-Path $credFile)) {
  $upi = Read-Host 'Your UPI ID that should receive the money (e.g. yourname@okhdfcbank)'
  $payee = Read-Host 'Name shown to payers (your name or shop name)'
  $storeUrl = Read-Host 'Online store address, e.g. https://your-project.vercel.app (press Enter to run the store only on this PC)'
  if ($storeUrl) {
    $storeToken = Read-Host 'STORE_ADMIN_TOKEN of the online store (from whoever deployed it)'
    $storeArgs = @('--store-url', $storeUrl.Trim(), '--admin-token', $storeToken.Trim())
  }
  # Brings .env up to the hardened settings before the gateway starts (no gateway needed for this part).
  node scripts/configure-store.js --upi $upi --name $payee @storeArgs | Out-Null
}

# 4. Start the gateway in its own window
if (Test-Up 'http://localhost:6100/health') {
  Write-Host 'A gateway is already running. Close that window (Ctrl+C) so it restarts with the new settings, then press Enter.' -ForegroundColor Yellow
  Read-Host | Out-Null
}
Start-Process powershell -ArgumentList '-NoExit', '-Command', "Set-Location '$dir'; npm run dev"
Write-Host 'Starting the gateway...'
$ok = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep 1
  if ((Test-Up 'http://localhost:6100/health') -and (Test-Up 'http://localhost:4000/health')) { $ok = $true; break }
}
if (-not $ok) { Write-Host 'The gateway did not come up in 60 seconds. Check the other window for errors.' -ForegroundColor Red; return }

# 5. Connect the store to the gateway (UPI ID, webhook, fresh merchant key + webhook secret)
if ($upi) {
  node scripts/configure-store.js --upi $upi --name $payee @storeArgs
  if ($LASTEXITCODE -ne 0) { Write-Host 'Connecting the store failed, see the message above.' -ForegroundColor Red; return }
}

# 6. Public address for customers and the phone (needed for the online store and for pairing)
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
  Write-Host 'Installing cloudflared (gives this PC a secure public address)...'
  winget install -e --id Cloudflare.cloudflared --accept-source-agreements --accept-package-agreements
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
Start-Process powershell -ArgumentList '-NoExit', '-Command', "Set-Location '$dir'; npm run observer:tunnel"

Start-Process 'http://localhost:4000'
Start-Process 'http://localhost:6001'
Write-Host ''
Write-Host 'Store:        http://localhost:4000' -ForegroundColor Green
Write-Host 'Admin panel:  http://localhost:6001' -ForegroundColor Green
Write-Host ''
Write-Host 'Keep the two new windows (gateway and tunnel) open while you accept payments.'
Write-Host 'Before a live payment works you still need (see HANDOFF.md, Part B):'
Write-Host '  1. Admin panel > Developer & Infrastructure Hub > Gmail & WhatsApp Protocols: link WhatsApp (customer OTP).'
Write-Host '  2. Install apps\android-observer-app\youpi-sms-gateway.apk on the phone that gets your bank alerts and'
Write-Host '     scan the QR in data\observer-pairing.html (written by the tunnel window).'
