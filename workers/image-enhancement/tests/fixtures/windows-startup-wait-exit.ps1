param(
    [Parameter(Mandatory=$true)][string]$ModulePath,
    [Parameter(Mandatory=$true)][string]$ModuleSha,
    [Parameter(Mandatory=$true)][string]$ProbePath,
    [Parameter(Mandatory=$true)][string]$ProbeSha,
    [Parameter(Mandatory=$true)][string]$ChildImage
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
if($PSVersionTable.PSVersion.Major -ne 5){throw 'fresh_winps5_required'}
if($null -ne ('Zeb.WorkerInstall.Native' -as [type]) -or $null -ne ('Zeb.StartupWaitExitProbe.Probe' -as [type])){throw 'fresh_native_and_probe_process_required'}
$ModulePath=[IO.Path]::GetFullPath($ModulePath);$ProbePath=[IO.Path]::GetFullPath($ProbePath)
$ChildImage=[IO.Path]::GetFullPath($ChildImage)
$childImageSha=(Get-FileHash -LiteralPath $ChildImage -Algorithm SHA256).Hash.ToLowerInvariant()
if((Get-FileHash -LiteralPath $ModulePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ModuleSha.ToLowerInvariant()){throw 'module_changed'}
if((Get-FileHash -LiteralPath $ProbePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ProbeSha.ToLowerInvariant()){throw 'probe_changed'}
$module=Import-Module -Name $ModulePath -Force -PassThru
if(@($module).Count -ne 1){throw 'actual_module_not_unique'}
& $module {Initialize-WorkerInstallNative}
$helper=& $module {$ExecutionContext.SessionState.InvokeCommand.GetCommand('Wait-WorkerStartupExit',[Management.Automation.CommandTypes]::Function)}
$valid=$null -ne $helper -and $null -ne $helper.Module -and
    [string]::Equals($helper.Module.Path,$ModulePath,[StringComparison]::OrdinalIgnoreCase) -and
    -not $module.ExportedFunctions.ContainsKey('Wait-WorkerStartupExit')
if($valid){
    $functionAst=$helper.ScriptBlock.Ast
    if($functionAst -is [Management.Automation.Language.FunctionDefinitionAst]){$functionAst=$functionAst.Body}
    $parameters=@($functionAst.ParamBlock.Parameters)
    $valid=$parameters.Count -eq 2 -and $parameters[0].Name.VariablePath.UserPath -ceq 'Capture' -and
        $parameters[1].Name.VariablePath.UserPath -ceq 'Deadline' -and $parameters[1].StaticType -eq [DateTime]
}
$names=@(
    'real_refused_capture_initial_exit_codes_null',
    'already_signaled_host0_node2_and_original_borrows',
    'delayed_real_host_then_node_exit_succeeds',
    'utc_total_deadline_is_shared_host_then_live_node',
    'earlier_monotonic_cutoff_is_shared_host_then_live_node',
    'expired_utc_rejected',
    'expired_monotonic_cutoff_rejected',
    'disposed_capture_rejected',
    'missing_host_pin_rejected',
    'missing_node_pin_rejected',
    'wrong_host_pid_record_rejected',
    'wrong_node_handle_rejected',
    'closed_caller_at_entry_rejected',
    'arbitrary_uint_exit_codes_are_observations_not_proof_gates'
)
$scope='real private wait consumer with actual current-session original handles; synthetic cutoff-only capture, no Receive/SCM/Session0/cross-SID/FailureProof/Recover/GPU claim'
$sourceGate='real Assert-WorkerStartupWindow and original caller Require before/after each wait and before exit-code read; each wait gets min(original UTC remaining, original Context cutoff remaining); Host then Node share one absolute window; Native.ReadStartupExitCode receives original pins; no new timeout, PID reopen, pin disposal or recovery authority'
if(-not $valid){
    @{code='startup_wait_exit_interface_red';moduleSha256=$ModuleSha;probeSha256=$ProbeSha;actualNativeCompiled=$true;
      interfacePresent=($null -ne $helper);interfacePassCount=0;interfaceFailCount=1;behaviorPassCount=0;behaviorFailCount=0;
      pendingBehaviorControls=$names.Count;pendingBehaviorNames=$names;probeCompiled=$false;actualChildCreated=$false;
      actualWaitHelperInvoked=$false;actualCaptureFactoryInvoked=$false;actualReceiveExecuted=$false;
      nonAuthorSourceReviewRequired=$true;sourceReviewGate=$sourceGate;scope=$scope}|ConvertTo-Json -Depth 8 -Compress
    exit 1
}
Add-Type -TypeDefinition ([IO.File]::ReadAllText($ProbePath)) -ErrorAction Stop
$rows=[Collections.Generic.List[object]]::new()
$scenes=[Collections.Generic.List[object]]::new()
$script:phase='setup';$script:helperCalls=0;$script:childCount=0;$script:captureFactoryInvoked=$false
$script:factoryFailure=$null;$script:unexpectedFailure=$null
function Root-Failure($Exception){$reason=$Exception;while($null -ne $reason.InnerException){$reason=$reason.InnerException};return $reason}
function Failure-Info($Exception){
    $reason=Root-Failure $Exception
    return @{phase=$script:phase;failureType=$reason.GetType().FullName;nativeErrorCode=$(if($reason -is [ComponentModel.Win32Exception]){$reason.NativeErrorCode}else{$null});
        fixedCode=$(if($reason.Message -cmatch '\Aworker_[a-z_]+\z'){$reason.Message}else{$null})}
}
function Expected-Refusal($Failure){
    if($null -eq $Failure){return $false}
    if($Failure.failureType -ceq 'System.ObjectDisposedException'){return $true}
    return $Failure.fixedCode -cin @('worker_timeout_unknown','worker_startup_observation_unknown','worker_identity_unknown')
}
function Add-Row([string]$Name,[bool]$Passed,$Details){
    $rows.Add(@{name=$Name;passed=$Passed;details=$Details})
}
function New-Scene([int]$HostExit=0,[int]$NodeExit=2) {
    $scene=[pscustomobject]@{Caller=$null;Host=$null;Node=$null;HostHandle=$null;NodeHandle=$null;HostChild=$null;NodeChild=$null;
        HostLive=$null;NodeLive=$null;HostExpectedCode=[BitConverter]::ToUInt32([BitConverter]::GetBytes($HostExit),0);
        NodeExpectedCode=[BitConverter]::ToUInt32([BitConverter]::GetBytes($NodeExit),0);Tasks=[Collections.Generic.List[Threading.Tasks.Task]]::new()}
    $scenes.Add($scene)
    $scene.Caller=[Zeb.WorkerInstall.Native]::PinStartupCaller()
    $image=$ChildImage
    $scene.HostChild=[Zeb.StartupWaitExitProbe.Probe]::StartChild($image,$HostExit);$script:childCount++
    $scene.Host=[Zeb.WorkerInstall.Native]::Pin($scene.HostChild.Pid,$image);$scene.HostHandle=$scene.Host.handle
    [Zeb.WorkerInstall.Native]::RequireStartupPin($scene.Host)
    $scene.HostLive=[Zeb.StartupWaitExitProbe.Probe]::QueryLive($scene.HostHandle)
    $scene.NodeChild=[Zeb.StartupWaitExitProbe.Probe]::StartChild($image,$NodeExit);$script:childCount++
    $scene.Node=[Zeb.WorkerInstall.Native]::Pin($scene.NodeChild.Pid,$image);$scene.NodeHandle=$scene.Node.handle
    [Zeb.WorkerInstall.Native]::RequireStartupPin($scene.Node)
    $scene.NodeLive=[Zeb.StartupWaitExitProbe.Probe]::QueryLive($scene.NodeHandle)
    return $scene
}
function New-Capture($Scene,[int]$UtcMs,[int]$CutoffMs){
    $tick=[Zeb.WorkerInstall.Native]::TickCount64()
    return [pscustomobject]@{Capture=[pscustomobject]@{Disposed=$false;Context=@{cutoffTick64=($tick+[long]$CutoffMs)};
        CallerPin=$Scene.Caller;HostPin=$Scene.Host;NodePin=$Scene.Node;HostExited=$null;NodeExited=$null;HostExitCode=$null;NodeExitCode=$null};
        Deadline=[DateTime]::UtcNow.AddMilliseconds($UtcMs);OriginalCutoff=($tick+[long]$CutoffMs)}
}
function Attempt-Wait($Case){
    $capture=$Case.Capture;$hostBefore=$capture.HostPin;$nodeBefore=$capture.NodePin;$caller=$capture.CallerPin;$disposed=$capture.Disposed
    $watch=[Diagnostics.Stopwatch]::StartNew();$failure=$null;$outputs=@()
    try{
        $script:helperCalls++
        $outputs=@(& $module {param($Value,[DateTime]$Limit) Wait-WorkerStartupExit $Value $Limit} $capture $Case.Deadline)
    }catch{$failure=Failure-Info $_.Exception}
    finally{$watch.Stop()}
    return @{succeeded=$null -eq $failure;refused=(Expected-Refusal $failure);failure=$failure;elapsedMs=$watch.ElapsedMilliseconds;
        noReturnValue=$outputs.Count -eq 0;captureUnchanged=$capture.Disposed -eq $disposed -and
            [object]::ReferenceEquals($capture.HostPin,$hostBefore) -and [object]::ReferenceEquals($capture.NodePin,$nodeBefore) -and
            [object]::ReferenceEquals($capture.CallerPin,$caller) -and $capture.Context['cutoffTick64'] -eq $Case.OriginalCutoff}
}
function Original-Handle-Preserved($Pin,$Handle,$Live){
    if($null -eq $Pin -or $null -eq $Handle -or $Handle.IsClosed -or $Handle.IsInvalid -or -not [object]::ReferenceEquals($Pin.handle,$Handle)){return $false}
    $facts=[Zeb.StartupWaitExitProbe.Probe]::QueryExit($Handle)
    return $facts.NonInherited -and $facts.Pid -eq $Live.Process.Pid -and $facts.Creation -ceq $Live.Process.Creation -and
        $facts.HandleValue -eq $Live.Process.HandleValue
}
function Scene-Borrows-Preserved($Scene){
    $good=(Original-Handle-Preserved $Scene.Host $Scene.HostHandle $Scene.HostLive) -and
        (Original-Handle-Preserved $Scene.Node $Scene.NodeHandle $Scene.NodeLive)
    try{[Zeb.WorkerInstall.Native]::RequireStartupPin($Scene.Caller.Pin)}
    catch{$good=$false}
    return $good
}
function Success-Facts($Scene,$Case,$Attempt){
    $c=$Case.Capture;$hostFacts=[Zeb.StartupWaitExitProbe.Probe]::QueryExit($Scene.HostHandle);$nodeFacts=[Zeb.StartupWaitExitProbe.Probe]::QueryExit($Scene.NodeHandle)
    return $Attempt.succeeded -and $Attempt.noReturnValue -and $Attempt.captureUnchanged -and $c.HostExited -ceq $true -and $c.NodeExited -ceq $true -and
        $c.HostExitCode -is [uint32] -and $c.HostExitCode -eq $Scene.HostExpectedCode -and $c.NodeExitCode -is [uint32] -and $c.NodeExitCode -eq $Scene.NodeExpectedCode -and
        -not $hostFacts.Alive -and $hostFacts.ExitCode -eq $Scene.HostExpectedCode -and -not $nodeFacts.Alive -and $nodeFacts.ExitCode -eq $Scene.NodeExpectedCode -and
        (Scene-Borrows-Preserved $Scene) -and [DateTime]::UtcNow -lt $Case.Deadline -and
        [Zeb.WorkerInstall.Native]::TickCount64() -lt $Case.OriginalCutoff
}
function Release-Schedule($Child){
    return @{scheduledTick64=$Child.ReleaseScheduledTick64;enteredTick64=$Child.ReleaseEnteredTick64;completedTick64=$Child.ReleaseCompletedTick64}
}
function Close-Scene($Scene){
    try{
        foreach($task in $Scene.Tasks){if(-not $task.Wait(6000)){throw 'test_release_task_unjoined'}}
        if($null -ne $Scene.HostChild){$Scene.HostChild.ReleaseAndJoin()}
        if($null -ne $Scene.NodeChild){$Scene.NodeChild.ReleaseAndJoin()}
    }catch{Add-Row 'scene_cleanup_failed' $false (Failure-Info $_.Exception)}
    finally{
        foreach($child in @($Scene.HostChild,$Scene.NodeChild)){
            if($null -ne $child){
                try{$child.Dispose();if($child.GuardianUsed){Add-Row 'scene_guardian_used' $false @{guardianUsed=$true}}}
                catch{Add-Row 'child_owner_cleanup_failed' $false (Failure-Info $_.Exception)}
            }
        }
        foreach($handle in @($Scene.HostHandle,$Scene.NodeHandle)){if($null -ne $handle){$handle.Dispose()}}
        if($null -ne $Scene.Caller){try{$Scene.Caller.Dispose()}catch{Add-Row 'caller_owner_cleanup_failed' $false (Failure-Info $_.Exception)}}
    }
}
try{
    $script:phase='factory.initial_null_fields'
    $op=[Guid]::NewGuid().ToString()
    $receipt=[pscustomobject]@{operation=[pscustomobject]@{operationId=$op;stage='started';outcome='pending'}}
    $worker=[IO.DirectoryInfo]::new([IO.Path]::GetDirectoryName($ModulePath)).Parent.Parent.FullName
    $missing=[IO.Path]::Combine($worker,'node_modules','.cache','wait-exit-missing-'+$op+'.json')
    if(Test-Path -LiteralPath $missing){throw 'exclusive_missing_receipt_required'}
    $script:captureFactoryInvoked=$true
    $initial=& $module {param($Value,$Path,[DateTime]$Limit) New-WorkerStartupObservation $Value $Path $Limit} $receipt $missing ([DateTime]::UtcNow.AddSeconds(5))
    try{
        $hostCode=$initial.PSObject.Properties['HostExitCode'];$nodeCode=$initial.PSObject.Properties['NodeExitCode']
        $good=$null -ne $initial.Failure -and $null -ne $hostCode -and $null -ne $nodeCode -and
            $null -eq $hostCode.Value -and $null -eq $nodeCode.Value -and $null -eq $initial.HostExited -and $null -eq $initial.NodeExited -and
            $null -eq $initial.CallerPin -and $null -eq $initial.HostPin -and $null -eq $initial.NodePin
        Add-Row $names[0] $good @{actualRefusedFactoryCapture=$true;hostExitCodePresent=$null -ne $hostCode;nodeExitCodePresent=$null -ne $nodeCode;actualProducerSuccess=$false}
    }finally{$initial.Dispose()}

    $script:phase='already_exited.prepare'
    $base=New-Scene;$base.HostChild.ReleaseAndJoin();$base.NodeChild.ReleaseAndJoin()
    $case=New-Capture $base 3000 3000;$script:phase='already_exited.wait';$attempt=Attempt-Wait $case
    Add-Row $names[1] (Success-Facts $base $case $attempt) $attempt

    $script:phase='delayed.prepare';$delayed=New-Scene
    $case=New-Capture $delayed 3000 3000
    $delayed.Tasks.Add($delayed.HostChild.ReleaseAfter(300));$delayed.Tasks.Add($delayed.NodeChild.ReleaseAfter(900))
    $script:phase='delayed.wait';$attempt=Attempt-Wait $case
    $attempt.releaseSchedule=@{originalCutoffTick64=$case.OriginalCutoff;utcDeadline=$case.Deadline.ToString('o');
        host=(Release-Schedule $delayed.HostChild);node=(Release-Schedule $delayed.NodeChild)}
    Add-Row $names[2] ((Success-Facts $delayed $case $attempt) -and $attempt.elapsedMs -ge 650) $attempt

    foreach($mode in @('utc','cutoff')){
        $script:phase=($mode+'.prepare');$scene=New-Scene
        $utc=if($mode -ceq 'utc'){1000}else{3000};$cut=if($mode -ceq 'cutoff'){1000}else{3000}
        $case=New-Capture $scene $utc $cut
        $scene.Tasks.Add($scene.HostChild.ReleaseAfter(700))
        $script:phase=($mode+'.shared_host_then_live_node');$attempt=Attempt-Wait $case
        $node=[Zeb.StartupWaitExitProbe.Probe]::QueryExit($scene.NodeHandle)
        $good=$attempt.refused -and $attempt.noReturnValue -and $attempt.captureUnchanged -and
            $case.Capture.HostExited -ceq $true -and $case.Capture.HostExitCode -is [uint32] -and $case.Capture.HostExitCode -eq 0 -and
            $case.Capture.NodeExited -cne $true -and $null -eq $case.Capture.NodeExitCode -and $node.Alive -and
            $attempt.elapsedMs -ge 800 -and $attempt.elapsedMs -le 1350 -and (Scene-Borrows-Preserved $scene)
        if($mode -ceq 'cutoff'){$good=$good -and [DateTime]::UtcNow -lt $case.Deadline}
        $name=if($mode -ceq 'utc'){$names[3]}else{$names[4]}
        Add-Row $name $good @{attempt=$attempt;hostFirstRecorded=$case.Capture.HostExited;hostCode=$case.Capture.HostExitCode;nodeStillAlive=$node.Alive;
            totalBudgetMs=1000;hostReleaseAfterMs=700;timingSlackMs=350;noNodeExitCode=$null -eq $case.Capture.NodeExitCode;
            releaseSchedule=@{originalCutoffTick64=$case.OriginalCutoff;utcDeadline=$case.Deadline.ToString('o');host=(Release-Schedule $scene.HostChild)}}
    }

    foreach($mode in @('utc','cutoff','disposed','missing-host','missing-node')){
        $case=New-Capture $base 3000 3000
        switch($mode){
            'utc'{$case.Deadline=[DateTime]::UtcNow.AddMilliseconds(-1);$name=$names[5]}
            'cutoff'{$case.Capture.Context['cutoffTick64']=[Zeb.WorkerInstall.Native]::TickCount64()-1;$case.OriginalCutoff=$case.Capture.Context['cutoffTick64'];$name=$names[6]}
            'disposed'{$case.Capture.Disposed=$true;$name=$names[7]}
            'missing-host'{$case.Capture.HostPin=$null;$name=$names[8]}
            'missing-node'{$case.Capture.NodePin=$null;$name=$names[9]}
        }
        $script:phase=('negative.'+$mode);$attempt=Attempt-Wait $case
        $good=$attempt.refused -and $attempt.noReturnValue -and $attempt.captureUnchanged -and $null -eq $case.Capture.NodeExitCode -and
            (Scene-Borrows-Preserved $base)
        if($mode -cne 'missing-node'){$good=$good -and $null -eq $case.Capture.HostExitCode}
        Add-Row $name $good $attempt
    }

    $case=New-Capture $base 3000 3000;$savedPid=$base.Host.pid
    try{
        $badPid=if($savedPid -eq [int]::MaxValue){$savedPid-1}else{$savedPid+1};$base.Host.pid=$badPid
        $script:phase='negative.wrong_host_pid';$attempt=Attempt-Wait $case
        $unchanged=$base.Host.pid -eq $badPid
    }finally{$base.Host.pid=$savedPid}
    Add-Row $names[10] ($attempt.refused -and $attempt.noReturnValue -and $attempt.captureUnchanged -and $unchanged -and
        $null -eq $case.Capture.HostExitCode -and $null -eq $case.Capture.NodeExitCode -and (Scene-Borrows-Preserved $base)) $attempt

    $case=New-Capture $base 3000 3000
    try{
        $base.Node.handle=$base.HostHandle
        $script:phase='negative.wrong_node_handle';$attempt=Attempt-Wait $case
        $unchanged=[object]::ReferenceEquals($base.Node.handle,$base.HostHandle)
    }finally{$base.Node.handle=$base.NodeHandle}
    Add-Row $names[11] ($attempt.refused -and $attempt.noReturnValue -and $attempt.captureUnchanged -and $unchanged -and
        $null -eq $case.Capture.NodeExitCode -and (Scene-Borrows-Preserved $base)) $attempt

    $closedCaller=[Zeb.WorkerInstall.Native]::PinStartupCaller()
    try{
        $closedCaller.Dispose();$case=New-Capture $base 3000 3000;$case.Capture.CallerPin=$closedCaller
        $script:phase='negative.closed_caller_at_entry';$attempt=Attempt-Wait $case
        Add-Row $names[12] ($attempt.refused -and $attempt.noReturnValue -and $attempt.captureUnchanged -and
            $null -eq $case.Capture.HostExitCode -and $null -eq $case.Capture.NodeExitCode -and (Scene-Borrows-Preserved $base)) $attempt
    }finally{$closedCaller.Dispose()}

    $script:phase='arbitrary_uint.prepare';$arbitrary=New-Scene -1 3
    $arbitrary.HostChild.ReleaseAndJoin();$arbitrary.NodeChild.ReleaseAndJoin()
    $case=New-Capture $arbitrary 3000 3000;$script:phase='arbitrary_uint.wait';$attempt=Attempt-Wait $case
    Add-Row $names[13] (Success-Facts $arbitrary $case $attempt) @{attempt=$attempt;hostExitCode=$case.Capture.HostExitCode;
        nodeExitCode=$case.Capture.NodeExitCode;expectedHostExitCode=[uint32]::MaxValue;expectedNodeExitCode=3;actualFailureProof=$false}
}catch{
    $script:unexpectedFailure=Failure-Info $_.Exception
    Add-Row 'unexpected_control_failure' $false $script:unexpectedFailure
}finally{
    $script:phase='cleanup.scene_owners'
    foreach($scene in $scenes){Close-Scene $scene}
}
$failed=@($rows|Where-Object {-not $_.passed});$observed=@($rows|ForEach-Object {$_.name})
$pending=@($names|Where-Object {$_ -cnotin $observed})
$complete=$pending.Count -eq 0 -and $rows.Count -eq $names.Count
@{code='startup_wait_exit_controls_v1';moduleSha256=$ModuleSha;probeSha256=$ProbeSha;childImageSha256=$childImageSha;actualNativeCompiled=$true;probeCompiled=$true;
  interfacePassCount=1;interfaceFailCount=0;rows=$rows.ToArray();passCount=$rows.Count-$failed.Count;failCount=$failed.Count;
  expectedBehaviorControls=$names.Count;pendingBehaviorControls=$pending.Count;pendingBehaviorNames=$pending;
  passed=$failed.Count -eq 0 -and $complete;behaviorStatus=$(if($failed.Count -eq 0 -and $complete){'complete'}else{'failed_or_incomplete'});
  unexpectedFailure=$script:unexpectedFailure;actualChildCreated=$script:childCount -gt 0;childCount=$script:childCount;
  actualWaitHelperInvoked=$script:helperCalls -gt 0;helperInvocationCount=$script:helperCalls;actualCaptureFactoryInvoked=$script:captureFactoryInvoked;
  actualReceiveExecuted=$false;productionSessionZeroPolicyExercised=$false;actualScmExercised=$false;actualVirtualServiceCrossSid=$false;
  actualFailureProof=$false;actualRecover=$false;actualGpu=$false;actualProducerSuccess=$false;callerInvalidationDuringWaitExercised=$false;nonAuthorSourceReviewRequired=$true;
  sourceReviewGate=$sourceGate;scope=$scope}|ConvertTo-Json -Depth 12 -Compress
if($failed.Count -gt 0 -or -not $complete){exit 1}
exit 0
