param(
    [Parameter(Mandatory=$true)][string]$ModulePath,
    [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ModuleSha,
    [Parameter(Mandatory=$true)][string]$OutputPath
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
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
        $item -is [Management.Automation.Language.BinaryExpressionAst] -and
        $item.Operator -eq [Management.Automation.Language.TokenKind]::Ceq -and
        $item.Left -is [Management.Automation.Language.VariableExpressionAst] -and $item.Left.VariablePath.UserPath -ceq 'action' -and
        $item.Right -is [Management.Automation.Language.StringConstantExpressionAst] -and $item.Right.Value -ceq 'Upgrade'
    },$true)).Count -gt 0
}
$install=Source-Function 'Invoke-WorkerInstallation'
$outerTries=@($install.Body.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]})
if($outerTries.Count -ne 1 -or $outerTries[0].CatchClauses.Count -ne 1 -or $null -eq $outerTries[0].Finally){throw 'original_operation_owner_shape_changed'}
$outer=$outerTries[0]
$initial=(@($install.Body.EndBlock.Statements|Where-Object {$_.Extent.StartOffset -lt $outer.Extent.StartOffset})|ForEach-Object {$_.Extent.Text}) -join $nl
$tail=@($outer.Body.Statements|Select-Object -Last 3)
if($tail.Count -ne 3 -or $tail[0].Extent.Text -notmatch 'Get-WorkerRemainingMilliseconds' -or
    $tail[1].Extent.Text -notmatch 'Get-WorkerPublicResult' -or $tail[2] -isnot [Management.Automation.Language.ReturnStatementAst]){throw 'original_success_tail_changed'}
$tailText=($tail|ForEach-Object {$_.Extent.Text}) -join $nl
$rows=[Collections.Generic.List[object]]::new()
$names=@('upgrade_original_order_binding_and_scalar','upgrade_resume_same_original_window',
    'upgrade_writer_failure_preserves_normal_upgrade','upgrade_partial_writer_failure_loses_eligibility',
    'upgrade_legacy_without_evidence_remains_normal','upgrade_stop_exception_not_swallowed',
    'upgrade_backup_exception_not_swallowed','upgrade_ledger_exception_not_swallowed',
    'upgrade_stop_false_has_no_backup_writer_or_start','uninstall_never_writes_upgrade_evidence','rollback_never_writes_upgrade_evidence')
$writer=Source-Function 'Write-WorkerUpgradeEvidence'
$stop=Source-Function 'Stop-WorkerOwnedService'
$writerParams=@($writer.Body.ParamBlock.Parameters|ForEach-Object {$_.Name.VariablePath.UserPath})
$writerInterface=($writerParams -join ',') -ceq 'Evidence,Receipt,ReceiptPath,Backup,Deadline' -and
    $writer.Body.ParamBlock.Parameters[4].StaticType -eq [DateTime]
