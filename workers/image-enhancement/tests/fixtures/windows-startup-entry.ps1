param(
    [Parameter(Mandatory=$true)][string]$ModulePath,
    [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ModuleSha,
    [Parameter(Mandatory=$true)][string]$OutputPath
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
if($PSVersionTable.PSVersion.Major -ne 5){throw 'actual_windows_powershell_5_required'}
if((Get-FileHash -LiteralPath $ModulePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ModuleSha.ToLowerInvariant()){throw 'module_preimage_changed'}
if(Test-Path -LiteralPath $OutputPath){throw 'output_already_exists'}
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($ModulePath,[ref]$tokens,[ref]$errors)
if($errors.Count -ne 0){throw 'module_parser_failed'}
$allFunctions=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$true))
function Source-Function([string]$Name){
    $found=@($allFunctions|Where-Object {$_.Name -ceq $Name})
    if($found.Count -ne 1){throw ('source_function_not_unique:'+ $Name)}
    return $found[0]
}
$start=Source-Function 'Start-WorkerOwnedService'
$install=Source-Function 'Invoke-WorkerInstallation'
$outerTries=@($install.Body.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]})
if($outerTries.Count -ne 1 -or $outerTries[0].CatchClauses.Count -ne 1 -or $null -eq $outerTries[0].Finally){throw 'original_operation_owner_shape_changed'}
$outer=$outerTries[0]
$sites=@($outer.Body.FindAll({param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -ceq 'Start-WorkerOwnedService'},$true)|Sort-Object {$_.Extent.StartOffset})
if($sites.Count -ne 4){throw 'original_four_start_calls_changed'}
$siteNames=@('fresh_install','retained_install','upgrade','rollback')
$initial=(@($install.Body.EndBlock.Statements|Where-Object {$_.Extent.StartOffset -lt $outer.Extent.StartOffset})|ForEach-Object {$_.Extent.Text}) -join "`n"
$tail=@($outer.Body.Statements|Select-Object -Last 3)
if($tail.Count -ne 3 -or $tail[0].Extent.Text -notmatch 'Get-WorkerRemainingMilliseconds' -or
    $tail[1].Extent.Text -notmatch 'Get-WorkerPublicResult' -or $tail[2] -isnot [Management.Automation.Language.ReturnStatementAst]){throw 'original_success_tail_changed'}
$tailText=($tail|ForEach-Object {$_.Extent.Text}) -join "`n"
$rows=[Collections.Generic.List[object]]::new()
$missing=[Collections.Generic.List[string]]::new()
foreach($contract in @(
    @{name='New-WorkerStartupObservation';parameters=@('Receipt','ReceiptPath','Deadline')},
    @{name='Receive-WorkerStartupObservation';parameters=@('Capture','Receipt','Deadline')},
    @{name='Write-WorkerStartupDiagnostic';parameters=@('Capture','Receipt')}
)){
    $found=@($allFunctions|Where-Object {$_.Name -ceq $contract.name})
    $actual=@();$valid=$false
    if($found.Count -eq 1){
        $actual=@($found[0].Body.ParamBlock.Parameters|ForEach-Object {$_.Name.VariablePath.UserPath})
        $valid=($actual -join ',') -ceq ($contract.parameters -join ',')
    }
    if(-not $valid){$missing.Add($contract.name)}
    $rows.Add(@{name=('fixed_interface:'+ $contract.name);passed=$valid;actualParameters=$actual;scope='source interface only; no producer/collector invoked'})
}
$captureParameters=@($start.Body.ParamBlock.Parameters|Where-Object {$_.Name.VariablePath.UserPath -ceq 'StartupCapture'})
$captureRef=$captureParameters.Count -eq 1 -and @($captureParameters[0].Attributes|Where-Object {
    $_ -is [Management.Automation.Language.TypeConstraintAst] -and $_.TypeName.FullName -ieq 'ref'
}).Count -eq 1
if(-not $captureRef){$missing.Add('Start-WorkerOwnedService([ref]StartupCapture)')}
$rows.Add(@{name='start_operation_capture_ref_interface';passed=$captureRef;scope='source parameter only'})
$allWired=$true
for($index=0;$index -lt 4;$index++){
    $elements=@($sites[$index].CommandElements);$binding=$null
    for($part=1;$part -lt $elements.Count;$part++){
        if($elements[$part] -is [Management.Automation.Language.CommandParameterAst] -and $elements[$part].ParameterName -ceq 'StartupCapture'){
            $binding=$elements[$part].Argument
            if($null -eq $binding -and $part+1 -lt $elements.Count){$binding=$elements[$part+1]}
        }
    }
    $refs=@()
    if($null -ne $binding){$refs=@($binding.FindAll({param($node)
        $node -is [Management.Automation.Language.ConvertExpressionAst] -and $node.Type.TypeName.FullName -ieq 'ref' -and
        $node.Child -is [Management.Automation.Language.VariableExpressionAst] -and $node.Child.VariablePath.UserPath -ceq 'startupCapture'
    },$true))}
    $good=$refs.Count -eq 1;$allWired=$allWired -and $good
    $rows.Add(@{name=('actual_callsite_ref:'+ $siteNames[$index]);passed=$good;line=$sites[$index].Extent.StartLineNumber;
        source=$sites[$index].Extent.Text;scope='actual original CommandAst; common operation-local ref only'})
}

