# Resumable alignment entry point. Prepared code, not a completed alignment.
# Exit 0 means review files were written or reused. It is not listening approval.
# Exit 2 stops at the first failed prerequisite. Exit 3 means reboot, then rerun this same command.
# It does not render, publish, change the recording, or replace saved timings.
# It never unregisters a distribution other than a vf-align this run just failed to create.
#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

$ExpectedSha = 'dc8e6f2422be7777d0ddfab9fc5014cdd68090a5eb7489edf29ca5caa46bd6b7'
$ExpectedBytes = 2824364
$DataRoot = if ($env:VF_ALIGN_DATA) { $env:VF_ALIGN_DATA } else { 'F:\VideoFactory_Test_VS7_4ac181a\data' }
$Wav = if ($env:VF_ALIGN_WAV) { $env:VF_ALIGN_WAV } else { Join-Path $DataRoot 'voiceover\Rahman_Raheem_Test_01_long_7d51848161d4.wav' }
$Project = if ($env:VF_ALIGN_PROJECT) { $env:VF_ALIGN_PROJECT } else { Join-Path $DataRoot 'projects\Rahman_Raheem_Test_01\project.json' }
$State = if ($env:VF_ALIGN_STATE) { $env:VF_ALIGN_STATE } else { Join-Path $DataRoot 'projects\Rahman_Raheem_Test_01\voice-audio\state.json' }
$ModelRoot = if ($env:VF_ALIGN_HOME) { $env:VF_ALIGN_HOME } else { 'F:\VideoFactory_Models\omniASR' }
$DistroName = 'vf-align'
$CheckpointBytes = 1304065508
$TokenizerBytes = 91481
$CheckpointUrl = 'https://dl.fbaipublicfiles.com/mms/omniASR-CTC-300M-v2.pt'
$TokenizerUrl = 'https://dl.fbaipublicfiles.com/mms/omniASR_tokenizer_written_v2.model'
$SumsUrl = 'https://cloud-images.ubuntu.com/wsl/jammy/current/SHA256SUMS'
$RootfsName = 'ubuntu-jammy-wsl-amd64-wsl.rootfs.tar.gz'
$RootfsUrl = "https://cloud-images.ubuntu.com/wsl/jammy/current/$RootfsName"

function Test-Inside([string]$Parent, [string]$Child) {
    $p = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    $c = [IO.Path]::GetFullPath($Child).TrimEnd('\') + '\'
    return $c.StartsWith($p, [StringComparison]::OrdinalIgnoreCase)
}

function Stop-Stage([string]$Message, [int]$Code) {
    if ($script:RunLog -and (Test-Path -LiteralPath (Split-Path -Parent $script:RunLog))) {
        Add-Content -LiteralPath $script:RunLog -Value ("STOP exit={0} {1}" -f $Code, $Message)
    }
    Write-Host $Message
    exit $Code
}

function Add-Run([string]$Message) {
    Add-Content -LiteralPath $script:RunLog -Value $Message
    Write-Host $Message
}

function Read-ProcessText([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -eq 0) { return '' }
    if ($bytes.Length -ge 2 -and $bytes[0] -eq 255 -and $bytes[1] -eq 254) {
        return [Text.Encoding]::Unicode.GetString($bytes)
    }
    foreach ($b in $bytes) {
        if ($b -eq 0) { return [Text.Encoding]::Unicode.GetString($bytes) }
    }
    return [Text.Encoding]::UTF8.GetString($bytes)
}

function Invoke-Logged {
    param(
        [Parameter(Mandatory = $true)][string]$Stage,
        [Parameter(Mandatory = $true)][string]$FileName,
        [Parameter(Mandatory = $true)][string[]]$ArgumentList,
        [int]$TimeoutSec = 600
    )
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $safe = ($Stage -replace '[^A-Za-z0-9._-]', '_')
    $out = Join-Path $script:LogDir "$safe.$stamp.stdout.txt"
    $err = Join-Path $script:LogDir "$safe.$stamp.stderr.txt"
    Add-Run ("BEGIN {0} {1} {2}" -f $Stage, $FileName, ($ArgumentList -join ' '))
    $proc = Start-Process -FilePath $FileName -ArgumentList $ArgumentList -PassThru -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError $err
    if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
        try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
        Add-Run "END $Stage exit=timeout stdout=$out stderr=$err"
        Stop-Stage "BLOCKER=timeout stage=$Stage seconds=$TimeoutSec logs=$out" 2
    }
    $proc.WaitForExit()
    $code = $proc.ExitCode
    Add-Run "END $Stage exit=$code stdout=$out stderr=$err"
    return @{ Code = $code; Stdout = $out; Stderr = $err }
}

