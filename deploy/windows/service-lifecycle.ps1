[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('PreInstall', 'PostInstall', 'Uninstall')]
    [string]$Action,

    [Parameter(Mandatory = $true)]
    [string]$InstallDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$serviceName = 'RightDataNetwork'
$displayName = 'RightData Network Service'
$firewallRuleName = 'RightDataNetwork-Program-v1'
$executableName = 'rightdata-network-service.exe'
$dataDir = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'RightData\network'
$scExe = Join-Path $env:SystemRoot 'System32\sc.exe'
# SERVICE_QUERY_STATUS | SERVICE_START. The desktop client does not receive
# query-config, change-config, stop, delete, or security-descriptor rights.
$controllerServiceAccessMask = 0x00000014

function Assert-ControllerSid {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Sid
    )

    # Local/domain and Microsoft Entra user SIDs, never group/system identities.
    if ($Sid -notmatch '^(?:S-1-5-21(?:-[0-9]+){4}|S-1-12-1(?:-[0-9]+){4})$') {
        throw "Invalid controller user SID: $Sid"
    }
    try {
        [void](New-Object System.Security.Principal.SecurityIdentifier($Sid))
    }
    catch {
        throw "Invalid controller user SID: $Sid"
    }
}

function Get-ConfiguredControllerSid {
    $serviceRegistryPath = "Registry::HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Services\$serviceName"
    if (-not (Test-Path -LiteralPath $serviceRegistryPath)) {
        return $null
    }

    $imagePath = (Get-ItemProperty -LiteralPath $serviceRegistryPath -Name ImagePath -ErrorAction Stop).ImagePath
    $match = [regex]::Match(
        $imagePath,
        '(?i)(?:^|\s)--controller-sid\s+(?:"(?<sid>S-1-5-[0-9-]+)"|(?<sid>S-1-5-[0-9-]+))(?:\s|$)'
    )
    if (-not $match.Success) {
        return $null
    }

    $sid = $match.Groups['sid'].Value
    Assert-ControllerSid -Sid $sid
    $sid
}

function Get-InstallerSessionId {
    [Diagnostics.Process]::GetCurrentProcess().SessionId
}

