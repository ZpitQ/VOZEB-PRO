param(
    [Parameter(Mandatory=$true)][string]$ModulePath,
    [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ModuleSha,
    [Parameter(Mandatory=$true)][string]$ProbePath,
    [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ProbeSha,
    [Parameter(Mandatory=$true)][string]$FixtureRoot,
    [Parameter(Mandatory=$true)][string]$OutputPath
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
if($PSVersionTable.PSVersion.Major -ne 5){throw 'fresh_winps5_required'}
if($null -ne ('Zeb.WorkerInstall.Native' -as [type]) -or $null -ne ('Zeb.StartupExitCodeProbe.Probe' -as [type])){throw 'fresh_native_and_probe_required'}
$ModulePath=[IO.Path]::GetFullPath($ModulePath);$ProbePath=[IO.Path]::GetFullPath($ProbePath)
$FixtureRoot=[IO.Path]::GetFullPath($FixtureRoot);$OutputPath=[IO.Path]::GetFullPath($OutputPath)
if((Get-FileHash -LiteralPath $ModulePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ModuleSha.ToLowerInvariant()){throw 'module_preimage_changed'}
if((Get-FileHash -LiteralPath $ProbePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ProbeSha.ToLowerInvariant()){throw 'probe_preimage_changed'}
if(Test-Path -LiteralPath $FixtureRoot){throw 'fixture_already_exists'}
if(Test-Path -LiteralPath $OutputPath){throw 'output_already_exists'}
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($ModulePath,[ref]$tokens,[ref]$errors)
if($errors.Count -ne 0){throw 'module_parser_failed'}
$functions=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$true))
function Source-Function([string]$Name){
    $found=@($functions|Where-Object {$_.Name -ceq $Name})
    if($found.Count -ne 1){throw ('source_function_not_unique:'+ $Name)}
    return $found[0]
}
$stopAst=Source-Function 'Stop-WorkerOwnedService'
$parameters=@($stopAst.Body.ParamBlock.Parameters)
$names=@($parameters|ForEach-Object {$_.Name.VariablePath.UserPath})
$hasRef=$parameters.Count -eq 5 -and ($names -join ',') -ceq 'Receipt,ReceiptPath,Deadline,Resume,UpgradeEvidence'
if($hasRef){
    $hasRef=@($parameters[4].Attributes|Where-Object {$_ -is [Management.Automation.Language.TypeConstraintAst] -and $_.TypeName.FullName -ieq 'ref'}).Count -eq 1
}
$interfaces=@(@{name='old_stop_optional_upgrade_evidence_ref';passed=$hasRef;actualParameters=$names})
# Define original functions, including genuine ledger/ACL helpers. Do not execute module top-level or the installation action.
foreach($definition in $functions){. ([scriptblock]::Create($definition.Extent.Text))}
Initialize-WorkerInstallNative
$native='Zeb.WorkerInstall.Native' -as [type]
$pinType=$native.Assembly.GetType('Zeb.WorkerInstall.ProcessPin',$true)
if($null -eq $native.GetMethod('ReadStartupExitCode',[type[]]@($pinType))){throw 'actual_exit_code_primitive_missing'}
Add-Type -TypeDefinition ([IO.File]::ReadAllText($ProbePath)) -ErrorAction Stop
New-WorkerCallerDirectory $FixtureRoot
$actualImage=[Diagnostics.Process]::GetCurrentProcess()
try{$script:CurrentImage=$actualImage.MainModule.FileName}finally{$actualImage.Dispose()}
$script:WorkerBearer='technical_fixture_not_a_real_bearer'
$script:Rows=[Collections.Generic.List[object]]::new()
$script:Phase='setup'
$script:Unexpected=$null
$script:ActualChildren=0
$script:ActualPinAndRequireCount=0
$script:ActualReceiptLedgerIo=$false

function Event([string]$Name){$script:Events.Add($Name)}
function Original-Reason($Failure){
    $reason=$Failure
    while($null -ne $reason.InnerException){$reason=$reason.InnerException}
    return $reason
}
function Is-Sentinel($Failure){
    for($reason=$Failure;$null -ne $reason;$reason=$reason.InnerException){if([object]::ReferenceEquals($reason,$script:Sentinel)){return $true}}
    return $false
}
function New-TechnicalGeneration([string]$Tag,$HostPin,$NodePin){
    $value=[pscustomobject]@{Tag=$Tag;DisposeCalls=0;exists=$true;status='Running';serviceName='ZebImageEnhancement';
        accountName='technical_current_session';candidateSid=$HostPin.tokenUserSid;tokenUserSid=$HostPin.tokenUserSid;sessionId=$HostPin.sessionId;
        imagePath=$script:Receipt.active.imagePath;bootId=$script:BootId;host=$HostPin;node=$NodePin;
        endpoint=[pscustomobject]@{scheme='http';host='127.0.0.1';port=1;ownerPid=$NodePin.pid;bootId=$script:BootId}}
    $value|Add-Member -MemberType ScriptMethod -Name Dispose -Value {
        $this.DisposeCalls++;Event ($this.Tag+':dispose')
        if($null -ne $script:EvidenceHolder){$script:EvidenceVisibleDuringDispose=$true}
        if($this.Tag -ceq 'first'){
            $script:BeforeDisposeHost=[Zeb.StartupExitCodeProbe.Probe]::QueryExit($this.host.handle)
            $script:BeforeDisposeNode=[Zeb.StartupExitCodeProbe.Probe]::QueryExit($this.node.handle)
        }
        $this.host.handle.Dispose();$this.node.handle.Dispose()
        if($script:Mode -ceq ($this.Tag+'_dispose_failure')){throw $script:Sentinel}
    }
    return $value
}
# Only the SCM facade, returned maintenance DTO, and exclusive-check boundary are synthetic.
# Original AssertSameGeneration/TestQuiescent/SaveStage/ledger/Stop bodies and all Native pins/exit reads remain real.
function Get-WorkerServiceGeneration($Receipt,[DateTime]$Deadline,[switch]$WaitForReady){
    $script:GenerationCalls++;Event ('generation:'+ $script:GenerationCalls)
    if($script:GenerationCalls -eq 1){return $script:First}
    if($script:GenerationCalls -eq 2){return $script:Second}
    throw 'unexpected_generation_retry'
}
function Assert-WorkerGeneration($Generation,$Receipt,[switch]$AllowUnboundBoot){
    if(-not [object]::ReferenceEquals($Generation,$script:First) -and -not [object]::ReferenceEquals($Generation,$script:Second)){throw 'unexpected_scm_generation'}
    [Zeb.WorkerInstall.Native]::RequireStartupPin($Generation.host)
    [Zeb.WorkerInstall.Native]::RequireStartupPin($Generation.node)
}
function Invoke-WorkerMaintenanceHttp([string]$Method,$Generation,[string]$Bearer,[DateTime]$Deadline){
    Event 'maintenance:dto'
    if($Method -cne 'POST' -or -not [object]::ReferenceEquals($Generation,$script:First)){throw 'unexpected_maintenance_request'}
    return $script:Snapshot
}
function Invoke-WorkerScmChange([string]$Action,[string]$ImagePath,$Generation,[DateTime]$Deadline,[string[]]$StartupArguments){
    if($Action -cne 'Stop' -or -not [object]::ReferenceEquals($Generation,$script:First)){throw 'unexpected_scm_action'}
    $script:ScmCalls++;Event 'scm:stop'
    if($script:ScmCalls -ne 1){throw 'unexpected_duplicate_stop'}
    [Zeb.WorkerInstall.Native]::RequireStartupPin($Generation.host)
    [Zeb.WorkerInstall.Native]::RequireStartupPin($Generation.node)
    if($script:Mode -ceq 'scm_failure'){throw $script:Sentinel}
    foreach($child in $script:Children){$child.ReleaseAndJoin()}
    foreach($original in @($Generation.host,$Generation.node)){
        if(-not [Zeb.WorkerInstall.Native]::Wait($original.handle,[uint32](Get-WorkerRemainingMilliseconds $Deadline))){throw 'original_handle_not_signaled'}
    }
}
function Assert-WorkerExclusiveSnapshot($Receipt,[DateTime]$Deadline){
    $script:ExclusiveCalls++;Event 'exclusive:checked'
    if($script:Mode -ceq 'exclusive_failure'){throw $script:Sentinel}
}
function Same-Projection($Projection,$Generation){
    if($null -eq $Projection -or $Projection.bootId -cne $Generation.bootId){return $false}
    foreach($key in @('scheme','host','port','ownerPid','bootId')){if($Projection.endpoint.$key -cne $Generation.endpoint.$key){return $false}}
    foreach($role in @('host','node')){
        if([object]::ReferenceEquals($Projection.$role,$Generation.$role) -or $null -ne $Projection.$role.PSObject.Properties['handle']){return $false}
        foreach($key in @('pid','creationFileTime','imagePath','tokenUserSid','sessionId')){if($Projection.$role.$key -cne $Generation.$role.$key){return $false}}
    }
    return $true
}
function Test-CapturedEvidence($Evidence){
    try {
    if($null -eq $Evidence){return $false}
    $required=@('OperationId','OldActive','MaintenanceDtoRaw','MaintenanceDtoSha256','First','Second','ScmStopCalls','HostExitCode','NodeExitCode','PinsExclusive')
    if(@($Evidence.PSObject.Properties).Count -ne $required.Count){return $false}
    foreach($name in $required){if($null -eq $Evidence.PSObject.Properties[$name]){return $false}}
    if($Evidence.OperationId -cne $script:Receipt.operation.operationId -or $Evidence.ScmStopCalls -ne 1 -or
        $Evidence.HostExitCode -isnot [uint32] -or $Evidence.HostExitCode -ne 0 -or
        $Evidence.NodeExitCode -isnot [uint32] -or $Evidence.NodeExitCode -ne 0 -or
        $Evidence.PinsExclusive -isnot [bool] -or -not $Evidence.PinsExclusive -or
        $Evidence.MaintenanceDtoRaw -isnot [byte[]] -or
        [Convert]::ToBase64String($Evidence.MaintenanceDtoRaw) -cne [Convert]::ToBase64String($script:ExpectedDtoRaw) -or
        $Evidence.MaintenanceDtoSha256 -cne (Get-WorkerBytesHash $script:ExpectedDtoRaw)){return $false}
    if([object]::ReferenceEquals($Evidence.OldActive,$script:Receipt.active)){return $false}
    foreach($key in @('version','inventorySha256','imagePath')){if($Evidence.OldActive.$key -cne $script:OldActive.$key){return $false}}
    return (Same-Projection $Evidence.First $script:First) -and (Same-Projection $Evidence.Second $script:Second)
    }catch{return $false}
}
$cases=@('omitted_ref_compatibility','capture_original_exit0','queued_keeps_normal_stop','draining',
    'host_exit2','node_exit2','different_generation','scm_failure','exclusive_failure','first_dispose_failure','second_dispose_failure')
try {
    foreach($mode in $cases){
        $script:Phase=$mode+'.setup';$script:Mode=$mode;$script:Events=[Collections.Generic.List[string]]::new()
        $script:Children=[Collections.Generic.List[object]]::new();$script:OwnedPins=[Collections.Generic.List[object]]::new()
        $script:First=$null;$script:Second=$null;$script:EvidenceHolder=$null;$script:EvidenceVisibleDuringDispose=$false
        $script:BeforeDisposeHost=$null;$script:BeforeDisposeNode=$null
        $script:GenerationCalls=0;$script:ScmCalls=0;$script:ExclusiveCalls=0
        $script:Sentinel=[IO.IOException]::new('technical_original_boundary_failure')
        $result=$null;$failure=$null;$cleanupFailure=$null;$row=$null
        try {
            $caseRoot=Join-Path $FixtureRoot $mode;New-WorkerCallerDirectory $caseRoot
            $receiptPath=Join-Path $caseRoot 'receipt.json';$script:BootId=[Guid]::NewGuid().ToString('D')
            $script:Receipt=[pscustomobject]@{installationId=[Guid]::NewGuid().ToString('D');serviceId=[Guid]::NewGuid().ToString('D');
                clientId=[Guid]::NewGuid().ToString('D');state='installed';programRoot=$caseRoot;dataRoot=$caseRoot;
                tokenUserSid=$null;sessionId=$null;configSha256=('a'*64);engineManifestSha256=('b'*64);tlsSha256=$null;
                active=[pscustomobject]@{version='technical-v1';inventorySha256=('c'*64);imagePath=('"'+$script:CurrentImage+'"')};
                previous=$null;lastStopped=$null;operation=[pscustomobject]@{operationId=[Guid]::NewGuid().ToString('D');action='Upgrade';
                    stage='prepared';outcome='pending';maintenanceBootId=$null;targetSha256=('d'*64)}}
            $script:OldActive=$script:Receipt.active|ConvertTo-Json -Compress|ConvertFrom-Json
            foreach($role in @('host','node')){
                $exitCode=if($mode -ceq ($role+'_exit2')){2}else{0}
                $child=[Zeb.StartupExitCodeProbe.Probe]::StartChild($script:CurrentImage,$exitCode)
                $script:Children.Add($child);$script:ActualChildren++
            }
            foreach($generation in @(1,2)){
                foreach($child in $script:Children){
                    $original=[Zeb.WorkerInstall.Native]::Pin([int]$child.Pid,$script:CurrentImage)
                    $script:OwnedPins.Add($original);[Zeb.WorkerInstall.Native]::RequireStartupPin($original)
                    $live=[Zeb.StartupExitCodeProbe.Probe]::QueryLive($original.handle)
                    if(-not $live.Process.Alive -or $live.Process.Pid -ne $original.pid -or $live.Process.Creation -cne $original.creationFileTime){throw 'original_live_pin_precondition_failed'}
                    $script:ActualPinAndRequireCount++
                }
            }
            $script:First=New-TechnicalGeneration 'first' $script:OwnedPins[0] $script:OwnedPins[1]
            $script:Second=New-TechnicalGeneration 'second' $script:OwnedPins[2] $script:OwnedPins[3]
            if($mode -ceq 'different_generation'){$script:Second.bootId=[Guid]::NewGuid().ToString('D')}
            $script:Receipt.tokenUserSid=$script:First.host.tokenUserSid;$script:Receipt.sessionId=$script:First.host.sessionId
            $running=if($mode -ceq 'draining'){1}else{0};$queued=if($mode -ceq 'queued_keeps_normal_stop'){1}else{0}
            $script:Snapshot=[pscustomobject]@{bootId=$script:BootId;sealed=$true;state=$(if($running -eq 1){'draining'}else{'quiescent'});canStop=($running -eq 0);
                store=[pscustomobject]@{queued=$queued;running=$running;slots=0;unreleasedReferences=0};
                http=[pscustomobject]@{sealed=$true;uploads=0;downloads=0;receipts=0};
                pending=[pscustomobject]@{selfTestAdmission=0;selfTestOutputRead=0;runner=0;adapter=0};
                runtime=[pscustomobject]@{closing=$false;startupRecovery='settled';
                    runner=[pscustomobject]@{closed=$false;storeClosed=$false;recoveryState='idle';recoveryInFlight=$false;ownedState='none'};
                    adapter=[pscustomobject]@{sealed=$false;activity='idle';close='not_requested'}}}
            $script:ExpectedDtoRaw=[Text.UTF8Encoding]::new($false,$true).GetBytes(($script:Snapshot|ConvertTo-Json -Depth 12 -Compress)+[char]10)
            $deadline=[DateTime]::UtcNow.AddSeconds(30)
            $script:Phase=$mode+'.original_Stop'
            try {
                if($mode -ceq 'omitted_ref_compatibility'){ $result=Stop-WorkerOwnedService $script:Receipt $receiptPath $deadline $false }
                else {
                    # On the old simple function the fifth positional value is an unused $args entry.
                    # The real old Stop still runs; a missing capture is therefore a behavior RED, not a binder error.
                    $result=Stop-WorkerOwnedService $script:Receipt $receiptPath $deadline $false ([ref]$script:EvidenceHolder)
                }
            }catch{$failure=$_.Exception}
            $script:Phase=$mode+'.assert'
            $ledgerWritten=[IO.File]::Exists($receiptPath)
            if($ledgerWritten){$script:ActualReceiptLedgerIo=$true}
            $normal=$mode -cin @('omitted_ref_compatibility','capture_original_exit0','queued_keeps_normal_stop','host_exit2','node_exit2')
            if($normal){$good=$null -eq $failure -and $result -is [bool] -and $result -eq $true -and $script:ScmCalls -eq 1 -and $script:ExclusiveCalls -eq 1}
            elseif($mode -ceq 'draining'){$good=$null -eq $failure -and $result -is [bool] -and -not $result -and $script:ScmCalls -eq 0 -and $script:ExclusiveCalls -eq 0}
            elseif($mode -ceq 'different_generation'){$good=$null -ne $failure -and (Original-Reason $failure).Message -ceq 'worker_identity_unknown' -and $script:ScmCalls -eq 0}
            else{$good=$null -ne $failure -and (Is-Sentinel $failure) -and $null -eq $result -and $script:ScmCalls -eq 1}
            $expectedFirst=if($mode -ceq 'second_dispose_failure'){0}else{1}
            $expectedSecond=if($mode -ceq 'draining'){0}else{1}
            $good=$good -and $script:First.DisposeCalls -eq $expectedFirst -and $script:Second.DisposeCalls -eq $expectedSecond
            $captureMatches=$false
            if($mode -ceq 'capture_original_exit0'){
                $captureMatches=Test-CapturedEvidence $script:EvidenceHolder
                $good=$good -and $captureMatches -and -not $script:EvidenceVisibleDuringDispose -and
                    $script:BeforeDisposeHost.ExitCode -eq 0 -and $script:BeforeDisposeNode.ExitCode -eq 0 -and
                    $script:BeforeDisposeHost.WaitState -eq 0 -and $script:BeforeDisposeNode.WaitState -eq 0
                if($captureMatches){
                    $script:Receipt.active.version='later-private-receipt-change'
                    $good=$good -and $script:EvidenceHolder.OldActive.version -ceq $script:OldActive.version
                }
            }else{$good=$good -and $null -eq $script:EvidenceHolder -and -not $script:EvidenceVisibleDuringDispose}
            $boundaryReached=$normal -and $null -eq $failure -and $result -is [bool] -and $result -and $script:ScmCalls -eq 1 -and $script:ExclusiveCalls -eq 1
            $row=@{name=$mode;passed=[bool]$good;capturePresent=$null -ne $script:EvidenceHolder;captureMatchesActualOriginalFacts=$captureMatches;
                originalStopReturnedBool=$result -is [bool];returnedValue=$result;failureType=$(if($null -ne $failure){(Original-Reason $failure).GetType().FullName}else{$null});
                originalBoundaryExceptionPreserved=$(if($mode -cin @('scm_failure','exclusive_failure','first_dispose_failure','second_dispose_failure')){Is-Sentinel $failure}else{$null});
                firstDisposeCalls=$script:First.DisposeCalls;secondDisposeCalls=$script:Second.DisposeCalls;captureVisibleDuringDispose=$script:EvidenceVisibleDuringDispose;actualReceiptLedgerWritten=$ledgerWritten;
                stopCalls=$script:ScmCalls;exclusiveCalls=$script:ExclusiveCalls;events=$script:Events.ToArray();
                actualHostSession=$script:First.host.sessionId;actualNodeSession=$script:First.node.sessionId;
                actualHostExitBeforeDispose=$(if($null -ne $script:BeforeDisposeHost){$script:BeforeDisposeHost.ExitCode}else{$null});
                actualNodeExitBeforeDispose=$(if($null -ne $script:BeforeDisposeNode){$script:BeforeDisposeNode.ExitCode}else{$null});
                captureBehaviorBoundaryReached=[bool]$boundaryReached;
                captureBehaviorRed=($mode -ceq 'capture_original_exit0' -and $boundaryReached -and -not $captureMatches)}
        }finally {
            foreach($child in $script:Children){try{$child.Dispose()}catch{$cleanupFailure=$_.Exception.GetType().FullName}}
            foreach($owned in $script:OwnedPins){try{if(-not $owned.handle.IsClosed){$owned.handle.Dispose()}}catch{$cleanupFailure=$_.Exception.GetType().FullName}}
            $guardianUsed=@($script:Children|Where-Object {$_.GuardianUsed}).Count -gt 0
            if($null -ne $row){$row.guardianUsed=$guardianUsed;$row.cleanupFailureType=$cleanupFailure;if($guardianUsed -or $null -ne $cleanupFailure){$row.passed=$false;$row.captureBehaviorRed=$false}}
        }
        if($null -ne $row){$script:Rows.Add($row)}
    }
}catch{
    $reason=Original-Reason $_.Exception
    $script:Unexpected=@{phase=$script:Phase;failureType=$reason.GetType().FullName;nativeErrorCode=$(if($reason -is [ComponentModel.Win32Exception]){$reason.NativeErrorCode}else{$null})}
}
$failed=@($script:Rows|Where-Object {-not $_.passed})
$seen=@($script:Rows|ForEach-Object {$_.name});$pending=@($cases|Where-Object {$_ -cnotin $seen})
$success=$hasRef -and $failed.Count -eq 0 -and $pending.Count -eq 0 -and $null -eq $script:Unexpected
$report=@{code='old_stop_capture_controls_v1';passed=$success;moduleSha256=$ModuleSha;probeSha256=$ProbeSha;
    interfaceChecks=$interfaces;interfacePassCount=$(if($hasRef){1}else{0});interfaceFailCount=$(if($hasRef){0}else{1});
    behaviorPassCount=$script:Rows.Count-$failed.Count;behaviorFailCount=$failed.Count;pendingBehaviorCount=$pending.Count;pendingBehaviorNames=$pending;
    rows=$script:Rows.ToArray();unexpectedFailure=$script:Unexpected;actualChildCount=$script:ActualChildren;
    actualNativeCompiled=$true;actualOriginalPinAndRequire=($script:ActualPinAndRequireCount -gt 0);actualPinAndRequireCount=$script:ActualPinAndRequireCount;
    nativeExitCodeProducerMocked=$false;actualDynamicHandleMutation=$false;
    actualMaintenanceWire=$false;actualScm=$false;actualSessionZeroOrServiceSid=$false;actualExclusiveSnapshot=$false;
    actualReceiptLedgerIo=$script:ActualReceiptLedgerIo;actualQualifiedPackage=$false;actualVerifiedBackup=$false;actualFailureProof=$false;actualRecover=$false;actualGpu=$false;
    nonAuthorSourceReviewRequired='capture ref published only after original finally succeeds; two real ReadStartupExitCode calls use first original pins; no PID reopen or synthetic exitcode; omitted slot and queued Stop semantics unchanged';
    scope='complete original Stop body; real original Native pins/current-session stdin-gated children/kernel exit facts and genuine private ledger IO; SCM facade/maintenance DTO/exclusive check are synthetic; no installation action or completed recovery authority'}
$text=($report|ConvertTo-Json -Depth 12 -Compress)+[char]10
New-WorkerCallerFile -Path $OutputPath -Bytes ([Text.UTF8Encoding]::new($false,$true).GetBytes($text))
[Console]::Write($text)
if(-not $success){exit 1}
exit 0