function Convert-ToWslPath([string]$WindowsPath) {
    $full = [IO.Path]::GetFullPath($WindowsPath)
    if ($full -notmatch '^([A-Za-z]):\\(.*)$') {
        Stop-Stage "BLOCKER=path_not_on_a_windows_drive path=$full" 2
    }
    $rest = $Matches[2] -replace '\\', '/'
    return "/mnt/$($Matches[1].ToLower())/$rest"
}

function Quote-Bash([string]$Text) {
    return "'" + ($Text -replace "'", "'\''") + "'"
}

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-Free([string]$Why) {
    $letter = $script:ModelRoot.Substring(0, 1)
    $drive = Get-PSDrive -Name $letter
    $need = 12GB
    if ($drive.Free -lt $need) {
        Stop-Stage "BLOCKER=low_disk drive=$letter free=$($drive.Free) need=$need why=$Why" 2
    }
}

function Parse-DistroText([string]$Text) {
    $rows = @()
    $clean = $Text -replace [char]0, ''
    foreach ($line in ($clean -split "`r`n|`n|`r")) {
        $trim = $line.Trim()
        if ($trim -eq '') { continue }
        if ($trim -match 'NAME' -and $trim -match 'VERSION') { continue }
        $isDefault = $trim.StartsWith('*')
        $trim = $trim.TrimStart('*').Trim()
        $parts = @($trim -split '\s+' | Where-Object { $_ -ne '' })
        if ($parts.Count -lt 3) { continue }
        if ($parts[-1] -notmatch '^\d+$') { continue }
        $name = ($parts[0..($parts.Count - 3)] -join ' ')
        if ($name -eq '') { continue }
        $rows += [pscustomobject]@{
            Name = $name
            State = $parts[-2]
            Version = [int]$parts[-1]
            Default = $isDefault
        }
    }
    return $rows
}

function Get-WslDistros {
    $result = Invoke-Logged -Stage 'wsl-list' -FileName $script:WslExe -ArgumentList @('-l', '-v') -TimeoutSec 90
    $text = Read-ProcessText $result.Stdout
    $err = Read-ProcessText $result.Stderr
    Set-Content -LiteralPath (Join-Path $script:LogDir 'wsl-list-latest.txt') -Value ($text + "`n" + $err) -Encoding UTF8
    if ($result.Code -ne 0) {
        $combined = "$text`n$err"
        if ($combined -match 'no installed distributions' -or $combined -match 'not installed') {
            return @()
        }
        Stop-Stage "BLOCKER=wsl_list_failed exit=$($result.Code)" 2
    }
    return @(Parse-DistroText $text)
}

function Assert-OtherDistrosPreserved($Before, $After) {
    foreach ($row in @($Before | Where-Object { $_.Name -ne $DistroName })) {
        $match = @($After | Where-Object { $_.Name -eq $row.Name })
        if ($match.Count -ne 1) {
            Stop-Stage "BLOCKER=unrelated_distro_missing name=$($row.Name) This script does not unregister other distributions." 2
        }
        if ($match[0].Version -ne $row.Version) {
            Stop-Stage "BLOCKER=unrelated_distro_version_changed name=$($row.Name) before=$($row.Version) after=$($match[0].Version)" 2
        }
    }
}

function Test-WslReady {
    $result = Invoke-Logged -Stage '01-wsl-status' -FileName $script:WslExe -ArgumentList @('--status') -TimeoutSec 90
    return $result.Code -eq 0
}

