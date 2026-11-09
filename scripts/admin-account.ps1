param(
    [Parameter(Mandatory = $true)]
    [string]$Email,
    [switch]$Create,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$databaseSecret = $null
$passwordSecret = $null
$confirmationSecret = $null
$process = $null
$payload = $null
$password = $null
$confirmation = $null
$databasePassword = $null
$payloadBytes = $null

function ConvertFrom-ProvisioningSecret([Security.SecureString]$Secret) {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secret)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

try {
    Write-Host "Local PisangLENS Admin account: $Email"
    $databaseUser = Read-Host 'Local MySQL administration username'
    $databaseSecret = Read-Host 'Local MySQL password (hidden; Enter for empty)' -AsSecureString
    $passwordSecret = Read-Host 'New Admin password (hidden; 8-72 UTF-8 bytes)' -AsSecureString
    $confirmationSecret = Read-Host 'Repeat new Admin password (hidden)' -AsSecureString
    $databasePassword = ConvertFrom-ProvisioningSecret $databaseSecret
    $password = ConvertFrom-ProvisioningSecret $passwordSecret
    $confirmation = ConvertFrom-ProvisioningSecret $confirmationSecret
    if ($password -cne $confirmation) {
        throw 'Passwords do not match. No changes were requested.'
    }
    $length = [Text.Encoding]::UTF8.GetByteCount($password)
    if ($length -lt 8 -or $length -gt 72 -or [string]::IsNullOrWhiteSpace($password) -or $password.Contains([string][char]0)) {
        throw 'The new password must contain 8-72 UTF-8 bytes and no NUL characters.'
    }
    $name = $null
    if ($Create) { $name = Read-Host 'Full name for the new Admin account' }
    $payload = @{
        email = $Email
        mode = $(if ($Create) { 'create' } else { 'reset' })
        name = $name
        database_username = $databaseUser
        database_password = $databasePassword
        new_password = $password
    } | ConvertTo-Json -Compress

    # Send secrets through a private stdin pipe, never command arguments or files.
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = (Get-Command php -CommandType Application -ErrorAction Stop).Source
    $worker = Join-Path $PSScriptRoot 'admin-account.php'
    $start.Arguments = '"' + $worker + '"'
    if ($DryRun) { $start.Arguments += ' --dry-run' }
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    if (!$process.Start()) { throw 'Could not start the local PHP provisioning process.' }
    $payloadBytes = [Text.Encoding]::UTF8.GetBytes($payload)
    $process.StandardInput.BaseStream.Write($payloadBytes, 0, $payloadBytes.Length)
    $process.StandardInput.Close()
    $output = $process.StandardOutput.ReadToEnd()
    $failure = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
        throw $failure.Trim()
    }
    Write-Host $output.Trim()
} finally {
    $payload = $null
    $password = $null
    $confirmation = $null
    $databasePassword = $null
    if ($payloadBytes) { [Array]::Clear($payloadBytes, 0, $payloadBytes.Length) }
    if ($databaseSecret) { $databaseSecret.Dispose() }
    if ($passwordSecret) { $passwordSecret.Dispose() }
    if ($confirmationSecret) { $confirmationSecret.Dispose() }
    if ($process) { $process.Dispose() }
}