# Load exact original complete functions; never import or execute module top-level or the installer body.
foreach($name in @('Save-WorkerStage','Get-WorkerPublicResult','Get-WorkerRemainingMilliseconds','Start-WorkerOwnedService')){
    . ([scriptblock]::Create((Source-Function $name).Extent.Text))
}
$script:WorkerUnresolvedProcessIdentity=$null
$script:ObservedSliceRuns=0
function Event([string]$Value){$script:Events.Add($Value)}
function Disposable([string]$Tag){
    $value=[pscustomobject]@{Tag=$Tag}
    $value|Add-Member -MemberType ScriptMethod -Name Dispose -Value {Event ($this.Tag+':dispose')}
    return $value
}
function Reset-Technical([string]$Mode){
    $script:Mode=$Mode;$script:Events=[Collections.Generic.List[string]]::new();$script:Capture=$null
    $script:Capability=$Mode -cnotin @('legacy_unbound','legacy_bound')
    $script:UnknownAlive=@();$script:StartArgumentCounts=@();$script:ScmStarted=$false
    $script:ScmFailure=$null;$script:ArchivedFailure=$null
    $script:Sid='S-1-5-12'
    $script:TestReceipt=[pscustomobject]@{installationId='00000000-0000-4000-8000-000000000001';
        serviceId='00000000-0000-4000-8000-000000000002';clientId='00000000-0000-4000-8000-000000000003';
        state='pending';tokenUserSid=$script:Sid;sessionId=0;programRoot='C:\TechnicalNoFiles\program';dataRoot='C:\TechnicalNoFiles\data';
        configSha256=('a'*64);active=[pscustomobject]@{version='technical-v1';inventorySha256=('b'*64);imagePath='"C:\TechnicalNoFiles\program\technical-v1\WindowsServiceHost.exe"'};
        previous=$null;operation=[pscustomobject]@{operationId='00000000-0000-4000-8000-000000000004';action='Install';stage='prepared';outcome='pending'}}
    $script:TestDeadline=[DateTime]::UtcNow.AddSeconds(10)
}
function Write-WorkerLedger($Path,$Value){
    Event ('ledger:'+ $Value.operation.stage+':'+$Value.operation.outcome)
    if($Value.state -ceq 'unknown'){
        $alive=$null -ne $script:Capture -and -not $script:Capture.Disposed
        $script:UnknownAlive+=,[bool]$alive
    }
}
function New-WorkerStartupObservation($Receipt,[string]$ReceiptPath,[DateTime]$Deadline){
    Event 'prepare'
    if($Receipt.operation.stage -cne 'started' -or $Receipt.operation.outcome -cne 'pending'){throw 'technical_prepare_before_starting_receipt'}
    if(-not $script:Capability){throw 'technical_legacy_must_not_prepare'}
    $script:Capture=[pscustomobject]@{Disposed=$false;DisposeCalls=0;RawFrames=@('technical-only-not-real-wire');
        HostPin=[pscustomobject]@{pid=101;creationFileTime='100'};NodePin=[pscustomobject]@{pid=202;creationFileTime='200'};
        ExpectedServiceSid=$script:Sid;Stage='technical';Failure=$null;FailureType=$null;FailureStage=$null;
        IntentPath='technical:intent';IntentSha256=('c'*64);
        StartArguments=[string[]]@('zeb-startup-observe-v1','eyJ0ZWNobmljYWwiOnRydWV9')}
    $script:Capture|Add-Member -MemberType ScriptMethod -Name Dispose -Value {
        $this.DisposeCalls++;Event 'capture:dispose';$this.Disposed=$true
        if($this.DisposeCalls -ne 1){throw 'technical_capture_disposed_twice'}
    }
    return $script:Capture
}
# This fixture executes original Start/catch/finally bodies with method sinks; no intent file or native window is exercised.
function Assert-WorkerStartupIntent($Capture,$Receipt,$ReceiptPath){
    Event 'intent:assert'
    if(-not [object]::ReferenceEquals($Capture,$script:Capture) -or $Capture.Disposed -or
        $Capture.IntentPath -cne 'technical:intent' -or $Capture.IntentSha256 -cne ('c'*64) -or
        -not [object]::ReferenceEquals($Receipt,$script:TestReceipt) -or $ReceiptPath -cne 'technical:receipt' -or
        $Receipt.operation.stage -cne 'started' -or $Receipt.operation.outcome -cne 'pending'){throw 'technical_intent_wrong_owner_or_order'}
}
function Assert-WorkerStartupWindow($Capture,[DateTime]$Deadline){
    Event 'window:assert'
    if(-not [object]::ReferenceEquals($Capture,$script:Capture) -or $Capture.Disposed -or
        $Deadline.Ticks -ne $script:TestDeadline.Ticks -or [DateTime]::UtcNow -ge $Deadline){throw 'technical_window_wrong_owner_or_deadline'}
}
function Receive-WorkerStartupObservation($Capture,$Receipt,[DateTime]$Deadline){
    Event 'collect'
    if(-not [object]::ReferenceEquals($Capture,$script:Capture) -or $Capture.Disposed -or -not $script:ScmStarted){throw 'technical_collect_wrong_owner_or_order'}
    if($script:Mode -cin @('collect_failure','archive_failure')){throw 'worker_startup_observation_unknown'}
    return [pscustomobject]@{kind=$(if($script:Mode -ceq 'settled'){'settled'}else{'ready'})}
}
function Write-WorkerStartupDiagnostic($Capture,$Receipt){
    Event 'diagnostic:save'
    if(-not [object]::ReferenceEquals($Capture,$script:Capture) -or $Capture.Disposed){throw 'technical_diagnostic_wrong_owner'}
    if($script:Mode -ceq 'archive_failure'){throw 'worker_startup_archive_unknown'}
    $script:ArchivedFailure=$Capture.Failure
}
function Invoke-WorkerScmChange([string]$Action,[string]$ImagePath,$Generation,[DateTime]$Deadline,[string[]]$StartupArguments){
    Event ('scm:'+ $Action)
    if($Action -ceq 'Start'){
        $count=if($null -eq $StartupArguments){0}else{$StartupArguments.Length};$script:StartArgumentCounts+=,[int]$count
        if($count -ne 0 -and ($count -ne 2 -or $StartupArguments[0] -cne 'zeb-startup-observe-v1' -or $StartupArguments[1] -cne 'eyJ0ZWNobmljYWwiOnRydWV9')){throw 'technical_start_arguments_not_original_capture'}
        if($script:Mode -ceq 'start_failure'){throw 'worker_startup_observation_unknown'}
        if($script:Mode -ceq 'start_native_failure'){
            $script:ScmFailure=[ComponentModel.Win32Exception]::new(1058,'ZEB_PRIVATE_ERROR_SENTINEL')
            throw [InvalidOperationException]::new('ZEB_PRIVATE_WRAPPER_SENTINEL',$script:ScmFailure)
        }
        $script:ScmStarted=$true
    }
}
function Get-WorkerServiceGeneration($Receipt,[DateTime]$Deadline,[switch]$WaitForReady){
    Event ('generation:'+ $(if($WaitForReady){'ready'}else{'stopped'}))
    if($WaitForReady -and $script:Mode -ceq 'generation_failure'){throw 'worker_identity_unknown'}
    $value=[pscustomobject]@{exists=$true;status=$(if($WaitForReady){'Running'}else{'Stopped'});candidateSid=$script:Sid;
        host=[pscustomobject]@{pid=101;creationFileTime=$(if($WaitForReady -and $script:Mode -ceq 'wrong_generation'){'101'}else{'100'})};
        node=[pscustomobject]@{pid=202;creationFileTime='200'};tokenUserSid=$script:Sid;bootId='00000000-0000-4000-8000-000000000005';endpoint=[pscustomobject]@{bootId=$null}}
    $value|Add-Member -MemberType ScriptMethod -Name Dispose -Value {Event 'generation:dispose'}
    return $value
}
function Set-WorkerResourceAcl($Receipt,[string]$CandidateSid,[DateTime]$Deadline){return [pscustomobject]@{verified=$true;candidateSid=$script:Sid}}
function Assert-WorkerGeneration($Generation,$Receipt,[switch]$AllowUnboundBoot){}
function Get-WorkerVersionRoot($ProgramRoot,$Version){return 'C:\TechnicalNoFiles\program\technical-v1'}
function Test-WorkerInstalledPayload($PayloadRoot,$ExpectedInventorySha256,$ExpectedConfigSha256){
    Event 'package:checked'
    return [pscustomobject]@{version='technical-v1';storeSchemaVersion=7;startupObservationV1=$script:Capability}
}
function Get-WorkerServiceRow {throw 'technical_unexpected_service_row_call_outside_collector_sink'}
function Invoke-WorkerMaintenanceHttp {throw 'technical_unexpected_real_http_path'}