function Receive-File {
    param(
        [string]$Url,
        [string]$Dest,
        [int64]$ExpectedSize,
        [switch]$RequireZip,
        [string]$ExpectedSha
    )
    $manifest = "$Dest.sha256"
    if ((Test-Path -LiteralPath $Dest) -and $ExpectedSha) {
        $hash = (Get-FileHash -LiteralPath $Dest -Algorithm SHA256).Hash.ToLower()
        if ($hash -eq $ExpectedSha) {
            Set-Content -LiteralPath $manifest -Value $hash -NoNewline -Encoding ascii
            Add-Run "reused $Dest $hash"
            return
        }
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        Rename-Item -LiteralPath $Dest -NewName ((Split-Path -Leaf $Dest) + ".rejected-$stamp")
        Add-Run "quarantined hash mismatch $Dest"
    }
    if ((Test-Path -LiteralPath $Dest) -and $ExpectedSize -gt 0) {
        $len = (Get-Item -LiteralPath $Dest).Length
        if ($len -eq $ExpectedSize) {
            $hash = (Get-FileHash -LiteralPath $Dest -Algorithm SHA256).Hash.ToLower()
            if ($ExpectedSha -and $hash -ne $ExpectedSha) {
                $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
                Rename-Item -LiteralPath $Dest -NewName ((Split-Path -Leaf $Dest) + ".rejected-$stamp")
                Add-Run "quarantined hash mismatch $Dest"
            } elseif (Test-Path -LiteralPath $manifest) {
                $recorded = (Get-Content -LiteralPath $manifest -Raw).Trim().ToLower()
                if ($recorded -eq $hash) { Add-Run "reused $Dest $hash"; return }
                $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
                Rename-Item -LiteralPath $Dest -NewName ((Split-Path -Leaf $Dest) + ".rejected-$stamp")
                Add-Run "quarantined recorded-hash mismatch $Dest"
            } else {
                Set-Content -LiteralPath $manifest -Value $hash -NoNewline -Encoding ascii
                Add-Run "hashed_existing $Dest $hash"
                return
            }
        } else {
            $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
            Rename-Item -LiteralPath $Dest -NewName ((Split-Path -Leaf $Dest) + ".rejected-$stamp")
            Add-Run "quarantined size mismatch $Dest size=$len"
        }
    }
    $partial = "$Dest.partial"
    if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
    $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
    $result = Invoke-Logged -Stage 'download' -FileName $curl -ArgumentList @('-L', '--fail', '--retry', '3', '--retry-delay', '2', '-o', $partial, $Url) -TimeoutSec 3600
    if ($result.Code -ne 0 -or -not (Test-Path -LiteralPath $partial)) {
        Stop-Stage "BLOCKER=download_failed url=$Url" 2
    }
    $len = (Get-Item -LiteralPath $partial).Length
    if ($ExpectedSize -gt 0 -and $len -ne $ExpectedSize) {
        Stop-Stage "BLOCKER=download_size actual=$len expected=$ExpectedSize url=$Url" 2
    }
    if ($RequireZip) {
        $stream = [IO.File]::OpenRead($partial)
        try {
            $buf = New-Object byte[] 2
            $n = $stream.Read($buf, 0, 2)
            if ($n -ne 2 -or $buf[0] -ne 80 -or $buf[1] -ne 75) {
                Stop-Stage 'BLOCKER=checkpoint_not_torch_zip' 2
            }
        } finally { $stream.Close() }
    }
    $hash = (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLower()
    if ($ExpectedSha -and $hash -ne $ExpectedSha) {
        Stop-Stage "BLOCKER=download_sha256 actual=$hash expected=$ExpectedSha url=$Url" 2
    }
    Move-Item -LiteralPath $partial -Destination $Dest
    Set-Content -LiteralPath $manifest -Value $hash -NoNewline -Encoding ascii
    Add-Run "downloaded $Dest $hash"
}

function Assert-Wav {
    if (-not (Test-Path -LiteralPath $Wav)) { Stop-Stage "BLOCKER=wav_missing path=$Wav" 2 }
    $item = Get-Item -LiteralPath $Wav
    if ($item.Length -ne $ExpectedBytes) { Stop-Stage "BLOCKER=wav_size actual=$($item.Length) expected=$ExpectedBytes" 2 }
    $hash = (Get-FileHash -LiteralPath $Wav -Algorithm SHA256).Hash.ToLower()
    if ($hash -ne $ExpectedSha) { Stop-Stage "BLOCKER=wav_sha256 actual=$hash expected=$ExpectedSha" 2 }
    foreach ($path in @($Project, $State)) {
        if (-not (Test-Path -LiteralPath $path)) { Stop-Stage "BLOCKER=project_file_missing path=$path" 2 }
    }
    return $hash
}

function Sync-Helpers {
    $src = Quote-Bash (Convert-ToWslPath $PSScriptRoot)
    $cmd = 'mkdir -p /opt/vf-align/tools && cp ' + $src + '/setup_runtime.sh ' + $src + '/align_recording.py ' + $src + '/ctc_forced.py /opt/vf-align/tools/ && sed -i ''s/\r$//'' /opt/vf-align/tools/setup_runtime.sh /opt/vf-align/tools/align_recording.py /opt/vf-align/tools/ctc_forced.py'
    $result = Invoke-WslBash 'sync-helpers' $cmd 120
    if ($result.Code -ne 0) { Stop-Stage 'BLOCKER=helper_copy_failed The recording was not copied into WSL.' 2 }
}

function Invoke-WslBash([string]$Stage, [string]$Command, [int]$TimeoutSec) {
    $safe = ($Stage -replace '[^A-Za-z0-9._-]', '_')
    $scriptFile = Join-Path $script:LogDir "$safe.command.sh"
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [IO.File]::WriteAllText($scriptFile, (($Command -replace "`r", '') + "`n"), $utf8)
    $wslScript = Convert-ToWslPath $scriptFile
    return Invoke-Logged -Stage $Stage -FileName $script:WslExe -ArgumentList @('-d', $DistroName, '-u', 'root', '--', 'bash', $wslScript) -TimeoutSec $TimeoutSec
}

if ($env:OS -ne 'Windows_NT') { Stop-Stage 'BLOCKER=not_windows' 2 }
if (Test-Inside $DataRoot $ModelRoot) { Stop-Stage 'BLOCKER=model_dir_is_inside_project_data' 2 }
if (Test-Inside $ModelRoot $DataRoot) { Stop-Stage 'BLOCKER=project_data_is_inside_model_dir' 2 }
if (-not (Test-Path -LiteralPath ($ModelRoot.Substring(0, 2) + '\'))) {
    Stop-Stage "BLOCKER=model_drive_missing path=$ModelRoot" 2
}

$sha = Assert-Wav
$script:ReviewDir = Join-Path $ModelRoot 'review'
$script:LogDir = Join-Path $script:ReviewDir 'logs'
$script:StageDir = Join-Path $script:ReviewDir 'stages'
$script:RunLog = Join-Path $script:ReviewDir 'run.log'
$rebootMarker = Join-Path $script:ReviewDir 'reboot-required.txt'
New-Item -ItemType Directory -Force -Path $script:LogDir, $script:StageDir | Out-Null
Add-Run "wav_ok sha256=$sha bytes=$ExpectedBytes path=$Wav"
Add-Run 'This log is machine execution. A git commit is not alignment acceptance.'

$script:WslExe = Join-Path $env:SystemRoot 'System32\wsl.exe'
if (Test-Path -LiteralPath $rebootMarker) {
    if ((Test-Path -LiteralPath $script:WslExe) -and (Test-WslReady)) {
        Remove-Item -LiteralPath $rebootMarker -Force
        Add-Run 'reboot_checkpoint_cleared'
    } else {
        Stop-Stage 'BLOCKER=reboot_still_required Restart Windows, then run this same command again. No distribution was unregistered.' 3
    }
}
if (-not (Test-Path -LiteralPath $script:WslExe) -or -not (Test-WslReady)) {
    if (-not (Test-IsAdmin)) {
        Stop-Stage 'BLOCKER=wsl_not_ready_need_admin Rerun this same command in an elevated PowerShell. Nothing was installed and no distribution was changed.' 2
    }
    Assert-Free 'wsl-feature'
    $dism = Join-Path $env:SystemRoot 'System32\dism.exe'
    $r1 = Invoke-Logged -Stage '01-dism-wsl' -FileName $dism -ArgumentList @('/online', '/enable-feature', '/featurename:Microsoft-Windows-Subsystem-Linux', '/all', '/norestart') -TimeoutSec 900
    $r2 = Invoke-Logged -Stage '01-dism-vmp' -FileName $dism -ArgumentList @('/online', '/enable-feature', '/featurename:VirtualMachinePlatform', '/all', '/norestart') -TimeoutSec 900
    if (@(0, 3010) -notcontains $r1.Code -or @(0, 3010) -notcontains $r2.Code) {
        Stop-Stage "BLOCKER=wsl_feature_enable_failed wsl=$($r1.Code) vmp=$($r2.Code)" 2
    }
    $r3 = Invoke-Logged -Stage '01-wsl-install-no-distro' -FileName $script:WslExe -ArgumentList @('--install', '--no-distribution') -TimeoutSec 900
    $needsReboot = ($r1.Code -eq 3010 -or $r2.Code -eq 3010 -or $r3.Code -eq 3010 -or -not (Test-WslReady))
    if ($needsReboot) {
        Set-Content -LiteralPath $rebootMarker -Value ("reboot required {0}" -f (Get-Date -Format o)) -Encoding ascii
        Stop-Stage 'BLOCKER=reboot_required Restart Windows, then run this same command again. No distribution was installed or unregistered.' 3
    }
}
Set-Content -LiteralPath (Join-Path $script:StageDir '01-wsl-feature.ok') -Value 'wsl status ok' -Encoding ascii

$before = @(Get-WslDistros)
$before | ForEach-Object { Add-Run ("distro-before name={0} version={1} state={2}" -f $_.Name, $_.Version, $_.State) }
$ours = @($before | Where-Object { $_.Name -eq $DistroName })
if ($ours.Count -gt 1) { Stop-Stage 'BLOCKER=duplicate_vf_align_rows' 2 }
if ($ours.Count -eq 1 -and $ours[0].Version -eq 1) {
    $set = Invoke-Logged -Stage '02-set-version' -FileName $script:WslExe -ArgumentList @('--set-version', $DistroName, '2') -TimeoutSec 1800
    if ($set.Code -ne 0) { Stop-Stage 'BLOCKER=vf_align_set_version_failed The distro was not unregistered.' 2 }
    $ours = @(@(Get-WslDistros) | Where-Object { $_.Name -eq $DistroName })
}
if ($ours.Count -eq 1 -and $ours[0].Version -ne 2) {
    Stop-Stage "BLOCKER=vf_align_not_wsl2 version=$($ours[0].Version)" 2
}
if ($ours.Count -eq 0) {
    Assert-Free 'wsl-import'
    $rootfsDir = Join-Path $ModelRoot 'rootfs'
    $installDir = Join-Path $ModelRoot 'wsl-distro'
    New-Item -ItemType Directory -Force -Path $rootfsDir | Out-Null
    if ((Test-Path -LiteralPath $installDir) -and @(Get-ChildItem -LiteralPath $installDir -Force -ErrorAction SilentlyContinue).Count -gt 0) {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        Rename-Item -LiteralPath $installDir -NewName ("wsl-distro.rejected-$stamp")
        Add-Run "quarantined non-empty vf-align install dir; no distribution was unregistered by this rename"
    }
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    $sums = Join-Path $rootfsDir 'SHA256SUMS'
    if (Test-Path -LiteralPath $sums) { Remove-Item -LiteralPath $sums -Force }
    Receive-File -Url $SumsUrl -Dest $sums -ExpectedSize 0
    $sumLine = @(Get-Content -LiteralPath $sums | Where-Object { $_ -match 'ubuntu-jammy-wsl-amd64-wsl\.rootfs\.tar\.gz' })
    if ($sumLine.Count -ne 1 -or $sumLine[0] -notmatch '([0-9a-fA-F]{64})\s+\*?ubuntu-jammy-wsl-amd64-wsl\.rootfs\.tar\.gz\s*$') {
        Stop-Stage 'BLOCKER=ubuntu_sha256sums_missing_expected_rootfs Nothing was imported.' 2
    }
    $rootfsSha = $Matches[1].ToLower()
    $rootfs = Join-Path $rootfsDir $RootfsName
    Receive-File -Url $RootfsUrl -Dest $rootfs -ExpectedSize 0 -ExpectedSha $rootfsSha
    $imported = Invoke-Logged -Stage '02-import' -FileName $script:WslExe -ArgumentList @('--import', $DistroName, $installDir, $rootfs, '--version', '2') -TimeoutSec 900
    $afterImport = @(Get-WslDistros)
    if ($imported.Code -ne 0 -or @($afterImport | Where-Object { $_.Name -eq $DistroName }).Count -ne 1) {
        if (@($before | Where-Object { $_.Name -eq $DistroName }).Count -eq 0 -and @($afterImport | Where-Object { $_.Name -eq $DistroName }).Count -eq 1) {
            Invoke-Logged -Stage '02-unregister-failed-vf-align' -FileName $script:WslExe -ArgumentList @('--unregister', $DistroName) -TimeoutSec 180 | Out-Null
        }
        Stop-Stage 'BLOCKER=vf_align_import_failed Only a vf-align created by this failed import may have been unregistered.' 2
    }
    $bootCmd = "printf '%s\n' '[user]' 'default=root' > /etc/wsl.conf; cat /etc/os-release"
    $boot = Invoke-WslBash '02-first-launch' $bootCmd 180
    if ($boot.Code -ne 0) {
        Invoke-Logged -Stage '02-unregister-failed-first-launch' -FileName $script:WslExe -ArgumentList @('--unregister', $DistroName) -TimeoutSec 180 | Out-Null
        Stop-Stage 'BLOCKER=vf_align_first_launch_failed The dedicated distro from this failed first launch was unregistered. Other distributions were not.' 2
    }
    Invoke-Logged -Stage '02-terminate-vf-align' -FileName $script:WslExe -ArgumentList @('--terminate', $DistroName) -TimeoutSec 60 | Out-Null
}
$after = @(Get-WslDistros)
$after | ForEach-Object { Add-Run ("distro-after name={0} version={1} state={2}" -f $_.Name, $_.Version, $_.State) }
Assert-OtherDistrosPreserved $before $after
$final = @($after | Where-Object { $_.Name -eq $DistroName })
if ($final.Count -ne 1 -or $final[0].Version -ne 2) { Stop-Stage 'BLOCKER=vf_align_missing_after_setup' 2 }
Set-Content -LiteralPath (Join-Path $script:StageDir '02-distro.ok') -Value 'vf-align wsl2' -Encoding ascii

Sync-Helpers
$pyCheck = Invoke-WslBash '03-python-check' '/opt/vf-align/venv-3.11.11/bin/python -c "import sys; raise SystemExit(0 if sys.version_info[:3]==(3,11,11) else 1)"' 60
if ($pyCheck.Code -ne 0) {
    Assert-Free 'python'
    $py = Invoke-WslBash '03-python' 'bash /opt/vf-align/tools/setup_runtime.sh ensure-python' 1800
    if ($py.Code -ne 0) { Stop-Stage 'BLOCKER=python_3.11.11_setup_failed The virtual environment was not deleted.' 2 }
}
Set-Content -LiteralPath (Join-Path $script:StageDir '03-python.ok') -Value '3.11.11' -Encoding ascii

$runtimeMarker = Join-Path $script:StageDir '04-runtime.ok'
$runtimeReused = $false
if (Test-Path -LiteralPath $runtimeMarker) {
    $runtime = Invoke-WslBash '04-runtime-reuse' 'bash /opt/vf-align/tools/setup_runtime.sh ensure-runtime' 1800
    if ($runtime.Code -eq 0) { $runtimeReused = $true }
}
if (-not $runtimeReused) {
    Assert-Free 'cpu-runtime'
    $runtime = Invoke-WslBash '04-runtime' 'bash /opt/vf-align/tools/setup_runtime.sh ensure-runtime && /opt/vf-align/venv-3.11.11/bin/python /opt/vf-align/tools/align_recording.py --self-test-forward' 3600
    if ($runtime.Code -ne 0) { Stop-Stage 'BLOCKER=cpu_runtime_or_forward_check_failed Weights were not downloaded.' 2 }
}
Set-Content -LiteralPath $runtimeMarker -Value 'cpu torch 2.8.0 fairseq2 0.6 forward-to-aligner' -Encoding ascii

$ckpt = Join-Path $ModelRoot 'omniASR-CTC-300M-v2.pt'
$tok = Join-Path $ModelRoot 'omniASR_tokenizer_written_v2.model'
$weightsReady = (Test-Path -LiteralPath (Join-Path $script:StageDir '05-weights.ok')) -and (Test-Path -LiteralPath $ckpt) -and ((Get-Item -LiteralPath $ckpt).Length -eq $CheckpointBytes) -and (Test-Path -LiteralPath "$ckpt.sha256") -and (Test-Path -LiteralPath $tok) -and ((Get-Item -LiteralPath $tok).Length -eq $TokenizerBytes) -and (Test-Path -LiteralPath "$tok.sha256")
if (-not $weightsReady) {
    Assert-Free 'weights'
    Receive-File -Url $CheckpointUrl -Dest $ckpt -ExpectedSize $CheckpointBytes -RequireZip
    Receive-File -Url $TokenizerUrl -Dest $tok -ExpectedSize $TokenizerBytes
}
Set-Content -LiteralPath (Join-Path $script:StageDir '05-weights.ok') -Value 'official sizes matched and sha256 recorded' -Encoding ascii

$wslWav = Quote-Bash (Convert-ToWslPath $Wav)
$wslProject = Quote-Bash (Convert-ToWslPath $Project)
$wslState = Quote-Bash (Convert-ToWslPath $State)
$wslCkpt = Quote-Bash (Convert-ToWslPath $ckpt)
$wslTok = Quote-Bash (Convert-ToWslPath $tok)
$wslReview = Quote-Bash (Convert-ToWslPath $script:ReviewDir)
$py = '/opt/vf-align/venv-3.11.11/bin/python /opt/vf-align/tools/align_recording.py'
$meta = Join-Path $script:ReviewDir 'emissions-meta.json'
$emissionsReady = $false
if (Test-Path -LiteralPath $meta) {
    $emissionsReady = (Get-Content -LiteralPath $meta -Raw -Encoding UTF8) -match [regex]::Escape($sha)
}
if (-not $emissionsReady) {
    $extract = Invoke-WslBash '06-logits' "export OMP_NUM_THREADS=4 MKL_NUM_THREADS=4; exec $py --extract-only --wav $wslWav --checkpoint $wslCkpt --review-dir $wslReview" 5400
    if ($extract.Code -ne 0) { Stop-Stage 'BLOCKER=logit_extraction_failed Saved timings were not changed.' 2 }
    if (-not (Test-Path -LiteralPath $meta) -or (Get-Content -LiteralPath $meta -Raw -Encoding UTF8) -notmatch [regex]::Escape($sha)) {
        Stop-Stage 'BLOCKER=logits_missing_after_extract Saved timings were not changed.' 2
    }
}
Set-Content -LiteralPath (Join-Path $script:StageDir '06-logits.ok') -Value 'frame logits from model.forward' -Encoding ascii

$boundaries = Join-Path $script:ReviewDir 'boundaries.json'
$reviewReady = $false
if ((Test-Path -LiteralPath $boundaries) -and (Test-Path -LiteralPath (Join-Path $script:ReviewDir 'diagnostics.json')) -and (Test-Path -LiteralPath (Join-Path $script:ReviewDir 'listen.txt'))) {
    $reviewText = Get-Content -LiteralPath $boundaries -Raw -Encoding UTF8
    $reviewReady = ($reviewText -match [regex]::Escape($sha)) -and ($reviewText -match 'listening_not_done')
}
if (-not $reviewReady) {
    $align = Invoke-WslBash '07-align' "export OMP_NUM_THREADS=4 MKL_NUM_THREADS=4; exec $py --align-only --wav $wslWav --project-json $wslProject --state-json $wslState --tokenizer $wslTok --review-dir $wslReview" 1800
    if ($align.Code -ne 0) { Stop-Stage 'BLOCKER=forced_alignment_failed No sentence time was invented by this entry point. Saved timings were not changed.' 2 }
    if (-not (Test-Path -LiteralPath $boundaries) -or (Get-Content -LiteralPath $boundaries -Raw -Encoding UTF8) -notmatch [regex]::Escape($sha)) {
        Stop-Stage 'BLOCKER=review_missing_after_align Saved timings were not changed.' 2
    }
}
Set-Content -LiteralPath (Join-Path $script:StageDir '07-align.ok') -Value 'review files only' -Encoding ascii
$status = @(
    'Review files were written. This is not listening approval, not a saved timing change, and not a finished render.'
    'An earlier approximate listening note was not used as a target and was not applied as an offset.'
    "Listen using: $(Join-Path $script:ReviewDir 'listen.txt')"
    "Boundaries: $boundaries"
    "Diagnostics: $(Join-Path $script:ReviewDir 'diagnostics.json')"
    'Play-from-here was not verified because the project timeline was not changed.'
) -join "`r`n"
Set-Content -LiteralPath (Join-Path $script:ReviewDir 'STATUS.txt') -Value $status -Encoding UTF8
Add-Run $status
Write-Host $status
exit 0
