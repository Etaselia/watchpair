param(
  [string]$MsysRoot = (Join-Path $env:TEMP 'watchpair-v2-native\msys64'),
  [string]$BuildDirectory = '',
  [string]$SourceArchive = '',
  [int]$Parallel = 4
)
$ErrorActionPreference = 'Stop'
$taskWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$taskSdk = [IO.Path]::GetFullPath((Join-Path $MsysRoot 'ucrt64'))
if (-not $BuildDirectory) { $BuildDirectory = Join-Path $taskWorkspace 'outputs\v2\native-libtorrent-matched' }
if (-not $SourceArchive) {
  $SourceArchive = Join-Path $taskWorkspace 'outputs\v2\releases\source-companion\dependencies\msys2\mingw-w64-libtorrent-rasterbar-2.1.2-1.src.tar.zst'
}
$taskOutput = [IO.Path]::GetFullPath($BuildDirectory)
if (Test-Path -LiteralPath $taskOutput) { throw "Use a fresh build directory: $taskOutput" }
$taskArchive = (Resolve-Path -LiteralPath $SourceArchive).Path
$taskSourceHash = '40239915ee2f2773685fa86d70675be893b674159136463d2513ebb46101933b'
$taskUpstreamHash = '3362546d9cd71b9e49ee6cac7d3f1f914ce9cdb217c86b63d5b22cbed0334dbc'
if ((Get-FileHash -LiteralPath $taskArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskSourceHash) {
  throw 'The cached libtorrent 2.1.2-1 source package hash does not match the published source kit.'
}
$taskTar = Join-Path $taskSdk 'bin\bsdtar.exe'
$taskCmake = Join-Path $taskSdk 'bin\cmake.exe'
$taskCompiler = Join-Path $taskSdk 'bin\c++.exe'
$env:Path = (Join-Path $taskSdk 'bin') + ';' + $env:Path
$taskInputs = Join-Path $taskOutput 'inputs'
$taskSources = Join-Path $taskOutput 'source'
$taskBuild = Join-Path $taskOutput 'build'
$taskInstall = Join-Path $taskOutput 'prefix'
New-Item -ItemType Directory -Path $taskInputs, $taskSources | Out-Null
$taskMember = 'mingw-w64-libtorrent-rasterbar/libtorrent-rasterbar-2.1.2.tar.gz'
& $taskTar -xf $taskArchive -C $taskInputs $taskMember 'mingw-w64-libtorrent-rasterbar/PKGBUILD'
if ($LASTEXITCODE) { throw 'Could not extract the pinned source inputs.' }
$taskUpstream = Join-Path $taskInputs $taskMember
if ((Get-FileHash -LiteralPath $taskUpstream -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskUpstreamHash) {
  throw 'The upstream libtorrent source archive hash differs from its package recipe.'
}
& $taskTar -xf $taskUpstream -C $taskSources
if ($LASTEXITCODE) { throw 'Could not extract the upstream source.' }
$taskSource = Join-Path $taskSources 'libtorrent-rasterbar-2.1.2'
if (-not (Test-Path -LiteralPath (Join-Path $taskSource 'CMakeLists.txt'))) { throw 'Missing upstream CMake source.' }

# The package contained both Win32 and pthread Asio implementations in the
# same unversioned namespace. Pin one backend across every translation unit.
# Consumers must also define BOOST_ASIO_HAS_PTHREADS=1; this recipe does not
# modify the configured SDK or the application's CMake configuration.
$taskConfigure = @('-S', $taskSource, '-B', $taskBuild, '-G', 'Ninja',
  '-DCMAKE_BUILD_TYPE=Release', "-DCMAKE_INSTALL_PREFIX=$taskInstall", "-DCMAKE_PREFIX_PATH=$taskSdk",
  "-DCMAKE_CXX_COMPILER=$taskCompiler", '-DCMAKE_CXX_FLAGS=-DBOOST_ASIO_HAS_PTHREADS=1',
  '-DBUILD_SHARED_LIBS=ON', '-Dbuild_tests=OFF', '-Dbuild_examples=OFF', '-Dbuild_tools=OFF')
$taskPublicConfigure = foreach ($taskArgument in $taskConfigure) {
  $taskArgument.Replace($taskSource, '<SOURCE>').Replace($taskBuild, '<BUILD>').Replace($taskInstall, '<PREFIX>').Replace($taskSdk, '<SDK>')
}
$taskReceipt = [ordered]@{
  format = 1
  library = 'libtorrent-rasterbar'
  version = '2.1.2'
  upstreamVersion = '2.1.2'
  asioThreadBackend = 'pthread'
  compileDefinitions = @('BOOST_ASIO_HAS_PTHREADS=1')
  recipe = 'v2/scripts/build-libtorrent-matched.ps1'
  sourcePackage = [ordered]@{ name = [IO.Path]::GetFileName($taskArchive); sha256 = $taskSourceHash }
  upstreamSource = [ordered]@{ name = [IO.Path]::GetFileName($taskUpstream); sha256 = $taskUpstreamHash }
  sourceArchives = @(
    [ordered]@{ name = [IO.Path]::GetFileName($taskArchive); sha256 = $taskSourceHash },
    [ordered]@{ name = [IO.Path]::GetFileName($taskUpstream); sha256 = $taskUpstreamHash })
  applicationDefinition = 'BOOST_ASIO_HAS_PTHREADS=1'
  configureArguments = @($taskPublicConfigure)
  compiler = @(& $taskCompiler --version)[0]
  cmake = @(& $taskCmake --version)[0]
  sdkPackages = @()
  complete = $false
}
foreach ($taskPackage in @('boost', 'boost-libs', 'gcc', 'libstdc++', 'libwinpthread', 'openssl', 'libtorrent-rasterbar')) {
  $taskPackageDir = Get-ChildItem -LiteralPath (Join-Path $MsysRoot 'var\lib\pacman\local') -Directory |
    Where-Object { $_.Name -match ('^mingw-w64-ucrt-x86_64-' + [regex]::Escape($taskPackage) + '-[0-9]') }
  foreach ($taskDir in $taskPackageDir) {
    Copy-Item -LiteralPath (Join-Path $taskDir.FullName 'desc') -Destination (Join-Path $taskInputs ($taskPackage + '-package.txt'))
    $taskReceipt.sdkPackages += $taskDir.Name
  }
}
$taskReceiptPath = Join-Path $taskOutput 'build-receipt.json'
$taskReceipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $taskReceiptPath -Encoding utf8
& $taskCmake @taskConfigure 2>&1 | Tee-Object -FilePath (Join-Path $taskOutput 'configure.log')
if ($LASTEXITCODE) { throw 'Matched libtorrent configure failed.' }
& $taskCmake --build $taskBuild --parallel $Parallel 2>&1 | Tee-Object -FilePath (Join-Path $taskOutput 'build.log')
if ($LASTEXITCODE) { throw 'Matched libtorrent build failed.' }
& $taskCmake --install $taskBuild 2>&1 | Tee-Object -FilePath (Join-Path $taskOutput 'install.log')
if ($LASTEXITCODE) { throw 'Matched libtorrent install failed.' }
$taskDll = Join-Path $taskInstall 'bin\libtorrent-rasterbar.dll'
$taskReceipt.dll = [ordered]@{
  file = 'libtorrent-rasterbar.dll'
  relativePath = 'prefix/bin/libtorrent-rasterbar.dll'
  size = (Get-Item -LiteralPath $taskDll).Length
  sha256 = (Get-FileHash -LiteralPath $taskDll -Algorithm SHA256).Hash.ToLowerInvariant()
}
$taskReceipt.recipeSha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
$taskReceipt.complete = $true
$taskReceipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $taskReceiptPath -Encoding utf8
Copy-Item -LiteralPath $taskReceiptPath -Destination (Join-Path $taskInstall 'watchpair-libtorrent-build.json')
Write-Output "Experimental library: $taskDll"
Write-Output "Build receipt: $taskReceiptPath"
