<#
.SYNOPSIS
    NOVA Phase 8 - one-command demonstration setup (Windows / PowerShell).

.DESCRIPTION
    Prepares the presentation configuration in which the ENTIRE knowledge stack
    is Azure-backed and ONLY the governed-action executor runs locally:

        AI_MODE=azure  KNOWLEDGE_MODE=azure  AUTH_MODE=entra
        VECTOR_STORE=azure_search  STORAGE_MODE=azure_blob
        DATABASE_URL=<Neon PostgreSQL>
        ACTION_MODE=local            <-- the only local component

    The script only ever runs npm scripts that already exist in package.json.
    It creates no Azure resource, deploys no Azure Function, deletes nothing,
    and never prints a secret value.

    Cost: the ONLY step that consumes Azure embedding usage is the one-time
    forced reindex, guarded by the marker file .demo-azure-search-reindexed.

.PARAMETER Start
    Perform the full setup and then start NOVA (npm start). Without -Start the
    script prepares and validates everything, then stops before starting.

.PARAMETER SkipReindex
    Never run the forced reindex in this invocation, even if the marker file is
    absent. Use when you know the index already holds Foundry vectors.

.PARAMETER ForceReindex
    Run the one-time forced reindex even though the marker file exists. This
    DOES consume embedding-model usage. Nothing else is forced.

.PARAMETER SkipTests
    Skip `npm test` / `npm run typecheck`. Both are offline and consume no
    model usage, so they run by default.

.EXAMPLE
    .\scripts\demo-setup.ps1 -Start
#>
[CmdletBinding()]
param(
    [switch]$Start,
    [switch]$SkipReindex,
    [switch]$ForceReindex,
    [switch]$SkipTests
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ---------------------------------------------------------------- output ----

function Write-Step  ([string]$Text) { Write-Host ''; Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok    ([string]$Text) { Write-Host "    OK    $Text" -ForegroundColor Green }
function Write-Info  ([string]$Text) { Write-Host "    ..    $Text" -ForegroundColor Gray }
function Write-Warn2 ([string]$Text) { Write-Host "    WARN  $Text" -ForegroundColor Yellow }

function Stop-Demo ([string]$Text, [string[]]$Hints = @()) {
    Write-Host ''
    Write-Host "FAILED: $Text" -ForegroundColor Red
    foreach ($hint in $Hints) { Write-Host "        $hint" -ForegroundColor Yellow }
    Write-Host ''
    Write-Host 'Setup stopped. Nothing was started, so the demo cannot silently run in a wrong mode.' -ForegroundColor Red
    exit 1
}

# Runs an npm script and fails loudly. Output is streamed, never captured, so
# nothing is reformatted and no value is echoed by this script.
function Invoke-Npm ([string[]]$NpmArgs, [string]$Label) {
    Write-Info "npm $($NpmArgs -join ' ')"
    & npm @NpmArgs
    if ($LASTEXITCODE -ne 0) {
        Stop-Demo "$Label failed (npm exit code $LASTEXITCODE)." @(
            'The command output above is the authoritative error.',
            'Fix the cause and re-run this script; it is safe to re-run.'
        )
    }
    Write-Ok $Label
}

# ------------------------------------------------------- repository root ----

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot
if (-not (Test-Path (Join-Path $repoRoot 'package.json'))) {
    Stop-Demo "No package.json in '$repoRoot'." @('Run the script from inside the NOVA repository.')
}

$envFile      = Join-Path $repoRoot '.env'
$envTemplate  = Join-Path $repoRoot '.env.demo.example'
$reindexMark  = Join-Path $repoRoot '.demo-azure-search-reindexed'

Write-Host ''
Write-Host '===========================================================' -ForegroundColor White
Write-Host ' NOVA Phase 8 - demonstration setup' -ForegroundColor White
Write-Host ' Azure knowledge stack + LOCAL governed-action executor' -ForegroundColor White
Write-Host '===========================================================' -ForegroundColor White
Write-Host " repository : $repoRoot"
Write-Host ' actions    : ACTION_MODE=local (LocalMockExecutor, simulated)'
Write-Host ' function   : NOVA Actions Azure Function app NOT used, NOT deployed'

# ------------------------------------------------------------ 1. toolchain --

Write-Step '1/11 Verifying Node.js and npm'
foreach ($tool in 'node', 'npm') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Stop-Demo "'$tool' was not found on PATH." @('Install Node.js 22.5 or newer from https://nodejs.org and reopen PowerShell.')
    }
}
$nodeVersion = (& node --version).Trim()
Write-Ok "node $nodeVersion, npm $((& npm --version).Trim())"
$nodeMajor = 0
$nodeMinor = 0
if ($nodeVersion -match '^v(\d+)\.(\d+)') { $nodeMajor = [int]$Matches[1]; $nodeMinor = [int]$Matches[2] }
if ($nodeMajor -lt 22 -or ($nodeMajor -eq 22 -and $nodeMinor -lt 5)) {
    Stop-Demo "Node $nodeVersion is older than the required >=22.5.0 (package.json engines)."
}

