param(
    [Parameter(Mandatory=$true)][string]$ModulePath,
    [Parameter(Mandatory=$true)][string]$ModuleSha,
    [Parameter(Mandatory=$true)][string]$ProbePath,
    [Parameter(Mandatory=$true)][string]$ProbeSha
)
$ErrorActionPreference='Stop'
Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
if($PSVersionTable.PSVersion.Major -ne 5){throw 'fresh_winps5_required'}
if($null -ne ('Zeb.WorkerInstall.Native' -as [type])){throw 'fresh_process_required'}
if((Get-FileHash -LiteralPath $ModulePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ModuleSha){throw 'module_changed'}
if((Get-FileHash -LiteralPath $ProbePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ProbeSha){throw 'probe_changed'}
$tokens=$null;$errors=$null
$moduleAst=[Management.Automation.Language.Parser]::ParseFile($ModulePath,[ref]$tokens,[ref]$errors)
if($errors.Count -ne 0){throw 'module_syntax_invalid'}
$initializers=@($moduleAst.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Initialize-WorkerInstallNative'},$true))
if($initializers.Count -ne 1){throw 'native_initializer_changed'}
$initialize=$initializers[0].Body.GetScriptBlock()
& $initialize
$native='Zeb.WorkerInstall.Native' -as [type]
$pinType=$native.Assembly.GetType('Zeb.WorkerInstall.ProcessPin',$true)
$factory=$native.GetMethod('PinStartupCaller',[type[]]@())
$require=$native.GetMethod('RequireStartupPin',[type[]]@($pinType))
$interfaces=@(
    @{name='fixed_current_caller_factory';passed=($null -ne $factory -and $factory.IsPublic -and $factory.IsStatic -and $factory.ReturnType.FullName -ceq 'Zeb.WorkerInstall.StartupCallerPin')},
    @{name='require_original_process_pin';passed=($null -ne $require -and $require.IsPublic -and $require.IsStatic -and $require.ReturnType -eq [void])}
)
$missing=@($interfaces|Where-Object {-not $_.passed})
if($missing.Count -gt 0){
    @{code='startup_caller_pin_interface_red';moduleSha256=$ModuleSha;interfaceChecks=$interfaces;
      passed=2-$missing.Count;failed=$missing.Count;pendingBehaviorControls=13;
      callerFactoryExecuted=$false;actualChildCreated=$false;scope='actual original Native compiled; missing interface only; no behavior counted pass'}|ConvertTo-Json -Depth 8 -Compress
    exit 1
}
$callerType=$factory.ReturnType
$publicInstance=[Reflection.BindingFlags]::Public -bor [Reflection.BindingFlags]::Instance
if($callerType.GetConstructors($publicInstance).Count -ne 0){throw 'caller_pin_public_constructor_forbidden'}
foreach($entry in @(@{name='Pin';type=$pinType},@{name='ImageSha256';type=[string]})){
    $property=$callerType.GetProperty($entry.name,$publicInstance)
    if($null -eq $property -or $property.PropertyType -ne $entry.type -or $null -ne $property.GetSetMethod($true)){throw 'caller_pin_properties_must_be_read_only'}
}
$dispose=$callerType.GetMethod('Dispose',[type[]]@())
if($null -eq $dispose -or $dispose.ReturnType -ne [void]){throw 'caller_pin_dispose_missing'}
Add-Type -TypeDefinition ([IO.File]::ReadAllText($ProbePath)) -ErrorAction Stop
function Invoke-Require($Pin) {
    $arguments=[object[]]::new(1);$arguments[0]=$Pin
    $null=$require.Invoke($null,$arguments)
}
function Refused-Original($Pin) {
    try {Invoke-Require $Pin;return $false}
    catch {
        $reason=$_.Exception;while($null -ne $reason.InnerException){$reason=$reason.InnerException}
        return $reason.GetType().Name -cin @('InvalidDataException','InvalidOperationException','ObjectDisposedException','Win32Exception')
    }
}
$rows=[Collections.Generic.List[object]]::new()
$caller=$null;$child=$null;$childPin=$null;$originalHandle=$null;$imageHandle=$null;$disposeObserved=$false;$callerFactoryExecuted=$false
try {
    $real=[Zeb.StartupCallerPinProbe.Probe]::Current()
    $independentImage=[Zeb.StartupCallerPinProbe.Probe]::HashImage($real.Image)
    $callerFactoryExecuted=$true
    $caller=$factory.Invoke($null,[object[]]@())
    $pin=$caller.Pin;$originalHandle=$pin.handle
    $borrowed=[Zeb.StartupCallerPinProbe.Probe]::Query($originalHandle)
    $same=$real.Alive -and $borrowed.Alive -and $borrowed.NonInherited -and
        $pin.pid -eq $real.Pid -and $pin.creationFileTime -ceq $real.Creation -and
        [string]::Equals($pin.imagePath,$real.Image,[StringComparison]::OrdinalIgnoreCase) -and
        $pin.tokenUserSid -ceq $real.Sid -and [uint32]$pin.sessionId -eq $real.Session -and
        $borrowed.Pid -eq $real.Pid -and $borrowed.Creation -ceq $real.Creation -and $borrowed.Sid -ceq $real.Sid -and $borrowed.Session -eq $real.Session -and
        [string]::Equals($borrowed.Image,$real.Image,[StringComparison]::OrdinalIgnoreCase)
    $rows.Add(@{name='real_current_caller_identity_noninherit';passed=$same;actualCurrentCaller=$true;actualCurrentSession=$real.Session})
    $streams=@($callerType.GetFields(([Reflection.BindingFlags]::Public -bor [Reflection.BindingFlags]::NonPublic -bor [Reflection.BindingFlags]::Instance))|
        ForEach-Object {$_.GetValue($caller)}|Where-Object {$_ -is [IO.FileStream]})
    $streamAlive=$streams.Count -eq 1 -and $streams[0].CanRead -and $streams[0].CanSeek
    $heldIdentityMatches=$false;$heldBytesMatch=$false;$heldPositionRestored=$false
    if($streamAlive){
        $heldStream=$streams[0];$imageHandle=$heldStream.SafeFileHandle
        $streamAlive=-not $imageHandle.IsClosed -and -not $imageHandle.IsInvalid -and [Zeb.StartupCallerPinProbe.Probe]::NonInherited($imageHandle)
        if($streamAlive){
            $heldPosition=$heldStream.Position
            $heldImage=[Zeb.StartupCallerPinProbe.Probe]::HashStream($heldStream)
            $heldIdentityMatches=$heldImage.FileIdentity -ceq $independentImage.FileIdentity -and $heldImage.Length -eq $independentImage.Length
            $heldBytesMatch=$heldImage.Sha256 -ceq $independentImage.Sha256 -and $heldImage.Sha256 -ceq $caller.ImageSha256
            $heldPositionRestored=$heldStream.Position -eq $heldPosition
        }
    }
    $rows.Add(@{name='system_image_exact_sha_and_retained_stream';passed=($streamAlive -and $heldIdentityMatches -and $heldBytesMatch -and $heldPositionRestored -and $caller.ImageSha256 -is [string] -and $caller.ImageSha256 -cmatch '\A[0-9a-f]{64}\z' -and $caller.ImageSha256 -ceq $independentImage.Sha256);
        actualSystemImageHardLinks=$independentImage.HardLinks;imageStreamRetained=$streamAlive;retainedImageKernelFileIdentityMatched=$heldIdentityMatches;retainedImageBytesMatched=$heldBytesMatch;retainedStreamPositionRestored=$heldPositionRestored;
        hashScope='kernel-image-path file bytes, not mapped process memory'})
    Invoke-Require $pin
    $rows.Add(@{name='same_original_live_handle_accepted';passed=[object]::ReferenceEquals($pin.handle,$originalHandle)})
    $mutations=@(
        @{field='pid';value=$(if($pin.pid -eq [int]::MaxValue){$pin.pid-1}else{$pin.pid+1})},
        @{field='creationFileTime';value=([uint64]::Parse($pin.creationFileTime,[Globalization.CultureInfo]::InvariantCulture)+[uint64]1).ToString([Globalization.CultureInfo]::InvariantCulture)},
        @{field='imagePath';value=($pin.imagePath+'.different.exe')},
        @{field='tokenUserSid';value='S-1-0-0'},
        @{field='sessionId';value=$(if($pin.sessionId -eq 0){1}else{0})}
    )
    foreach($mutation in $mutations){
        $field=$pinType.GetField($mutation.field);$saved=$field.GetValue($pin)
        try {$field.SetValue($pin,$mutation.value);$rejected=Refused-Original $pin}
        finally {$field.SetValue($pin,$saved)}
        $rows.Add(@{name=('original_handle_record_tampered_'+$mutation.field);passed=$rejected})
    }
    foreach($mode in @('inherited','closed')){
        $duplicate=[Zeb.StartupCallerPinProbe.Probe]::Duplicate($originalHandle,($mode -ceq 'inherited'))
        try {
            if($mode -ceq 'closed'){$duplicate.Dispose()}
            $pin.handle=$duplicate
            $rejected=Refused-Original $pin
            $borrowPreserved=$true;$duplicateFactsMatched=$true
            if($mode -ceq 'inherited'){
                $borrowPreserved=[object]::ReferenceEquals($pin.handle,$duplicate) -and -not $duplicate.IsClosed -and -not $duplicate.IsInvalid
                $duplicateFactsMatched=$false
                if($borrowPreserved){
                    $inheritedFacts=[Zeb.StartupCallerPinProbe.Probe]::Query($duplicate)
                    $duplicateFactsMatched=$inheritedFacts.Alive -and -not $inheritedFacts.NonInherited -and $inheritedFacts.Pid -eq $real.Pid -and $inheritedFacts.Creation -ceq $real.Creation -and
                        $inheritedFacts.Sid -ceq $real.Sid -and $inheritedFacts.Session -eq $real.Session -and [string]::Equals($inheritedFacts.Image,$real.Image,[StringComparison]::OrdinalIgnoreCase)
                }
            }
            $rows.Add(@{name=('original_handle_'+$mode+'_refused_without_pid_reopen');passed=($rejected -and $borrowPreserved -and $duplicateFactsMatched);
                inheritedBorrowPreserved=$(if($mode -ceq 'inherited'){$borrowPreserved}else{$null});inheritedOriginalHandleFactsMatched=$(if($mode -ceq 'inherited'){$duplicateFactsMatched}else{$null})})
        }finally {$pin.handle=$originalHandle;$duplicate.Dispose()}
    }
    $child=[Zeb.StartupCallerPinProbe.Probe]::StartChild($real.Image)
    $childPin=[Zeb.WorkerInstall.Native]::Pin($child.Pid,$real.Image)
    Invoke-Require $childPin
    $childOriginal=$childPin.handle
    $liveChildFacts=[Zeb.StartupCallerPinProbe.Probe]::QueryExit($childOriginal)
    $child.StopAndJoin()
    $childRefused=Refused-Original $childPin
    $childBorrowPreserved=[object]::ReferenceEquals($childPin.handle,$childOriginal) -and -not $childOriginal.IsClosed -and -not $childOriginal.IsInvalid
    $childExitMatched=$false
    if($childBorrowPreserved){
        $childExitFacts=[Zeb.StartupCallerPinProbe.Probe]::QueryExit($childOriginal)
        $childExitMatched=$liveChildFacts.Alive -and $liveChildFacts.NonInherited -and $liveChildFacts.Pid -eq $child.Pid -and $liveChildFacts.Creation -ceq $childPin.creationFileTime -and
            -not $childExitFacts.Alive -and $childExitFacts.NonInherited -and $childExitFacts.WaitState -eq 0 -and $childExitFacts.ExitCode -eq 0 -and $childExitFacts.ExitFileTime -cne '0' -and
            $childExitFacts.Pid -eq $liveChildFacts.Pid -and $childExitFacts.Creation -ceq $liveChildFacts.Creation
    }
    $rows.Add(@{name='real_child_exit_refused_on_original_handle';passed=($childRefused -and $childBorrowPreserved -and $childExitMatched -and -not $child.GuardianUsed);
        actualChildSource='real WinPS5 stdin-gated child';exitedChildBorrowPreserved=$childBorrowPreserved;originalHandleExitFactsMatched=$childExitMatched;exitProbeReopenedPid=$false})
    if($independentImage.HardLinks -gt 1){
        $stillStrict=$false
        try {$null=[Zeb.WorkerInstall.Native]::Hash($real.Image)}
        catch {$reason=$_.Exception;while($null -ne $reason.InnerException){$reason=$reason.InnerException};$stillStrict=$reason -is [IO.InvalidDataException] -and $reason.Message -ceq 'worker_path_invalid'}
        $rows.Add(@{name='owned_hash_policy_kept_for_hardlinked_image';passed=$stillStrict;skipped=$false;actualHardLinks=$independentImage.HardLinks})
    }else{
        $rows.Add(@{name='owned_hash_policy_kept_for_hardlinked_image';passed=$null;skipped=$true;reason='this real system image has one hardlink; no synthetic production image substituted'})
    }
    $caller.Dispose();$caller.Dispose();$disposeObserved=$true
    $rows.Add(@{name='caller_dispose_idempotent_and_original_handles_closed';passed=($originalHandle.IsClosed -and $null -ne $imageHandle -and $imageHandle.IsClosed -and (Refused-Original $pin))})
} catch {
    $reason=$_.Exception;while($null -ne $reason.InnerException){$reason=$reason.InnerException}
    $rows.Add(@{name='unexpected_control_failure';passed=$false;failureType=$reason.GetType().Name})
} finally {
    if($null -ne $childPin -and $null -ne $childPin.handle){$childPin.handle.Dispose()}
    if($null -ne $child){try {$child.Dispose()}catch {$rows.Add(@{name='child_cleanup_failed';passed=$false;failureType=$_.Exception.GetType().Name})}}
    if($null -ne $caller){try {$caller.Dispose()}catch {$rows.Add(@{name='caller_cleanup_failed';passed=$false;failureType=$_.Exception.GetType().Name})}}
}
$failed=@($rows|Where-Object {$_.passed -eq $false -and -not $_.skipped})
$skipped=@($rows|Where-Object {$_.skipped})
@{code='startup_caller_pin_controls_v3';moduleSha256=$ModuleSha;probeSha256=$ProbeSha;interfaceChecks=$interfaces;
  rows=$rows.ToArray();passCount=$rows.Count-$failed.Count-$skipped.Count;failCount=$failed.Count;skipCount=$skipped.Count;passed=($failed.Count -eq 0 -and $rows.Count -eq 13);
  callerFactoryExecuted=$callerFactoryExecuted;callerDisposeControlReached=$disposeObserved;productionSessionZeroPolicyExercised=$false;actualVirtualServiceCrossSid=$false;actualScmExercised=$false;
  scope='real current caller and real exited child; borrowed original kernel handle integrity/SHA/lifetime only; no service principal/session simulation, pipe, ACK or SCM';
  ownership='PS capture must retain CallerPin and separate Host/Node handles until Unknown receipt is written; Require borrows and must not close/reopen original handles'}|ConvertTo-Json -Depth 10 -Compress
if($failed.Count -gt 0 -or $rows.Count -ne 13){exit 1}
exit 0
