param(
  [string]$MsysRoot = (Join-Path $env:TEMP 'watchpair-v2-native\msys64'),
  [string]$BuildDirectory = '',
  [switch]$RunTests,
  [switch]$DesktopTests,
  [string]$MediaFixtures = '',
  [string]$AppVersion = '',
  [string]$UpdatePublicKey = ''
)
$ErrorActionPreference = 'Stop'
$taskSource = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$taskPrefix = Join-Path $MsysRoot 'ucrt64'
if (-not $BuildDirectory) { $BuildDirectory = Join-Path $taskSource '..\outputs\v2\app-windows' }
$env:Path = (Join-Path $taskPrefix 'bin') + ';' + $env:Path
$taskConfigure = @('-S', $taskSource, '-B', $BuildDirectory, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=RelWithDebInfo', "-DCMAKE_PREFIX_PATH=$taskPrefix")
if ($AppVersion) { $taskConfigure += "-DWATCHPAIR_APP_VERSION=$AppVersion" }
if ($UpdatePublicKey) { $taskConfigure += "-DWATCHPAIR_UPDATE_PUBLIC_KEY=$UpdatePublicKey" }
& (Join-Path $taskPrefix 'bin\cmake.exe') @taskConfigure
if ($LASTEXITCODE) { exit $LASTEXITCODE }
& (Join-Path $taskPrefix 'bin\cmake.exe') --build $BuildDirectory --parallel 4
if ($LASTEXITCODE) { exit $LASTEXITCODE }
if ($RunTests -or $DesktopTests) {
  & npm.cmd run build --prefix (Join-Path $taskSource 'coordinator')
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
  & (Join-Path $taskPrefix 'bin\ctest.exe') --test-dir $BuildDirectory --output-on-failure -LE render
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
}
if ($DesktopTests) {
  if (-not $MediaFixtures -or -not (Test-Path -LiteralPath (Join-Path $MediaFixtures 'tracks.mkv'))) {
    throw 'DesktopTests requires generated media fixtures. Pass -MediaFixtures; see generate-media-fixtures.py.'
  }
  $env:WATCHPAIR_MEDIA_FIXTURES = (Resolve-Path -LiteralPath $MediaFixtures).Path
  $env:WATCHPAIR_MEDIA_OUTPUT = Join-Path $BuildDirectory 'media-validation'
  & (Join-Path $taskPrefix 'bin\ctest.exe') --test-dir $BuildDirectory --output-on-failure -L render
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
}
Write-Output (Join-Path $BuildDirectory 'desktop\watchpair.exe')