foreach($mode in @('legacy_unbound','legacy_bound')){
    if($mode -ceq 'legacy_bound' -and -not $captureRef){continue}
    Reset-Technical $mode;$failure=$null;$holder=$null
    try{
        $arguments=@{Receipt=$script:TestReceipt;ReceiptPath='technical:receipt';Deadline=$script:TestDeadline;Create=$true}
        if($mode -ceq 'legacy_bound'){$arguments.StartupCapture=[ref]$holder}
        Start-WorkerOwnedService @arguments
    }
    catch{$failure=$_.Exception.Message}
    $good=$null -eq $failure -and $script:StartArgumentCounts.Count -eq 1 -and $script:StartArgumentCounts[0] -eq 0 -and
        $script:Events.IndexOf('prepare') -lt 0 -and $script:Events.IndexOf('collect') -lt 0 -and $null -eq $script:Capture -and $null -eq $holder
    if($mode -ceq 'legacy_bound'){$good=$good -and $script:Events.IndexOf('package:checked') -ge 0 -and $script:Events.IndexOf('package:checked') -lt $script:Events.IndexOf('scm:Start')}
    $rows.Add(@{name=$mode;passed=$good;failure=$failure;events=$script:Events.ToArray();scope='real complete Start body, verified-package capability=false sink; slot is ownership only; no marker/factory/SCM evidence'})
}

