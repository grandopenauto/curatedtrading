param(
  [string]$RepoCommit = 'main'
)

$ErrorActionPreference = 'Stop'
$Root = 'C:\HDP\CuratedTrading\ebay'
$EnvPath = Join-Path $Root '.env'
$ServiceName = 'HDP-CuratedTrading-eBay'
$IisSite = 'HDP-CuratedTradingAPI'
$IisRoot = 'C:\inetpub\wwwroot\HDP-CuratedTradingAPIProxy'
$ApiHost = 'api.curatedtrading.com'
$VpsIp = '74.208.77.37'
$RepoBase = "https://raw.githubusercontent.com/grandopenauto/curatedtrading/$RepoCommit/server/ebay"

function Upsert-Env([string]$Key, [string]$Value) {
  $lines = if (Test-Path $EnvPath) { @(Get-Content $EnvPath) } else { @() }
  $found = $false
  $out = foreach ($line in $lines) {
    if ($line -match ('^\s*' + [regex]::Escape($Key) + '\s*=')) {
      $found = $true
      "$Key=$Value"
    } else {
      $line
    }
  }
  if (-not $found) { $out += "$Key=$Value" }
  [IO.File]::WriteAllLines($EnvPath, $out, (New-Object Text.UTF8Encoding($false)))
}

function Env-Key-Present([string]$Key) {
  if (-not (Test-Path $EnvPath)) { return $false }
  return [regex]::IsMatch((Get-Content $EnvPath -Raw), ('(?m)^\s*' + [regex]::Escape($Key) + '\s*=\s*.+$'))
}

function Get-Env-Value([string]$Key) {
  if (-not (Test-Path $EnvPath)) { return $null }
  foreach ($line in Get-Content $EnvPath) {
    if ($line -match ('^\s*' + [regex]::Escape($Key) + '\s*=\s*(.*)$')) {
      return $matches[1].Trim().Trim('"').Trim("'")
    }
  }
  return $null
}

function Get-Public-A([string]$Name) {
  $values = @()
  foreach ($server in @('8.8.8.8','1.1.1.1')) {
    try {
      $values += @(Resolve-DnsName $Name -Type A -Server $server -ErrorAction Stop |
        Where-Object { $_.IPAddress } | Select-Object -ExpandProperty IPAddress)
    } catch {}
  }
  return @($values | Select-Object -Unique)
}

function Write-ProxyConfig([int]$Port, [bool]$RedirectHttps) {
  $rules = @()
  if ($RedirectHttps) {
    $rules += @(
      '        <rule name="RedirectToHttps" stopProcessing="true">',
      '          <match url="(.*)" />',
      '          <conditions><add input="{HTTPS}" pattern="off" ignoreCase="true" /></conditions>',
      '          <action type="Redirect" url="https://{HTTP_HOST}/{R:1}" redirectType="Permanent" appendQueryString="true" />',
      '        </rule>'
    )
  }
  $rules += @(
    '        <rule name="CuratedTradingApiReverseProxy" stopProcessing="true">',
    '          <match url="(.*)" />',
    "          <action type=`"Rewrite`" url=`"http://127.0.0.1:$Port/{R:1}`" appendQueryString=`"true`" />",
    '        </rule>'
  )
  $lines = @(
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<configuration>',
    '  <system.webServer>',
    '    <rewrite>',
    '      <rules>'
  ) + $rules + @(
    '      </rules>',
    '    </rewrite>',
    '  </system.webServer>',
    '</configuration>'
  )
  [IO.File]::WriteAllLines((Join-Path $IisRoot 'web.config'), $lines, (New-Object Text.UTF8Encoding($false)))
}

Write-Output '=== CURATEDTRADING VPS DEPLOY ==='
Write-Output ('REPO_COMMIT=' + $RepoCommit)

if (-not (Test-Path $Root)) { New-Item -ItemType Directory -Path $Root -Force | Out-Null }
if (-not (Test-Path $EnvPath)) { throw '.env is missing; refusing to deploy without existing credentials' }
foreach ($key in @('APP_ID','CERT_ID')) {
  if (-not (Env-Key-Present $key)) { throw "Required production credential key missing: $key" }
}
Write-Output 'CREDENTIAL_KEYS_PRESENT=True'
Write-Output 'SECRET_VALUES_EMITTED=0'

# Choose a local port without disturbing another service. Reuse the configured port only if free.
$existingPort = [int](Get-Env-Value 'PORT')
$portCandidates = @()
if ($existingPort -ge 4318 -and $existingPort -le 4399) { $portCandidates += $existingPort }
$portCandidates += 4318..4325
$portCandidates = @($portCandidates | Select-Object -Unique)
$Port = $null
foreach ($candidate in $portCandidates) {
  $listener = Get-NetTCPConnection -LocalPort $candidate -State Listen -ErrorAction SilentlyContinue
  if (-not $listener) { $Port = $candidate; break }
  if ((Get-Service $ServiceName -ErrorAction SilentlyContinue) -and $candidate -eq $existingPort) {
    $Port = $candidate; break
  }
}
if (-not $Port) { throw 'No free CuratedTrading port found in 4318-4325' }
Write-Output ('SELECTED_PORT=' + $Port)

