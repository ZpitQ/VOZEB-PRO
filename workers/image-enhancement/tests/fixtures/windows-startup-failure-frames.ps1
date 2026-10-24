param([Parameter(Mandatory=$true)][string]$ModulePath,[Parameter(Mandatory=$true)][string]$ModuleSha)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
if($PSVersionTable.PSVersion.Major -ne 5 -or $null -ne ('Zeb.WorkerInstall.Native' -as [type])){throw 'fresh_winps5_required'}
$ModulePath=[IO.Path]::GetFullPath($ModulePath)
if((Get-FileHash -LiteralPath $ModulePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ModuleSha.ToLowerInvariant()){throw 'module_changed'}
$module=Import-Module -Name $ModulePath -Force -PassThru
if(@($module).Count -ne 1){throw 'actual_module_not_unique'}
& $module {Initialize-WorkerInstallNative}
$helper=& $module {$ExecutionContext.SessionState.InvokeCommand.GetCommand('Read-WorkerStartupFailureFrames',[Management.Automation.CommandTypes]::Function)}
$valid=$null -ne $helper -and $null -ne $helper.Module -and
    [string]::Equals($helper.Module.Path,$ModulePath,[StringComparison]::OrdinalIgnoreCase) -and
    -not $module.ExportedFunctions.ContainsKey('Read-WorkerStartupFailureFrames')
if($valid){
    $functionAst=$helper.ScriptBlock.Ast
    if($functionAst -is [Management.Automation.Language.FunctionDefinitionAst]){$functionAst=$functionAst.Body}
    $parameters=@($functionAst.ParamBlock.Parameters)
    $valid=$parameters.Count -eq 1 -and $parameters[0].Name.VariablePath.UserPath -ceq 'Capture'
}
$names=@('listener_failure_force1_expected_invalid_operation','schema_failure_force1_expected_invalid_operation',
    'legacy_missing_cleanup_pair_refused','cleanup_failure_count_nonzero_refused','owner_release_incomplete_refused',
    'owner_tree_active_missing_refused','tree_exit_missing_refused','stderr_not_eof_refused','stdout_sink_failure_refused',
    'phase_recovery_already_called_refused','prepared_wire_sha_mismatch_refused','raw_context_attempt_mismatch_refused',
    'stage_before_settled_refused','host_zero_exit_code_refused','truncated_or_extra_raw_frame_refused')
$scope='real original Native context/frame parser and private failure-frame consumer; synthetic Capture and public pin identities only; no real Receive EOF/wait, original handles, service, cleanup or Proof/Recover evidence'
$sourceGate='real ReadStartupContext/ReadStartupFrame, original Assert-WorkerStartupBindings/Get-WorkerBytesHash; exactly four original bounded length-prefixed wires; original context and prepared-wire hash; paired cleanup extension, strict booleans/typed captured exit codes and exact cleanup projections; preserve original four parsed objects without capture mutation, IO or qualification; original-handle and complete Proof gates remain separate'
if(-not $valid){
    @{code='startup_failure_frames_interface_red';moduleSha256=$ModuleSha;actualNativeCompiled=$true;interfacePresent=$null -ne $helper;
      interfacePassCount=0;interfaceFailCount=1;behaviorPassCount=0;behaviorFailCount=0;pendingBehaviorControls=$names.Count;pendingBehaviorNames=$names;
      syntheticCaptureConstructed=$false;actualFrameConsumerInvoked=$false;actualOriginalHandleVerification=$false;actualFailureProof=$false;
      actualRecover=$false;actualScm=$false;actualGpu=$false;nonAuthorSourceReviewRequired=$true;sourceReviewGate=$sourceGate;scope=$scope}|ConvertTo-Json -Depth 8 -Compress
    exit 1
}
$utf8=[Text.UTF8Encoding]::new($false,$true)
function Bytes-Hash([byte[]]$Bytes){
    $hash=[Security.Cryptography.SHA256]::Create()
    try{return [BitConverter]::ToString($hash.ComputeHash($Bytes)).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
}
function Wire($Document){
    $body=$utf8.GetBytes(($Document|ConvertTo-Json -Depth 8 -Compress))
    $wire=[byte[]]::new(4+$body.Length)
    [BitConverter]::GetBytes([uint32]$body.Length).CopyTo($wire,0);$body.CopyTo($wire,4)
    return ,$wire
}
function New-Scene([string]$Phase){
    $operation='a1111111-1111-4111-8111-111111111111';$attempt='b2222222-2222-4222-8222-222222222222'
    $sha='a'*64;$nonce='b'*64
    $context=[ordered]@{v=1;operationId=$operation;startupAttemptId=$attempt;startingReceiptSha256=$sha;
        pipeName='zeb-worker-startup-v1-b2222222222242228222222222222222';nonce=$nonce;cutoffTick64=1234567890;
        caller=[ordered]@{pid=19;creationFileTime='9007199254740992';imagePath='C:\Zeb Technical\caller.exe';imageSha256=$sha;
            tokenUserSid='S-1-5-21-1-2-3-1001';sessionId=1};expectedServiceSid='S-1-5-80-1-2-3-4-5';
        inventorySha256=$sha;configSha256=$sha;engineManifestSha256=$sha;hostSha256=$sha;nodeSha256=$sha}
    $hostIdentity=[ordered]@{pid=17;creationFileTime='9007199254740993'}
    $nodeIdentity=[ordered]@{pid=18;creationFileTime='18446744073709551615'}
    $prepared=[ordered]@{v=1;kind='prepared';seq=1;nonce=$nonce;operationId=$operation;startupAttemptId=$attempt;
        startingReceiptSha256=$sha;host=$hostIdentity;node=$nodeIdentity;jobName='Local\Zeb-technical';inventorySha256=$sha;
        configSha256=$sha;engineManifestSha256=$sha;hostSha256=$sha;nodeSha256=$sha;
        inspection=[ordered]@{processSignaled=$false;inOriginalJob=$true;activeProcesses=1;totalProcesses=1;
            jobHandleFlags=0;processHandleFlags=0;authorized=$false;sealed=$false}}
    $preparedWire=Wire $prepared;$preparedSha=Bytes-Hash $preparedWire
    $ack=[ordered]@{v=1;kind='ack_prepared';seq=2;nonce=$nonce;operationId=$operation;startupAttemptId=$attempt;
        preparedSha256=$preparedSha;host=$hostIdentity;node=$nodeIdentity}
    $authorized=[ordered]@{v=1;kind='authorized';seq=3;nonce=$nonce;operationId=$operation;startupAttemptId=$attempt;
        preparedSha256=$preparedSha;host=$hostIdentity;node=$nodeIdentity;authorized=$true}
    $phaseDocument=[ordered]@{v=1;kind='startup_phase';attempt=$attempt;nonce=$nonce;phase=$Phase;
        runnerConstructed=($Phase -ceq 'listener_bind_failed');listenerSucceeded=$false;recoveryCalled=$false;
        claimEntered=$false;prepareEntered=$false;authorizeEntered=$false}
    $settled=[ordered]@{v=1;kind='settled';seq=4;nonce=$nonce;operationId=$operation;startupAttemptId=$attempt;
        preparedSha256=$preparedSha;host=$hostIdentity;node=$nodeIdentity;phase=$phaseDocument;jobName=$prepared.jobName;
        sealed=$true;ownerReleasedTreeActive=0;ownerReleaseCompleted=$true;cleanupFailureCount=0;forceCalls=1;failureType='InvalidOperationException';
        cleanup=[ordered]@{rootExit=[ordered]@{identity=$nodeIdentity;exitCode=2};
            treeExit=[ordered]@{engineExitCode=2;activeProcesses=0};
            stdout=[ordered]@{bytesRead=17;eof=$true;readFailureType=$null;sinkFailureType=$null};
            stderr=[ordered]@{bytesRead=0;eof=$true;readFailureType=$null;sinkFailureType=$null}}}
    $contextRaw=$utf8.GetBytes(($context|ConvertTo-Json -Depth 8 -Compress))
    $capture=[pscustomobject]@{OperationId=$operation;Stage='settled';Disposed=$false;ContextRaw=$contextRaw;
        Context=[Zeb.WorkerInstall.Native]::ReadStartupContext($contextRaw);PreparedSha256=$preparedSha;JobName=$prepared.jobName;
        HostPin=[pscustomobject]@{pid=17;creationFileTime='9007199254740993'};
        NodePin=[pscustomobject]@{pid=18;creationFileTime='18446744073709551615'};
        HostExited=$true;NodeExited=$true;HostExitCode=[uint32]1;NodeExitCode=[uint32]2;
        RawFrames=[Collections.Generic.List[object]]::new()}
    $documents=@($prepared,$ack,$authorized,$settled)
    foreach($index in 0..3){$kind=@('prepared','ack_prepared','authorized','final')[$index];$capture.RawFrames.Add([pscustomobject]@{kind=$kind;raw=(Wire $documents[$index])})}
    return [pscustomobject]@{Capture=$capture;ContextDocument=$context;Documents=$documents}
}
$cases=@(
    @{name=$names[0];phase='listener_bind_failed';change='none';accept=$true},
    @{name=$names[1];phase='store_schema_incompatible';change='none';accept=$true},
    @{name=$names[2];phase='listener_bind_failed';change='legacy';accept=$false},
    @{name=$names[3];phase='listener_bind_failed';change='cleanup';accept=$false},
    @{name=$names[4];phase='listener_bind_failed';change='release';accept=$false},
    @{name=$names[5];phase='listener_bind_failed';change='owner-active';accept=$false},
    @{name=$names[6];phase='listener_bind_failed';change='tree';accept=$false},
    @{name=$names[7];phase='listener_bind_failed';change='eof';accept=$false},
    @{name=$names[8];phase='listener_bind_failed';change='sink';accept=$false},
    @{name=$names[9];phase='listener_bind_failed';change='recovery';accept=$false},
    @{name=$names[10];phase='listener_bind_failed';change='sha';accept=$false},
    @{name=$names[11];phase='listener_bind_failed';change='attempt';accept=$false},
    @{name=$names[12];phase='listener_bind_failed';change='stage';accept=$false},
    @{name=$names[13];phase='listener_bind_failed';change='host-zero';accept=$false},
    @{name=$names[14];phase='listener_bind_failed';change='truncate';accept=$false},
    @{name=$names[14];phase='listener_bind_failed';change='extra';accept=$false}
)
$checks=[Collections.Generic.List[object]]::new();$invocations=0
foreach($case in $cases){
    $scene=New-Scene $case.phase;$capture=$scene.Capture;$settled=$scene.Documents[3]
    switch($case.change){
        'legacy'{$settled.Remove('ownerReleaseCompleted');$settled.Remove('cleanupFailureCount')}
        'cleanup'{$settled.cleanupFailureCount=1}
        'release'{$settled.ownerReleaseCompleted=$false}
        'owner-active'{$settled.ownerReleasedTreeActive=$null}
        'tree'{$settled.cleanup.treeExit=$null}
        'eof'{$settled.cleanup.stderr.eof=$false}
        'sink'{$settled.cleanup.stdout.sinkFailureType='IOException'}
        'recovery'{$settled.phase.recoveryCalled=$true}
        'sha'{$capture.PreparedSha256='c'*64}
        'attempt'{
            $scene.ContextDocument.startupAttemptId='c3333333-3333-4333-8333-333333333333'
            $scene.ContextDocument.pipeName='zeb-worker-startup-v1-c3333333333343338333333333333333'
            $capture.ContextRaw=$utf8.GetBytes(($scene.ContextDocument|ConvertTo-Json -Depth 8 -Compress))
        }
        'stage'{$capture.Stage='exit-wait'}
        'host-zero'{$capture.HostExitCode=[uint32]0}
    }
    $capture.RawFrames[3].raw=Wire $settled
    if($case.change -ceq 'truncate'){
        $original=$capture.RawFrames[0].raw;$short=[byte[]]::new($original.Length-1)
        [Buffer]::BlockCopy($original,0,$short,0,$short.Length);$capture.RawFrames[0].raw=$short
    }
    if($case.change -ceq 'extra'){$capture.RawFrames.Add([pscustomobject]@{kind='final';raw=(Wire $settled)})}
    $before=$capture|ConvertTo-Json -Depth 16 -Compress
    $accepted=$false;$refused=$false;$failureType=$null;$fixedCode=$null;$observed=@();$invocations++
    try{
        $read=& $module {param($Value) Read-WorkerStartupFailureFrames $Value} $capture
        $observed=@($read);$accepted=$true
    }catch{
        $reason=$_.Exception;while($null -ne $reason.InnerException){$reason=$reason.InnerException}
        $failureType=$reason.GetType().FullName
        if($reason.Message -cmatch '\Aworker_[a-z_]+\z'){$fixedCode=$reason.Message}
        $refused=$null -ne $fixedCode -and ($reason -is [IO.InvalidDataException] -or $reason -is [Management.Automation.RuntimeException])
    }
    $unchanged=($capture|ConvertTo-Json -Depth 16 -Compress) -ceq $before
    $good=if($case.accept){$accepted -and $observed.Count -eq 4 -and $unchanged}else{-not $accepted -and $refused -and $unchanged}
    if($case.accept -and $accepted -and $observed.Count -eq 4){
        foreach($index in 0..3){
            $shape=@('prepared','ack_prepared','authorized','settled')[$index]
            $body=$utf8.GetBytes(($scene.Documents[$index]|ConvertTo-Json -Depth 8 -Compress))
            $expected=[Zeb.WorkerInstall.Native]::ReadStartupFrame($body,$shape)
            $good=$good -and $observed[$index] -is [Collections.IDictionary] -and
                ($observed[$index]|ConvertTo-Json -Depth 12 -Compress) -ceq ($expected|ConvertTo-Json -Depth 12 -Compress)
        }
        $good=$good -and $observed[3]['forceCalls'] -eq 1 -and $observed[3]['failureType'] -ceq 'InvalidOperationException' -and
            $capture.HostExitCode -is [uint32] -and $capture.HostExitCode -eq 1 -and $capture.NodeExitCode -is [uint32] -and $capture.NodeExitCode -eq 2
    }
    $checks.Add(@{control=$case.name;variant=$case.change;passed=[bool]$good;accepted=$accepted;expectedAccept=$case.accept;
        refused=$refused;failureType=$failureType;fixedCode=$fixedCode;captureUnchanged=$unchanged;returnedFrameCount=$observed.Count})
}
$rows=@(foreach($name in $names){
    $parts=@($checks|Where-Object {$_.control -ceq $name})
    @{name=$name;passed=$parts.Count -gt 0 -and @($parts|Where-Object {-not $_.passed}).Count -eq 0;checks=$parts}
})
$failed=@($rows|Where-Object {-not $_.passed})
if((Get-FileHash -LiteralPath $ModulePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ModuleSha.ToLowerInvariant()){throw 'module_changed_during_controls'}
@{code='startup_failure_frames_controls_v1';moduleSha256=$ModuleSha;actualNativeCompiled=$true;interfacePassCount=1;interfaceFailCount=0;
  passed=$failed.Count -eq 0;passCount=$rows.Count-$failed.Count;failCount=$failed.Count;expectedBehaviorControls=$names.Count;
  behaviorPassCount=$rows.Count-$failed.Count;behaviorFailCount=$failed.Count;pendingBehaviorControls=0;pendingBehaviorNames=@();rows=$rows;
  syntheticCaptureConstructed=$true;actualFrameConsumerInvoked=$invocations -gt 0;helperInvocationCount=$invocations;
  actualReceiveExecuted=$false;actualOriginalHandleVerification=$false;actualRealExitCodesObserved=$false;actualFailureProof=$false;
  actualRecover=$false;actualScm=$false;actualGpu=$false;nonAuthorSourceReviewRequired=$true;sourceReviewGate=$sourceGate;scope=$scope}|ConvertTo-Json -Depth 12 -Compress
if($failed.Count -gt 0){exit 1}
exit 0
