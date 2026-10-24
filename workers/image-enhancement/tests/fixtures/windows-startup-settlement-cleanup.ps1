param([Parameter(Mandatory=$true)][string]$ModulePath,[Parameter(Mandatory=$true)][string]$ModuleSha)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
if($PSVersionTable.PSVersion.Major -ne 5 -or $null -ne ('Zeb.WorkerInstall.Native' -as [type])){throw 'fresh_winps5_required'}
if((Get-FileHash -LiteralPath $ModulePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ModuleSha){throw 'module_changed'}
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($ModulePath,[ref]$tokens,[ref]$errors)
if($errors.Count -ne 0){throw 'module_syntax_invalid'}
$initializers=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Initialize-WorkerInstallNative'},$true))
if($initializers.Count -ne 1){throw 'native_initializer_not_unique'}
& $initializers[0].Body.GetScriptBlock()
$native='Zeb.WorkerInstall.Native' -as [type]
$read=$native.GetMethod('ReadStartupFrame',[type[]]@([byte[]],[string]))
if($null -eq $read){throw 'existing_parser_required'}
$operation='a1111111-1111-4111-8111-111111111111';$attempt='b2222222-2222-4222-8222-222222222222'
$nonce='b'*64;$sha='a'*64
$identity=[ordered]@{pid=17;creationFileTime='9007199254740993'}
$phase=[ordered]@{v=1;kind='startup_phase';attempt=$attempt;nonce=$nonce;phase='store_schema_incompatible';
    runnerConstructed=$false;listenerSucceeded=$false;recoveryCalled=$false;claimEntered=$false;prepareEntered=$false;authorizeEntered=$false}
$stream=[ordered]@{bytesRead=0;eof=$true;readFailureType=$null;sinkFailureType=$null}
$settled=[ordered]@{v=1;kind='settled';seq=4;nonce=$nonce;operationId=$operation;startupAttemptId=$attempt;
    preparedSha256=$sha;host=$identity;node=$identity;phase=$phase;jobName=$null;sealed=$null;ownerReleasedTreeActive=$null;
    forceCalls=1;failureType='InvalidOperationException';cleanup=[ordered]@{rootExit=$null;treeExit=$null;stdout=$stream;stderr=$stream}}
$base=$settled|ConvertTo-Json -Depth 10 -Compress
function With-Fields([string]$Fields){return $base.Substring(0,$base.Length-1)+','+$Fields+'}'}
$cases=@(
    @{name='legacy_full_shape_remains_diagnostic';text=$base;accept=$true;extended=$false},
    @{name='complete_cleanup_fields';text=(With-Fields '"cleanupFailureCount":0,"ownerReleaseCompleted":true');accept=$true;extended=$true;count=0;released=$true},
    @{name='incomplete_cleanup_is_preserved_as_diagnostic';text=(With-Fields '"cleanupFailureCount":2,"ownerReleaseCompleted":false');accept=$true;extended=$true;count=2;released=$false},
    @{name='maximum_cleanup_count';text=(With-Fields '"cleanupFailureCount":2147483647,"ownerReleaseCompleted":true');accept=$true;extended=$true;count=2147483647;released=$true},
    @{name='missing_release_field';text=(With-Fields '"cleanupFailureCount":0');accept=$false},
    @{name='missing_count_field';text=(With-Fields '"ownerReleaseCompleted":true');accept=$false},
    @{name='negative_cleanup_count';text=(With-Fields '"cleanupFailureCount":-1,"ownerReleaseCompleted":true');accept=$false},
    @{name='overflow_cleanup_count';text=(With-Fields '"cleanupFailureCount":2147483648,"ownerReleaseCompleted":true');accept=$false},
    @{name='fractional_cleanup_count';text=(With-Fields '"cleanupFailureCount":1.5,"ownerReleaseCompleted":true');accept=$false},
    @{name='string_cleanup_count';text=(With-Fields '"cleanupFailureCount":"0","ownerReleaseCompleted":true');accept=$false},
    @{name='null_cleanup_count';text=(With-Fields '"cleanupFailureCount":null,"ownerReleaseCompleted":true');accept=$false},
    @{name='string_release';text=(With-Fields '"cleanupFailureCount":0,"ownerReleaseCompleted":"true"');accept=$false},
    @{name='null_release';text=(With-Fields '"cleanupFailureCount":0,"ownerReleaseCompleted":null');accept=$false},
    @{name='unknown_extra_field';text=(With-Fields '"cleanupFailureCount":0,"ownerReleaseCompleted":true,"extra":0');accept=$false},
    @{name='duplicate_cleanup_count';text=(With-Fields '"cleanupFailureCount":0,"cleanupFailureCount":0,"ownerReleaseCompleted":true');accept=$false}
)
$rows=[Collections.Generic.List[object]]::new()
foreach($case in $cases){
    $accepted=$false;$refused=$false;$result=$null;$failureType=$null
    try{
        $arguments=[object[]]::new(2);$arguments[0]=[Text.UTF8Encoding]::new($false,$true).GetBytes($case.text);$arguments[1]='settled'
        $result=$read.Invoke($null,$arguments);$accepted=$true
    }catch{
        $reason=$_.Exception;while($null -ne $reason.InnerException){$reason=$reason.InnerException}
        $failureType=$reason.GetType().Name
        $refused=$reason -is [IO.InvalidDataException] -and $reason.Message -ceq 'worker_startup_observation_invalid'
    }
    $good=if($case.accept){$accepted -and $result -is [Collections.IDictionary]}else{-not $accepted -and $refused}
    if($good -and $case.accept){
        if($case.extended){
            $good=$result.ContainsKey('cleanupFailureCount') -and $result['cleanupFailureCount'] -is [long] -and
                $result['cleanupFailureCount'] -eq $case.count -and $result.ContainsKey('ownerReleaseCompleted') -and
                $result['ownerReleaseCompleted'] -is [bool] -and $result['ownerReleaseCompleted'] -eq $case.released
        }else{$good=-not $result.ContainsKey('cleanupFailureCount') -and -not $result.ContainsKey('ownerReleaseCompleted')}
    }
    $rows.Add(@{name=$case.name;passed=[bool]$good;accepted=$accepted;expectedAccept=$case.accept;failureType=$failureType})
}
$failed=@($rows|Where-Object {-not $_.passed})
if((Get-FileHash -LiteralPath $ModulePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ModuleSha){throw 'module_changed_during_controls'}
@{code='startup_settlement_cleanup_shape_v1';moduleSha256=$ModuleSha;passCount=$rows.Count-$failed.Count;failCount=$failed.Count;
    rows=$rows.ToArray();actualHostCleanup=$false;actualScm=$false;actualFailureProof=$false;actualRecover=$false;
    scope='pure production parser shape only; diagnostic acceptance never establishes cleanup facts or recovery authority'}|ConvertTo-Json -Depth 8 -Compress
if($failed.Count -gt 0){exit 1};exit 0
