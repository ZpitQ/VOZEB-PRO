param(
    [Parameter(Mandatory=$true)][string]$ModulePath,
    [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ModuleSha,
    [Parameter(Mandatory=$true)][string]$OutputPath
)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$nl=[Environment]::NewLine
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
if($PSVersionTable.PSVersion.Major -ne 5){throw 'actual_windows_powershell_5_required'}
if($null -ne ('Zeb.WorkerInstall.Native' -as [type])){throw 'fresh_technical_native_process_required'}
if((Get-FileHash -LiteralPath $ModulePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ModuleSha.ToLowerInvariant()){throw 'module_preimage_changed'}
if(Test-Path -LiteralPath $OutputPath){throw 'output_already_exists'}
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($ModulePath,[ref]$tokens,[ref]$errors)
if($errors.Count -ne 0){throw 'module_parser_failed'}
$allFunctions=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$true))
function Source-Function([string]$Name){
    $found=@($allFunctions|Where-Object {$_.Name -ceq $Name})
    if($found.Count -ne 1){throw 'source_function_not_unique'}
    return $found[0]
}
function Commands($Node,[string]$Name){
    return @($Node.FindAll({param($item) $item -is [Management.Automation.Language.CommandAst] -and $item.GetCommandName() -ceq $Name},$true))
}
function Upgrade-Condition($Node){
    return @($Node.FindAll({param($item)
        $item -is [Management.Automation.Language.BinaryExpressionAst] -and $item.Operator -eq [Management.Automation.Language.TokenKind]::Ceq -and
        $item.Left -is [Management.Automation.Language.VariableExpressionAst] -and $item.Left.VariablePath.UserPath -ceq 'action' -and
        $item.Right -is [Management.Automation.Language.StringConstantExpressionAst] -and $item.Right.Value -ceq 'Upgrade'
    },$true)).Count -gt 0
}
$install=Source-Function 'Invoke-WorkerInstallation'
$owners=@($install.Body.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]})
if($owners.Count -ne 1 -or $owners[0].CatchClauses.Count -ne 1 -or $null -eq $owners[0].Finally){throw 'original_operation_owner_shape_changed'}
$outer=$owners[0]
$initial=(@($install.Body.EndBlock.Statements|Where-Object {$_.Extent.StartOffset -lt $outer.Extent.StartOffset})|ForEach-Object {$_.Extent.Text}) -join $nl
$upgradeBlocks=[Collections.Generic.List[object]]::new()
foreach($branch in @($outer.Body.FindAll({param($node) $node -is [Management.Automation.Language.IfStatementAst]},$true))){
    foreach($clause in $branch.Clauses){
        if((Upgrade-Condition $clause.Item1) -and @(Commands $clause.Item2 'Start-WorkerOwnedService').Count -eq 1 -and
            @(Commands $clause.Item2 'New-WorkerBackup').Count -eq 1){$upgradeBlocks.Add($clause.Item2)}
    }
}
if($upgradeBlocks.Count -ne 1){throw 'original_upgrade_start_owner_not_unique'}
$startSite=@(Commands $upgradeBlocks[0] 'Start-WorkerOwnedService')[0]
$constructorSites=@(Commands $install.Body 'New-WorkerStartupFailureProof')
$writerSites=@(Commands $install.Body 'Write-WorkerStartupFailureProof')
$constructorInCatch=$constructorSites.Count -eq 1 -and $constructorSites[0].Extent.StartOffset -ge $outer.CatchClauses[0].Extent.StartOffset -and
    $constructorSites[0].Extent.EndOffset -le $outer.CatchClauses[0].Extent.EndOffset
$writerInFinally=$writerSites.Count -eq 1 -and $writerSites[0].Extent.StartOffset -ge $outer.Finally.Extent.StartOffset -and
    $writerSites[0].Extent.EndOffset -le $outer.Finally.Extent.EndOffset