# ------------------------------------------------------------- 2. env file --

Write-Step '2/11 Ensuring .env exists'
if (Test-Path $envFile) {
    Write-Ok '.env already exists - preserved untouched (no secret is read, rewritten or printed)'
} else {
    if (-not (Test-Path $envTemplate)) {
        Stop-Demo '.env is missing and .env.demo.example was not found.'
    }
    Copy-Item $envTemplate $envFile
    Write-Ok 'created .env from .env.demo.example (placeholders only)'
    Write-Host ''
    Write-Host '    ACTION REQUIRED: fill the secret placeholders in .env now, then re-run this script.' -ForegroundColor Yellow
    Write-Host '      notepad .env' -ForegroundColor Yellow
    Write-Host '      DATABASE_URL, AZURE_API_KEY (or AZURE_ACCESS_TOKEN),' -ForegroundColor Yellow
    Write-Host '      AZURE_SEARCH_ADMIN_KEY, AZURE_STORAGE_CONNECTION_STRING' -ForegroundColor Yellow
    Write-Host '      plus the public Entra / Foundry / Search / Storage settings.' -ForegroundColor Yellow
    Write-Host '    Secrets stay on this machine. Never paste them into a chat.' -ForegroundColor Yellow
    Write-Host ''
    exit 2
}

# --------------------------------------------------------- 3. parse .env ----

# Same rules as backend/src/config/index.ts loadEnv(): KEY=VALUE, '#' comments,
# optional quotes, unquoted trailing ' #' comment stripped. Values are only
# inspected for presence/mode correctness and are never written to the console.
function Read-DotEnv ([string]$Path) {
    $map = @{}
    foreach ($raw in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $line = $raw.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) { continue }
        $eq = $line.IndexOf('=')
        if ($eq -lt 1) { continue }
        $key = $line.Substring(0, $eq).Trim()
        $value = $line.Substring($eq + 1).Trim()
        if (($value.StartsWith('"') -and $value.EndsWith('"') -and $value.Length -ge 2) -or
            ($value.StartsWith("'") -and $value.EndsWith("'") -and $value.Length -ge 2)) {
            $value = $value.Substring(1, $value.Length - 2)
        } elseif ($value -match '\s#') {
            $value = ($value -split '\s#', 2)[0].Trim()
        }
        $map[$key] = $value
    }
    return $map
}

$envMap = Read-DotEnv $envFile
function Get-EnvValue ([string]$Key) { if ($envMap.ContainsKey($Key)) { return [string]$envMap[$Key] } return '' }
function Test-Placeholder ([string]$Value) { return ($Value -match '^<.*>$') -or ($Value -eq '') }

# ------------------------------------------------------- 4. mode checking ---

Write-Step '3/11 Validating provider modes'
$expectedModes = [ordered]@{
    'AI_MODE'       = 'azure'
    'KNOWLEDGE_MODE' = 'azure'
    'AUTH_MODE'     = 'entra'
    'VECTOR_STORE'  = 'azure_search'
    'STORAGE_MODE'  = 'azure_blob'
    'ACTION_MODE'   = 'local'
    'EMBEDDING_DIM' = '384'
}
$modeProblems = @()
foreach ($key in $expectedModes.Keys) {
    $actual = Get-EnvValue $key
    $want = [string]$expectedModes[$key]
    if ($actual -eq $want) {
        Write-Ok "$key=$actual"
    } else {
        $shown = if ($actual -eq '') { '(unset)' } else { $actual }
        $modeProblems += "$key is $shown but the demo requires $want"
        Write-Warn2 "$key=$shown (expected $want)"
    }
}

# ACTION_MODE=azure is refused outright: it would need the Function app and
# would stop labelling results as simulated.
if ((Get-EnvValue 'ACTION_MODE') -eq 'azure') {
    Stop-Demo 'ACTION_MODE=azure is not allowed for this demonstration.' @(
        'Set ACTION_MODE=local in .env. The NOVA Actions Azure Function app is not deployed',
        'and must not participate in the presentation runtime.'
    )
}

