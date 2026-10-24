param(
    [Parameter(Mandatory=$true)][string]$ModulePath,
    [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ModuleSha,
    [Parameter(Mandatory=$true)][string]$FixtureRoot,
    [Parameter(Mandatory=$true)][string]$OutputPath
)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
Set-StrictMode -Version Latest
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
if($PSVersionTable.PSVersion.Major -ne 5){throw 'actual_windows_powershell_5_required'}
$ModulePath=[IO.Path]::GetFullPath($ModulePath)
if((Get-FileHash -LiteralPath $ModulePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ModuleSha.ToLowerInvariant()){throw 'module_preimage_changed'}
if($null -ne ('Zeb.WorkerInstall.Native' -as [type])){throw 'fresh_native_process_required'}
$root=[IO.Path]::GetFullPath($FixtureRoot)
$moduleDirectory=[IO.DirectoryInfo]::new([IO.Path]::GetDirectoryName($ModulePath))
$workerRoot=$moduleDirectory.Parent.Parent.FullName
$expectedModule=[IO.Path]::Combine($workerRoot,'deployment','windows','Worker.Installation.psm1')
if(-not [string]::Equals($ModulePath,$expectedModule,[StringComparison]::OrdinalIgnoreCase)){throw 'bound_worker_module_path_required'}
$cache=[IO.Path]::Combine($workerRoot,'node_modules','.cache')
if(-not [IO.Directory]::Exists($cache)){throw 'worker_cache_parent_required'}
$privatePrefix=$cache.TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar
if(-not $root.StartsWith($privatePrefix,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $root) -or
    (Test-Path -LiteralPath $OutputPath)){throw 'exclusive_worker_cache_fixture_or_output_required'}
$module=Import-Module -Name $ModulePath -Force -PassThru
if(@($module).Count -ne 1){throw 'actual_module_not_unique'}
& $module {Initialize-WorkerInstallNative}
foreach($name in @('PinStartupCaller','RequireStartupPin')){
    if($null -eq [Zeb.WorkerInstall.Native].GetMethod($name,[Reflection.BindingFlags]::Public -bor [Reflection.BindingFlags]::Static)){throw 'startup_native_interface_missing'}
}
& $module {param($path) New-WorkerCallerDirectory $path} $root
$rows=[Collections.Generic.List[object]]::new();$kept=$null;$keptFixture=$null;$callerHandle=$null
function Hash-Bytes([byte[]]$Bytes){
    $hash=[Security.Cryptography.SHA256]::Create()
    try{return [BitConverter]::ToString($hash.ComputeHash($Bytes)).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
}
function Root-Failure($Failure){
    while($null -ne $Failure.InnerException){$Failure=$Failure.InnerException}
    return $Failure
}
function Put-TechnicalFile([string]$Path,[byte[]]$Bytes){
    $null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path))
    & $module {param($path,$bytes) New-WorkerCallerFile -Path $path -Bytes $bytes} $Path $Bytes
}
function Technical-Fixture([string]$Mode){
    $scene=[IO.Path]::Combine($root,$Mode)
    & $module {param($path) New-WorkerCallerDirectory $path} $scene
    $program=[IO.Path]::Combine($scene,'program');$data=[IO.Path]::Combine($scene,'data')
    foreach($path in @($program,$data,[IO.Path]::Combine($data,'installation'))){& $module {param($path) New-WorkerCallerDirectory $path} $path}
    $version='technical-v1';$payload=[IO.Path]::Combine($program,$version)
    $files=[Collections.Generic.List[object]]::new()
    foreach($relative in @('WindowsServiceHost.exe','WindowsServiceHost.deps.json','WindowsServiceHost.runtimeconfig.json',
        'runtime/node.exe','runtime/LICENSE','app/main.mjs','app/manage.mjs','app/package.json','app/dist/bootstrap.js',
        'app/dist/contracts.js','native/bridge/WindowsControlBridge.exe','native/supervisor/WindowsSupervisor.exe')){
        $bytes=[Text.Encoding]::ASCII.GetBytes("inert producer fixture $relative`n")
        Put-TechnicalFile ([IO.Path]::Combine($payload,$relative.Replace('/','\'))) $bytes
        $files.Add([ordered]@{path=$relative;bytes=$bytes.Length;sha256=(Hash-Bytes $bytes)})
    }
    $marker=[Text.Encoding]::ASCII.GetBytes($(if($Mode -ceq 'bad_marker'){"ZEB_STARTUP_OBSERVATION_V0`n"}else{"ZEB_STARTUP_OBSERVATION_V1`n"}))
    Put-TechnicalFile ([IO.Path]::Combine($payload,'startup-observation.v1')) $marker
    $files.Add([ordered]@{path='startup-observation.v1';bytes=$marker.Length;sha256=(Hash-Bytes $marker)})
    $inventory=[Text.UTF8Encoding]::new($false).GetBytes(([ordered]@{schemaVersion=1;version=$version;storeSchemaVersion=7;files=$files.ToArray()}|ConvertTo-Json -Depth 6 -Compress))
    Put-TechnicalFile ([IO.Path]::Combine($payload,'package.inventory.json')) $inventory
    $config=[Text.Encoding]::ASCII.GetBytes("{`"technical`":true}`n")
    Put-TechnicalFile ([IO.Path]::Combine($payload,'app','worker.config.json')) $config
    Put-TechnicalFile ([IO.Path]::Combine($data,'config','worker.config.json')) $config
    $engine=[Text.Encoding]::ASCII.GetBytes("{}`n")
    Put-TechnicalFile ([IO.Path]::Combine($data,'engine','installation-manifest.json')) $engine
    $receipt=[pscustomobject]@{schemaVersion=1;installationId=[Guid]::NewGuid().ToString('D');state='pending';
        serviceName='ZebImageEnhancement';accountName='NT SERVICE\ZebImageEnhancement';tokenUserSid=$null;sessionId=$null;
        programRoot=$program;dataRoot=$data;storeSchemaVersion=7;serviceId=[Guid]::NewGuid().ToString('D');clientId=[Guid]::NewGuid().ToString('D');
        engineImportSha256=('b'*64);engineManifestSha256=(Hash-Bytes $engine);configSha256=(Hash-Bytes $config);tlsSha256=$null;
        active=[pscustomobject]@{version=$version;inventorySha256=$(if($Mode -ceq 'bad_inventory'){'0'*64}else{Hash-Bytes $inventory});
            imagePath=('"'+[IO.Path]::Combine($payload,'WindowsServiceHost.exe')+'"')};previous=$null;lastStopped=$null;
        operation=[pscustomobject]@{operationId=[Guid]::NewGuid().ToString('D');action='Install';stage=$(if($Mode -ceq 'not_started'){'prepared'}else{'started'});
            outcome='pending';maintenanceBootId=$null;targetSha256=$null}}
    $diskReceipt=$receipt|ConvertTo-Json -Depth 8 -Compress|ConvertFrom-Json
    if($Mode -ceq 'receipt_mismatch'){$diskReceipt.operation.operationId=[Guid]::NewGuid().ToString('D')}
    $receiptPath=[IO.Path]::Combine($data,'installation','receipt.json')
    Put-TechnicalFile $receiptPath ([Text.UTF8Encoding]::new($false).GetBytes(($diskReceipt|ConvertTo-Json -Depth 8 -Compress)+"`n"))
    if($Mode -cne 'bad_marker'){
        $checked=& $module {param($path,$inventory,$config) Test-WorkerInstalledPayload $path $inventory $config} $payload (Hash-Bytes $inventory) (Hash-Bytes $config)
        if($checked.startupObservationV1 -ne $true){throw 'technical_full_package_precondition_failed'}
    }
    return [pscustomobject]@{receipt=$receipt;receiptPath=$receiptPath;payload=$payload}
}
foreach($case in @(@{mode='not_started';stage='receipt';code='worker_startup_observation_unknown'},@{mode='receipt_mismatch';stage='receipt';code='worker_startup_observation_unknown'},
    @{mode='bad_inventory';stage='materials';code='worker_package_invalid'},@{mode='bad_marker';stage='materials';code='worker_package_invalid'},
    @{mode='fixed_service_boundary';stage='service-identity';code=$null})){
    $capture=$null;$errorType=$null;$deep=$null;$good=$false
    try{
        $fixture=Technical-Fixture $case.mode
        $row=& $module {Get-WorkerServiceRow}
        if($null -ne $row -and $row.PathName -ceq $fixture.receipt.active.imagePath){throw 'technical_fixture_must_not_be_actual_service_image'}
        $capture=& $module {param($receipt,$path) New-WorkerStartupObservation $receipt $path ([DateTime]::UtcNow.AddSeconds(15))} $fixture.receipt $fixture.receiptPath
        if($null -ne $capture.Failure){$deep=Root-Failure $capture.Failure}
        $good=$null -ne $capture -and $null -ne $deep -and $capture.Stage -ceq $case.stage -and $capture.FailureStage -ceq $case.stage -and
            $capture.FailureType -ceq $deep.GetType().FullName -and $capture.SourceModuleSha256 -ceq $ModuleSha.ToLowerInvariant() -and
            $null -eq $capture.CallerPin -and $null -eq $capture.HostPin -and $null -eq $capture.NodePin -and $null -eq $capture.Pipe
        if($null -ne $case.code){$good=$good -and $deep.Message -ceq $case.code}
        if($case.mode -ceq 'fixed_service_boundary'){
            $refusedAtFixedBoundary=$deep.GetType().FullName -ceq 'System.Security.Principal.IdentityNotMappedException' -or $deep.Message -ceq 'worker_identity_unknown'
            $good=$good -and $refusedAtFixedBoundary
            if($good){$kept=$capture;$keptFixture=$fixture;$capture=$null}
        }
    }catch{$errorType=(Root-Failure $_.Exception).GetType().FullName;$good=$false}
    finally{if($null -ne $capture){$capture.Dispose()}}
    $rows.Add(@{name=('actual_new:'+ $case.mode);passed=$good;errorType=$errorType;failureType=$(if($null -ne $deep){$deep.GetType().FullName}else{$null});
        expectedStage=$case.stage;expectedCode=$case.code;actualFixedCode=$(if($null -ne $deep -and $deep.Message -cmatch '\Aworker_[a-z_]+\z'){$deep.Message}else{$null});scope='real imported private New; inert bytes only; fixed service identity/Stopped row refusal, never successful producer or SCM'})
}
$archivePath=$null;$originalSha=$null;$sentinel='ZEB_DIAGNOSTIC_PRIVATE_FIELD_SENTINEL';$projectionGood=$false;$collisionGood=$false;$closed=$false
try{
    if($null -eq $kept){throw 'technical_service_boundary_capture_unavailable'}
    # Real current caller only; Host/Node stay null. This tests the archive projection, not producer identity admission.
    $kept.CallerPin=[Zeb.WorkerInstall.Native]::PinStartupCaller();$callerHandle=$kept.CallerPin.Pin.handle
    [Zeb.WorkerInstall.Native]::RequireStartupPin($kept.CallerPin.Pin)
    $kept.Failure=[InvalidOperationException]::new($sentinel)
    $kept|Add-Member -MemberType NoteProperty -Name Bearer -Value $sentinel
    $kept|Add-Member -MemberType NoteProperty -Name UnrelatedPrivateField -Value $sentinel
    $body=[Text.Encoding]::ASCII.GetBytes('{"technicalProjection":true}')
    $wire=[byte[]]::new(4+$body.Length);[BitConverter]::GetBytes([uint32]$body.Length).CopyTo($wire,0);$body.CopyTo($wire,4)
    $kept.RawFrames.Add([pscustomobject]@{kind='technical_archive_input';raw=$wire})
    & $module {param($capture,$receipt) Write-WorkerStartupDiagnostic $capture $receipt} $kept $keptFixture.receipt
    $archivePath=[IO.Path]::Combine($keptFixture.receipt.dataRoot,'installation','startup-'+$kept.OperationId+'.json')
    & $module {param($path) Assert-WorkerCallerFile $path} $archivePath
    $raw=[Zeb.WorkerInstall.Native]::ReadBytes($archivePath);$originalSha=Hash-Bytes $raw
    $text=[Text.UTF8Encoding]::new($false,$true).GetString($raw);$value=$text|ConvertFrom-Json
    $info=[Zeb.WorkerInstall.Native]::Inspect($archivePath)
    $security=[Security.AccessControl.FileSecurity]::new();$security.SetSecurityDescriptorSddlForm($info.SecuritySddl)
    $rules=@($security.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
    $owner=$kept.CallerPin.Pin.tokenUserSid
    $acl=$security.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq $owner -and $security.AreAccessRulesProtected -and
        $rules.Count -eq 1 -and $rules[0].IdentityReference.Value -ceq $owner -and -not $rules[0].IsInherited -and
        [int]$rules[0].FileSystemRights -eq 0x001f01ff -and $rules[0].AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow
    $projectionGood=@($value.PSObject.Properties).Count -eq 17 -and $value.kind -ceq 'startup_caller_diagnostic' -and
        $null -ne $value.PSObject.Properties['failureNativeErrorCode'] -and $null -eq $value.failureNativeErrorCode -and
        $value.operationId -ceq $kept.OperationId -and $value.stage -ceq 'service-identity' -and $value.sourceModuleSha256 -ceq $ModuleSha.ToLowerInvariant() -and
        $value.pins.caller.pid -eq $PID -and $value.pins.caller.creationFileTime -ceq $kept.CallerPin.Pin.creationFileTime -and
        $null -eq $value.pins.host -and $null -eq $value.pins.node -and $value.frames.Count -eq 1 -and
        $value.frames[0].wireBase64 -ceq [Convert]::ToBase64String($wire) -and -not $text.Contains($sentinel) -and $acl
    $rows.Add(@{name='actual_diagnostic_write_acl_projection';passed=$projectionGood;callerOnlyAcl=$acl;originalSha256=$originalSha;
        scope='real private archive I/O with actual caller lease; technical inert raw projection; ContextRaw absent at refused producer boundary'})
    $collisionType=$null
    try{& $module {param($capture,$receipt) Write-WorkerStartupDiagnostic $capture $receipt} $kept $keptFixture.receipt}
    catch{$collisionType=(Root-Failure $_.Exception).GetType().FullName}
    $after=[Zeb.WorkerInstall.Native]::Inspect($archivePath)
    $collisionGood=$collisionType -ceq 'System.IO.IOException' -and [Zeb.WorkerInstall.Native]::Hash($archivePath) -ceq $originalSha -and
        $after.Identity -ceq $info.Identity -and $after.Bytes -eq $info.Bytes -and $after.LastWriteUtc -ceq $info.LastWriteUtc
    $rows.Add(@{name='actual_diagnostic_create_new_collision';passed=$collisionGood;errorType=$collisionType;scope='same original archive identity/length/SHA/write time preserved; no overwrite or retry'})
    $kept.OperationId=[Guid]::NewGuid().ToString('D');$keptFixture.receipt.operation.operationId=$kept.OperationId
    $nativeFailure=[ComponentModel.Win32Exception]::new(1058,$sentinel)
    $kept.Failure=[InvalidOperationException]::new($sentinel,$nativeFailure)
    $kept.FailureType=$nativeFailure.GetType().FullName;$kept.FailureStage='scm-start';$kept.Stage='scm-start'
    & $module {param($capture,$receipt) Write-WorkerStartupDiagnostic $capture $receipt} $kept $keptFixture.receipt
    $nativePath=[IO.Path]::Combine($keptFixture.receipt.dataRoot,'installation','startup-'+$kept.OperationId+'.json')
    $nativeText=[Text.UTF8Encoding]::new($false,$true).GetString([Zeb.WorkerInstall.Native]::ReadBytes($nativePath))
    $nativeValue=$nativeText|ConvertFrom-Json
    $nativeGood=$null -ne $nativeValue.PSObject.Properties['failureNativeErrorCode'] -and
        $nativeValue.failureNativeErrorCode -is [int] -and $nativeValue.failureNativeErrorCode -eq 1058 -and
        $nativeValue.failureType -ceq 'System.ComponentModel.Win32Exception' -and -not $nativeText.Contains($sentinel)
    $rows.Add(@{name='actual_diagnostic_native_code_without_private_message';passed=$nativeGood;
        scope='real nested Win32Exception projected through private archive; no SCM call and no message serialization'})
}catch{
    $rows.Add(@{name='actual_diagnostic_preparation';passed=$false;errorType=(Root-Failure $_.Exception).GetType().FullName;scope='preparation failure, not successful privacy or collision refusal'})
}finally{
    if($null -ne $kept){
        $disposeType=$null
        try{$kept.Dispose();$closed=$null -ne $callerHandle -and $callerHandle.IsClosed}catch{$disposeType=(Root-Failure $_.Exception).GetType().FullName}
        $rows.Add(@{name='actual_capture_caller_lease_dispose';passed=$closed -and $null -eq $disposeType;errorType=$disposeType;scope='same real caller handle only; no Host/Node/SCM closure claim'})
    }
}
$failed=@($rows|Where-Object {-not $_.passed})
$report=@{code='startup_producer_diagnostic_io_v2';passed=$failed.Count -eq 0 -and $rows.Count -eq 9;moduleSha256=$ModuleSha;
    passCount=$rows.Count-$failed.Count;failCount=$failed.Count;rows=$rows.ToArray();actualImportedNew=$true;actualDiagnosticIo=$projectionGood;
    actualProducerSuccess=$false;actualContextOrStartingShaSuccess=$false;actualHostNodePins=$false;actualScmStarted=$false;actualVirtualServiceCrossSid=$false;actualGpu=$false;
    scope='actual private producer preflight/refusal and local diagnostic I/O; fixtures and evidence retained, no system service writes'}
if((Get-FileHash -LiteralPath $ModulePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ModuleSha.ToLowerInvariant()){throw 'module_changed_during_controls'}
$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($report|ConvertTo-Json -Depth 10)+"`n")
$output=[IO.FileStream]::new($OutputPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
try{$output.Write($bytes,0,$bytes.Length)}finally{$output.Dispose()}
[Console]::WriteLine([Text.Encoding]::UTF8.GetString($bytes))
if(-not $report.passed){exit 1}
exit 0