$stopParams=@($stop.Body.ParamBlock.Parameters|Where-Object {$_.Name.VariablePath.UserPath -ceq 'UpgradeEvidence'})
$stopInterface=$stopParams.Count -eq 1 -and $stopParams[0].StaticType -eq [ref]
$rows.Add(@{kind='interface';name='writer_five_parameter_interface';passed=$writerInterface})
$rows.Add(@{kind='interface';name='stop_optional_ref_interface';passed=$stopInterface})
$stopSites=@(Commands $outer.Body 'Stop-WorkerOwnedService')
$writerSites=@(Commands $outer.Body 'Write-WorkerUpgradeEvidence')
$stopOwner=$null;$upgradeBlock=$null;$bindingText='';$bindingFound=$false;$maintenanceText=$null
if($stopSites.Count -eq 1){
    $stopSite=$stopSites[0]
    $owners=@($outer.Body.FindAll({param($node)
        $node -is [Management.Automation.Language.IfStatementAst] -and @($node.Clauses|Where-Object {
            $_.Item1.Extent.StartOffset -le $stopSite.Extent.StartOffset -and $_.Item1.Extent.EndOffset -ge $stopSite.Extent.EndOffset
        }).Count -eq 1
    },$true))
    if($owners.Count -eq 1){
        $stopOwner=$owners[0]
        $afterStop=@($stopOwner.Parent.Statements|Where-Object {$_.Extent.StartOffset -gt $stopOwner.Extent.EndOffset}|Select-Object -First 1)
        if($afterStop.Count -eq 1 -and $afterStop[0] -is [Management.Automation.Language.IfStatementAst] -and
            @(Commands $afterStop[0] 'Get-WorkerPublicResult').Count -eq 1){$maintenanceText=$afterStop[0].Extent.Text}
        $clause=@($stopOwner.Clauses|Where-Object {$_.Item1.Extent.StartOffset -le $stopSite.Extent.StartOffset -and
            $_.Item1.Extent.EndOffset -ge $stopSite.Extent.EndOffset})[0]
        $dispatch=@($clause.Item2.Statements|Where-Object {$_ -is [Management.Automation.Language.IfStatementAst]})
        if($dispatch.Count -eq 1){
            $upgradeClauses=@($dispatch[0].Clauses|Where-Object {(Upgrade-Condition $_.Item1) -and @(Commands $_.Item2 'New-WorkerBackup').Count -eq 1})
            if($upgradeClauses.Count -eq 1){$upgradeBlock=$upgradeClauses[0].Item2}
        }
        $splats=@($stopSite.CommandElements|Where-Object {$_ -is [Management.Automation.Language.VariableExpressionAst] -and $_.Splatted})
        if($splats.Count -eq 1){
            $splatName=$splats[0].VariablePath.UserPath
            $binders=@($install.Body.FindAll({param($node)
                $node -is [Management.Automation.Language.AssignmentStatementAst] -and
                $node.Left -is [Management.Automation.Language.MemberExpressionAst] -and
                $node.Left.Expression -is [Management.Automation.Language.VariableExpressionAst] -and
                $node.Left.Expression.VariablePath.UserPath -ceq $splatName -and
                $node.Left.Member -is [Management.Automation.Language.StringConstantExpressionAst] -and $node.Left.Member.Value -ceq 'UpgradeEvidence'
            },$true))
            if($binders.Count -eq 1){
                $references=@($binders[0].Right.FindAll({param($node)
                    $node -is [Management.Automation.Language.ConvertExpressionAst] -and $node.Type.TypeName.FullName -ieq 'ref' -and
                    $node.Child -is [Management.Automation.Language.VariableExpressionAst]
                },$true))
                $parent=$binders[0].Parent
                while($null -ne $parent -and $parent -isnot [Management.Automation.Language.IfStatementAst]){$parent=$parent.Parent}
                if($references.Count -eq 1 -and $null -ne $parent -and $parent.Extent.EndOffset -lt $stopOwner.Extent.StartOffset -and
                    @($parent.Clauses|Where-Object {Upgrade-Condition $_.Item1}).Count -eq 1){
                    $evidenceName=$references[0].Child.VariablePath.UserPath
                    $setupParts=[Collections.Generic.List[string]]::new();$initializersGood=$true
                    foreach($entry in @(@{name=$splatName;value='@{}'},@{name=$evidenceName;value='$null'})){
                        $init=@($install.Body.FindAll({param($node)
                            $node -is [Management.Automation.Language.AssignmentStatementAst] -and
                            $node.Left -is [Management.Automation.Language.VariableExpressionAst] -and
                            $node.Left.VariablePath.UserPath -ceq $entry.name -and $node.Right.Extent.Text.Trim() -ceq $entry.value -and
                            $node.Extent.EndOffset -lt $parent.Extent.StartOffset
                        },$true)|Sort-Object {$_.Extent.StartOffset}|Select-Object -Last 1)
                        if($init.Count -ne 1){$initializersGood=$false}
                        elseif($init[0].Extent.StartOffset -ge $outer.Extent.StartOffset){$setupParts.Add($init[0].Extent.Text)}
                    }
                    if($initializersGood){$setupParts.Add($parent.Extent.Text);$bindingText=$setupParts -join $nl;$bindingFound=$true}
                }
            }
        }
    }
}
$writerInsideUpgrade=$writerSites.Count -eq 1 -and $null -ne $upgradeBlock -and
    $writerSites[0].Extent.StartOffset -ge $upgradeBlock.Extent.StartOffset -and $writerSites[0].Extent.EndOffset -le $upgradeBlock.Extent.EndOffset
