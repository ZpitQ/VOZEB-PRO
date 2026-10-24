param(
    [Parameter(Mandatory=$true)][string]$ModulePath,
    [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ModuleSha,
    [Parameter(Mandatory=$true)][string]$FixtureRoot,
    [Parameter(Mandatory=$true)][string]$OutputPath
)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
if($PSVersionTable.PSVersion.Major -ne 5){throw 'fresh_winps5_required'}
if($null -ne ('Zeb.WorkerInstall.Native' -as [type])){throw 'fresh_native_required'}
$ModulePath=[IO.Path]::GetFullPath($ModulePath);$FixtureRoot=[IO.Path]::GetFullPath($FixtureRoot);$OutputPath=[IO.Path]::GetFullPath($OutputPath)
$ModuleSha=$ModuleSha.ToLowerInvariant()
if((Get-FileHash -LiteralPath $ModulePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ModuleSha){throw 'module_changed'}
if(Test-Path -LiteralPath $OutputPath){throw 'output_already_exists'}
$module=Import-Module -Name $ModulePath -Force -PassThru
if(@($module).Count -ne 1){throw 'actual_module_not_unique'}
$writer=& $module {$ExecutionContext.SessionState.InvokeCommand.GetCommand('Write-WorkerUpgradeEvidence',[Management.Automation.CommandTypes]::Function)}
$valid=$null -ne $writer -and $null -ne $writer.Module -and
    [string]::Equals($writer.Module.Path,$ModulePath,[StringComparison]::OrdinalIgnoreCase) -and
    -not $module.ExportedFunctions.ContainsKey('Write-WorkerUpgradeEvidence')
$declared=@()
if($valid){
    $functionAst=$writer.ScriptBlock.Ast
    if($functionAst -is [Management.Automation.Language.FunctionDefinitionAst]){$functionAst=$functionAst.Body}
    $parameters=@($functionAst.ParamBlock.Parameters);$declared=@($parameters|ForEach-Object {$_.Name.VariablePath.UserPath})
    $valid=($declared -join ',') -ceq 'Evidence,Receipt,ReceiptPath,Backup,Deadline' -and $parameters.Count -eq 5 -and $parameters[4].StaticType -eq [DateTime]
}
$names=@('stores_four_fixed_leaves_and_original_bindings','completed_collision_preserves_originals','partial_collision_preserves_originals',
    'legacy_marker_absent_refused','wrong_marker_bytes_refused','host_managed_dll_missing_refused','supervisor_managed_dll_missing_refused',
    'wrong_operation_refused','same_value_foreign_backup_object_refused','backup_binding_raw_sha_mismatch_refused',
    'backup_value_vs_original_raw_mismatch_refused','manifest_raw_tamper_refused','five_directory_payload_tamper_refused',
    'installed_payload_tamper_refused','expired_original_deadline_refused','self_consistent_schema8_metadata_refused','wrong_backup_source_refused')
function Save-Report($Report){
    if((Get-FileHash -LiteralPath $ModulePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ModuleSha){throw 'module_changed_during_controls'}
    $raw=[Text.UTF8Encoding]::new($false,$true).GetBytes(($Report|ConvertTo-Json -Depth 14 -Compress)+[char]10)
    $stream=[IO.FileStream]::new($OutputPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try{$stream.Write($raw,0,$raw.Length)}finally{$stream.Dispose()}
    [Console]::Write([Text.Encoding]::UTF8.GetString($raw))
}
if(-not $valid){
    Save-Report @{code='upgrade_evidence_interface_red';moduleSha256=$ModuleSha;interfacePresent=$null -ne $writer;
        declaredParameters=$declared;interfacePassCount=0;interfaceFailCount=1;behaviorPassCount=0;behaviorFailCount=0;
        pendingBehaviorCount=$names.Count;pendingBehaviorNames=$names;actualNativeCompiled=$false;actualStorage=$false;
        actualWriterInvoked=$false;writerInvocationCount=0;
        actualInstalledPayloadValidation=$false;actualReadBackupAndSnapshot=$false;actualNewWorkerBackup=$false;
        actualDatabaseVerification=$false;actualStop=$false;actualScm=$false;actualFailureProof=$false;actualRecover=$false;actualGpu=$false;
        scope='actual imported private interface only; fixture and all storage controls remain pending'}
    exit 1
}
if(Test-Path -LiteralPath $FixtureRoot){throw 'fixture_already_exists'}
& $module {Initialize-WorkerInstallNative}
function Call-Private([string]$Name,[object[]]$Values){return & $module {param($Name,$Values) & $Name @Values} $Name $Values}
function New-PrivateDirectory([string]$Path){$null=Call-Private 'New-WorkerCallerDirectory' @($Path)}
function Put-PrivateFile([string]$Path,[byte[]]$Bytes){$null=Call-Private 'New-WorkerCallerFile' @($Path,$Bytes)}
function Json-Bytes($Value){return ,([Text.UTF8Encoding]::new($false,$true).GetBytes(($Value|ConvertTo-Json -Depth 32 -Compress)+[char]10))}
function Hash-Bytes([byte[]]$Bytes){$sha=[Security.Cryptography.SHA256]::Create();try{return [BitConverter]::ToString($sha.ComputeHash($Bytes)).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}}
function Json-Value($Value){return $Value|ConvertTo-Json -Depth 32 -Compress}
function Root-Reason($Failure){while($null -ne $Failure.InnerException){$Failure=$Failure.InnerException};return $Failure}
function Keys-Match($Value,[string[]]$Keys){
    if($Value -isnot [pscustomobject] -or @($Value.PSObject.Properties).Count -ne $Keys.Count){return $false}
    foreach($key in $Keys){if($null -eq $Value.PSObject.Properties[$key]){return $false}}
    return $true
}
function File-Facts([string]$Path){
    $info=[Zeb.WorkerInstall.Native]::Inspect($Path)
    return [pscustomobject]@{identity=$info.Identity;bytes=$info.Bytes;sha256=[Zeb.WorkerInstall.Native]::Hash($Path);
        creation=$info.CreationUtc;lastWrite=$info.LastWriteUtc;sddl=$info.SecuritySddl}
}
function Tree-State([string]$Root){
    $value=[ordered]@{}
    foreach($item in (Call-Private 'Get-WorkerTree' @($Root))){
        $relative=$item.path.Substring($Root.Length).Replace('\','/')
        if($relative.Length -eq 0){$relative='.'}
        $value[$relative]=if($item.info.Directory){[pscustomobject]@{identity=$item.info.Identity;sddl=$item.info.SecuritySddl}}else{File-Facts $item.path}
    }
    return Json-Value ([pscustomobject]$value)
}
function Inputs-State($Fixture){
    return Json-Value ([pscustomobject]@{receipt=(File-Facts $Fixture.ReceiptPath);value=(Json-Value $Fixture.Receipt);
        payload=(Tree-State $Fixture.VersionRoot);backup=(Tree-State $Fixture.Backup.value.root);
        dataSnapshot=(Call-Private 'Get-WorkerSnapshot' @($Fixture.Receipt.dataRoot))})
}
function Rebind-BackupFixture($Fixture){
    # This is a synthetic owning-caller binding, never claimed as an actual New-WorkerBackup invocation.
    $Fixture.Evidence.BackupResult=$Fixture.Backup
    $Fixture.Evidence.BackupBinding=[pscustomobject]@{path=$Fixture.Backup.path;valueJson=(Json-Value $Fixture.Backup.value);
        receiptSha256=(Hash-Bytes ([IO.File]::ReadAllBytes($Fixture.Backup.path)))}
}
function New-StorageFixture([string]$Name){
    $scene=Join-Path $FixtureRoot $Name;New-PrivateDirectory $scene
    $program=Join-Path $scene 'program';$data=Join-Path $scene 'data';$backupRoot=Join-Path $scene 'backup'
    foreach($path in @($program,$data,$backupRoot,(Join-Path $data 'installation'))){New-PrivateDirectory $path}
    $version='inert-old-v1';$versionRoot=Join-Path $program $version;New-PrivateDirectory $versionRoot
    $paths=@('WindowsServiceHost.exe','WindowsServiceHost.dll','WindowsServiceHost.deps.json','WindowsServiceHost.runtimeconfig.json',
        'WindowsSupervisor.dll','WindowsSupervisor.deps.json','WindowsSupervisor.runtimeconfig.json',
        'runtime/node.exe','runtime/LICENSE','app/main.mjs','app/manage.mjs','app/package.json','app/dist/bootstrap.js','app/dist/contracts.js',
        'native/bridge/WindowsControlBridge.exe','native/bridge/WindowsControlBridge.dll',
        'native/supervisor/WindowsSupervisor.exe','native/supervisor/WindowsSupervisor.dll','orderly-stop-contract.v1')
    $entries=[Collections.Generic.List[object]]::new()
    foreach($relative in $paths){
        if(($Name -ceq 'legacy_marker_absent_refused' -and $relative -ceq 'orderly-stop-contract.v1') -or
            ($Name -ceq 'host_managed_dll_missing_refused' -and $relative -ceq 'WindowsServiceHost.dll') -or
            ($Name -ceq 'supervisor_managed_dll_missing_refused' -and $relative -ceq 'WindowsSupervisor.dll')){continue}
        $target=Join-Path $versionRoot $relative.Replace('/','\');$parent=[IO.Path]::GetDirectoryName($target)
        if(-not [IO.Directory]::Exists($parent)){New-PrivateDirectory $parent}
        $bytes=[Text.Encoding]::ASCII.GetBytes('INERT:'+ $relative+[char]10)
        if($relative -ceq 'orderly-stop-contract.v1'){
            $marker=if($Name -ceq 'wrong_marker_bytes_refused'){'ZEB_ORDERLY_STOP_CONTRACT_V0'}else{'ZEB_ORDERLY_STOP_CONTRACT_V1'}
            $bytes=[Text.Encoding]::ASCII.GetBytes($marker+[char]10)
        }
        Put-PrivateFile $target $bytes
        $entries.Add([pscustomobject]@{path=$relative;bytes=$bytes.Length;sha256=(Hash-Bytes $bytes)})
    }
    $inventoryRaw=Json-Bytes ([pscustomobject]@{schemaVersion=1;version=$version;storeSchemaVersion=7;files=$entries.ToArray()})
    Put-PrivateFile (Join-Path $versionRoot 'package.inventory.json') $inventoryRaw
    foreach($name in @('store','records','engine','config','tls')){New-PrivateDirectory (Join-Path $data $name)}
    $files=[ordered]@{'store/worker.sqlite'='INERT_STORE_BYTES_SCHEMA7_METADATA_ONLY';'store/complete-task.json'='{"status":"succeeded","jobId":"inert-job"}';
        'store/source.png'='INERT_SOURCE_BYTES';'store/output.png'='INERT_OUTPUT_BYTES';'records/original.json'='{"inert":true}';
        'engine/manifest.json'='{"inert":true}';'config/worker.config.json'='{"host":"127.0.0.1","port":1}'}
    foreach($relative in $files.Keys){Put-PrivateFile (Join-Path $data $relative.Replace('/','\')) ([Text.Encoding]::UTF8.GetBytes($files[$relative]+[char]10))}
    $configRaw=[IO.File]::ReadAllBytes((Join-Path $data 'config\worker.config.json'))
    Put-PrivateFile (Join-Path $versionRoot 'app\worker.config.json') $configRaw
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$boot=[Guid]::NewGuid().ToString('D')
    $receipt=[pscustomobject]@{schemaVersion=1;installationId=[Guid]::NewGuid().ToString('D');state='installed';serviceName='ZebImageEnhancement';
        accountName='NT SERVICE\ZebImageEnhancement';tokenUserSid=$sid;sessionId=0;programRoot=$program;dataRoot=$data;storeSchemaVersion=7;
        serviceId=[Guid]::NewGuid().ToString('D');clientId=[Guid]::NewGuid().ToString('D');engineImportSha256=('a'*64);
        engineManifestSha256=(Hash-Bytes ([IO.File]::ReadAllBytes((Join-Path $data 'engine\manifest.json'))));configSha256=(Hash-Bytes $configRaw);tlsSha256=$null;
        active=[pscustomobject]@{version=$version;inventorySha256=(Hash-Bytes $inventoryRaw);imagePath=('"'+(Join-Path $versionRoot 'WindowsServiceHost.exe')+'"')};
        previous=$null;lastStopped=[pscustomobject]@{bootId=$boot;host=[pscustomobject]@{pid=101;creationFileTime='10001'};
            node=[pscustomobject]@{pid=102;creationFileTime='10002'};pinsExclusive=$true};
        operation=[pscustomobject]@{operationId=[Guid]::NewGuid().ToString('D');action='Upgrade';stage='stopped';outcome='known';maintenanceBootId=$boot;targetSha256=('b'*64)}}
    $receiptPath=Join-Path $data 'installation\receipt.json'
    $receiptRaw=[Text.UTF8Encoding]::new($false,$true).GetBytes(' '+(Json-Value $receipt)+[char]10+[char]10)
    Put-PrivateFile $receiptPath $receiptRaw
    $manifest=Call-Private 'Get-WorkerSnapshot' @($data)
    foreach($entry in ($manifest.entries|Sort-Object {$_.path.Length})){
        $target=Join-Path $backupRoot $entry.path.Replace('/','\')
        if($entry.kind -ceq 'directory'){New-PrivateDirectory $target}else{Put-PrivateFile $target ([IO.File]::ReadAllBytes((Join-Path $data $entry.path.Replace('/','\'))))}
    }
    $null=Call-Private 'Restore-WorkerSnapshotMetadata' @($backupRoot,$manifest)
    $manifestPath=Join-Path $backupRoot 'manifest.json';Put-PrivateFile $manifestPath (Json-Bytes $manifest)
    $backupValue=[pscustomobject]@{schemaVersion=1;backupId=[Guid]::NewGuid().ToString('D');installationId=$receipt.installationId;storeSchemaVersion=7;
        serviceId=$receipt.serviceId;clientId=$receipt.clientId;tokenUserSid=$sid;engineManifestSha256=$receipt.engineManifestSha256;
        configSha256=$receipt.configSha256;tlsSha256=$null;sourceVersion=$receipt.active.version;sourceInventorySha256=$receipt.active.inventorySha256;
        sourceImagePath=$receipt.active.imagePath;root=$backupRoot;manifestSha256=(Hash-Bytes ([IO.File]::ReadAllBytes($manifestPath)));verified=$true}
    $backupPath=Join-Path $backupRoot 'backup-receipt.json';Put-PrivateFile $backupPath (Json-Bytes $backupValue)
    $generation=[pscustomobject]@{bootId=$boot;endpoint=[pscustomobject]@{scheme='http';host='127.0.0.1';port=1;ownerPid=102;bootId=$boot};
        host=[pscustomobject]@{pid=101;creationFileTime='10001';imagePath=(Join-Path $versionRoot 'WindowsServiceHost.exe');tokenUserSid=$sid;sessionId=0};
        node=[pscustomobject]@{pid=102;creationFileTime='10002';imagePath=(Join-Path $versionRoot 'runtime\node.exe');tokenUserSid=$sid;sessionId=0}}
    $dto=[pscustomobject]@{bootId=$boot;sealed=$true;state='quiescent';canStop=$true;store=[pscustomobject]@{queued=0;running=0;slots=0;unreleasedReferences=0};
        http=[pscustomobject]@{sealed=$true;uploads=0;downloads=0;receipts=0};pending=[pscustomobject]@{selfTestAdmission=0;selfTestOutputRead=0;runner=0;adapter=0};
        runtime=[pscustomobject]@{closing=$false;startupRecovery='settled';runner=[pscustomobject]@{closed=$false;storeClosed=$false;recoveryState='idle';recoveryInFlight=$false;ownedState='none'};
            adapter=[pscustomobject]@{sealed=$false;activity='idle';close='not_requested'}}}
    $dtoRaw=Json-Bytes $dto
    $evidence=[pscustomobject]@{OperationId=$receipt.operation.operationId;OldActive=($receipt.active|ConvertTo-Json -Compress|ConvertFrom-Json);
        MaintenanceDtoRaw=$dtoRaw;MaintenanceDtoSha256=(Hash-Bytes $dtoRaw);First=$generation;Second=($generation|ConvertTo-Json -Depth 12 -Compress|ConvertFrom-Json);
        ScmStopCalls=1;HostExitCode=[uint32]0;NodeExitCode=[uint32]0;PinsExclusive=$true;BackupResult=$null;BackupBinding=$null;EvidencePath=$null;EvidenceSha256=$null}
    $fixture=[pscustomobject]@{Receipt=$receipt;ReceiptPath=$receiptPath;ReceiptRaw=$receiptRaw;VersionRoot=$versionRoot;InventoryRaw=$inventoryRaw;Manifest=$manifest;
        Backup=[pscustomobject]@{path=$backupPath;value=$backupValue};Evidence=$evidence;Deadline=[DateTime]::UtcNow.AddSeconds(30);
        EvidenceRoot=(Join-Path $data ('installation\upgrade-'+$receipt.operation.operationId))}
    Rebind-BackupFixture $fixture
    # Real, unmocked preflight: validate complete inert installed tree and the entire backup/snapshot.
    $null=Call-Private 'Test-WorkerInstalledPayload' @($versionRoot,$receipt.active.inventorySha256,$receipt.configSha256)
    $null=Call-Private 'Read-WorkerReceipt' @($receiptPath)
    $projection=$receipt|ConvertTo-Json -Depth 32 -Compress|ConvertFrom-Json;$projection.previous=$evidence.OldActive
    $null=Call-Private 'Read-WorkerBackup' @($backupPath,$projection)
    $script:PreflightCount++
    return $fixture
}
function Invoke-Writer($Fixture,$Backup){
    if($null -eq $Backup){$Backup=$Fixture.Backup}
    $script:WriterCalls++
    $output=@(& $module {param($Evidence,$Receipt,$ReceiptPath,$Backup,[DateTime]$Deadline)
        Write-WorkerUpgradeEvidence $Evidence $Receipt $ReceiptPath $Backup $Deadline
    } $Fixture.Evidence $Fixture.Receipt $Fixture.ReceiptPath $Backup $Fixture.Deadline)
    return $output.Count
}
function Validate-Material($Fixture){
    $root=$Fixture.EvidenceRoot;$indexPath=Join-Path $root 'verified-backup.json'
    if($Fixture.Evidence.EvidencePath -cne $indexPath -or $Fixture.Evidence.EvidenceSha256 -cne [Zeb.WorkerInstall.Native]::Hash($indexPath)){return $false}
    $leaves=@([Zeb.WorkerInstall.Native]::Children($root)|Sort-Object)
    if(($leaves -join ',') -cne 'maintenance-dto.json,old-package.inventory.json,old-stop.json,verified-backup.json'){return $false}
    $null=Call-Private 'Assert-WorkerCallerDirectory' @($root)
    foreach($leaf in $leaves){$null=Call-Private 'Assert-WorkerCallerFile' @((Join-Path $root $leaf))}
    if([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $root 'maintenance-dto.json'))) -cne [Convert]::ToBase64String($Fixture.Evidence.MaintenanceDtoRaw) -or
        [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $root 'old-package.inventory.json'))) -cne [Convert]::ToBase64String($Fixture.InventoryRaw)){return $false}
    $old=Call-Private 'Read-WorkerJson' @((Join-Path $root 'old-stop.json'))
    if(-not (Keys-Match $old @('schemaVersion','operationId','source','oldActive','maintenanceDtoSha256','first','second','scmStopCalls','hostExitCode','nodeExitCode','pinsExclusive','stoppedReceiptRawBase64','stoppedReceiptSha256'))){return $false}
    if($old.schemaVersion -ne 1 -or $old.operationId -cne $Fixture.Evidence.OperationId -or $old.source -cne 'derivedFromQualifiedHostContract' -or
        (Json-Value $old.oldActive) -cne (Json-Value $Fixture.Evidence.OldActive) -or (Json-Value $old.first) -cne (Json-Value $Fixture.Evidence.First) -or
        (Json-Value $old.second) -cne (Json-Value $Fixture.Evidence.Second) -or $old.scmStopCalls -ne 1 -or $old.hostExitCode -ne 0 -or $old.nodeExitCode -ne 0 -or
        $old.pinsExclusive -cne $true -or $old.maintenanceDtoSha256 -cne $Fixture.Evidence.MaintenanceDtoSha256 -or
        $old.stoppedReceiptRawBase64 -cne [Convert]::ToBase64String($Fixture.ReceiptRaw) -or $old.stoppedReceiptSha256 -cne (Hash-Bytes $Fixture.ReceiptRaw)){return $false}
    $index=Call-Private 'Read-WorkerJson' @($indexPath)
    if(-not (Keys-Match $index @('schemaVersion','operationId','materials','backupReceipt','backupManifest','directories')) -or
        $index.schemaVersion -ne 1 -or $index.operationId -cne $Fixture.Evidence.OperationId -or
        ($index.directories -join ',') -cne 'store,records,engine,config,tls' -or
        -not (Keys-Match $index.materials @('maintenance-dto.json','old-package.inventory.json','old-stop.json'))){return $false}
    foreach($leaf in @('maintenance-dto.json','old-package.inventory.json','old-stop.json')){
        $facts=File-Facts (Join-Path $root $leaf);$declared=$index.materials.PSObject.Properties[$leaf].Value
        if(-not (Keys-Match $declared @('bytes','sha256')) -or $declared.bytes -ne $facts.bytes -or $declared.sha256 -cne $facts.sha256){return $false}
    }
    foreach($binding in @(@{value=$index.backupReceipt;path=$Fixture.Backup.path},@{value=$index.backupManifest;path=(Join-Path $Fixture.Backup.value.root 'manifest.json')})){
        $facts=File-Facts $binding.path
        if(-not (Keys-Match $binding.value @('path','bytes','sha256')) -or $binding.value.path -cne $binding.path -or
            $binding.value.bytes -ne $facts.bytes -or $binding.value.sha256 -cne $facts.sha256){return $false}
    }
    return $true
}
$rows=[Collections.Generic.List[object]]::new();$script:PreflightCount=0;$script:WriterCalls=0;$phase='setup';$unexpected=$null
$forbidden=[Collections.Generic.List[string]]::new()
& $module {
    param($Calls)
    $script:UpgradeEvidenceForbidden=$Calls
    function script:Invoke-WorkerScmChange {$script:UpgradeEvidenceForbidden.Add('SCM');throw 'fixture_forbidden_scm'}
    function script:Invoke-WorkerMaintenanceHttp {$script:UpgradeEvidenceForbidden.Add('HTTP');throw 'fixture_forbidden_http'}
    function script:Invoke-WorkerNodeProcess {$script:UpgradeEvidenceForbidden.Add('Node');throw 'fixture_forbidden_node'}
    function script:New-WorkerBackup {$script:UpgradeEvidenceForbidden.Add('NewBackup');throw 'fixture_forbidden_new_backup'}
    function script:Copy-WorkerSnapshot {$script:UpgradeEvidenceForbidden.Add('CopySnapshot');throw 'fixture_forbidden_snapshot_copy'}
} $forbidden
try {
    New-PrivateDirectory $FixtureRoot
    $positive=$null
    foreach($name in $names){
        $phase=$name+'.prepare'
        $fixture=if($name -ceq 'completed_collision_preserves_originals'){$positive}else{New-StorageFixture $name}
        if($null -eq $fixture){throw 'positive_fixture_unavailable'}
        $backupArgument=$fixture.Backup
        switch($name){
            'partial_collision_preserves_originals'{New-PrivateDirectory $fixture.EvidenceRoot;Put-PrivateFile (Join-Path $fixture.EvidenceRoot 'old-stop.json') ([Text.Encoding]::ASCII.GetBytes('original-partial'))}
            'wrong_operation_refused'{$fixture.Evidence.OperationId=[Guid]::NewGuid().ToString('D')}
            'same_value_foreign_backup_object_refused'{$backupArgument=[pscustomobject]@{path=$fixture.Backup.path;value=$fixture.Backup.value}}
            'backup_binding_raw_sha_mismatch_refused'{$fixture.Evidence.BackupBinding.receiptSha256=('e'*64)}
            'backup_value_vs_original_raw_mismatch_refused'{$fixture.Backup.value.sourceVersion='different-version'}
            'manifest_raw_tamper_refused'{[IO.File]::AppendAllText((Join-Path $fixture.Backup.value.root 'manifest.json'),' ',[Text.Encoding]::ASCII)}
            'five_directory_payload_tamper_refused'{[IO.File]::AppendAllText((Join-Path $fixture.Backup.value.root 'records\original.json'),'tamper',[Text.Encoding]::ASCII)}
            'installed_payload_tamper_refused'{[IO.File]::AppendAllText((Join-Path $fixture.VersionRoot 'WindowsServiceHost.dll'),'tamper',[Text.Encoding]::ASCII)}
            'expired_original_deadline_refused'{$fixture.Deadline=[DateTime]::UtcNow.AddMilliseconds(-1)}
            'self_consistent_schema8_metadata_refused'{
                $fixture.Backup.value.storeSchemaVersion=8;[IO.File]::WriteAllBytes($fixture.Backup.path,(Json-Bytes $fixture.Backup.value));Rebind-BackupFixture $fixture
            }
            'wrong_backup_source_refused'{
                $fixture.Backup.value.sourceVersion='wrong-source';[IO.File]::WriteAllBytes($fixture.Backup.path,(Json-Bytes $fixture.Backup.value));Rebind-BackupFixture $fixture
            }
        }
        $before=Inputs-State $fixture;$previous=Json-Value $fixture.Receipt.previous
        $materialBefore=if([IO.Directory]::Exists($fixture.EvidenceRoot)){Tree-State $fixture.EvidenceRoot}else{$null}
        $pathBefore=$fixture.Evidence.EvidencePath;$shaBefore=$fixture.Evidence.EvidenceSha256
        $phase=$name+'.writer';$failure=$null;$outputCount=$null
        try{$outputCount=Invoke-Writer $fixture $backupArgument}catch{$failure=Root-Reason $_.Exception}
        $phase=$name+'.assert'
        $unchanged=$before -ceq (Inputs-State $fixture) -and $previous -ceq (Json-Value $fixture.Receipt.previous)
        if($name -ceq 'stores_four_fixed_leaves_and_original_bindings'){
            $good=$null -eq $failure -and $outputCount -eq 0 -and $unchanged -and (Validate-Material $fixture)
            $positive=$fixture
        }else{
            $refused=$null -ne $failure -and ($failure.Message -cmatch '\Aworker_[a-z_]+\z' -or $failure -is [IO.IOException] -or
                $failure -is [IO.InvalidDataException] -or $failure -is [InvalidOperationException] -or $failure -is [UnauthorizedAccessException] -or $failure -is [ComponentModel.Win32Exception])
            $good=$refused -and $unchanged -and $fixture.Evidence.EvidencePath -ceq $pathBefore -and $fixture.Evidence.EvidenceSha256 -ceq $shaBefore
            if($null -ne $materialBefore){$good=$good -and $materialBefore -ceq (Tree-State $fixture.EvidenceRoot)}
            else{$good=$good -and -not [IO.File]::Exists((Join-Path $fixture.EvidenceRoot 'verified-backup.json'))}
        }
        $rows.Add(@{name=$name;passed=[bool]$good;originalInputsPreserved=$unchanged;
            failureType=$(if($null -ne $failure){$failure.GetType().FullName}else{$null});
            fixedCode=$(if($null -ne $failure -and $failure.Message -cmatch '\Aworker_[a-z_]+\z'){$failure.Message}else{$null});
            actualOriginalNewBackup=$false;actualDatabaseVerification=$false;actualStop=$false;actualScm=$false})
    }
}catch{
    $failure=Root-Reason $_.Exception;$unexpected=@{phase=$phase;failureType=$failure.GetType().FullName;message=$failure.Message;stack=$_.ScriptStackTrace;
        nativeErrorCode=$(if($failure -is [ComponentModel.Win32Exception]){$failure.NativeErrorCode}else{$null})}
}
$failed=@($rows|Where-Object {-not $_.passed});$seen=@($rows|ForEach-Object {$_.name});$pending=@($names|Where-Object {$_ -cnotin $seen})
$success=$failed.Count -eq 0 -and $pending.Count -eq 0 -and $null -eq $unexpected -and $forbidden.Count -eq 0
Save-Report @{code='upgrade_evidence_storage_controls_v1';passed=$success;moduleSha256=$ModuleSha;interfacePassCount=1;interfaceFailCount=0;
    behaviorPassCount=$rows.Count-$failed.Count;behaviorFailCount=$failed.Count;pendingBehaviorCount=$pending.Count;pendingBehaviorNames=$pending;
    rows=$rows.ToArray();unexpectedFailure=$unexpected;preflightCount=$script:PreflightCount;forbiddenCalls=$forbidden.ToArray();
    actualWriterInvoked=$script:WriterCalls -gt 0;writerInvocationCount=$script:WriterCalls;
    actualNativeCompiled=$true;actualStorage=$script:PreflightCount -gt 0;actualInstalledPayloadValidation=$script:PreflightCount -gt 0;
    actualReadBackupAndSnapshot=$script:PreflightCount -gt 0;actualNewWorkerBackup=$false;actualDatabaseVerification=$false;
    actualQualifiedHostBehavior=$false;actualStop=$false;actualScm=$false;actualSessionZeroOrServiceSid=$false;actualFailureProof=$false;actualRecover=$false;actualGpu=$false;
    nonAuthorSourceReviewRequired='owning caller binds exact original NewBackup reference/snapshot; writer validates full approved installed inventory plus fixed marker/root DLLs and real ReadBackup/snapshot before four fixed CreateNew leaves; final index written last; only publish evidence path/hash after readback; no core receipt mutation or recovery authority';
    scope='pure private storage/validation with own inert complete payload and schema7 metadata/inert store bytes; real installed-payload/ReadBackup/snapshot/ACL methods, synthetic Stop and backup-origin inputs; no actual DB verification/NewBackup/SCM/FailureProof/Recover'}
if(-not $success){exit 1}
exit 0
