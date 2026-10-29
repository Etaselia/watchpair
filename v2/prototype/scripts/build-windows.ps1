param(
  [string]$MsysRoot = (Join-Path $env:TEMP 'watchpair-v2-native\msys64'),
  [string]$BuildDirectory = '',
  [switch]$RunTests
)
$ErrorActionPreference = 'Stop'
$taskSource = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$taskPrefix = Join-Path $MsysRoot 'ucrt64'
if (-not (Test-Path -LiteralPath (Join-Path $taskPrefix 'bin\cmake.exe'))) {
  throw 'Set -MsysRoot to an MSYS2 installation with the UCRT64 dependencies listed in README.md.'
}
if (-not $BuildDirectory) { $BuildDirectory = Join-Path $taskSource '..\..\outputs\v2\windows-build' }
$env:Path = (Join-Path $taskPrefix 'bin') + ';' + $env:Path
& (Join-Path $taskPrefix 'bin\cmake.exe') -S $taskSource -B $BuildDirectory -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo "-DCMAKE_PREFIX_PATH=$taskPrefix"
if ($LASTEXITCODE) { exit $LASTEXITCODE }
& (Join-Path $taskPrefix 'bin\cmake.exe') --build $BuildDirectory --parallel 4
if ($LASTEXITCODE) { exit $LASTEXITCODE }
if ($RunTests) {
  & (Join-Path $taskPrefix 'bin\ctest.exe') --test-dir $BuildDirectory --output-on-failure
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
}
Write-Output (Join-Path $BuildDirectory 'watchpair-v2-prototype.exe')
