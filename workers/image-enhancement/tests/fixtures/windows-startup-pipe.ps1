param(
    [Parameter(Mandatory=$true)][string]$ModulePath,
    [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ModuleSha,
    [Parameter(Mandatory=$true)][string]$OutputPath
)
$ErrorActionPreference='Stop'
Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
Set-StrictMode -Version Latest
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
if($PSVersionTable.PSVersion.Major -ne 5){throw 'actual_windows_powershell_5_required'}
if((Get-FileHash -LiteralPath $ModulePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ModuleSha.ToLowerInvariant()){throw 'module_preimage_changed'}
if($null -ne ('Zeb.WorkerInstall.Native' -as [type])){throw 'fresh_process_native_type_already_loaded'}
if(Test-Path -LiteralPath $OutputPath){throw 'output_already_exists'}

function Save-ProbeReport($Report) {
    $text=($Report|ConvertTo-Json -Depth 12)+"`n"
    $raw=[Text.UTF8Encoding]::new($false).GetBytes($text)
    $output=[IO.FileStream]::new($OutputPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try{$output.Write($raw,0,$raw.Length)}finally{$output.Dispose()}
    [Console]::WriteLine($text)
}

# Execute only the exact original initializer, not module top-level/installation/SCM functions.
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($ModulePath,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count -ne 0){throw 'module_parser_failed'}
$initializers=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Initialize-WorkerInstallNative'},$true))
if($initializers.Count -ne 1){throw 'native_initializer_not_unique'}
. ([scriptblock]::Create($initializers[0].Extent.Text))
Initialize-WorkerInstallNative
$native='Zeb.WorkerInstall.Native' -as [type]
$publicStatic=[Reflection.BindingFlags]::Public -bor [Reflection.BindingFlags]::Static
$publicInstance=[Reflection.BindingFlags]::Public -bor [Reflection.BindingFlags]::Instance
$nonpublicInstance=[Reflection.BindingFlags]::NonPublic -bor [Reflection.BindingFlags]::Instance
$factory=$native.GetMethod('NewStartupPipe',$publicStatic)
$clock=$native.GetMethod('TickCount64',$publicStatic)
$missing=[Collections.Generic.List[string]]::new()
if($null -eq $factory){$missing.Add('Native.NewStartupPipe(string,long)')}
if($null -eq $clock){$missing.Add('Native.TickCount64()')}
if($missing.Count -gt 0){
    Save-ProbeReport @{code='startup_pipe_primitives_interface_red';moduleSha256=$ModuleSha;missing=$missing.ToArray();passed=$false;
        actualPipeCases=0;nativeInitializerCompiled=$true;scope='missing API only; no pipe/SCM/principal/behavior claim'}
    exit 1
}
$parameters=$factory.GetParameters()
if($parameters.Count -ne 2 -or $parameters[0].ParameterType -ne [string] -or $parameters[1].ParameterType -ne [long] -or
    $clock.GetParameters().Count -ne 0 -or $clock.ReturnType -ne [long]){throw 'factory_must_not_accept_principal_or_permission_parameters'}
$pipeType=$factory.ReturnType
if($pipeType.GetConstructors($publicInstance).Count -ne 0){throw 'public_pipe_constructor_not_allowed'}
$ctor=$pipeType.GetConstructor($nonpublicInstance,$null,[type[]]@([string],[long],[Security.Principal.SecurityIdentifier],[Security.Principal.SecurityIdentifier]),$null)
if($null -eq $ctor){throw 'natural_nonpublic_ctor_missing_interface_red'}
foreach($method in @('Accept','ReadFrame','WriteAck','RequireEof','Dispose')){if($null -eq $pipeType.GetMethod($method,$publicInstance)){throw ('pipe_method_missing_interface_red:'+ $method)}}
if($null -eq $pipeType.GetProperty('PipeName',$publicInstance) -or $null -eq $pipeType.GetProperty('ClientProcessId',$publicInstance)){throw 'pipe_properties_missing_interface_red'}
$readMethod=$pipeType.GetMethod('ReadFrame',$publicInstance);$writeMethod=$pipeType.GetMethod('WriteAck',$publicInstance)
if($readMethod.ReturnType -ne [byte[]] -or $readMethod.GetParameters().Count -ne 1 -or $readMethod.GetParameters()[0].ParameterType -ne [int] -or
    $writeMethod.ReturnType -ne [void] -or $writeMethod.GetParameters().Count -ne 1 -or $writeMethod.GetParameters()[0].ParameterType -ne [byte[]]){throw 'bounded_frame_interface_changed'}
foreach($method in @('Accept','RequireEof','Dispose')){if($pipeType.GetMethod($method,$publicInstance).GetParameters().Count -ne 0){throw 'single_pipe_no_retry_interface_changed'}}
if($pipeType.GetProperty('PipeName',$publicInstance).PropertyType -ne [string] -or
    $pipeType.GetProperty('ClientProcessId',$publicInstance).PropertyType -ne [int] -or
    $null -ne $pipeType.GetProperty('PipeName',$publicInstance).GetSetMethod() -or
    $null -ne $pipeType.GetProperty('ClientProcessId',$publicInstance).GetSetMethod()){throw 'pipe_identity_must_be_read_only'}

$probeSource=Join-Path $PSScriptRoot 'windows-startup-pipe-probe.cs'
$probeSha=(Get-FileHash -LiteralPath $probeSource -Algorithm SHA256).Hash.ToLowerInvariant()
Add-Type -TypeDefinition ([IO.File]::ReadAllText($probeSource)) -ErrorAction Stop
$user=[Security.Principal.WindowsIdentity]::GetCurrent()
try{
    if($user.ImpersonationLevel -ne [Security.Principal.TokenImpersonationLevel]::None -or $null -eq $user.User){throw 'technical_owner_must_be_real_current_token_user'}
    $ownerSid=$user.User
}finally{$user.Dispose()}
$technicalSid=[Security.Principal.SecurityIdentifier]::new('S-1-5-12')
if($ownerSid.Equals($technicalSid)){throw 'technical_second_sid_must_be_distinct'}
$rows=[Collections.Generic.List[object]]::new()

function Now {return [long]$clock.Invoke($null,[object[]]@())}
function Deadline-Error([string]$Name) {return $Name -cin @('TimeoutException','OperationCanceledException','TaskCanceledException')}
function Root-Error($ErrorObject) {
    $errorValue=$ErrorObject.Exception
    while($null -ne $errorValue.InnerException){$errorValue=$errorValue.InnerException}
    return $errorValue.GetType().Name
}
function Frame([byte[]]$Body) {
    $wire=[byte[]]::new(4+$Body.Length)
    [BitConverter]::GetBytes([uint32]$Body.Length).CopyTo($wire,0);$Body.CopyTo($wire,4)
    return ,$wire
}
function New-TechnicalPipe([long]$Cutoff) {
    $attempt=[Guid]::NewGuid().ToString('D')
    $pipe=$ctor.Invoke([object[]]@($attempt,$Cutoff,$ownerSid,$technicalSid))
    # Natural implementation stream only; no public test handle getter is added to the product.
    $streams=@($pipeType.GetFields($nonpublicInstance)|Where-Object {$_.FieldType -eq [IO.Pipes.NamedPipeServerStream]})
    if($streams.Count -ne 1){$pipe.Dispose();throw 'one_private_native_server_stream_required'}
    $stream=$streams[0].GetValue($pipe)
    if($pipe.PipeName -cne ('zeb-worker-startup-v1-'+$attempt.Replace('-',''))){$pipe.Dispose();throw 'pipe_leaf_not_bound_to_canonical_attempt'}
    return [pscustomobject]@{pipe=$pipe;handle=$stream.SafePipeHandle;cutoff=$Cutoff;calls=[Collections.Generic.List[object]]::new()}
}
function Call-Pipe($Record,[string]$Name,[object[]]$Arguments=@()) {
    $result=[Zeb.StartupPipeProbe.Probe]::Call($Record.pipe,$Name,$Arguments,4000)
    $Record.calls.Add($result.Invocation)
    return $result
}
function Exact-Inspection($Actual) {
    if($Actual.Owner -cne $ownerSid.Value -or -not $Actual.Protected -or -not $Actual.DaclPresent -or
        -not $Actual.NonInherited -or -not $Actual.ServerEnd -or -not $Actual.ByteType -or $Actual.MaximumInstances -ne 1 -or $Actual.Aces.Count -ne 2){return $false}
    $expected=@{};$expected[$ownerSid.Value]=0x001f019f;$expected[$technicalSid.Value]=0x0012019b
    foreach($ace in $Actual.Aces){
        if(-not $expected.ContainsKey($ace.Sid) -or $ace.Qualifier -cne 'AccessAllowed' -or $ace.Flags -ne 0 -or
            $ace.Callback -or $ace.Mask -ne $expected[$ace.Sid]){return $false}
        $expected.Remove($ace.Sid)
    }
    return $expected.Count -eq 0
}

# Independent native clock and actual constructor refusal, separate from API/compile preparation.
$tickBefore=[Zeb.StartupPipeProbe.Probe]::Tick();$nativeTick=Now;$tickAfter=[Zeb.StartupPipeProbe.Probe]::Tick()
$rows.Add(@{name='clock_matches_native_tick64';passed=$nativeTick -ge $tickBefore -and $nativeTick -le $tickAfter;before=$tickBefore;actual=$nativeTick;after=$tickAfter})
$expired=$false;$expiredType=$null
try{$unexpected=New-TechnicalPipe ((Now)-1);$unexpected.pipe.Dispose()}catch{$expiredType=Root-Error $_;$expired=Deadline-Error $expiredType}
$rows.Add(@{name='expired_before_create';passed=$expired;errorType=$expiredType;scope='nonpublic production constructor with technical SIDs'})

$small=Frame ([Text.Encoding]::UTF8.GetBytes('{}'))
$drip=Frame ([Text.Encoding]::UTF8.GetBytes('abcdefghijklmnop'))
$badBody=[byte[]]@(4,0,0,0,0x61,0x62)
$badUtf8=Frame ([byte[]]@(0xc3,0x28))
$tail=[byte[]]($small+[byte[]]@(0x21))
$cases=@(
    @{name='positive_fragmented_one_ack';wire=$small;chunks=[int[]]@(1,1,2,2);pause=20;budget=1500;ack=$true},
    @{name='duplicate_accept_refused';wire=$small;chunks=[int[]]@(6);pause=0;budget=1500;duplicateAccept=$true},
    @{name='duplicate_ack_refused';wire=$small;chunks=[int[]]@(6);pause=0;budget=1500;ack=$true;duplicateAck=$true},
    @{name='partial_header_eof';wire=[byte[]]@(2,0);chunks=[int[]]@(2);pause=0;budget=1500;error='EndOfStreamException'},
    @{name='partial_body_eof';wire=$badBody;chunks=[int[]]@(6);pause=0;budget=1500;error='EndOfStreamException'},
    @{name='zero_length';wire=[byte[]]@(0,0,0,0);chunks=[int[]]@(4);pause=0;budget=1500;error='InvalidDataException'},
    @{name='over_8192_before_body';wire=[byte[]]@(1,32,0,0);chunks=[int[]]@(4);pause=0;budget=1500;error='InvalidDataException'},
    @{name='over_1024_before_body';wire=[byte[]]@(1,4,0,0);chunks=[int[]]@(4);pause=0;budget=1500;maximum=1024;error='InvalidDataException'},
    @{name='invalid_utf8';wire=$badUtf8;chunks=[int[]]@(6);pause=0;budget=1500;error='utf8'},
    @{name='trailing_byte_not_eof';wire=$tail;chunks=[int[]]@(7);pause=0;budget=1500;tail=$true},
    @{name='drip_cannot_reset_first_cutoff';wire=$drip;chunks=[int[]]@(4,8,8);pause=150;budget=220;error='deadline'},
    @{name='accept_no_client_cutoff';wire=[byte[]]@();chunks=[int[]]@();pause=0;budget=120;noClient=$true},
    @{name='write_after_first_cutoff';wire=$small;chunks=[int[]]@(6);pause=0;budget=200;lateWrite=$true;hold=300},
    @{name='eof_after_first_cutoff';wire=$small;chunks=[int[]]@(6);pause=0;budget=200;lateEof=$true}
)
foreach($case in $cases){
    $record=$null;$client=$null;$clientResult=$null;$inspection=$null;$read=$null;$accept=$null;$extra=$null
    $good=$true;$failure=$null;$closed=$false;$joined=$true;$pendingOwnerTasks=0;$details=@{}
    try{
        $record=New-TechnicalPipe ((Now)+[long]$case.budget)
        $inspection=[Zeb.StartupPipeProbe.Probe]::Inspect($record.handle)
        $good=$good -and (Exact-Inspection $inspection)
        if($case.name -ceq 'positive_fragmented_one_ack'){
            $first=[Zeb.StartupPipeProbe.Probe]::Duplicate($record.pipe.PipeName,$true)
            $second=[Zeb.StartupPipeProbe.Probe]::Duplicate($record.pipe.PipeName,$false)
            $details.duplicateWithFirst=$first;$details.duplicateWithoutFirst=$second
            $good=$good -and -not $first.Created -and -not $second.Created -and $first.HandleClosed -and $second.HandleClosed
        }
        if(-not $case.ContainsKey('noClient')){
            $hold=if($case.ContainsKey('hold')){[int]$case.hold}else{0}
            $ack=$case.ContainsKey('ack') -and [bool]$case.ack
            $client=[Zeb.StartupPipeProbe.Probe]::Client($record.pipe.PipeName,$case.wire,$case.chunks,[int]$case.pause,$hold,$ack)
        }
        $accept=Call-Pipe $record 'Accept'
        $good=$good -and -not $accept.Watchdog
        if($accept.Watchdog){throw 'probe_accept_watchdog'}
        if($case.ContainsKey('noClient')){
            $good=$good -and (Deadline-Error $accept.ErrorType) -and (Now) -ge $record.cutoff
        }else{
            $good=$good -and $null -eq $accept.ErrorType -and [int]$record.pipe.ClientProcessId -eq $PID
            if($null -ne $accept.ErrorType){throw 'accept_failed_before_frame_gate'}
            $client.Send()
            $maximum=if($case.ContainsKey('maximum')){[int]$case.maximum}else{8192}
            $read=Call-Pipe $record 'ReadFrame' ([object[]]@([int]$maximum))
            $good=$good -and -not $read.Watchdog
            if($read.Watchdog){throw 'probe_read_watchdog'}
            if($case.ContainsKey('error')){
                if($case.error -ceq 'utf8'){$good=$good -and $read.ErrorType -cin @('DecoderFallbackException','InvalidDataException')}
                elseif($case.error -ceq 'deadline'){$good=$good -and (Deadline-Error $read.ErrorType) -and (Now) -ge $record.cutoff}
                else{$good=$good -and $read.ErrorType -ceq $case.error}
            }else{
                $expected=if($case.ContainsKey('tail')){$small}else{$case.wire}
                $good=$good -and $null -eq $read.ErrorType -and [Convert]::ToBase64String([byte[]]$read.Value) -ceq [Convert]::ToBase64String($expected)
                if($case.ContainsKey('ack')){
                    $ackArgs=[object[]]::new(1);$ackArgs[0]=$small
                    $write=Call-Pipe $record 'WriteAck' $ackArgs
                    $good=$good -and -not $write.Watchdog -and $null -eq $write.ErrorType
                    if($write.Watchdog){throw 'probe_write_watchdog'}
                }
                if($case.ContainsKey('lateWrite') -or $case.ContainsKey('lateEof')){[Zeb.StartupPipeProbe.Probe]::Until($record.cutoff)}
                if($case.ContainsKey('duplicateAccept') -or $case.ContainsKey('duplicateAck')){
                    if(-not [Zeb.StartupPipeProbe.Probe]::Joined($client.Completion,1000)){throw 'probe_client_before_duplicate_unjoined'}
                    $method=if($case.ContainsKey('duplicateAccept')){'Accept'}else{'WriteAck'}
                    $methodArgs=[object[]]@()
                    if($case.ContainsKey('duplicateAck')){$methodArgs=[object[]]::new(1);$methodArgs[0]=$small}
                    $extra=Call-Pipe $record $method $methodArgs
                    $good=$good -and -not $extra.Watchdog -and $extra.ErrorType -ceq 'InvalidOperationException'
                }elseif($case.ContainsKey('lateWrite')){
                    $ackArgs=[object[]]::new(1);$ackArgs[0]=$small
                    $extra=Call-Pipe $record 'WriteAck' $ackArgs
                    $good=$good -and -not $extra.Watchdog -and (Deadline-Error $extra.ErrorType) -and (Now) -ge $record.cutoff
                }else{
                    $extra=Call-Pipe $record 'RequireEof'
                    $expectedError=if($case.ContainsKey('tail')){'InvalidDataException'}elseif($case.ContainsKey('lateEof')){'deadline'}else{$null}
                    $good=$good -and -not $extra.Watchdog
                    if($expectedError -ceq 'deadline'){$good=$good -and (Deadline-Error $extra.ErrorType) -and (Now) -ge $record.cutoff}
                    else{$good=$good -and $extra.ErrorType -ceq $expectedError}
                }
            }
        }
    }catch{$good=$false;$failure=Root-Error $_}
    finally{
        if($null -ne $record){
            if($null -ne $client){$client.Send()}
            $dispose=Call-Pipe $record 'Dispose'
            $good=$good -and -not $dispose.Watchdog -and $null -eq $dispose.ErrorType
            $closed=$record.handle.IsClosed;$good=$good -and $closed
            foreach($operation in $record.calls){$oneJoined=[Zeb.StartupPipeProbe.Probe]::Joined($operation,1000);$joined=$joined -and $oneJoined}
            foreach($field in $pipeType.GetFields($nonpublicInstance)){
                if([Threading.Tasks.Task].IsAssignableFrom($field.FieldType)){
                    $ownerTask=$field.GetValue($record.pipe)
                    if($null -ne $ownerTask -and -not $ownerTask.IsCompleted){$pendingOwnerTasks++}
                }
            }
        }
        if($null -ne $client){
            $clientJoined=[Zeb.StartupPipeProbe.Probe]::Joined($client.Completion,3000);$joined=$joined -and $clientJoined
            if($clientJoined){$clientResult=$client.Completion.GetAwaiter().GetResult();$client.Dispose();$good=$good -and $clientResult.HandleClosed -and $null -eq $clientResult.CleanupErrorType}
            if($case.ContainsKey('ack')){$good=$good -and $null -ne $clientResult -and $null -eq $clientResult.ErrorType -and $clientResult.AckBase64 -ceq [Convert]::ToBase64String($small)}
            if($case.name -ceq 'drip_cannot_reset_first_cutoff'){
                $target=$null -ne $read -and $null -ne $clientResult -and $clientResult.BytesWritten -ge 12 -and $clientResult.WriteTicks.Count -ge 2 -and
                    $clientResult.WriteTicks[0] -lt $record.cutoff -and $clientResult.WriteTicks[1] -lt $record.cutoff -and
                    $read.StartedTick -gt 0 -and $read.StartedTick -lt $clientResult.WriteTicks[1] -and $read.FinishedTick -ge $record.cutoff
                $details.dripProgressTargetReached=$target;$good=$good -and $target
            }
        }
        $good=$good -and $joined -and $pendingOwnerTasks -eq 0
    }
    $rows.Add(@{name=$case.name;passed=$good;failure=$failure;inspection=$inspection;details=$details;
        acceptError=if($null -ne $accept){$accept.ErrorType}else{$null};readError=if($null -ne $read){$read.ErrorType}else{$null};
        cutoffTick64=if($null -ne $record){$record.cutoff}else{$null};
        sentWireBase64=[Convert]::ToBase64String($case.wire);
        readWireBase64=if($null -ne $read -and $null -ne $read.Value){[Convert]::ToBase64String([byte[]]$read.Value)}else{$null};
        readStartedTick=if($null -ne $read){$read.StartedTick}else{$null};readFinishedTick=if($null -ne $read){$read.FinishedTick}else{$null};
        extraError=if($null -ne $extra){$extra.ErrorType}else{$null};serverHandleClosed=$closed;allProbeTasksJoined=$joined;
        pendingReflectedOwnerTasks=$pendingOwnerTasks;client=$clientResult;
        scope='nonpublic ctor; current owner ACE transport plus extra technical SID ACL structure only'})
}
$failed=@($rows|Where-Object {-not $_.passed})
Save-ProbeReport @{code='startup_pipe_primitives_controls_v2';moduleSha256=$ModuleSha;probeSourceSha256=$probeSha;
    passed=$failed.Count -eq 0;passCount=$rows.Count-$failed.Count;failCount=$failed.Count;rows=$rows.ToArray();
    publicFactoryExecuted=$false;actualVirtualServiceCrossSid=$false;actualScmExercised=$false;
    firstInstanceFlagIndependentlyProven=$false;rejectRemoteIndependentlyProven=$false;
    scope='WinPS5 real local pipes from same nonpublic production ctor; bottom ACL/ownerACE/frame/cutoff controls only';
    remaining='source review must confirm first-instance/reject-remote actual native arguments; real fixed-factory/cross-SID SCM acceptance remains separate'}
if($failed.Count -ne 0){exit 1}
exit 0
