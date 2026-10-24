param([string]$Root=$PSScriptRoot,[string]$UpscaylRoot,[string]$ListenHost,[int]$Port=10443,[switch]$CheckOnly)

function Get-ZebBytesHash {
    param([byte[]]$Bytes)
    $hash=[Security.Cryptography.SHA256]::Create()
    try{return ([BitConverter]::ToString($hash.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
}

function New-ZebModelCatalog {
    param($Material,$Import,[string]$AssetsRoot,[string]$UpscaylRoot,[string]$OutputRoot)
    $manifest=Get-Content -LiteralPath (Join-Path $AssetsRoot 'installation-manifest.json') -Raw -Encoding UTF8|ConvertFrom-Json
    $base=$Material.workerConfig.models|Where-Object {$_.id -ceq 'standard-4x'}|Select-Object -First 1
    $standard=$manifest.models|Where-Object {$_.modelId -ceq 'standard-4x'}|Select-Object -First 1
    if(-not $base -or -not $standard){throw 'standard_model_missing'}
    $imports=@($Import.files|Where-Object {$_.path.StartsWith('bin/')})
    $models=@();$declarations=@();$generated=@();$skipped=@()
    $ids=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach($file in Get-ChildItem -LiteralPath (Join-Path $UpscaylRoot 'resources\models') -Filter '*.bin' -File|Sort-Object Name){
        $name=$file.BaseName;$paramPath=Join-Path $file.DirectoryName ($name+'.param')
        if($name -cnotmatch '\A[A-Za-z0-9][A-Za-z0-9._-]*-4x\z' -or -not(Test-Path -LiteralPath $paramPath -PathType Leaf)){$skipped+=@($name);continue}
        $id=$name -replace '^upscayl-',''
        if(-not $ids.Add($id)){throw ('model_id_conflict: '+$id)}
        $binHash=(Get-FileHash -LiteralPath $file.FullName).Hash.ToLowerInvariant();$paramFile=Get-Item -LiteralPath $paramPath
        $paramHash=(Get-FileHash -LiteralPath $paramPath).Hash.ToLowerInvariant()
        $model=($base|ConvertTo-Json -Depth 10)|ConvertFrom-Json
        $model.id=$id
        if($name -ceq $standard.modelName){
            $model.modelVersion=$standard.modelVersion;$model.modelSha256=$standard.modelSetSha256
            $setSource=Join-Path $AssetsRoot 'model-set.json'
            $setBytes=[IO.File]::ReadAllBytes($setSource)
        }else{
            $set=[ordered]@{v=1;modelName=$name;files=@([ordered]@{path=($name+'.bin');length=[string]$file.Length;sha256=$binHash},[ordered]@{path=($name+'.param');length=[string]$paramFile.Length;sha256=$paramHash})}
            $setBytes=[Text.UTF8Encoding]::new($false).GetBytes(($set|ConvertTo-Json -Depth 10 -Compress)+[char]10)
            $model.modelVersion='content-sha256-'+$binHash;$model.modelSha256=Get-ZebBytesHash $setBytes
            $setSource=Join-Path $OutputRoot ('models\'+$id+'\model-set.json')
            $generated+=@([pscustomobject]@{path=$setSource;bytes=$setBytes})
        }
        $directory='models/'+$id
        $imports+=@([pscustomobject]@{path=($directory+'/'+$name+'.bin');sourcePath=$file.FullName;bytes=$file.Length;sha256=$binHash},[pscustomobject]@{path=($directory+'/'+$name+'.param');sourcePath=$paramPath;bytes=$paramFile.Length;sha256=$paramHash},[pscustomobject]@{path=($directory+'/model-set.json');sourcePath=$setSource;bytes=$setBytes.Length;sha256=$model.modelSha256})
        $declarations+=@([pscustomobject]@{modelId=$id;modelVersion=$model.modelVersion;modelDirectory=$directory;modelName=$name;modelSetSha256=$model.modelSha256})
        $models+=@($model)
    }
    if(-not $ids.Contains('standard-4x')){throw 'standard_model_missing'}
    $manifest.models=@($declarations)
    $manifestBytes=[Text.UTF8Encoding]::new($false).GetBytes(($manifest|ConvertTo-Json -Depth 15 -Compress)+[char]10)
    $manifestSource=Join-Path $OutputRoot 'installation-manifest.json'
    $generated+=@([pscustomobject]@{path=$manifestSource;bytes=$manifestBytes})
    $imports+=@([pscustomobject]@{path='installation-manifest.json';sourcePath=$manifestSource;bytes=$manifestBytes.Length;sha256=(Get-ZebBytesHash $manifestBytes)})
    [pscustomobject]@{models=@($models);engineImport=[pscustomobject]@{schemaVersion=1;files=@($imports)};generatedFiles=@($generated);skippedModels=@($skipped)}
}

function Get-ZebSetupPlan {
    param([string]$Root,[string]$AssetsRoot,[string]$UpscaylRoot,[string]$ListenHost,[int]$Port,[switch]$RefreshModels)
    $rootPath=[IO.Path]::GetFullPath($Root)
    $ip=$null
    if(-not[Net.IPAddress]::TryParse($ListenHost,[ref]$ip) -or $ip.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or $ip.Equals([Net.IPAddress]::Any) -or [Net.IPAddress]::IsLoopback($ip) -or $Port -lt 1 -or $Port -gt 65535){throw 'listener_invalid: 请填写本机内网 IPv4 地址和 1～65535 端口。'}
    $release=Get-Content -LiteralPath (Join-Path $AssetsRoot 'release.json') -Raw -Encoding UTF8|ConvertFrom-Json
    $archive=Join-Path $rootPath $release.runtimeFile
    if(-not(Test-Path -LiteralPath $archive -PathType Leaf)){throw 'package_missing: 请把配套运行 ZIP 放在安装入口旁。'}
    if((Get-FileHash -LiteralPath $archive).Hash.ToLowerInvariant() -cne $release.zipSha256){throw 'package_hash_mismatch: 压缩包与此安装入口版本不匹配。'}
    if(-not $UpscaylRoot){$UpscaylRoot=@((Join-Path $rootPath 'Upscayl'),(Join-Path $env:ProgramFiles 'Upscayl'),(Join-Path $env:LOCALAPPDATA 'Programs\Upscayl'))|Where-Object {Test-Path -LiteralPath (Join-Path $_ 'resources\bin\upscayl-bin.exe')}|Select-Object -First 1}
    if(-not $UpscaylRoot){throw 'upscayl_not_found: 请指定已安装的 Upscayl 文件夹。'}
    if(-not(Test-Path -LiteralPath (Join-Path $UpscaylRoot 'resources\bin\upscayl-bin.exe') -PathType Leaf)){throw 'upscayl_not_found: 请指定已安装的 Upscayl 文件夹。'}
    foreach($name in @('applications','data')){
        $path=Join-Path $rootPath $name
        if(-not $RefreshModels -and (Test-Path -LiteralPath $path) -and (-not(Test-Path -LiteralPath $path -PathType Container) -or @(Get-ChildItem -LiteralPath $path -Force).Count -ne 0)){throw 'installation_target_not_empty: 安装目标有现有文件，请保留并选择空目录。'}
    }
    $engine=Get-Content -LiteralPath (Join-Path $AssetsRoot 'engine-import.example.json') -Raw -Encoding UTF8|ConvertFrom-Json
    foreach($entry in $engine.files){
        $fileName=[IO.Path]::GetFileName($entry.path)
        $entry.sourcePath=if($entry.path.StartsWith('bin/')){Join-Path $UpscaylRoot ('resources\bin\'+$fileName)}elseif($fileName.EndsWith('.bin') -or $fileName.EndsWith('.param')){Join-Path $UpscaylRoot ('resources\models\'+$fileName)}else{Join-Path $AssetsRoot $fileName}
        if(-not(Test-Path -LiteralPath $entry.sourcePath -PathType Leaf) -or (Get-Item -LiteralPath $entry.sourcePath).Length -ne $entry.bytes -or (Get-FileHash -LiteralPath $entry.sourcePath).Hash.ToLowerInvariant() -cne $entry.sha256){throw ('engine_source_mismatch: 引擎文件缺失或版本不匹配：'+$fileName)}
    }
    $material=Get-Content -LiteralPath (Join-Path $AssetsRoot 'configuration-material.http.example.json') -Raw -Encoding UTF8|ConvertFrom-Json
    $material.host=$ListenHost;$material.port=$Port
    $inputRoot=Join-Path $rootPath ('setup-inputs\'+$release.version)
    $catalog=New-ZebModelCatalog -Material $material -Import $engine -AssetsRoot $AssetsRoot -UpscaylRoot $UpscaylRoot -OutputRoot (Join-Path $inputRoot 'engine')
    $material.workerConfig.models=@($catalog.models)
    [pscustomobject]@{root=$rootPath;archive=$archive;version=$release.version;inventorySha256=$release.inventorySha256;payloadRoot=(Join-Path $rootPath ('worker-package\'+$release.version));inputRoot=$inputRoot;programRoot=(Join-Path $rootPath 'applications');dataRoot=(Join-Path $rootPath 'data');backupRoot=(Join-Path $rootPath 'back');credentialFile=(Join-Path $rootPath 'credentials\operator.json');engineImport=$catalog.engineImport;material=$material;generatedFiles=$catalog.generatedFiles;skippedModels=$catalog.skippedModels;endpoint=('http://'+$ListenHost+':'+$Port)}
}

function Show-ZebConnection {
    param([string]$Root)
    $config=Get-Content -LiteralPath (Join-Path $Root 'data\config\worker.config.json') -Raw -Encoding UTF8|ConvertFrom-Json
    $endpoint='http://'+$config.host+':'+$config.port
    Write-Host ('服务地址：'+$endpoint)
    Write-Host ('Token 文件：'+(Join-Path $Root 'credentials\operator.json'))
    Write-Host '双击 Copy-Token.cmd 复制 Token，在 ZEB 后台“AI 高清增强”中粘贴。'
    Write-Host '保存连接 → 检查连接 → 选择所需模型 → 样图自检 → 启用。'
}

function Invoke-ZebSetup {
    param([string]$Root,[string]$UpscaylRoot,[string]$ListenHost,[int]$Port,[switch]$CheckOnly)
    $rootPath=[IO.Path]::GetFullPath($Root)
    $receiptPath=Join-Path $rootPath 'data\installation\receipt.json'
    if(Test-Path -LiteralPath $receiptPath){
        $receipt=Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8|ConvertFrom-Json
        if($receipt.state -cne 'installed'){throw 'existing_installation_requires_maintenance: 已有安装记录，请按维护指南继续原操作；不会重新初始化。'}
        Write-Host '当前目录已有安装，保留现有配置和 Token。'
        Show-ZebConnection $rootPath
        return
    }
    if(Get-Service -Name ZebImageEnhancement -ErrorAction SilentlyContinue){throw 'existing_service_elsewhere: 其他目录已有 Worker 服务；请先确认保留卸载或继续使用原服务。'}
    if(-not $ListenHost){
        $route=Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue|Sort-Object RouteMetric|Select-Object -First 1
        $address=Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue|Where-Object {$_.InterfaceIndex -eq $route.InterfaceIndex -and $_.AddressState -eq 'Preferred'}|Select-Object -First 1
        $ListenHost=$address.IPAddress
    }
    if(-not $UpscaylRoot){
        $UpscaylRoot=@((Join-Path $rootPath 'Upscayl'),(Join-Path $env:ProgramFiles 'Upscayl'),(Join-Path $env:LOCALAPPDATA 'Programs\Upscayl'))|Where-Object {Test-Path -LiteralPath (Join-Path $_ 'resources\bin\upscayl-bin.exe')}|Select-Object -First 1
    }
    if(-not $CheckOnly){
        if(-not $UpscaylRoot){$UpscaylRoot=Read-Host '请输入 Upscayl 安装文件夹'}
        $answer=Read-Host ('监听 IP ['+$ListenHost+']，回车使用默认值');if($answer){$ListenHost=$answer}
        $answer=Read-Host ('监听端口 ['+$Port+']，回车使用默认值');if($answer){$Port=[int]$answer}
    }
    $assets=Join-Path $PSScriptRoot 'setup-assets'
    $plan=Get-ZebSetupPlan -Root $rootPath -AssetsRoot $assets -UpscaylRoot $UpscaylRoot -ListenHost $ListenHost -Port $Port
    Write-Host ('程序目录：'+$plan.programRoot)
    Write-Host ('数据目录：'+$plan.dataRoot)
    Write-Host ('服务地址：'+$plan.endpoint)
    if($CheckOnly){Write-Host '预检查通过，没有更改服务或文件。';return}
    if((Read-Host '按回车开始安装，输入 N 取消') -match '^[Nn]$'){return}
    if(-not(Test-Path -LiteralPath $plan.payloadRoot)){
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($plan.payloadRoot))|Out-Null
        [IO.Compression.ZipFile]::ExtractToDirectory($plan.archive,$plan.payloadRoot)
    }
    foreach($path in @($plan.inputRoot,$plan.backupRoot,[IO.Path]::GetDirectoryName($plan.credentialFile))){[IO.Directory]::CreateDirectory($path)|Out-Null}
    foreach($file in $plan.generatedFiles){
        if(Test-Path -LiteralPath $file.path){throw 'setup_inputs_exist: 已有生成的模型材料，请保留现场。'}
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file.path))|Out-Null
        [IO.File]::WriteAllBytes($file.path,[byte[]]$file.bytes)
    }
    $materialPath=Join-Path $plan.inputRoot 'configuration-material.http.json';$enginePath=Join-Path $plan.inputRoot 'engine-import.json'
    foreach($entry in @(@{path=$materialPath;value=$plan.material},@{path=$enginePath;value=$plan.engineImport})){
        if(Test-Path -LiteralPath $entry.path){throw 'setup_inputs_exist: 已有安装材料，保留现场；请查看原操作记录。'}
        [IO.File]::WriteAllText($entry.path,($entry.value|ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))
    }
    $script=Join-Path $plan.payloadRoot 'deployment\windows\Install-Worker.ps1'
    Write-Host '正在安装服务，请保持窗口打开……'
    $reply=& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script -Action Install -PayloadRoot $plan.payloadRoot -ExpectedInventorySha256 $plan.inventorySha256 -ProgramRoot $plan.programRoot -DataRoot $plan.dataRoot -EngineImportManifest $enginePath -ExpectedEngineImportSha256 (Get-FileHash -LiteralPath $enginePath).Hash.ToLowerInvariant() -ConfigFile $materialPath -CredentialFile $plan.credentialFile -TimeoutSeconds 180
    $exitCode=$LASTEXITCODE
    $result=$reply|ConvertFrom-Json
    if($exitCode -ne 0 -or $result.code -cne 'worker_operation_complete' -or $result.outcome -cne 'known'){throw ('installation_not_complete: '+$result.code+'；保留现有文件，请查看 installation-diagnostics。')}
    $guide=@('安装完成。','服务地址：'+$plan.endpoint,'Token 文件：'+$plan.credentialFile,'双击 Copy-Token.cmd 复制密钥；后台执行连接检查及样图自检后启用。') -join [Environment]::NewLine
    [IO.File]::WriteAllText((Join-Path $rootPath 'CONNECTION.txt'),$guide,[Text.UTF8Encoding]::new($true))
    Show-ZebConnection $rootPath
}

if($MyInvocation.InvocationName -ne '.'){
    $ErrorActionPreference='Stop'
    try{
        if(-not $CheckOnly -and -not([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
            $arguments='-NoLogo -NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'" -Root "'+$Root+'"'
            if($UpscaylRoot){$arguments+=' -UpscaylRoot "'+$UpscaylRoot+'"'}
            if($ListenHost){$arguments+=' -ListenHost "'+$ListenHost+'"'}
            $arguments+=' -Port '+$Port
            $process=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList $arguments -Verb RunAs -Wait -PassThru
            exit $process.ExitCode
        }
        Invoke-ZebSetup -Root $Root -UpscaylRoot $UpscaylRoot -ListenHost $ListenHost -Port $Port -CheckOnly:$CheckOnly
    }catch{Write-Host ('安装未完成：'+$_.Exception.Message) -ForegroundColor Red;if(-not $CheckOnly){$null=Read-Host '按回车关闭'};exit 1}
    if(-not $CheckOnly){$null=Read-Host '按回车关闭'}
}