Upsert-Env 'EBAY_ENV' 'production'
Upsert-Env 'EBAY_MARKETPLACE_ID' 'EBAY_US'
Upsert-Env 'PORT' ([string]$Port)
Upsert-Env 'ALLOWED_ORIGINS' 'https://curatedtrading.com,https://www.curatedtrading.com'
Upsert-Env 'CACHE_SECONDS' '300'
Upsert-Env 'RATE_LIMIT_PER_MINUTE' '90'
Upsert-Env 'CT_EPN_CAMPAIGN_ID' '5339211724'

Write-Output '=== DOWNLOAD + VERIFY ==='
$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$tmpIndex = Join-Path $Root '_index.deploy.js'
$tmpPackage = Join-Path $Root '_package.deploy.json'
Invoke-WebRequest ($RepoBase + '/index.js?v=' + $stamp) -OutFile $tmpIndex -UseBasicParsing -Headers @{'Cache-Control'='no-cache'}
Invoke-WebRequest ($RepoBase + '/package.json?v=' + $stamp) -OutFile $tmpPackage -UseBasicParsing -Headers @{'Cache-Control'='no-cache'}
& node --check $tmpIndex
if ($LASTEXITCODE -ne 0) { throw 'index.js syntax validation failed' }
$idx = Get-Content $tmpIndex -Raw
if ($idx -notmatch "const VERSION = '0\.1\.0'" -or $idx -notmatch 'curatedtrading-ebay-gateway') {
  throw 'Downloaded gateway did not match CuratedTrading v0.1.0'
}

$backupDir = Join-Path $Root 'backups'
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
$backupStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (Test-Path (Join-Path $Root 'index.js')) { Copy-Item (Join-Path $Root 'index.js') (Join-Path $backupDir ("index.js.$backupStamp.bak")) -Force }
if (Test-Path (Join-Path $Root 'package.json')) { Copy-Item (Join-Path $Root 'package.json') (Join-Path $backupDir ("package.json.$backupStamp.bak")) -Force }
Move-Item $tmpIndex (Join-Path $Root 'index.js') -Force
Move-Item $tmpPackage (Join-Path $Root 'package.json') -Force

Push-Location $Root
try {
  & npm install --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install failed exit=$LASTEXITCODE" }
} finally { Pop-Location }

Write-Output '=== SERVICE ==='
$node = (Get-Command node -ErrorAction Stop).Source
$nssm = (Get-Command nssm -ErrorAction Stop).Source
$logs = Join-Path $Root 'logs'
New-Item -ItemType Directory -Path $logs -Force | Out-Null
if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
  & $nssm stop $ServiceName confirm | Out-Null
  Start-Sleep -Seconds 2
  & $nssm set $ServiceName Application $node | Out-Null
  & $nssm set $ServiceName AppParameters 'index.js' | Out-Null
} else {
  & $nssm install $ServiceName $node 'index.js' | Out-Null
}
& $nssm set $ServiceName AppDirectory $Root | Out-Null
& $nssm set $ServiceName AppStdout (Join-Path $logs 'stdout.log') | Out-Null
& $nssm set $ServiceName AppStderr (Join-Path $logs 'stderr.log') | Out-Null
& $nssm set $ServiceName AppRotateFiles 1 | Out-Null
& $nssm set $ServiceName AppRotateBytes 10485760 | Out-Null
& $nssm set $ServiceName Start SERVICE_AUTO_START | Out-Null
& $nssm set $ServiceName AppExit Default Restart | Out-Null
& $nssm start $ServiceName | Out-Null

$health = $null
for ($i=0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 1
  try {
    $health = Invoke-RestMethod ("http://127.0.0.1:$Port/health") -TimeoutSec 5
    if ($health.ok) { break }
  } catch {}
}
if (-not $health -or -not $health.ok) {
  $err = if (Test-Path (Join-Path $logs 'stderr.log')) { Get-Content (Join-Path $logs 'stderr.log') -Tail 60 | Out-String } else { 'no stderr log' }
  throw ('Gateway health failed. ' + $err)
}
Write-Output ('HEALTH_OK=' + $health.ok)
Write-Output ('GATEWAY_VERSION=' + $health.version)
Write-Output ('GATEWAY_ENV=' + $health.environment)

