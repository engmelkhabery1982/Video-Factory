#Requires -Version 5.1
<#
.SYNOPSIS
  Local still images (stable-diffusion.cpp) and the local planner (llama.cpp, loopback) for the Video Factory.

.DESCRIPTION
  One explicit script. Nothing runs at application startup, and nothing here runs on the application's behalf.

  Without a step switch the script only runs the PREFLIGHT: it reads the machine and prints what it would do.
  It downloads nothing, installs nothing, and writes no files.

  -Download -AcceptModelLicence   Opt-in. Fetches the four pinned files (about 3.3 GB) into <Root>\downloads.
                                  Each file is kept only if its size AND SHA-256 match the pin. Otherwise it is
                                  deleted and the script stops.
  -Install                        Extracts the two runtime zips, checks that the runtime prints every flag the
                                  factory passes, checks the model digest against the pin, and writes the
                                  configuration file <Root>\config\local-generation.env.ps1.
  -StartPlanner                   Starts llama-server bound to 127.0.0.1 only and waits for GET /health to return 200.
  -Health                         Re-checks files, flags, model digest and the planner, without changing anything.

  Google is not used here. Images run on this PC. Planning runs on this PC, on the loopback address only.
  The script never reads, prints, or stores an API key.

  Evidence limits: the pinned hashes come from upstream metadata (GitHub release digests and the Hugging Face
  LFS object ids). They were not produced by downloading the files in the build sandbox. The download step
  computes the real digest on your machine and refuses any file that does not match.

.PARAMETER Root
  Working folder for runtime, weights, config, and reports. Keep it outside Git (default F:\VideoFactory).

.PARAMETER PlannerPort
  Loopback port for llama-server (default 8080).

.PARAMETER Yes
  Skips the typed confirmation before downloads. Use only in a script you have read.

.EXAMPLE
  .\Setup-LocalGeneration.ps1 -Root F:\VideoFactory
  Preflight only. Changes nothing.

.EXAMPLE
  .\Setup-LocalGeneration.ps1 -Root F:\VideoFactory -Download -AcceptModelLicence -Install -StartPlanner -Health
