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
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class InstallerArgvTest {
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr CommandLineToArgvW(string command, out int count);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    public static string[] Parse(string command) {
        int count;
        IntPtr memory = CommandLineToArgvW(command, out count);
        if (memory == IntPtr.Zero) throw new Exception("CommandLineToArgvW failed");
        try {
            var result = new string[count];
            for (int i=0; i<count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, i * IntPtr.Size));
            return result;
        } finally { LocalFree(memory); }
    }
}
'@
$nativeArguments = @('create', 'RightDataNetwork', 'binPath=', '"C:\Program Files\RightData\service.exe" --data-dir "C:\ProgramData\RightData\network"', '', 'C:\ends-with-slash\', 'a&b')
$nativeCommand = 'probe.exe ' + (($nativeArguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' ')
$parsedArguments = [InstallerArgvTest]::Parse($nativeCommand)
if ($parsedArguments.Count -ne $nativeArguments.Count + 1) { throw 'Native argument count changed' }
for ($i=0; $i -lt $nativeArguments.Count; $i++) {
    if ($parsedArguments[$i+1] -cne $nativeArguments[$i]) { throw "Native argument $i changed during serialization" }
}
'Native argument boundaries, spaces, embedded quotes, empty arguments and trailing backslashes passed.'
$controllerServiceAccessMask = 0x14
$serviceName = 'InMemoryTest'
$script:testSddl = 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)'
function Get-ServiceSecurityDescriptor { New-Object System.Security.AccessControl.RawSecurityDescriptor($script:testSddl) }
function Invoke-ServiceControl { param([string[]]$Arguments) $script:testSddl = $Arguments[2] }
$controller = [Security.Principal.WindowsIdentity]::GetCurrent().User
Grant-ControllerServiceStartAccess -ControllerSid $controller.Value
$granted = $script:testSddl
if ((Get-AllowedServiceAccessMask -Descriptor (Get-ServiceSecurityDescriptor) -Sid $controller) -ne 0x14) { throw 'Controller received incorrect service access' }
if ((Get-ServiceSecurityDescriptor).DiscretionaryAcl.Count -ne 3) { throw 'Existing service permissions were changed' }
Grant-ControllerServiceStartAccess -ControllerSid $controller.Value
if ($script:testSddl -ne $granted) { throw 'Repeated service access grant changed the descriptor' }
'Service ACL mutation and idempotency passed without modifying an operating-system service.'
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
