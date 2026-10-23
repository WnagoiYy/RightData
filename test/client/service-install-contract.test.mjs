import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "../..");

async function read(relativePath) {
  return readFile(path.join(projectRoot, relativePath), "utf8");
}

test("Windows service runtime uses the fixed SCM identity and graceful shutdown", async () => {
  const source = await read("client/network-service/src/windows_service.rs");

  assert.match(source, /SERVICE_NAME:\s*&str\s*=\s*"RightDataNetwork"/);
  assert.match(source, /service_dispatcher::start\(SERVICE_NAME, ffi_service_main\)/);
  assert.match(source, /watch::channel\(false\)/);
  assert.match(source, /ServiceControl::Stop\s*\|\s*ServiceControl::Shutdown/);
  assert.match(source, /crate::run\(data_dir, shutdown_rx\)/);
  assert.match(source, /pub fn set_auto_start\(enabled: bool\)/);
  assert.match(source, /ChangeServiceConfigW/);
  assert.match(source, /pub fn query_auto_start\(\)/);
  assert.match(source, /static SCM_SERVICE_CONTEXT:\s*AtomicBool\s*=\s*AtomicBool::new\(false\)/);
  assert.match(source, /fn service_main[\s\S]*SCM_SERVICE_CONTEXT\.store\(true, Ordering::Release\)/);
  assert.match(source, /fn ensure_scm_service_context\(\)[\s\S]*unsupported outside the Windows service context/);
});

test("installer lifecycle is fixed-scope and preserves service data", async () => {
  const [hooks, lifecycle, defaultsText] = await Promise.all([
    read("deploy/windows/installer-hooks.nsh"),
    read("deploy/windows/service-lifecycle.ps1"),
    read("deploy/windows/service-defaults.json"),
  ]);
  const defaults = JSON.parse(defaultsText);

  for (const hook of [
    "NSIS_HOOK_PREINSTALL",
    "NSIS_HOOK_POSTINSTALL",
    "NSIS_HOOK_PREUNINSTALL",
    "NSIS_HOOK_POSTUNINSTALL",
  ]) {
    assert.match(hooks, new RegExp(`!macro ${hook}\\b`));
  }
  assert.match(hooks, /-NoProfile -NonInteractive/);
  assert.match(hooks, /-Action "\$\{ACTION\}" -InstallDir "\$INSTDIR"/);

  assert.match(lifecycle, /\$serviceName\s*=\s*'RightDataNetwork'/);
  assert.match(lifecycle, /\$firewallRuleName\s*=\s*'RightDataNetwork-Program-v1'/);
  assert.match(lifecycle, /'obj=', 'LocalSystem'/);
  assert.match(lifecycle, /'start=', 'demand'/);
  assert.doesNotMatch(lifecycle, /'start=', 'auto'/);
  assert.match(lifecycle, /'binPath=', \$binaryPath/);
  assert.match(lifecycle, /ConvertTo-NativeArgument/);
  assert.match(lifecycle, /--service --data-dir/);
  assert.match(lifecycle, /--controller-sid/);
  assert.match(lifecycle, /S-1-5-21/);
  assert.match(lifecycle, /WTSQuerySessionInformationW/);
  assert.doesNotMatch(lifecycle, /Get-Process -Name explorer/);
  assert.match(lifecycle, /Get-ConfiguredControllerSid/);
  assert.match(lifecycle, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(lifecycle, /S-1-5-18/);
  assert.match(lifecycle, /S-1-5-32-544/);
  assert.match(lifecycle, /RawSecurityDescriptor/);
  assert.match(lifecycle, /DiscretionaryAcl/);
  assert.match(lifecycle, /CommonAce/);
  assert.match(lifecycle, /AceQualifier\]::AccessAllowed/);
  assert.match(lifecycle, /InsertAce/);
  assert.match(lifecycle, /GetSddlForm/);
  assert.match(lifecycle, /'sdshow'/);
  assert.match(lifecycle, /'sdset'/);
  assert.match(lifecycle, /Grant-ControllerServiceStartAccess -ControllerSid \$controllerSid/);
  assert.match(lifecycle, /WaitForStatus/);
  assert.match(lifecycle, /Get-NetFirewallRule -Name \$firewallRuleName/);
  assert.match(lifecycle, /Remove-NetFirewallRule/);
  assert.doesNotMatch(lifecycle, /Start-Process[\s\S]*-Verb\s+RunAs/i);
  assert.doesNotMatch(lifecycle, /Remove-Item[^\r\n]*\$dataDir/i);

  const accessMaskMatch = lifecycle.match(/\$controllerServiceAccessMask\s*=\s*0x([0-9a-f]+)/i);
  assert.ok(accessMaskMatch, "controller service access mask must be explicit");
  const accessMask = Number.parseInt(accessMaskMatch[1], 16);
  assert.equal(accessMask, 0x14, "controller may only query status and start the service");
  for (const forbidden of [0x01, 0x02, 0x20, 0x10000, 0x40000]) {
    assert.equal(accessMask & forbidden, 0, `controller service mask includes forbidden bit 0x${forbidden.toString(16)}`);
  }
  const installFunction = lifecycle.slice(
    lifecycle.indexOf("function Install-RightDataService"),
    lifecycle.indexOf("function Uninstall-RightDataService"),
  );
  assert.ok(
    installFunction.indexOf("Grant-ControllerServiceStartAccess") < installFunction.indexOf("Start-Service"),
    "controller start access must be applied before the service is started",
  );

  assert.equal(defaults.serviceName, "RightDataNetwork");
  assert.equal(defaults.executableName, "rightdata-network-service.exe");
  assert.equal(defaults.account, "LocalSystem");
  assert.equal(defaults.startType, "manual");
  assert.equal(defaults.dataDirectory, "%ProgramData%\\RightData\\network");
  assert.deepEqual(defaults.launchArguments.slice(-2), [
    "--controller-sid",
    "%ControllerUserSid%",
  ]);
  assert.equal(defaults.firewallRuleName, "RightDataNetwork-Program-v1");
  assert.equal(defaults.preserveDataOnUninstall, true);
});

test("Tauri bundles the service through a per-machine NSIS installer", async () => {
  const config = JSON.parse(await read("client/src-tauri/tauri.conf.json"));
  const nsis = config.bundle?.windows?.nsis;

  assert.equal(nsis?.installMode, "perMachine");
  assert.equal(
    nsis?.installerHooks?.replaceAll("\\", "/"),
    "../../deploy/windows/installer-hooks.nsh",
  );

  const resources = config.bundle?.resources;
  assert.ok(resources && !Array.isArray(resources), "bundle.resources must map the service filename");
  const serviceSource = Object.entries(resources).find(
    ([, destination]) => destination === "rightdata-network-service.exe",
  )?.[0];
  assert.ok(serviceSource, "network service executable resource is missing");
  assert.match(
    serviceSource.replaceAll("\\", "/"),
    /target\/x86_64-pc-windows-msvc\/release\/rightdata-network-service\.exe$/,
  );
});

test("packaging builds the service into client target before invoking Tauri", async () => {
  const [buildScript, packageScript] = await Promise.all([
    read("deploy/windows/build-network-service.ps1"),
    read("deploy/windows/package-windows.ps1"),
  ]);

  assert.match(buildScript, /client\\target/);
  assert.match(buildScript, /--locked/);
  assert.match(buildScript, /x86_64-pc-windows-msvc/);
  assert.match(packageScript, /build-network-service\.ps1/);
  assert.match(packageScript, /--bundles nsis/);
  assert.match(packageScript, /installMode -ne 'perMachine'/);
});