$constructorAssigned=$false
if($constructorInCatch){
    $parent=$constructorSites[0].Parent
    while($null -ne $parent -and $parent -isnot [Management.Automation.Language.AssignmentStatementAst]){$parent=$parent.Parent}
    $constructorAssigned=$null -ne $parent -and $parent.Left -is [Management.Automation.Language.VariableExpressionAst]
}
$wiring=$constructorInCatch -and $writerInFinally -and $constructorAssigned
$rows=[Collections.Generic.List[object]]::new()
$rows.Add(@{kind='wiring';name='one_candidate_in_original_catch_and_one_writer_in_original_finally';passed=$wiring;
    constructorCallSites=$constructorSites.Count;writerCallSites=$writerSites.Count;constructorInCatch=$constructorInCatch;
    writerInFinally=$writerInFinally;constructorAssigned=$constructorAssigned})
$names=@('upgrade_settled_original_references_order_and_deadline','unknown_ledger_write_failure_has_no_proof',
    'unknown_independent_readback_mismatch_has_no_proof','unknown_independent_readback_failure_has_no_proof',
    'optional_constructor_failure_preserves_original_error','capture_dispose_failure_has_no_publication',
    'privileges_dispose_failure_has_no_publication','installation_lock_dispose_failure_has_no_publication',
    'second_original_lock_dispose_failure_has_no_publication','optional_writer_failure_preserves_original_unknown',
    'install_never_requests_failure_proof','rollback_never_requests_failure_proof','eof_stage_never_requests_failure_proof',
    'exit_wait_stage_never_requests_failure_proof','missing_upgrade_success_pointers_never_request_failure_proof')
