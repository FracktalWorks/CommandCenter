# AI Company Brain - local bootstrap (Windows / PowerShell 5.1+).
# One-shot: install python deps, prepare .env, boot the lean infra stack,
# run smoke tests, print next steps.
#
#   pwsh -ExecutionPolicy Bypass -File scripts/bootstrap_local.ps1
#
[CmdletBinding()]
param(
    [switch]$SkipDocker,
    [switch]$SkipTests
)

# Native commands (docker, uv, ...) write progress + warnings to stderr.
# Windows PowerShell 5.1 will treat that as a terminating error if we use
# ErrorActionPreference="Stop", so we use Continue and check $LASTEXITCODE
# explicitly after every external call.
$ErrorActionPreference = "Continue"
if ($PSVersionTable.PSVersion.Major -ge 7) {
    $PSNativeCommandUseErrorActionPreference = $false
}
Set-Location (Split-Path -Parent $PSScriptRoot)

function Invoke-NativeQuiet {
    # Run a native command, swallow stdout+stderr at the cmd.exe level,
    # return the exit code. Works on Windows PowerShell 5.1.
    param([Parameter(Mandatory)][string]$Line)
    cmd /c "$Line >NUL 2>&1"
    return $LASTEXITCODE
}

function Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    OK  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    !!  $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host "    XX  $msg" -ForegroundColor Red; exit 1 }

# 1. Preflight
Step "Preflight: tooling"
foreach ($t in @("python","uv","git")) {
    if (-not (Get-Command $t -ErrorAction SilentlyContinue)) { Die "missing: $t" }
    Ok ("found  " + $t)
}
$dockerOk = $false
if (-not $SkipDocker) {
    if (Get-Command docker -ErrorAction SilentlyContinue) {
        $rc = Invoke-NativeQuiet "docker info"
        if ($rc -eq 0) { $dockerOk = $true; Ok "docker daemon reachable" }
        else { Warn "docker found but daemon not running. Start Docker Desktop and re-run." }
    } else {
        Warn "docker not installed."
        Write-Host "        Install Docker Desktop:  winget install -e --id Docker.DockerDesktop"
        Write-Host "        Then open it once to start the WSL2 backend, and re-run this script."
    }
}

# 2. .env
Step ".env"
if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Ok "created .env from template"
    Warn "edit .env and fill in ANTHROPIC_API_KEY (required for Tier 1/2/3 in dev)"
} else { Ok ".env already exists" }

# 3. uv sync
Step "uv sync (Python workspace)"
uv sync
if ($LASTEXITCODE -ne 0) { Die "uv sync failed" }
Ok "Python workspace synced"

# 4. Infra
if ($dockerOk) {
    Step "Boot infra (Docker Compose)"
    $profiles = @("--profile","core")
    docker compose --env-file .env -f infra/docker-compose.yml @profiles up -d
    if ($LASTEXITCODE -ne 0) { Die "docker compose up failed" }
    Ok "compose up issued; waiting for health..."

    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline) {
        $psJson = docker compose --env-file .env -f infra/docker-compose.yml ps --format json 2>$null
        if ($psJson) {
            # `compose ps --format json` emits one object per line.
            $rows = $psJson -split "`n" | Where-Object { $_.Trim() } | ForEach-Object {
                try { $_ | ConvertFrom-Json } catch { $null }
            } | Where-Object { $_ }
            $unhealthy = $rows | Where-Object { $_.Health -and $_.Health -ne "healthy" }
            if (-not $unhealthy) { Ok "all containers healthy"; break }
        }
        Start-Sleep -Seconds 3
    }
    Step "Probing services"
    uv run python scripts/check_infra.py
} else {
    Warn "skipped Docker step. The Python smoke tests will still pass; infra-dependent code will not."
}

# 5. Tests
if (-not $SkipTests) {
    Step "Smoke tests"
    uv run pytest tests/ -q
    if ($LASTEXITCODE -ne 0) { Die "smoke tests failed" }
    Ok "all smoke tests pass"
}

# 6. Next steps
Write-Host ""
Write-Host "Done. Next steps:" -ForegroundColor Green
Write-Host "  - Edit .env (set ANTHROPIC_API_KEY at minimum)"
Write-Host "  - Run the gateway:   uv run uvicorn gateway.main:app --reload --port 8080"
Write-Host "  - Health check:      curl http://localhost:8080/health"
Write-Host "  - LLM routing:      gateway /v1 (litellm SDK — no separate proxy)"