#>
[CmdletBinding()]
param(
  [string]$Root = 'F:\VideoFactory',
  [switch]$Download,
  [switch]$AcceptModelLicence,
  [switch]$Install,
  [switch]$StartPlanner,
  [switch]$Health,
  [int]$PlannerPort = 8080,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

# ---------------------------------------------------------------------------
# Pins. Each value was read from upstream metadata at the stated commit or release.
# Do not edit these to match a different file. Re-review the pin instead.
# ---------------------------------------------------------------------------
$Pins = @{
  SdZip = @{
    Label  = 'stable-diffusion.cpp master-964-1d0a58a, Windows x64 CPU zip (MIT, binary sd-cli.exe)'
    Url    = 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-964-1d0a58a/sd-master-1d0a58a-bin-win-cpu-x64.zip'
    File   = 'sd-master-1d0a58a-bin-win-cpu-x64.zip'
    Bytes  = 17574585
    Sha256 = '8e4e7bde781ff246817019a182040a087314caf4d21bc15fe4ff045167bd336d'
  }
  LlamaZip = @{
    Label  = 'llama.cpp b11429, Windows x64 CPU zip (MIT, llama-server.exe)'
    Url    = 'https://github.com/ggml-org/llama.cpp/releases/download/b11429/llama-b11429-bin-win-cpu-x64.zip'
    File   = 'llama-b11429-bin-win-cpu-x64.zip'
    Bytes  = 19398918
    Sha256 = '1283323272b04cd07905816a597a0da810918102de958f4ff6f7bbaa70ed2efe'
  }
  SdModel = @{
    Label   = 'Stable Diffusion v1.5 FP16 (Comfy-Org archive, commit 9cfd069)'
    Url     = 'https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive/resolve/9cfd069101959ca3828bf9c04a4419870832b74f/v1-5-pruned-emaonly-fp16.safetensors'
    File    = 'v1-5-pruned-emaonly-fp16.safetensors'
    Bytes   = 2132696762
    Sha256  = 'e9476a13728cd75d8279f6ec8bad753a66a1957ca375a1464dc63b37db6e3916'
    Licence = 'CreativeML Open RAIL-M (use restrictions apply; you must accept them)'
  }
  PlannerModel = @{
    Label   = 'Qwen2.5-1.5B-Instruct Q4_K_M GGUF (Qwen repo, commit 91cad51)'
    Url     = 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/91cad51170dc346986eccefdc2dd33a9da36ead9/qwen2.5-1.5b-instruct-q4_k_m.gguf'
    File    = 'qwen2.5-1.5b-instruct-q4_k_m.gguf'
    Bytes   = 1117320736
    Sha256  = '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e'
    Licence = 'Apache-2.0 (LICENSE file at commit 91cad51)'
  }
}
$SdFlags = @('-m', '-p', '-n', '-W', '-H', '-s', '-o', '--steps', '--cfg-scale')
$LlamaFlags = @('-m', '--host', '--port', '-c')
$MinFreeBytes = 6GB
$MinRamBytes = 12GB

# ---------------------------------------------------------------------------
# Paths and report state
# ---------------------------------------------------------------------------
$Dl       = Join-Path $Root 'downloads'
$RtSd     = Join-Path $Root 'runtime\sd-cpu'
$RtLlama  = Join-Path $Root 'runtime\llama-cpu'
$Models   = Join-Path $Root 'models'
$Cfg      = Join-Path $Root 'config'
$Reports  = Join-Path $Root 'reports'
$RunDir   = Join-Path $Root 'run'
$ImgRoot  = Join-Path $Root 'local-images'
$EnvFile  = Join-Path $Cfg 'local-generation.env.ps1'
$Stamp    = Get-Date -Format 'yyyyMMdd-HHmmss'
$Results  = New-Object System.Collections.ArrayList
$Failed   = $false

function Add-Result([string]$Step, [string]$Check, [string]$Status, [string]$Detail) {
  [void]$Results.Add([pscustomobject]@{ Step = $Step; Check = $Check; Status = $Status; Detail = $Detail })
  $colour = switch ($Status) { 'OK' { 'Green' } 'WARN' { 'Yellow' } 'SKIP' { 'Gray' } default { 'Red' } }
  Write-Host ("[{0}] {1}: {2} - {3}" -f $Status, $Step, $Check, $Detail) -ForegroundColor $colour
  if ($Status -eq 'FAIL') { $script:Failed = $true }
}

function Get-Sha256Lower([string]$Path) {
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Save-Report {
  if (-not (Test-Path -LiteralPath $Reports)) { New-Item -ItemType Directory -Force -Path $Reports | Out-Null }
  $json = Join-Path $Reports "setup-report-$Stamp.json"
  $md   = Join-Path $Reports "setup-report-$Stamp.md"
  $Results | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $json -Encoding UTF8
  $lines = @('# Local generation setup report', '', "Run: $Stamp", "Root: $Root", '', '| Step | Check | Status | Detail |', '|---|---|---|---|')
  foreach ($r in $Results) { $lines += ("| {0} | {1} | {2} | {3} |" -f $r.Step, $r.Check, $r.Status, ($r.Detail -replace '\|', '/')) }
  $lines += ''
  $lines += 'Google: not used by this script. Local image generation and local planning run on this PC.'
  $lines += 'The digests in the Download step are computed from the files on this PC and compared with the pins.'
  Set-Content -LiteralPath $md -Value $lines -Encoding UTF8
  Write-Host "Report written: $md" -ForegroundColor Cyan
}

function Get-FreeBytes([string]$Path) {
  $qualifier = [System.IO.Path]::GetPathRoot($Path).TrimEnd('\')
  $drive = Get-PSDrive -Name $qualifier.TrimEnd(':') -ErrorAction SilentlyContinue
  if ($null -eq $drive) { return -1 }
  return [int64]$drive.Free
}

function Test-PortListening([int]$Port) {
  try {
    $c = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop
    return @($c)
  } catch { return @() }
}

# ---------------------------------------------------------------------------
# 1. Preflight (read-only)
# ---------------------------------------------------------------------------
function Invoke-Preflight {
  Write-Host ''
  Write-Host '== Preflight (read-only) ==' -ForegroundColor Cyan
  $ps = $PSVersionTable.PSVersion
  if ($ps.Major -ge 5) { Add-Result 'preflight' 'PowerShell' 'OK' "version $ps" } else { Add-Result 'preflight' 'PowerShell' 'FAIL' "version $ps; need 5.1 or later" }
  if ([Environment]::Is64BitOperatingSystem) { Add-Result 'preflight' '64-bit Windows' 'OK' 'yes' } else { Add-Result 'preflight' '64-bit Windows' 'FAIL' 'a 64-bit system is required' }

  $cs = Get-CimInstance Win32_ComputerSystem
  $ram = [int64]$cs.TotalPhysicalMemory
  $ramGiB = [math]::Round($ram / 1GB, 1)
  if ($ram -ge $MinRamBytes) { Add-Result 'preflight' 'RAM' 'OK' "$ramGiB GiB" } else { Add-Result 'preflight' 'RAM' 'WARN' "$ramGiB GiB; under 12 GiB the CPU run may swap" }

  $gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name })
  Add-Result 'preflight' 'Display adapters (information only)' 'OK' ($gpus -join '; ')
  Add-Result 'preflight' 'Backend' 'OK' 'CPU is the baseline. No CUDA or GPU speed is assumed or promised.'

  $drive = [System.IO.Path]::GetPathRoot($Root)
  $free = Get-FreeBytes $Root
  if ($free -lt 0) {
    Add-Result 'preflight' "Drive $drive" 'FAIL' 'drive not found. Pass -Root with a folder on an existing drive.'
  } elseif ($free -ge $MinFreeBytes) {
    Add-Result 'preflight' "Free space on $drive" 'OK' ("{0} GiB free; about 3.3 GB of downloads plus extraction needs about 6 GB" -f [math]::Round($free / 1GB, 1))
  } else {
    Add-Result 'preflight' "Free space on $drive" 'FAIL' ("{0} GiB free; need about 6 GB" -f [math]::Round($free / 1GB, 1))
  }

  $listeners = Test-PortListening $PlannerPort
  if ($listeners.Count -eq 0) { Add-Result 'preflight' "Port $PlannerPort" 'OK' 'free' }
  else { Add-Result 'preflight' "Port $PlannerPort" 'WARN' 'already listening. Stop that process or pass -PlannerPort.' }

  $rootState = if (Test-Path -LiteralPath $Root) { 'exists' } else { 'will be created on -Download or -Install' }
  Add-Result 'preflight' 'Root folder' 'OK' "$Root ($rootState)"
  Add-Result 'preflight' 'Git' 'OK' 'nothing here is written under the repository. Keep F:\ outside Git.'
}

# ---------------------------------------------------------------------------
# 2. Download (opt-in, verified)
# ---------------------------------------------------------------------------
function Save-Pinned([hashtable]$Pin, [string]$Dest) {
  if (Test-Path -LiteralPath $Dest) {
    $size = (Get-Item -LiteralPath $Dest).Length
    if ($size -eq $Pin.Bytes -and (Get-Sha256Lower $Dest) -eq $Pin.Sha256) { return 'already present, size and SHA-256 match the pin' }
    throw "$($Pin.File) is present but does not match the pinned size or SHA-256. Move it aside and run again. Nothing was overwritten."
  }
  $partial = "$Dest.partial"
  if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
  Invoke-WebRequest -Uri $Pin.Url -OutFile $partial -UseBasicParsing -MaximumRedirection 10
  $got = (Get-Item -LiteralPath $partial).Length
  if ($got -ne $Pin.Bytes) {
    Remove-Item -LiteralPath $partial -Force
    throw "$($Pin.File): size $got bytes, pinned $($Pin.Bytes). Deleted. Do not use it."
  }
  $digest = Get-Sha256Lower $partial
  if ($digest -ne $Pin.Sha256) {
    Remove-Item -LiteralPath $partial -Force
    throw "$($Pin.File): SHA-256 $digest, pinned $($Pin.Sha256). Deleted. Do not use it."
  }
  Move-Item -LiteralPath $partial -Destination $Dest
  return "downloaded; computed SHA-256 $digest matches the pin"
}

function Invoke-Download {
  Write-Host ''
  Write-Host '== Download (opt-in) ==' -ForegroundColor Cyan
  if (-not $AcceptModelLicence) { throw 'Downloading needs -AcceptModelLicence. The SD weights are CreativeML Open RAIL-M, with use restrictions you must accept.' }
  $total = $Pins.SdZip.Bytes + $Pins.LlamaZip.Bytes + $Pins.SdModel.Bytes + $Pins.PlannerModel.Bytes
  Write-Host ("About {0:N2} GB from these pinned URLs:" -f ($total / 1GB))
  foreach ($k in @('SdZip', 'LlamaZip', 'SdModel', 'PlannerModel')) { Write-Host ("  {0}`n    {1}" -f $Pins[$k].Label, $Pins[$k].Url) }
  if (-not $Yes) {
    $answer = Read-Host "Type YES to download into $Dl"
    if ($answer -ne 'YES') { throw 'Cancelled. Nothing was downloaded.' }
  }
  New-Item -ItemType Directory -Force -Path $Dl, $Models | Out-Null
  foreach ($k in @('SdZip', 'LlamaZip')) {
    $msg = Save-Pinned $Pins[$k] (Join-Path $Dl $Pins[$k].File)
    Add-Result 'download' $Pins[$k].File 'OK' $msg
  }
  $msg = Save-Pinned $Pins.SdModel (Join-Path $Models $Pins.SdModel.File)
  Add-Result 'download' $Pins.SdModel.File 'OK' $msg
  $msg = Save-Pinned $Pins.PlannerModel (Join-Path $Models $Pins.PlannerModel.File)
  Add-Result 'download' $Pins.PlannerModel.File 'OK' $msg
}

# ---------------------------------------------------------------------------
# 3. Install (extract, flag check, configuration)
# ---------------------------------------------------------------------------
function Find-Exe([string]$Dir, [string]$Name) {
  $hit = Get-ChildItem -LiteralPath $Dir -Recurse -Filter $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $hit) { return $null }
  return $hit.FullName
}