# APP_MODE is derived in backend/src/config/index.ts and startup fails if a
# declared value disagrees with the derived one.
if ($envMap.ContainsKey('APP_MODE') -and (Get-EnvValue 'APP_MODE') -ne '') {
    Stop-Demo "APP_MODE is set in .env, but NOVA derives it from the provider modes." @(
        'Remove the APP_MODE line from .env. It is not a configurable input.'
    )
}
Write-Ok 'APP_MODE is not set (correctly derived by NOVA)'

foreach ($forbidden in 'ENTRA_CLIENT_SECRET', 'AZURE_CLIENT_SECRET') {
    if ((Get-EnvValue $forbidden) -ne '') {
        Stop-Demo "$forbidden is set, but NOVA's Entra app is a PUBLIC client (SPA + PKCE)." @(
            "Remove $forbidden from .env; AUTH_MODE=entra refuses to start while it is present."
        )
    }
}
Write-Ok 'no Entra client secret present (public client, PKCE)'

foreach ($unused in 'AZURE_ACTION_FUNCTION_URL', 'AZURE_ACTION_FUNCTION_KEY') {
    if ((Get-EnvValue $unused) -ne '') {
        Write-Warn2 "$unused is set. It is IGNORED while ACTION_MODE=local, but comment it out to keep the demo unambiguous."
    }
}

if ($modeProblems.Count -gt 0) {
    Stop-Demo 'The provider modes in .env do not match the demonstration architecture.' ($modeProblems + @(
        'Compare .env against .env.demo.example and correct the values above.'
    ))
}

# ----------------------------------------------------- 5. secret presence ---

Write-Step '4/11 Checking required settings are present (values are never printed)'

$publicRequired = @(
    'FOUNDRY_ENDPOINT', 'FOUNDRY_MODEL_DEPLOYMENT', 'AZURE_EMBEDDING_DEPLOYMENT',
    'AZURE_SEARCH_ENDPOINT', 'AZURE_SEARCH_INDEX',
    'AZURE_STORAGE_CONTAINER',
    'ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'ENTRA_API_ID_URI', 'ENTRA_API_SCOPE',
    'ENTRA_AUTHORITY', 'ENTRA_REDIRECT_URI'
)
$secretRequired = @(
    'DATABASE_URL', 'AZURE_SEARCH_ADMIN_KEY', 'AZURE_STORAGE_CONNECTION_STRING'
)

$missing = @()
foreach ($key in $publicRequired) {
    if (Test-Placeholder (Get-EnvValue $key)) { $missing += $key } else { Write-Ok "$key present" }
}
foreach ($key in $secretRequired) {
    if (Test-Placeholder (Get-EnvValue $key)) { $missing += $key } else { Write-Ok "$key present (value hidden)" }
}
# Foundry accepts either a static key or a pre-acquired Entra access token.
if ((Test-Placeholder (Get-EnvValue 'AZURE_API_KEY')) -and (Test-Placeholder (Get-EnvValue 'AZURE_ACCESS_TOKEN'))) {
    $missing += 'AZURE_API_KEY (or AZURE_ACCESS_TOKEN)'
} else {
    Write-Ok 'Foundry credential present (value hidden)'
}

if ($missing.Count -gt 0) {
    Stop-Demo 'Required settings are missing or still placeholders in .env.' (
        @('Missing:') + ($missing | ForEach-Object { "  - $_" }) + @(
            'Fill them in .env on this machine:  notepad .env',
            'Their values are never printed by this script and must never be pasted into a chat.'
        )
    )
}

$dbUrl = Get-EnvValue 'DATABASE_URL'
if (-not ($dbUrl.StartsWith('postgres://') -or $dbUrl.StartsWith('postgresql://'))) {
    Stop-Demo 'DATABASE_URL is not a PostgreSQL connection string.' @(
        'The demo runs on Neon PostgreSQL. NOVA refuses to fall back to SQLite in Azure mode.'
    )
}
Write-Ok 'DATABASE_URL is a PostgreSQL connection string (Neon)'

$redirect = Get-EnvValue 'ENTRA_REDIRECT_URI'
$demoUrl = 'http://localhost:4317'
try {
    $redirectUri = [uri]$redirect
    $demoUrl = "$($redirectUri.Scheme)://$($redirectUri.Authority)"
    Write-Ok "Entra redirect origin $demoUrl (NOVA binds this exact port; no port fallback in Entra mode)"
} catch {
    Stop-Demo 'ENTRA_REDIRECT_URI is not a valid absolute URL.'
}
$declaredPort = Get-EnvValue 'PORT'
if ($declaredPort -ne '' -and $redirectUri.Port -ne [int]$declaredPort) {
    Stop-Demo "PORT=$declaredPort contradicts ENTRA_REDIRECT_URI (port $($redirectUri.Port))." @(
        'In Entra mode NOVA must serve the exact registered redirect origin. Remove PORT from .env.'
    )
}

