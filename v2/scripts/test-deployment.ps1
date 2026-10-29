param([string]$Image='watchpair-v2-smoke:local', [string]$OutputDirectory='')
$ErrorActionPreference='Stop'
$taskRepo=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
if(-not $OutputDirectory){$OutputDirectory=Join-Path $taskRepo ('outputs\v2\deployment-'+[guid]::NewGuid().ToString('N').Substring(0,8))}
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
$OutputDirectory=(Resolve-Path -LiteralPath $OutputDirectory).Path
$taskId='wp-v2-test-'+[guid]::NewGuid().ToString('N').Substring(0,8)
$taskContainers=@(); $taskVolumes=@()
function Invoke-Docker([string[]]$Arguments){
  $taskResult=& docker @Arguments
  if($LASTEXITCODE){throw ('Docker failed: '+($Arguments | Select-Object -First 2) -join ' ')}
  return $taskResult
}
$taskListener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
$taskListener.Start(); $taskPort=$taskListener.LocalEndpoint.Port; $taskListener.Stop()
$taskSecret=[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$taskState=Join-Path $OutputDirectory 'private-smoke-state.json'
$taskBackup=Join-Path $OutputDirectory 'online-backup.sqlite'
try {
  [void](Invoke-Docker @('network','create',$taskId))
  foreach($taskSuffix in @('rooms','restored','caddy')){
    $taskVolume=$taskId+'-'+$taskSuffix
    [void](Invoke-Docker @('volume','create',$taskVolume)); $taskVolumes+=$taskVolume
  }
  $taskCoordinator=$taskId+'-coordinator'; $taskRelay=$taskId+'-relay'; $taskEdge=$taskId+'-edge'; $taskRestored=$taskId+'-restored'
  $taskContainers=@($taskCoordinator,$taskRelay,$taskEdge,$taskRestored)
  $taskSecurity=@('--read-only','--tmpfs','/tmp','--cap-drop','ALL','--security-opt','no-new-privileges:true')
  [void](Invoke-Docker (@('run','-d','--init','--name',$taskCoordinator,'--network',$taskId,'--network-alias','coordinator',
    '-v',($taskId+'-rooms:/data'),'-e','HOST=0.0.0.0','-e','PORT=8787','-e','WATCHPAIR_TRUST_PROXY=true',
    '-e','WATCHPAIR_DATABASE=/data/watchpair-v2.sqlite','-e',('WATCHPAIR_RELAY_URL=https://localhost:'+$taskPort),
    '-e',('WATCHPAIR_RELAY_SECRET='+$taskSecret))+$taskSecurity+@($Image)))
  [void](Invoke-Docker (@('run','-d','--init','--name',$taskRelay,'--network',$taskId,'--network-alias','relay',
    '-e','WATCHPAIR_RELAY_HOST=0.0.0.0','-e',('WATCHPAIR_RELAY_SECRET='+$taskSecret))+$taskSecurity+@($Image,'node','dist/src/relay-main.js')))
  $taskCaddy=Join-Path $OutputDirectory 'Caddyfile'
  @'
https://localhost {
  tls internal
  handle /v2/relay/* {
    reverse_proxy relay:8788
  }
  handle {
    reverse_proxy coordinator:8787 {
      header_up X-Forwarded-For {remote_host}
    }
  }
}
'@ | Set-Content -LiteralPath $taskCaddy -Encoding utf8
  [void](Invoke-Docker @('run','-d','--name',$taskEdge,'--network',$taskId,'-p',('127.0.0.1:'+$taskPort+':443'),
    '-v',($taskCaddy+':/etc/caddy/Caddyfile:ro'),'-v',($taskId+'-caddy:/data'),'caddy:2'))
  $taskCa=Join-Path $OutputDirectory 'local-test-ca.pem'
  for($taskAttempt=0;$taskAttempt -lt 60;$taskAttempt++){
    & docker cp ($taskEdge+':/data/caddy/pki/authorities/local/root.crt') $taskCa 2>$null
    if($LASTEXITCODE -eq 0){break}
    Start-Sleep -Milliseconds 500
  }
  if(-not (Test-Path -LiteralPath $taskCa)){throw 'The local TLS authority did not initialize.'}
  $taskPreviousCa=$env:NODE_EXTRA_CA_CERTS
  $env:NODE_EXTRA_CA_CERTS=$taskCa
  & node (Join-Path $PSScriptRoot 'deployment-smoke.mjs') ('https://localhost:'+$taskPort) $taskState create
  if($LASTEXITCODE){throw 'Container HTTPS/WebSocket/relay smoke failed.'}
  [void](Invoke-Docker @('exec',$taskCoordinator,'node','dist/src/backup.js','/data/online-backup.sqlite'))
  [void](Invoke-Docker @('cp',($taskCoordinator+':/data/online-backup.sqlite'),$taskBackup))
  [void](Invoke-Docker @('restart',$taskCoordinator))
  Start-Sleep -Seconds 1
  & node (Join-Path $PSScriptRoot 'deployment-smoke.mjs') ('https://localhost:'+$taskPort) $taskState verify
  if($LASTEXITCODE){throw 'Container restart persistence failed.'}
  [void](Invoke-Docker @('stop',$taskCoordinator))
  [void](Invoke-Docker @('network','disconnect',$taskId,$taskCoordinator))
  [void](Invoke-Docker (@('create','--init','--name',$taskRestored,'--network',$taskId,'--network-alias','coordinator',
    '-v',($taskId+'-restored:/data'),'-e','HOST=0.0.0.0','-e','PORT=8787','-e','WATCHPAIR_TRUST_PROXY=true',
    '-e','WATCHPAIR_DATABASE=/data/watchpair-v2.sqlite','-e',('WATCHPAIR_RELAY_URL=https://localhost:'+$taskPort),
    '-e',('WATCHPAIR_RELAY_SECRET='+$taskSecret))+$taskSecurity+@($Image)))
  [void](Invoke-Docker @('cp',$taskBackup,($taskRestored+':/data/watchpair-v2.sqlite')))
  [void](Invoke-Docker @('run','--rm','--user','root','-v',($taskId+'-restored:/data'),$Image,'sh','-c','chown node:node /data/watchpair-v2.sqlite'))
  [void](Invoke-Docker @('start',$taskRestored))
  Start-Sleep -Seconds 1
  & node (Join-Path $PSScriptRoot 'deployment-smoke.mjs') ('https://localhost:'+$taskPort) $taskState verify
  if($LASTEXITCODE){throw 'Container backup restore failed.'}
  Write-Output 'PASS: read-only Node containers, verified Caddy TLS, relay, WebSockets, restart and fresh-volume online-backup restore.'
} finally {
  $env:NODE_EXTRA_CA_CERTS=$taskPreviousCa
  foreach($taskContainer in $taskContainers){& docker logs $taskContainer *> (Join-Path $OutputDirectory ($taskContainer+'.log')); & docker rm -f $taskContainer *> $null}
  foreach($taskVolume in $taskVolumes){& docker volume rm $taskVolume *> $null}
  & docker network rm $taskId *> $null
  foreach($taskPrivate in @($taskState,$taskBackup)){if(Test-Path -LiteralPath $taskPrivate){Remove-Item -LiteralPath $taskPrivate}}
}