function Test-FlagsPrinted([string]$Exe, [string[]]$Flags, [string]$HelpArg, [string]$SaveAs) {
  # Native tools may write help to stderr. Under Stop, PowerShell 5.1 would turn that into a terminating error.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $text = (& $Exe $HelpArg 2>&1 | Out-String) } finally { $ErrorActionPreference = $previous }
  Set-Content -LiteralPath $SaveAs -Value $text -Encoding UTF8
  $missing = @()
  foreach ($f in $Flags) {
    $pattern = '(^|\s)' + [regex]::Escape($f) + '(\s|,|$)'
    if ($text -notmatch $pattern) { $missing += $f }
  }
  return ,$missing
}

function Invoke-Install {
  Write-Host ''
  Write-Host '== Install (extract, check flags, write configuration) ==' -ForegroundColor Cyan
  foreach ($pair in @(@{ Zip = 'SdZip'; Dir = $RtSd }, @{ Zip = 'LlamaZip'; Dir = $RtLlama })) {
    $zip = Join-Path $Dl $Pins[$pair.Zip].File
    if (-not (Test-Path -LiteralPath $zip)) { throw "Missing $($Pins[$pair.Zip].File). Run with -Download first." }
    if ((Get-Item -LiteralPath $zip).Length -ne $Pins[$pair.Zip].Bytes -or (Get-Sha256Lower $zip) -ne $Pins[$pair.Zip].Sha256) {
      throw "$($Pins[$pair.Zip].File) does not match its pin. Not extracted."
    }
    New-Item -ItemType Directory -Force -Path $pair.Dir | Out-Null
    Expand-Archive -LiteralPath $zip -DestinationPath $pair.Dir -Force
    Add-Result 'install' "Extracted $($Pins[$pair.Zip].File)" 'OK' $pair.Dir
  }

  $sdCli = Find-Exe $RtSd 'sd-cli.exe'
  if ($null -eq $sdCli) { throw 'sd-cli.exe was not found in the extracted runtime.' }
  $sdMissing = Test-FlagsPrinted $sdCli $SdFlags '-h' (Join-Path $Reports "sd-cli-help-$Stamp.txt")
  if ($sdMissing.Count -eq 0) { Add-Result 'install' 'sd-cli flags' 'OK' ("printed by sd-cli -h: " + ($SdFlags -join ' ')) }
  else { throw ("sd-cli -h does not print: " + ($sdMissing -join ' ') + '. Stop: the adapter must not be run against this build.') }

  $llama = Find-Exe $RtLlama 'llama-server.exe'
  if ($null -eq $llama) { throw 'llama-server.exe was not found in the extracted runtime.' }
  $llMissing = Test-FlagsPrinted $llama $LlamaFlags '--help' (Join-Path $Reports "llama-server-help-$Stamp.txt")
  if ($llMissing.Count -eq 0) { Add-Result 'install' 'llama-server flags' 'OK' ($LlamaFlags -join ' ') }
  else { throw ("llama-server --help does not print: " + ($llMissing -join ' ')) }

  $modelPath = Join-Path $Models $Pins.SdModel.File
  $modelDigest = Get-Sha256Lower $modelPath
  if ($modelDigest -ne $Pins.SdModel.Sha256) { throw "SD weights digest $modelDigest does not match the pin. Not configured." }
  Add-Result 'install' 'SD weights SHA-256' 'OK' "computed $modelDigest equals the pin"

  $gguf = Join-Path $Models $Pins.PlannerModel.File
  $ggufDigest = Get-Sha256Lower $gguf
  if ($ggufDigest -ne $Pins.PlannerModel.Sha256) { throw "Planner model digest $ggufDigest does not match the pin. Not configured." }
  Add-Result 'install' 'Planner GGUF SHA-256' 'OK' "computed $ggufDigest equals the pin"

  New-Item -ItemType Directory -Force -Path $Cfg, $ImgRoot | Out-Null
  $q = { param($v) "'" + ([string]$v).Replace("'", "''") + "'" }
  $lines = @(
    '# Generated by Setup-LocalGeneration.ps1. Contains no secrets. Keep this file outside Git.',
    '# Use: . ''' + $EnvFile + ''' in the window that starts the factory.',
    '$env:LOCAL_IMAGE_ENABLED = ''1''',
    ('$env:LOCAL_IMAGE_RUNNER = ' + (& $q $sdCli)),
    ('$env:LOCAL_IMAGE_MODEL = ' + (& $q $modelPath)),
    ('$env:LOCAL_IMAGE_MODEL_SHA256 = ' + (& $q $modelDigest)),
    '$env:LOCAL_IMAGE_BACKEND = ''cpu''',
    '$env:LOCAL_IMAGE_STEPS = ''20''',
    '$env:LOCAL_IMAGE_TIMEOUT_SEC = ''900''',
    ('$env:LOCAL_IMAGE_ROOT = ' + (& $q $ImgRoot)),
    '$env:LOCAL_LLM_ENABLED = ''1''',
    ('$env:LOCAL_LLM_URL = ' + (& $q ("http://127.0.0.1:$PlannerPort"))),
    '$env:LOCAL_LLM_MODEL = ''qwen2.5-1.5b-instruct-q4_k_m''',
    '$env:LOCAL_LLM_MODEL_LICENSE = ''Apache-2.0 (Qwen2.5-1.5B-Instruct-GGUF at commit 91cad51)''',
    '$env:LOCAL_LLM_TIMEOUT_SEC = ''180''',
    '$env:LOCAL_LLM_MAX_TOKENS = ''4096''',
    '# Google is not configured here. Optional speech keeps its own settings.'
  )
  Set-Content -LiteralPath $EnvFile -Value $lines -Encoding UTF8
  Add-Result 'install' 'Configuration' 'OK' $EnvFile
  # Keep the paths for the planner step in this session.
  $script:LlamaExe = $llama
  $script:GgufPath = $gguf
}

