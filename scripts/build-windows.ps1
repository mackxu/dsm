$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
  throw "Windows packaging must run on Windows 10/11 with Node.js 22.13+ and pnpm 11.5.2."
}

Write-Host "Installing frozen dependencies..."
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw "pnpm install failed." }

Write-Host "Checking TypeScript..."
pnpm run check
if ($LASTEXITCODE -ne 0) { throw "Type checking failed." }

Write-Host "Running tests..."
pnpm run test
if ($LASTEXITCODE -ne 0) { throw "Tests failed." }

Write-Host "Building Windows x64 NSIS and ZIP artifacts..."
pnpm run make:win
if ($LASTEXITCODE -ne 0) { throw "Windows packaging failed." }

$artifactRoot = Join-Path $PSScriptRoot "../apps/desktop/out/make"
Get-ChildItem $artifactRoot -Recurse -File |
  Where-Object {
    $_.Name -eq "RELEASES" -or
    $_.Extension -in @(".exe", ".nupkg", ".zip")
  } |
  Select-Object FullName, Length |
  Format-Table -AutoSize