# ------------------------------------------------------- 6. dependencies ----

Write-Step '5/11 Dependencies'
$needInstall = $true
$nodeModules = Join-Path $repoRoot 'node_modules'
if (Test-Path (Join-Path $nodeModules '.package-lock.json')) {
    $lockAge = (Get-Item (Join-Path $repoRoot 'package-lock.json')).LastWriteTimeUtc
    $installAge = (Get-Item (Join-Path $nodeModules '.package-lock.json')).LastWriteTimeUtc
    if ($installAge -ge $lockAge) { $needInstall = $false }
}
if ($needInstall) {
    Write-Info 'node_modules is missing or older than package-lock.json'
    Invoke-Npm @('install') 'npm install'
} else {
    Write-Ok 'dependencies already installed (skipping npm install)'
}
Write-Info 'no npm audit fix, no version changes: dependencies are left exactly as the lockfile defines them'

# -------------------------------------------------------- 7. offline tests --

Write-Step '6/11 Offline checks (no Azure calls, no model usage)'
if ($SkipTests) {
    Write-Warn2 'skipped by -SkipTests'
} else {
    Invoke-Npm @('run', 'typecheck') 'typecheck'
    Invoke-Npm @('test') 'test suite (mocked providers, offline)'
    Write-Info 'tests/providerModes.test.ts pins: ACTION_MODE=local loads LocalMockExecutor (simulated=true)'
    Write-Info 'while Foundry, Search, Blob, Entra and PostgreSQL stay Azure-backed, and health performs zero probes'
}

# ------------------------------------------------------------ 8. database ---

Write-Step '7/11 Neon PostgreSQL migrations'
Invoke-Npm @('run', 'db:migrate') 'db:migrate'
Invoke-Npm @('run', 'db:status') 'db:status (schema up to date)'

# -------------------------------------------------------- 9. azure search ---

Write-Step '8/11 Azure AI Search'
Invoke-Npm @('run', 'search:validate') 'search:validate (index schema + vector dimension)'

$doReindex = $false
if ($ForceReindex) {
    $doReindex = $true
    Write-Warn2 '-ForceReindex given: the one-time reindex will run again'
} elseif ($SkipReindex) {
    Write-Warn2 '-SkipReindex given: no embedding usage in this run'
} elseif (Test-Path $reindexMark) {
    Write-Ok "marker $(Split-Path -Leaf $reindexMark) exists - forced Azure reindex already done, skipping (no embedding usage)"
} else {
    $doReindex = $true
}

if ($doReindex) {
    Write-Host ''
    Write-Host '    Azure embedding reindex will consume embedding-model usage and is intended to run once.' -ForegroundColor Yellow
    Write-Host '    Reason: an index populated in local mode holds nova-hashed-lexical-v1 vectors, which are' -ForegroundColor Yellow
    Write-Host '    not in the same vector space as Foundry query embeddings. This rebuilds every chunk vector' -ForegroundColor Yellow
    Write-Host '    through the configured AZURE_EMBEDDING_DEPLOYMENT.' -ForegroundColor Yellow
    Write-Host ''
    Write-Info 'npm run search:reindex -- --force'
    $reindexArgs = @('run', 'search:reindex', '--', '--force')
    & npm @reindexArgs
    if ($LASTEXITCODE -ne 0) {
        Stop-Demo "search:reindex --force failed (npm exit code $LASTEXITCODE)." @(
            "The marker file was NOT created, so a later run will retry it.",
            'Review the output above before retrying, to avoid paying for embeddings twice.'
        )
    }
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    @(
        "NOVA demo marker - do not commit.",
        "A forced Azure embedding reindex (npm run search:reindex -- --force) completed successfully.",
        "Completed (UTC): $stamp",
        "Delete this file only if you deliberately want to pay for a full re-embed again."
    ) | Set-Content -LiteralPath $reindexMark -Encoding UTF8
    Write-Ok "forced Azure reindex complete; marker $(Split-Path -Leaf $reindexMark) created"
}

# --------------------------------------------------------- 10. blob storage -

Write-Step '9/11 Azure Blob Storage'
Invoke-Npm @('run', 'storage:validate') 'storage:validate (container reachable)'
Write-Info 'storage stays STORAGE_MODE=azure_blob; there is no local-disk fallback'

