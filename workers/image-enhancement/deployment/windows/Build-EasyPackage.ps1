param([Parameter(Mandatory=$true)][string]$RuntimeZip,[Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
$release=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'setup-assets\release.json') -Raw -Encoding UTF8|ConvertFrom-Json
if((Get-FileHash -LiteralPath $RuntimeZip).Hash.ToLowerInvariant() -cne $release.zipSha256){throw 'package_hash_mismatch'}
if(Test-Path -LiteralPath $OutputDirectory){throw 'preserve_existing_package'}
[IO.Directory]::CreateDirectory($OutputDirectory)|Out-Null
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$files=@('Setup-Worker.ps1','Install-ZEB.cmd','Copy-Token.ps1','Copy-Token.cmd','Refresh-Models.ps1','Refresh-Models.cmd','INSTALL-WINDOWS-EASY.md','setup-assets/release.json','setup-assets/engine-import.example.json','setup-assets/configuration-material.http.example.json','setup-assets/installation-manifest.json','setup-assets/model-set.json')
foreach($file in $files){
    $target=Join-Path $OutputDirectory $file.Replace('/','\')
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))|Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file.Replace('/','\')) -Destination $target
}
$packages=@()
foreach($complete in @($false,$true)){
    $name=if($complete){'ZEB-ImageEnhancement-Windows.zip'}else{'ZEB-Windows-Easy-Setup.zip'}
    $path=Join-Path $OutputDirectory $name
    $archive=[IO.Compression.ZipFile]::Open($path,[IO.Compression.ZipArchiveMode]::Create)
    try{
        foreach($file in $files){[IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,(Join-Path $OutputDirectory $file.Replace('/','\')),$file,[IO.Compression.CompressionLevel]::Optimal)|Out-Null}
        if($complete){[IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,(Resolve-Path -LiteralPath $RuntimeZip).Path,$release.runtimeFile,[IO.Compression.CompressionLevel]::NoCompression)|Out-Null}
    }finally{$archive.Dispose()}
    $check=[IO.Compression.ZipFile]::OpenRead($path)
    try{
        $expected=$files.Count;if($complete){$expected++}
        if($check.Entries.Count -ne $expected){throw 'package_entry_mismatch'}
        foreach($entry in $check.Entries){
            $stream=$entry.Open();$hash=[Security.Cryptography.SHA256]::Create()
            try{$actual=([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$stream.Dispose();$hash.Dispose()}
            $wanted=if($entry.FullName -ceq $release.runtimeFile){$release.zipSha256}else{(Get-FileHash -LiteralPath (Join-Path $OutputDirectory $entry.FullName.Replace('/','\'))).Hash.ToLowerInvariant()}
            if($actual -cne $wanted){throw 'package_content_mismatch'}
        }
    }finally{$check.Dispose()}
    $packages+=@{file=$path;sha256=(Get-FileHash -LiteralPath $path).Hash.ToLowerInvariant();bytes=(Get-Item -LiteralPath $path).Length}
}
[pscustomobject]@{runtimeUnchanged=$true;bootstrapFiles=$files.Count;packages=$packages}|ConvertTo-Json -Depth 5 -Compress
