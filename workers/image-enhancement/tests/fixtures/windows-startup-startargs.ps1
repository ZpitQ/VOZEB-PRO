param([Parameter(Mandatory=$true)][string]$ModulePath,[Parameter(Mandatory=$true)][string]$ModuleSha)
# Tests only: run the real SCM function body with its sole controller constructor replaced by a method sink.
$ErrorActionPreference='Stop'
# Node can inherit another PowerShell edition's module search path.
Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
if((Get-FileHash -LiteralPath $ModulePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ModuleSha){throw 'module_changed'}
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($ModulePath,[ref]$tokens,[ref]$errors)
if($errors.Count -ne 0){throw 'module_syntax_invalid'}
$functions=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Invoke-WorkerScmChange'},$true))
if($functions.Count -ne 1){throw 'actual_scm_function_changed'}
$function=$functions[0]
$parameterPresent=@($function.Body.ParamBlock.Parameters|Where-Object {$_.Name.VariablePath.UserPath -ceq 'StartupArguments'}).Count -eq 1
$bodyText=$function.Body.Extent.Text
$constructor="`$service = [System.ServiceProcess.ServiceController]::new('ZebImageEnhancement')"
$constructorAt=$bodyText.IndexOf($constructor,[StringComparison]::Ordinal)
if($constructorAt -lt 0 -or $bodyText.IndexOf($constructor,$constructorAt+$constructor.Length,[StringComparison]::Ordinal) -ge 0){throw 'actual_service_constructor_changed'}
$bodyText=$bodyText.Replace($constructor,'$script:controllerConstructions++; $service = $script:startupServiceSink')
$body=[scriptblock]::Create($bodyText.Substring(1,$bodyText.Length-2))
function Get-WorkerRemainingMilliseconds {param($Deadline) return 1000}
function Assert-WorkerLiveGeneration {throw 'control_stop_generation_reached'}
function Invoke-WorkerFixedProcess {$script:fixedProcessCalls++;throw 'control_fixed_process_reached'}
function Get-WorkerServiceRow {throw 'control_service_query_reached'}

# This is deliberately not a valid production Context: only the transport-shaped Start layer is under test.
$technicalContext=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{"technical":true}')).TrimEnd('=').Replace('+','-').Replace('/','_')
$oversizedContext=[Convert]::ToBase64String([byte[]]::new(4097)).TrimEnd('=').Replace('+','-').Replace('/','_')
$marker='zeb-startup-observe-v1'
$cases=@(
    @{name='ordinary_start_zero_args';action='Start';arguments=$null;refuse=$false;expected=@()},
    @{name='observed_start_exact_two_args';action='Start';arguments=@($marker,$technicalContext);refuse=$false;expected=@($marker,$technicalContext)},
    @{name='empty_vector_refused';action='Start';arguments=@();refuse=$true},
    @{name='one_argument_refused';action='Start';arguments=@($marker);refuse=$true},
    @{name='three_arguments_refused';action='Start';arguments=@($marker,$technicalContext,'extra');refuse=$true},
    @{name='wrong_marker_case_refused';action='Start';arguments=@('ZEB-startup-observe-v1',$technicalContext);refuse=$true},
    @{name='empty_context_refused';action='Start';arguments=@($marker,'');refuse=$true},
    @{name='whitespace_context_refused';action='Start';arguments=@($marker,' ');refuse=$true},
    @{name='padding_context_refused';action='Start';arguments=@($marker,($technicalContext+'='));refuse=$true},
    @{name='non_url_context_refused';action='Start';arguments=@($marker,'+/8');refuse=$true},
    @{name='impossible_base64_length_refused';action='Start';arguments=@($marker,'A');refuse=$true},
    @{name='noncanonical_pad_bits_refused';action='Start';arguments=@($marker,'AB');refuse=$true},
    @{name='over_4096_decoded_bytes_refused';action='Start';arguments=@($marker,$oversizedContext);refuse=$true},
    @{name='observation_on_stop_refused';action='Stop';arguments=@($marker,$technicalContext);refuse=$true},
    @{name='observation_on_delete_refused';action='Delete';arguments=@($marker,$technicalContext);refuse=$true}
)
$controls=[Collections.Generic.List[object]]::new()
foreach($case in $cases){
    $script:startCalls=[Collections.Generic.List[object]]::new()
    $script:waitCalls=0;$script:stopCalls=0;$script:disposeCalls=0
    $script:controllerConstructions=0;$script:fixedProcessCalls=0
    $script:startupServiceSink=[pscustomobject]@{}
    $script:startupServiceSink|Add-Member -MemberType ScriptMethod -Name Start -Value {
        $captured=@()
        if($args.Count -eq 1 -and $args[0] -is [array]){$captured=@($args[0])}
        elseif($args.Count -gt 0){$captured=@($args)}
        $script:startCalls.Add(@{arguments=$captured})
    }
    $script:startupServiceSink|Add-Member -MemberType ScriptMethod -Name WaitForStatus -Value {param($Status,$Budget) $script:waitCalls++}
    $script:startupServiceSink|Add-Member -MemberType ScriptMethod -Name Stop -Value {$script:stopCalls++}
    $script:startupServiceSink|Add-Member -MemberType ScriptMethod -Name Dispose -Value {$script:disposeCalls++}
    $invocation=@{Action=$case.action;Deadline=[DateTime]::UtcNow.AddSeconds(1);StartupArguments=$case.arguments}
    $threw=$false;$failure=$null
    try {& $body @invocation} catch {$threw=$true;$failure=$_.Exception.Message}
    $actual=if($script:startCalls.Count -eq 1){@($script:startCalls[0].arguments)}else{@()}
    if($case.refuse){
        $passed=$threw -and $script:startCalls.Count -eq 0 -and $script:stopCalls -eq 0 -and
            $script:controllerConstructions -eq 0 -and $script:fixedProcessCalls -eq 0
    }else{
        $expected=@($case.expected)
        $same=$actual.Count -eq $expected.Count
        if($same){for($i=0;$i -lt $actual.Count;$i++){if($actual[$i] -cne $expected[$i]){$same=$false}}}
        $passed=-not $threw -and $script:startCalls.Count -eq 1 -and $script:waitCalls -eq 1 -and
            $script:disposeCalls -eq 1 -and $script:controllerConstructions -eq 1 -and $same
    }
    $controls.Add(@{name=$case.name;passed=$passed;refusalExpected=$case.refuse;refusalObserved=$threw;
        actualStartCalls=$script:startCalls.Count;actualArgumentCount=$actual.Count;controllerConstructions=$script:controllerConstructions;
        fixedProcessCalls=$script:fixedProcessCalls;failure=$failure})
}
$failed=@($controls|Where-Object {-not $_.passed})
@{code='startup_caller_startargs_controls_v2';moduleSha256=$ModuleSha;startupArgumentsParameterPresent=$parameterPresent;
  controls=$controls.ToArray();passed=$controls.Count-$failed.Count;failed=$failed.Count;
  scope='actual function body with only controller construction substituted; local method sinks; no module import, real controller, SCM, process, principal, pipe or Node';
  unproven='Context JSON/schema/source/cutoff, producer/collector, caller ownership and cross-SID SCM are separate controls'}|ConvertTo-Json -Depth 8 -Compress
if($failed.Count -gt 0){exit 1}
exit 0
