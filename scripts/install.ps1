# Magic Context — Interactive Setup (Windows)
# Usage: irm https://raw.githubusercontent.com/cortexkit/opencode-magic-context/master/scripts/install.ps1 | iex

Write-Host ""
Write-Host "  ✨ Magic Context — Setup" -ForegroundColor Cyan
Write-Host "  ────────────────────────"
Write-Host ""

$package = "@cortexkit/opencode-magic-context"

if (Get-Command bun -ErrorAction SilentlyContinue) {
    Write-Host "  → Using bun" -ForegroundColor Gray
    Write-Host ""
    & bun x $package setup
} elseif (Get-Command npx -ErrorAction SilentlyContinue) {
    Write-Host "  → Using npx" -ForegroundColor Gray
    Write-Host ""
    & npx -y $package setup
} else {
    Write-Host "  ✗ Neither bun nor npx found." -ForegroundColor Red
    Write-Host ""
    Write-Host "  Install one of:" -ForegroundColor Yellow
    Write-Host "    • bun:  irm bun.sh/install.ps1 | iex"
    Write-Host "    • node: https://nodejs.org"
    Write-Host ""
    exit 1
}
