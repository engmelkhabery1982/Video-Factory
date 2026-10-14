#Requires -Version 5.1
param([string]$LocalRoot='F:\VideoFactory_Models\LocalGeneration')
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$configFile=Join-Path $LocalRoot 'config\local-generation.env.ps1'
if(Test-Path -LiteralPath $configFile){
  . $configFile
  $healthy=$false
  try { $response=Invoke-WebRequest -Uri ($env:LOCAL_LLM_URL+'/health') -UseBasicParsing -TimeoutSec 3; $healthy=$response.StatusCode -eq 200 } catch { }
  if(-not $healthy){
    & (Join-Path $PSScriptRoot 'Setup-LocalGeneration.ps1') -Root $LocalRoot -StartPlanner -Health
    if($LASTEXITCODE -ne 0){throw 'Local planner did not start. See the setup report. No downloads were attempted.'}
  }
} else {
  Write-Host 'Local generation is not configured yet. The editor and supplied-media paths remain available.'
}
Set-Location -LiteralPath $repo
Start-Process 'http://localhost:3000'
& node.exe --import tsx apps/api/src/server.ts
exit $LASTEXITCODE
