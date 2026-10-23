param([switch]$Live)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$source = Join-Path $PSScriptRoot '../../deploy/windows/service-lifecycle.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Resolve-Path $source), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw $errors[0] }
# Import functions only: never execute installation or mutate service state.
foreach ($function in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    . ([scriptblock]::Create($function.Extent.Text))
}
if ($Live) {
    $actual = Get-InteractiveControllerSid
    $expected = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($actual -ne $expected) { throw 'Session owner differs from this unelevated test user' }
    "Live session lookup passed ($([IntPtr]::Size * 8)-bit PowerShell)."
    exit
}
function Assert-Rejected([scriptblock]$Operation) {
    $failed = $false
    try { & $Operation | Out-Null } catch { $failed = $true }
    if (-not $failed) { throw 'Expected operation to fail' }
}
foreach ($sid in @('S-1-5-18', 'S-1-5-32-544', 'S-1-1-0', 'invalid')) {
    Assert-Rejected { Assert-ControllerSid $sid }
}
Assert-ControllerSid 'S-1-5-21-1-2-3-1001'
Assert-ControllerSid 'S-1-12-1-1-2-3-4'
function Get-InstallerSessionId { 0 }
Assert-Rejected { Get-InteractiveControllerSid }
function Get-ConfiguredControllerSid { 'S-1-5-21-1-2-3-1001' }
function Get-SessionAccount { throw 'Desktop lookup must not run during an upgrade' }
if ((Get-ControllerSid) -ne 'S-1-5-21-1-2-3-1001') { throw 'Upgrade changed controller SID' }
function Get-ConfiguredControllerSid { $null }
function Get-InstallerSessionId { 7 }
function Get-SessionAccount { param($SessionId) if ($SessionId -ne 7) { throw 'Wrong session' }; [Security.Principal.WindowsIdentity]::GetCurrent().Name }
if ((Get-ControllerSid) -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'Incorrect desktop owner' }
function Get-SessionAccount { throw 'WTS failed' }
Assert-Rejected { Get-ControllerSid }
'Session-zero rejection, upgrade preservation, exact-session lookup, SID restrictions and lookup failures passed.'
