param(
  [string]$Only = 'both',
  [switch]$NoPause
)
# Test double for refresh-all.ps1: same argument shape, prints a few lines, exits.
#
# Purpose: prove RefreshRunner can spawn powershell with FILE-backed stdio.
# The sandbox forbids opening named pipes, so stdio:'pipe' fails with EPERM;
# RefreshRunner uses stdio:['ignore', fd, fd] instead. This fixture turns that
# assumption into a verified fact without touching the network or any browser.
#
# ASCII ONLY on purpose -- Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI
# (GBK on this machine) and mangles non-ASCII literals. This file first shipped
# with Chinese comments and tripped exactly that rule. Keep it English.
Write-Host "=== fixture refresh start ==="
Write-Host "Only=$Only NoPause=$($NoPause.IsPresent)"
Write-Host "OK line 1"
Start-Sleep -Milliseconds 300
Write-Host "OK line 2"
Write-Host "=== ALL STEPS OK ==="
exit 0
