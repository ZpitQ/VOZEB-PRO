param(
    [Parameter(Mandatory=$true)][string]$ModulePath,
    [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ModuleSha,
    [Parameter(Mandatory=$true)][string]$FixtureRoot,
    [Parameter(Mandatory=$true)][string]$OutputPath,
    [switch]$Internal
)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
if($PSVersionTable.PSVersion.Major -ne 5 -or $null -ne ('Zeb.WorkerInstall.Native' -as [type])){throw 'fresh_winps5_required'}
$ModulePath=[IO.Path]::GetFullPath($ModulePath);$FixtureRoot=[IO.Path]::GetFullPath($FixtureRoot);$OutputPath=[IO.Path]::GetFullPath($OutputPath)
$ModuleSha=$ModuleSha.ToLowerInvariant()
if((Get-FileHash -LiteralPath $ModulePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ModuleSha){throw 'module_changed'}
if(Test-Path -LiteralPath $OutputPath){throw 'output_already_exists'}
$module=Import-Module -Name $ModulePath -Force -PassThru
if(@($module).Count -ne 1){throw 'actual_module_not_unique'}
$names=@('bind_failure_complete_file_transaction','schema_failure_complete_file_transaction','proof_tamper_zero_recovery_writes',
    'backup_payload_tamper_zero_recovery_writes','failed_tree_tamper_zero_recovery_writes','missing_original_lock_zero_recovery_writes',
    'real_original_lock_contention_zero_recovery_writes','partial_move_preserves_originals_and_unknown',
    'unique_start_failure_preserves_archive_and_unknown','cleanup_failure_preserves_archive_and_unknown')
if($Internal){$names=@('internal_no_proof_complete_transaction','internal_backup_damage_refused','internal_changed_data_refused',
    'internal_missing_lock_refused','internal_concurrent_operation_refused','internal_port_occupied_refused',
    'internal_running_service_refused','internal_partial_move_preserves_data','internal_start_failure_preserves_data',
    'internal_cleanup_failure_preserves_data','internal_database_failure_preserves_data')}
$requestKeys=@('Receipt','ExpectedFailedReceiptSha256','FailedOperationId','BackupReceipt','ExpectedBackupReceiptSha256',
    'FailureProof','ExpectedFailureProofSha256','RecoveryRoot','CredentialFile','TimeoutSeconds')
$interfaces=[Collections.Generic.List[object]]::new();$rows=[Collections.Generic.List[object]]::new()
$command=& $module {$ExecutionContext.SessionState.InvokeCommand.GetCommand('Invoke-WorkerRecovery',[Management.Automation.CommandTypes]::Function)}
$apiValid=$null -ne $command -and $null -ne $command.Module -and
    [string]::Equals($command.Module.Path,$ModulePath,[StringComparison]::OrdinalIgnoreCase) -and -not $module.ExportedFunctions.ContainsKey('Invoke-WorkerRecovery')
$declared=@();$nativeMoveSites=0
if($apiValid){
    $body=$command.ScriptBlock.Ast;if($body -is [Management.Automation.Language.FunctionDefinitionAst]){$body=$body.Body}
    $parameters=@($body.ParamBlock.Parameters);$declared=@($parameters|ForEach-Object {$_.Name.VariablePath.UserPath})
    $apiValid=$parameters.Count -eq 1 -and ($declared -join ',') -ceq 'Request' -and $parameters[0].StaticType -eq [hashtable]
    $nativeMoveSites=@($body.FindAll({param($Node)
        $Node -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $Node.Static -and
        $Node.Member -is [Management.Automation.Language.StringConstantExpressionAst] -and $Node.Member.Value -ceq 'MoveObject' -and
        $Node.Expression -is [Management.Automation.Language.TypeExpressionAst] -and $Node.Expression.TypeName.FullName -ceq 'Zeb.WorkerInstall.Native'
    },$true)).Count
}
$interfaces.Add(@{name='private_InvokeWorkerRecovery_Request_hashtable';passed=[bool]$apiValid;present=$null -ne $command;declaredParameters=$declared})
$entryPath=Join-Path ([IO.Path]::GetDirectoryName($ModulePath)) 'Recover-Worker.ps1'
$entryExists=[IO.File]::Exists($entryPath);$entryParams=@();$entryValid=$false
if($entryExists){
    $tokens=$null;$errors=$null;$entryAst=[Management.Automation.Language.Parser]::ParseFile($entryPath,[ref]$tokens,[ref]$errors)
    if($errors.Count -ne 0){throw 'entry_parser_preparation_failed'}
    $entryParams=@($entryAst.ParamBlock.Parameters|ForEach-Object {$_.Name.VariablePath.UserPath})
    $entryValid=$entryParams.Count -eq 10 -and ($entryParams -join ',') -ceq ($requestKeys -join ',')
}
$interfaces.Add(@{name='separate_thin_entry_original_ten_parameters';passed=$entryValid;present=$entryExists;declaredParameters=$entryParams})
function Save-Report($Report){
    if((Get-FileHash -LiteralPath $ModulePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ModuleSha){throw 'module_changed_during_controls'}
    $raw=[Text.UTF8Encoding]::new($false,$true).GetBytes(($Report|ConvertTo-Json -Depth 16 -Compress)+[char]10)
    $stream=[IO.FileStream]::new($OutputPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try{$stream.Write($raw,0,$raw.Length)}finally{$stream.Dispose()}
    [Console]::Write([Text.Encoding]::UTF8.GetString($raw))
}
$badInterfaces=@($interfaces|Where-Object {-not $_.passed})
if($badInterfaces.Count -ne 0){
    Save-Report @{code='explicit_recovery_interface_red_v3';passed=$false;moduleSha256=$ModuleSha;interfaceChecks=$interfaces.ToArray();
        interfacePassCount=$interfaces.Count-$badInterfaces.Count;interfaceFailCount=$badInterfaces.Count;
        behaviorPassCount=0;behaviorFailCount=0;pendingBehaviorCount=$names.Count;pendingBehaviorNames=$names;
        actualNativeCompiled=$false;actualStorage=$false;actualRecoveryConsumerInvoked=$false;actualOriginalCopySnapshot=$false;
        actualIndependentEntryExecuted=$false;actualProcessLifetimeLock=$false;actualScm=$false;actualFailureProof=$false;actualRecover=$false;actualGpu=$false;
        scope='actual private API and thin-entry AST only; no fixture, native compilation, old control loop or recovery behavior executed'}
    exit 1
}
if(Test-Path -LiteralPath $FixtureRoot){throw 'fixture_already_exists'}
# Exact reviewed definitions only; never execute any preceding script's setup or control loop.
$sources=@(
    @{name='windows-upgrade-evidence.ps1';sha='aedcdada9c31af32705270666afd074e5ee4654de552a013201d830fdba03db9';functions=@(
        'Call-Private','New-PrivateDirectory','Put-PrivateFile','Json-Bytes','Hash-Bytes','Json-Value','Root-Reason','Keys-Match',
        'File-Facts','Tree-State','Inputs-State','Rebind-BackupFixture','New-StorageFixture')},
    @{name='windows-startup-failure-frames.ps1';sha='c966c5d82170e934913d74801f4b7211bab946671b506f051c0fc45ed58482ab';functions=@('Bytes-Hash','Wire','New-Scene')},
    @{name='windows-startup-failure-proof-constructor.ps1';sha='468ea0f531c8625b7b655c049ec7c7c96c2e19c26ecb2c2604a43f9d6779a37d';functions=@('New-ConstructorFixture')}
)
foreach($source in $sources){
    $path=Join-Path $PSScriptRoot $source.name
    if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $source.sha){throw 'fixture_source_changed'}
    $tokens=$null;$errors=$null;$parsed=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
    if($errors.Count -ne 0){throw 'fixture_source_parser_failed'}
    $definitions=@($parsed.FindAll({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst]},$true))
    foreach($name in $source.functions){
        $found=@($definitions|Where-Object {$_.Name -ceq $name});if($found.Count -ne 1){throw 'fixture_definition_not_unique'}
        $definitionText=$found[0].Extent.Text
        if($name -ceq 'New-ConstructorFixture'){
            $oldPredicate="if(`$serviceSid.Value -ceq `$f.Receipt.tokenUserSid){throw 'fixture_service_sid_not_distinct'}"
            $newPredicate="if(`$serviceSid.Value -ceq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value){throw 'fixture_service_sid_not_distinct'}"
            if(-not $definitionText.Contains($oldPredicate)){throw 'fixture_distinct_sid_predicate_changed'}
            $definitionText=$definitionText.Replace($oldPredicate,$newPredicate)
        }
        . ([scriptblock]::Create($definitionText))
    }
}
& $module {Initialize-WorkerInstallNative}
$utf8=[Text.UTF8Encoding]::new($false,$true);$FailurePhase='listener_bind_failed'
$script:PreflightCount=0;$script:FramePreflights=0;$script:AclDifferencePreflights=0;$script:ConsumerCalls=0;$script:PublishedFixtures=0
$hash=[Security.Cryptography.SHA1]::Create()
try{$sidBytes=$hash.ComputeHash([Text.Encoding]::Unicode.GetBytes('ZEBIMAGEENHANCEMENT'))}finally{$hash.Dispose()}
$script:FixtureServiceSid='S-1-5-80-'+((0..4|ForEach-Object {[BitConverter]::ToUInt32($sidBytes,$_ * 4).ToString([Globalization.CultureInfo]::InvariantCulture)}) -join '-')
$script:OriginalStorageFactory=(Get-Command New-StorageFixture -CommandType Function).ScriptBlock
function New-StorageFixture([string]$SceneName){
    $f=& $script:OriginalStorageFactory $SceneName
    # Synthetic service identity is prepared consistently before the original old-evidence publication.
    $f.Receipt.tokenUserSid=$script:FixtureServiceSid;$f.Backup.value.tokenUserSid=$script:FixtureServiceSid
    foreach($generation in @($f.Evidence.First,$f.Evidence.Second)){foreach($role in @('host','node')){$generation.$role.tokenUserSid=$script:FixtureServiceSid}}
    [IO.File]::WriteAllBytes($f.Backup.path,(Json-Bytes $f.Backup.value));Rebind-BackupFixture $f
    $null=Call-Private 'Write-WorkerLedger' @($f.ReceiptPath,$f.Receipt);$f.ReceiptRaw=[Zeb.WorkerInstall.Native]::ReadBytes($f.ReceiptPath)
    return $f
}
# Preserve real file/lock operations. Only the explicitly named provenance, privilege, DB and /B seams are controlled.
& $module {
    $script:RecoveryControlState=$null;$script:ExpectedFailureCapture=$null;$script:ExpectedFailureReceipt=$null
    $script:RecoveryOriginalOpenLock=(Get-Command Open-WorkerInstallLock -CommandType Function).ScriptBlock
    $script:RecoveryOriginalLedger=(Get-Command Write-WorkerLedger -CommandType Function).ScriptBlock
    $script:RecoveryOriginalExclusive=(Get-Command Open-WorkerExclusiveObject -CommandType Function).ScriptBlock
    function script:Recovery-Event([string]$Value){if($null -ne $script:RecoveryControlState){$script:RecoveryControlState.Events.Add($Value)}}
    function script:Recovery-Deadline([DateTime]$Deadline){
        $s=$script:RecoveryControlState;$null=Get-WorkerRemainingMilliseconds $Deadline
        if($Deadline.Kind -ne [DateTimeKind]::Utc){$s.Violations.Add('deadline_kind');throw 'fixture_deadline_changed'}
        if($null -eq $s.FirstDeadline){
            $s.FirstDeadline=$Deadline
            if($Deadline -lt $s.StartedUtc.AddSeconds(59.5) -or $Deadline -gt [DateTime]::UtcNow.AddSeconds(60.5)){
                $s.Violations.Add('deadline_not_original_recovery_timeout');throw 'fixture_deadline_changed'
            }
        }elseif($Deadline.Ticks -ne $s.FirstDeadline.Ticks){$s.Violations.Add('deadline_extended');throw 'fixture_deadline_changed'}
        $s.DeadlineChecks++
    }
    function script:Recovery-PartialConflict {
        $s=$script:RecoveryControlState
        if($null -eq $s -or -not $s.Active -or $s.Mode -cne 'partial' -or $s.PartialInjected){return}
        $archive=[IO.Path]::Combine($s.RecoveryRoot,'archive')
        if($s.DatabaseChecks -eq 1 -and -not [IO.Directory]::Exists([IO.Path]::Combine($archive,'records'))){
            # Own conflict is armed before the real moves: store can move, then no-overwrite records refuses.
            if(-not [IO.Directory]::Exists($archive)){New-WorkerCallerDirectory $archive}
            New-WorkerCallerDirectory ([IO.Path]::Combine($archive,'records'));$s.PartialInjected=$true;Recovery-Event 'fixture-partial-destination-conflict'
        }
    }
    function script:Assert-WorkerStartupFailurePins($Capture,$Receipt,[DateTime]$Deadline){
        if($null -ne $script:RecoveryControlState -and $script:RecoveryControlState.Active){
            $script:RecoveryControlState.Violations.Add('live_pins_recollected');throw 'fixture_live_pins_recollection_forbidden'
        }
        $null=Get-WorkerRemainingMilliseconds $Deadline
        if(-not [object]::ReferenceEquals($Capture,$script:ExpectedFailureCapture) -or
            -not [object]::ReferenceEquals($Receipt,$script:ExpectedFailureReceipt)){throw 'fixture_wrong_pin_subject'}
    }
    function script:Open-WorkerInstallLock([string]$Path,[string]$OperationId,[switch]$Existing){
        $s=$script:RecoveryControlState
        if($null -eq $s -or -not $s.Active){return & $script:RecoveryOriginalOpenLock -Path $Path -OperationId $OperationId -Existing:$Existing}
        Recovery-Event 'original-lock-open';$s.LockCalls++
        if($Path -cne $s.LockPath -or -not $Existing){$s.Violations.Add('different_lock');throw 'fixture_wrong_lock'}
        if(-not [IO.File]::Exists($Path)){$s.MissingLockOpens++}
        $handle=& $script:RecoveryOriginalOpenLock -Path $Path -OperationId $OperationId -Existing:$Existing
        $s.Locks.Add($handle);return $handle
    }
    function script:Write-WorkerLedger([string]$Path,$Value){
        $s=$script:RecoveryControlState
        if($null -ne $s -and $s.Active){
            $s.LedgerWrites++;Recovery-Event 'real-ledger-write';Recovery-PartialConflict
            $known=($null -ne $Value.PSObject.Properties['operation'] -and $Value.operation.outcome -ceq 'known') -or
                ($null -ne $Value.PSObject.Properties['outcome'] -and $Value.outcome -ceq 'known')
            if($known){
                $s.KnownWrites++;Recovery-Event 'real-ledger-known'
                if($s.PrivilegeDisposals -ne 1 -or -not $s.PrivilegesRestored){
                    $s.KnownBeforeCleanupWrites++;$s.Violations.Add('known_before_successful_cleanup')
                }
            }
        }
        & $script:RecoveryOriginalLedger -Path $Path -Value $Value
    }
    function script:Open-WorkerExclusiveObject([string]$LiteralPath,[DateTime]$Deadline){
        if($null -ne $script:RecoveryControlState -and $script:RecoveryControlState.Active){Recovery-Deadline $Deadline;Recovery-PartialConflict}
        return & $script:RecoveryOriginalExclusive -LiteralPath $LiteralPath -Deadline $Deadline
    }
    function script:Enter-WorkerInstallPrivileges([DateTime]$Deadline){
        $s=$script:RecoveryControlState;Recovery-Deadline $Deadline;$s.PrivilegeEntries++;Recovery-Event 'synthetic-privileges-enter'
        $value=[pscustomobject]@{Disposed=$false}
        $value|Add-Member -MemberType ScriptMethod -Name Dispose -Value {
            $s=$script:RecoveryControlState;$s.PrivilegeDisposals++;Recovery-Event 'synthetic-privileges-dispose'
            if($s.Locks.Count -gt 0 -and @($s.Locks|Where-Object {$_.CanRead}).Count -eq 0){$s.Violations.Add('cleanup_after_unlock');throw 'fixture_cleanup_after_unlock'}
            if($s.Mode -ceq 'cleanup'){throw 'worker_privilege_restore_unknown'}
            $s.PrivilegesRestored=$true;$this.Disposed=$true
        }
        return $value
    }
    function script:Copy-WorkerSnapshot($Source,$Destination,$Manifest,[DateTime]$Deadline){
        $s=$script:RecoveryControlState;Recovery-Deadline $Deadline;$s.CopyCalls++;Recovery-Event 'technical-copy-real-files'
        if($Source -cne $s.BackupRoot -or $Destination -cne [IO.Path]::Combine($s.RecoveryRoot,'staging')){
            $s.Violations.Add('copy_source_or_destination');throw 'fixture_copy_subject_invalid'
        }
        foreach($name in @('intent.json','recovery-receipt.json','failed-receipt.json','failed-snapshot.json')){
            Assert-WorkerCallerFile ([IO.Path]::Combine($s.RecoveryRoot,$name))
        }
        if([Zeb.WorkerInstall.Native]::Hash([IO.Path]::Combine($s.RecoveryRoot,'failed-receipt.json')) -cne $s.FailedReceiptSha -or
            [Zeb.WorkerInstall.Native]::Hash([IO.Path]::Combine($s.RecoveryRoot,'failed-snapshot.json')) -cne $s.FailedSnapshotSha){
            $s.Violations.Add('raw_archive_not_before_staging');throw 'fixture_raw_archive_invalid'
        }
        New-WorkerCallerDirectory $Destination
        foreach($entry in ($Manifest.entries|Sort-Object {$_.path.Length})){
            $target=[IO.Path]::Combine($Destination,$entry.path.Replace('/','\'))
            if($entry.kind -ceq 'directory'){New-WorkerCallerDirectory $target}
            else{Copy-WorkerFile ([IO.Path]::Combine($Source,$entry.path.Replace('/','\'))) $target}
        }
        foreach($entry in $Manifest.entries){
            $target=[IO.Path]::Combine($Destination,$entry.path.Replace('/','\'));$info=[Zeb.WorkerInstall.Native]::Inspect($target)
            [Zeb.WorkerInstall.Native]::RestoreMetadata($target,$info.SecuritySddl,$entry.creationUtc,$entry.lastWriteUtc,[uint32]$entry.attributes)
        }
        Assert-WorkerSnapshot -Root $Destination -Manifest $Manifest
        $s.StageRoot=$Destination
        foreach($name in @('store','records','engine','config','tls')){$s.StageIdentities[$name]=[Zeb.WorkerInstall.Native]::Inspect([IO.Path]::Combine($Destination,$name)).Identity}
    }
    function script:Test-WorkerSnapshotDatabase($Root,$Receipt,[DateTime]$Deadline){
        $s=$script:RecoveryControlState;Recovery-Deadline $Deadline;$s.DatabaseChecks++;Recovery-Event 'synthetic-old-database-check'
        if($Root -cne $s.StageRoot -or $Receipt.active.version -cne $s.OldActive.version -or $Receipt.serviceId -cne $s.ServiceId -or
            [Zeb.WorkerInstall.Native]::Hash($s.ReceiptPath) -cne $s.FailedReceiptSha){
            $s.Violations.Add('database_not_old_code_staging');throw 'fixture_database_subject_invalid'
        }
        Recovery-PartialConflict
        if($s.Mode -ceq 'database'){throw 'worker_backup_invalid'}
    }
    function script:Assert-WorkerNativeAcl($Receipt,[string]$Sid){
        $s=$script:RecoveryControlState
        if($null -eq $s -or -not $s.Active -or $Receipt.tokenUserSid -cne $s.ServiceSid -or $Sid -cne $s.ServiceSid){throw 'fixture_identity_acl_subject_invalid'}
        $s.IdentityChecks++;Recovery-Event 'synthetic-native-service-acl'
    }
    function script:Get-WorkerServiceGeneration($Receipt,[DateTime]$Deadline,[switch]$WaitForReady){
        $s=$script:RecoveryControlState;Recovery-Deadline $Deadline;$s.GenerationCalls++;Recovery-PartialConflict
        if($Receipt.serviceId -cne $s.ServiceId -or $Receipt.clientId -cne $s.ClientId -or $Receipt.tokenUserSid -cne $s.ServiceSid){throw 'fixture_service_subject_invalid'}
        $generation=[pscustomobject]@{exists=$true;serviceName='ZebImageEnhancement';status=$(if($s.Started -or $s.Mode -ceq 'running'){'Running'}else{'Stopped'});imagePath=$Receipt.active.imagePath;
            accountName='NT SERVICE\ZebImageEnhancement';tokenUserSid=$s.ServiceSid;sessionId=0;candidateSid=$s.ServiceSid;
            bootId=$(if($s.Started){$s.NewBoot}else{$null});host=$null;node=$null;endpoint=$null}
        if($s.Started){
            $root=Get-WorkerVersionRoot $Receipt.programRoot $Receipt.active.version
            $generation.host=[pscustomobject]@{pid=711;creationFileTime='10001';imagePath=[IO.Path]::Combine($root,'WindowsServiceHost.exe');tokenUserSid=$s.ServiceSid;sessionId=0}
            $generation.node=[pscustomobject]@{pid=712;creationFileTime='10002';imagePath=[IO.Path]::Combine($root,'runtime','node.exe');tokenUserSid=$s.ServiceSid;sessionId=0}
            $generation.endpoint=[pscustomobject]@{scheme='http';host='127.0.0.1';port=1;ownerPid=712;bootId=$s.NewBoot}
        }
        $generation|Add-Member -MemberType ScriptMethod -Name Dispose -Value {Recovery-Event 'synthetic-generation-dispose'}
        return $generation
    }
    function script:Get-NetTCPConnection {
        param($State,$ErrorAction)
        if($script:RecoveryControlState.Mode -ceq 'port'){return [pscustomobject]@{LocalAddress='::';LocalPort=1;OwningProcess=711}}
    }
    function script:Get-WorkerServiceRow {
        $s=$script:RecoveryControlState;Recovery-PartialConflict
        return [pscustomobject]@{Name='ZebImageEnhancement';State=$(if($s.Started){'Running'}else{'Stopped'});ProcessId=$(if($s.Started){711}else{0});
            StartName='NT SERVICE\ZebImageEnhancement';PathName=$s.CurrentImagePath;StartMode='Auto'}
    }
    function script:Assert-WorkerGeneration($Generation,$Receipt,[switch]$AllowUnboundBoot){
        $s=$script:RecoveryControlState;$s.IdentityChecks++
        if($Generation.imagePath -cne $Receipt.active.imagePath -or $Generation.tokenUserSid -cne $s.ServiceSid -or
            $Receipt.serviceId -cne $s.ServiceId -or $Receipt.clientId -cne $s.ClientId){throw 'fixture_generation_subject_invalid'}
    }
    function script:Start-WorkerOwnedService($Receipt,[string]$ReceiptPath,[DateTime]$Deadline,[switch]$Create,[switch]$Switch,[ref]$StartupCapture,[switch]$DeferCompletion){
        $s=$script:RecoveryControlState;Recovery-Deadline $Deadline;$s.StartCalls++;Recovery-Event 'technical-switch-start'
        if($Create -or -not $Switch -or -not $DeferCompletion -or $ReceiptPath -cne $s.ReceiptPath -or $Receipt.active.version -cne $s.OldActive.version -or
            $Receipt.operation.action -cne 'Rollback' -or $Receipt.operation.operationId -ceq $s.FailedOperation -or
            $Receipt.operation.outcome -cne 'pending' -or $Receipt.operation.targetSha256 -cne $s.BackupReceiptSha -or
            $Receipt.serviceId -cne $s.ServiceId -or $Receipt.clientId -cne $s.ClientId -or $Receipt.tokenUserSid -cne $s.ServiceSid){throw 'fixture_start_subject_invalid'}
        Assert-WorkerSnapshot -Root $Receipt.dataRoot -Manifest $s.BackupManifest -Security
        foreach($name in @('store','records','engine','config','tls')){
            if([Zeb.WorkerInstall.Native]::Inspect([IO.Path]::Combine($Receipt.dataRoot,$name)).Identity -cne $s.StageIdentities[$name]){throw 'fixture_staging_not_moved'}
        }
        if($s.Mode -ceq 'start'){throw 'worker_startup_observation_unknown'}
        $s.Started=$true;$s.CurrentImagePath=$Receipt.active.imagePath
        $Receipt.state='pending';$Receipt.operation.stage='started';$Receipt.operation.outcome='pending'
        Save-WorkerStage $ReceiptPath $Receipt 'started' 'pending'
    }
    function script:New-WorkerBackup {if($null -ne $script:RecoveryControlState){$script:RecoveryControlState.Violations.Add('NewBackup')};throw 'fixture_new_backup_forbidden'}
    function script:Invoke-WorkerScmChange {if($null -ne $script:RecoveryControlState){$script:RecoveryControlState.Violations.Add('SCM')};throw 'fixture_real_scm_forbidden'}
    function script:Invoke-WorkerNodeProcess {if($null -ne $script:RecoveryControlState){$script:RecoveryControlState.Violations.Add('Node')};throw 'fixture_real_node_forbidden'}
    function script:Invoke-WorkerMaintenanceHttp([string]$Method,$Generation,[string]$Bearer,[DateTime]$Deadline){
        $s=$script:RecoveryControlState;Recovery-Deadline $Deadline
        if($Method -cne 'GET'){$s.Violations.Add('HTTP_'+$Method);throw 'fixture_http_mutation_forbidden'}
        if(-not $s.Started -or $Generation.status -cne 'Running' -or $Generation.imagePath -cne $s.CurrentImagePath -or
            $Generation.bootId -cne $s.NewBoot -or $Generation.endpoint.bootId -cne $s.NewBoot -or
            $Bearer -cne $s.Bearer){throw 'fixture_http_subject_invalid'}
        $s.GetCalls++;Recovery-Event 'synthetic-maintenance-get'
        return [pscustomobject]@{bootId=$s.NewBoot;sealed=$false;state='open';canStop=$false;
            store=[pscustomobject]@{queued=0;running=0;slots=0;unreleasedReferences=0};
            http=[pscustomobject]@{sealed=$false;uploads=0;downloads=0;receipts=0};
            pending=[pscustomobject]@{selfTestAdmission=0;selfTestOutputRead=0;runner=0;adapter=0};
            runtime=[pscustomobject]@{closing=$false;startupRecovery='settled';
                runner=[pscustomobject]@{closed=$false;storeClosed=$false;recoveryState='idle';recoveryInFlight=$false;ownedState='none'};
                adapter=[pscustomobject]@{sealed=$false;activity='idle';close='not_requested'}}}
    }
    function script:Stop-WorkerOwnedService {if($null -ne $script:RecoveryControlState){$script:RecoveryControlState.Violations.Add('Stop')};throw 'fixture_extra_stop_forbidden'}
}
function New-RecoveryFixture([string]$SceneName,[string]$Phase){
    $script:FailurePhase=$Phase;$f=New-ConstructorFixture $SceneName
    # Restore the real caller metadata after preparing synthetic service metadata before publication.
    $context=$utf8.GetString($f.Capture.ContextRaw)|ConvertFrom-Json
    $context.caller.tokenUserSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $f.Capture.CallerPin.Pin.tokenUserSid=$context.caller.tokenUserSid
    $f.Capture.ContextRaw=$utf8.GetBytes((Json-Value $context));$f.Capture.Context=[Zeb.WorkerInstall.Native]::ReadStartupContext($f.Capture.ContextRaw)
    $f.ContextRaw=$f.Capture.ContextRaw
    [IO.File]::WriteAllBytes((Join-Path $f.StartupRoot 'context.json'),$f.ContextRaw)
    $intent=Call-Private 'Read-WorkerJson' @($f.Capture.IntentPath)
    $intent.contextSha256=Hash-Bytes $f.ContextRaw;$intent.materials.context.bytes=$f.ContextRaw.Length;$intent.materials.context.sha256=$intent.contextSha256
    $f.IntentRaw=Json-Bytes $intent;[IO.File]::WriteAllBytes($f.Capture.IntentPath,$f.IntentRaw);$f.Capture.IntentSha256=Hash-Bytes $f.IntentRaw
    # Failed data differs from the selected healthy backup. These are inert bytes, never SQLite/schema-gate evidence.
    [IO.File]::WriteAllBytes((Join-Path $f.Base.Receipt.dataRoot 'store\worker.sqlite'),[Text.Encoding]::ASCII.GetBytes('INERT_FAILED_'+$Phase))
    Put-PrivateFile (Join-Path $f.Base.Receipt.dataRoot 'store\failed-only.bin') ([Text.Encoding]::ASCII.GetBytes('INERT_FAILED_ONLY'))
    & $module {param($Capture,$Receipt) $script:ExpectedFailureCapture=$Capture;$script:ExpectedFailureReceipt=$Receipt} $f.Capture $f.Base.Receipt
    $candidate=@(Call-Private 'New-WorkerStartupFailureProof' @($f.Capture,$f.Base.Receipt,$f.Base.ReceiptPath,$f.Base.Evidence,$f.Deadline))
    if($candidate.Count -ne 1){throw 'fixture_constructor_not_scalar'}
    # Sole producer-origin seam: synthetic pins and synthetic closeout flags; the real writer/file publication is exercised.
    foreach($name in @('captureReleased','privilegesRestored','installationLocksReleased')){$candidate[0].Closeout.$name=$true}
    $null=Call-Private 'Write-WorkerStartupFailureProof' @($candidate[0],$f.Deadline)
    $proofPath=Join-Path $f.StartupRoot 'failure-proof.json'
    if($candidate[0].PublishedPath -cne $proofPath -or $candidate[0].PublishedSha256 -cne [Zeb.WorkerInstall.Native]::Hash($proofPath)){throw 'fixture_final_proof_not_published'}
    $scene=[IO.Path]::GetDirectoryName($f.Base.Receipt.dataRoot);$credentialPath=Join-Path $scene 'credential.json'
    $pairing=[pscustomobject]@{serviceId=$f.Base.Receipt.serviceId;credential=[pscustomobject]@{clientId=$f.Base.Receipt.clientId;
        credentialId=[Guid]::NewGuid().ToString('D');version=1;key=('s'*43)}}
    Put-PrivateFile $credentialPath (Json-Bytes $pairing);$null=Call-Private 'Read-WorkerCredential' @($credentialPath,$f.Base.Receipt)
    $lockPath=Join-Path $f.Base.Receipt.dataRoot 'installation\operation.lock'
    $setupLock=Call-Private 'Open-WorkerInstallLock' @($lockPath,$f.Base.Receipt.operation.operationId)
    try{$null=$setupLock.CanRead}finally{$setupLock.Dispose()}
    $lockId=[Zeb.WorkerInstall.Native]::Inspect($lockPath).Identity
    $request=@{Receipt=$f.Base.ReceiptPath;ExpectedFailedReceiptSha256=[Zeb.WorkerInstall.Native]::Hash($f.Base.ReceiptPath);
        FailedOperationId=$f.Base.Receipt.operation.operationId;BackupReceipt=$f.Base.Backup.path;ExpectedBackupReceiptSha256=[Zeb.WorkerInstall.Native]::Hash($f.Base.Backup.path);
        FailureProof=$proofPath;ExpectedFailureProofSha256=[Zeb.WorkerInstall.Native]::Hash($proofPath);RecoveryRoot=(Join-Path $scene 'recovery');
        CredentialFile=$credentialPath;TimeoutSeconds=60}
    $failedDirectories=@{};$failedStates=@{}
    foreach($name in @('store','records','engine','config','tls')){
        $path=Join-Path $f.Base.Receipt.dataRoot $name;$failedDirectories[$name]=[Zeb.WorkerInstall.Native]::Inspect($path).Identity;$failedStates[$name]=Tree-State $path
    }
    $script:PublishedFixtures++
    return [pscustomobject]@{F=$f;Request=$request;CredentialPath=$credentialPath;Pairing=$pairing;LockPath=$lockPath;LockIdentity=$lockId;
        FailedDirectories=$failedDirectories;FailedStates=$failedStates;FailedRaw=[Zeb.WorkerInstall.Native]::ReadBytes($request.Receipt)}
}
function Immutable-State($Fixture){
    return Json-Value ([pscustomobject]@{program=(Tree-State $Fixture.F.Base.Receipt.programRoot);backup=(Tree-State $Fixture.F.Base.Backup.value.root);
        credential=(File-Facts $Fixture.CredentialPath);startup=(Tree-State $Fixture.F.StartupRoot);upgrade=(Tree-State $Fixture.F.Base.EvidenceRoot)})
}
function Failed-State($Fixture){
    $roots=[ordered]@{};foreach($name in @('store','records','engine','config','tls')){$roots[$name]=Tree-State (Join-Path $Fixture.F.Base.Receipt.dataRoot $name)}
    return Json-Value ([pscustomobject]@{receipt=(File-Facts $Fixture.Request.Receipt);directories=[pscustomobject]$roots})
}
function Original-Failed-Directories-Preserved($Fixture){
    foreach($name in @('store','records','engine','config','tls')){
        $matches=[Collections.Generic.List[string]]::new()
        foreach($parent in @($Fixture.F.Base.Receipt.dataRoot,(Join-Path $Fixture.Request.RecoveryRoot 'archive'))){
            $path=Join-Path $parent $name
            if([IO.Directory]::Exists($path) -and [Zeb.WorkerInstall.Native]::Inspect($path).Identity -ceq $Fixture.FailedDirectories[$name]){$matches.Add($path)}
        }
        if($matches.Count -ne 1 -or (Tree-State $matches[0]) -cne $Fixture.FailedStates[$name]){return $false}
    }
    return $true
}
function New-RuntimeState($Fixture,[string]$Mode){
    return [pscustomobject]@{Active=$true;Mode=$Mode;Events=[Collections.Generic.List[string]]::new();Violations=[Collections.Generic.List[string]]::new();
        Locks=[Collections.Generic.List[object]]::new();LockPath=$Fixture.LockPath;LockCalls=0;MissingLockOpens=0;LedgerWrites=0;KnownWrites=0;KnownBeforeCleanupWrites=0;
        ReceiptPath=$Fixture.Request.Receipt;FailedReceiptSha=$Fixture.Request.ExpectedFailedReceiptSha256;FailedOperation=$Fixture.Request.FailedOperationId;
        FailedSnapshotSha=[Zeb.WorkerInstall.Native]::Hash((Join-Path $Fixture.F.StartupRoot 'failed-snapshot.json'));
        BackupRoot=$Fixture.F.Base.Backup.value.root;BackupReceiptSha=$Fixture.Request.ExpectedBackupReceiptSha256;BackupManifest=$Fixture.F.Base.Manifest;
        RecoveryRoot=$Fixture.Request.RecoveryRoot;OldActive=$Fixture.F.Base.Receipt.previous;ServiceId=$Fixture.F.Base.Receipt.serviceId;
        ClientId=$Fixture.F.Base.Receipt.clientId;ServiceSid=$Fixture.F.Base.Receipt.tokenUserSid;CurrentImagePath=$Fixture.F.Base.Receipt.active.imagePath;
        StageRoot=$null;StageIdentities=@{};CopyCalls=0;DatabaseChecks=0;StartCalls=0;Started=$false;NewBoot=[Guid]::NewGuid().ToString('D');
        GenerationCalls=0;GetCalls=0;Bearer=$Fixture.Pairing.credential.key;IdentityChecks=0;PrivilegeEntries=0;PrivilegeDisposals=0;PrivilegesRestored=$false;
        PartialInjected=$false;FirstDeadline=$null;DeadlineChecks=0;StartedUtc=[DateTime]::UtcNow}
}
function Private-Archive-Valid($Fixture,$Current){
    $root=$Fixture.Request.RecoveryRoot
    foreach($name in @('intent.json','recovery-receipt.json','failed-receipt.json','failed-snapshot.json')){
        if(-not [IO.File]::Exists((Join-Path $root $name))){return $false}
        $null=Call-Private 'Assert-WorkerCallerFile' @((Join-Path $root $name))
    }
    $null=Call-Private 'Assert-WorkerCallerDirectory' @($root)
    if([Zeb.WorkerInstall.Native]::Hash((Join-Path $root 'failed-receipt.json')) -cne $Fixture.Request.ExpectedFailedReceiptSha256){return $false}
    if([Zeb.WorkerInstall.Native]::Hash((Join-Path $root 'failed-snapshot.json')) -cne
        [Zeb.WorkerInstall.Native]::Hash((Join-Path $Fixture.F.StartupRoot 'failed-snapshot.json'))){return $false}
    $archived=Call-Private 'Read-WorkerJson' @((Join-Path $root 'failed-receipt.json'))
    if($archived.state -cne 'unknown' -or $archived.operation.outcome -cne 'unknown' -or $archived.operation.operationId -cne $Fixture.Request.FailedOperationId){return $false}
    $private=Call-Private 'Read-WorkerJson' @((Join-Path $root 'recovery-receipt.json'))
    foreach($name in @('phase','outcome','bootId','qualificationRequired')){if($null -eq $private.PSObject.Properties[$name]){return $false}}
    $expectedProof=if($Internal){[Zeb.WorkerInstall.Native]::Hash((Join-Path $root 'failure-proof.json'))}else{$Fixture.Request.ExpectedFailureProofSha256}
    if($Internal -and (Call-Private 'Read-WorkerJson' @((Join-Path $root 'failure-proof.json'))).kind -cne 'internal_stopped_recovery'){return $false}
    if($private.schemaVersion -ne 1 -or $private.kind -cne 'worker_recovery' -or
        $private.failedOperationId -cne $Fixture.Request.FailedOperationId -or $private.failedReceiptSha256 -cne $Fixture.Request.ExpectedFailedReceiptSha256 -or
        $private.failureProofSha256 -cne $expectedProof -or $private.selectedBackupReceiptSha256 -cne $Fixture.Request.ExpectedBackupReceiptSha256){return $false}
    if($null -ne $Current -and $Current.operation.action -ceq 'Rollback' -and $private.recoveryOperationId -cne $Current.operation.operationId){return $false}
    return $true
}
$cases=@(
    @{name=$names[0];phase='listener_bind_failed';mode='positive'},@{name=$names[1];phase='store_schema_incompatible';mode='positive'},
    @{name=$names[2];phase='listener_bind_failed';mode='proof'},@{name=$names[3];phase='listener_bind_failed';mode='backup'},
    @{name=$names[4];phase='listener_bind_failed';mode='tree'},@{name=$names[5];phase='listener_bind_failed';mode='missing-lock'},
    @{name=$names[6];phase='listener_bind_failed';mode='locked'},@{name=$names[7];phase='listener_bind_failed';mode='partial'},
    @{name=$names[8];phase='listener_bind_failed';mode='start'},@{name=$names[9];phase='listener_bind_failed';mode='cleanup'}
)
if($Internal){
    $modes=@('positive','backup','tree','missing-lock','locked','port','running','partial','start','cleanup','database')
    $cases=@(for($i=0;$i -lt $modes.Count;$i++){@{name=$names[$i];phase='listener_bind_failed';mode=$modes[$i]}})
}
$phase='setup';$unexpected=$null
try{
    New-PrivateDirectory $FixtureRoot
    foreach($case in $cases){
        $phase=$case.name+'.prepare';$fixture=New-RecoveryFixture $case.name $case.phase;$request=$fixture.Request;$heldByHarness=$null
        if($Internal){
            $data=$fixture.F.Base.Receipt.dataRoot
            [IO.File]::WriteAllBytes((Join-Path $data 'store\worker.sqlite'),[IO.File]::ReadAllBytes((Join-Path $fixture.F.Base.Backup.value.root 'store\worker.sqlite')))
            [Zeb.WorkerInstall.Native]::DeleteObject((Join-Path $data 'store\failed-only.bin'))
            [Zeb.WorkerInstall.Native]::DeleteObject($request.FailureProof)
            $snapshot=Call-Private 'Get-WorkerSnapshot' @($data)
            [IO.File]::WriteAllBytes((Join-Path $fixture.F.StartupRoot 'failed-snapshot.json'),(Json-Bytes $snapshot))
            foreach($name in @('store','records','engine','config','tls')){$fixture.FailedStates[$name]=Tree-State (Join-Path $data $name)}
        }
        switch($case.mode){
            'proof'{[IO.File]::AppendAllText($request.FailureProof,' ',[Text.Encoding]::ASCII)}
            'backup'{[IO.File]::AppendAllText((Join-Path $fixture.F.Base.Backup.value.root 'records\original.json'),'tamper',[Text.Encoding]::ASCII)}
            'tree'{[IO.File]::AppendAllText((Join-Path $fixture.F.Base.Receipt.dataRoot 'store\worker.sqlite'),'tamper',[Text.Encoding]::ASCII)}
            'missing-lock'{[Zeb.WorkerInstall.Native]::DeleteObject($fixture.LockPath)}
            'locked'{$heldByHarness=& $module {param($Path,$OperationId) Open-WorkerInstallLock -Path $Path -OperationId $OperationId -Existing} $fixture.LockPath $request.FailedOperationId}
        }
        $immutableBefore=Immutable-State $fixture;$failedBefore=Failed-State $fixture
        $state=New-RuntimeState $fixture $case.mode
        & $module {param($State) $script:RecoveryControlState=$State} $state
        $phase=$case.name+'.recovery';$failure=$null;$output=@();$script:ConsumerCalls++
        $invokeRequest=$request
        if($Internal){$invokeRequest=@{};foreach($key in @('Receipt','BackupReceipt','RecoveryRoot','CredentialFile','TimeoutSeconds')){$invokeRequest[$key]=$request[$key]}}
        $inputCount=$invokeRequest.Count
        try{$output=@(Call-Private 'Invoke-WorkerRecovery' @($invokeRequest))}catch{$failure=Root-Reason $_.Exception}
        $phase=$case.name+'.assert';$validationFailure=$null;$good=$false;$lockAlive=$false;$sameLock=$false;$anchorHeld=$false;$transfers=0
        try{
            $result=if($output.Count -eq 1){$output[0]}else{$null}
            $valid=$null -ne $result -and $null -ne $result.PSObject.Properties['value'] -and $null -ne $result.PSObject.Properties['exitCode']
            $good=$null -eq $failure -and $output.Count -eq 1 -and $valid -and $state.Violations.Count -eq 0 -and $state.KnownBeforeCleanupWrites -eq 0 -and
                $immutableBefore -ceq (Immutable-State $fixture) -and $state.MissingLockOpens -eq 0
            if($Internal){$good=$good -and $inputCount -eq 5 -and -not [IO.File]::Exists($request.FailureProof)}
            if($valid){
                $public=Json-Value $result.value
                $good=$good -and -not $public.Contains($fixture.Pairing.credential.key) -and
                    $public -cnotmatch '"(?:path|token|credential|key|sid|pfx)"\s*:' -and $result.value.code -cmatch '\Aworker_[a-z_]+\z'
            }
            $zeroWrite=$case.mode -cin @('proof','backup','tree','missing-lock','locked','port','running')
            if($zeroWrite){
                $good=$good -and $result.exitCode -eq 1 -and $result.value.outcome -cin @('known','unknown') -and
                    $state.StartCalls -eq 0 -and $state.CopyCalls -eq 0 -and $state.LedgerWrites -eq 0 -and $state.KnownWrites -eq 0 -and
                    -not [IO.Directory]::Exists($request.RecoveryRoot) -and $failedBefore -ceq (Failed-State $fixture)
                if($case.mode -ceq 'missing-lock'){$good=$good -and $state.LockCalls -eq 0 -and -not [IO.File]::Exists($fixture.LockPath)}
            }else{
                $lockAlive=$state.Locks.Count -eq 1 -and $state.Locks[0].CanRead
                $anchor=& $module {$variable=Get-Variable -Name WorkerRecoveryLock -Scope Script -ErrorAction SilentlyContinue;if($null -ne $variable){$variable.Value}}
                $anchorHeld=$lockAlive -and [object]::ReferenceEquals($anchor,$state.Locks[0]) -and $anchor.CanRead
                if($lockAlive){
                    $refused=$false;$probe=$null
                    try{$probe=[IO.FileStream]::new($fixture.LockPath,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
                    catch{$refused=(Root-Reason $_.Exception) -is [IO.IOException]}
                    finally{if($null -ne $probe){$probe.Dispose()}}
                    $sameLock=$refused
                }
                $current=Call-Private 'Read-WorkerReceipt' @($request.Receipt)
                $good=$good -and $lockAlive -and $anchorHeld -and $sameLock -and $state.LockCalls -eq 1 -and $state.CopyCalls -eq 1 -and
                    $state.DatabaseChecks -eq 1 -and $state.PrivilegeEntries -eq 1 -and $state.PrivilegeDisposals -eq 1 -and
                    $state.DeadlineChecks -gt 0 -and (Private-Archive-Valid $fixture $current) -and (Original-Failed-Directories-Preserved $fixture)
                foreach($name in @('store','records','engine','config','tls')){
                    $archived=Join-Path (Join-Path $request.RecoveryRoot 'archive') $name;$live=Join-Path $fixture.F.Base.Receipt.dataRoot $name
                    if([IO.Directory]::Exists($archived) -and [Zeb.WorkerInstall.Native]::Inspect($archived).Identity -ceq $fixture.FailedDirectories[$name]){$transfers++}
                    if($state.StageIdentities.ContainsKey($name) -and [IO.Directory]::Exists($live) -and
                        [Zeb.WorkerInstall.Native]::Inspect($live).Identity -ceq $state.StageIdentities[$name]){$transfers++}
                }
                if($case.mode -ceq 'positive'){
                    $null=& $module {param($Root,$Manifest) Assert-WorkerSnapshot -Root $Root -Manifest $Manifest -Security} $fixture.F.Base.Receipt.dataRoot $fixture.F.Base.Manifest
                    $private=Call-Private 'Read-WorkerJson' @((Join-Path $request.RecoveryRoot 'recovery-receipt.json'))
                    $good=$good -and $transfers -eq 10 -and $state.StartCalls -eq 1 -and $state.Started -and $state.GetCalls -ge 1 -and
                        $state.KnownWrites -ge 1 -and $state.PrivilegesRestored -and
                        $result.exitCode -eq 0 -and $result.value.code -ceq 'worker_recovery_complete' -and $result.value.outcome -ceq 'known' -and
                        $result.value.qualificationRequired -is [bool] -and $result.value.qualificationRequired -and $result.value.bootId -ceq $state.NewBoot -and
                        $private.outcome -ceq 'known' -and $private.bootId -ceq $state.NewBoot -and $private.qualificationRequired -is [bool] -and $private.qualificationRequired -and
                        $current.state -ceq 'installed' -and $current.operation.action -ceq 'Rollback' -and $current.operation.outcome -ceq 'known' -and
                        $current.operation.operationId -cne $request.FailedOperationId -and $current.operation.targetSha256 -ceq $request.ExpectedBackupReceiptSha256 -and
                        $current.active.version -ceq $fixture.F.Base.Receipt.previous.version -and
                        $current.serviceId -ceq $fixture.F.Base.Receipt.serviceId -and $current.clientId -ceq $fixture.F.Base.Receipt.clientId -and
                        -not [IO.File]::Exists((Join-Path $fixture.F.Base.Receipt.dataRoot 'store\failed-only.bin'))
                }else{
                    $private=Call-Private 'Read-WorkerJson' @((Join-Path $request.RecoveryRoot 'recovery-receipt.json'))
                    $good=$good -and $result.exitCode -eq 1 -and $result.value.outcome -ceq 'unknown' -and $state.KnownWrites -eq 0 -and
                        $current.state -ceq 'unknown' -and $current.operation.outcome -ceq 'unknown' -and $private.outcome -ceq 'unknown'
                    if($case.mode -ceq 'database'){$good=$good -and $transfers -eq 0 -and $state.StartCalls -eq 0}
                    elseif($case.mode -ceq 'partial'){$good=$good -and $state.PartialInjected -and $transfers -gt 0 -and $transfers -lt 10 -and $state.StartCalls -eq 0}
                    else{$good=$good -and $transfers -eq 10 -and $state.StartCalls -eq 1 -and $current.operation.action -ceq 'Rollback'}
                }
            }
        }catch{$validationFailure=Root-Reason $_.Exception;$good=$false}
        finally{
            # Transaction slice only: verify no early unlock above, then the test owner explicitly releases its real handles.
            $state.Active=$false
            foreach($handle in $state.Locks){if($handle.CanRead){$handle.Dispose()}}
            & $module {param($Locks)
                $variable=Get-Variable -Name WorkerRecoveryLock -Scope Script -ErrorAction SilentlyContinue
                if($null -ne $variable){foreach($owned in $Locks){if([object]::ReferenceEquals($variable.Value,$owned)){$script:WorkerRecoveryLock=$null}}}
            } $state.Locks
            if($null -ne $heldByHarness){$heldByHarness.Dispose()}
        }
        $lockIdentityPreserved=if([IO.File]::Exists($fixture.LockPath)){[Zeb.WorkerInstall.Native]::Inspect($fixture.LockPath).Identity -ceq $fixture.LockIdentity}else{$case.mode -ceq 'missing-lock'}
        $good=$good -and $lockIdentityPreserved
        $rows.Add(@{name=$case.name;passed=[bool]$good;outputCount=$output.Count;technicalFailurePhase=$case.phase;
            publicCode=$(if($null -ne $result -and $null -ne $result.PSObject.Properties['value']){$result.value.code}else{$null});
            failureType=$(if($null -ne $failure){$failure.GetType().FullName}else{$null});validationFailureType=$(if($null -ne $validationFailure){$validationFailure.GetType().FullName}else{$null});
            fixedCode=$(if($null -ne $failure -and $failure.Message -cmatch '\Aworker_[a-z_]+\z'){$failure.Message}else{$null});
            directoryIdentityTransfers=$transfers;originalLockRetainedAtReturn=$lockAlive;actualModuleLockAnchorRetained=$anchorHeld;sameLockRejectsCompetingOpen=$sameLock;
            originalLockIdentityPreserved=$lockIdentityPreserved;harnessReleasedLocks=$true;actualProcessLifetimeLock=$false;
            technicalCopyCalls=$state.CopyCalls;technicalDatabaseChecks=$state.DatabaseChecks;technicalStartCalls=$state.StartCalls;technicalGetCalls=$state.GetCalls;
            realLedgerWrites=$state.LedgerWrites;knownLedgerWrites=$state.KnownWrites;knownBeforeSuccessfulCleanupWrites=$state.KnownBeforeCleanupWrites;
            syntheticPrivilegesRestored=$state.PrivilegesRestored;partialFaultInjected=$state.PartialInjected;deadlineChecks=$state.DeadlineChecks;
            violations=$state.Violations.ToArray();events=$state.Events.ToArray()})
    }
}catch{
    $reason=Root-Reason $_.Exception;$unexpected=@{phase=$phase;failureType=$reason.GetType().FullName;
        fixedCode=$(if($reason.Message -cmatch '\Aworker_[a-z_]+\z'){$reason.Message}else{$null});
        invocationLine=[int]$_.InvocationInfo.ScriptLineNumber;
        scriptStackLines=@([regex]::Matches([string]$_.ScriptStackTrace,'(?:line|行)\s+([0-9]+)')|ForEach-Object {[int]$_.Groups[1].Value});
        nativeErrorCode=$(if($reason -is [ComponentModel.Win32Exception]){$reason.NativeErrorCode}else{$null})}
}
$failed=@($rows|Where-Object {-not $_.passed});$seen=@($rows|ForEach-Object {$_.name});$pending=@($names|Where-Object {$_ -cnotin $seen})
$success=$failed.Count -eq 0 -and $pending.Count -eq 0 -and $null -eq $unexpected
Save-Report @{code=$(if($Internal){'internal_recovery_transaction_controls_v1'}else{'explicit_recovery_transaction_controls_v3'});passed=$success;moduleSha256=$ModuleSha;interfaceChecks=$interfaces.ToArray();
    interfacePassCount=$interfaces.Count;interfaceFailCount=0;behaviorPassCount=$rows.Count-$failed.Count;behaviorFailCount=$failed.Count;
    pendingBehaviorCount=$pending.Count;pendingBehaviorNames=$pending;rows=$rows.ToArray();unexpectedFailure=$unexpected;
    actualRecoveryConsumerInvoked=$script:ConsumerCalls -gt 0;consumerInvocationCount=$script:ConsumerCalls;publishedFixtureCount=$script:PublishedFixtures;
    originalNativeMoveSourceSites=$nativeMoveSites;actualNativeCompiled=$true;actualStorage=$script:PublishedFixtures -gt 0;
    actualConstructorAndProofWriterStorage=$script:PublishedFixtures -gt 0;actualReadBackupAndSnapshot=$script:PublishedFixtures -gt 0;
    actualCredentialReader=$script:PublishedFixtures -gt 0;actualOriginalCopySnapshot=$false;actualOriginalNewBackup=$false;
    actualOriginalHandles=$false;actualServiceSidOrSessionZero=$false;actualDatabaseVerification=$false;actualSchema8Gate=$false;actualProductionBindFailure=$false;
    actualPrivilegeRestoration=$false;actualScm=$false;actualOriginalStartOwnedService=$false;actualHttp=$false;actualIndependentEntryExecuted=$false;
    actualProcessLifetimeLock=$false;transactionSliceOnly=$true;actualFailureProof=$false;actualRecover=$false;actualGpu=$false;
    nonAuthorSourceReviewRequired='exact ten-parameter entry/private Request; locked durable proof and all material sources revalidated; original lock existence precheck and original identity; raw archive before irreversible moves, old-code DB gate, real file operations, no auto retry/clear/rollback; same original recovery deadline; keep actual process lock until natural exit; all synthetic provenance seams remain technical';
    scope='real imported recovery body, persisted own constructor/writer materials, real caller-only files/archive/index/snapshot/metadata/original Native.MoveObject and real original lock; explicit synthetic pins/closeout/service/Start/privilege/DB and /B-copy adapter; harness releases locks after return assertions; no independent-process/SCM/bootstrap/DB/GPU end-to-end qualification'}
if(-not $success){exit 1}
exit 0
