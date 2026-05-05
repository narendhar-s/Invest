# StockWise Startup Script
# Run this from the project root: .\start.ps1

$env:PATH = "C:\msys64\mingw64\bin;" + $env:PATH
$env:GOROOT = "C:\msys64\mingw64\lib\go"
$env:GOPATH = "$env:USERPROFILE\go"

$pgBin = "C:\msys64\mingw64\bin"
$pgData = "C:\msys64\home\NAREN\pgdata"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "Starting StockWise..." -ForegroundColor Cyan

# Start PostgreSQL if not running
$pgRunning = $false
try {
    & "$pgBin\psql.exe" -U postgres -c "SELECT 1;" -q 2>&1 | Out-Null
    $pgRunning = $?
} catch { }

if (-not $pgRunning) {
    Write-Host "Starting PostgreSQL..." -ForegroundColor Yellow
    & "$pgBin\pg_ctl.exe" -D $pgData -l "$pgData\pg.log" start
    Start-Sleep -Seconds 3
    # Create DB if not exists
    & "$pgBin\psql.exe" -U postgres -c "CREATE USER IF NOT EXISTS stockwise WITH PASSWORD 'stockwise123';" 2>&1 | Out-Null
    & "$pgBin\createdb.exe" -U postgres -O stockwise stockwise_db 2>&1 | Out-Null
} else {
    Write-Host "PostgreSQL already running." -ForegroundColor Green
}

# Build and start backend
Write-Host "Building backend..." -ForegroundColor Yellow
Set-Location $projectRoot
& "$env:GOROOT\bin\go.exe" build -o "bin\stockwise.exe" .\cmd\main.go
if ($LASTEXITCODE -ne 0) { Write-Host "Build failed!" -ForegroundColor Red; exit 1 }

Write-Host "Starting backend on :8080..." -ForegroundColor Green
Start-Process -FilePath "$projectRoot\bin\stockwise.exe" -WorkingDirectory $projectRoot -WindowStyle Normal

# Start frontend dev server
Write-Host "Starting frontend on :5173..." -ForegroundColor Green
Start-Process -FilePath "C:\msys64\mingw64\bin\node.exe" `
    -ArgumentList "C:\msys64\mingw64\lib\node_modules\npm\bin\npm-cli.js run dev" `
    -WorkingDirectory "$projectRoot\frontend" -WindowStyle Normal

Start-Sleep -Seconds 4
Write-Host ""
Write-Host "StockWise is running!" -ForegroundColor Green
Write-Host "  Frontend:  http://localhost:5173" -ForegroundColor Cyan
Write-Host "  Backend:   http://localhost:8080" -ForegroundColor Cyan
Write-Host "  API:       http://localhost:8080/api/v1/health" -ForegroundColor Cyan
