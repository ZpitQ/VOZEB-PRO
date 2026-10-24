param([Parameter(Mandatory=$true)][string]$ModulePath,[Parameter(Mandatory=$true)][string]$ModuleSha)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
if($PSVersionTable.PSVersion.Major -ne 5 -or $null -ne ('Zeb.WorkerInstall.Native' -as [type])){throw 'fresh_winps5_required'}
if((Get-FileHash -LiteralPath $ModulePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ModuleSha){throw 'module_changed'}
$module=Import-Module -Name $ModulePath -Force -PassThru
$helper=& $module {$ExecutionContext.SessionState.InvokeCommand.GetCommand('Assert-WorkerStartupFailurePins',[Management.Automation.CommandTypes]::Function)}
$names=@('matching_capture_uses_native_boundaries','actual_host_code_mismatch_refused','actual_node_code_mismatch_refused',
    'service_sid_mismatch_refused','service_session_mismatch_refused','payload_path_mismatch_refused',
    'caller_context_mismatch_refused','disposed_capture_refused','utc_deadline_refused','monotonic_cutoff_refused',
    'caller_native_refusal_preserved','exit_native_refusal_preserved','captured_exit_type_mismatch_refused')
if($null -eq $helper -or $null -eq $helper.Module -or $helper.Module.Path -cne $module.Path -or
    $module.ExportedFunctions.ContainsKey('Assert-WorkerStartupFailurePins')){
    @{code='failure_pins_interface_red';passed=$false;interfacePassCount=0;interfaceFailCount=1;pendingNames=$names;
      actualNative=$false;actualOriginalHandles=$false;actualScm=$false}|ConvertTo-Json -Compress
    exit 1
}
# Dependency sinks exercise the imported private consumer; real native handles are a separate gate.
Add-Type -TypeDefinition @'
using System;
using System.IO;
namespace Zeb.WorkerInstall {
  public sealed class ProcessPin {
    public int pid,sessionId; public string creationFileTime,imagePath,tokenUserSid;
    public uint ObservedCode;
  }
  public static class Native {
    public static bool RejectCaller,RejectRead;
    public static int CallerChecks,ExitReads;
    public static long TickCount64() { return 1000; }
    public static void RequireStartupPin(ProcessPin pin) {
      CallerChecks++; if(RejectCaller) throw new InvalidDataException("worker_identity_unknown");
    }
    public static uint ReadStartupExitCode(ProcessPin pin) {
      ExitReads++; if(RejectRead) throw new InvalidDataException("worker_identity_unknown");
      return pin.ObservedCode;
    }
  }
}
'@
function New-Pin($Id,$Image,$Sid,$Session,$Code){
    $pin=[Zeb.WorkerInstall.ProcessPin]::new();$pin.pid=$Id;$pin.imagePath=$Image;$pin.tokenUserSid=$Sid
    $pin.sessionId=$Session;$pin.creationFileTime='123456789';$pin.ObservedCode=$Code;return $pin
}
$rows=[Collections.Generic.List[object]]::new()
foreach($name in $names){
    [Zeb.WorkerInstall.Native]::RejectCaller=$false;[Zeb.WorkerInstall.Native]::RejectRead=$false
    [Zeb.WorkerInstall.Native]::CallerChecks=0;[Zeb.WorkerInstall.Native]::ExitReads=0
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    try{$callerSid=$identity.User.Value}finally{$identity.Dispose()}
    $process=[Diagnostics.Process]::GetCurrentProcess()
    try{$callerSession=$process.SessionId;$callerPath=$process.MainModule.FileName}finally{$process.Dispose()}
    $sid='S-1-5-80-1-2-3-4-5';$hostPath='C:\Technical\Host.exe';$nodePath='C:\Technical\runtime\node.exe'
    $caller=New-Pin $PID $callerPath $callerSid $callerSession 0
    $context=@{cutoffTick64=[long]30000;expectedServiceSid=$sid;caller=@{pid=$PID;creationFileTime=$caller.creationFileTime;
        imagePath=$callerPath;imageSha256=('a'*64);tokenUserSid=$callerSid;sessionId=$callerSession}}
    $capture=[pscustomobject]@{Disposed=$false;Stage='settled';Context=$context;
        CallerPin=[pscustomobject]@{Pin=$caller;ImageSha256=('a'*64)};
        HostPin=(New-Pin 17 $hostPath $sid 0 1);NodePin=(New-Pin 18 $nodePath $sid 0 2);
        ExpectedServiceSid=$sid;HostPath=$hostPath;NodePath=$nodePath;
        HostExited=$true;NodeExited=$true;HostExitCode=[uint32]1;NodeExitCode=[uint32]2}
    $receipt=[pscustomobject]@{tokenUserSid=$sid;sessionId=0;serviceName='ZebImageEnhancement';accountName='NT SERVICE\ZebImageEnhancement'}
    $deadline=[DateTime]::UtcNow.AddSeconds(15)
    switch($name){
        'actual_host_code_mismatch_refused'{$capture.HostPin.ObservedCode=0}
        'actual_node_code_mismatch_refused'{$capture.NodePin.ObservedCode=0}
        'service_sid_mismatch_refused'{$capture.NodePin.tokenUserSid='S-1-5-80-5-4-3-2-1'}
        'service_session_mismatch_refused'{$capture.HostPin.sessionId=1}
        'payload_path_mismatch_refused'{$capture.NodePin.imagePath='C:\Technical\other.exe'}
        'caller_context_mismatch_refused'{$context.caller.creationFileTime='123456788'}
        'disposed_capture_refused'{$capture.Disposed=$true}
        'utc_deadline_refused'{$deadline=[DateTime]::UtcNow.AddMilliseconds(-1)}
        'monotonic_cutoff_refused'{$context.cutoffTick64=[long]999}
        'caller_native_refusal_preserved'{[Zeb.WorkerInstall.Native]::RejectCaller=$true}
        'exit_native_refusal_preserved'{[Zeb.WorkerInstall.Native]::RejectRead=$true}
        'captured_exit_type_mismatch_refused'{$capture.HostExitCode=[int]1}
    }
    $before=$capture|ConvertTo-Json -Depth 12 -Compress
    $accepted=$false;$failure=$null;$output=@()
    try{$output=@(& $module {param($Capture,$Receipt,[DateTime]$Deadline) Assert-WorkerStartupFailurePins $Capture $Receipt $Deadline} $capture $receipt $deadline);$accepted=$true}
    catch{$failure=$_.Exception;while($null -ne $failure.InnerException){$failure=$failure.InnerException}}
    $preserved=$before -ceq ($capture|ConvertTo-Json -Depth 12 -Compress)
    $good=if($name -ceq 'matching_capture_uses_native_boundaries'){
        $accepted -and $output.Count -eq 0 -and [Zeb.WorkerInstall.Native]::CallerChecks -ge 2 -and [Zeb.WorkerInstall.Native]::ExitReads -eq 2 -and $preserved
    }else{-not $accepted -and $null -ne $failure -and $failure.Message -cmatch '\Aworker_[a-z_]+\z' -and $preserved}
    $rows.Add(@{name=$name;passed=[bool]$good;accepted=$accepted;capturePreserved=$preserved;
        nativeCallerCalls=[Zeb.WorkerInstall.Native]::CallerChecks;nativeExitCalls=[Zeb.WorkerInstall.Native]::ExitReads;
        code=$(if($null -ne $failure){$failure.Message}else{$null})})
}
if((Get-FileHash -LiteralPath $ModulePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ModuleSha){throw 'module_changed'}
$failed=@($rows|Where-Object {-not $_.passed})
@{code='failure_pins_consumer_controls_v1';moduleSha256=$ModuleSha;passed=$failed.Count -eq 0;passCount=$rows.Count-$failed.Count;
  failCount=$failed.Count;rows=$rows.ToArray();actualImportedConsumer=$true;technicalNativeSinks=$true;
  actualNative=$false;actualOriginalHandles=$false;actualServiceSidOrSessionZero=$false;actualScm=$false;actualFailureProof=$false;
  actualRecover=$false;actualGpu=$false;scope='imported private pin consumer with explicit native method sinks; no original handles, service or failure qualification'}|ConvertTo-Json -Depth 8 -Compress
if($failed.Count -ne 0){exit 1}
