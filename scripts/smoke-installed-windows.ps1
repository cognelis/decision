$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$package = Get-Content -Raw -Path "package.json" | ConvertFrom-Json
$installer = Join-Path $PWD "out\make\squirrel.windows\x64\Decision-$($package.version)-win-x64-Setup.exe"
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
  throw "Windows installer was not produced: $installer"
}

$installRoot = Join-Path $env:LOCALAPPDATA "Decision"
$packageRoot = Join-Path $installRoot "app-$($package.version)"
$update = Join-Path $installRoot "Update.exe"

try {
  $install = Start-Process -FilePath $installer -ArgumentList "--silent" -Wait -PassThru
  if ($install.ExitCode -ne 0) {
    throw "Windows installer exited with code $($install.ExitCode)"
  }

  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while (-not (Test-Path -LiteralPath (Join-Path $packageRoot "Decision.exe") -PathType Leaf)) {
    if ([DateTime]::UtcNow -ge $deadline) {
      throw "Installed Decision executable was not found in $packageRoot"
    }
    Start-Sleep -Milliseconds 250
  }

  $installedExecutable = Join-Path $packageRoot "Decision.exe"
  Get-Process -Name "Decision" -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $installedExecutable } |
    Stop-Process -Force

  $env:DECISION_SMOKE_PACKAGE_ROOT = $packageRoot
  npm run smoke
  if ($LASTEXITCODE -ne 0) {
    throw "Installed Windows smoke failed with code $LASTEXITCODE"
  }
} finally {
  Remove-Item Env:DECISION_SMOKE_PACKAGE_ROOT -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $update -PathType Leaf) {
    $uninstall = Start-Process -FilePath $update -ArgumentList "--uninstall", "-s" -Wait -PassThru
    if ($uninstall.ExitCode -ne 0) {
      Write-Error "Squirrel uninstall exited with code $($uninstall.ExitCode)"
    }
  }
}
