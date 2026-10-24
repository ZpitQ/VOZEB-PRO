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
$writer=& $module {$ExecutionContext.SessionState.InvokeCommand.GetCommand('Write-WorkerStartupFailureProof',[Management.Automation.CommandTypes]::Function)}
$valid=$null -ne $writer -and $null -ne $writer.Module -and
    [string]::Equals($writer.Module.Path,$ModulePath,[StringComparison]::OrdinalIgnoreCase) -and
    -not $module.ExportedFunctions.ContainsKey('Write-WorkerStartupFailureProof')
$declared=@()
if($valid){
    $ast=$writer.ScriptBlock.Ast
    if($ast -is [Management.Automation.Language.FunctionDefinitionAst]){$ast=$ast.Body}
    $parameters=@($ast.ParamBlock.Parameters);$declared=@($parameters|ForEach-Object {$_.Name.VariablePath.UserPath})
    $valid=$parameters.Count -eq 2 -and ($declared -join ',') -ceq 'Evidence,Deadline' -and $parameters[1].StaticType -eq [DateTime]
}
$names=@('publishes_fixed_nine_materials_and_final_only','capture_not_released_refused','privileges_not_restored_refused',
    'installation_locks_not_released_refused','failed_receipt_raw_tamper_refused','existing_material_raw_tamper_refused',
    'new_material_vs_frozen_index_tamper_refused','source_module_sha_mismatch_refused','original_utc_deadline_expired_refused',
    'original_tick_cutoff_expired_refused','pending_collision_preserves_originals','final_collision_preserves_originals')
