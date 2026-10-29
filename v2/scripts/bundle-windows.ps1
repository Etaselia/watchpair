param(
  [string]$MsysRoot = (Join-Path $env:TEMP 'watchpair-v2-native\msys64'),
  [string]$BuildDirectory = '',
  [string]$Destination = ''
)
$ErrorActionPreference = 'Stop'
$taskSource = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$taskPrefix = Join-Path $MsysRoot 'ucrt64'
if (-not $BuildDirectory) { $BuildDirectory = Join-Path $taskSource '..\outputs\v2\app-windows' }
if (-not $Destination) { $Destination = Join-Path $taskSource ('..\outputs\v2\packages\windows-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
if (Test-Path -LiteralPath $Destination) { throw 'Use a new package destination so stale runtime files cannot enter the bundle.' }
$taskExe = Join-Path $BuildDirectory 'desktop\watchpair.exe'
if (-not (Test-Path -LiteralPath $taskExe)) { throw 'Build the v2 application first.' }
New-Item -ItemType Directory -Path $Destination | Out-Null
$Destination = (Resolve-Path -LiteralPath $Destination).Path
Copy-Item -LiteralPath $taskExe -Destination $Destination
Copy-Item -LiteralPath (Join-Path $BuildDirectory 'desktop\watchpair-launcher.exe') -Destination $Destination
$taskBuildInfo = Get-Content -LiteralPath (Join-Path $BuildDirectory 'build-info.json') -Raw | ConvertFrom-Json
Copy-Item -LiteralPath (Join-Path $BuildDirectory 'build-info.json') -Destination $Destination
$env:Path = (Join-Path $taskPrefix 'bin') + ';' + $env:Path
$taskDeploy = @('windeployqt6.exe','windeployqt.exe') | ForEach-Object {Join-Path $taskPrefix "bin\$_"} | Where-Object {Test-Path -LiteralPath $_} | Select-Object -First 1
if (-not $taskDeploy) {throw 'Qt deployment tool not found.'}
& $taskDeploy --release --no-translations --dir $Destination (Join-Path $Destination 'watchpair.exe')
if ($LASTEXITCODE) {throw 'Qt deployment failed.'}
foreach ($taskItem in @(@('lib\ossl-modules','ossl-modules'),@('etc\ssl\certs\ca-bundle.crt','certs\ca-bundle.crt'))) {
  $taskFrom = Join-Path $taskPrefix $taskItem[0]
  $taskTo = Join-Path $Destination $taskItem[1]
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $taskTo) | Out-Null
  Copy-Item -LiteralPath $taskFrom -Destination $taskTo -Recurse
}
$taskPending = [System.Collections.Generic.Queue[string]]::new()
$taskSeen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
Get-ChildItem -LiteralPath $Destination -Recurse -File | Where-Object {$_.Extension -in '.exe','.dll'} | ForEach-Object {$taskPending.Enqueue($_.FullName)}
while ($taskPending.Count) {
  $taskFile = $taskPending.Dequeue()
  if (-not $taskSeen.Add($taskFile)) {continue}
  $taskImports = & (Join-Path $taskPrefix 'bin\objdump.exe') -p $taskFile
  if ($LASTEXITCODE) {throw "Cannot inspect imports: $taskFile"}
  foreach ($taskLine in $taskImports) {
    if ($taskLine -notmatch 'DLL Name:\s*(.+\.dll)\s*$') {continue}
    $taskName = $Matches[1].Trim()
    if ([IO.Path]::GetFileName($taskName) -ne $taskName) {throw 'Invalid import filename.'}
    $taskDll = Join-Path $taskPrefix "bin\$taskName"
    if (Test-Path -LiteralPath $taskDll) {
      $taskTarget = Join-Path $Destination $taskName
      if (-not (Test-Path -LiteralPath $taskTarget)) {Copy-Item -LiteralPath $taskDll -Destination $taskTarget}
      if (-not $taskSeen.Contains($taskTarget)) {$taskPending.Enqueue($taskTarget)}
    }
  }
}
Copy-Item -LiteralPath (Join-Path $taskPrefix 'share\licenses') -Destination (Join-Path $Destination 'ThirdPartyLicenses') -Recurse
$taskCommon = Join-Path $MsysRoot 'usr\share\licenses\common'
if (Test-Path -LiteralPath $taskCommon) {Copy-Item -LiteralPath $taskCommon -Destination (Join-Path $Destination 'ThirdPartyLicenses\Common') -Recurse}
Copy-Item -LiteralPath (Join-Path $taskSource 'assets\watchpair.svg') -Destination $Destination
Copy-Item -LiteralPath (Join-Path $taskSource '..\LICENSE') -Destination (Join-Path $Destination 'WatchPair-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $taskSource 'DISTRIBUTION.md') -Destination $Destination
Set-Content -LiteralPath (Join-Path $Destination 'PACKAGE-STATUS.txt') -Encoding utf8 -Value 'Internal validation bundle. Public distribution requires exact corresponding source, build recipes, complete license notices, signed release metadata and published checksums. See v2/DISTRIBUTION.md.'
$taskOwners = @{}
$taskPackages = foreach ($taskFolder in Get-ChildItem -LiteralPath (Join-Path $MsysRoot 'var\lib\pacman\local') -Directory) {
  $taskDesc = Join-Path $taskFolder.FullName 'desc'
  if (-not (Test-Path -LiteralPath $taskDesc)) {continue}
  $taskText = Get-Content -LiteralPath $taskDesc -Raw
  $taskFields = [ordered]@{}
  foreach ($taskName in @('NAME','BASE','VERSION','URL','LICENSE','BUILDDATE')) {
    $taskMatch = [regex]::Match($taskText, '(?ms)^%' + $taskName + '%\r?\n(.*?)(?=\r?\n\r?\n|\z)')
    if ($taskMatch.Success) {$taskFields[$taskName.ToLowerInvariant()]=$taskMatch.Groups[1].Value.Trim()}
  }
  $taskFileList = Join-Path $taskFolder.FullName 'files'
  if (Test-Path -LiteralPath $taskFileList) {
    foreach ($taskInstalledFile in Get-Content -LiteralPath $taskFileList) {
      if ($taskInstalledFile -notmatch '^ucrt64/.*\.(dll|crt)$') {continue}
      $taskLeaf = [IO.Path]::GetFileName($taskInstalledFile).ToLowerInvariant()
      if (-not $taskOwners.ContainsKey($taskLeaf)) {$taskOwners[$taskLeaf] = [System.Collections.Generic.HashSet[string]]::new()}
      [void]$taskOwners[$taskLeaf].Add($taskFields.name)
    }
  }
  $taskFields
}
$taskRuntimeNames = [System.Collections.Generic.HashSet[string]]::new()
$taskRows = foreach ($taskFile in Get-ChildItem -LiteralPath $Destination -Recurse -File) {
  $taskOrigin = $null
  if ($taskFile.Extension -eq '.dll' -or $taskFile.Name -eq 'ca-bundle.crt') {
    $taskMatches = $taskOwners[$taskFile.Name.ToLowerInvariant()]
    if (-not $taskMatches -or $taskMatches.Count -ne 1) {throw "Cannot identify the installed source package for $($taskFile.Name)."}
    $taskOrigin = @($taskMatches)[0]
    [void]$taskRuntimeNames.Add($taskOrigin)
  }
  [ordered]@{path=[IO.Path]::GetRelativePath($Destination,$taskFile.FullName).Replace('\','/');size=$taskFile.Length;sha256=(Get-FileHash -LiteralPath $taskFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant();originPackage=$taskOrigin}
}
$taskRuntimePackages = @($taskPackages | Where-Object {$taskRuntimeNames.Contains($_.name)})
[ordered]@{format=1;version=$taskBuildInfo.version;protocol=2;platform='windows-x64';files=@($taskRows);runtimePackages=$taskRuntimePackages;sdkPackages=@($taskPackages)} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $Destination 'runtime-manifest.json') -Encoding utf8
Write-Output (Join-Path $Destination 'watchpair.exe')
