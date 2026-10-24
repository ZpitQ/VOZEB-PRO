param(
    [Parameter(Mandatory=$true)][string]$ModulePath,
    [Parameter(Mandatory=$true)][string]$ModuleSha,
    [Parameter(Mandatory=$true)][string]$ProbePath,
    [Parameter(Mandatory=$true)][string]$ProbeSha
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
if($PSVersionTable.PSVersion.Major -ne 5){throw 'fresh_winps5_required'}
if($null -ne ('Zeb.WorkerInstall.Native' -as [type]) -or $null -ne ('Zeb.StartupExitCodeProbe.Probe' -as [type])){throw 'fresh_native_and_probe_process_required'}
$ModulePath=[IO.Path]::GetFullPath($ModulePath);$ProbePath=[IO.Path]::GetFullPath($ProbePath)
if((Get-FileHash -LiteralPath $ModulePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ModuleSha.ToLowerInvariant()){throw 'module_changed'}
if((Get-FileHash -LiteralPath $ProbePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ProbeSha.ToLowerInvariant()){throw 'probe_changed'}
$tokens=$null;$errors=$null
$moduleAst=[Management.Automation.Language.Parser]::ParseFile($ModulePath,[ref]$tokens,[ref]$errors)
if($errors.Count -ne 0){throw 'module_syntax_invalid'}
$initializers=@($moduleAst.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Initialize-WorkerInstallNative'},$true))
if($initializers.Count -ne 1){throw 'native_initializer_changed'}
& ($initializers[0].Body.GetScriptBlock())
$native='Zeb.WorkerInstall.Native' -as [type]
if($null -eq $native){throw 'actual_native_compile_missing'}
$pinType=$native.Assembly.GetType('Zeb.WorkerInstall.ProcessPin',$true)
$flags=[Reflection.BindingFlags]::Public -bor [Reflection.BindingFlags]::Static
$named=@($native.GetMethods($flags)|Where-Object {$_.Name -ceq 'ReadStartupExitCode'})
$read=$null
if($named.Count -eq 1){
    $candidate=$named[0];$parameters=@($candidate.GetParameters())
    if($candidate.ReturnType -eq [uint32] -and $parameters.Count -eq 1 -and $parameters[0].ParameterType -eq $pinType -and
        -not $parameters[0].IsOptional -and -not $candidate.IsGenericMethod){$read=$candidate}
}
$interfaces=@(@{name='fixed_original_pin_exit_code_uint';passed=($null -ne $read);signature='public static uint ReadStartupExitCode(ProcessPin pin)'})
$behaviorNames=@(
    'live_original_handle_refused_and_preserved',
    'real_stdin_gated_child_exit_0_exact_uint_and_original_borrow',
    'real_stdin_gated_child_exit_2_exact_uint_and_original_borrow',
    'repeated_successful_reads_leave_same_original_handle_open',
    'null_pin_refused',
    'null_handle_refused_without_pid_reopen',
    'invalid_handle_refused_without_pid_reopen',
    'closed_handle_refused_without_pid_reopen',
    'inherited_handle_refused_without_closing_borrow',
    'exited_original_record_tampered_pid',
    'exited_original_record_tampered_creationFileTime',
    'exited_original_record_tampered_imagePath',
    'foreign_original_handle_refused_instead_of_record_pid_reopen',
    'raw_parameterless_pin_with_correct_public_records_and_same_handle_refused'
)
$expectedControls=$behaviorNames.Count
if($null -eq $read){
    @{code='startup_exit_code_interface_red';moduleSha256=$ModuleSha;probeSha256=$ProbeSha;actualNativeCompiled=$true;interfaceChecks=$interfaces;
      interfacePassCount=0;interfaceFailCount=1;behaviorStatus='pending';behaviorPassCount=0;behaviorFailCount=0;pendingBehaviorControls=$expectedControls;pendingBehaviorNames=$behaviorNames;
      probeCompiled=$false;actualChildCreated=$false;actualExitCodeReadInvoked=$false;actualDynamicHandleMutationExercised=$false;
      sourceReviewRequired='snapshot original SafeHandle; recheck same handle reference before successful return; no PID reopen, token reopen or borrowed-handle Dispose';
      actualScmExercised=$false;actualVirtualServiceCrossSid=$false;productionSessionZeroPolicyExercised=$false;
      scope='fresh original Native compile then exact missing-interface RED only; no behavior counted pass'}|ConvertTo-Json -Depth 8 -Compress
    exit 1
}
$pin=$native.GetMethod('Pin',[type[]]@([int],[string]))
$require=$native.GetMethod('RequireStartupPin',[type[]]@($pinType))
if($null -eq $pin -or $pin.ReturnType -ne $pinType -or $null -eq $require -or $require.ReturnType -ne [void]){throw 'existing_pin_require_prerequisite_missing'}
Add-Type -TypeDefinition ([IO.File]::ReadAllText($ProbePath)) -ErrorAction Stop
$script:readCallCount=0
$script:controlPhase='behavior.setup'
$script:unexpectedFailure=$null
function Set-ControlPhase([string]$Phase){$script:controlPhase=$Phase}
function Failure-Diagnostic($Exception){
    $reason=$Exception;$failureProbePhase=$null;$nativeErrorCode=$null
    while($null -ne $reason){
        if($null -eq $failureProbePhase -and $reason.Data.Contains('startupExitProbePhase')){$failureProbePhase=[string]$reason.Data['startupExitProbePhase']}
        if($reason -is [ComponentModel.Win32Exception]){$nativeErrorCode=$reason.NativeErrorCode}
        if($null -eq $reason.InnerException){break}
        $reason=$reason.InnerException
    }
    return @{controlPhase=$script:controlPhase;failureType=$reason.GetType().Name;failureTypeFullName=$reason.GetType().FullName;nativeErrorCode=$nativeErrorCode;
        failureProbePhase=$failureProbePhase;probePhaseAtCatch=[Zeb.StartupExitCodeProbe.Probe]::Phase;probeLastCompletedAtCatch=[Zeb.StartupExitCodeProbe.Probe]::LastCompletedPhase;
        nativeReadInvocationCountAtFailure=$script:readCallCount}
}
function Invoke-ExitRead($PinValue){
    $arguments=[object[]]::new(1);$arguments[0]=$PinValue
    $script:readCallCount++
    return $read.Invoke($null,$arguments)
}
function Refused-ExitRead($PinValue){
    try {$null=Invoke-ExitRead $PinValue;return $false}
    catch {
        $reason=$_.Exception;while($null -ne $reason.InnerException){$reason=$reason.InnerException}
        return $reason.GetType().Name -cin @('InvalidDataException','InvalidOperationException','ObjectDisposedException','Win32Exception')
    }
}
function Same-ExitFacts($Before,$After){
    return $Before.Pid -eq $After.Pid -and $Before.Creation -ceq $After.Creation -and
        $Before.ExitFileTime -ceq $After.ExitFileTime -and $Before.WaitState -eq $After.WaitState -and $Before.ExitCode -eq $After.ExitCode -and
        $Before.HandleValue -eq $After.HandleValue -and $Before.NonInherited -eq $After.NonInherited -and $Before.Alive -eq $After.Alive
}
function Borrow-Preserved($PinValue,$Handle,$Before){
    if(-not [object]::ReferenceEquals($PinValue.handle,$Handle) -or $Handle.IsClosed -or $Handle.IsInvalid){return $false}
    return Same-ExitFacts $Before ([Zeb.StartupExitCodeProbe.Probe]::QueryExit($Handle))
}
$rows=[Collections.Generic.List[object]]::new()
$children=[Collections.Generic.List[object]]::new()
$ownedPins=[Collections.Generic.List[object]]::new()
$observed=[Collections.Generic.List[object]]::new()
$actualChildCreated=$false
try {
    Set-ControlPhase 'caller.current_image'
    $actualImage=[Diagnostics.Process]::GetCurrentProcess()
    try {$currentImage=$actualImage.MainModule.FileName}finally {$actualImage.Dispose()}
    foreach($expectedExit in @(0,2)){
        $label='exit'+$expectedExit
        Set-ControlPhase ($label+'.child.start')
        $child=[Zeb.StartupExitCodeProbe.Probe]::StartChild($currentImage,$expectedExit)
        $actualChildCreated=$true;$children.Add($child)
        $arguments=[object[]]@([int]$child.Pid,[string]$currentImage)
        Set-ControlPhase ($label+'.native.Pin')
        $childPin=$pin.Invoke($null,$arguments);$ownedPins.Add($childPin)
        $original=$childPin.handle
        $requireArguments=[object[]]::new(1);$requireArguments[0]=$childPin
        Set-ControlPhase ($label+'.native.RequireStartupPin.live')
        $null=$require.Invoke($null,$requireArguments)
        Set-ControlPhase ($label+'.probe.QueryLive')
        $liveEvidence=[Zeb.StartupExitCodeProbe.Probe]::QueryLive($original)
        $before=$liveEvidence.Process
        $bound=$before.Alive -and $before.NonInherited -and $before.WaitState -eq 258 -and $before.ExitCode -eq 259 -and
            $before.Pid -eq $child.Pid -and $before.Pid -eq $childPin.pid -and $before.Creation -ceq $childPin.creationFileTime -and
            [string]::Equals($liveEvidence.KernelImage,$childPin.imagePath,[StringComparison]::OrdinalIgnoreCase)
        if($expectedExit -eq 0){
            Set-ControlPhase ($label+'.native.ReadStartupExitCode.live_refusal')
            $refused=Refused-ExitRead $childPin
            Set-ControlPhase ($label+'.probe.verify_live_borrow')
            $preserved=Borrow-Preserved $childPin $original $before
            $rows.Add(@{name='live_original_handle_refused_and_preserved';passed=($bound -and $refused -and $preserved);
                priorRealRequireStartupPin=$true;originalBorrowPreserved=$preserved;independentOriginalFactsMatched=$preserved})
        }
        Set-ControlPhase ($label+'.child.ReleaseAndJoin')
        $child.ReleaseAndJoin()
        Set-ControlPhase ($label+'.probe.QueryExit.exited')
        $exited=[Zeb.StartupExitCodeProbe.Probe]::QueryExit($original)
        $exitBound=$bound -and -not $exited.Alive -and $exited.NonInherited -and $exited.WaitState -eq 0 -and
            $exited.ExitCode -eq $expectedExit -and $exited.ExitFileTime -cne '0' -and $exited.Pid -eq $before.Pid -and
            $exited.Creation -ceq $before.Creation -and $exited.HandleValue -eq $before.HandleValue
        Set-ControlPhase ($label+'.native.ReadStartupExitCode.exited')
        $actual=Invoke-ExitRead $childPin
        Set-ControlPhase ($label+'.probe.verify_exited_borrow')
        $preserved=Borrow-Preserved $childPin $original $exited
        $rows.Add(@{name=('real_stdin_gated_child_exit_'+$expectedExit+'_exact_uint_and_original_borrow');passed=($exitBound -and $actual -is [uint32] -and $actual -eq $expectedExit -and $preserved -and -not $child.GuardianUsed);
            expectedExitCode=$expectedExit;actualExitCode=$actual;actualChildSession=$childPin.sessionId;priorRealRequireStartupPin=$true;
            originalBorrowPreserved=$preserved;independentOriginalExitFactsMatched=$exitBound;guardianUsed=$child.GuardianUsed;exitProbeReopenedPid=$false;
            independentImageEvidenceSource='same original handle kernel image queried while live';independentExitKernelImageQueried=$false;
            retainedLiveImageBindingMatched=$bound})
        $observed.Add(@{pin=$childPin;handle=$original;facts=$exited;session=$childPin.sessionId;liveKernelImage=$liveEvidence.KernelImage;liveFacts=$before})
    }
    $zero=$observed[0];$two=$observed[1];$zeroPin=$zero.pin;$original=$zero.handle;$facts=$zero.facts
    Set-ControlPhase 'repeat.native.ReadStartupExitCode.first'
    $first=Invoke-ExitRead $zeroPin
    Set-ControlPhase 'repeat.native.ReadStartupExitCode.second'
    $second=Invoke-ExitRead $zeroPin
    Set-ControlPhase 'repeat.probe.verify_borrow'
    $preserved=Borrow-Preserved $zeroPin $original $facts
    $rows.Add(@{name='repeated_successful_reads_leave_same_original_handle_open';passed=($first -is [uint32] -and $second -is [uint32] -and $first -eq 0 -and $second -eq 0 -and $preserved);originalBorrowPreserved=$preserved})

    Set-ControlPhase 'null_pin.native.refusal'
    $refused=Refused-ExitRead $null
    $rows.Add(@{name='null_pin_refused';passed=($refused -and (Borrow-Preserved $zeroPin $original $facts))})
    try {
        Set-ControlPhase 'null_handle.native.refusal'
        $zeroPin.handle=$null;$refused=Refused-ExitRead $zeroPin
        $unchanged=$null -eq $zeroPin.handle
    }finally {$zeroPin.handle=$original}
    $rows.Add(@{name='null_handle_refused_without_pid_reopen';passed=($refused -and $unchanged -and (Borrow-Preserved $zeroPin $original $facts))})

    Set-ControlPhase 'invalid_handle.prepare'
    $invalid=[Microsoft.Win32.SafeHandles.SafeProcessHandle]::new([IntPtr]::Zero,$false)
    try {
        Set-ControlPhase 'invalid_handle.native.refusal'
        $zeroPin.handle=$invalid;$refused=Refused-ExitRead $zeroPin
        $unchanged=[object]::ReferenceEquals($zeroPin.handle,$invalid) -and $invalid.IsInvalid -and -not $invalid.IsClosed
    }finally {$zeroPin.handle=$original;$invalid.Dispose()}
    $rows.Add(@{name='invalid_handle_refused_without_pid_reopen';passed=($refused -and $unchanged -and (Borrow-Preserved $zeroPin $original $facts))})

    Set-ControlPhase 'closed_handle.probe.Duplicate'
    $closed=[Zeb.StartupExitCodeProbe.Probe]::Duplicate($original,$false)
    try {
        Set-ControlPhase 'closed_handle.native.refusal'
        $closed.Dispose();$zeroPin.handle=$closed;$refused=Refused-ExitRead $zeroPin
        $unchanged=[object]::ReferenceEquals($zeroPin.handle,$closed) -and $closed.IsClosed
    }finally {$zeroPin.handle=$original;$closed.Dispose()}
    $rows.Add(@{name='closed_handle_refused_without_pid_reopen';passed=($refused -and $unchanged -and (Borrow-Preserved $zeroPin $original $facts))})

    Set-ControlPhase 'inherited_handle.probe.Duplicate'
    $inherited=[Zeb.StartupExitCodeProbe.Probe]::Duplicate($original,$true)
    try {
        Set-ControlPhase 'inherited_handle.probe.QueryExit'
        $zeroPin.handle=$inherited;$inheritedBefore=[Zeb.StartupExitCodeProbe.Probe]::QueryExit($inherited)
        Set-ControlPhase 'inherited_handle.native.refusal'
        $refused=Refused-ExitRead $zeroPin
        Set-ControlPhase 'inherited_handle.probe.verify_borrow'
        $inheritedPreserved=Borrow-Preserved $zeroPin $inherited $inheritedBefore
        $inheritedMatched=-not $inheritedBefore.NonInherited -and -not $inheritedBefore.Alive -and $inheritedBefore.WaitState -eq 0 -and
            $inheritedBefore.Pid -eq $facts.Pid -and $inheritedBefore.Creation -ceq $facts.Creation -and $inheritedBefore.ExitCode -eq 0
    }finally {$zeroPin.handle=$original;$inherited.Dispose()}
    $rows.Add(@{name='inherited_handle_refused_without_closing_borrow';passed=($refused -and $inheritedPreserved -and $inheritedMatched -and (Borrow-Preserved $zeroPin $original $facts));
        inheritedBorrowPreserved=$inheritedPreserved;independentInheritedExitFactsMatched=$inheritedMatched})

    foreach($mutation in @(
        @{field='pid';value=$(if($zeroPin.pid -eq [int]::MaxValue){$zeroPin.pid-1}else{$zeroPin.pid+1})},
        @{field='creationFileTime';value=([uint64]::Parse($zeroPin.creationFileTime,[Globalization.CultureInfo]::InvariantCulture)+[uint64]1).ToString([Globalization.CultureInfo]::InvariantCulture)},
        @{field='imagePath';value=($zeroPin.imagePath+'.different.exe')}
    )){
        Set-ControlPhase ('record.'+$mutation.field+'.prepare')
        $field=$pinType.GetField($mutation.field);$saved=$field.GetValue($zeroPin)
        try {
            Set-ControlPhase ('record.'+$mutation.field+'.native.refusal')
            $field.SetValue($zeroPin,$mutation.value);$refused=Refused-ExitRead $zeroPin
            $recordUnchanged=$field.GetValue($zeroPin) -ceq $mutation.value
            Set-ControlPhase ('record.'+$mutation.field+'.probe.verify_borrow')
            $preserved=Borrow-Preserved $zeroPin $original $facts
        }finally {$field.SetValue($zeroPin,$saved)}
        $rows.Add(@{name=('exited_original_record_tampered_'+$mutation.field);passed=($refused -and $recordUnchanged -and $preserved);
            originalBorrowPreserved=$preserved;independentOriginalExitFactsMatched=$preserved})
    }
    try {
        Set-ControlPhase 'foreign_handle.native.refusal'
        $zeroPin.handle=$two.handle;$refused=Refused-ExitRead $zeroPin
        Set-ControlPhase 'foreign_handle.probe.verify_borrow'
        $twoPreserved=Borrow-Preserved $zeroPin $two.handle $two.facts
    }finally {$zeroPin.handle=$original}
    $zeroPreserved=Borrow-Preserved $zeroPin $original $facts
    $rows.Add(@{name='foreign_original_handle_refused_instead_of_record_pid_reopen';passed=($refused -and $twoPreserved -and $zeroPreserved -and $facts.Pid -ne $two.facts.Pid);
        bothBorrowedOriginalHandlesPreserved=($twoPreserved -and $zeroPreserved);dynamicDuringCallHandleMutation=$false})

    Set-ControlPhase 'unbound_pin.public_parameterless_prepare'
    $rawConstructor=$pinType.GetConstructor([type[]]@())
    if($null -eq $rawConstructor){throw 'public_parameterless_process_pin_compatibility_missing'}
    $raw=$rawConstructor.Invoke([object[]]@())
    $publicFields=@('pid','sessionId','creationFileTime','imagePath','tokenUserSid','handle')
    foreach($name in $publicFields){
        $field=$pinType.GetField($name)
        $field.SetValue($raw,$field.GetValue($zeroPin))
    }
    $copiedExactly=-not [object]::ReferenceEquals($raw,$zeroPin) -and [object]::ReferenceEquals($raw.handle,$original)
    foreach($name in $publicFields){
        $field=$pinType.GetField($name)
        if($field.GetValue($raw) -cne $field.GetValue($zeroPin)){$copiedExactly=$false}
    }
    try {
        Set-ControlPhase 'unbound_pin.native.ReadStartupExitCode.refusal'
        $rawRefused=Refused-ExitRead $raw
        Set-ControlPhase 'unbound_pin.probe.verify_borrow'
        $rawBorrowPreserved=Borrow-Preserved $raw $original $facts
        $ownerBorrowPreserved=Borrow-Preserved $zeroPin $original $facts
        $recordsPreserved=$true
        foreach($name in $publicFields){
            $field=$pinType.GetField($name)
            if($field.GetValue($raw) -cne $field.GetValue($zeroPin)){$recordsPreserved=$false}
        }
        $rows.Add(@{name='raw_parameterless_pin_with_correct_public_records_and_same_handle_refused';
            passed=($copiedExactly -and $rawRefused -and $rawBorrowPreserved -and $ownerBorrowPreserved -and $recordsPreserved);
            actualSeparateParameterlessObject=$true;allPublicRecordsAndSameHandleCopiedExactly=$copiedExactly;
            borrowedOriginalHandlePreserved=($rawBorrowPreserved -and $ownerBorrowPreserved);publicRecordsPreserved=$recordsPreserved;
            productionInternalBindingsCopied=$false;owner='original real Native.Pin remains sole handle owner'})
    }finally {$raw.handle=$null}
} catch {
    $script:unexpectedFailure=Failure-Diagnostic $_.Exception
    $rows.Add(@{name='unexpected_control_failure';passed=$false;failureType=$script:unexpectedFailure.failureType;diagnostic=$script:unexpectedFailure})
} finally {
    foreach($owned in $ownedPins){
        Set-ControlPhase 'cleanup.owned_pin.Dispose'
        try {if($null -ne $owned.handle){$owned.handle.Dispose()}}
        catch {$rows.Add(@{name='owned_pin_cleanup_failed';passed=$false;diagnostic=(Failure-Diagnostic $_.Exception)})}
    }
    foreach($child in $children){
        Set-ControlPhase 'cleanup.owned_child.Dispose'
        try {$child.Dispose()}
        catch {$rows.Add(@{name='owned_child_cleanup_failed';passed=$false;diagnostic=(Failure-Diagnostic $_.Exception)})}
    }
}
$failed=@($rows|Where-Object {-not $_.passed})
$observedNames=@($rows|ForEach-Object {$_.name})
$pending=@($behaviorNames|Where-Object {$_ -cnotin $observedNames})
$complete=$pending.Count -eq 0 -and $rows.Count -eq $expectedControls
@{code='startup_exit_code_controls_v3';moduleSha256=$ModuleSha;probeSha256=$ProbeSha;actualNativeCompiled=$true;interfaceChecks=$interfaces;
  liveImageSeparatedFromExitFacts=$true;independentExitKernelImageQueried=$false;unexpectedFailure=$script:unexpectedFailure;
  interfacePassCount=1;interfaceFailCount=0;rows=$rows.ToArray();passCount=$rows.Count-$failed.Count;failCount=$failed.Count;pendingBehaviorControls=$pending.Count;pendingBehaviorNames=$pending;
  passed=($failed.Count -eq 0 -and $complete);behaviorStatus=$(if($failed.Count -eq 0 -and $complete){'complete'}else{'failed_or_incomplete'});expectedBehaviorControls=$expectedControls;probeCompiled=$true;
  actualChildCreated=$actualChildCreated;actualExitCodeReadInvoked=$script:readCallCount -gt 0;nativeReadInvocationCount=$script:readCallCount;
  actualDynamicHandleMutationExercised=$false;nonAuthorSourceReviewRequired=$true;
  sourceReviewGate='only live Native.Pin binds readonly original handle and actual kernel image; raw public records cannot supply binding; exit reads kernel PID/creation/signaled/code from same local original handle, compares image to immutable live binding, rechecks current handle reference before return; no exited image query, PID/token reopen or borrowed-handle Dispose';
  productionSessionZeroPolicyExercised=$false;actualVirtualServiceCrossSid=$false;actualScmExercised=$false;actualFailureProof=$false;actualRecover=$false;actualGpu=$false;
  scope='14 deterministic original-handle behaviors; kernel image captured while live, exit kernel facts queried separately, raw parameterless public records refused; current-session children only; immutable origin and dynamic handle-change contracts retain separate non-author source review'}|ConvertTo-Json -Depth 10 -Compress
if($failed.Count -gt 0 -or -not $complete){exit 1}
exit 0
