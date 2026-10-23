# macOS DMG lifecycle smoke test

`installer-macos.py` runs only when all of the following are true:

- `GITHUB_ACTIONS=true`
- `RUNNER_OS=macOS`
- `RUNNER_ENVIRONMENT=github-hosted`
- Python reports Darwin

The guard is intentional. The test mounts the final DMG, starts its application,
installs and controls the per-user `com.rightdata.network` LaunchAgent, and must
run on an ephemeral GitHub macOS runner. It refuses to start if the runner
already has a RightData LaunchAgent, plist, or user data directory.

Invoke it after `deploy/github/build-release.mjs` has built and copied the final,
signed target-specific DMG into `test/artifacts/release/`:

```sh
python3 test/client/installer-macos.py \
  --package test/artifacts/release/RightData-0.1.7-macos-arm64.dmg \
  --expected-version 0.1.7 \
  --expected-arch arm64
```

The equivalent target shorthand derives those three values from the release
layout and `client/package.json`:

```sh
python3 test/client/installer-macos.py aarch64-apple-darwin
```

Use `x86_64-apple-darwin` on the Intel runner.

Do not copy or spoof the guard variables to run this on a workstation. The script:

1. mounts the read-only DMG under a unique `test/build/installer-macos-*` path;
2. copies the real `.app` with `ditto` and checks its bundle ID, release version,
   native architecture, bundled helper architecture, and code signatures;
3. launches the copied application and allows up to 30 seconds for it to install
   the helper and LaunchAgent and expose the Unix control socket;
4. reads `status` over the framed socket even though the default business backend
   is unreachable;
5. verifies the helper copy, plist arguments, directory/socket permissions, app
   lifetime, service lifetime after app exit, service process restart, app
   restart, and stable device identity;
6. stops only the app processes it launched, boots out only the initially absent
   LaunchAgent label, removes only the plist created after preflight, detaches
   the DMG, and removes its unique `test/build` directory.

The service data directory is deliberately retained. The test never removes
`~/Library/Application Support/RightData/network`, matching product uninstall
semantics and avoiding deletion of device identity or connection data. The
structured result is written to `test/results/installer-macos.json` and contains
no proxy credential or device ID.