# ---------------------------------------------------------------------------
# 4. Planner launch (loopback only)
# ---------------------------------------------------------------------------
function Wait-PlannerHealthy([int]$TimeoutSec) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$PlannerPort/health" -UseBasicParsing -TimeoutSec 5
      if ($r.StatusCode -eq 200) { return $true }
    } catch { }
    Start-Sleep -Seconds 3
  }
  return $false
}

function Invoke-StartPlanner {
  Write-Host ''
  Write-Host '== Planner (llama-server, 127.0.0.1 only) ==' -ForegroundColor Cyan
  $llama = Find-Exe $RtLlama 'llama-server.exe'
  $gguf = Join-Path $Models $Pins.PlannerModel.File
  if ($null -eq $llama -or -not (Test-Path -LiteralPath $gguf)) { throw 'Planner files are missing. Run -Install first.' }
  if ((Test-PortListening $PlannerPort).Count -gt 0) { throw "Port $PlannerPort is already listening. Stop it or pass -PlannerPort." }
  New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
  $argLine = '-m "' + $gguf + '" --host 127.0.0.1 --port ' + $PlannerPort + ' -c 4096'
  $proc = Start-Process -FilePath $llama -ArgumentList $argLine -WorkingDirectory (Split-Path -Parent $llama) -WindowStyle Minimized -PassThru
  Set-Content -LiteralPath (Join-Path $RunDir 'llama-server.pid') -Value $proc.Id -Encoding ASCII
  Add-Result 'planner' 'llama-server started' 'OK' ("pid $($proc.Id), --host 127.0.0.1, port $PlannerPort")
  if (Wait-PlannerHealthy 180) { Add-Result 'planner' 'GET /health' 'OK' 'HTTP 200 {"status":"ok"}' }
  else {
    $state = if ($proc.HasExited) { "exited with code $($proc.ExitCode)" } else { 'still running but not healthy' }
    throw "llama-server did not report healthy within 180 seconds ($state)."
  }
}

