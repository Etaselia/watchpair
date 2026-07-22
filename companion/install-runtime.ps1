$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Runtime = Join-Path $Root "runtime"
if (Test-Path (Join-Path $Runtime "node.exe")) { exit 0 }

$Releases = Invoke-RestMethod "https://nodejs.org/dist/index.json"
$Release = ($Releases | Where-Object { $_.version -like "v24.*" } | Select-Object -First 1)
if (-not $Release) { throw "Could not find a Node.js 24 release." }
$Version = [string]$Release.version
if ($Version -notmatch '^v24\.\d+\.\d+$') { throw "Node.js returned an invalid release version: $Version" }
if ($Release.files -notcontains "win-x64-zip") { throw "Node.js $Version does not provide a Windows x64 ZIP." }
$ArchiveName = "node-$Version-win-x64.zip"
$BaseUrl = "https://nodejs.org/dist/$Version"
$Temp = Join-Path $Root ".runtime-download"
$Archive = Join-Path $Temp $ArchiveName
$ChecksumFile = Join-Path $Temp "SHASUMS256.txt"
$Stage = Join-Path $Temp "expanded"

if (Test-Path $Temp) { Remove-Item -LiteralPath $Temp -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Temp | Out-Null
Invoke-WebRequest "$BaseUrl/$ArchiveName" -OutFile $Archive -UseBasicParsing
Invoke-WebRequest "$BaseUrl/SHASUMS256.txt" -OutFile $ChecksumFile -UseBasicParsing
$Checksums = Get-Content -LiteralPath $ChecksumFile -Raw
$Pattern = "(?m)^([a-f0-9]{64})\s+\*?" + [regex]::Escape($ArchiveName) + '$'
$Match = [regex]::Match($Checksums, $Pattern)
if (-not $Match.Success) { throw "Could not verify the Node.js archive checksum." }
$Expected = $Match.Groups[1].Value.ToLowerInvariant()
$Actual = (Get-FileHash -Algorithm SHA256 $Archive).Hash.ToLowerInvariant()
if ($Actual -ne $Expected) { throw "The Node.js archive checksum did not match." }

New-Item -ItemType Directory -Force -Path $Stage | Out-Null
Expand-Archive -LiteralPath $Archive -DestinationPath $Stage -Force
$Expanded = Get-ChildItem -LiteralPath $Stage -Directory | Select-Object -First 1
if (-not $Expanded) { throw "The Node.js archive was empty." }
if (Test-Path $Runtime) { Remove-Item -LiteralPath $Runtime -Recurse -Force }
Move-Item -LiteralPath $Expanded.FullName -Destination $Runtime
Remove-Item -LiteralPath $Temp -Recurse -Force
