param(
    [Parameter(Mandatory=$true)][string]$ModulePath,
    [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ModuleSha,
    [Parameter(Mandatory=$true)][string]$FixtureRoot,
    [Parameter(Mandatory=$true)][string]$OutputPath
)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$FailurePhase='listener_bind_failed'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
if($PSVersionTable.PSVersion.Major -ne 5 -or $null -ne ('Zeb.WorkerInstall.Native' -as [type])){throw 'fresh_winps5_required'}
$ModulePath=[IO.Path]::GetFullPath($ModulePath);$FixtureRoot=[IO.Path]::GetFullPath($FixtureRoot);$OutputPath=[IO.Path]::GetFullPath($OutputPath)
$ModuleSha=$ModuleSha.ToLowerInvariant()
if((Get-FileHash -LiteralPath $ModulePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ModuleSha){throw 'module_changed'}
if(Test-Path -LiteralPath $OutputPath){throw 'output_already_exists'}
$module=Import-Module -Name $ModulePath -Force -PassThru
if(@($module).Count -ne 1){throw 'actual_module_not_unique'}
$names=@('freezes_fourteen_key_failure_candidate','unknown_receipt_additional_change_refused','self_consistent_old_source_mismatch_refused',
    'successful_upgrade_pointer_missing_refused','backup_payload_tamper_refused','new_full_payload_tamper_refused',
    'original_frame_missing_refused','original_deadline_refused','original_starting_material_tamper_refused')
$checks=[Collections.Generic.List[object]]::new();$interface=[Collections.Generic.List[object]]::new()
foreach($definition in @(
    @{name='New-WorkerStartupFailureProof';parameters='Capture,Receipt,ReceiptPath,UpgradeEvidence,Deadline';deadlineIndex=4},
    @{name='Assert-WorkerStartupFailurePins';parameters='Capture,Receipt,Deadline';deadlineIndex=2}
)){
    $command=& $module {param($Name) $ExecutionContext.SessionState.InvokeCommand.GetCommand($Name,[Management.Automation.CommandTypes]::Function)} $definition.name
    $valid=$null -ne $command -and $null -ne $command.Module -and
        [string]::Equals($command.Module.Path,$ModulePath,[StringComparison]::OrdinalIgnoreCase) -and
        -not $module.ExportedFunctions.ContainsKey($definition.name)
    $declared=@()
    if($valid){
        $ast=$command.ScriptBlock.Ast
        if($ast -is [Management.Automation.Language.FunctionDefinitionAst]){$ast=$ast.Body}
        $parameters=@($ast.ParamBlock.Parameters);$declared=@($parameters|ForEach-Object {$_.Name.VariablePath.UserPath})
        $valid=($declared -join ',') -ceq $definition.parameters -and $parameters.Count -eq $definition.deadlineIndex+1 -and
            $parameters[$definition.deadlineIndex].StaticType -eq [DateTime]
    }
    $interface.Add(@{name=$definition.name;passed=[bool]$valid;present=$null -ne $command;declaredParameters=$declared})
}
function Save-Report($Report){
    if((Get-FileHash -LiteralPath $ModulePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ModuleSha){throw 'module_changed_during_controls'}
    $raw=[Text.UTF8Encoding]::new($false,$true).GetBytes(($Report|ConvertTo-Json -Depth 14 -Compress)+[char]10)
    $stream=[IO.FileStream]::new($OutputPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try{$stream.Write($raw,0,$raw.Length)}finally{$stream.Dispose()}
    [Console]::Write([Text.Encoding]::UTF8.GetString($raw))
}
$failedInterfaces=@($interface|Where-Object {-not $_.passed})
if($failedInterfaces.Count -ne 0){
    Save-Report @{code='startup_failure_proof_constructor_interface_red_v4';passed=$false;moduleSha256=$ModuleSha;failurePhase=$FailurePhase;interfaceChecks=$interface.ToArray();
        interfacePassCount=$interface.Count-$failedInterfaces.Count;interfaceFailCount=$failedInterfaces.Count;
        behaviorPassCount=0;behaviorFailCount=0;pendingBehaviorCount=$names.Count;pendingBehaviorNames=$names;
        actualConstructorInvoked=$false;constructorInvocationCount=0;actualNativeCompiled=$false;actualStorage=$false;
        actualOriginalHandles=$false;actualScm=$false;actualDatabaseVerification=$false;actualNewWorkerBackup=$false;
        actualFailureProof=$false;actualRecover=$false;actualGpu=$false;scope='actual private interfaces only; no fixture or behavior run'}
    exit 1
}
if(Test-Path -LiteralPath $FixtureRoot){throw 'fixture_already_exists'}
# Reuse only the reviewed fixture definitions. Never execute either prior control loop.
$sources=@(
    @{name='windows-upgrade-evidence.ps1';sha='aedcdada9c31af32705270666afd074e5ee4654de552a013201d830fdba03db9';functions=@(
        'Call-Private','New-PrivateDirectory','Put-PrivateFile','Json-Bytes','Hash-Bytes','Json-Value','Root-Reason','Keys-Match',
        'File-Facts','Tree-State','Inputs-State','Rebind-BackupFixture','New-StorageFixture')},
    @{name='windows-startup-failure-frames.ps1';sha='c966c5d82170e934913d74801f4b7211bab946671b506f051c0fc45ed58482ab';functions=@('Bytes-Hash','Wire','New-Scene')}
)
foreach($source in $sources){
    $path=Join-Path $PSScriptRoot $source.name
    if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $source.sha){throw 'fixture_source_changed'}
    $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
    if($errors.Count -ne 0){throw 'fixture_source_parser_failed'}
    $functions=@($ast.FindAll({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst]},$true))
    foreach($name in $source.functions){
        $found=@($functions|Where-Object {$_.Name -ceq $name})
        if($found.Count -ne 1){throw 'fixture_function_not_unique'}
        . ([scriptblock]::Create($found[0].Extent.Text))
    }
}
& $module {Initialize-WorkerInstallNative}
$utf8=[Text.UTF8Encoding]::new($false,$true)
$script:PreflightCount=0;$script:ConstructorCalls=0;$script:FramePreflights=0;$script:AclDifferencePreflights=0
$script:PinCalls=[Collections.Generic.List[object]]::new();$forbidden=[Collections.Generic.List[string]]::new()
& $module {
    param($Calls,$Forbidden)
    $script:FailureConstructorPinCalls=$Calls;$script:FailureConstructorForbidden=$Forbidden
    # Sole successful synthetic boundary: original-handle/SCM provenance is intentionally not attested.
    function script:Assert-WorkerStartupFailurePins {
        param($Capture,$Receipt,[DateTime]$Deadline)
        $null=Get-WorkerRemainingMilliseconds $Deadline
        if(-not [object]::ReferenceEquals($Capture,$script:ExpectedFailureCapture) -or
            -not [object]::ReferenceEquals($Receipt,$script:ExpectedFailureReceipt)){throw 'fixture_wrong_pin_boundary_subject'}
        $script:FailureConstructorPinCalls.Add([pscustomobject]@{originalHandles=$false;scm=$false})
    }
    function script:Invoke-WorkerScmChange {$script:FailureConstructorForbidden.Add('SCM');throw 'fixture_forbidden_scm'}
    function script:Get-WorkerServiceRow {$script:FailureConstructorForbidden.Add('ServiceQuery');throw 'fixture_forbidden_service_query'}
    function script:Invoke-WorkerMaintenanceHttp {$script:FailureConstructorForbidden.Add('HTTP');throw 'fixture_forbidden_http'}
    function script:Invoke-WorkerNodeProcess {$script:FailureConstructorForbidden.Add('Node');throw 'fixture_forbidden_node'}
    function script:New-WorkerBackup {$script:FailureConstructorForbidden.Add('NewBackup');throw 'fixture_forbidden_new_backup'}
    function script:Write-WorkerStartupFailureProof {$script:FailureConstructorForbidden.Add('ProofWriter');throw 'fixture_forbidden_proof_writer'}
    function script:Invoke-WorkerRecovery {$script:FailureConstructorForbidden.Add('Recover');throw 'fixture_forbidden_recover'}
} $script:PinCalls $forbidden
function New-ConstructorFixture([string]$Name){
    $f=New-StorageFixture $Name
    $newVersion='inert-new-v2';$newRoot=Join-Path $f.Receipt.programRoot $newVersion;New-PrivateDirectory $newRoot
    $inventory=Call-Private 'Read-WorkerJson' @((Join-Path $f.VersionRoot 'package.inventory.json'))
    $inventory.version=$newVersion
    foreach($entry in $inventory.files){
        $path=Join-Path $newRoot $entry.path.Replace('/','\');$parent=[IO.Path]::GetDirectoryName($path)
        if(-not [IO.Directory]::Exists($parent)){New-PrivateDirectory $parent}
        Put-PrivateFile $path ([IO.File]::ReadAllBytes((Join-Path $f.VersionRoot $entry.path.Replace('/','\'))))
    }
    $startupMarker=[Text.Encoding]::ASCII.GetBytes("ZEB_STARTUP_OBSERVATION_V1`n")
    Put-PrivateFile (Join-Path $newRoot 'startup-observation.v1') $startupMarker
    $inventory.files=@($inventory.files)+@([pscustomobject]@{path='startup-observation.v1';bytes=$startupMarker.Length;sha256=(Hash-Bytes $startupMarker)})
    $newInventoryRaw=Json-Bytes $inventory;Put-PrivateFile (Join-Path $newRoot 'package.inventory.json') $newInventoryRaw
    Put-PrivateFile (Join-Path $newRoot 'app\worker.config.json') ([IO.File]::ReadAllBytes((Join-Path $f.VersionRoot 'app\worker.config.json')))
    $newSha=Hash-Bytes $newInventoryRaw
    $null=Call-Private 'Test-WorkerInstalledPayload' @($newRoot,$newSha,$f.Receipt.configSha256)
    # Enrich only this new fixture before original evidence publication; the old reviewed fixture source is untouched.
    $engineRaw=[IO.File]::ReadAllBytes((Join-Path $f.Receipt.dataRoot 'engine\manifest.json'))
    Put-PrivateFile (Join-Path $f.Receipt.dataRoot 'engine\installation-manifest.json') $engineRaw
    Put-PrivateFile (Join-Path $f.Backup.value.root 'engine\installation-manifest.json') $engineRaw
    # Use a real read-only service SID ACE without creating/querying a Windows service.
    $sidHash=[Security.Cryptography.SHA1]::Create()
    try{$sidBytes=$sidHash.ComputeHash([Text.Encoding]::Unicode.GetBytes('ZEBIMAGEENHANCEMENT'))}finally{$sidHash.Dispose()}
    $serviceSid=[Security.Principal.SecurityIdentifier]::new('S-1-5-80-'+((0..4|ForEach-Object {[BitConverter]::ToUInt32($sidBytes,$_ * 4).ToString([Globalization.CultureInfo]::InvariantCulture)}) -join '-'))
    if($serviceSid.Value -ceq $f.Receipt.tokenUserSid){throw 'fixture_service_sid_not_distinct'}
    $sourceAcls=@{}
    foreach($relative in @('records','records/original.json')){
        $path=Join-Path $f.Receipt.dataRoot $relative.Replace('/','\');$info=[Zeb.WorkerInstall.Native]::Inspect($path)
        $security=if($info.Directory){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}
        $security.SetSecurityDescriptorSddlForm($info.SecuritySddl)
        $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($serviceSid,[Security.AccessControl.FileSystemRights]::ReadAndExecute,
            [Security.AccessControl.InheritanceFlags]::None,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
        $sddl=$security.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group -bor [Security.AccessControl.AccessControlSections]::Access)
        [Zeb.WorkerInstall.Native]::RestoreMetadata($path,$sddl,$info.CreationUtc,$info.LastWriteUtc,$info.Attributes)
        $sourceAcls[$relative]=[Zeb.WorkerInstall.Native]::Inspect($path).SecuritySddl
        if($sourceAcls[$relative] -cne $sddl -or $sourceAcls[$relative] -ceq $info.SecuritySddl){throw 'fixture_service_acl_not_applied'}
    }
    $f.Manifest=Call-Private 'Get-WorkerSnapshot' @($f.Receipt.dataRoot)
    # CopySnapshot keeps backup caller-only. Restore DAT with each backup object's own SDDL.
    foreach($entry in ($f.Manifest.entries|Sort-Object {$_.path.Length})){
        $target=Join-Path $f.Backup.value.root $entry.path.Replace('/','\');$info=[Zeb.WorkerInstall.Native]::Inspect($target)
        [Zeb.WorkerInstall.Native]::RestoreMetadata($target,$info.SecuritySddl,$entry.creationUtc,$entry.lastWriteUtc,[uint32]$entry.attributes)
    }
    $null=Call-Private 'Assert-WorkerSnapshot' @($f.Backup.value.root,$f.Manifest)
    $backupManifestPath=Join-Path $f.Backup.value.root 'manifest.json'
    [IO.File]::WriteAllBytes($backupManifestPath,(Json-Bytes $f.Manifest))
    $f.Backup.value.manifestSha256=[Zeb.WorkerInstall.Native]::Hash($backupManifestPath)
    [IO.File]::WriteAllBytes($f.Backup.path,(Json-Bytes $f.Backup.value))
    Rebind-BackupFixture $f
    $projection=Json-Value $f.Receipt|ConvertFrom-Json;$projection.previous=$f.Evidence.OldActive
    $null=Call-Private 'Read-WorkerBackup' @($f.Backup.path,$projection)
    $sourceVsBackupAclDifferent=$true
    foreach($relative in @('records','records/original.json')){
        $entries=@($f.Manifest.entries|Where-Object {$_.path -ceq $relative})
        $backupInfo=[Zeb.WorkerInstall.Native]::Inspect((Join-Path $f.Backup.value.root $relative.Replace('/','\')))
        if($entries.Count -ne 1 -or $entries[0].securitySddl -cne $sourceAcls[$relative] -or $backupInfo.SecuritySddl -ceq $sourceAcls[$relative]){
            $sourceVsBackupAclDifferent=$false
        }
    }
    if(-not $sourceVsBackupAclDifferent){throw 'fixture_source_backup_acl_not_distinct'}
    $script:AclDifferencePreflights++;$script:PreflightCount++
    # Bind the target before the real old-evidence writer freezes its stopped receipt.
    $f.Receipt.operation.targetSha256=$newSha
    $null=Call-Private 'Write-WorkerLedger' @($f.ReceiptPath,$f.Receipt)
    $f.ReceiptRaw=[Zeb.WorkerInstall.Native]::ReadBytes($f.ReceiptPath)
    $null=Call-Private 'Write-WorkerUpgradeEvidence' @($f.Evidence,$f.Receipt,$f.ReceiptPath,$f.Backup,[DateTime]::UtcNow.AddSeconds(30))
    if($null -eq $f.Evidence.EvidencePath -or $f.Evidence.EvidenceSha256 -cne [Zeb.WorkerInstall.Native]::Hash($f.Evidence.EvidencePath)){
        throw 'original_upgrade_evidence_pointer_not_published'
    }
    $starting=Json-Value $f.Receipt|ConvertFrom-Json
    $starting.previous=Json-Value $f.Receipt.active|ConvertFrom-Json
    $starting.active=[pscustomobject]@{version=$newVersion;inventorySha256=$newSha;imagePath=('"'+(Join-Path $newRoot 'WindowsServiceHost.exe')+'"')}
    $starting.operation.stage='started';$starting.operation.outcome='pending'
    $null=Call-Private 'Write-WorkerLedger' @($f.ReceiptPath,$starting)
    $startingRaw=[Zeb.WorkerInstall.Native]::ReadBytes($f.ReceiptPath)
    $scene=New-Scene $FailurePhase;$capture=$scene.Capture;$context=$scene.ContextDocument
    $deadline=[DateTime]::UtcNow.AddSeconds(30);$context.cutoffTick64=[Zeb.WorkerInstall.Native]::TickCount64()+[long]30000
    $context.operationId=$starting.operation.operationId;$context.startupAttemptId=[Guid]::NewGuid().ToString('D')
    $context.pipeName='zeb-worker-startup-v1-'+$context.startupAttemptId.Replace('-','')
    $context.startingReceiptSha256=Hash-Bytes $startingRaw;$context.inventorySha256=$newSha
    $context.configSha256=$starting.configSha256;$context.engineManifestSha256=$starting.engineManifestSha256
    $context.hostSha256=[Zeb.WorkerInstall.Native]::Hash((Join-Path $newRoot 'WindowsServiceHost.exe'))
    $context.nodeSha256=[Zeb.WorkerInstall.Native]::Hash((Join-Path $newRoot 'runtime\node.exe'))
    $context.expectedServiceSid=$starting.tokenUserSid
    $process=[Diagnostics.Process]::GetCurrentProcess()
    try{$image=$process.MainModule.FileName;$pidValue=$process.Id;$created=$process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture);$session=$process.SessionId}finally{$process.Dispose()}
    $context.caller=[ordered]@{pid=$pidValue;creationFileTime=$created;imagePath=$image;
        imageSha256=(Get-FileHash -LiteralPath $image -Algorithm SHA256).Hash.ToLowerInvariant();tokenUserSid=$starting.tokenUserSid;sessionId=$session}
    $capture.ContextRaw=$utf8.GetBytes((Json-Value $context));$capture.Context=[Zeb.WorkerInstall.Native]::ReadStartupContext($capture.ContextRaw)
    $capture.OperationId=$starting.operation.operationId
    foreach($name in @('CallerPin','ExpectedServiceSid','HostPath','NodePath','SourceModuleSha256','IntentPath','IntentSha256','FailureStage','FailureType')){
        $capture|Add-Member -NotePropertyName $name -NotePropertyValue $null
    }
    $capture.CallerPin=[pscustomobject]@{Pin=[pscustomobject]@{pid=$context.caller.pid;creationFileTime=$context.caller.creationFileTime;
        imagePath=$image;tokenUserSid=$context.caller.tokenUserSid;sessionId=$session};ImageSha256=$context.caller.imageSha256}
    $capture.ExpectedServiceSid=$context.expectedServiceSid;$capture.HostPath=Join-Path $newRoot 'WindowsServiceHost.exe'
    $capture.NodePath=Join-Path $newRoot 'runtime\node.exe';$capture.SourceModuleSha256=$ModuleSha
    foreach($role in @('Host','Node')){
        $pin=$capture.($role+'Pin')
        $pin|Add-Member -NotePropertyName imagePath -NotePropertyValue $capture.($role+'Path')
        $pin|Add-Member -NotePropertyName tokenUserSid -NotePropertyValue $context.expectedServiceSid
        $pin|Add-Member -NotePropertyName sessionId -NotePropertyValue 0
    }
    foreach($document in $scene.Documents){
        $document.operationId=$context.operationId;$document.startupAttemptId=$context.startupAttemptId;$document.nonce=$context.nonce
    }
    $prepared=$scene.Documents[0]
    foreach($key in @('startingReceiptSha256','inventorySha256','configSha256','engineManifestSha256','hostSha256','nodeSha256')){$prepared[$key]=$context[$key]}
    $capture.PreparedSha256=Hash-Bytes (Wire $prepared)
    foreach($index in 1..3){$scene.Documents[$index].preparedSha256=$capture.PreparedSha256}
    $scene.Documents[3].phase.attempt=$context.startupAttemptId;$scene.Documents[3].phase.nonce=$context.nonce
    foreach($index in 0..3){$capture.RawFrames[$index].raw=Wire $scene.Documents[$index]}
    $rawContext=$capture.ContextRaw
    $intent=[ordered]@{v=1;kind='startup_intent';operationId=$starting.operation.operationId;startupAttemptId=$context.startupAttemptId;
        installationId=$starting.installationId;serviceId=$starting.serviceId;clientId=$starting.clientId;active=$starting.active;previous=$starting.previous;
        sourceModuleSha256=$ModuleSha;startingReceiptSha256=(Hash-Bytes $startingRaw);contextSha256=(Hash-Bytes $rawContext);
        configSha256=$starting.configSha256;engineManifestSha256=$starting.engineManifestSha256;
        materials=[ordered]@{startingReceipt=[ordered]@{bytes=$startingRaw.Length;sha256=(Hash-Bytes $startingRaw)};
            context=[ordered]@{bytes=$rawContext.Length;sha256=(Hash-Bytes $rawContext)}};
        missingRecoveryEvidence=@('oldStop','verifiedBackup','failureCloseout')}
    $intentRaw=Json-Bytes ([pscustomobject]$intent)
    $startupRoot=Join-Path (Join-Path $starting.dataRoot 'installation') ('startup-'+$context.startupAttemptId);New-PrivateDirectory $startupRoot
    Put-PrivateFile (Join-Path $startupRoot 'starting-receipt.json') $startingRaw
    Put-PrivateFile (Join-Path $startupRoot 'context.json') $rawContext
    Put-PrivateFile (Join-Path $startupRoot 'intent.json') $intentRaw
    $capture.IntentPath=Join-Path $startupRoot 'intent.json';$capture.IntentSha256=Hash-Bytes $intentRaw
    $parsed=@(Call-Private 'Read-WorkerStartupFailureFrames' @($capture))
    if($parsed.Count -ne 4){throw 'real_frame_consumer_preflight_failed'}
    $script:FramePreflights++
    $failed=Json-Value $starting|ConvertFrom-Json;$failed.state='unknown';$failed.operation.outcome='unknown'
    $null=Call-Private 'Write-WorkerLedger' @($f.ReceiptPath,$failed)
    $f.Receipt=$failed
    return [pscustomobject]@{Base=$f;Capture=$capture;Starting=$starting;StartingRaw=$startingRaw;ContextRaw=$rawContext;IntentRaw=$intentRaw;
        FailedRaw=[Zeb.WorkerInstall.Native]::ReadBytes($f.ReceiptPath);Documents=$scene.Documents;
        Deadline=$deadline;StartupRoot=$startupRoot;NewRoot=$newRoot;NewInventoryRaw=$newInventoryRaw;SourceVsBackupAclDifferent=$sourceVsBackupAclDifferent}
}
function Protected-State($F){
    return Json-Value ([pscustomobject]@{original=(Inputs-State $F.Base);newPayload=(Tree-State $F.NewRoot);
        installationTree=(Tree-State (Join-Path $F.Base.Receipt.dataRoot 'installation'));
        capture=(Json-Value $F.Capture);upgrade=(Json-Value $F.Base.Evidence)})
}
function Validate-Candidate($E,$F){
    $keys=@('OperationId','StartupAttemptId','DataRoot','ReceiptPath','FailedReceiptRaw','SourceModuleSha256','ContextCutoffTick64',
        'DeadlineUtcTicks','ExistingMaterials','NewMaterials','ProofRaw','Closeout','PublishedPath','PublishedSha256')
    if(-not (Keys-Match $E $keys) -or $E.OperationId -cne $F.Capture.OperationId -or
        $E.StartupAttemptId -cne $F.Capture.Context['startupAttemptId'] -or $E.DataRoot -cne $F.Base.Receipt.dataRoot -or
        $E.ReceiptPath -cne $F.Base.ReceiptPath -or $E.SourceModuleSha256 -cne $ModuleSha -or
        $E.ContextCutoffTick64 -ne $F.Capture.Context['cutoffTick64'] -or $E.DeadlineUtcTicks -ne $F.Deadline.Ticks -or
        $E.FailedReceiptRaw -isnot [byte[]] -or [Convert]::ToBase64String($E.FailedReceiptRaw) -cne [Convert]::ToBase64String($F.FailedRaw) -or
        $null -ne $E.PublishedPath -or $null -ne $E.PublishedSha256 -or $E.ProofRaw -isnot [byte[]]){return $false}
    if(-not (Keys-Match $E.Closeout @('captureReleased','privilegesRestored','installationLocksReleased'))){return $false}
    foreach($key in @('captureReleased','privilegesRestored','installationLocksReleased')){if($E.Closeout.$key -isnot [bool] -or $E.Closeout.$key){return $false}}
    $oldNames=@('starting-receipt.json','context.json','intent.json');$newNames=@('failed-receipt.json','prepared.frame','ack-prepared.frame','authorized.frame','settled.frame','failed-snapshot.json')
    if((@($E.ExistingMaterials|ForEach-Object {$_.name}) -join ',') -cne ($oldNames -join ',') -or
        (@($E.NewMaterials|ForEach-Object {$_.name}) -join ',') -cne ($newNames -join ',')){return $false}
    $expected=@{'starting-receipt.json'=$F.StartingRaw;'context.json'=$F.ContextRaw;'intent.json'=$F.IntentRaw;'failed-receipt.json'=$F.FailedRaw}
    foreach($index in 0..3){$expected[$newNames[$index+1]]=$F.Capture.RawFrames[$index].raw}
    $proof=ConvertFrom-Json -InputObject $utf8.GetString($E.ProofRaw) -ErrorAction Stop
    if($proof.v -ne 1 -or $proof.kind -cne 'startup_failure_proof' -or $proof.operationId -cne $E.OperationId -or
        $proof.startupAttemptId -cne $E.StartupAttemptId -or $proof.failedReceiptSha256 -cne (Hash-Bytes $F.FailedRaw) -or
        $proof.sourceModuleSha256 -cne $ModuleSha -or $proof.cutoffTick64 -ne $E.ContextCutoffTick64 -or
        $proof.deadlineUtcTicks -cne $F.Deadline.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) -or
        @($proof.materials.PSObject.Properties).Count -ne 9){return $false}
    foreach($material in @($E.ExistingMaterials)+@($E.NewMaterials)){
        if(-not (Keys-Match $material @('name','raw')) -or $material.raw -isnot [byte[]]){return $false}
        if($expected.ContainsKey($material.name) -and ([object]::ReferenceEquals($material.raw,$expected[$material.name]) -or
            [Convert]::ToBase64String($material.raw) -cne [Convert]::ToBase64String($expected[$material.name]))){return $false}
        $entry=$proof.materials.PSObject.Properties[$material.name].Value
        if(-not (Keys-Match $entry @('bytes','sha256')) -or $entry.bytes -ne $material.raw.Length -or $entry.sha256 -cne (Hash-Bytes $material.raw)){return $false}
        if($material.name -ceq 'failed-snapshot.json'){
            $manifest=ConvertFrom-Json -InputObject $utf8.GetString($material.raw) -ErrorAction Stop
            $null=& $module {param($Root,$Manifest) Assert-WorkerSnapshot -Root $Root -Manifest $Manifest -Security} $F.Base.Receipt.dataRoot $manifest
            if((Json-Value $manifest) -cne (Json-Value (Call-Private 'Get-WorkerSnapshot' @($F.Base.Receipt.dataRoot)))){return $false}
            if($proof.failedSnapshotSha256 -cne (Hash-Bytes $material.raw)){return $false}
        }
    }
    foreach($key in @('captureReleased','privilegesRestored','installationLocksReleased')){if($proof.closeout.$key -cne $true){return $false}}
    foreach($key in @('installationId','serviceId','clientId')){if($proof.$key -cne $F.Base.Receipt.$key){return $false}}
    if((Json-Value $proof.active) -cne (Json-Value $F.Starting.active) -or (Json-Value $proof.previous) -cne (Json-Value $F.Starting.previous) -or
        $proof.startingReceiptSha256 -cne (Hash-Bytes $F.StartingRaw) -or $proof.contextSha256 -cne (Hash-Bytes $F.ContextRaw) -or
        $proof.preparedSha256 -cne $F.Capture.PreparedSha256 -or $proof.jobName -cne $F.Capture.JobName -or
        $proof.upgradeEvidence.path -cne $F.Base.Evidence.EvidencePath -or $proof.upgradeEvidence.sha256 -cne $F.Base.Evidence.EvidenceSha256 -or
        $proof.backup.path -cne $F.Base.Backup.path -or $proof.backup.sha256 -cne [Zeb.WorkerInstall.Native]::Hash($F.Base.Backup.path) -or
        $proof.backup.manifestPath -cne (Join-Path $F.Base.Backup.value.root 'manifest.json') -or
        $proof.backup.manifestSha256 -cne $F.Base.Backup.value.manifestSha256){return $false}
    $expectedPhase=$F.Documents[3].phase
    if(-not (Keys-Match $proof.phase @($expectedPhase.Keys))){return $false}
    foreach($key in $expectedPhase.Keys){if($proof.phase.$key -cne $expectedPhase[$key]){return $false}}
    $expectedCaller=$F.Capture.Context['caller']
    if(-not (Keys-Match $proof.pins @('caller','host','node')) -or -not (Keys-Match $proof.pins.caller @($expectedCaller.Keys)) -or
        -not (Keys-Match $proof.exits @('hostExitCode','nodeExitCode','pipeEof')) -or
        $proof.exits.hostExitCode -ne 1 -or $proof.exits.nodeExitCode -ne 2 -or $proof.exits.pipeEof -cne $true){return $false}
    foreach($key in $expectedCaller.Keys){if($proof.pins.caller.$key -cne $expectedCaller[$key]){return $false}}
    foreach($role in @('host','node')){
        $pin=$F.Capture.($role+'Pin');$projection=$proof.pins.$role
        if(-not (Keys-Match $projection @('pid','creationFileTime','imagePath','tokenUserSid','sessionId'))){return $false}
        foreach($key in @('pid','creationFileTime','imagePath','tokenUserSid','sessionId')){if($projection.$key -cne $pin.$key){return $false}}
    }
    return $true
}
$phase='setup';$unexpected=$null
try{
    New-PrivateDirectory $FixtureRoot
    foreach($name in $names){
        $variants=if($name -ceq 'original_deadline_refused'){@('utc','tick')}else{@('single')}
        foreach($variant in $variants){
            $phase=$name+'.'+$variant+'.prepare';$f=New-ConstructorFixture ($name+'-'+$variant)
            switch($name){
                'unknown_receipt_additional_change_refused'{$f.Base.Receipt.clientId=[Guid]::NewGuid().ToString('D');$null=Call-Private 'Write-WorkerLedger' @($f.Base.ReceiptPath,$f.Base.Receipt)}
                'self_consistent_old_source_mismatch_refused'{
                    $path=Join-Path $f.Base.EvidenceRoot 'old-stop.json';$old=Call-Private 'Read-WorkerJson' @($path);$old.source='foreign_source'
                    [IO.File]::WriteAllBytes($path,(Json-Bytes $old))
                    $index=Call-Private 'Read-WorkerJson' @($f.Base.Evidence.EvidencePath);$entry=$index.materials.PSObject.Properties['old-stop.json'].Value
                    $entry.bytes=[IO.File]::ReadAllBytes($path).Length;$entry.sha256=[Zeb.WorkerInstall.Native]::Hash($path)
                    [IO.File]::WriteAllBytes($f.Base.Evidence.EvidencePath,(Json-Bytes $index));$f.Base.Evidence.EvidenceSha256=[Zeb.WorkerInstall.Native]::Hash($f.Base.Evidence.EvidencePath)
                }
                'successful_upgrade_pointer_missing_refused'{$f.Base.Evidence.EvidencePath=$null}
                'backup_payload_tamper_refused'{[IO.File]::AppendAllText((Join-Path $f.Base.Backup.value.root 'records\original.json'),'tamper',[Text.Encoding]::ASCII)}
                'new_full_payload_tamper_refused'{[IO.File]::AppendAllText((Join-Path $f.NewRoot 'WindowsServiceHost.dll'),'tamper',[Text.Encoding]::ASCII)}
                'original_frame_missing_refused'{$f.Capture.RawFrames.RemoveAt(3)}
                'original_deadline_refused'{
                    if($variant -ceq 'utc'){$f.Deadline=[DateTime]::UtcNow.AddMilliseconds(-1)}
                    else{
                        $context=$utf8.GetString($f.Capture.ContextRaw)|ConvertFrom-Json;$context.cutoffTick64=[Zeb.WorkerInstall.Native]::TickCount64()-[long]1
                        $f.Capture.ContextRaw=$utf8.GetBytes((Json-Value $context));$f.Capture.Context=[Zeb.WorkerInstall.Native]::ReadStartupContext($f.Capture.ContextRaw)
                        [IO.File]::WriteAllBytes((Join-Path $f.StartupRoot 'context.json'),$f.Capture.ContextRaw)
                        $intent=Call-Private 'Read-WorkerJson' @($f.Capture.IntentPath)
                        $intent.contextSha256=Hash-Bytes $f.Capture.ContextRaw
                        $intent.materials.context.bytes=$f.Capture.ContextRaw.Length;$intent.materials.context.sha256=$intent.contextSha256
                        [IO.File]::WriteAllBytes($f.Capture.IntentPath,(Json-Bytes $intent))
                        $f.Capture.IntentSha256=[Zeb.WorkerInstall.Native]::Hash($f.Capture.IntentPath)
                    }
                }
                'original_starting_material_tamper_refused'{[IO.File]::AppendAllText((Join-Path $f.StartupRoot 'starting-receipt.json'),' ',[Text.Encoding]::ASCII)}
            }
            $before=Protected-State $f;$pinBefore=$script:PinCalls.Count;$failure=$null;$validationFailureType=$null;$output=@();$accepted=$false
            & $module {param($Capture,$Receipt) $script:ExpectedFailureCapture=$Capture;$script:ExpectedFailureReceipt=$Receipt} $f.Capture $f.Base.Receipt
            $phase=$name+'.'+$variant+'.constructor';$script:ConstructorCalls++
            try{$output=@(Call-Private 'New-WorkerStartupFailureProof' @($f.Capture,$f.Base.Receipt,$f.Base.ReceiptPath,$f.Base.Evidence,$f.Deadline));$accepted=$true}
            catch{$failure=Root-Reason $_.Exception}
            $phase=$name+'.'+$variant+'.assert';$preserved=$before -ceq (Protected-State $f)
            if($name -ceq 'freezes_fourteen_key_failure_candidate'){
                try{$good=$accepted -and $output.Count -eq 1 -and $preserved -and $script:PinCalls.Count -gt $pinBefore -and (Validate-Candidate $output[0] $f)}
                catch{$good=$false;$validationFailureType=(Root-Reason $_.Exception).GetType().FullName}
            }else{
                $refused=$null -ne $failure -and ($failure.Message -cmatch '\Aworker_[a-z_]+\z' -or $failure -is [IO.InvalidDataException] -or
                    $failure -is [IO.IOException] -or $failure -is [InvalidOperationException] -or $failure -is [UnauthorizedAccessException] -or $failure -is [ComponentModel.Win32Exception])
                $good=-not $accepted -and $refused -and $preserved -and $output.Count -eq 0
            }
            $checks.Add(@{name=$name;variant=$variant;passed=[bool]$good;accepted=$accepted;outputCount=$output.Count;originalInputsPreserved=$preserved;
                sourceVsBackupAclDifferent=$f.SourceVsBackupAclDifferent;
                syntheticPinBoundaryCalls=$script:PinCalls.Count-$pinBefore;candidateValidationFailureType=$validationFailureType;
                failureType=$(if($null -ne $failure){$failure.GetType().FullName}else{$null});
                fixedCode=$(if($null -ne $failure -and $failure.Message -cmatch '\Aworker_[a-z_]+\z'){$failure.Message}else{$null})})
        }
    }
}catch{
    $reason=Root-Reason $_.Exception;$unexpected=@{phase=$phase;failureType=$reason.GetType().FullName;
        nativeErrorCode=$(if($reason -is [ComponentModel.Win32Exception]){$reason.NativeErrorCode}else{$null})}
}
$rows=@(foreach($name in $names){$parts=@($checks|Where-Object {$_.name -ceq $name});$expected=if($name -ceq 'original_deadline_refused'){2}else{1};
    @{name=$name;passed=$parts.Count -eq $expected -and @($parts|Where-Object {-not $_.passed}).Count -eq 0;checks=$parts}})
$seen=@($checks|ForEach-Object {$_.name}|Select-Object -Unique);$pending=@($names|Where-Object {$_ -cnotin $seen})
$executed=@($rows|Where-Object {$_.checks.Count -gt 0});$failed=@($executed|Where-Object {-not $_.passed})
$success=$pending.Count -eq 0 -and $failed.Count -eq 0 -and $null -eq $unexpected -and $forbidden.Count -eq 0 -and
    $script:PreflightCount -gt 0 -and $script:AclDifferencePreflights -eq $script:FramePreflights
Save-Report @{code='startup_failure_proof_constructor_controls_v4';passed=$success;moduleSha256=$ModuleSha;failurePhase=$FailurePhase;
    interfaceChecks=$interface.ToArray();interfacePassCount=$interface.Count;interfaceFailCount=0;
    behaviorPassCount=$executed.Count-$failed.Count;behaviorFailCount=$failed.Count;pendingBehaviorCount=$pending.Count;pendingBehaviorNames=$pending;
    rows=$rows;actualInvocationCount=$script:ConstructorCalls;actualConstructorInvoked=$script:ConstructorCalls -gt 0;constructorInvocationCount=$script:ConstructorCalls;
    unexpectedFailure=$unexpected;forbiddenCalls=$forbidden.ToArray();syntheticPinBoundaryCalls=$script:PinCalls.Count;
    actualNativeCompiled=$true;actualStorage=$script:PreflightCount -gt 0;actualInstalledPayloadValidation=$script:PreflightCount -gt 0;
    actualReadBackupAndSnapshot=$script:PreflightCount -gt 0;actualFrameParserPreflight=$script:FramePreflights;
    sourceVsBackupAclDifferent=($script:PreflightCount -gt 0 -and $script:AclDifferencePreflights -eq $script:FramePreflights);aclDifferencePreflightCount=$script:AclDifferencePreflights;
    actualOriginalHandles=$false;actualScm=$false;actualSessionZeroOrServiceSid=$false;actualStartupIntentWriter=$false;
    actualDatabaseVerification=$false;actualNewWorkerBackup=$false;actualCloseout=$false;actualFailureProof=$false;actualRecover=$false;actualGpu=$false;
    nonAuthorSourceReviewRequired='constructor consumes original three-leaf v1 intent plus four strict wires and Unknown-only delta; exact successful upgrade index/source/backup and full old/new payload checks; sole synthetic provenance boundary AssertFailurePins; frozen fourteen-key candidate, no writes or authority';
    scope='real imported constructor/parser/hash/receipt/backup/snapshot/payload methods with own inert files and actual distinct source service-read ACL versus caller-only backup ACL; original reviewed fixture definitions only, never old control loops; synthetic public pins/SCM origin and inert database bytes; unpublished semantic candidate only'}
if(-not $success){exit 1}
exit 0