# ---------------------------------------------------------------------------
# 5. Health (read-only, re-checks)
# ---------------------------------------------------------------------------
function Invoke-Health {
  Write-Host ''
  Write-Host '== Health ==' -ForegroundColor Cyan
  $sdCli = Find-Exe $RtSd 'sd-cli.exe'
  if ($sdCli) {
    $miss = Test-FlagsPrinted $sdCli $SdFlags '-h' (Join-Path $Reports "sd-cli-help-$Stamp.txt")
    if ($miss.Count -eq 0) { Add-Result 'health' 'sd-cli flags' 'OK' 'all flags printed' } else { Add-Result 'health' 'sd-cli flags' 'FAIL' ('missing: ' + ($miss -join ' ')) }
  } else { Add-Result 'health' 'sd-cli' 'FAIL' 'not installed' }

  $modelPath = Join-Path $Models $Pins.SdModel.File
  if (Test-Path -LiteralPath $modelPath) {
    $d = Get-Sha256Lower $modelPath
    if ($d -eq $Pins.SdModel.Sha256) { Add-Result 'health' 'SD weights SHA-256' 'OK' 'equals the pin' } else { Add-Result 'health' 'SD weights SHA-256' 'FAIL' "computed $d, pin differs" }
  } else { Add-Result 'health' 'SD weights' 'FAIL' 'not present' }

  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$PlannerPort/health" -UseBasicParsing -TimeoutSec 5
    if ($r.StatusCode -eq 200) { Add-Result 'health' 'Planner /health' 'OK' 'HTTP 200' } else { Add-Result 'health' 'Planner /health' 'WARN' "HTTP $($r.StatusCode)" }
  } catch {
    Add-Result 'health' 'Planner /health' 'WARN' 'not answering. Start it with -StartPlanner. Semantic planning is unavailable until then.'
  }
  $listen = Test-PortListening $PlannerPort
  if ($listen.Count -gt 0) {
    $addrs = ($listen | ForEach-Object { $_.LocalAddress } | Sort-Object -Unique) -join ', '
    if ($addrs -match '^(127\.0\.0\.1|::1)$') { Add-Result 'health' "Port $PlannerPort bind" 'OK' "listening on $addrs (loopback only)" }
    else { Add-Result 'health' "Port $PlannerPort bind" 'FAIL' "listening on $addrs. Not loopback-only. Stop it." }
  }
  Add-Result 'health' 'Factory check' 'SKIP' 'Start the factory with ". ''' + $EnvFile + '''" and open GET /api/local-images/status. Expect ready: true.'
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
$anyStep = $Download -or $Install -or $StartPlanner -or $Health
try {
  Invoke-Preflight
  if (-not $anyStep) {
    Write-Host ''
    Write-Host 'Preflight only. Nothing was downloaded, installed or written.' -ForegroundColor Cyan
    Write-Host 'Add -Download -AcceptModelLicence, then -Install, -StartPlanner and -Health.'
  } else {
    if ($Download) { Invoke-Download }
    if ($Install) { Invoke-Install }
    if ($StartPlanner) { Invoke-StartPlanner }
    if ($Health) { Invoke-Health }
  }
} catch {
  Add-Result 'stop' 'Error' 'FAIL' $_.Exception.Message
}

if ($anyStep) { Save-Report }
if ($Failed) {
  Write-Host ''
  Write-Host 'Setup did not finish. Read the FAIL lines above. Nothing unverified was used.' -ForegroundColor Red
  exit 1
}
Write-Host ''
Write-Host 'Done. Images and planning run on this PC. Google is not used.' -ForegroundColor Green
exit 0