if($captureRef){
    foreach($mode in @('missing_holder','null_holder')){
        Reset-Technical $mode;$failure=$null
        try{
            $arguments=@{Receipt=$script:TestReceipt;ReceiptPath='technical:receipt';Deadline=$script:TestDeadline}
            if($mode -ceq 'null_holder'){$arguments.Switch=$true;$arguments.StartupCapture=$null}else{$arguments.Create=$true}
            Start-WorkerOwnedService @arguments
        }catch{$failure=$_.Exception.Message}
        $rows.Add(@{name=('observed_'+$mode+'_refused_before_prepare_start');passed=$null -ne $failure -and $null -eq $script:Capture -and
            ($mode -ceq 'null_holder' -or $script:Events.IndexOf('package:checked') -ge 0) -and $script:Events.IndexOf('prepare') -lt 0 -and $script:Events.IndexOf('scm:Start') -lt 0 -and
            $script:Events.IndexOf('scm:CreateDemand') -lt 0 -and $script:Events.IndexOf('scm:SetImagePath') -lt 0;
            failure=$failure;events=$script:Events.ToArray();scope='real Start binding/body, verified-package capability=true sink; invalid owner never prepares or starts'})
    }
}

if($captureRef -and $allWired){
    $setup=@'
$receipt=$script:TestReceipt; $receiptPath='technical:receipt'; $data=$receipt.dataRoot
$action=$receipt.operation.action
$deadline=$script:TestDeadline; $ledgerOwned=$true
$privileges=Disposable 'privileges'; $lock=Disposable 'lock'
'@
    $afterStart=@'
if($script:Capability){
    if($null -eq $startupCapture -or -not [object]::ReferenceEquals($startupCapture,$script:Capture) -or $startupCapture.Disposed){
        throw 'technical_success_capture_not_owned_and_alive'
    }
}elseif($null -ne $startupCapture){throw 'technical_legacy_capture_not_null'}
Event 'technical:owner-retained'
'@
    $slices=@()
    for($index=0;$index -lt 4;$index++){
        $text=$initial+"`n"+$setup+"`ntry {`n"+$sites[$index].Extent.Text+"`n"+$afterStart+"`n"+$tailText+"`n} "+$outer.CatchClauses[0].Extent.Text+" finally "+$outer.Finally.Extent.Text
        $slices+=,([scriptblock]::Create($text))
    }
    $cases=[Collections.Generic.List[object]]::new()
    for($index=0;$index -lt 4;$index++){
        $cases.Add(@{site=$index;mode='ready'})
    }
    foreach($case in @(@{site=0;mode='start_failure'},@{site=2;mode='start_native_failure'},@{site=1;mode='collect_failure'},@{site=2;mode='settled'},
        @{site=3;mode='generation_failure'},@{site=2;mode='wrong_generation'},@{site=1;mode='archive_failure'})){$cases.Add($case)}
    foreach($case in $cases){
        Reset-Technical $case.mode;$delivery=$null;$failure=$null;$script:ObservedSliceRuns++
        try{$slice=$slices[[int]$case.site];$delivery=& $slice}catch{$failure=$_.Exception.Message}
        $events=$script:Events.ToArray();$begin=$script:Events.IndexOf('ledger:started:pending');$prepare=$script:Events.IndexOf('prepare')
        $scm=$script:Events.IndexOf('scm:Start');$collect=$script:Events.IndexOf('collect');$generation=$script:Events.IndexOf('generation:ready')
        $intent=$script:Events.IndexOf('intent:assert');$window=$script:Events.IndexOf('window:assert')
        $archive=$script:Events.IndexOf('diagnostic:save');$dispose=$script:Events.IndexOf('capture:dispose');$privilege=$script:Events.IndexOf('privileges:dispose');$unlock=$script:Events.IndexOf('lock:dispose')
        $good=$null -eq $failure -and $null -ne $delivery -and $begin -ge 0 -and $prepare -gt $begin -and $privilege -ge 0 -and $unlock -gt $privilege
        $good=$good -and $script:Events.IndexOf('package:checked') -ge 0 -and $script:Events.IndexOf('package:checked') -lt $prepare
        $expectedCollect=$case.mode -cnotin @('start_failure','start_native_failure')
        $good=$good -and $intent -gt $prepare -and $window -gt $intent -and $scm -gt $window -and
            @($events|Where-Object {$_ -ceq 'intent:assert'}).Count -eq 1 -and @($events|Where-Object {$_ -ceq 'window:assert'}).Count -eq 1 -and
            $script:StartArgumentCounts.Count -eq 1 -and $script:StartArgumentCounts[0] -eq 2
        $good=$good -and $(if($expectedCollect){$collect -gt $scm}else{$collect -lt 0})
        if($case.mode -ceq 'ready'){
            $good=$good -and $delivery.exitCode -eq 0 -and $delivery.value.outcome -ceq 'known' -and $generation -gt $collect -and
                $script:Events.IndexOf('scm:SetAutomatic') -gt $generation -and $script:UnknownAlive.Count -eq 0 -and $archive -lt 0 -and
                $script:Events.IndexOf('technical:owner-retained') -gt $generation -and $dispose -gt $script:Events.IndexOf('technical:owner-retained')
        }else{
            $good=$good -and $delivery.exitCode -eq 1 -and $delivery.value.outcome -ceq 'unknown'
            if($case.mode -cnotin @('generation_failure','wrong_generation')){$good=$good -and $generation -lt 0 -and $script:Events.IndexOf('scm:SetAutomatic') -lt 0 -and $script:Events.IndexOf('ledger:started:known') -lt 0}
            if($case.mode -cin @('generation_failure','wrong_generation')){$good=$good -and $generation -gt $collect -and $script:Events.IndexOf('scm:SetAutomatic') -lt 0 -and $script:Events.IndexOf('ledger:started:known') -lt 0}
            $unknown=$script:Events.IndexOf('ledger:started:unknown')
            $good=$good -and $archive -gt $prepare -and $unknown -gt $archive -and $dispose -gt $unknown -and $script:UnknownAlive.Count -eq 1 -and $script:UnknownAlive[0]
        }
        if($null -ne $script:Capture){$good=$good -and $script:Capture.Disposed -and $script:Capture.DisposeCalls -eq 1 -and $dispose -ge 0 -and $privilege -gt $dispose}
        if($case.mode -ceq 'start_native_failure'){
            $good=$good -and $null -ne $script:ArchivedFailure -and
                [object]::ReferenceEquals($script:ArchivedFailure.GetBaseException(),$script:ScmFailure)
        }
        $rows.Add(@{name=('actual_entry_slice:'+ $siteNames[[int]$case.site]+':'+$case.mode);passed=$good;failure=$failure;
            events=$events;unknownWriteAttemptCaptureAlive=$script:UnknownAlive;startArgumentCounts=$script:StartArgumentCounts;
            output=$delivery;scope='exact original four CommandAst plus initial statements/success tail/catch/finally; full Start body; producer/collector/intent/window/SCM/ledger/pins are technical method sinks'})
    }
}
$failed=@($rows|Where-Object {-not $_.passed})
$report=@{code=$(if($missing.Count -gt 0){'startup_caller_entry_interface_red'}elseif(-not $allWired){'startup_caller_entry_wiring_red'}else{'startup_caller_entry_controls_v4'});
    passed=$failed.Count -eq 0;moduleSha256=$ModuleSha;passCount=$rows.Count-$failed.Count;failCount=$failed.Count;
    missingInterfaces=$missing.ToArray();observedEntrySlices=$script:ObservedSliceRuns;rows=$rows.ToArray();
    actualProducerCollectorExecuted=$false;actualNativePipeOrPins=$false;actualInstalledInventoryOrMarker=$false;actualScmExercised=$false;actualVirtualServiceCrossSid=$false;
    scope='interface/wiring RED plus exact source method-sink slices; not complete Invoke-WorkerInstallation action validation or actual runtime handshake'}
$text=($report|ConvertTo-Json -Depth 12)+"`n";$bytes=[Text.UTF8Encoding]::new($false).GetBytes($text)
$output=[IO.FileStream]::new($OutputPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
try{$output.Write($bytes,0,$bytes.Length)}finally{$output.Dispose()}
[Console]::WriteLine($text)
if($failed.Count -gt 0){exit 1}
exit 0