# ---------------------------------------------------------------- 11. build -

Write-Step '10/11 Building the frontend'
Invoke-Npm @('run', 'build:web') 'build:web'

# ---------------------------------------------------------------- summary ---

Write-Step '11/11 Ready'
Write-Host ''
Write-Host '  Azure-backed  : Microsoft Entra ID, Neon PostgreSQL, Microsoft Foundry (chat + embeddings),' -ForegroundColor White
Write-Host '                  Azure AI Search, Azure Blob Storage' -ForegroundColor White
Write-Host '  Local         : governed-action executor only (LocalMockExecutor, simulated=true)' -ForegroundColor White
Write-Host '  Not used      : NOVA Actions Azure Function app (not deployed, not called)' -ForegroundColor White
Write-Host "  Demo URL      : $demoUrl" -ForegroundColor White
Write-Host '  Wording       : "Governed action executed in local/demo mode."' -ForegroundColor White
Write-Host ''

if (-not $Start) {
    Write-Host '  Preparation complete. Start NOVA with:' -ForegroundColor Green
    Write-Host '      .\scripts\demo-setup.ps1 -Start' -ForegroundColor Green
    Write-Host '  or directly:' -ForegroundColor Green
    Write-Host '      npm start' -ForegroundColor Green
    Write-Host ''
    exit 0
}

# ----------------------------------------------------------------- start ----

Write-Host '==> Starting NOVA (npm start). Press Ctrl+C to stop.' -ForegroundColor Cyan
Write-Host "    Open $demoUrl and sign in with Microsoft Entra." -ForegroundColor Cyan
Write-Host ''

$nova = Start-Process -FilePath 'npm' -ArgumentList 'start' -WorkingDirectory $repoRoot -NoNewWindow -PassThru

# Configuration-only health check. /api/health is local and synchronous: it
# performs no Foundry, embedding, Search, Blob or Function call, and this script
# adds no probe of its own.
$healthUrl = "$demoUrl/api/health"
$health = $null
for ($attempt = 1; $attempt -le 20; $attempt++) {
    Start-Sleep -Seconds 2
    if ($nova.HasExited) {
        Stop-Demo "NOVA exited during startup (exit code $($nova.ExitCode))." @('The server output above explains why.')
    }
    try {
        $health = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 5
        break
    } catch {
        Write-Info "waiting for $healthUrl ($attempt/20)"
    }
}

if ($null -eq $health) {
    Write-Warn2 "Could not read $healthUrl automatically. Open it in the browser; NOVA may still be starting."
} else {
    Write-Host ''
    Write-Host '==> /api/health (configuration-only, zero-token)' -ForegroundColor Cyan
    try {
        $checks = @(
            @{ Label = 'appMode = azure';      Pass = ($health.appMode -eq 'azure');     Actual = $health.appMode }
            @{ Label = 'isFullyLocal = false'; Pass = ($health.isFullyLocal -eq $false); Actual = $health.isFullyLocal }
            @{ Label = 'liveProbe = false';    Pass = ($health.liveProbe -eq $false);    Actual = $health.liveProbe }
            @{ Label = 'modeBadge = AZURE CONFIGURED'; Pass = ($health.modeBadge -eq 'AZURE CONFIGURED'); Actual = $health.modeBadge }
        )
        foreach ($check in $checks) {
            if ($check.Pass) { Write-Ok $check.Label } else { Write-Warn2 "$($check.Label) - actual: $($check.Actual)" }
        }
        $actionState = $health.azureReadiness.components.actions.state
        if ($actionState -eq 'local') {
            Write-Ok 'actions state = local (intentionally simulated, not "incomplete")'
        } else {
            Write-Warn2 "actions state = $actionState (expected local)"
        }
        $incomplete = @($health.azureReadiness.incompleteComponents)
        if ($incomplete.Count -eq 0) {
            Write-Ok 'incompleteComponents = [] (every Azure-selected component is configured)'
        } else {
            Write-Warn2 "incompleteComponents = $($incomplete -join ', ')"
        }
    } catch {
        Write-Warn2 'Could not read azureReadiness from the health payload; inspect it in the browser.'
    }
    Write-Host ''
    Write-Host "  NOVA is running at $demoUrl" -ForegroundColor Green
    Write-Host '  Governed actions are in local/demo mode: results are labelled SIMULATED ACTION.' -ForegroundColor Green
    Write-Host '  See docs/demo-quickstart.md for the presentation sequence.' -ForegroundColor Green
    Write-Host ''
}

Wait-Process -Id $nova.Id
exit $nova.ExitCode
