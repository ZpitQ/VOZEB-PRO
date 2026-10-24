param([string]$Root=$PSScriptRoot,[string]$UpscaylRoot,[switch]$CheckOnly)
$targetRoot=[IO.Path]::GetFullPath($Root);$preview=$CheckOnly;$sourceRoot=$UpscaylRoot
$ErrorActionPreference='Stop'
try {
    . (Join-Path $PSScriptRoot 'Setup-Worker.ps1')
    $receiptPath=Join-Path $targetRoot 'data\installation\receipt.json'
    $receipt=Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8|ConvertFrom-Json
    if($receipt.state -cne 'installed' -or -not [string]::Equals($receipt.programRoot,(Join-Path $targetRoot 'applications'),[StringComparison]::OrdinalIgnoreCase) -or -not [string]::Equals($receipt.dataRoot,(Join-Path $targetRoot 'data'),[StringComparison]::OrdinalIgnoreCase)){throw 'installation_target_mismatch: 请使用当前安装目录。'}
    $config=Get-Content -LiteralPath (Join-Path $targetRoot 'data\config\worker.config.json') -Raw -Encoding UTF8|ConvertFrom-Json
    $listen=if($config.host){$config.host}else{$config.tls.host}
    $plan=Get-ZebSetupPlan -Root $targetRoot -AssetsRoot (Join-Path $PSScriptRoot 'setup-assets') -UpscaylRoot $sourceRoot -ListenHost $listen -Port $config.port -RefreshModels
    if($plan.version -cne $receipt.active.version){throw 'setup_version_mismatch: 请使用当前 Worker 版本的配套安装入口。'}
    foreach($old in $config.workerConfig.models){if($old.id -cnotin @($plan.material.workerConfig.models.id)){throw ('installed_model_missing: 请保留已导入模型 '+$old.id)}}
    $base=$config.workerConfig.models|Where-Object {$_.id -ceq 'standard-4x'}|Select-Object -First 1
    foreach($model in $plan.material.workerConfig.models){
        $policy=$config.workerConfig.models|Where-Object {$_.id -ceq $model.id}|Select-Object -First 1
        if(-not $policy){$policy=$base}
        foreach($key in @('allowedTiles','defaultTile','gpuId')){$model.$key=$policy.$key}
    }
    if($preview){[pscustomobject]@{checkOnly=$true;models=@($plan.material.workerConfig.models.id);skippedModels=$plan.skippedModels;writes=0;serviceChanges=0}|ConvertTo-Json -Compress;return}
    $unchanged=$config.workerConfig.models.Count -eq $plan.material.workerConfig.models.Count
    foreach($model in $plan.material.workerConfig.models){
        $old=$config.workerConfig.models|Where-Object {$_.id -ceq $model.id}|Select-Object -First 1
        foreach($key in $model.PSObject.Properties.Name){if(-not $old -or ($old.$key|ConvertTo-Json -Compress) -cne ($model.$key|ConvertTo-Json -Compress)){$unchanged=$false}}
    }
    $manifestHash=($plan.engineImport.files|Where-Object {$_.path -ceq 'installation-manifest.json'}).sha256
    if($unchanged -and $config.execution.expectedManifestSha256 -ceq $manifestHash){[pscustomobject]@{outcome='known';changed=$false;models=@($plan.material.workerConfig.models.id);message='模型目录没有变化，保持服务运行。'}|ConvertTo-Json -Compress;return}
    if(-not([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
        $arguments='-NoLogo -NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'" -Root "'+$targetRoot+'"'
        if($sourceRoot){$arguments+=' -UpscaylRoot "'+$sourceRoot+'"'}
        $process=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList $arguments -Verb RunAs -Wait -PassThru
        exit $process.ExitCode
    }
    $work=Join-Path $targetRoot ('model-updates\'+[Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($work)|Out-Null
    foreach($file in $plan.generatedFiles){
        $relative=$file.path.Substring($plan.inputRoot.Length+1)
        $newPath=Join-Path $work $relative
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($newPath))|Out-Null
        [IO.File]::WriteAllBytes($newPath,[byte[]]$file.bytes)
        foreach($entry in $plan.engineImport.files|Where-Object {$_.sourcePath -ceq $file.path}){$entry.sourcePath=$newPath}
    }
    $importPath=Join-Path $work 'engine-import.json'
    [IO.File]::WriteAllText($importPath,($plan.engineImport|ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))
    $versionRoot=Join-Path $receipt.programRoot $receipt.active.version
    $module=Import-Module (Join-Path $versionRoot 'deployment\windows\Worker.Installation.psm1') -PassThru
    $result=& $module {
        param($ReceiptPath,$Plan,$ImportPath,$Work,$VersionRoot)
        $deadline=[DateTime]::UtcNow.AddSeconds(180);$lease=$null;$lock=$null;$capture=$null;$current=$null;$stage='preflight'
        function Replace-ModelFile([string]$Path,[byte[]]$Bytes){
            $info=[Zeb.WorkerInstall.Native]::Inspect($Path);$temporary=$Path+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
            New-WorkerCallerFile $temporary $Bytes
            $fresh=[Zeb.WorkerInstall.Native]::Inspect($temporary)
            [Zeb.WorkerInstall.Native]::RestoreMetadata($temporary,$info.SecuritySddl,$info.CreationUtc,$fresh.LastWriteUtc,$info.Attributes)
            [IO.File]::Replace($temporary,$Path,[System.Management.Automation.Language.NullString]::Value)
        }
        try{
            Initialize-WorkerInstallNative;$lease=Enter-WorkerInstallPrivileges $deadline
            $current=Read-WorkerReceipt $ReceiptPath
            if($current.state -cne 'installed' -or $current.operation.outcome -cne 'known'){throw 'worker_state_invalid'}
            $lock=Open-WorkerInstallLock -Path (Join-Path $current.dataRoot 'installation\operation.lock') -OperationId $current.operation.operationId -Existing
            $credential=Read-WorkerCredential $Plan.credentialFile $current;$script:WorkerBearer=$credential.credential.key
            $credentialHash=[Zeb.WorkerInstall.Native]::Hash($Plan.credentialFile)
            $oldServiceId=$current.serviceId
            $engineImport=Read-WorkerEngineImport -Path $ImportPath -ExpectedSha256 ([Zeb.WorkerInstall.Native]::Hash($ImportPath)) -Material $Plan.material -OwnedPaths @($current.programRoot,$current.dataRoot,$Plan.credentialFile)
            $null=Assert-WorkerStableFiles -Receipt $current -Engine
            Copy-WorkerFile $ReceiptPath (Join-Path $Work 'previous-installation-receipt.json')
            $resumeMaintenance=$current.operation.action -ceq 'Upgrade' -and $current.operation.stage -ceq 'maintenance' -and $current.operation.outcome -ceq 'known'
            if(-not $resumeMaintenance){$current.operation=New-WorkerOperation 'Upgrade' $current.active.inventorySha256}
            $stage='maintenance'
            if(-not(Stop-WorkerOwnedService -Receipt $current -ReceiptPath $ReceiptPath -Deadline $deadline -Resume $resumeMaintenance)){
                return [pscustomobject]@{outcome='pending';reason='worker_not_quiescent';message='已有任务尚未结束，本次没有更新模型。稍后再次运行将继续已受理的维护。'}
            }
            $stage='backup'
            $backup=New-WorkerBackup -Receipt $current -BackupRoot (Join-Path $Work 'backup') -Deadline $deadline
            $engineRoot=Join-Path $current.dataRoot 'engine';$engineInfo=[Zeb.WorkerInstall.Native]::Inspect($engineRoot)
            $fileInfo=[Zeb.WorkerInstall.Native]::Inspect((Join-Path $engineRoot 'installation-manifest.json'))
            $stage='models'
            foreach($item in Get-WorkerTree $engineRoot|Sort-Object {$_.path.Length}){
                $security=Get-WorkerCallerSecurity -Directory:$item.info.Directory
                $security.SetGroup([Security.AccessControl.RawSecurityDescriptor]::new($item.info.SecuritySddl).Group)
                [Zeb.WorkerInstall.Native]::RestoreMetadata($item.path,$security.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group -bor [Security.AccessControl.AccessControlSections]::Access),$item.info.CreationUtc,$item.info.LastWriteUtc,$item.info.Attributes)
            }
            foreach($entry in $engineImport.entries.Values){
                $destination=Join-Path $engineRoot $entry.path.Replace('/','\')
                [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination))|Out-Null
                if(Test-Path -LiteralPath $destination){if([Zeb.WorkerInstall.Native]::Hash($destination) -cne $entry.sha256){Replace-ModelFile $destination ([Zeb.WorkerInstall.Native]::ReadBytes($entry.sourcePath))}}
                else{Copy-WorkerFile $entry.sourcePath $destination}
            }
            Assert-WorkerCopiedEngine -Root $engineRoot -Material $Plan.material -ExpectedManifestSha256 $engineImport.manifestSha256
            $stage='configuration'
            $configPath=Join-Path $current.dataRoot 'config\worker.config.json';$next=Read-WorkerJson $configPath
            $next.workerConfig.models=@($Plan.material.workerConfig.models);$next.execution.expectedManifestSha256=$engineImport.manifestSha256
            $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($next|ConvertTo-Json -Depth 30 -Compress)+[char]10)
            Replace-ModelFile $configPath $bytes
            Replace-ModelFile (Join-Path $VersionRoot 'app\worker.config.json') $bytes
            foreach($item in Get-WorkerTree $engineRoot|Sort-Object {$_.path.Length} -Descending){
                $sddl=if($item.info.Directory){$engineInfo.SecuritySddl}else{$fileInfo.SecuritySddl}
                [Zeb.WorkerInstall.Native]::RestoreMetadata($item.path,$sddl,$item.info.CreationUtc,$item.info.LastWriteUtc,$item.info.Attributes)
            }
            $current.configSha256=Get-WorkerBytesHash $bytes;$current.engineImportSha256=[Zeb.WorkerInstall.Native]::Hash($ImportPath);$current.engineManifestSha256=$engineImport.manifestSha256
            Save-WorkerStage $ReceiptPath $current 'switched' 'pending'
            Assert-WorkerConfigurationResult (Invoke-WorkerConfigurationCheck -VersionRoot $VersionRoot -ConfigPath $configPath -Deadline $deadline)
            $stage='start'
            Start-WorkerOwnedService -Receipt $current -ReceiptPath $ReceiptPath -Deadline $deadline -Switch -StartupCapture ([ref]$capture)
            if($null -ne $capture){$capture.Dispose();$capture=$null}
            if($current.serviceId -cne $oldServiceId -or [Zeb.WorkerInstall.Native]::Hash($Plan.credentialFile) -cne $credentialHash){throw 'worker_identity_changed'}
            $current.lastStopped=$null;Save-WorkerStage $ReceiptPath $current 'started' 'known'
            $result=[pscustomobject]@{outcome='known';models=@($next.workerConfig.models.id);serviceId=$current.serviceId;tokenUnchanged=$true;backupReceipt=$backup.path;selfTestRequired=$true}
            Write-WorkerLedger (Join-Path $Work 'result.json') $result
            return $result
        }catch{
            if($null -ne $current -and $stage -ne 'preflight'){$current.state='unknown';Save-WorkerStage $ReceiptPath $current $current.operation.stage 'unknown'}
            if($null -ne $capture){try{Write-WorkerStartupDiagnostic -Capture $capture -Receipt $current}catch{}}
            Write-WorkerLedger (Join-Path $Work 'failure.json') ([pscustomobject]@{stage=$stage;errorType=$_.Exception.GetType().FullName;hresult=$_.Exception.HResult;message=$_.Exception.Message})
            throw
        }finally{if($null -ne $capture){$capture.Dispose()};if($null -ne $lock){$lock.Dispose()};if($null -ne $lease){$lease.Dispose()}}
    } $receiptPath $plan $importPath $work $versionRoot
    $result|ConvertTo-Json -Depth 5 -Compress
}catch{Write-Error ('模型更新未完成，已保留原配置和诊断，请勿重复运行：'+$_.Exception.Message);exit 1}
