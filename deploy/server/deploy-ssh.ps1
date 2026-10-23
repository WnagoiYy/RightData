param([Parameter(Mandatory)][string]$PackageDirectory, [string]$SshHost='dacp-internal')
$ErrorActionPreference='Stop'
$project=(Resolve-Path "$PSScriptRoot/../..").Path
$packages=(Resolve-Path $PackageDirectory).Path
$manifest=Get-Content "$packages/latest-server-windows-x64.json" -Raw | ConvertFrom-Json
if ($manifest.version -notmatch '^\d+\.\d+\.\d+$' -or $manifest.fileName -ne "RightDataServer-$($manifest.version)-windows-x64.zip") { throw 'Invalid server manifest' }
$remoteRoot='C:/ProgramData/RightDataServer'
$incoming="$remoteRoot/downloads/$($manifest.version)"
function Invoke-Remote([string]$Script) {
    $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("`$ErrorActionPreference='Stop'; `$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $Script"))
    & ssh -o BatchMode=yes $SshHost powershell -NoProfile -NonInteractive -EncodedCommand $encoded
    if ($LASTEXITCODE) { throw 'Remote deployment command failed' }
}
Invoke-Remote "New-Item -ItemType Directory -Force -Path '$remoteRoot', '$incoming' | Out-Null"
foreach ($name in @('run-server.ps1','activate.ps1','extract.ps1','install.ps1','update-server.mjs')) {
    & scp -q "$PSScriptRoot/$name" "${SshHost}:$remoteRoot/$name"
    if ($LASTEXITCODE) { throw "Upload failed: $name" }
}
& scp -q "$project/client/update-public-key.pub" "${SshHost}:$remoteRoot/update-public-key.pub"
if ($LASTEXITCODE) { throw 'Public key upload failed' }
foreach ($name in @('latest-server-windows-x64.json', $manifest.fileName)) {
    & scp -q "$packages/$name" "${SshHost}:$incoming/$name"
    if ($LASTEXITCODE) { throw "Package upload failed: $name" }
}
Invoke-Remote "& '$remoteRoot/install.ps1'; & '$remoteRoot/tools/node.exe' '$remoteRoot/update-server.mjs' --package-dir '$incoming'; if (`$LASTEXITCODE) { throw 'Signed deployment failed' }; Get-Content '$remoteRoot/logs/deploy-status.json' -Raw"