$status = Invoke-RestMethod ("http://127.0.0.1:$Port/api/commerce/ebay/status") -TimeoutSec 30
Write-Output ('TOKEN_OK=' + $status.tokenValid)
$sample = Invoke-RestMethod ("http://127.0.0.1:$Port/api/commerce/curated/search?q=excavator&min_price=5000&limit=4") -TimeoutSec 60
Write-Output ('SAMPLE_COUNT=' + @($sample.items).Count)
Write-Output ('SAMPLE_SOURCE_TOTAL=' + [string]$sample.sourceTotal)
if (@($sample.items).Count -gt 0) {
  $first = @($sample.items)[0]
  Write-Output ('TOP_CURATED_SCORE=' + [string]$first.curatedScore)
  Write-Output ('TOP_CURATED_LANE=' + [string]$first.curatedLane)
  Write-Output ('AFFILIATE_URL_PRESENT=' + [bool]$first.affiliateUrl)
}
$featured = Invoke-RestMethod ("http://127.0.0.1:$Port/api/commerce/curated/featured?min_price=5000&limit=8") -TimeoutSec 90
Write-Output ('FEATURED_COUNT=' + @($featured.items).Count)
if (@($sample.items).Count -lt 1 -and @($featured.items).Count -lt 1) { throw 'No curated eBay results returned during QA' }

Write-Output '=== IIS API PROXY ==='
Import-Module WebAdministration
New-Item -ItemType Directory -Path $IisRoot -Force | Out-Null
Write-ProxyConfig -Port $Port -RedirectHttps:$false
if (Test-Path "IIS:\Sites\$IisSite") {
  Set-ItemProperty "IIS:\Sites\$IisSite" -Name physicalPath -Value $IisRoot
} else {
  New-Website -Name $IisSite -PhysicalPath $IisRoot -Port 80 -HostHeader $ApiHost | Out-Null
}
$httpBinding = Get-WebBinding -Name $IisSite -Protocol http -ErrorAction SilentlyContinue |
  Where-Object { $_.bindingInformation -eq "*:80:$ApiHost" }
if (-not $httpBinding) { New-WebBinding -Name $IisSite -Protocol http -Port 80 -HostHeader $ApiHost | Out-Null }
Start-Website $IisSite -ErrorAction SilentlyContinue

$proxyHealth = Invoke-RestMethod -Uri 'http://127.0.0.1/health' -Headers @{Host=$ApiHost} -TimeoutSec 15
Write-Output ('IIS_PROXY_HEALTH=' + $proxyHealth.ok)
Write-Output ('IIS_SITE_STATE=' + (Get-Website -Name $IisSite).State)
$siteId = (Get-Website -Name $IisSite).id
Write-Output ('IIS_SITE_ID=' + $siteId)

$apiA = Get-Public-A $ApiHost
Write-Output ('API_PUBLIC_A=' + ($apiA -join ','))
$dnsReady = [bool]($apiA -contains $VpsIp)
Write-Output ('API_DNS_READY=' + $dnsReady)

if ($dnsReady) {
  $httpsBinding = Get-WebBinding -Name $IisSite -Protocol https -ErrorAction SilentlyContinue |
    Where-Object { $_.bindingInformation -match (':443:' + [regex]::Escape($ApiHost) + '$') }
  if (-not $httpsBinding) {
    $wacs = 'C:\win-acme\wacs.exe'
    if (-not (Test-Path $wacs)) { throw 'WACS is missing; cannot issue API certificate' }
    & $wacs --source iis --siteid $siteId --host $ApiHost --validation selfhosting --installation iis --accepttos --closeonfinish
    if ($LASTEXITCODE -ne 0) { throw "WACS certificate issuance failed exit=$LASTEXITCODE" }
  }
  $httpsBinding = Get-WebBinding -Name $IisSite -Protocol https -ErrorAction SilentlyContinue |
    Where-Object { $_.bindingInformation -match (':443:' + [regex]::Escape($ApiHost) + '$') }
  if (-not $httpsBinding) { throw 'HTTPS binding missing after certificate stage' }
  Write-ProxyConfig -Port $Port -RedirectHttps:$true
  Start-Sleep -Seconds 2
  $publicHealth = Invoke-RestMethod ("https://$ApiHost/health") -TimeoutSec 20
  $publicSearchResp = Invoke-WebRequest ("https://$ApiHost/api/commerce/curated/search?q=excavator&min_price=5000&limit=2") -Headers @{Origin='https://curatedtrading.com'} -UseBasicParsing -TimeoutSec 60
  $publicSearch = $publicSearchResp.Content | ConvertFrom-Json
  Write-Output ('PUBLIC_HTTPS_HEALTH=' + $publicHealth.ok)
  Write-Output ('PUBLIC_SEARCH_COUNT=' + @($publicSearch.items).Count)
  Write-Output ('PUBLIC_CORS=' + [string]$publicSearchResp.Headers['Access-Control-Allow-Origin'])
  if (-not $publicHealth.ok -or @($publicSearch.items).Count -lt 1) { throw 'Public API QA failed' }
  Write-Output 'API_PUBLIC_READY=True'
} else {
  Write-Output 'API_PUBLIC_READY=False'
  Write-Output ("NEXT_DNS_ACTION=Create A record $ApiHost -> $VpsIp")
  Write-Output 'CERTIFICATE_STAGE=DEFERRED_UNTIL_DNS'
}

Write-Output ('SERVICE_STATUS=' + (Get-Service $ServiceName).Status)
Write-Output ('PORT=' + $Port)
Write-Output 'CURATEDTRADING_DEPLOY_PASS'