function Get-SessionAccount {
    param([int]$SessionId)
    # NSIS can launch 32-bit PowerShell on 64-bit Windows. Process.Path then
    # cannot reliably inspect the 64-bit Explorer process. WTS is bitness-neutral
    # and returns the desktop owner even when UAC uses another administrator.
    if (-not ('RightData.InstallerSession' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
namespace RightData {
    public static class InstallerSession {
        [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool WTSQuerySessionInformationW(IntPtr server, int session, int info, out IntPtr buffer, out int length);
        [DllImport("wtsapi32.dll")]
        private static extern void WTSFreeMemory(IntPtr buffer);
        public static string Query(int session, int info) {
            IntPtr buffer = IntPtr.Zero;
            int length;
            try {
                if (!WTSQuerySessionInformationW(IntPtr.Zero, session, info, out buffer, out length))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                return buffer == IntPtr.Zero ? "" : Marshal.PtrToStringUni(buffer);
            } finally { if (buffer != IntPtr.Zero) WTSFreeMemory(buffer); }
        }
    }
}
'@
    }
    $user = [RightData.InstallerSession]::Query($SessionId, 5)
    $domain = [RightData.InstallerSession]::Query($SessionId, 7)
    if ([string]::IsNullOrWhiteSpace($user)) { throw 'No signed-in user in this Windows session.' }
    if ([string]::IsNullOrWhiteSpace($domain)) { return $user }
    "$domain\$user"
}

function Get-InteractiveControllerSid {
    $sessionId = Get-InstallerSessionId
    if ($sessionId -le 0) { throw 'First installation requires a signed-in desktop session (console or Remote Desktop).' }
    $name = Get-SessionAccount -SessionId $sessionId
    $account = New-Object System.Security.Principal.NTAccount($name)
    $sid = $account.Translate([System.Security.Principal.SecurityIdentifier]).Value
    Assert-ControllerSid -Sid $sid
    $sid
}

function Get-ControllerSid {
    $configuredSid = Get-ConfiguredControllerSid
    if ($null -ne $configuredSid) {
        return $configuredSid
    }
    Get-InteractiveControllerSid
}

function Set-PrivateDataAcl {
    $systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
    $administratorsSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
    $items = @((Get-Item -LiteralPath $dataDir -Force)) +
        @(Get-ChildItem -LiteralPath $dataDir -Force -Recurse -ErrorAction Stop)

    foreach ($item in $items) {
        $isDirectory = $item.PSIsContainer
        $security = if ($isDirectory) {
            New-Object System.Security.AccessControl.DirectorySecurity
        }
        else {
            New-Object System.Security.AccessControl.FileSecurity
        }
        $security.SetAccessRuleProtection($true, $false)
        $security.SetOwner($systemSid)

        $inheritance = if ($isDirectory) {
            [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
                [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
        }
        else {
            [System.Security.AccessControl.InheritanceFlags]::None
        }
        foreach ($sid in @($systemSid, $administratorsSid)) {
            $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
                $sid,
                [System.Security.AccessControl.FileSystemRights]::FullControl,
                $inheritance,
                [System.Security.AccessControl.PropagationFlags]::None,
                [System.Security.AccessControl.AccessControlType]::Allow
            )
            [void]$security.AddAccessRule($rule)
        }
        Set-Acl -LiteralPath $item.FullName -AclObject $security -ErrorAction Stop
    }
}

function Get-RightDataService {
    Get-Service -Name $serviceName -ErrorAction SilentlyContinue
}

function Invoke-ServiceControl {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,

        [int[]]$AllowedExitCodes = @(0)
    )

    # sc.exe requires each option name (including '=') and its value as distinct
    # argv entries. Serialize explicitly because Windows PowerShell 5.1 strips
    # embedded quotes from executable paths when invoking native tools directly.
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $scExe
    $startInfo.Arguments = ($Arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' '
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($startInfo)
    try {
        $output = $process.StandardOutput.ReadToEnd()
        $errorOutput = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        $exitCode = $process.ExitCode
    } finally { $process.Dispose() }
    if ($exitCode -notin $AllowedExitCodes) {
        throw "sc.exe $($Arguments[0]) failed with exit code ${exitCode}: $output $errorOutput"
    }
}

function ConvertTo-NativeArgument {
    param([AllowEmptyString()][string]$Value)
    # CommandLineToArgvW: double backslashes before a quote or the closing quote.
    '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}

function Get-ServiceSecurityDescriptor {
    $output = @(& $scExe 'sdshow' $serviceName 2>&1)
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "sc.exe sdshow failed with exit code $exitCode."
    }

    $sddl = $output |
        ForEach-Object { $_.ToString().Trim() } |
        Where-Object { $_ -match '^(?:O:|G:|D:|S:)' -and $_ -match 'D:' } |
        Select-Object -Last 1
    if ([string]::IsNullOrWhiteSpace($sddl)) {
        throw "Could not read the $serviceName service security descriptor."
    }

    try {
        New-Object System.Security.AccessControl.RawSecurityDescriptor($sddl)
    }
    catch {
        throw "Could not parse the $serviceName service security descriptor."
    }
}

function Get-AllowedServiceAccessMask {
    param(
        [Parameter(Mandatory = $true)]
        [System.Security.AccessControl.RawSecurityDescriptor]$Descriptor,

        [Parameter(Mandatory = $true)]
        [System.Security.Principal.SecurityIdentifier]$Sid
    )

    $allowedMask = 0
    $dacl = $Descriptor.DiscretionaryAcl
    if ($null -eq $dacl) {
        throw "$serviceName has a null DACL; refusing to replace it."
    }
    for ($index = 0; $index -lt $dacl.Count; $index++) {
        $ace = $dacl[$index]
        if (
            $ace -is [System.Security.AccessControl.QualifiedAce] -and
            $ace.AceQualifier -eq [System.Security.AccessControl.AceQualifier]::AccessAllowed -and
            $null -ne $ace.SecurityIdentifier -and
            $ace.SecurityIdentifier.Value -eq $Sid.Value
        ) {
            $allowedMask = $allowedMask -bor $ace.AccessMask
        }
    }
    $allowedMask
}

function Grant-ControllerServiceStartAccess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ControllerSid
    )

    Assert-ControllerSid -Sid $ControllerSid
    $sid = New-Object System.Security.Principal.SecurityIdentifier($ControllerSid)
    $descriptor = Get-ServiceSecurityDescriptor
    $dacl = $descriptor.DiscretionaryAcl
    $allowedMask = Get-AllowedServiceAccessMask -Descriptor $descriptor -Sid $sid
    $missingMask = $controllerServiceAccessMask -band (-bnot $allowedMask)
    if ($missingMask -eq 0) {
        return
    }

    $newAce = New-Object System.Security.AccessControl.CommonAce(
        [System.Security.AccessControl.AceFlags]::None,
        [System.Security.AccessControl.AceQualifier]::AccessAllowed,
        $missingMask,
        $sid,
        $false,
        $null
    )
    $insertIndex = $dacl.Count
    for ($index = 0; $index -lt $dacl.Count; $index++) {
        if (($dacl[$index].AceFlags -band [System.Security.AccessControl.AceFlags]::Inherited) -ne 0) {
            $insertIndex = $index
            break
        }
    }
    $dacl.InsertAce($insertIndex, $newAce)
    $updatedSddl = $descriptor.GetSddlForm(
        [System.Security.AccessControl.AccessControlSections]::All
    )
    Invoke-ServiceControl -Arguments @('sdset', $serviceName, $updatedSddl)

    $verified = Get-ServiceSecurityDescriptor
    $verifiedMask = Get-AllowedServiceAccessMask -Descriptor $verified -Sid $sid
    if (($verifiedMask -band $controllerServiceAccessMask) -ne $controllerServiceAccessMask) {
        throw "The $serviceName controller service permissions were not applied."
    }
}

function Stop-RightDataService {
    $service = Get-RightDataService
    if ($null -eq $service -or $service.Status -eq [System.ServiceProcess.ServiceControllerStatus]::Stopped) {
        return
    }

    Stop-Service -Name $serviceName -ErrorAction Stop
    $service.WaitForStatus(
        [System.ServiceProcess.ServiceControllerStatus]::Stopped,
        [TimeSpan]::FromSeconds(30)
    )
    $service.Refresh()
    if ($service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Stopped) {
        throw "$serviceName did not stop within 30 seconds."
    }
}

function Resolve-ServiceExecutable {
    if (-not [IO.Path]::IsPathRooted($InstallDir)) {
        throw 'The installer directory must be an absolute path.'
    }

    $normalizedInstallDir = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
    $executablePath = [IO.Path]::GetFullPath((Join-Path $normalizedInstallDir $executableName))
    $expectedPrefix = $normalizedInstallDir + [IO.Path]::DirectorySeparatorChar
    if (-not $executablePath.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The service executable resolved outside the installer directory.'
    }
    if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) {
        throw "The service executable is missing: $executablePath"
    }
    $executablePath
}

