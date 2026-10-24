param([string]$SetupScript=(Join-Path $PSScriptRoot 'Setup-Worker.ps1'))
$ErrorActionPreference='Stop'
if(Test-Path -LiteralPath $SetupScript){. $SetupScript}
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('Zeb Setup tests 中文 '+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testRoot)|Out-Null
$passed=0;$failed=0
function Assert($Value,[string]$Message){if(-not $Value){throw $Message}}
function JsonFile($Path,$Value){[IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 15),[Text.UTF8Encoding]::new($false))}
function Fixture {
    $root=Join-Path $testRoot ([Guid]::NewGuid().ToString('N'));$assets=Join-Path $root 'setup-assets'
    foreach($part in @('setup-assets','Upscayl\resources\bin','Upscayl\resources\models','applications','data','back')){[IO.Directory]::CreateDirectory((Join-Path $root $part))|Out-Null}
    $entries=@()
    foreach($path in @('bin/upscayl-bin.exe','bin/vcomp140.dll','bin/vcomp140d.dll','models/standard-4x/upscayl-standard-4x.bin','models/standard-4x/upscayl-standard-4x.param','installation-manifest.json','models/standard-4x/model-set.json')){
        $source=if($path.StartsWith('bin/')){Join-Path $root ('Upscayl\resources\'+$path.Replace('/','\'))}elseif($path.EndsWith('.bin') -or $path.EndsWith('.param')){Join-Path $root ('Upscayl\resources\models\'+[IO.Path]::GetFileName($path))}else{Join-Path $assets ([IO.Path]::GetFileName($path))}
        [IO.File]::WriteAllText($source,('fixture '+$path),[Text.UTF8Encoding]::new($false))
        $entries+=@{path=$path;sourcePath='placeholder';bytes=(Get-Item -LiteralPath $source).Length;sha256=(Get-FileHash -LiteralPath $source).Hash.ToLowerInvariant()}
    }
    $modelFiles=@($entries|Where-Object {$_.path.EndsWith('.bin') -or $_.path.EndsWith('.param')}|ForEach-Object {@{path=[IO.Path]::GetFileName($_.path);length=[string]$_.bytes;sha256=$_.sha256}})
    JsonFile (Join-Path $assets 'model-set.json') @{v=1;modelName='upscayl-standard-4x';files=$modelFiles}
    $set=Get-Item -LiteralPath (Join-Path $assets 'model-set.json');$setHash=(Get-FileHash -LiteralPath $set.FullName).Hash.ToLowerInvariant()
    $declarations=@($entries|Where-Object {$_.path.StartsWith('bin/')}|ForEach-Object {@{path=$_.path;length=[string]$_.bytes;sha256=$_.sha256}})
    JsonFile (Join-Path $assets 'installation-manifest.json') @{v=1;platform='win-x64';recipeId='upscayl-4x-png-v1';binaryVersion='fixture-binary';entryPoint='bin/upscayl-bin.exe';files=$declarations;models=@(@{modelId='standard-4x';modelVersion='fixture-model';modelDirectory='models/standard-4x';modelName='upscayl-standard-4x';modelSetSha256=$setHash})}
    foreach($entry in $entries|Where-Object {$_.path -in @('installation-manifest.json','models/standard-4x/model-set.json')}){$p=Join-Path $assets ([IO.Path]::GetFileName($entry.path));$entry.bytes=(Get-Item -LiteralPath $p).Length;$entry.sha256=(Get-FileHash -LiteralPath $p).Hash.ToLowerInvariant()}
    $baseModel=@{id='standard-4x';binaryVersion='fixture-binary';binarySha256=($entries|Where-Object {$_.path -eq 'bin/upscayl-bin.exe'}).sha256;modelVersion='fixture-model';modelSha256=$setHash;nativeScale=4;allowedTiles=@(256);defaultTile=256;tta=$false;gpuId=0}
    $payload=Join-Path $root 'fixture-payload';[IO.Directory]::CreateDirectory((Join-Path $payload 'deployment\windows'))|Out-Null
    $nativeFixture=@'
param($Action,$PayloadRoot,$ExpectedInventorySha256,$ProgramRoot,$DataRoot,$EngineImportManifest,$ExpectedEngineImportSha256,$ConfigFile,$CredentialFile,$TimeoutSeconds)
$ErrorActionPreference='Stop'
[IO.Directory]::CreateDirectory((Join-Path $DataRoot 'config'))|Out-Null
[IO.File]::WriteAllText((Join-Path $DataRoot 'received-arguments.json'),($PSBoundParameters|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
if(Test-Path -LiteralPath (Join-Path $PayloadRoot 'fail.marker')){'{"code":"worker_operation_unknown","outcome":"unknown"}';exit 1}
Copy-Item -LiteralPath $ConfigFile -Destination (Join-Path $DataRoot 'config\worker.config.json')
'{"code":"worker_operation_complete","outcome":"known"}'
'@
    [IO.File]::WriteAllText((Join-Path $payload 'deployment\windows\Install-Worker.ps1'),$nativeFixture,[Text.UTF8Encoding]::new($true))
    $zip=Join-Path $root 'image-enhancement-worker-candidate.zip'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($payload,$zip)
    JsonFile (Join-Path $assets 'release.json') @{version='m5-test';runtimeFile='image-enhancement-worker-candidate.zip';zipSha256=(Get-FileHash -LiteralPath $zip).Hash.ToLowerInvariant();inventorySha256=('a'*64)}
    JsonFile (Join-Path $assets 'engine-import.example.json') @{schemaVersion=1;files=$entries}
    JsonFile (Join-Path $assets 'configuration-material.http.example.json') @{host='placeholder';port='placeholder';selfTestModelId='standard-4x';workerConfig=@{models=@($baseModel)}}
    return @{Root=$root;AssetsRoot=$assets;ListenHost='192.0.2.10';Port=10443}
}
function Plan($Parameters){if(Get-Command Get-ZebSetupPlan -ErrorAction SilentlyContinue){Get-ZebSetupPlan @Parameters}else{$null}}
function Reject($Parameters,$Expected){try{$null=Plan $Parameters;throw 'did_not_reject'}catch{Assert ($_.Exception.Message -like ('*'+$Expected+'*')) ('expected '+$Expected+'; received '+$_.Exception.Message)}}
function Test($Name,[scriptblock]$Body){try{& $Body;$script:passed++;Write-Output ('PASS '+$Name)}catch{$script:failed++;Write-Output ('FAIL '+$Name+': '+$_.Exception.Message)}}
Test '自动发现同目录 Upscayl 和安装目录' {
    $p=Fixture;$plan=Plan $p
    Assert ($null -ne $plan) '简化安装入口尚未生成计划'
    Assert ($plan.programRoot -ceq (Join-Path $p.Root 'applications')) '程序目录不正确'
    Assert ($plan.dataRoot -ceq (Join-Path $p.Root 'data')) '数据目录不正确'
    Assert ($plan.credentialFile -ceq (Join-Path $p.Root 'credentials\operator.json')) 'Token 路径不正确'
    Assert ($plan.engineImport.files.Count -eq 7) '引擎材料未完整生成'
    Assert ($plan.material.host -ceq '192.0.2.10' -and $plan.material.port -eq 10443) '连接配置不正确'
}
Test '预检查不创建目录和配置文件' {
    $p=Fixture;$before=@(Get-ChildItem -LiteralPath $p.Root -Recurse).Count;$plan=Plan $p
    Assert ($null -ne $plan) '缺少预检查计划'
    Assert (@(Get-ChildItem -LiteralPath $p.Root -Recurse).Count -eq $before) '预检查产生了写入'
}
Test '自动导入目录中其他完整的四倍模型' {
    $p=Fixture;$models=Join-Path $p.Root 'Upscayl\resources\models'
    [IO.File]::WriteAllText((Join-Path $models 'remacri-4x.bin'),'fixture alternate weights');[IO.File]::WriteAllText((Join-Path $models 'remacri-4x.param'),'fixture alternate params')
    $plan=Plan $p
    Assert ($plan.material.workerConfig.models.Count -eq 2) '没有遍历导入其他模型'
    Assert ($plan.material.workerConfig.models[1].id -ceq 'standard-4x' -or $plan.material.workerConfig.models[0].id -ceq 'standard-4x') '丢失原 standard 模型'
    $alternate=$plan.material.workerConfig.models|Where-Object {$_.id -ceq 'remacri-4x'}
    Assert ($null -ne $alternate) '没有发现 Remacri 模型'
    Assert ($plan.engineImport.files.Count -eq 10) '完整引擎导入清单不正确'
    $set=$plan.generatedFiles|Where-Object {$_.path.EndsWith('remacri-4x\model-set.json')}
    Assert ($null -ne $set) '没有自动生成模型元数据'
    $hash=[Security.Cryptography.SHA256]::Create();try{$sha=([BitConverter]::ToString($hash.ComputeHash([byte[]]$set.bytes))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
    Assert ($sha -ceq $alternate.modelSha256) '能力列表没有绑定实际模型元数据'
}
Test '不完整和非四倍模型不会冒充可用模型' {
    $p=Fixture;$models=Join-Path $p.Root 'Upscayl\resources\models'
    [IO.File]::WriteAllText((Join-Path $models 'orphan-4x.bin'),'incomplete')
    [IO.File]::WriteAllText((Join-Path $models 'custom-2x.bin'),'two times');[IO.File]::WriteAllText((Join-Path $models 'custom-2x.param'),'two times params')
    $plan=Plan $p
    Assert ($plan.skippedModels.Count -eq 2) '没有说明被跳过的模型'
    Assert ($plan.material.workerConfig.models.Count -eq 1) '错误注册不完整模型'
}
Test '标准模型别名冲突会明确拒绝' {
    $p=Fixture;$models=Join-Path $p.Root 'Upscayl\resources\models'
    [IO.File]::WriteAllText((Join-Path $models 'standard-4x.bin'),'duplicate weights');[IO.File]::WriteAllText((Join-Path $models 'standard-4x.param'),'duplicate params')
    Reject $p 'model_id_conflict'
}
Test '错误引擎不进入安装' {
    $p=Fixture;[IO.File]::AppendAllText((Join-Path $p.Root 'Upscayl\resources\bin\upscayl-bin.exe'),'changed');Reject $p 'engine_source_mismatch'
}
Test '错误压缩包不进入安装' {
    $p=Fixture;[IO.File]::AppendAllText((Join-Path $p.Root 'image-enhancement-worker-candidate.zip'),'changed');Reject $p 'package_hash_mismatch'
}
Test '缺少 Upscayl 时提示明确' {
    $p=Fixture;$p.UpscaylRoot=Join-Path $p.Root 'not-installed';Reject $p 'upscayl_not_found'
}
Test '拒绝全部网卡监听和无效端口' {
    $p=Fixture;$p.ListenHost='0.0.0.0';Reject $p 'listener_invalid'
    $p.ListenHost='192.0.2.10';$p.Port=0;Reject $p 'listener_invalid'
}
Test '现有用户数据不会被重新初始化' {
    $p=Fixture;[IO.File]::WriteAllText((Join-Path $p.Root 'data\keep.txt'),'user data');Reject $p 'installation_target_not_empty'
    Assert ((Get-Content -LiteralPath (Join-Path $p.Root 'data\keep.txt') -Raw) -ceq 'user data') '原数据被修改'
}
Test '真实子进程收到自动生成的完整安装参数' {
    $p=Fixture
    $fixtureScript=Join-Path $p.Root 'Setup-Worker.ps1';Copy-Item -LiteralPath $SetupScript -Destination $fixtureScript;. $fixtureScript
    function Get-Service {}
    function Read-Host {''}
    Invoke-ZebSetup -Root $p.Root -ListenHost $p.ListenHost -Port $p.Port
    $actual=Get-Content -LiteralPath (Join-Path $p.Root 'data\received-arguments.json') -Raw -Encoding UTF8|ConvertFrom-Json
    Assert ($actual.Action -ceq 'Install' -and $actual.ProgramRoot -ceq (Join-Path $p.Root 'applications')) '安装动作或中文空格路径丢失'
    Assert ($actual.CredentialFile -ceq (Join-Path $p.Root 'credentials\operator.json')) '凭据路径丢失'
    Assert ($actual.ExpectedEngineImportSha256 -ceq (Get-FileHash -LiteralPath $actual.EngineImportManifest).Hash.ToLowerInvariant()) '自动清单校验值错误'
    Assert (Test-Path -LiteralPath (Join-Path $p.Root 'CONNECTION.txt')) '未提供接入说明'
}
Test '再次运行保留配置和 Token' {
    $p=Fixture;[IO.Directory]::CreateDirectory((Join-Path $p.Root 'data\installation'))|Out-Null;[IO.Directory]::CreateDirectory((Join-Path $p.Root 'data\config'))|Out-Null
    JsonFile (Join-Path $p.Root 'data\installation\receipt.json') @{state='installed'}
    JsonFile (Join-Path $p.Root 'data\config\worker.config.json') @{host='192.0.2.10';port=10443}
    [IO.Directory]::CreateDirectory((Join-Path $p.Root 'credentials'))|Out-Null
    $credential=Join-Path $p.Root 'credentials\operator.json';[IO.File]::WriteAllText($credential,'keep original token')
    $before=(Get-FileHash -LiteralPath $credential).Hash
    Invoke-ZebSetup -Root $p.Root -CheckOnly
    Assert ((Get-FileHash -LiteralPath $credential).Hash -ceq $before) '已有 Token 被改写'
    Assert (-not(Test-Path -LiteralPath (Join-Path $p.Root 'worker-package'))) '已有安装仍解压了新包'
}
Test '其他目录的服务不会被自动替换' {
    $p=Fixture
    function Get-Service {[pscustomobject]@{Name='ZebImageEnhancement'}}
    try{Invoke-ZebSetup @p -CheckOnly;throw 'did_not_reject'}catch{Assert ($_.Exception.Message -like '*existing_service_elsewhere*') '没有保护其他目录服务'}
    Assert (-not(Test-Path -LiteralPath (Join-Path $p.Root 'worker-package'))) '拒绝前不应解压写入'
}
Test '已有安装刷新模型的预检查不改配置和 Token' {
    $p=Fixture;$refresh=Join-Path ([IO.Path]::GetDirectoryName($SetupScript)) 'Refresh-Models.ps1'
    Assert (Test-Path -LiteralPath $refresh) '缺少现有安装模型刷新入口'
    Copy-Item -LiteralPath $SetupScript -Destination (Join-Path $p.Root 'Setup-Worker.ps1');Copy-Item -LiteralPath $refresh -Destination (Join-Path $p.Root 'Refresh-Models.ps1')
    foreach($part in @('data\installation','data\config','credentials')){[IO.Directory]::CreateDirectory((Join-Path $p.Root $part))|Out-Null}
    JsonFile (Join-Path $p.Root 'data\installation\receipt.json') @{state='installed';programRoot=(Join-Path $p.Root 'applications');dataRoot=(Join-Path $p.Root 'data');active=@{version='m5-test'}}
    $config=Get-Content -LiteralPath (Join-Path $p.Root 'setup-assets\configuration-material.http.example.json') -Raw -Encoding UTF8|ConvertFrom-Json;$config.host=$p.ListenHost;$config.port=$p.Port
    JsonFile (Join-Path $p.Root 'data\config\worker.config.json') $config
    $tokenFile=Join-Path $p.Root 'credentials\operator.json';[IO.File]::WriteAllText($tokenFile,'keep original token')
    $before=@(Get-ChildItem -LiteralPath $p.Root -File -Recurse|ForEach-Object {(Get-FileHash -LiteralPath $_.FullName).Hash}) -join ','
    $result=& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $p.Root 'Refresh-Models.ps1') -Root $p.Root -CheckOnly
    Assert ($LASTEXITCODE -eq 0) ('预检查失败：'+($result -join ' '))
    $after=@(Get-ChildItem -LiteralPath $p.Root -File -Recurse|ForEach-Object {(Get-FileHash -LiteralPath $_.FullName).Hash}) -join ','
    Assert ($before -ceq $after) '刷新预检查修改了文件'
}
Write-Output ('RESULT passed='+$passed+' failed='+$failed)
if($failed -ne 0){exit 1}
