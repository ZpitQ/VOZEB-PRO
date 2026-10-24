param([Parameter(Mandatory=$true)][string]$ModulePath)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
if($PSVersionTable.PSVersion.Major -ne 5){throw 'fresh_winps5_required'}
$module=Import-Module -Name $ModulePath -Force -PassThru
$rows=@(& $module {
    $script:CompletionWrites=[Collections.Generic.List[object]]::new()
    function script:Test-WorkerInstalledPayload {return [pscustomobject]@{startupObservationV1=$false}}
    function script:Set-WorkerResourceAcl {param($Receipt,$CandidateSid,$Deadline) return [pscustomobject]@{verified=$true;candidateSid=$CandidateSid}}
    function script:Invoke-WorkerScmChange {param($Action,$ImagePath,$Generation,$Deadline,$StartupArguments)}
    function script:Save-WorkerStage {
        param($Path,$Receipt,$Stage,$Outcome)
        $Receipt.operation.stage=$Stage;$Receipt.operation.outcome=$Outcome
        $script:CompletionWrites.Add([pscustomobject]@{state=$Receipt.state;stage=$Stage;outcome=$Outcome})
    }
    function script:Get-WorkerServiceGeneration {
        param($Receipt,$Deadline,[switch]$WaitForReady)
        $value=[pscustomobject]@{tokenUserSid=$Receipt.tokenUserSid;bootId='20000000-0000-4000-8000-000000000002';endpoint=[pscustomobject]@{bootId=$null}}
        $value|Add-Member -MemberType ScriptMethod -Name Dispose -Value {}
        return $value
    }
    function script:Assert-WorkerGeneration {param($Generation,$Receipt,[switch]$AllowUnboundBoot)}
    foreach($defer in @($true,$false)){
        $script:CompletionWrites.Clear()
        $receipt=[pscustomobject]@{programRoot='D:\inert-recovery-program';active=[pscustomobject]@{
            version='inert-v1';inventorySha256=('a'*64);imagePath='"D:\inert-recovery-program\inert-v1\WindowsServiceHost.exe"'};
            configSha256=('b'*64);tokenUserSid='S-1-5-80-1-2-3-4-5';state='pending';sessionId=0;
            operation=[pscustomobject]@{stage='backed_up';outcome='pending'}}
        $arguments=@{Receipt=$receipt;ReceiptPath='D:\inert-recovery-data\installation\receipt.json';
            Deadline=[DateTime]::UtcNow.AddSeconds(30);Switch=$true}
        if($defer){$arguments.DeferCompletion=$true}
        $capture=$null;$arguments.StartupCapture=[ref]$capture
        Start-WorkerOwnedService @arguments
        $known=@($script:CompletionWrites|Where-Object {$_.state -ceq 'installed' -and $_.outcome -ceq 'known'}).Count
        $good=if($defer){$known -eq 0 -and $receipt.state -ceq 'pending' -and $receipt.operation.outcome -ceq 'pending'}
            else{$known -eq 1 -and $receipt.state -ceq 'installed' -and $receipt.operation.outcome -ceq 'known'}
        [pscustomobject]@{name=$(if($defer){'recovery_start_does_not_commit_before_owner_cleanup'}else{'ordinary_start_keeps_existing_completion'});
            passed=[bool]$good;knownWrites=$known;state=$receipt.state;outcome=$receipt.operation.outcome}
    }
})
$sha=[Security.Cryptography.SHA256]::Create()
try{$moduleHash=[BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($ModulePath))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
$passed=@($rows|Where-Object {-not $_.passed}).Count -eq 0
[Console]::Out.WriteLine(([ordered]@{code='recover_completion_controls_v1';passed=$passed;moduleSha256=$moduleHash;rows=$rows;
    actualStartHelperBody=$true;actualStorage=$false;actualScm=$false;actualRecoveryOwner=$false;actualGpu=$false}|ConvertTo-Json -Depth 6 -Compress))
if(-not $passed){exit 1}
exit 0
