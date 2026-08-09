# defer-claude.ps1 — waits until rate limit resets, then resumes Claude Code
param(
    [int]$WaitMinutes = 60,
    [string]$SessionId = "",
    [switch]$Interactive     # use --resume (interactive picker) instead of --continue
)

$waitSeconds = $WaitMinutes * 60
$resumeTime = (Get-Date).AddMinutes($WaitMinutes)
Write-Host "Deferred until $($resumeTime.ToString('HH:mm:ss')) ($WaitMinutes min from now)" -ForegroundColor Cyan
Write-Host "Waiting..." -ForegroundColor Yellow
Start-Sleep -Seconds $waitSeconds

Write-Host "`nRate limit window should be clear. Resuming Claude Code..." -ForegroundColor Green
if ($SessionId) {
    claude --resume $SessionId
} elseif ($Interactive) {
    claude --resume
} else {
    claude --continue
}
