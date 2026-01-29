# AGENTS.md

This repository builds Silicon Labs (EmberZNet/EZSP) firmware images from YAML manifests. It is designed to be used both by humans and by coding agents to produce reproducible `.gbl` artifacts and validate them against a real adapter.

## Project map

- `manifests/`:
  - One YAML file per firmware build variant (chip, project, UART pins, baudrate, flow control, stack sizing, etc.).
- `src/`:
  - Base Simplicity Studio projects (e.g. `src/zigbee_ncp`, `src/zigbee_router`, `src/openthread_rcp`).
- `tools/build_project.py`:
  - Builds a base project using the manifest: retargets the project, applies overrides, then generates and compiles.
- `tools/create_gbl.py`:
  - Post-build step that generates a `.gbl` and embeds JSON metadata (fw type/version/baudrate/variant, etc.).
- `.github/workflows/build.yaml`:
  - CI workflow that builds selected manifests and uploads artifacts.
- `tools/ember_zli_tool.mjs`:
  - Non-interactive helper to flash a `.gbl` and verify EZSP connectivity via the `ember-zli` Node.js package.

## Agent workflow (build → flash → verify)

### 1) Pick or create a manifest

- Prefer copying an existing manifest that matches the same chip family and firmware type.
- Typical keys to validate:
  - `device`, `base_project`, `sdk`, `toolchain`
  - `gbl.fw_type`, `gbl.*_version`, `gbl.baudrate`, `gbl.fw_variant`
  - `c_defines` UART peripheral + TX/RX pins + flow control type
- Keep the filename convention consistent with `README.md` (baudrate and flow control are part of the name).

### 2) Build an artifact (recommended: CI)

Use CI to avoid local SDK/toolchain setup.

- Trigger a targeted build (manifest stem without extension):
  - `gh workflow run build.yaml -f manifest_glob=<manifest_stem>`
- Download the run artifacts:
  - `gh run download <run_id> -D /tmp/firmware_artifacts`

### 3) Sanity-check the output

- Confirm you have the expected `.gbl`.
- If you change UART parameters (baudrate/flow control), remember:
  - The host application (e.g. Zigbee2MQTT / ZHA / OTBR) must be configured to match.
  - For TCP-based adapters (bridge boards), the bridge UART settings must match the radio firmware UART settings.

### 4) Flash the `.gbl`

- Use the non-interactive flasher:
  - `node tools/ember_zli_tool.mjs flash-gbl --gbl <file.gbl> --port <serial_or_tcp_port>`
- The underlying bootloader typically runs at `115200` internally; the application firmware baudrate is separate.

### 5) Verify EZSP connectivity post-flash

- Dump stack configuration:
  - `node tools/ember_zli_tool.mjs dump-stack-config --port <serial_or_tcp_port> --out /tmp/stack_config.json`
- If EZSP fails to start, double-check:
  - Port path and flow control settings
  - Baudrate match between firmware and your host/bridge
  - That you did not change the host/bridge baudrate before flashing a firmware that supports it

## Notes for agents

- Avoid “blind” manifest edits.
  - Changing pin mapping or flow control incorrectly will produce a firmware that cannot communicate.
- Keep changes minimal and reviewable.
  - Prefer adding a new manifest for a new variant instead of rewriting a known-good one.