$script:SliceRuns=0;$script:TechnicalNativeCompiled=$false
function Report([string]$Code){
    if((Get-FileHash -LiteralPath $ModulePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ModuleSha.ToLowerInvariant()){throw 'module_changed_during_controls'}
    $failed=@($rows|Where-Object {-not $_.passed});$behavior=@($rows|Where-Object {$_.kind -ceq 'behavior'})
    $observed=@($behavior|ForEach-Object {$_.name});$pending=@($names|Where-Object {$_ -cnotin $observed})
    $complete=$pending.Count -eq 0 -and $behavior.Count -eq $names.Count
    $report=@{code=$Code;moduleSha256=$ModuleSha.ToLowerInvariant();passed=$failed.Count -eq 0 -and $complete;rows=$rows.ToArray();
        passCount=$rows.Count-$failed.Count;failCount=$failed.Count;expectedBehaviorControls=$names.Count;
        behaviorPassCount=@($behavior|Where-Object {$_.passed}).Count;behaviorFailCount=@($behavior|Where-Object {-not $_.passed}).Count;
        pendingBehaviorControls=$pending.Count;pendingBehaviorNames=$pending;observedEntrySlices=$script:SliceRuns;
        technicalNativeCompiled=$script:TechnicalNativeCompiled;actualNativeCompiled=$false;actualIndependentDiskReadback=$false;
        actualStopExecuted=$false;actualBackupExecuted=$false;actualStartupExecuted=$false;actualSemanticConstructor=$false;
        actualWriterStorageExecuted=$false;actualOriginalHandleCloseout=$false;actualScmExercised=$false;actualFailureProof=$false;
        actualRecover=$false;actualGpu=$false;fullInstallerActionValidationExecuted=$false;constructorSourceInterfaceOutsideScope=$true;
        scope='exact original Upgrade Start call and owner catch/finally; independent serialized receipt and Native/file methods are technical sinks; no original Native/filesystem/handles/SCM/startup/constructor/writer storage/Recovery';
        nonAuthorSourceReviewRequired='new optional readback/constructor/writer failures do not replace original startup error; original Unknown write/cleanup semantics unchanged; constructor after full independent Unknown readback while original refs held; all original disposal gates before same-candidate Closeout flags and single writer; no deadline extension or extra lifecycle calls'}
    $text=($report|ConvertTo-Json -Depth 16 -Compress)+[char]10;$raw=[Text.UTF8Encoding]::new($false,$true).GetBytes($text)
    $stream=[IO.FileStream]::new($OutputPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try{$stream.Write($raw,0,$raw.Length)}finally{$stream.Dispose()}
    [Console]::Write($text)
    if($failed.Count -gt 0 -or -not $complete){exit 1}
    exit 0
}
if(-not $wiring){Report 'startup_failure_proof_owner_wiring_red'}
# This is a method sink for caller wiring, never the product Native or an independent disk observation.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Security.Cryptography;
namespace Zeb.WorkerInstall {
    public static class Native {
        public static string ReceiptPath;
        public static byte[] ReceiptRaw;
        public static readonly List<string> ReadPaths = new List<string>();
        public static byte[] ReadBytes(string path) {
            ReadPaths.Add(path);
            if (!String.Equals(path, ReceiptPath, StringComparison.Ordinal) || ReceiptRaw == null)
                throw new InvalidOperationException("technical_receipt_read_without_write");
            return (byte[])ReceiptRaw.Clone();
        }
        public static string Hash(string path) {
            using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(ReadBytes(path))).Replace("-", "").ToLowerInvariant();
        }
    }
}
'@
$script:TechnicalNativeCompiled=$true
foreach($name in @('Get-WorkerPublicResult','Get-WorkerBytesHash','Get-WorkerRemainingMilliseconds')){
    . ([scriptblock]::Create((Source-Function $name).Extent.Text))
}
function Event([string]$Value){$script:Events.Add($Value)}
function Json-Text($Value){return $Value|ConvertTo-Json -Depth 64 -Compress}
function Json-Bytes($Value){return ,([Text.UTF8Encoding]::new($false,$true).GetBytes((Json-Text $Value)+[char]10))}
function Deadline-Check([DateTime]$Deadline){
    $script:DeadlineChecks++
    if($Deadline.Ticks -ne $script:TestDeadline.Ticks -or $Deadline.Kind -ne [DateTimeKind]::Utc -or [DateTime]::UtcNow -ge $Deadline){
        $script:DeadlineViolations++;throw 'technical_original_deadline_changed'
    }
}
function Same-Receipt($Receipt,[string]$ReceiptPath){
    if(-not [object]::ReferenceEquals($Receipt,$script:Receipt) -or $ReceiptPath -cne 'technical:receipt'){throw 'technical_original_receipt_changed'}
}
function Disposable([string]$Tag){
    $value=[pscustomobject]@{Tag=$Tag;Disposed=$false;Failure=$null;FailureType=$null;FailureStage=$null;Stage=$null}
    $value|Add-Member -MemberType ScriptMethod -Name Dispose -Value {
        Event ($this.Tag+':dispose')
        $script:DisposeCalls[$this.Tag]++
        if($script:Case.mode -ceq ($this.Tag+'-error')){throw 'worker_technical_cleanup_unknown'}
        $this.Disposed=$true
    }
    return $value
}
function Reset-Case($Case){
    $script:Case=$Case;$script:Events=[Collections.Generic.List[string]]::new();$script:Forbidden=[Collections.Generic.List[string]]::new()
    $script:DisposeCalls=@{capture=0;privileges=0;lock=0;'second-lock'=0}
    $script:StartCalls=0;$script:UnknownWrites=0;$script:SuccessfulWrites=0;$script:ReadbackCalls=0;$script:ConstructorCalls=0;$script:WriterCalls=0
    $script:DeadlineChecks=0;$script:DeadlineViolations=0;$script:ReadbackIndependent=$false;$script:ReadbackGood=$false
    $script:ConstructorChecks=$false;$script:WriterChecks=$false;$script:Candidate=$null;$script:CandidateInitial=$null
    $script:Capture=Disposable 'capture';$script:Capture.Stage=$Case.stage
    $script:Privileges=Disposable 'privileges';$script:InstallLock=Disposable 'lock';$script:SecondLock=Disposable 'second-lock'
    $script:Receipt=[pscustomobject]@{installationId='00000000-0000-4000-8000-000000000001';serviceId='00000000-0000-4000-8000-000000000002';
        clientId='00000000-0000-4000-8000-000000000003';state='installed';dataRoot='C:\TechnicalNoFiles\data';
        active=[pscustomobject]@{version='technical-v2';inventorySha256=('a'*64);imagePath='"C:\TechnicalNoFiles\program\technical-v2\WindowsServiceHost.exe"'};
        previous=[pscustomobject]@{version='technical-v1';inventorySha256=('b'*64);imagePath='"C:\TechnicalNoFiles\program\technical-v1\WindowsServiceHost.exe"'};
        operation=[pscustomobject]@{operationId='00000000-0000-4000-8000-000000000004';action=$Case.action;stage='started';outcome='pending';targetSha256=('a'*64)}}
    $script:UpgradeEvidence=[pscustomobject]@{EvidencePath='technical:verified-backup';EvidenceSha256=('c'*64)}
    if($Case.mode -ceq 'missing-upgrade-proof'){$script:UpgradeEvidence.EvidencePath=$null;$script:UpgradeEvidence.EvidenceSha256=$null}
    $script:TestDeadline=[DateTime]::UtcNow.AddSeconds(10);$script:WorkerUnresolvedProcessIdentity=$null
    [Zeb.WorkerInstall.Native]::ReceiptPath='technical:receipt';[Zeb.WorkerInstall.Native]::ReceiptRaw=$null
    [Zeb.WorkerInstall.Native]::ReadPaths.Clear()
}
function Start-WorkerOwnedService($Receipt,[string]$ReceiptPath,[DateTime]$Deadline,[switch]$Switch,[ref]$StartupCapture){
    Event 'original-start';$script:StartCalls++;Deadline-Check $Deadline;Same-Receipt $Receipt $ReceiptPath
    if(-not $Switch -or $null -eq $StartupCapture -or $null -ne $StartupCapture.Value){throw 'technical_start_reference_or_mode_changed'}
    $StartupCapture.Value=$script:Capture
    throw 'worker_startup_observation_unknown'
}
function Write-WorkerStartupDiagnostic($Capture,$Receipt){
    Event 'diagnostic'
    if(-not [object]::ReferenceEquals($Capture,$script:Capture) -or -not [object]::ReferenceEquals($Receipt,$script:Receipt)){throw 'technical_diagnostic_owner_changed'}
}
function Write-WorkerLedger([string]$Path,$Value){
    Same-Receipt $Value $Path;Event 'unknown-write';$script:UnknownWrites++
    if($Value.state -cne 'unknown' -or $Value.operation.stage -cne 'started' -or $Value.operation.outcome -cne 'unknown'){throw 'technical_unknown_ledger_shape_changed'}
    if($script:Case.mode -ceq 'ledger-error'){throw 'worker_ledger_unknown'}
    $snapshot=Json-Text $Value|ConvertFrom-Json
    if($script:Case.mode -ceq 'readback-mismatch'){$snapshot.operation.targetSha256=('d'*64)}
    [Zeb.WorkerInstall.Native]::ReceiptRaw=Json-Bytes $snapshot
    $script:SuccessfulWrites++;Event 'unknown-written'
}
function Read-WorkerReceipt([string]$Path){
    Event 'unknown-readback';$script:ReadbackCalls++
    if($Path -cne 'technical:receipt' -or $script:SuccessfulWrites -le 0){throw 'technical_readback_before_original_write'}
    if($script:Case.mode -ceq 'readback-error'){throw 'worker_technical_readback_unknown'}
    $copy=[Text.UTF8Encoding]::new($false,$true).GetString([Zeb.WorkerInstall.Native]::ReadBytes($Path))|ConvertFrom-Json
    $script:ReadbackIndependent=-not [object]::ReferenceEquals($copy,$script:Receipt)
    $script:ReadbackGood=$script:ReadbackIndependent -and (Json-Text $copy) -ceq (Json-Text $script:Receipt)
    return $copy
}
function New-WorkerStartupFailureProof($Capture,$Receipt,$ReceiptPath,$UpgradeEvidence,[DateTime]$Deadline){
    Event 'constructor';$script:ConstructorCalls++;Deadline-Check $Deadline;Same-Receipt $Receipt $ReceiptPath
    if(-not [object]::ReferenceEquals($Capture,$script:Capture) -or -not [object]::ReferenceEquals($UpgradeEvidence,$script:UpgradeEvidence) -or
        $Capture.Disposed -or $script:Privileges.Disposed -or $script:InstallLock.Disposed -or $script:SecondLock.Disposed -or
        @($script:DisposeCalls.Values|Where-Object {$_ -ne 0}).Count -ne 0 -or
        $Capture.Stage -cne 'settled' -or $Receipt.operation.action -cne 'Upgrade' -or
        $Receipt.state -cne 'unknown' -or $Receipt.operation.outcome -cne 'unknown' -or
        $script:SuccessfulWrites -ne 1 -or $script:ReadbackCalls -lt 1 -or -not $script:ReadbackGood -or
        $null -eq $UpgradeEvidence.EvidencePath -or $null -eq $UpgradeEvidence.EvidenceSha256){throw 'technical_constructor_owner_or_readback_gate_changed'}
    $script:ConstructorChecks=$true
    if($script:Case.mode -ceq 'constructor-error'){throw 'worker_technical_constructor_unknown'}
    $script:Candidate=[pscustomobject]@{OperationId=$Receipt.operation.operationId;StartupAttemptId='00000000-0000-4000-8000-000000000005';
        DataRoot=$Receipt.dataRoot;ReceiptPath=$ReceiptPath;FailedReceiptRaw=[Zeb.WorkerInstall.Native]::ReceiptRaw.Clone();SourceModuleSha256=$ModuleSha.ToLowerInvariant();
        ContextCutoffTick64=[long]9999999999999;DeadlineUtcTicks=$Deadline.Ticks;ExistingMaterials=@();NewMaterials=@();ProofRaw=[byte[]]@(123,125);
        Closeout=[pscustomobject]@{captureReleased=$false;privilegesRestored=$false;installationLocksReleased=$false};PublishedPath=$null;PublishedSha256=$null}
    $script:CandidateInitial=Json-Text ($script:Candidate|Select-Object -Property * -ExcludeProperty Closeout,PublishedPath,PublishedSha256)
    return $script:Candidate
}
function Write-WorkerStartupFailureProof($Evidence,[DateTime]$Deadline){
    Event 'proof-writer';$script:WriterCalls++;Deadline-Check $Deadline
    if(-not [object]::ReferenceEquals($Evidence,$script:Candidate) -or
        -not $script:Capture.Disposed -or -not $script:Privileges.Disposed -or -not $script:InstallLock.Disposed -or -not $script:SecondLock.Disposed -or
        @($script:DisposeCalls.Values|Where-Object {$_ -ne 1}).Count -ne 0 -or
        @($Evidence.Closeout.PSObject.Properties).Count -ne 3 -or
        $Evidence.Closeout.captureReleased -isnot [bool] -or -not $Evidence.Closeout.captureReleased -or
        $Evidence.Closeout.privilegesRestored -isnot [bool] -or -not $Evidence.Closeout.privilegesRestored -or
        $Evidence.Closeout.installationLocksReleased -isnot [bool] -or -not $Evidence.Closeout.installationLocksReleased -or
        $null -ne $Evidence.PublishedPath -or $null -ne $Evidence.PublishedSha256 -or
        $script:CandidateInitial -cne (Json-Text ($Evidence|Select-Object -Property * -ExcludeProperty Closeout,PublishedPath,PublishedSha256))){throw 'technical_writer_original_closeout_or_candidate_changed'}
    $script:WriterChecks=$true
    if($script:Case.mode -ceq 'writer-error'){throw 'worker_technical_writer_unknown'}
    $Evidence.PublishedPath='technical:failure-proof';$Evidence.PublishedSha256=('e'*64)
}
function Stop-WorkerOwnedService {$script:Forbidden.Add('Stop');throw 'technical_extra_stop_forbidden'}
function New-WorkerBackup {$script:Forbidden.Add('Backup');throw 'technical_extra_backup_forbidden'}
function Invoke-WorkerScmChange {$script:Forbidden.Add('SCM');throw 'technical_extra_scm_forbidden'}
function Invoke-WorkerMaintenanceHttp {$script:Forbidden.Add('HTTP');throw 'technical_extra_http_forbidden'}
function Invoke-WorkerNodeProcess {$script:Forbidden.Add('Node');throw 'technical_extra_node_forbidden'}
function Invoke-WorkerRecovery {$script:Forbidden.Add('Recover');throw 'technical_extra_recover_forbidden'}
$setup=@'
$receipt=$script:Receipt;$receiptPath='technical:receipt';$data=$receipt.dataRoot;$deadline=$script:TestDeadline
$action=$script:Case.action;$operationId=$receipt.operation.operationId;$ledgerOwned=$true
$privileges=$script:Privileges;$lock=$script:InstallLock;$tombstoneLock=$script:SecondLock;$upgradeEvidence=$script:UpgradeEvidence
'@
# Exact original call/catch/finally; whole-action preflight and semantic/startup/storage behavior are outside this slice.
$slice=[scriptblock]::Create($initial+$nl+$setup+$nl+'try {'+$nl+$startSite.Extent.Text+$nl+'} '+
    $outer.CatchClauses[0].Extent.Text+' finally '+$outer.Finally.Extent.Text)
$cases=@(
    @{name=$names[0];action='Upgrade';stage='settled';mode='normal'},
    @{name=$names[1];action='Upgrade';stage='settled';mode='ledger-error'},
    @{name=$names[2];action='Upgrade';stage='settled';mode='readback-mismatch'},
    @{name=$names[3];action='Upgrade';stage='settled';mode='readback-error'},
    @{name=$names[4];action='Upgrade';stage='settled';mode='constructor-error'},
    @{name=$names[5];action='Upgrade';stage='settled';mode='capture-error'},
    @{name=$names[6];action='Upgrade';stage='settled';mode='privileges-error'},
    @{name=$names[7];action='Upgrade';stage='settled';mode='lock-error'},
    @{name=$names[8];action='Upgrade';stage='settled';mode='second-lock-error'},
    @{name=$names[9];action='Upgrade';stage='settled';mode='writer-error'},
    @{name=$names[10];action='Install';stage='settled';mode='normal'},
    @{name=$names[11];action='Rollback';stage='settled';mode='normal'},
    @{name=$names[12];action='Upgrade';stage='eof';mode='normal'},
    @{name=$names[13];action='Upgrade';stage='exit-wait';mode='normal'},
    @{name=$names[14];action='Upgrade';stage='settled';mode='missing-upgrade-proof'}
)
foreach($case in $cases){
    Reset-Case $case;$failureType=$null;$failureCode=$null;$outputs=@();$script:SliceRuns++
    try{$outputs=@(& $slice)}catch{$failureType=$_.Exception.GetType().FullName;if($_.Exception.Message -cmatch '\A(?:worker|technical)_[a-z_]+\z'){$failureCode=$_.Exception.Message}}
    $delivery=if($outputs.Count -eq 1){$outputs[0]}else{$null}
    $deliveryValid=$null -ne $delivery -and $null -ne $delivery.PSObject.Properties['exitCode'] -and $null -ne $delivery.PSObject.Properties['value']
    $expectedCode=switch($case.mode){'ledger-error'{'worker_ledger_unknown'} 'privileges-error'{'worker_privilege_restore_unknown'}
        'lock-error'{'worker_operation_unknown'} 'second-lock-error'{'worker_operation_unknown'} default{'worker_startup_observation_unknown'}}
    $eligible=$case.action -ceq 'Upgrade' -and $case.stage -ceq 'settled' -and $case.mode -cne 'missing-upgrade-proof'
    $expectedConstructor=if($eligible -and $case.mode -cnotin @('ledger-error','readback-mismatch','readback-error')){1}else{0}
    $expectedWriter=if($expectedConstructor -eq 1 -and $case.mode -cnotin @('constructor-error','capture-error','privileges-error','lock-error','second-lock-error')){1}else{0}
    $expectedPublication=$expectedWriter -eq 1 -and $case.mode -cne 'writer-error'
    $expectedUnknownWrites=if($case.mode -cin @('capture-error','privileges-error')){2}else{1}
    $good=$null -eq $failureType -and $outputs.Count -eq 1 -and $deliveryValid -and
        $script:StartCalls -eq 1 -and $script:ConstructorCalls -eq $expectedConstructor -and $script:WriterCalls -eq $expectedWriter -and
        $script:UnknownWrites -eq $expectedUnknownWrites -and
        $script:DeadlineChecks -gt 0 -and $script:DeadlineViolations -eq 0 -and $script:Forbidden.Count -eq 0 -and
        @($script:DisposeCalls.Values|Where-Object {$_ -ne 1}).Count -eq 0 -and $null -eq $script:WorkerBearer
    if($deliveryValid){$good=$good -and $delivery.exitCode -eq 1 -and $delivery.value.code -ceq $expectedCode -and $delivery.value.outcome -ceq 'unknown'}
    $good=$good -and $script:Receipt.state -ceq 'unknown' -and $script:Receipt.operation.outcome -ceq 'unknown' -and
        $script:Receipt.operation.stage -ceq 'started' -and $script:Receipt.operation.action -ceq $case.action
    if($expectedConstructor -eq 1){
        $good=$good -and $script:ConstructorChecks -and $script:ReadbackIndependent -and $script:ReadbackGood -and
            $script:Events.IndexOf('unknown-written') -lt $script:Events.IndexOf('unknown-readback') -and
            $script:Events.IndexOf('unknown-readback') -lt $script:Events.IndexOf('constructor') -and
            $script:Events.IndexOf('constructor') -lt $script:Events.IndexOf('capture:dispose')
    }
    if($expectedWriter -eq 1){
        $good=$good -and $script:WriterChecks
        foreach($tag in @('capture','privileges','lock','second-lock')){$good=$good -and $script:Events.IndexOf($tag+':dispose') -lt $script:Events.IndexOf('proof-writer')}
    }
    $published=$null -ne $script:Candidate -and $null -ne $script:Candidate.PublishedPath -and $null -ne $script:Candidate.PublishedSha256
    $good=$good -and $published -eq $expectedPublication
    if($null -ne $script:Candidate -and $case.mode -cin @('capture-error','privileges-error','lock-error','second-lock-error')){
        $good=$good -and -not $script:Candidate.Closeout.captureReleased -and -not $script:Candidate.Closeout.privilegesRestored -and -not $script:Candidate.Closeout.installationLocksReleased
    }
    $rows.Add(@{kind='behavior';name=$case.name;passed=[bool]$good;outputCount=$outputs.Count;failureType=$failureType;fixedFailureCode=$failureCode;
        publicCode=$(if($deliveryValid){$delivery.value.code}else{$null});exitCode=$(if($deliveryValid){$delivery.exitCode}else{$null});
        originalStartCallSitesExecuted=$script:StartCalls;technicalUnknownWrites=$script:UnknownWrites;technicalReadbackCalls=$script:ReadbackCalls;
        readbackIndependent=$script:ReadbackIndependent;constructorCalls=$script:ConstructorCalls;writerCalls=$script:WriterCalls;
        candidateChecks=$script:ConstructorChecks;writerChecks=$script:WriterChecks;syntheticPublished=$published;
        deadlineChecks=$script:DeadlineChecks;deadlineViolations=$script:DeadlineViolations;forbiddenCalls=$script:Forbidden.ToArray();events=$script:Events.ToArray()})
}
Report 'startup_failure_proof_entry_controls_v1'