function Save-Report($Report){
    if((Get-FileHash -LiteralPath $ModulePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ModuleSha){throw 'module_changed_during_controls'}
    $raw=[Text.UTF8Encoding]::new($false,$true).GetBytes(($Report|ConvertTo-Json -Depth 14 -Compress)+[char]10)
    $stream=[IO.FileStream]::new($OutputPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try{$stream.Write($raw,0,$raw.Length)}finally{$stream.Dispose()}
    [Console]::Write([Text.Encoding]::UTF8.GetString($raw))
}
if(-not $valid){
    Save-Report @{code='startup_failure_proof_writer_interface_red';moduleSha256=$ModuleSha;interfacePresent=$null -ne $writer;
        declaredParameters=$declared;interfacePassCount=0;interfaceFailCount=1;behaviorPassCount=0;behaviorFailCount=0;
        pendingBehaviorCount=$names.Count;pendingBehaviorNames=$names;actualNativeCompiled=$false;actualStorage=$false;
        actualWriterInvoked=$false;writerInvocationCount=0;actualReceiptValidation=$false;actualSourceProvenance=$false;
        actualSemanticConstructor=$false;actualOriginalCloseout=$false;actualDatabaseVerification=$false;actualNewWorkerBackup=$false;
        actualScm=$false;actualFailureProof=$false;actualRecover=$false;actualGpu=$false;
        scope='actual imported private interface only; all pure storage behaviors pending; no fixture created'}
    exit 1
}
if(Test-Path -LiteralPath $FixtureRoot){throw 'fixture_already_exists'}
& $module {Initialize-WorkerInstallNative}
function Call-Private([string]$Name,[object[]]$Values){return & $module {param($Name,$Values) & $Name @Values} $Name $Values}
function New-PrivateDirectory([string]$Path){$null=Call-Private 'New-WorkerCallerDirectory' @($Path)}
function Put-PrivateFile([string]$Path,[byte[]]$Bytes){$null=Call-Private 'New-WorkerCallerFile' @($Path,$Bytes)}
function Json-Text($Value){return $Value|ConvertTo-Json -Depth 32 -Compress}
function Json-Bytes($Value){return ,([Text.UTF8Encoding]::new($false,$true).GetBytes((Json-Text $Value)+[char]10))}
function Hash-Bytes([byte[]]$Bytes){
    $sha=[Security.Cryptography.SHA256]::Create()
    try{return [BitConverter]::ToString($sha.ComputeHash($Bytes)).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
}
function Root-Reason($Failure){while($null -ne $Failure.InnerException){$Failure=$Failure.InnerException};return $Failure}
function File-Facts([string]$Path){
    $info=[Zeb.WorkerInstall.Native]::Inspect($Path)
    return [pscustomobject]@{identity=$info.Identity;bytes=$info.Bytes;sha256=[Zeb.WorkerInstall.Native]::Hash($Path);
        creation=$info.CreationUtc;lastWrite=$info.LastWriteUtc;attributes=$info.Attributes;sddl=$info.SecuritySddl}
}
function Tree-State([string]$Root){
    $value=[ordered]@{}
    foreach($item in (Call-Private 'Get-WorkerTree' @($Root)|Sort-Object path)){
        $relative=$item.path.Substring($Root.Length).Replace('\','/');if($relative.Length -eq 0){$relative='.'}
        $value[$relative]=if($item.info.Directory){[pscustomobject]@{identity=$item.info.Identity;sddl=$item.info.SecuritySddl}}else{File-Facts $item.path}
    }
    return Json-Text ([pscustomobject]$value)
}
function Protected-State($Fixture){
    $old=[ordered]@{};foreach($name in $script:ExistingNames){$old[$name]=File-Facts (Join-Path $Fixture.StartupRoot $name)}
    $business=[ordered]@{};foreach($name in @('store','records','engine','config','tls')){$business[$name]=Tree-State (Join-Path $Fixture.Evidence.DataRoot $name)}
    $root=[Zeb.WorkerInstall.Native]::Inspect($Fixture.StartupRoot)
    return Json-Text ([pscustomobject]@{receipt=(File-Facts $Fixture.Evidence.ReceiptPath);old=[pscustomobject]$old;
        program=(Tree-State $Fixture.ProgramRoot);business=[pscustomobject]$business;rootIdentity=$root.Identity;rootSddl=$root.SecuritySddl})
}
function Evidence-Inputs($Evidence){
    $value=[ordered]@{}
    foreach($property in $Evidence.PSObject.Properties){if($property.Name -cnotin @('PublishedPath','PublishedSha256')){$value[$property.Name]=$property.Value}}
    return Json-Text ([pscustomobject]$value)
}
$script:ExistingNames=@('starting-receipt.json','context.json','intent.json')
$script:NewNames=@('failed-receipt.json','prepared.frame','ack-prepared.frame','authorized.frame','settled.frame','failed-snapshot.json')
function New-StorageFixture([string]$SceneName){
    $scene=Join-Path $FixtureRoot $SceneName;New-PrivateDirectory $scene
    $program=Join-Path $scene 'program';$data=Join-Path $scene 'data';$installation=Join-Path $data 'installation'
    foreach($path in @($program,$data,$installation)){New-PrivateDirectory $path}
    foreach($name in @('store','records','engine','config','tls')){
        $directory=Join-Path $data $name;New-PrivateDirectory $directory
        Put-PrivateFile (Join-Path $directory 'inert-protected.txt') ([Text.Encoding]::ASCII.GetBytes('INERT_NOT_DATABASE_OR_ENGINE:'+ $name+[char]10))
    }
    Put-PrivateFile (Join-Path $program 'inert-protected.txt') ([Text.Encoding]::ASCII.GetBytes('INERT_NOT_INSTALLED_PAYLOAD'+[char]10))
    $operation=[Guid]::NewGuid().ToString('D');$attempt=[Guid]::NewGuid().ToString('D');$boot=[Guid]::NewGuid().ToString('D')
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $receipt=[pscustomobject]@{schemaVersion=1;installationId=[Guid]::NewGuid().ToString('D');state='unknown';serviceName='ZebImageEnhancement';
        accountName='NT SERVICE\ZebImageEnhancement';tokenUserSid=$sid;sessionId=0;programRoot=$program;dataRoot=$data;storeSchemaVersion=7;
        serviceId=[Guid]::NewGuid().ToString('D');clientId=[Guid]::NewGuid().ToString('D');engineImportSha256=('a'*64);
        engineManifestSha256=('b'*64);configSha256=('c'*64);tlsSha256=$null;
        active=[pscustomobject]@{version='inert-new-v1';inventorySha256=('d'*64);imagePath=('"'+(Join-Path $program 'inert-new-v1\WindowsServiceHost.exe')+'"')};
        previous=[pscustomobject]@{version='inert-old-v1';inventorySha256=('e'*64);imagePath=('"'+(Join-Path $program 'inert-old-v1\WindowsServiceHost.exe')+'"')};
        lastStopped=[pscustomobject]@{bootId=$boot;host=[pscustomobject]@{pid=101;creationFileTime='10001'};
            node=[pscustomobject]@{pid=102;creationFileTime='10002'};pinsExclusive=$true};
        operation=[pscustomobject]@{operationId=$operation;action='Upgrade';stage='started';outcome='unknown';maintenanceBootId=$boot;targetSha256=('d'*64)}}
    $receiptPath=Join-Path $installation 'receipt.json'
    $failedRaw=[Text.UTF8Encoding]::new($false,$true).GetBytes(' '+(Json-Text $receipt)+[char]10+[char]10)
    Put-PrivateFile $receiptPath $failedRaw
    $null=Call-Private 'Read-WorkerReceipt' @($receiptPath)
    $startup=Join-Path $installation ('startup-'+$attempt);New-PrivateDirectory $startup
    $starting=Json-Text $receipt|ConvertFrom-Json;$starting.state='installed';$starting.operation.outcome='pending'
    # These materials are deliberately inert. This suite exercises storage, not the semantic constructor or original startup.
    $existing=@([pscustomobject]@{name='starting-receipt.json';raw=(Json-Bytes $starting)},
        [pscustomobject]@{name='context.json';raw=(Json-Bytes ([pscustomobject]@{synthetic=$true;kind='inert_storage_context';startupAttemptId=$attempt}))},
        [pscustomobject]@{name='intent.json';raw=(Json-Bytes ([pscustomobject]@{synthetic=$true;kind='inert_storage_intent';operationId=$operation}))})
    foreach($material in $existing){Put-PrivateFile (Join-Path $startup $material.name) $material.raw}
    $new=[Collections.Generic.List[object]]::new();$new.Add([pscustomobject]@{name='failed-receipt.json';raw=$failedRaw.Clone()})
    foreach($name in @('prepared.frame','ack-prepared.frame','authorized.frame','settled.frame')){
        $new.Add([pscustomobject]@{name=$name;raw=[Text.Encoding]::ASCII.GetBytes('INERT_NOT_A_STARTUP_WIRE:'+ $name+[char]10)})
    }
    $new.Add([pscustomobject]@{name='failed-snapshot.json';raw=(Json-Bytes ([pscustomobject]@{synthetic=$true;kind='inert_raw_failure_snapshot'}))})
    $index=[ordered]@{}
    foreach($material in @($existing)+@($new.ToArray())){$index[$material.name]=[pscustomobject]@{bytes=$material.raw.Length;sha256=(Hash-Bytes $material.raw)}}
    $deadline=[DateTime]::UtcNow.AddSeconds(30);$cutoff=[Zeb.WorkerInstall.Native]::TickCount64()+[long]30000
    if($SceneName -ceq 'original_utc_deadline_expired_refused'){$deadline=[DateTime]::UtcNow.AddMilliseconds(-1)}
    if($SceneName -ceq 'original_tick_cutoff_expired_refused'){$cutoff=[Zeb.WorkerInstall.Native]::TickCount64()-[long]1}
    $source=if($SceneName -ceq 'source_module_sha_mismatch_refused'){'f'*64}else{$ModuleSha}
    $proof=[ordered]@{v=1;kind='startup_failure_proof';operationId=$operation;startupAttemptId=$attempt;
        failedReceiptSha256=(Hash-Bytes $failedRaw);sourceModuleSha256=$source;
        deadlineUtcTicks=$deadline.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture);cutoffTick64=$cutoff;
        materials=[pscustomobject]$index;closeout=[pscustomobject]@{captureReleased=$true;privilegesRestored=$true;installationLocksReleased=$true}}
    $evidence=[pscustomobject]@{OperationId=$operation;StartupAttemptId=$attempt;DataRoot=$data;ReceiptPath=$receiptPath;
        FailedReceiptRaw=$failedRaw;SourceModuleSha256=$source;ContextCutoffTick64=$cutoff;DeadlineUtcTicks=$deadline.Ticks;
        ExistingMaterials=$existing;NewMaterials=$new.ToArray();ProofRaw=(Json-Bytes ([pscustomobject]$proof));
        Closeout=[pscustomobject]@{captureReleased=$false;privilegesRestored=$false;installationLocksReleased=$false};
        PublishedPath=$null;PublishedSha256=$null}
    $script:PreflightCount++
    return [pscustomobject]@{Evidence=$evidence;Deadline=$deadline;StartupRoot=$startup;ProgramRoot=$program}
}
function Invoke-Writer($Fixture){
    $script:WriterCalls++
    $output=@(& $module {param($Evidence,[DateTime]$Deadline) Write-WorkerStartupFailureProof $Evidence $Deadline} $Fixture.Evidence $Fixture.Deadline)
    return $output.Count
}
function Valid-Publication($Fixture){
    $root=$Fixture.StartupRoot;$final=Join-Path $root 'failure-proof.json';$expected=@($script:ExistingNames)+@($script:NewNames)+@('failure-proof.json')
    $names=@([Zeb.WorkerInstall.Native]::Children($root)|Sort-Object)
    if(($names -join ',') -cne (($expected|Sort-Object)-join ',') -or [IO.File]::Exists((Join-Path $root 'failure-proof.pending.json'))){return $false}
    if($Fixture.Evidence.PublishedPath -cne $final -or $Fixture.Evidence.PublishedSha256 -cne (Hash-Bytes $Fixture.Evidence.ProofRaw)){return $false}
    if((Hash-Bytes ([IO.File]::ReadAllBytes($final))) -cne (Hash-Bytes $Fixture.Evidence.ProofRaw)){return $false}
    $null=Call-Private 'Assert-WorkerCallerDirectory' @($root)
    foreach($name in $names){$null=Call-Private 'Assert-WorkerCallerFile' @((Join-Path $root $name))}
    $parsed=Call-Private 'Read-WorkerJson' @($final)
    if(@($parsed.materials.PSObject.Properties).Count -ne 9){return $false}
    foreach($material in @($Fixture.Evidence.ExistingMaterials)+@($Fixture.Evidence.NewMaterials)){
        $raw=[IO.File]::ReadAllBytes((Join-Path $root $material.name));$declaration=$parsed.materials.PSObject.Properties[$material.name].Value
        if(@($declaration.PSObject.Properties).Count -ne 2 -or $null -eq $declaration.PSObject.Properties['bytes'] -or
            $null -eq $declaration.PSObject.Properties['sha256'] -or $raw.Length -ne $material.raw.Length -or
            [Convert]::ToBase64String($raw) -cne [Convert]::ToBase64String($material.raw) -or
            $declaration.bytes -ne $raw.Length -or $declaration.sha256 -cne (Hash-Bytes $raw)){return $false}
    }
    return $true
}
$forbidden=[Collections.Generic.List[string]]::new()
& $module {
    param($Calls)
    $script:FailureProofStorageForbidden=$Calls
    function script:Invoke-WorkerScmChange {$script:FailureProofStorageForbidden.Add('SCM');throw 'fixture_forbidden_scm'}
    function script:Get-WorkerServiceRow {$script:FailureProofStorageForbidden.Add('ServiceQuery');throw 'fixture_forbidden_service_query'}
    function script:Invoke-WorkerMaintenanceHttp {$script:FailureProofStorageForbidden.Add('HTTP');throw 'fixture_forbidden_http'}
    function script:Invoke-WorkerNodeProcess {$script:FailureProofStorageForbidden.Add('Node');throw 'fixture_forbidden_node'}
    function script:New-WorkerBackup {$script:FailureProofStorageForbidden.Add('NewBackup');throw 'fixture_forbidden_new_backup'}
    function script:Copy-WorkerSnapshot {$script:FailureProofStorageForbidden.Add('CopySnapshot');throw 'fixture_forbidden_copy'}
    function script:New-WorkerStartupFailureProof {$script:FailureProofStorageForbidden.Add('Constructor');throw 'fixture_forbidden_constructor'}
    function script:Invoke-WorkerRecovery {$script:FailureProofStorageForbidden.Add('Recover');throw 'fixture_forbidden_recover'}
} $forbidden
$rows=[Collections.Generic.List[object]]::new();$script:PreflightCount=0;$script:WriterCalls=0;$phase='setup';$unexpected=$null
try{
    New-PrivateDirectory $FixtureRoot
    foreach($name in $names){
        $phase=$name+'.prepare';$fixture=New-StorageFixture $name
        # Synthetic permission to test the writer only: no original cleanup is executed or attested here.
        $fixture.Evidence.Closeout.captureReleased=$true;$fixture.Evidence.Closeout.privilegesRestored=$true;$fixture.Evidence.Closeout.installationLocksReleased=$true
        switch($name){
            'capture_not_released_refused'{$fixture.Evidence.Closeout.captureReleased=$false}
            'privileges_not_restored_refused'{$fixture.Evidence.Closeout.privilegesRestored=$false}
            'installation_locks_not_released_refused'{$fixture.Evidence.Closeout.installationLocksReleased=$false}
            'failed_receipt_raw_tamper_refused'{[IO.File]::AppendAllText($fixture.Evidence.ReceiptPath,' ',[Text.Encoding]::ASCII)}
            'existing_material_raw_tamper_refused'{[IO.File]::AppendAllText((Join-Path $fixture.StartupRoot 'context.json'),' ',[Text.Encoding]::ASCII)}
            'new_material_vs_frozen_index_tamper_refused'{
                $material=@($fixture.Evidence.NewMaterials|Where-Object {$_.name -ceq 'prepared.frame'})[0]
                $material.raw=[byte[]]($material.raw+@([byte]33))
            }
            'pending_collision_preserves_originals'{Put-PrivateFile (Join-Path $fixture.StartupRoot 'failure-proof.pending.json') ([Text.Encoding]::ASCII.GetBytes('INERT_EXISTING_PENDING'))}
            'final_collision_preserves_originals'{Put-PrivateFile (Join-Path $fixture.StartupRoot 'failure-proof.json') ([Text.Encoding]::ASCII.GetBytes('INERT_EXISTING_FINAL'))}
        }
        $before=Protected-State $fixture;$evidenceBefore=Evidence-Inputs $fixture.Evidence;$treeBefore=Tree-State $fixture.StartupRoot
        $phase=$name+'.writer';$failure=$null;$outputCount=$null
        try{$outputCount=Invoke-Writer $fixture}catch{$failure=Root-Reason $_.Exception}
        $phase=$name+'.assert';$preserved=$before -ceq (Protected-State $fixture) -and $evidenceBefore -ceq (Evidence-Inputs $fixture.Evidence)
        if($name -ceq 'publishes_fixed_nine_materials_and_final_only'){
            $good=$null -eq $failure -and $outputCount -eq 0 -and $preserved -and (Valid-Publication $fixture)
        }else{
            $refused=$null -ne $failure -and ($failure.Message -cmatch '\Aworker_[a-z_]+\z' -or $failure -is [IO.IOException] -or
                $failure -is [IO.InvalidDataException] -or $failure -is [InvalidOperationException] -or $failure -is [UnauthorizedAccessException] -or $failure -is [ComponentModel.Win32Exception])
            $good=$refused -and $preserved -and $null -eq $fixture.Evidence.PublishedPath -and $null -eq $fixture.Evidence.PublishedSha256
            if($name -cin @('pending_collision_preserves_originals','final_collision_preserves_originals','capture_not_released_refused',
                'privileges_not_restored_refused','installation_locks_not_released_refused')){$good=$good -and $treeBefore -ceq (Tree-State $fixture.StartupRoot)}
            else{$good=$good -and -not [IO.File]::Exists((Join-Path $fixture.StartupRoot 'failure-proof.json'))}
        }
        $rows.Add(@{name=$name;passed=[bool]$good;originalInputsPreserved=$preserved;
            failureType=$(if($null -ne $failure){$failure.GetType().FullName}else{$null});
            fixedCode=$(if($null -ne $failure -and $failure.Message -cmatch '\Aworker_[a-z_]+\z'){$failure.Message}else{$null});
            actualSourceProvenance=$false;actualOriginalCloseout=$false;actualScm=$false;actualFailureProof=$false})
    }
}catch{
    $failure=Root-Reason $_.Exception;$unexpected=@{phase=$phase;failureType=$failure.GetType().FullName;
        nativeErrorCode=$(if($failure -is [ComponentModel.Win32Exception]){$failure.NativeErrorCode}else{$null})}
}
$failed=@($rows|Where-Object {-not $_.passed});$seen=@($rows|ForEach-Object {$_.name});$pending=@($names|Where-Object {$_ -cnotin $seen})
$success=$failed.Count -eq 0 -and $pending.Count -eq 0 -and $null -eq $unexpected -and $forbidden.Count -eq 0
Save-Report @{code='startup_failure_proof_storage_controls_v1';passed=$success;moduleSha256=$ModuleSha;interfacePassCount=1;interfaceFailCount=0;
    behaviorPassCount=$rows.Count-$failed.Count;behaviorFailCount=$failed.Count;pendingBehaviorCount=$pending.Count;pendingBehaviorNames=$pending;
    rows=$rows.ToArray();unexpectedFailure=$unexpected;preflightCount=$script:PreflightCount;forbiddenCalls=$forbidden.ToArray();
    actualWriterInvoked=$script:WriterCalls -gt 0;writerInvocationCount=$script:WriterCalls;actualNativeCompiled=$true;actualStorage=$script:PreflightCount -gt 0;
    actualReceiptValidation=$script:PreflightCount -gt 0;actualSourceProvenance=$false;actualSemanticConstructor=$false;actualOriginalCloseout=$false;
    actualDatabaseVerification=$false;actualNewWorkerBackup=$false;actualScm=$false;actualFailureProof=$false;actualRecover=$false;actualGpu=$false;
    nonAuthorSourceReviewRequired='writer validates 14-key inert evidence/receipt/current module and original UTC+Tick gates; checks fixed 3+6 material bytes/index/ACL; CreateNew pending readback then original MoveObject without overwrite as final publish; no post-publish fallible qualification gate; owning caller supplies real cleanup and source; Recover re-locks and revalidates';
    scope='pure private storage with real receipt/path/ACL/native file helpers and original MoveObject; context/intent/frames/snapshot/proof semantic source and closeout flags deliberately synthetic; no DB/NewBackup/original startup/SCM/qualified FailureProof/Recover/GPU'}
if(-not $success){exit 1}
exit 0