function Install-RightDataService {
    $executablePath = Resolve-ServiceExecutable
    $controllerSid = Get-ControllerSid
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    Set-PrivateDataAcl
    $binaryPath = '"{0}" --service --data-dir "{1}" --controller-sid {2}' -f `
        $executablePath, $dataDir, $controllerSid

    if ($null -eq (Get-RightDataService)) {
        Invoke-ServiceControl -Arguments @(
            'create', $serviceName,
            'binPath=', $binaryPath,
            'start=', 'demand',
            'type=', 'own',
            'error=', 'normal',
            'obj=', 'LocalSystem',
            'DisplayName=', $displayName
        )
        Invoke-ServiceControl -Arguments @(
            'description', $serviceName,
            'Provides RightData device discovery and peer transport.'
        )
    }
    else {
        # Preserve the user's current automatic/manual startup choice on upgrades.
        Invoke-ServiceControl -Arguments @(
            'config', $serviceName,
            'binPath=', $binaryPath,
            'type=', 'own',
            'error=', 'normal',
            'obj=', 'LocalSystem',
            'DisplayName=', $displayName
        )
    }

    Grant-ControllerServiceStartAccess -ControllerSid $controllerSid

    Get-NetFirewallRule -Name $firewallRuleName -ErrorAction SilentlyContinue |
        Remove-NetFirewallRule -ErrorAction Stop
    New-NetFirewallRule `
        -Name $firewallRuleName `
        -DisplayName 'RightData Network Service' `
        -Description 'Allows inbound peer transport for the RightData network service.' `
        -Program $executablePath `
        -Direction Inbound `
        -Action Allow `
        -Profile Any `
        -Enabled True | Out-Null

    Start-Service -Name $serviceName -ErrorAction Stop
    $service = Get-RightDataService
    $service.WaitForStatus(
        [System.ServiceProcess.ServiceControllerStatus]::Running,
        [TimeSpan]::FromSeconds(30)
    )
}

function Uninstall-RightDataService {
    Stop-RightDataService
    if ($null -ne (Get-RightDataService)) {
        Invoke-ServiceControl -Arguments @('delete', $serviceName)
    }
    Get-NetFirewallRule -Name $firewallRuleName -ErrorAction SilentlyContinue |
        Remove-NetFirewallRule -ErrorAction Stop

    # The service data in $dataDir is intentionally retained across upgrades and uninstall.
}

switch ($Action) {
    'PreInstall' {
        Stop-RightDataService
    }
    'PostInstall' {
        Install-RightDataService
    }
    'Uninstall' {
        Uninstall-RightDataService
    }
}
