param(
    [Parameter(Mandatory=$true)][string]$ModulePath,
    [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ModuleSha,
    [Parameter(Mandatory=$true)][string]$FixtureRoot,
    [Parameter(Mandatory=$true)][string]$OutputPath
)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
Set-StrictMode -Version Latest
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
if($PSVersionTable.PSVersion.Major -ne 5){throw 'actual_windows_powershell_5_required'}
if($null -ne ('Zeb.WorkerInstall.Native' -as [type])){throw 'fresh_native_process_required'}
$ModulePath=[IO.Path]::GetFullPath($ModulePath);$ModuleSha=$ModuleSha.ToLowerInvariant()
if((Get-FileHash -LiteralPath $ModulePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ModuleSha){throw 'module_changed'}
if(Test-Path -LiteralPath $OutputPath){throw 'output_already_exists'}
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($ModulePath,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count -ne 0){throw 'module_syntax_invalid'}
$module=Import-Module -Name $ModulePath -Force -PassThru -ErrorAction Stop
if(@($module).Count -ne 1){throw 'actual_module_not_unique'}
$behaviorNames=@('stored_exact_bytes_and_acl_previous','stored_exact_bytes_and_acl_null_previous','writer_create_new_collision',
    'writer_receipt_bytes_sha_mismatch','writer_context_operation_mismatch','writer_actual_caller_record_mismatch',
    'assert_material_attempt_tamper','partial_attempt_collision_preserved','assert_unknown_intent_key',
    'assert_material_path_forbidden','assert_missing_evidence_shape','assert_capture_path_mismatch','assert_capture_sha_mismatch','storage_never_creates_failure_proof')
$sourceNames=@('new_persists_then_checks_original_window','start_reasserts_same_intent_before_observed_start')
$interfaces=@(foreach($name in @('Write-WorkerStartupIntent','Assert-WorkerStartupIntent')){
    $definitions=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name},$true))
    $parameters=@()
    if($definitions.Count -eq 1 -and $null -ne $definitions[0].Body.ParamBlock){$parameters=@($definitions[0].Body.ParamBlock.Parameters|ForEach-Object {$_.Name.VariablePath.UserPath})}
    $passed=$definitions.Count -eq 1 -and $parameters.Count -eq 3 -and $parameters[0] -ceq 'Capture' -and $parameters[1] -ceq 'Receipt' -and $parameters[2] -ceq 'ReceiptPath'
    @{name=$name;passed=$passed;definitionCount=$definitions.Count;declaredParameters=$parameters}
})
function Save-Report($Report){
    if((Get-FileHash -LiteralPath $ModulePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ModuleSha){throw 'module_changed_during_controls'}
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Report|ConvertTo-Json -Depth 12)+[char]10)
    $stream=[IO.FileStream]::new($OutputPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try{$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
    [Console]::WriteLine([Text.Encoding]::UTF8.GetString($bytes))
}
$missing=@($interfaces|Where-Object {-not $_.passed})
if($missing.Count -gt 0){
    Save-Report @{code='startup_intent_interface_red';moduleSha256=$ModuleSha;interfaces=$interfaces;
        passCount=2-$missing.Count;failCount=$missing.Count;pendingStorageControls=$behaviorNames.Count;pendingSourceControls=$sourceNames.Count;
        callerFactoryExecuted=$false;actualStorageExecuted=$false;actualProducerSuccess=$false;actualScmStarted=$false;
        actualVirtualServiceCrossSid=$false;productionSessionZeroPolicyExercised=$false;failureProofCreated=$false;actualGpu=$false;
        scope='actual imported module and private declared interfaces only; missing interfaces do not count storage or source-order behavior as passed'}
    exit 1
}
$root=[IO.Path]::GetFullPath($FixtureRoot)
$moduleDirectory=[IO.DirectoryInfo]::new([IO.Path]::GetDirectoryName($ModulePath))
$workerRoot=$moduleDirectory.Parent.Parent.FullName
$expectedModule=[IO.Path]::Combine($workerRoot,'deployment','windows','Worker.Installation.psm1')
$cache=[IO.Path]::Combine($workerRoot,'node_modules','.cache')
if(-not [string]::Equals($ModulePath,$expectedModule,[StringComparison]::OrdinalIgnoreCase) -or -not [IO.Directory]::Exists($cache)){throw 'bound_worker_module_and_cache_required'}
if(-not $root.StartsWith($cache.TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or
    (Test-Path -LiteralPath $root)){throw 'exclusive_worker_cache_fixture_required'}
& $module {Initialize-WorkerInstallNative}
& $module {param($path) New-WorkerCallerDirectory $path} $root
$forbidden=[Collections.Generic.List[string]]::new()
& $module {
    param($calls)
    $script:StartupIntentForbiddenCalls=$calls
    function script:Invoke-WorkerScmChange {param($Action,$ImagePath,$Generation,$Deadline,$StartupArguments) $script:StartupIntentForbiddenCalls.Add('SCM');throw 'intent_fixture_forbidden_scm'}
    function script:Invoke-WorkerMaintenanceHttp {param($Method,$Generation,$Bearer,$Deadline) $script:StartupIntentForbiddenCalls.Add('HTTP');throw 'intent_fixture_forbidden_http'}
} $forbidden
$rows=[Collections.Generic.List[object]]::new();$sourceRows=[Collections.Generic.List[object]]::new()
$callerFactoryExecuted=$false;$storageExecuted=$false;$allLeasesClosed=$true;$knownAttemptRoots=[Collections.Generic.List[string]]::new()
function Hash-Bytes([byte[]]$Bytes){
    $sha=[Security.Cryptography.SHA256]::Create()
    try{return [BitConverter]::ToString($sha.ComputeHash($Bytes)).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
}
function Json-Bytes($Value){return ,([Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 12 -Compress)))}
function Root-Failure($Failure){while($null -ne $Failure.InnerException){$Failure=$Failure.InnerException};return $Failure}
function Keys-Match($Value,[string[]]$Keys){
    if($null -eq $Value -or $Value -isnot [pscustomobject]){return $false}
    $actual=@($Value.PSObject.Properties|ForEach-Object {$_.Name})
    if($actual.Count -ne $Keys.Count){return $false}
    foreach($key in $Keys){if($actual -cnotcontains $key){return $false}}
    return $true
}
function New-PrivateDirectory([string]$Path){& $module {param($path) New-WorkerCallerDirectory $path} $Path}
function Put-PrivateFile([string]$Path,[byte[]]$Bytes){& $module {param($path,$bytes) New-WorkerCallerFile -Path $path -Bytes $bytes} $Path $Bytes}
function Invoke-Intent([string]$Name,$Fixture){
    $null=& $module {param($name,$capture,$receipt,$path) & $name -Capture $capture -Receipt $receipt -ReceiptPath $path} $Name $Fixture.Capture $Fixture.Receipt $Fixture.ReceiptPath
}
function Assert-PrivateFile([string]$Path,[string]$Sid){
    & $module {param($path) Assert-WorkerCallerFile $path} $Path
    $info=[Zeb.WorkerInstall.Native]::Inspect($Path)
    $security=[Security.AccessControl.FileSecurity]::new();$security.SetSecurityDescriptorSddlForm($info.SecuritySddl)
    $rules=@($security.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
    return -not $info.Directory -and $security.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq $Sid -and $security.AreAccessRulesProtected -and
        $rules.Count -eq 1 -and $rules[0].IdentityReference.Value -ceq $Sid -and -not $rules[0].IsInherited -and
        [int]$rules[0].FileSystemRights -eq 0x001f01ff -and $rules[0].AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow
}
function File-Facts([string]$Path){
    $info=[Zeb.WorkerInstall.Native]::Inspect($Path)
    return [pscustomobject]@{identity=$info.Identity;bytes=$info.Bytes;sha256=([Zeb.WorkerInstall.Native]::Hash($Path));lastWrite=$info.LastWriteUtc;sddl=$info.SecuritySddl}
}
function Same-Facts($Before,$After){
    return $Before.identity -ceq $After.identity -and $Before.bytes -eq $After.bytes -and $Before.sha256 -ceq $After.sha256 -and
        $Before.lastWrite -ceq $After.lastWrite -and $Before.sddl -ceq $After.sddl
}
function Material-State($Fixture){
    $state=[ordered]@{}
    foreach($name in @('starting-receipt.json','context.json','intent.json')){
        $path=[IO.Path]::Combine($Fixture.AttemptRoot,$name)
        if([IO.File]::Exists($path)){$state[$name]=File-Facts $path}
    }
    return $state
}
function Same-State($Before,$After){
    if($Before.Count -ne $After.Count){return $false}
    foreach($key in $Before.Keys){if(-not $After.Contains($key) -or -not (Same-Facts $Before[$key] $After[$key])){return $false}}
    return $true
}
function Refused-Intent([string]$Name,$Fixture){
    try{Invoke-Intent $Name $Fixture;return $false}
    catch{$reason=Root-Failure $_.Exception;return $reason -is [IO.IOException] -or $reason -is [IO.InvalidDataException] -or
        $reason -is [InvalidOperationException] -or $reason -is [ComponentModel.Win32Exception] -or $reason -is [UnauthorizedAccessException] -or
        $reason.Message -cmatch '\Aworker_[a-z_]+\z'}
}
function New-StorageFixture([string]$Name,[bool]$NullPrevious){
    $scene=[IO.Path]::Combine($root,$Name);New-PrivateDirectory $scene
    $program=[IO.Path]::Combine($scene,'program');$data=[IO.Path]::Combine($scene,'data')
    foreach($path in @($program,$data,[IO.Path]::Combine($data,'installation'))){New-PrivateDirectory $path}
    $script:callerFactoryExecuted=$true
    $caller=[Zeb.WorkerInstall.Native]::PinStartupCaller()
    try{
        [Zeb.WorkerInstall.Native]::RequireStartupPin($caller.Pin)
        $pin=$caller.Pin
        $receipt=[pscustomobject]@{schemaVersion=1;installationId=[Guid]::NewGuid().ToString('D');state='installed';serviceName='ZebImageEnhancement';
            accountName='NT SERVICE\ZebImageEnhancement';tokenUserSid=$pin.tokenUserSid;sessionId=0;programRoot=$program;dataRoot=$data;storeSchemaVersion=7;
            serviceId=[Guid]::NewGuid().ToString('D');clientId=[Guid]::NewGuid().ToString('D');engineImportSha256=('1'*64);engineManifestSha256=('2'*64);configSha256=('3'*64);tlsSha256=$null;
            active=[pscustomobject]@{version='storage-new-v1';inventorySha256=('4'*64);imagePath=('"'+[IO.Path]::Combine($program,'storage-new-v1','WindowsServiceHost.exe')+'"')};
            previous=$(if($NullPrevious){$null}else{[pscustomobject]@{version='storage-old-v1';inventorySha256=('5'*64);imagePath=('"'+[IO.Path]::Combine($program,'storage-old-v1','WindowsServiceHost.exe')+'"')}});
            lastStopped=$null;operation=[pscustomobject]@{operationId=[Guid]::NewGuid().ToString('D');action='Upgrade';stage='started';outcome='pending';maintenanceBootId=$null;targetSha256=('4'*64)}}
        # Expected receipt fields are storage DTO values, not evidence of actual service SID or Session0.
        $receiptText=" `n"+($receipt|ConvertTo-Json -Depth 10 -Compress)+"`n  `n"
        $receiptRaw=[Text.UTF8Encoding]::new($false).GetBytes($receiptText)
        $receiptPath=[IO.Path]::Combine($data,'installation','receipt.json');Put-PrivateFile $receiptPath $receiptRaw
        $nonce=[byte[]]::new(32);$random=[Security.Cryptography.RandomNumberGenerator]::Create()
        try{$random.GetBytes($nonce)}finally{$random.Dispose()}
        $attempt=[Guid]::NewGuid().ToString('D')
        $context=[ordered]@{v=1;operationId=$receipt.operation.operationId;startupAttemptId=$attempt;startingReceiptSha256=(Hash-Bytes $receiptRaw);
            pipeName=('zeb-worker-startup-v1-'+$attempt.Replace('-',''));nonce=[BitConverter]::ToString($nonce).Replace('-','').ToLowerInvariant();
            cutoffTick64=([Zeb.WorkerInstall.Native]::TickCount64()+60000L);
            caller=[ordered]@{pid=$pin.pid;creationFileTime=$pin.creationFileTime;imagePath=$pin.imagePath;imageSha256=$caller.ImageSha256;tokenUserSid=$pin.tokenUserSid;sessionId=$pin.sessionId};
            expectedServiceSid=$pin.tokenUserSid;inventorySha256=$receipt.active.inventorySha256;configSha256=$receipt.configSha256;
            engineManifestSha256=$receipt.engineManifestSha256;hostSha256=('6'*64);nodeSha256=('7'*64)}
        $contextRaw=Json-Bytes $context
        $encoded=[Convert]::ToBase64String($contextRaw).TrimEnd('=').Replace('+','-').Replace('/','_')
        $capture=[pscustomobject]@{OperationId=$receipt.operation.operationId;Stage='intent';FailureStage=$null;Failure=$null;FailureType=$null;
            DiagnosticFailureType=$null;DisposeFailure=$null;CallerPin=$caller;ContextRaw=$contextRaw;
            Context=[Zeb.WorkerInstall.Native]::ReadStartupContext($contextRaw);SourceModuleSha256=$ModuleSha;ExpectedServiceSid=$pin.tokenUserSid;
            StartArguments=[string[]]@('zeb-startup-observe-v1',$encoded);HostPath=[IO.Path]::Combine($program,'storage-new-v1','WindowsServiceHost.exe');
            NodePath=[IO.Path]::Combine($program,'storage-new-v1','runtime','node.exe');PreparedSha256=$null;JobName=$null;HostExited=$null;NodeExited=$null;
            HostPin=$null;NodePin=$null;Pipe=$null;Disposed=$false;IntentPath=$null;IntentSha256=$null;RawFrames=[Collections.Generic.List[object]]::new()}
        $attemptRoot=[IO.Path]::Combine($data,'installation','startup-'+$attempt);$knownAttemptRoots.Add($attemptRoot)
        return [pscustomobject]@{Capture=$capture;Receipt=$receipt;ReceiptPath=$receiptPath;ReceiptRaw=$receiptRaw;ContextRaw=$contextRaw;
            ContextValue=$context;AttemptRoot=$attemptRoot;CallerHandle=$pin.handle;ReceiptBefore=(File-Facts $receiptPath)}
    }catch{$caller.Dispose();throw}
}
function Close-StorageFixture($Fixture){
    if($null -eq $Fixture){return}
    try{$Fixture.Capture.CallerPin.Dispose();$Fixture.Capture.CallerPin.Dispose();if(-not $Fixture.CallerHandle.IsClosed){$script:allLeasesClosed=$false}}
    catch{$script:allLeasesClosed=$false;throw}
}
function Check-Intent($Fixture){
    $path=[IO.Path]::Combine($Fixture.AttemptRoot,'intent.json')
    $raw=[Zeb.WorkerInstall.Native]::ReadBytes($path)
    & $module {param($path) Assert-WorkerCallerDirectory $path} $Fixture.AttemptRoot
    $value=ConvertFrom-Json -InputObject ([Text.UTF8Encoding]::new($false,$true).GetString($raw))
    $keys=@('v','kind','operationId','startupAttemptId','installationId','serviceId','clientId','active','previous','sourceModuleSha256',
        'startingReceiptSha256','contextSha256','configSha256','engineManifestSha256','materials','missingRecoveryEvidence')
    $good=[string]::Equals($Fixture.Capture.IntentPath,[IO.Path]::GetFullPath($path),[StringComparison]::OrdinalIgnoreCase) -and
        $Fixture.Capture.IntentSha256 -ceq (Hash-Bytes $raw) -and (Keys-Match $value $keys) -and $value.v -eq 1 -and $value.kind -ceq 'startup_intent' -and
        $value.operationId -ceq $Fixture.Receipt.operation.operationId -and $value.startupAttemptId -ceq $Fixture.Capture.Context['startupAttemptId'] -and
        $value.installationId -ceq $Fixture.Receipt.installationId -and $value.serviceId -ceq $Fixture.Receipt.serviceId -and $value.clientId -ceq $Fixture.Receipt.clientId -and
        $value.sourceModuleSha256 -ceq $ModuleSha -and $value.startingReceiptSha256 -ceq (Hash-Bytes $Fixture.ReceiptRaw) -and
        $value.contextSha256 -ceq (Hash-Bytes $Fixture.ContextRaw) -and $value.configSha256 -ceq $Fixture.Receipt.configSha256 -and $value.engineManifestSha256 -ceq $Fixture.Receipt.engineManifestSha256
    foreach($field in @('active','previous')){
        $expected=$Fixture.Receipt.$field;$actual=$value.$field
        if($null -eq $expected){$good=$good -and $null -eq $actual}
        else{$good=$good -and (Keys-Match $actual @('version','inventorySha256','imagePath')) -and $actual.version -ceq $expected.version -and $actual.inventorySha256 -ceq $expected.inventorySha256 -and $actual.imagePath -ceq $expected.imagePath}
    }
    $good=$good -and (Keys-Match $value.materials @('startingReceipt','context')) -and $value.missingRecoveryEvidence -is [array] -and
        $value.missingRecoveryEvidence.Count -eq 3 -and $value.missingRecoveryEvidence[0] -ceq 'oldStop' -and $value.missingRecoveryEvidence[1] -ceq 'verifiedBackup' -and $value.missingRecoveryEvidence[2] -ceq 'failureCloseout'
    foreach($entry in @(@{key='startingReceipt';file='starting-receipt.json';raw=$Fixture.ReceiptRaw},@{key='context';file='context.json';raw=$Fixture.ContextRaw})){
        $material=$value.materials.($entry.key);$materialPath=[IO.Path]::Combine($Fixture.AttemptRoot,$entry.file)
        $saved=[Zeb.WorkerInstall.Native]::ReadBytes($materialPath)
        $good=$good -and (Keys-Match $material @('bytes','sha256')) -and $material.bytes -eq $entry.raw.Length -and
            $material.sha256 -ceq (Hash-Bytes $entry.raw) -and $saved.Length -eq $entry.raw.Length -and
            [Convert]::ToBase64String($saved) -ceq [Convert]::ToBase64String($entry.raw) -and (Assert-PrivateFile $materialPath $Fixture.Capture.CallerPin.Pin.tokenUserSid)
    }
    $children=@([Zeb.WorkerInstall.Native]::Children($Fixture.AttemptRoot))
    $good=$good -and $children.Count -eq 3 -and @($children|Where-Object {$_ -cnotin @('starting-receipt.json','context.json','intent.json')}).Count -eq 0 -and
        (Assert-PrivateFile $path $Fixture.Capture.CallerPin.Pin.tokenUserSid) -and (Same-Facts $Fixture.ReceiptBefore (File-Facts $Fixture.ReceiptPath))
    [Zeb.WorkerInstall.Native]::RequireStartupPin($Fixture.Capture.CallerPin.Pin)
    return [bool]$good
}
foreach($nullPrevious in @($false,$true)){
    $name=if($nullPrevious){'stored_exact_bytes_and_acl_null_previous'}else{'stored_exact_bytes_and_acl_previous'}
    $fixture=$null;$good=$false;$failureType=$null;$cleanupFailureType=$null;$phase='preparation';$targetCallReached=$false
    try{$fixture=New-StorageFixture $name $nullPrevious;$storageExecuted=$true;$phase='writer';$targetCallReached=$true;Invoke-Intent 'Write-WorkerStartupIntent' $fixture;
        $phase='assert-readback';Invoke-Intent 'Assert-WorkerStartupIntent' $fixture;$phase='independent-validation';$good=Check-Intent $fixture}
    catch{$failureType=(Root-Failure $_.Exception).GetType().FullName}
    finally{try{Close-StorageFixture $fixture}catch{$good=$false;$cleanupFailureType=(Root-Failure $_.Exception).GetType().FullName}}
    $rows.Add(@{name=$name;passed=$good;failureType=$failureType;cleanupFailureType=$cleanupFailureType;failurePhase=$phase;prepared=($null -ne $fixture);targetCallReached=$targetCallReached;
        scope='real private storage I/O with actual current caller lease; no successful service producer claim'})
}
foreach($name in @('writer_create_new_collision','writer_receipt_bytes_sha_mismatch','writer_context_operation_mismatch','writer_actual_caller_record_mismatch',
    'assert_material_attempt_tamper','partial_attempt_collision_preserved','assert_unknown_intent_key','assert_material_path_forbidden','assert_missing_evidence_shape',
    'assert_capture_path_mismatch','assert_capture_sha_mismatch')){
    $fixture=$null;$good=$false;$failureType=$null;$cleanupFailureType=$null;$savedPid=$null;$phase='preparation';$targetCallReached=$false
    try{
        $fixture=New-StorageFixture $name $false;$storageExecuted=$true;$phase='refusal-precondition'
        $method='Write-WorkerStartupIntent'
        if($name -ceq 'writer_create_new_collision'){
            Invoke-Intent $method $fixture;$before=Material-State $fixture
        }elseif($name -ceq 'writer_receipt_bytes_sha_mismatch'){
            # Deliberate mutation is confined to this independently owned storage fixture.
            [IO.File]::WriteAllBytes($fixture.ReceiptPath,($fixture.ReceiptRaw+[byte]10));$beforeReceipt=File-Facts $fixture.ReceiptPath
        }elseif($name -ceq 'writer_context_operation_mismatch'){
            $fixture.ContextValue.operationId=[Guid]::NewGuid().ToString('D');$fixture.Capture.ContextRaw=Json-Bytes $fixture.ContextValue
            $fixture.Capture.Context=[Zeb.WorkerInstall.Native]::ReadStartupContext($fixture.Capture.ContextRaw)
        }elseif($name -ceq 'writer_actual_caller_record_mismatch'){
            $savedPid=$fixture.Capture.CallerPin.Pin.pid;$fixture.Capture.CallerPin.Pin.pid=if($savedPid -eq [int]::MaxValue){$savedPid-1}else{$savedPid+1}
            $fixture.ContextValue.caller.pid=$fixture.Capture.CallerPin.Pin.pid;$fixture.Capture.ContextRaw=Json-Bytes $fixture.ContextValue
            $fixture.Capture.Context=[Zeb.WorkerInstall.Native]::ReadStartupContext($fixture.Capture.ContextRaw)
        }elseif($name -ceq 'partial_attempt_collision_preserved'){
            New-PrivateDirectory $fixture.AttemptRoot
            Put-PrivateFile ([IO.Path]::Combine($fixture.AttemptRoot,'starting-receipt.json')) $fixture.ReceiptRaw
            Put-PrivateFile ([IO.Path]::Combine($fixture.AttemptRoot,'context.json')) $fixture.ContextRaw
            Put-PrivateFile ([IO.Path]::Combine($fixture.AttemptRoot,'intent.json')) ([Text.Encoding]::ASCII.GetBytes('owned-partial-intent-sentinel'))
            $before=Material-State $fixture
        }else{
            Invoke-Intent $method $fixture;$method='Assert-WorkerStartupIntent'
            if($name -ceq 'assert_capture_path_mismatch'){
                $fixture.Capture.IntentPath=[IO.Path]::Combine($fixture.AttemptRoot,'different-intent.json')
            }elseif($name -ceq 'assert_capture_sha_mismatch'){
                $fixture.Capture.IntentSha256='0'*64
            }elseif($name -ceq 'assert_material_attempt_tamper'){
                $fixture.ContextValue.startupAttemptId=[Guid]::NewGuid().ToString('D')
                $fixture.ContextValue.pipeName='zeb-worker-startup-v1-'+$fixture.ContextValue.startupAttemptId.Replace('-','')
                $changedContext=Json-Bytes $fixture.ContextValue
                [IO.File]::WriteAllBytes(([IO.Path]::Combine($fixture.AttemptRoot,'context.json')),$changedContext)
                $intentPath=[IO.Path]::Combine($fixture.AttemptRoot,'intent.json')
                $value=[Text.UTF8Encoding]::new($false,$true).GetString([Zeb.WorkerInstall.Native]::ReadBytes($intentPath))|ConvertFrom-Json
                $value.contextSha256=Hash-Bytes $changedContext;$value.materials.context.sha256=$value.contextSha256;$value.materials.context.bytes=$changedContext.Length
                $changedIntent=Json-Bytes $value;[IO.File]::WriteAllBytes($intentPath,$changedIntent);$fixture.Capture.IntentSha256=Hash-Bytes $changedIntent
            }else{
                $intentPath=[IO.Path]::Combine($fixture.AttemptRoot,'intent.json')
                $value=[Text.UTF8Encoding]::new($false,$true).GetString([Zeb.WorkerInstall.Native]::ReadBytes($intentPath))|ConvertFrom-Json
                if($name -ceq 'assert_unknown_intent_key'){$value|Add-Member -MemberType NoteProperty -Name extra -Value $true}
                elseif($name -ceq 'assert_material_path_forbidden'){$value.materials.context|Add-Member -MemberType NoteProperty -Name path -Value 'outside-fixture.json'}
                else{$value.missingRecoveryEvidence=@('verifiedBackup','failureCloseout')}
                $changedIntent=Json-Bytes $value;[IO.File]::WriteAllBytes($intentPath,$changedIntent);$fixture.Capture.IntentSha256=Hash-Bytes $changedIntent
            }
            $before=Material-State $fixture
        }
        $phase='refusal';$targetCallReached=$true;$good=Refused-Intent $method $fixture
        if($null -ne $savedPid){$fixture.Capture.CallerPin.Pin.pid=$savedPid;$savedPid=$null}
        [Zeb.WorkerInstall.Native]::RequireStartupPin($fixture.Capture.CallerPin.Pin)
        if($name -cin @('writer_create_new_collision','partial_attempt_collision_preserved','assert_material_attempt_tamper','assert_unknown_intent_key','assert_material_path_forbidden','assert_missing_evidence_shape','assert_capture_path_mismatch','assert_capture_sha_mismatch')){
            $good=$good -and (Same-State $before (Material-State $fixture))
        }else{
            $good=$good -and -not [IO.File]::Exists([IO.Path]::Combine($fixture.AttemptRoot,'intent.json')) -and
                $null -eq $fixture.Capture.IntentPath -and $null -eq $fixture.Capture.IntentSha256
        }
        if($name -ceq 'writer_receipt_bytes_sha_mismatch'){$good=$good -and (Same-Facts $beforeReceipt (File-Facts $fixture.ReceiptPath))}
        else{$good=$good -and (Same-Facts $fixture.ReceiptBefore (File-Facts $fixture.ReceiptPath))}
    }catch{$good=$false;$failureType=(Root-Failure $_.Exception).GetType().FullName}
    finally{
        if($null -ne $fixture -and $null -ne $savedPid){$fixture.Capture.CallerPin.Pin.pid=$savedPid}
        try{Close-StorageFixture $fixture}catch{$good=$false;$cleanupFailureType=(Root-Failure $_.Exception).GetType().FullName}
    }
    $rows.Add(@{name=$name;passed=$good;failureType=$failureType;cleanupFailureType=$cleanupFailureType;failurePhase=$phase;prepared=($null -ne $fixture);targetCallReached=$targetCallReached;
        scope='independent owned storage fixture refusal; original material preserved; no reconstructed FailureProof'})
}
$noProof=$true
foreach($attemptRoot in $knownAttemptRoots){
    if([IO.Directory]::Exists($attemptRoot)){
        $names=@([Zeb.WorkerInstall.Native]::Children($attemptRoot))
        if(@($names|Where-Object {$_ -cnotin @('starting-receipt.json','context.json','intent.json')}).Count -ne 0){$noProof=$false}
        $installation=[IO.Path]::GetDirectoryName($attemptRoot)
        if(@([Zeb.WorkerInstall.Native]::Children($installation)|Where-Object {$_ -like '*proof*' -or $_ -like '*recovery*'}).Count -gt 0){$noProof=$false}
    }
}
$rows.Add(@{name='storage_never_creates_failure_proof';passed=($noProof -and $forbidden.Count -eq 0 -and $allLeasesClosed);
    forbiddenExternalCalls=$forbidden.Count;allOriginalCallerLeasesClosed=$allLeasesClosed;scope='only storage side effects observed; no claim of complete missing-evidence recovery rejection'})
function Function-Ast([string]$Name){
    $definitions=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $Name},$true))
    if($definitions.Count -ne 1){throw 'source_function_not_unique'};return $definitions[0]
}
function Commands($Definition,[string]$Name){return @($Definition.Body.FindAll({param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -ceq $Name},$true))}
function Statement-Block($Node){$current=$Node.Parent;while($null -ne $current -and $current -isnot [Management.Automation.Language.StatementBlockAst]){$current=$current.Parent};return $current}
function Call-Bindings($Command,[string[]]$Names,[string[]]$Values){
    $arguments=@($Command.CommandElements|Select-Object -Skip 1)
    if($arguments.Count -eq $Names.Count){
        for($index=0;$index -lt $Names.Count;$index++){if($arguments[$index].Extent.Text -ine $Values[$index]){return $false}}
        return $true
    }
    if($arguments.Count -ne $Names.Count*2){return $false}
    $bound=[Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    for($index=0;$index -lt $arguments.Count;$index+=2){
        if($arguments[$index] -isnot [Management.Automation.Language.CommandParameterAst]){return $false}
        $key=$arguments[$index].ParameterName
        if($bound.ContainsKey($key)){return $false};$bound.Add($key,$arguments[$index+1].Extent.Text)
    }
    for($index=0;$index -lt $Names.Count;$index++){if(-not $bound.ContainsKey($Names[$index]) -or $bound[$Names[$index]] -ine $Values[$index]){return $false}}
    return $true
}
try{
    $definition=Function-Ast 'New-WorkerStartupObservation';$writers=@(Commands $definition 'Write-WorkerStartupIntent');$windows=@(Commands $definition 'Assert-WorkerStartupWindow')
    $prepared=@($definition.Body.FindAll({param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and
        $node.Left.Extent.Text -ieq '$capture.Stage' -and $node.Right.Extent.Text -ceq "'prepared-to-start'"},$true))
    $good=$writers.Count -eq 1 -and $prepared.Count -eq 1
    if($good){$good=(Call-Bindings $writers[0] @('Capture','Receipt','ReceiptPath') @('$capture','$Receipt','$ReceiptPath')) -and
        @($windows|Where-Object {$_.Extent.StartOffset -gt $writers[0].Extent.EndOffset -and $_.Extent.EndOffset -lt $prepared[0].Extent.StartOffset -and
            (Call-Bindings $_ @('Capture','Deadline') @('$capture','$Deadline'))}).Count -ge 1}
    $sourceRows.Add(@{name='new_persists_then_checks_original_window';passed=$good;scope='AST source-order only, not execution of successful producer'})
}catch{$sourceRows.Add(@{name='new_persists_then_checks_original_window';passed=$false;failureType=(Root-Failure $_.Exception).GetType().FullName;scope='AST source-order only'})}
try{
    $definition=Function-Ast 'Start-WorkerOwnedService';$assertions=@(Commands $definition 'Assert-WorkerStartupIntent')
    $starts=@(Commands $definition 'Invoke-WorkerScmChange'|Where-Object {@($_.CommandElements|Where-Object {$_ -is [Management.Automation.Language.CommandParameterAst] -and $_.ParameterName -ceq 'StartupArguments'}).Count -eq 1})
    $good=$assertions.Count -eq 1 -and $starts.Count -eq 1
    if($good){$good=(Call-Bindings $assertions[0] @('Capture','Receipt','ReceiptPath') @('$capture','$Receipt','$ReceiptPath')) -and
        $assertions[0].Extent.EndOffset -lt $starts[0].Extent.StartOffset -and [object]::ReferenceEquals((Statement-Block $assertions[0]),(Statement-Block $starts[0]))}
    $sourceRows.Add(@{name='start_reasserts_same_intent_before_observed_start';passed=$good;scope='AST observed branch callsite order only; actual SCM0'})
}catch{$sourceRows.Add(@{name='start_reasserts_same_intent_before_observed_start';passed=$false;failureType=(Root-Failure $_.Exception).GetType().FullName;scope='AST source-order only'})}
$storageFailed=@($rows|Where-Object {-not $_.passed});$sourceFailed=@($sourceRows|Where-Object {-not $_.passed})
$passed=$rows.Count -eq $behaviorNames.Count -and $sourceRows.Count -eq $sourceNames.Count -and $storageFailed.Count -eq 0 -and $sourceFailed.Count -eq 0
Save-Report @{code='startup_intent_controls_v1';moduleSha256=$ModuleSha;interfaces=$interfaces;passed=$passed;
    storagePassCount=$rows.Count-$storageFailed.Count;storageFailCount=$storageFailed.Count;rows=$rows.ToArray();sourcePassCount=$sourceRows.Count-$sourceFailed.Count;
    sourceFailCount=$sourceFailed.Count;sourceRows=$sourceRows.ToArray();callerFactoryExecuted=$callerFactoryExecuted;actualStorageExecuted=$storageExecuted;
    actualProducerSuccess=$false;actualScmStarted=$false;actualVirtualServiceCrossSid=$false;productionSessionZeroPolicyExercised=$false;
    failureProofCreated=(-not $noProof);actualGpu=$false;scope='actual private durable-intent storage only; source-order checks separate; no full startup/FailureProof/Recover/SCM claim'}
if(-not $passed){exit 1};exit 0
