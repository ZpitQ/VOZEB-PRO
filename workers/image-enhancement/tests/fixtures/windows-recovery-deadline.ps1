param(
    [Parameter(Mandatory=$true)][string]$ModulePath,
    [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ModuleSha,
    [Parameter(Mandatory=$true)][string]$OutputPath
)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
if($PSVersionTable.PSVersion.Major -ne 5){throw 'fresh_winps5_required'}
$ModulePath=[IO.Path]::GetFullPath($ModulePath);$OutputPath=[IO.Path]::GetFullPath($OutputPath);$ModuleSha=$ModuleSha.ToLowerInvariant()
if((Get-FileHash -LiteralPath $ModulePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ModuleSha){throw 'module_changed'}
if([IO.File]::Exists($OutputPath)){throw 'output_already_exists'}
$tokens=$null;$errors=$null;$source=[Management.Automation.Language.Parser]::ParseFile($ModulePath,[ref]$tokens,[ref]$errors)
if($errors.Count -ne 0){throw 'source_parser_failed'}
$functions=@($source.FindAll({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -ceq 'Invoke-WorkerRecovery'},$true))
if($functions.Count -ne 1){throw 'recovery_source_not_unique'}
$outer=@($functions[0].Body.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]})
if($outer.Count -ne 1 -or $null -eq $outer[0].Finally){throw 'recovery_finally_not_unique'}
$sliceText=$outer[0].Finally.Extent.Text
if(-not $sliceText.StartsWith('{') -or -not $sliceText.TrimEnd().EndsWith('}')){throw 'finally_extent_not_block'}
$sha=[Security.Cryptography.SHA256]::Create()
try{$sliceSha=[BitConverter]::ToString($sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($sliceText))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
$testModule=New-Module -ScriptBlock {
    function Write-WorkerLedger([string]$Path,$Value){
        $s=$script:ClockControlState
        if($Path -ceq 'core'){$outcome=$Value.operation.outcome;if($outcome -ceq 'known'){$s.CoreKnownWrites++}}
        elseif($Path -ceq 'private'){$outcome=$Value.outcome;if($outcome -ceq 'known'){$s.PrivateKnownWrites++}}
        else{throw 'fixture_ledger_subject_invalid'}
        $s.Events.Add('ledger_'+$Path+'_'+$outcome)
    }
    function Save-WorkerStage([string]$Path,$Receipt,[string]$Stage,[string]$Outcome){
        $Receipt.operation.stage=$Stage;$Receipt.operation.outcome=$Outcome
        Write-WorkerLedger $Path $Receipt
    }
    function Get-WorkerRemainingMilliseconds([DateTime]$Deadline){
        $s=$script:ClockControlState;$s.ClockCalls++;$s.Events.Add('synthetic_clock_check')
        if($Deadline.Ticks -ne $s.Deadline.Ticks){throw 'fixture_deadline_changed'}
        if($s.Expired -and $s.CleanupCompleted){$s.TimeoutThrows++;throw 'worker_timeout_unknown'}
        return 1000
    }
}
$rows=[Collections.Generic.List[object]]::new()
foreach($expired in @($false,$true)){
    $state=[pscustomobject]@{Expired=$expired;Deadline=[DateTime]::UtcNow.AddSeconds(60);Events=[Collections.Generic.List[string]]::new();
        CleanupCompleted=$false;CaptureDisposals=0;PrivilegeDisposals=0;ClockCalls=0;TimeoutThrows=0;CoreKnownWrites=0;PrivateKnownWrites=0}
    $observed=& $testModule {
        param($State,$SliceText)
        $script:ClockControlState=$State;$script:WorkerBearer='INERT_PRIVATE_TOKEN'
        $deadline=$State.Deadline;$liveTouched=$true;$receiptPath='core';$recoveryPath='private'
        $receipt=[pscustomobject]@{state='pending';operation=[pscustomobject]@{stage='started';outcome='pending'}}
        $recoveryReceipt=[pscustomobject]@{phase='starting';outcome='pending';bootId='00000000-0000-4000-8000-000000000001';qualificationRequired=$true}
        $delivery=[pscustomobject]@{exitCode=0;value=[pscustomobject]@{code='worker_recovery_complete';outcome='known'}}
        $startupCapture=[pscustomobject]@{}
        $startupCapture|Add-Member -MemberType ScriptMethod -Name Dispose -Value {
            $script:ClockControlState.CaptureDisposals++;$script:ClockControlState.Events.Add('synthetic_capture_dispose')
        }
        $privileges=[pscustomobject]@{}
        $privileges|Add-Member -MemberType ScriptMethod -Name Dispose -Value {
            $s=$script:ClockControlState;$s.PrivilegeDisposals++;$s.CleanupCompleted=$true;$s.Events.Add('synthetic_privilege_dispose')
        }
        $failure=$null
        try{& ([scriptblock]::Create('& '+$SliceText))}catch{$failure=$_.Exception.GetType().FullName}
        return [pscustomobject]@{failureType=$failure;exitCode=$delivery.exitCode;outcome=$delivery.value.outcome;
            code=$(if($delivery.value.code -cmatch '\Aworker_[a-z_]+\z'){$delivery.value.code}else{$null});
            coreState=$receipt.state;coreOutcome=$receipt.operation.outcome;privateOutcome=$recoveryReceipt.outcome;
            bearerCleared=$null -eq $script:WorkerBearer}
    } $state $sliceText
    $good=$null -eq $observed.failureType -and $state.CleanupCompleted -and $state.CaptureDisposals -eq 1 -and
        $state.PrivilegeDisposals -eq 1 -and $state.ClockCalls -ge 1 -and $observed.bearerCleared
    if($expired){
        $good=$good -and $state.TimeoutThrows -eq 1 -and $state.CoreKnownWrites -eq 0 -and $state.PrivateKnownWrites -eq 0 -and
            $observed.exitCode -eq 1 -and $observed.outcome -ceq 'unknown' -and $observed.coreState -ceq 'unknown' -and
            $observed.coreOutcome -ceq 'unknown' -and $observed.privateOutcome -ceq 'unknown'
    }else{
        $good=$good -and $state.TimeoutThrows -eq 0 -and $state.CoreKnownWrites -eq 1 -and $state.PrivateKnownWrites -eq 1 -and
            $observed.exitCode -eq 0 -and $observed.outcome -ceq 'known' -and $observed.coreState -ceq 'installed' -and
            $observed.coreOutcome -ceq 'known' -and $observed.privateOutcome -ceq 'known'
    }
    $rows.Add(@{name=$(if($expired){'expired_after_successful_cleanup_zero_core_or_private_known'}else{'actual_finally_technical_success_control'});
        passed=[bool]$good;observed=$observed;clockCalls=$state.ClockCalls;syntheticTimeoutThrows=$state.TimeoutThrows;
        coreKnownWrites=$state.CoreKnownWrites;privateKnownWrites=$state.PrivateKnownWrites;events=$state.Events.ToArray()})
}
if((Get-FileHash -LiteralPath $ModulePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ModuleSha){throw 'module_changed_during_controls'}
$failures=@($rows|Where-Object {-not $_.passed});$passed=$failures.Count -eq 0
$report=@{code='recovery_finally_deadline_controls_v1';passed=$passed;moduleSha256=$ModuleSha;finallySliceSha256=$sliceSha;
    sourceFinallyStartLine=$outer[0].Finally.Extent.StartLineNumber;sourceFinallyEndLine=$outer[0].Finally.Extent.EndLineNumber;
    passCount=$rows.Count-$failures.Count;failCount=$failures.Count;rows=$rows.ToArray();
    actualOriginalFinallySlice=$true;actualFullInvokeRecovery=$false;actualClockOrElapsedDeadline=$false;actualOriginalLedger=$false;
    actualPrivilegeRestoration=$false;actualFileTransaction=$false;actualScm=$false;actualFailureProof=$false;actualRecover=$false;actualGpu=$false;
    scope='unmodified actual InvokeWorkerRecovery outer finally block executed with explicit synthetic pre-finally variables, cleanup, deadline and ledger seams; no real clock wait, storage, process, SCM or GPU qualification'}
$raw=[Text.UTF8Encoding]::new($false).GetBytes(($report|ConvertTo-Json -Depth 12 -Compress)+[char]10)
$stream=[IO.FileStream]::new($OutputPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
try{$stream.Write($raw,0,$raw.Length)}finally{$stream.Dispose()}
[Console]::Write([Text.Encoding]::UTF8.GetString($raw))
if(-not $passed){exit 1}
exit 0