$wiring=$stopSites.Count -eq 1 -and $null -ne $stopOwner -and $null -ne $maintenanceText -and $writerInsideUpgrade -and $bindingFound
$rows.Add(@{kind='wiring';name='one_original_stop_and_upgrade_only_writer_with_ref_setup';passed=$wiring;
    stopCallSites=$stopSites.Count;writerCallSites=$writerSites.Count;writerInsideUpgrade=$writerInsideUpgrade;originalRefSetupFound=$bindingFound})
$script:SliceRuns=0;$script:TechnicalNativeCompiled=$false
$scope='exact original Stop/action-dispatch and owner catch/finally with technical method sinks; no full installer validation, real Stop/backup/writer storage/SCM/Native/pins or recovery authority'
$sourceGate='original unique Stop is not duplicated; action-conditioned original empty ref setup precedes it; only append/bind/writer qualification work is in the evidence catch; original Stop, New-WorkerBackup and Save-WorkerStage errors still reach the original operation catch; no recovery authority'
function Report([string]$Code){
    $failed=@($rows|Where-Object {-not $_.passed});$behavior=@($rows|Where-Object {$_.kind -ceq 'behavior'})
    $observed=@($behavior|ForEach-Object {$_.name});$pending=@($names|Where-Object {$_ -cnotin $observed})
    $complete=$pending.Count -eq 0 -and $behavior.Count -eq $names.Count
    $report=@{code=$Code;moduleSha256=$ModuleSha;passed=$failed.Count -eq 0 -and $complete;rows=$rows.ToArray();
        passCount=$rows.Count-$failed.Count;failCount=$failed.Count;expectedBehaviorControls=$names.Count;
        behaviorPassCount=@($behavior|Where-Object {$_.passed}).Count;behaviorFailCount=@($behavior|Where-Object {-not $_.passed}).Count;
        pendingBehaviorControls=$pending.Count;pendingBehaviorNames=$pending;observedEntrySlices=$script:SliceRuns;
        technicalNativeCompiled=$script:TechnicalNativeCompiled;actualNativeCompiled=$false;actualStopExecuted=$false;actualBackupExecuted=$false;
        actualWriterStorageExecuted=$false;actualScmExercised=$false;actualVirtualServiceCrossSid=$false;actualFailureProof=$false;
        actualRecover=$false;actualGpu=$false;fullInstallerActionValidationExecuted=$false;
        nonAuthorSourceReviewRequired=$true;sourceReviewGate=$sourceGate;scope=$scope}
    $text=($report|ConvertTo-Json -Depth 14 -Compress)
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes($text+[char]10)
    $output=[IO.FileStream]::new($OutputPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try{$output.Write($bytes,0,$bytes.Length)}finally{$output.Dispose()}
    [Console]::WriteLine($text)
    if($failed.Count -gt 0 -or -not $complete){exit 1}
    exit 0
}
if(-not $writerInterface -or -not $stopInterface){Report 'upgrade_evidence_entry_interface_red'}
if(-not $wiring){Report 'upgrade_evidence_entry_wiring_red'}
# This type is an explicit static method sink, not the original Native implementation.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
namespace Zeb.WorkerInstall {
    public static class Native {
        public static string ExpectedPath, ExpectedHash;
        public static readonly List<string> HashPaths = new List<string>();
        public static int MoveCalls;
        public static string Hash(string path) {
            HashPaths.Add(path);
            if (!String.Equals(path, ExpectedPath, StringComparison.Ordinal)) throw new InvalidOperationException("technical_hash_path_changed");
            return ExpectedHash;
        }
        public static void MoveObject(string source, string destination) { MoveCalls++; }
    }
}
'@
$script:TechnicalNativeCompiled=$true
foreach($name in @('Save-WorkerStage','Get-WorkerPublicResult','Get-WorkerRemainingMilliseconds')){
    . ([scriptblock]::Create((Source-Function $name).Extent.Text))
}
function Event([string]$Value){$script:Events.Add($Value)}
function Disposable([string]$Tag){
    $value=[pscustomobject]@{Tag=$Tag}
    $value|Add-Member -MemberType ScriptMethod -Name Dispose -Value {Event ($this.Tag+':dispose')}
    return $value
}
function Deadline-Check([DateTime]$Deadline){
    $script:DeadlineChecks++
    if($Deadline.Ticks -ne $script:TestDeadline.Ticks -or $Deadline.Kind -ne [DateTimeKind]::Utc -or [DateTime]::UtcNow -ge $Deadline){
        $script:DeadlineViolations++;throw 'technical_deadline_changed'
    }
}
function Same-Receipt($Receipt,[string]$ReceiptPath){
    if(-not [object]::ReferenceEquals($Receipt,$script:Receipt) -or $ReceiptPath -cne 'technical:receipt'){throw 'technical_receipt_owner_changed'}
}
function Eligible($Value){
    return $null -ne $Value -and $null -ne $Value.PSObject.Properties['EvidencePath'] -and $null -ne $Value.PSObject.Properties['EvidenceSha256'] -and
        $null -ne $Value.EvidencePath -and $null -ne $Value.EvidenceSha256
}
function Reset-Case($Case){
    $script:Case=$Case;$script:Events=[Collections.Generic.List[string]]::new();$script:StageFacts=[Collections.Generic.List[object]]::new()
    $script:StopCalls=0;$script:BackupCalls=0;$script:WriterCalls=0;$script:StartCalls=0;$script:DeleteCalls=0
    $script:DeadlineChecks=0;$script:DeadlineViolations=0;$script:EvidenceRef=$null;$script:PublishedEvidence=$null;$script:WriterChecks=$false
    $script:StopRefWasEmpty=$false;$script:StartEligibility=$false;$script:BindingIndependent=$false;$script:UnknownLedgerCalls=0
    $script:Old=[pscustomobject]@{version='technical-v1';inventorySha256=('a'*64);imagePath='"C:\TechnicalNoFiles\program\technical-v1\WindowsServiceHost.exe"'}
    $script:Prior=[pscustomobject]@{version='technical-v0';inventorySha256=('b'*64);imagePath='"C:\TechnicalNoFiles\program\technical-v0\WindowsServiceHost.exe"'}
    $script:Receipt=[pscustomobject]@{installationId='00000000-0000-4000-8000-000000000001';serviceId='00000000-0000-4000-8000-000000000002';
        clientId='00000000-0000-4000-8000-000000000003';state='installed';programRoot='C:\TechnicalNoFiles\program';dataRoot='C:\TechnicalNoFiles\data';
        configSha256=('c'*64);active=$script:Old;previous=$script:Prior;lastStopped=$null;
        operation=[pscustomobject]@{operationId='00000000-0000-4000-8000-000000000004';action=$Case.action;stage='prepared';outcome='pending';maintenanceBootId=$null}}
    $script:Backup=[pscustomobject]@{path='C:\TechnicalNoFiles\backup\backup-receipt.json';
        value=[pscustomobject]@{sourceVersion='technical-v1';verified=$true}}
    $script:BackupJson=$script:Backup.value|ConvertTo-Json -Depth 64 -Compress
    $script:BackupPath=$script:Backup.path;$script:BackupSha=('d'*64)
    [Zeb.WorkerInstall.Native]::ExpectedPath=$script:BackupPath;[Zeb.WorkerInstall.Native]::ExpectedHash=$script:BackupSha
    [Zeb.WorkerInstall.Native]::HashPaths.Clear();[Zeb.WorkerInstall.Native]::MoveCalls=0
    $script:TestDeadline=[DateTime]::UtcNow.AddSeconds(10);$script:WorkerUnresolvedProcessIdentity=$null
}
function Stop-WorkerOwnedService($Receipt,[string]$ReceiptPath,[DateTime]$Deadline,[bool]$Resume,[ref]$UpgradeEvidence){
    Event 'stop';$script:StopCalls++;Deadline-Check $Deadline;Same-Receipt $Receipt $ReceiptPath
    if($Resume -ne $script:Case.resume){throw 'technical_resume_changed'}
    if($Receipt.operation.action -ceq 'Upgrade'){
        if(-not $PSBoundParameters.ContainsKey('UpgradeEvidence') -or $null -eq $UpgradeEvidence -or $null -ne $UpgradeEvidence.Value){throw 'technical_upgrade_stop_ref_not_empty'}
        $script:StopRefWasEmpty=$true;$script:EvidenceRef=$UpgradeEvidence
    }elseif($PSBoundParameters.ContainsKey('UpgradeEvidence')){throw 'technical_nonupgrade_evidence_ref_added'}
    if($script:Case.mode -ceq 'stop-error'){throw 'worker_identity_unknown'}
    if($script:Case.mode -ceq 'stop-false'){$Receipt.operation.stage='maintenance';$Receipt.operation.outcome='known';return $false}
    $Receipt.operation.stage='stopped';$Receipt.operation.outcome='known';$Receipt.lastStopped=[pscustomobject]@{pinsExclusive=$true}
    if($Receipt.operation.action -ceq 'Upgrade' -and $script:Case.mode -cne 'legacy'){
        $script:PublishedEvidence=[pscustomobject]@{OperationId=$Receipt.operation.operationId;OldActive=[pscustomobject]@{
            version=$Receipt.active.version;inventorySha256=$Receipt.active.inventorySha256;imagePath=$Receipt.active.imagePath};
            MaintenanceDtoRaw=[byte[]]@(123,125);MaintenanceDtoSha256=('e'*64);First=[pscustomobject]@{technical=1};Second=[pscustomobject]@{technical=2};
            ScmStopCalls=1;HostExitCode=[uint32]0;NodeExitCode=[uint32]0;PinsExclusive=$true}
        $UpgradeEvidence.Value=$script:PublishedEvidence
    }
    return $true
}
function New-WorkerBackup($Receipt,[string]$BackupRoot,[DateTime]$Deadline){
    Event 'backup';$script:BackupCalls++;Deadline-Check $Deadline
    if(-not [object]::ReferenceEquals($Receipt,$script:Receipt) -or $Receipt.operation.stage -cne 'stopped' -or
        $Receipt.operation.outcome -cne 'known' -or -not [object]::ReferenceEquals($Receipt.active,$script:Old)){throw 'technical_backup_wrong_owner_or_order'}
    if($script:Case.action -ceq 'Upgrade' -and $BackupRoot -cne 'C:\TechnicalNoFiles\backup'){throw 'technical_backup_root_changed'}
    if($script:Case.mode -ceq 'backup-error'){throw 'worker_backup_invalid'}
    return $script:Backup
}
function Write-WorkerUpgradeEvidence($Evidence,$Receipt,$ReceiptPath,$Backup,[DateTime]$Deadline){
    Event 'writer';$script:WriterCalls++;Deadline-Check $Deadline;Same-Receipt $Receipt $ReceiptPath
    if(-not [object]::ReferenceEquals($Evidence,$script:PublishedEvidence) -or -not [object]::ReferenceEquals($Backup,$script:Backup) -or
        -not [object]::ReferenceEquals($Evidence.BackupResult,$script:Backup) -or $Receipt.operation.stage -cne 'stopped' -or
        $Receipt.operation.outcome -cne 'known' -or -not [object]::ReferenceEquals($Receipt.active,$script:Old) -or
        $null -ne $Evidence.EvidencePath -or $null -ne $Evidence.EvidenceSha256){throw 'technical_writer_wrong_original_owner_or_order'}
    $binding=$Evidence.BackupBinding
    if($null -eq $binding -or [object]::ReferenceEquals($binding,$Backup) -or [object]::ReferenceEquals($binding,$Backup.value) -or
        $binding.path -cne $script:BackupPath -or $binding.valueJson -isnot [string] -or $binding.valueJson -cne $script:BackupJson -or
        $binding.receiptSha256 -cne $script:BackupSha -or [Zeb.WorkerInstall.Native]::HashPaths.Count -ne 1 -or
        [Zeb.WorkerInstall.Native]::HashPaths[0] -cne $script:BackupPath){throw 'technical_backup_binding_not_independent'}
    $Backup.path='technical:mutated';$Backup.value.sourceVersion='mutated'
    try{$script:BindingIndependent=$binding.path -ceq $script:BackupPath -and $binding.valueJson -ceq $script:BackupJson -and $binding.receiptSha256 -ceq $script:BackupSha}
    finally{$Backup.path=$script:BackupPath;$Backup.value.sourceVersion='technical-v1'}
    if(-not $script:BindingIndependent){throw 'technical_binding_changed_with_result'}
    $script:WriterChecks=$true
    if($script:Case.mode -ceq 'writer-error'){throw 'worker_upgrade_evidence_invalid'}
    $Evidence.EvidencePath='technical:verified-backup';$Evidence.EvidenceSha256=('f'*64)
    if($script:Case.mode -ceq 'writer-partial-error'){throw 'worker_upgrade_evidence_invalid'}
}
function Write-WorkerLedger([string]$Path,$Value){
    Same-Receipt $Value $Path
    Event ('ledger:'+$Value.operation.stage+':'+$Value.operation.outcome)
    $script:StageFacts.Add(@{stage=$Value.operation.stage;outcome=$Value.operation.outcome;active=$Value.active.version})
    if($Value.state -ceq 'unknown'){$script:UnknownLedgerCalls++}
    if($script:Case.mode -ceq 'ledger-error' -and $Value.operation.stage -ceq 'backed_up' -and $Value.operation.outcome -ceq 'known'){throw 'worker_ledger_unknown'}
}
function Test-WorkerInstalledPayload($PayloadRoot,$ExpectedInventorySha256,$ExpectedConfigSha256){Event 'payload:checked';return [pscustomobject]@{verified=$true}}
function Start-WorkerOwnedService($Receipt,[string]$ReceiptPath,[DateTime]$Deadline,[switch]$Switch,[ref]$StartupCapture){
    Event 'start';$script:StartCalls++;Deadline-Check $Deadline;Same-Receipt $Receipt $ReceiptPath
    if(-not $Switch -or $null -eq $StartupCapture -or $null -ne $StartupCapture.Value -or
        $Receipt.operation.stage -cne 'backed_up' -or $Receipt.operation.outcome -cne 'pending'){throw 'technical_start_owner_or_stage_changed'}
    if($script:Case.action -ceq 'Upgrade'){
        if($Receipt.active.version -cne 'technical-v2' -or -not [object]::ReferenceEquals($Receipt.previous,$script:Old)){throw 'technical_upgrade_active_switch_changed'}
        $script:StartEligibility=Eligible $script:EvidenceRef.Value
    }elseif($Receipt.active.version -cne 'technical-v0' -or -not [object]::ReferenceEquals($Receipt.previous,$script:Old)){throw 'technical_rollback_active_switch_changed'}
    $Receipt.state='installed';$Receipt.operation.stage='started';$Receipt.operation.outcome='known'
}
function Invoke-WorkerScmChange([string]$Action,[string]$ImagePath,[DateTime]$Deadline){
    Event ('scm:'+ $Action);Deadline-Check $Deadline
    if($Action -cne 'Delete'){throw 'technical_unexpected_scm_sink_action'}
    $script:DeleteCalls++
}
function Get-WorkerVersionRoot($ProgramRoot,$Version){return [IO.Path]::Combine($ProgramRoot,$Version)}
function Remove-WorkerOwnedTree($Path){Event 'tree:remove'}
function Copy-WorkerSnapshot($Source,$Destination,$Manifest,[DateTime]$Deadline){Event 'snapshot:copy';Deadline-Check $Deadline}
function Test-WorkerSnapshotDatabase($Root,$Receipt,[DateTime]$Deadline){Event 'snapshot:database';Deadline-Check $Deadline}
function Restore-WorkerSnapshotMetadata($Root,$Manifest){Event 'snapshot:metadata'}
function New-WorkerCallerDirectory($Path){Event 'directory:create'}
$setup=@'
$receipt=$script:Receipt;$receiptPath='technical:receipt';$data=$receipt.dataRoot;$program=$receipt.programRoot
$deadline=$script:TestDeadline;$action=$script:Case.action;$resume=$script:Case.resume;$operationId=$receipt.operation.operationId
$ledgerOwned=$true;$privileges=Disposable 'privileges';$lock=Disposable 'lock'
$backupRoot='C:\TechnicalNoFiles\backup';$versionRoot='C:\TechnicalNoFiles\program\technical-v2'
$package=[pscustomobject]@{version='technical-v2'};$Request=@{ExpectedInventorySha256=('1'*64)}
$selectedBackup=[pscustomobject]@{value=[pscustomobject]@{root='C:\TechnicalNoFiles\archive\selected';sourceVersion='technical-v0';sourceInventorySha256=('b'*64)};manifest=[pscustomobject]@{technical=$true}}
'@
# Execute exact source fragments; original preflight/whole action validation is outside this boundary.
$slice=[scriptblock]::Create($initial+$nl+$setup+$nl+$bindingText+$nl+'try {'+$nl+$stopOwner.Extent.Text+$nl+$maintenanceText+$nl+$tailText+$nl+'} '+
    $outer.CatchClauses[0].Extent.Text+' finally '+$outer.Finally.Extent.Text)
$cases=@(
    @{name=$names[0];action='Upgrade';mode='normal';resume=$false},
    @{name=$names[1];action='Upgrade';mode='normal';resume=$true},
    @{name=$names[2];action='Upgrade';mode='writer-error';resume=$false},
    @{name=$names[3];action='Upgrade';mode='writer-partial-error';resume=$false},
    @{name=$names[4];action='Upgrade';mode='legacy';resume=$false},
    @{name=$names[5];action='Upgrade';mode='stop-error';resume=$false},
    @{name=$names[6];action='Upgrade';mode='backup-error';resume=$false},
    @{name=$names[7];action='Upgrade';mode='ledger-error';resume=$false},
    @{name=$names[8];action='Upgrade';mode='stop-false';resume=$false},
    @{name=$names[9];action='Uninstall';mode='normal';resume=$false},
    @{name=$names[10];action='Rollback';mode='normal';resume=$false}
)
foreach($case in $cases){
    Reset-Case $case;$failureType=$null;$failureCode=$null;$outputs=@();$script:SliceRuns++
    try{$outputs=@(& $slice)}catch{$failureType=$_.Exception.GetType().FullName;if($_.Exception.Message -cmatch '\A(?:worker|technical)_[a-z_]+\z'){$failureCode=$_.Exception.Message}}
    $delivery=if($outputs.Count -eq 1){$outputs[0]}else{$null}
    $deliveryValid=$null -ne $delivery -and $null -ne $delivery.PSObject.Properties['exitCode'] -and $null -ne $delivery.PSObject.Properties['value']
    $good=$null -eq $failureType -and $outputs.Count -eq 1 -and $deliveryValid -and
        $script:StopCalls -eq 1 -and $script:DeadlineChecks -gt 0 -and $script:DeadlineViolations -eq 0 -and
        @($script:Events|Where-Object {$_ -ceq 'privileges:dispose'}).Count -eq 1 -and @($script:Events|Where-Object {$_ -ceq 'lock:dispose'}).Count -eq 1
    $stopAt=$script:Events.IndexOf('stop');$backupAt=$script:Events.IndexOf('backup');$writerAt=$script:Events.IndexOf('writer')
    $knownAt=$script:Events.IndexOf('ledger:backed_up:known');$pendingAt=$script:Events.IndexOf('ledger:backed_up:pending');$startAt=$script:Events.IndexOf('start')
    if($case.action -ceq 'Upgrade'){$good=$good -and $script:StopRefWasEmpty}
    if($case.mode -cin @('stop-error','backup-error','ledger-error')){
        $expectedCode=switch($case.mode){'stop-error'{'worker_identity_unknown'} 'backup-error'{'worker_backup_invalid'} 'ledger-error'{'worker_ledger_unknown'}}
        $expectedBackup=if($case.mode -ceq 'stop-error'){0}else{1};$expectedWriter=if($case.mode -ceq 'ledger-error'){1}else{0}
        $good=$good -and $delivery.exitCode -eq 1 -and $delivery.value.outcome -ceq 'unknown' -and $delivery.value.code -ceq $expectedCode -and
            $script:BackupCalls -eq $expectedBackup -and $script:WriterCalls -eq $expectedWriter -and $script:StartCalls -eq 0 -and
            [object]::ReferenceEquals($script:Receipt.active,$script:Old) -and $script:UnknownLedgerCalls -eq 1
    }elseif($case.mode -ceq 'stop-false'){
        $good=$good -and $delivery.exitCode -eq 1 -and $delivery.value.outcome -ceq 'known' -and $delivery.value.code -ceq 'worker_not_quiescent' -and
            $script:BackupCalls -eq 0 -and $script:WriterCalls -eq 0 -and $script:StartCalls -eq 0
    }elseif($case.action -ceq 'Uninstall'){
        $good=$good -and $delivery.exitCode -eq 0 -and $delivery.value.outcome -ceq 'known' -and $script:Receipt.state -ceq 'retained' -and
            $script:BackupCalls -eq 0 -and $script:WriterCalls -eq 0 -and $script:StartCalls -eq 0 -and $script:DeleteCalls -eq 1
    }elseif($case.action -ceq 'Rollback'){
        $good=$good -and $delivery.exitCode -eq 0 -and $delivery.value.outcome -ceq 'known' -and
            $script:BackupCalls -eq 1 -and $script:WriterCalls -eq 0 -and $script:StartCalls -eq 1 -and [Zeb.WorkerInstall.Native]::MoveCalls -eq 10 -and
            $script:Receipt.active.version -ceq 'technical-v0'
    }else{
        $expectedWriter=if($case.mode -ceq 'legacy'){0}else{1};$expectedEligible=$case.mode -ceq 'normal'
        $good=$good -and $delivery.exitCode -eq 0 -and $delivery.value.code -ceq 'worker_operation_complete' -and $delivery.value.outcome -ceq 'known' -and
            $script:BackupCalls -eq 1 -and $script:WriterCalls -eq $expectedWriter -and $script:StartCalls -eq 1 -and $script:UnknownLedgerCalls -eq 0 -and
            $backupAt -gt $stopAt -and $knownAt -gt $backupAt -and $pendingAt -gt $knownAt -and $startAt -gt $pendingAt -and
            $script:Receipt.active.version -ceq 'technical-v2' -and $script:StartEligibility -eq $expectedEligible
        $stageKnown=@($script:StageFacts|Where-Object {$_.stage -ceq 'backed_up' -and $_.outcome -ceq 'known'})
        $stagePending=@($script:StageFacts|Where-Object {$_.stage -ceq 'backed_up' -and $_.outcome -ceq 'pending'})
        $good=$good -and $stageKnown.Count -eq 1 -and $stageKnown[0].active -ceq 'technical-v1' -and
            $stagePending.Count -eq 1 -and $stagePending[0].active -ceq 'technical-v2'
        if($expectedWriter -eq 1){$good=$good -and $writerAt -gt $backupAt -and $writerAt -lt $knownAt -and $script:WriterChecks -and $script:BindingIndependent}
        else{$good=$good -and [Zeb.WorkerInstall.Native]::HashPaths.Count -eq 0}
    }
    $rows.Add(@{kind='behavior';name=$case.name;passed=$good;outputCount=$outputs.Count;failureType=$failureType;fixedFailureCode=$failureCode;
        publicCode=$(if($deliveryValid){$delivery.value.code}else{$null});exitCode=$(if($deliveryValid){$delivery.exitCode}else{$null});
        stopCalls=$script:StopCalls;backupCalls=$script:BackupCalls;writerCalls=$script:WriterCalls;startCalls=$script:StartCalls;
        stopRefWasEmpty=$script:StopRefWasEmpty;bindingIndependent=$script:BindingIndependent;eligibleAtStart=$script:StartEligibility;
        deadlineChecks=$script:DeadlineChecks;deadlineViolations=$script:DeadlineViolations;events=$script:Events.ToArray()})
}
Report 'upgrade_evidence_entry_controls_v1'
