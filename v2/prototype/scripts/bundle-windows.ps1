param(
  [string]$MsysRoot = (Join-Path $env:TEMP 'watchpair-v2-native\msys64'),
  [string]$BuildDirectory = '',
  [string]$Destination = ''
)
$ErrorActionPreference = 'Stop'
$taskSource = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$taskPrefix = Join-Path $MsysRoot 'ucrt64'
if (-not $BuildDirectory) { $BuildDirectory = Join-Path $taskSource '..\..\outputs\v2\windows-build' }
if (-not $Destination) { $Destination = Join-Path $taskSource '..\..\outputs\v2\windows-portable' }
$taskExe = Join-Path $BuildDirectory 'watchpair-v2-prototype.exe'
if (-not (Test-Path -LiteralPath $taskExe)) { throw 'Build the prototype first.' }
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$Destination = (Resolve-Path -LiteralPath $Destination).Path
Copy-Item -LiteralPath $taskExe -Destination $Destination
$env:Path = (Join-Path $taskPrefix 'bin') + ';' + $env:Path
$taskDeploy = @('windeployqt6.exe', 'windeployqt.exe') | ForEach-Object { Join-Path $taskPrefix "bin\$_" } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $taskDeploy) { throw 'Qt deployment tool not found in the selected UCRT64 installation.' }
& $taskDeploy --release --no-translations --dir $Destination (Join-Path $Destination 'watchpair-v2-prototype.exe')
if ($LASTEXITCODE) { exit $LASTEXITCODE }
$taskProviders = Join-Path $taskPrefix 'lib\ossl-modules'
if (-not (Test-Path -LiteralPath (Join-Path $taskProviders 'legacy.dll'))) { throw 'Matching OpenSSL legacy provider is required for this native runtime.' }
$taskProviderTarget = Join-Path $Destination 'ossl-modules'
New-Item -ItemType Directory -Force -Path $taskProviderTarget | Out-Null
Get-ChildItem -LiteralPath $taskProviders -File -Filter '*.dll' | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $taskProviderTarget -Force
}
$taskPending = [System.Collections.Generic.Queue[string]]::new()
$taskSeen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
Get-ChildItem -LiteralPath $Destination -Recurse -File | Where-Object { $_.Extension -in '.exe', '.dll' } | ForEach-Object { $taskPending.Enqueue($_.FullName) }
while ($taskPending.Count) {
  $taskFile = $taskPending.Dequeue()
  if (-not $taskSeen.Add($taskFile)) { continue }
  $taskImports = & (Join-Path $taskPrefix 'bin\objdump.exe') -p $taskFile
  if ($LASTEXITCODE) { throw "Cannot inspect runtime dependencies of $taskFile" }
  foreach ($taskLine in $taskImports) {
    if ($taskLine -notmatch 'DLL Name:\s*(.+\.dll)\s*$') { continue }
    $taskName = $Matches[1].Trim()
    if ([System.IO.Path]::GetFileName($taskName) -ne $taskName) { throw 'Unexpected dependency path.' }
    $taskDll = Join-Path $taskPrefix "bin\$taskName"
    if (Test-Path -LiteralPath $taskDll) {
      $taskTarget = Join-Path $Destination $taskName
      Copy-Item -LiteralPath $taskDll -Destination $taskTarget -Force
      if (-not $taskSeen.Contains($taskTarget)) { $taskPending.Enqueue($taskTarget) }
    }
  }
}
Copy-Item -LiteralPath (Join-Path $taskPrefix 'share\licenses') -Destination (Join-Path $Destination 'ThirdPartyLicenses') -Recurse -Force
$taskReadme = (Get-Content -LiteralPath (Join-Path $taskSource 'README.md') -Raw).Replace('../../docs/watchpair-v2-plan.md', 'docs/watchpair-v2-plan.md')
Set-Content -LiteralPath (Join-Path $Destination 'PROTOTYPE-README.md') -Value $taskReadme -Encoding UTF8
Copy-Item -LiteralPath (Join-Path $taskSource 'VALIDATION.md') -Destination $Destination -Force
New-Item -ItemType Directory -Force -Path (Join-Path $Destination 'docs') | Out-Null
$taskSpec = (Get-Content -LiteralPath (Join-Path $taskSource '..\..\docs\watchpair-v2-plan.md') -Raw).Replace('../v2/prototype/VALIDATION.md', '../VALIDATION.md')
Set-Content -LiteralPath (Join-Path $Destination 'docs\watchpair-v2-plan.md') -Value $taskSpec -Encoding UTF8
Write-Output (Join-Path $Destination 'watchpair-v2-prototype.exe')
