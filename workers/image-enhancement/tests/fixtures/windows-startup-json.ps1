param([Parameter(Mandatory=$true)][string]$ModulePath,[Parameter(Mandatory=$true)][string]$ModuleSha)
$ErrorActionPreference='Stop'
Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
if($PSVersionTable.PSVersion.Major -ne 5 -or $null -ne ('Zeb.WorkerInstall.Native' -as [type])){throw 'fresh_winps5_required'}
if((Get-FileHash -LiteralPath $ModulePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ModuleSha){throw 'module_changed'}
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($ModulePath,[ref]$tokens,[ref]$errors)
if($errors.Count -ne 0){throw 'module_syntax_invalid'}
$initializers=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Initialize-WorkerInstallNative'},$true))
if($initializers.Count -ne 1){throw 'initializer_not_unique'}
& $initializers[0].Body.GetScriptBlock()
$native='Zeb.WorkerInstall.Native' -as [type]
$contextMethod=$native.GetMethod('ReadStartupContext',[type[]]@([byte[]]))
$frameMethod=$native.GetMethod('ReadStartupFrame',[type[]]@([byte[]],[string]))
if($null -eq $contextMethod -or $null -eq $frameMethod){
    @{available=$false;passed=0;failed=2;scope='parser interface missing; no rejection counted as passing'}|ConvertTo-Json -Compress
    exit 1
}
$utf8=[Text.UTF8Encoding]::new($false,$true)
$hash='a'*64;$nonce='b'*64
$operationId='a1111111-1111-4111-8111-111111111111'
$attemptId='b2222222-2222-4222-8222-222222222222'
$context=[ordered]@{v=1;operationId=$operationId;startupAttemptId=$attemptId;startingReceiptSha256=$hash;
    pipeName='zeb-worker-startup-v1-b2222222222242228222222222222222';nonce=$nonce;cutoffTick64=1234567890;
    caller=[ordered]@{pid=17;creationFileTime='9007199254740993';imagePath='C:\Zeb Technical\caller.exe';imageSha256=$hash;
        tokenUserSid='S-1-5-21-1-2-3-1001';sessionId=1};expectedServiceSid='S-1-5-80-1-2-3-4-5';
    inventorySha256=$hash;configSha256=$hash;engineManifestSha256=$hash;hostSha256=$hash;nodeSha256=$hash}
$hostIdentity=[ordered]@{pid=17;creationFileTime='9007199254740993'}
$nodeIdentity=[ordered]@{pid=18;creationFileTime='18446744073709551615'}
$prepared=[ordered]@{v=1;kind='prepared';seq=1;nonce=$nonce;operationId=$operationId;startupAttemptId=$attemptId;
    startingReceiptSha256=$hash;host=$hostIdentity;node=$nodeIdentity;jobName='Local\Zeb-technical';inventorySha256=$hash;
    configSha256=$hash;engineManifestSha256=$hash;hostSha256=$hash;nodeSha256=$hash;
    inspection=[ordered]@{processSignaled=$false;inOriginalJob=$true;activeProcesses=1;totalProcesses=1;
        jobHandleFlags=0;processHandleFlags=0;authorized=$false;sealed=$false}}
$ack=[ordered]@{v=1;kind='ack_prepared';seq=2;nonce=$nonce;operationId=$operationId;startupAttemptId=$attemptId;
    preparedSha256=$hash;host=$hostIdentity;node=$nodeIdentity}
$authorized=[ordered]@{v=1;kind='authorized';seq=3;nonce=$nonce;operationId=$operationId;startupAttemptId=$attemptId;
    preparedSha256=$hash;host=$hostIdentity;node=$nodeIdentity;authorized=$true}
$phase=[ordered]@{v=1;kind='startup_phase';attempt=$attemptId;nonce=$nonce;phase='listening';runnerConstructed=$true;
    listenerSucceeded=$true;recoveryCalled=$false;claimEntered=$false;prepareEntered=$false;authorizeEntered=$false}
$ready=[ordered]@{v=1;kind='ready';seq=4;nonce=$nonce;operationId=$operationId;startupAttemptId=$attemptId;
    preparedSha256=$hash;host=$hostIdentity;node=$nodeIdentity;phase=$phase}
$settledPhase=[ordered]@{v=1;kind='startup_phase';attempt=$attemptId;nonce=$nonce;phase='store_schema_incompatible';runnerConstructed=$false;
    listenerSucceeded=$false;recoveryCalled=$false;claimEntered=$false;prepareEntered=$false;authorizeEntered=$false}
$stream=[ordered]@{bytesRead=0;eof=$true;readFailureType=$null;sinkFailureType=$null}
$settled=[ordered]@{v=1;kind='settled';seq=4;nonce=$nonce;operationId=$operationId;startupAttemptId=$attemptId;
    preparedSha256=$hash;host=$hostIdentity;node=$nodeIdentity;phase=$settledPhase;jobName=$null;sealed=$null;
    ownerReleasedTreeActive=$null;forceCalls=0;failureType=$null;
    cleanup=[ordered]@{rootExit=$null;treeExit=$null;stdout=$stream;stderr=$stream}}
$contextText=$context|ConvertTo-Json -Depth 8 -Compress
$preparedText=$prepared|ConvertTo-Json -Depth 8 -Compress
$readyText=$ready|ConvertTo-Json -Depth 8 -Compress
$settledText=$settled|ConvertTo-Json -Depth 8 -Compress
$cases=[Collections.Generic.List[object]]::new()
function Add-Vector([string]$Name,[string]$Text,[bool]$Accept,[string]$Shape='prepared'){
    $cases.Add(@{name=$Name;body=$utf8.GetBytes($Text);accept=$Accept;shape=$Shape})
}
function Changed([string]$Source,[string]$Needle,[string]$Replacement){
    if(-not $Source.Contains($Needle) -or $Needle -ceq $Replacement){throw 'mutation_did_not_change_input'}
    return $Source.Replace($Needle,$Replacement)
}
Add-Vector 'context' $contextText $true 'context'
Add-Vector 'prepared' $preparedText $true
Add-Vector 'ack' ($ack|ConvertTo-Json -Depth 8 -Compress) $true 'ack_prepared'
Add-Vector 'authorized' ($authorized|ConvertTo-Json -Depth 8 -Compress) $true 'authorized'
Add-Vector 'ready' $readyText $true 'ready'
Add-Vector 'nullable_settled_capture' $settledText $true 'settled'
Add-Vector 'single_escaped_key' (Changed $preparedText '"v":1' '"\u0076":1') $true
Add-Vector 'duplicate_escaped_key' (Changed $preparedText '"v":1' '"v":1,"\u0076":1') $false
Add-Vector 'nested_duplicate_key' (Changed $preparedText '"pid":17' '"pid":17,"\u0070id":17') $false
Add-Vector 'metadata_key' $preparedText.Insert(1,'"__type":"Wire",') $false
Add-Vector 'unknown_key' $preparedText.Insert(1,'"unexpected":0,') $false
Add-Vector 'wrong_case_key' (Changed $preparedText '"v":1' '"V":1') $false
foreach($literal in @('01','+1','1.0','1e0','NaN','9223372036854775808')){
    Add-Vector ('bad_version_'+$literal) (Changed $preparedText '"v":1' ('"v":'+$literal)) $false
}
Add-Vector 'signed_negative_zero' (Changed $contextText '"sessionId":1' '"sessionId":-0') $true 'context'
Add-Vector 'unsigned_negative_zero' (Changed $preparedText '"activeProcesses":1' '"activeProcesses":-0') $false
Add-Vector 'unsigned_overflow' (Changed $preparedText '"activeProcesses":1' '"activeProcesses":4294967296') $false
Add-Vector 'creation_not_string' (Changed $preparedText '"creationFileTime":"9007199254740993"' '"creationFileTime":9007199254740993') $false
Add-Vector 'relative_image_path' (Changed $contextText 'C:\\Zeb Technical\\caller.exe' 'C:caller.exe') $false 'context'
Add-Vector 'bad_phase_relation' (Changed $readyText '"listenerSucceeded":true' '"listenerSucceeded":false') $false 'ready'
Add-Vector 'trailing_document' ($preparedText+'{}') $false
Add-Vector 'trailing_comma' ($preparedText.Substring(0,$preparedText.Length-1)+',}') $false
Add-Vector 'unpaired_surrogate' (Changed $preparedText 'Local\\Zeb-technical' '\uD800') $false
Add-Vector 'paired_surrogate' (Changed $preparedText 'Local\\Zeb-technical' '\uD83D\uDE00') $true
$invalidUtf8=[byte[]](@(0xc0,0xaf))
$cases.Add(@{name='invalid_utf8';body=$invalidUtf8;accept=$false;shape='prepared'})
$cases.Add(@{name='bom';body=[byte[]](@(239,187,191)+$utf8.GetBytes($preparedText));accept=$false;shape='prepared'})
foreach($length in @(4096,4097)){
    $bytes=[byte[]]::new($length);$original=$utf8.GetBytes($contextText);[Array]::Copy($original,$bytes,$original.Length)
    for($index=$original.Length;$index -lt $length;$index++){$bytes[$index]=32}
    $cases.Add(@{name=('context_bytes_'+$length);body=$bytes;accept=($length -eq 4096);shape='context'})
}
$rows=[Collections.Generic.List[object]]::new()
foreach($case in $cases){
    $accepted=$false;$correctRejection=$false;$projection=$null;$failure=$null
    try{
        if($case.shape -ceq 'context'){$arguments=[object[]]::new(1);$arguments[0]=$case.body;$projection=$contextMethod.Invoke($null,$arguments)}
        else{$arguments=[object[]]::new(2);$arguments[0]=$case.body;$arguments[1]=$case.shape;$projection=$frameMethod.Invoke($null,$arguments)}
        $accepted=$true
    }catch{
        $reason=$_.Exception;while($null -ne $reason.InnerException){$reason=$reason.InnerException}
        $failure=$reason.GetType().Name
        $correctRejection=$reason -is [IO.InvalidDataException] -and $reason.Message -ceq 'worker_startup_observation_invalid'
    }
    $passed=if($case.accept){$accepted -and $projection -is [Collections.IDictionary] -and $projection.ContainsKey('v') -and -not $projection.ContainsKey('V')}
        else{-not $accepted -and $correctRejection}
    if($passed -and $case.name -ceq 'context'){
        $actualCreation=$projection['caller']['creationFileTime']
        $passed=$actualCreation -is [string] -and [string]::Equals($actualCreation,'9007199254740993',[StringComparison]::Ordinal)
    }
    if($passed -and $case.name -ceq 'prepared'){
        $actualCreation=$projection['node']['creationFileTime']
        $passed=$actualCreation -is [string] -and [string]::Equals($actualCreation,'18446744073709551615',[StringComparison]::Ordinal)
    }
    if($passed -and $case.name -ceq 'nullable_settled_capture'){
        $passed=$projection.ContainsKey('sealed') -and $null -eq $projection['sealed'] -and
            $projection['cleanup'].ContainsKey('rootExit') -and $null -eq $projection['cleanup']['rootExit']
    }
    if($passed -and $case.name -ceq 'paired_surrogate'){
        $actualJobName=$projection['jobName']
        $passed=$actualJobName -is [string] -and [string]::Equals($actualJobName,[char]::ConvertFromUtf32(128512),[StringComparison]::Ordinal)
    }
    $rows.Add(@{name=$case.name;passed=[bool]$passed;accepted=$accepted;correctRejection=$correctRejection;failureType=$failure})
}
$failed=@($rows|Where-Object {-not $_.passed})
@{available=$true;passed=$rows.Count-$failed.Count;failed=$failed.Count;controls=$rows.ToArray();
    scope='pure fixed-shape Native JSON parser; no SCM, caller binding, pipe, process or ACK'}|ConvertTo-Json -Depth 8 -Compress
if($failed.Count -gt 0){exit 1}
exit 0
