# Conduit Windows 11 Setup Check Script
Write-Host "=== Conduit Windows 11 Setup Check ===" -ForegroundColor Cyan
Write-Host ""

$checks = @(
    @{ Name = "Node.js"; Command = "node --version"; Pattern = "v\d+\.\d+" },
    @{ Name = "pnpm"; Command = "pnpm --version"; Pattern = "^\d+\." },
    @{ Name = "Rust (rustc)"; Command = "rustc --version"; Pattern = "rustc \d+\.\d+" },
    @{ Name = "Cargo"; Command = "cargo --version"; Pattern = "cargo \d+\.\d+" },
    @{ Name = "Tauri CLI (local)"; Command = "pnpm -C `"$PSScriptRoot\apps\desktop`" exec tauri --version"; Pattern = "tauri-cli" }
)

$allPass = $true
foreach ($check in $checks) {
    try {
        $output = Invoke-Expression $check.Command 2>$null
        if ($output -match $check.Pattern) {
            Write-Host "  ✅ $($check.Name): $output" -ForegroundColor Green
        } else {
            Write-Host "  ❌ $($check.Name): Not properly installed" -ForegroundColor Red
            $allPass = $false
        }
    } catch {
        Write-Host "  ❌ $($check.Name): Not found in PATH" -ForegroundColor Red
        $allPass = $false
    }
}

Write-Host ""

# Check for Visual Studio Build Tools
$vsPaths = @(
    "C:\Program Files\Microsoft Visual Studio\2022\BuildTools",
    "C:\Program Files\Microsoft Visual Studio\2022\Community",
    "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools",
    "C:\Program Files (x86)\Microsoft Visual Studio\2022\Community"
)

$vsFound = $false
foreach ($vsPath in $vsPaths) {
    if (Test-Path $vsPath) {
        $edition = if ($vsPath -like "*Community*") { "Community" } else { "BuildTools" }
        $arch = if ($vsPath -like "*(x86)*") { "(x86)" } else { "" }
        Write-Host "  ✅ Visual Studio 2022 $edition $arch`: Found at $vsPath" -ForegroundColor Green
        $vsFound = $true
        break
    }
}

if (-not $vsFound) {
    Write-Host "  ❌ Visual Studio Build Tools 2022: Not found" -ForegroundColor Red
    $allPass = $false
}

Write-Host ""

if ($allPass) {
    Write-Host "🚀 All prerequisites installed!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Yellow
    Write-Host "  1. cd $PSScriptRoot" -ForegroundColor White
    Write-Host "  2. pnpm install" -ForegroundColor White
    Write-Host "  3. pnpm dev" -ForegroundColor White
} else {
    Write-Host "⚠️  Some prerequisites are missing or need PATH refresh" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Try: Close and reopen your terminal, then run this script again" -ForegroundColor Cyan
}

Write-Host ""
