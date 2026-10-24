$ErrorActionPreference='Stop'
try {
    $pairing=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'credentials\operator.json') -Raw -Encoding UTF8|ConvertFrom-Json
    if($pairing.credential.key -cnotmatch '\A[A-Za-z0-9_-]{43}\z'){throw 'Token 文件格式无效。'}
    Set-Clipboard -Value $pairing.credential.key
    Write-Host 'Token 已复制，可在 ZEB 管理员后台粘贴。'
} catch {Write-Host $_.Exception.Message -ForegroundColor Red;exit 1}
