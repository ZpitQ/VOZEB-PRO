param(
    $Action = 'Uninstall',
    $Receipt,
    $CredentialFile,
    $ExpectedDataRoot,
    $TimeoutSeconds
)

$ErrorActionPreference = 'Stop'
try {
    $modulePath = [System.IO.Path]::Combine($PSScriptRoot, 'Worker.Installation.psm1')
    $loaded = @(Get-Module -All | Where-Object { [string]::Equals($_.Path, $modulePath, [System.StringComparison]::OrdinalIgnoreCase) })
    $module = if ($loaded.Count -eq 1) { $loaded[0] } else { Import-Module -Name $modulePath -PassThru -ErrorAction Stop }
    $request = @{}
    foreach ($key in $PSBoundParameters.Keys) { $request[$key] = $PSBoundParameters[$key] }
    if ($args.Count -ne 0) { $request['InvalidArguments'] = $true }
    $result = & $module { param($Request) Invoke-WorkerInstallation -Request $Request -Remove $true } $request
} catch {
    $result = [pscustomobject]@{ exitCode=1; value=[pscustomobject]@{
        code='worker_operation_unknown'; operationId=[Guid]::NewGuid().ToString(); outcome='unknown' } }
}
[Console]::Out.WriteLine(($result.value | ConvertTo-Json -Compress -Depth 8))
exit $result.exitCode
