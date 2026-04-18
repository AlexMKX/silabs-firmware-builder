# SLZB-06MU MR3 Dense Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a "fat" Zigbee router GBL for SLZB-06MU (EFR32MG21, 768 KiB flash / 96 KiB RAM) tuned for a dense ~150-device mesh, build it on GitHub Actions, and flash it via the device's own web-UI firmware-upload API without losing the existing Zigbee network membership.

**Architecture:** New manifest `smlight_slzb06mu_mr3_dense_zigbee_router.yaml` on a fresh branch off `upstream/sisdk-2025.12.x`. Manifest inherits all pin/clock from the stock `smlight_slzb06m_zigbee_router.yaml` and adds 6 deltas (route/discovery/broadcast/key tables, APS dup-rejection, packet buffer heap = LARGE). Build via existing `.github/workflows/build.yaml`, download the GBL artifact via `gh`, flash via the SLZB web API (`POST /fileUpload` + `GET /api2?action=6&local=1...`), verify by polling `/api2?action=1&param=zbRev` and tailing Z2M logs.

**Tech Stack:** SimplicityStudio SDK 2025.12.2, EmberZNet, EFR32MG21, GitHub Actions, MQTT (zigbee2mqtt), SLZB-06MU SLZB-OS web API (curl).

**Spec:** `docs/superpowers/specs/2026-04-18-slzb06mu-dense-router-design.md`

**Working dir for all commands:** `/home/alex/Projects/zigbee/zigbee-silabs-firmware`

**Hard rules** (re-stated from spec, observed during execution):
- Target = SLZB-06MU at `http://192.168.88.144/` ONLY.
- Do NOT touch the Z2M coordinator at `slzb-mr3.h.xxl.cx` (192.168.88.228) — that is a different physical device (NCP, MG24).
- Do NOT use `ember-zli` for this device — it is a standalone Wi-Fi router with no TCP UART bridge open. All flashing goes through the SLZB web API.

---

## File Structure

| File | Responsibility |
|---|---|
| `manifests/smlight/smlight_slzb06mu_mr3_dense_zigbee_router.yaml` | NEW. The dense-router manifest. Sole new artifact. |
| `docs/superpowers/specs/2026-04-18-slzb06mu-dense-router-design.md` | Already exists (design spec, committed). |
| `docs/superpowers/plans/2026-04-18-slzb06mu-dense-router.md` | This plan (committed alongside the manifest). |

No source/code modifications. No workflow changes. Single manifest commit + plan commit.

---

## Task 1: Verify branch state and target identity

**Files:** none — environmental checks.

- [ ] **Step 1: Confirm we are on the right branch from upstream**

```bash
git -C /home/alex/Projects/zigbee/zigbee-silabs-firmware branch --show-current
git -C /home/alex/Projects/zigbee/zigbee-silabs-firmware log --oneline upstream/sisdk-2025.12.x..HEAD
```

Expected:
- `mr3-dense-router-2025.12.x`
- One commit: `28dcc6b docs: add SLZB-06MU MR3 dense router design spec`

- [ ] **Step 2: Confirm SLZB-06MU is reachable**

```bash
curl -sk --max-time 5 -o /dev/null -w "%{http_code}\n" http://192.168.88.144/
```

Expected: `200`

- [ ] **Step 3: Confirm we are talking to the right physical device**

```bash
curl -sk --max-time 5 http://192.168.88.144/ha_info | python3 -m json.tool
```

Expected JSON includes:
- `"model": "SLZB-06MU"`
- `"zb_hw": "EFR32MG21"`
- `"zb_flash_size": 768`
- `"zb_ram_size": 96`
- `"device_ip": "192.168.88.144"`
- `"hostname": "SLZB-06MU"`

If `model` is anything else (e.g. `SLZB-MR3`, `SLZB-06M`), STOP — wrong device.

Capture the current Zigbee revision for later comparison:

```bash
ZB_REV_PRE=$(curl -sk --max-time 5 "http://192.168.88.144/api2?action=1&param=zbRev")
echo "ZB_REV_PRE=$ZB_REV_PRE"
```

Expected: a numeric date-style revision (currently `20250602`). Save it — we'll compare against the post-flash revision.

- [ ] **Step 4: Confirm Z2M log path exists**

```bash
ls -1 /home/alex/Projects/zigbee/45df7312_zigbee2mqtt/zigbee2mqtt/log/ | sort | tail -5
```

Expected: at least one timestamped subdirectory (e.g. `2026-04-18.15-38-09`).

- [ ] **Step 5: Confirm gh CLI is authenticated against the right account**

```bash
gh auth status 2>&1 | grep -E "Active account|Logged in"
```

Expected: `Active account: true` for `AlexMKX`.

- [ ] **Step 6: Confirm the upload + flash endpoints respond**

```bash
# These are read-only probes (HEAD, no payload). They must NOT trigger a flash.
curl -sk --max-time 5 -o /dev/null -w "fileUpload: %{http_code}\n" -X HEAD "http://192.168.88.144/fileUpload"
curl -sk --max-time 5 -o /dev/null -w "api2: %{http_code}\n" -X HEAD "http://192.168.88.144/api2"
```

Expected: any non-5xx response (200/400/404 are all fine — we only care that the routes exist on the web server). 5xx means the device is in trouble — stop.

---

## Task 2: Create the dense-router manifest

**Files:**
- Create: `manifests/smlight/smlight_slzb06mu_mr3_dense_zigbee_router.yaml`

- [ ] **Step 1: Write the manifest**

Create `manifests/smlight/smlight_slzb06mu_mr3_dense_zigbee_router.yaml` with the following exact content:

```yaml
name: SMLIGHT SLZB-06MU MR3 Dense Zigbee Router (Optimized for ~150-device mesh)
device: EFR32MG21A020F768IM32
base_project: src/zigbee_router
filename: "{manifest_name}_{sdk_version}_{fw_version}_{baudrate}_{fw_variant}"
sdk: "simplicity_sdk:2025.12.2"
toolchain: "12.2.1.20221205"

gbl:
  fw_type: zigbee_router
  baudrate: 115200
  fw_variant: sw_flow

# This file is a "dense" sibling of `smlight_slzb06m_zigbee_router.yaml`.
# Pin/clock/UART/LED are byte-for-byte identical to the stock SMLIGHT
# SLZB-06M router manifest. The only differences are the `slcp_defines` and
# the extra `c_defines` block at the bottom that widen Zigbee tables for
# routers serving very dense meshes (~150 devices).
#
# IMPORTANT: stack table sizes (ROUTE_TABLE_SIZE, DISCOVERY_TABLE_SIZE) MUST
# go in `slcp_defines`. Putting them in `configuration:` does not stick on
# this codebase — see commit 96aa4d6 in the NCP history
# ("revert unsupported neighbor table size override").

add_components:
  # Status LED on PC0 (same as stock SLZB-06M router manifest)
  - id: simple_led
    instance:
      - led0

slcp_defines:
  # Transit-side widening — biggest single win for a 150-device mesh.
  SL_ZIGBEE_ROUTE_TABLE_SIZE: 80            # upstream MG21 default: 16
  SL_ZIGBEE_DISCOVERY_TABLE_SIZE: 24        # upstream MG21 default: 16

c_defines:
  # === Pin/clock/UART/LED (identical to upstream smlight_slzb06m_zigbee_router.yaml) ===
  SL_IOSTREAM_USART_VCOM_BAUDRATE: 115200
  SL_IOSTREAM_USART_VCOM_FLOW_CONTROL_TYPE: uartFlowControlSoftware

  SL_IOSTREAM_USART_VCOM_PERIPHERAL: USART0
  SL_IOSTREAM_USART_VCOM_PERIPHERAL_NO: 0

  SL_IOSTREAM_USART_VCOM_TX_PORT: SL_GPIO_PORT_B
  SL_IOSTREAM_USART_VCOM_TX_PIN: 1

  SL_IOSTREAM_USART_VCOM_RX_PORT: SL_GPIO_PORT_B
  SL_IOSTREAM_USART_VCOM_RX_PIN: 0

  SL_IOSTREAM_USART_VCOM_CTS_PORT: 0
  SL_IOSTREAM_USART_VCOM_CTS_PIN: 0

  SL_IOSTREAM_USART_VCOM_RTS_PORT: 0
  SL_IOSTREAM_USART_VCOM_RTS_PIN: 0

  SL_SIMPLE_LED_LED0_POLARITY: SL_SIMPLE_LED_POLARITY_ACTIVE_HIGH
  SL_SIMPLE_LED_LED0_PORT: SL_GPIO_PORT_C
  SL_SIMPLE_LED_LED0_PIN: 0

  SL_CLOCK_MANAGER_HFXO_CTUNE: 80

  SL_RAIL_UTIL_RSSI_OFFSET: -11

  # === Dense-router deltas ===
  # Larger packet buffer heap. NOT `HUGE` — that is sized for MG24/MG26
  # (1 MiB flash, 256 KiB RAM). LARGE is the most we can afford on MG21
  # (768 KiB flash, 96 KiB RAM).
  SL_ZIGBEE_PACKET_BUFFER_HEAP_SIZE: SL_ZIGBEE_LARGE_PACKET_BUFFER_HEAP

  # Bigger broadcast tracking table — Tuya devices flood broadcasts.
  # upstream MG21 default: 30
  SL_ZIGBEE_BROADCAST_TABLE_SIZE: 35

  # Allow several unique APS link keys (per-child) instead of a single one.
  # upstream MG21 default: 1
  SL_ZIGBEE_KEY_TABLE_SIZE: 8

  # APS duplicate-rejection table is unset for xg21 in upstream router.slcp
  # but is 64 for xg24/xg26. Tuya retries badly — we want at least the
  # xg24 default here.
  SL_ZIGBEE_APS_DUPLICATE_REJECTION_MAX_ENTRIES: 64
```

- [ ] **Step 2: Verify YAML is parseable**

```bash
python3 -c "import yaml; yaml.safe_load(open('manifests/smlight/smlight_slzb06mu_mr3_dense_zigbee_router.yaml'))" && echo OK
```

Expected: `OK`

- [ ] **Step 3: Verify pin/clock block matches the stock SLZB-06M router manifest exactly**

```bash
diff <(grep -E '^\s+SL_(IOSTREAM|SIMPLE_LED|CLOCK_MANAGER|RAIL_UTIL)' \
        manifests/smlight/smlight_slzb06m_zigbee_router.yaml) \
     <(grep -E '^\s+SL_(IOSTREAM|SIMPLE_LED|CLOCK_MANAGER|RAIL_UTIL)' \
        manifests/smlight/smlight_slzb06mu_mr3_dense_zigbee_router.yaml | grep -v PACKET_BUFFER)
```

Expected: empty diff (the new manifest's pin section is a superset that is byte-identical for SL_IOSTREAM/SIMPLE_LED/CLOCK_MANAGER/RAIL_UTIL lines).

- [ ] **Step 4: Verify the manifest is picked up by the workflow's matrix**

```bash
find manifests -type f \( -name "*.yaml" -o -name "*.yml" \) -print | grep slzb06mu_mr3_dense
```

Expected: `manifests/smlight/smlight_slzb06mu_mr3_dense_zigbee_router.yaml`

- [ ] **Step 5: Run pre-commit if installed (matches CI's pre-commit step)**

```bash
pre-commit run --files manifests/smlight/smlight_slzb06mu_mr3_dense_zigbee_router.yaml || \
  echo "pre-commit not installed locally — CI will run it"
```

Expected: passes, OR "pre-commit not installed" message.

- [ ] **Step 6: Commit**

```bash
git add manifests/smlight/smlight_slzb06mu_mr3_dense_zigbee_router.yaml \
        docs/superpowers/plans/2026-04-18-slzb06mu-dense-router.md
git commit -m "feat: add SLZB-06MU MR3 Dense Zigbee Router manifest

Mirrors smlight_slzb06m_zigbee_router.yaml pinout for the SLZB-06MU
(EFR32MG21) and adds 6 deltas tuned for a dense ~150-device mesh:
ROUTE_TABLE 16->80, DISCOVERY_TABLE 16->24, BROADCAST_TABLE 30->35,
KEY_TABLE 1->8, APS_DUPLICATE_REJECTION 64, packet buffer heap LARGE.

Spec: docs/superpowers/specs/2026-04-18-slzb06mu-dense-router-design.md"
```

---

## Task 3: Push branch and trigger build

**Files:** none.

- [ ] **Step 1: Push the branch to origin (AlexMKX/silabs-firmware-builder)**

The current upstream tracking is `upstream/sisdk-2025.12.x`. We need to push to `origin`.

```bash
git push -u origin mr3-dense-router-2025.12.x
```

Expected: branch created on origin, output ends with `Branch 'mr3-dense-router-2025.12.x' set up to track 'origin/mr3-dense-router-2025.12.x'.`

- [ ] **Step 2: Trigger the workflow with a glob restricted to our manifest**

The `build.yaml` workflow accepts `manifest_glob` to limit which manifests are built (this avoids rebuilding 50+ unrelated firmwares).

```bash
gh workflow run build.yaml \
  --ref mr3-dense-router-2025.12.x \
  -f manifest_glob='*slzb06mu_mr3_dense*'
```

Expected: `✓ Created workflow_dispatch event for build.yaml at mr3-dense-router-2025.12.x`

- [ ] **Step 3: Find the run id**

```bash
sleep 5
RUN_ID=$(gh run list --workflow=build.yaml --branch=mr3-dense-router-2025.12.x \
  --limit 1 --json databaseId --jq '.[0].databaseId')
echo "RUN_ID=$RUN_ID"
```

Expected: a numeric run id (e.g. `RUN_ID=12345678`).

- [ ] **Step 4: Watch the run to completion**

```bash
gh run watch "$RUN_ID" --exit-status
```

Expected: exits 0 on success. If it exits non-zero, jump to "Failure handling: Build failure" below.

---

## Task 4: Download GBL artifact and verify

**Files:**
- Create: `/tmp/slzb06mu_dense_gbl/` (artifact download dir)

- [ ] **Step 1: Discover the artifact name**

```bash
gh run view "$RUN_ID" --json jobs --jq '.jobs[] | select(.name | startswith("Firmware builder")) | .name'
```

Expected: at least one line including `slzb06mu_mr3_dense`.

- [ ] **Step 2: Download the firmware artifact**

```bash
rm -rf /tmp/slzb06mu_dense_gbl && mkdir -p /tmp/slzb06mu_dense_gbl
gh run download "$RUN_ID" -p 'firmware-build-*slzb06mu_mr3_dense*' -D /tmp/slzb06mu_dense_gbl
```

Expected: at least one `.gbl` file under `/tmp/slzb06mu_dense_gbl/`.

- [ ] **Step 3: Locate the GBL file**

```bash
GBL=$(find /tmp/slzb06mu_dense_gbl -name '*slzb06mu_mr3_dense*.gbl' -type f | head -1)
echo "GBL=$GBL"
ls -la "$GBL"
```

Expected: file exists, size between roughly 200 KiB and 700 KiB (typical EFR32MG21 GBL range).

- [ ] **Step 4: Sanity-check the GBL header**

```bash
xxd "$GBL" | head -3
```

Expected: first 4 bytes `eb 17 a6 03` — the standard Silabs GBL magic number. If not, the artifact is wrong.

---

## Task 5: Pre-flash safety capture

**Files:** none — diagnostic capture before risk.

- [ ] **Step 1: Snapshot current SLZB device state**

```bash
curl -sk --max-time 5 http://192.168.88.144/ha_info > /tmp/slzb_ha_info_pre.json
python3 -m json.tool < /tmp/slzb_ha_info_pre.json | head -30
```

Expected: same JSON we saw in Task 1 step 3. Re-confirm `model=SLZB-06MU` and `zb_hw=EFR32MG21`. Save `zb_version` as `ZB_REV_PRE` if not already set:

```bash
ZB_REV_PRE=$(jq -r '.Info.zb_version' /tmp/slzb_ha_info_pre.json)
echo "ZB_REV_PRE=$ZB_REV_PRE"
```

- [ ] **Step 2: Identify the latest Z2M log file for tail-based verification**

```bash
LOG_BASE=/home/alex/Projects/zigbee/45df7312_zigbee2mqtt/zigbee2mqtt/log
LATEST_LOG_DIR=$(ls -1 "$LOG_BASE" | sort | tail -1)
LATEST_LOG="$LOG_BASE/$LATEST_LOG_DIR/log.log"
ls -la "$LATEST_LOG" 2>/dev/null || \
  LATEST_LOG=$(find "$LOG_BASE/$LATEST_LOG_DIR" -name '*.log' -o -name '*.txt' | head -1)
echo "LATEST_LOG=$LATEST_LOG"
tail -1 "$LATEST_LOG" | head -c 200
```

Expected: a real log file path is printed and tail returns at least one line.

- [ ] **Step 3: Snapshot Z2M's device list to find the SLZB router by IEEE/friendly_name**

The MAC of the SLZB-06MU EFR32 (from `ha_info`) is `58:E6:C5:46:1D:90`. Its Zigbee IEEE may differ (per-radio EUI64). Query Z2M:

```bash
ssh root@hassio.h.xxl.cx \
  'mosquitto_sub -h core-mosquitto -t zigbee2mqtt/bridge/devices -C 1 -W 5' \
  > /tmp/z2m_devices_pre.json
jq 'length' /tmp/z2m_devices_pre.json
jq -r '.[] | select(.type=="Router") | "\(.friendly_name)  ieee=\(.ieee_address)  manuf=\(.manufacturer // "?")  model=\(.model_id // .definition.model // "?")"' \
  /tmp/z2m_devices_pre.json | grep -i 'SLZB\|SMLIGHT\|router\|MR3' | head -10
```

Expected: at least one line that the user can identify as the SLZB-06MU router. If none, list all router-type devices to find it manually:

```bash
jq -r '.[] | select(.type=="Router") | "\(.friendly_name)  ieee=\(.ieee_address)"' \
  /tmp/z2m_devices_pre.json
```

Capture the recognized friendly name into a shell variable:

```bash
SLZB_FRIENDLY="<paste friendly_name here>"
echo "SLZB_FRIENDLY=$SLZB_FRIENDLY"
```

If the user cannot identify the router, STOP and ask. We need this name to verify rejoin in Task 7. Do NOT proceed to Task 6 without it — flashing without a verification target makes failure invisible.

---

## Task 6: Flash via the SLZB web API

**Files:** none — uses `curl` against `http://192.168.88.144/`.

This task replaces the earlier `ember-zli` plan because the SLZB-06MU on `192.168.88.144` is a standalone Wi-Fi router, not a serial gateway: its TCP UART bridge is closed. The right way to flash it is through its built-in firmware-upload web API.

The flow is:

1. `POST /fileUpload?customName=/fw.bin` (multipart, field `update`) — uploads the GBL into the device's filesystem as `/fw.bin`.
2. `GET /api2?action=6&zbChipIdx=0&local=1&fwVer=-1&fwType=0&baud=0&fwCh=2` — instructs the SLZB-OS to enter the EFR32 bootloader, push `/fw.bin` over the internal UART, and let the new firmware run.
3. Poll `/api2?action=1&param=zbRev` until the value differs from `ZB_REV_PRE`.

- [ ] **Step 1: Re-confirm we are still on the right device immediately before flashing**

```bash
MODEL=$(curl -sk --max-time 5 http://192.168.88.144/ha_info | jq -r '.Info.model')
echo "MODEL=$MODEL"
[ "$MODEL" = "SLZB-06MU" ] || { echo "WRONG DEVICE — aborting"; exit 1; }
```

Expected: `MODEL=SLZB-06MU`. If anything else, STOP.

- [ ] **Step 2: Upload the GBL to the device as `/fw.bin`**

```bash
curl -sk --max-time 120 \
  -F "update=@$GBL" \
  -w "\nHTTP %{http_code}  size=%{size_upload}  time=%{time_total}s\n" \
  "http://192.168.88.144/fileUpload?customName=/fw.bin" \
  | tee /tmp/slzb_upload.log
```

Expected: HTTP 200 and an upload time of a few seconds. The body may be empty or a short success message — that is fine.

- [ ] **Step 3: Trigger the local-file flash**

```bash
curl -sk --max-time 30 \
  "http://192.168.88.144/api2?action=6&zbChipIdx=0&local=1&fwVer=-1&fwType=0&baud=0&fwCh=2" \
  -w "\nHTTP %{http_code}  time=%{time_total}s\n" \
  | tee /tmp/slzb_flash_trigger.log
```

Expected: HTTP 200 within seconds. The body is usually empty — the actual flashing runs asynchronously on the device.

- [ ] **Step 4: Poll for firmware version change (max 5 minutes)**

```bash
echo "ZB_REV_PRE=$ZB_REV_PRE"
for i in $(seq 1 60); do
  ZB_REV_NOW=$(curl -sk --max-time 4 "http://192.168.88.144/api2?action=1&param=zbRev" 2>/dev/null || echo "?")
  echo "[$(date +%H:%M:%S)] try $i  zbRev=$ZB_REV_NOW"
  if [ -n "$ZB_REV_NOW" ] && [ "$ZB_REV_NOW" != "$ZB_REV_PRE" ] && [ "$ZB_REV_NOW" != "?" ]; then
    echo "FW updated: $ZB_REV_PRE -> $ZB_REV_NOW"
    break
  fi
  sleep 5
done
```

Expected: within ~2-3 minutes the loop prints `FW updated: <old> -> <new>`. The new revision will be a fresh date/build identifier set by the build system.

If the loop runs all 60 iterations and `zbRev` never changes, the flash failed — see "Failure handling: Flash failure" below. Do NOT retry blindly; investigate first.

- [ ] **Step 5: Wait for the EFR32 to settle**

```bash
sleep 20
curl -sk --max-time 5 -o /dev/null -w "web: %{http_code}\n" http://192.168.88.144/
```

Expected: web `200`.

---

## Task 7: Verify successful join

**Files:** none — observation only.

- [ ] **Step 1: Tail Z2M log for SLZB activity (60 seconds)**

```bash
timeout 60 tail -n 0 -F "$LATEST_LOG" 2>&1 \
  | grep -i --line-buffered "$SLZB_FRIENDLY\|router\|announce\|rejoin\|nwk" \
  | tee /tmp/z2m_post_flash.log &
TAIL_PID=$!
wait $TAIL_PID 2>/dev/null
```

Expected: at least one line about the device announcing or being seen. The tail naturally exits after 60 seconds.

- [ ] **Step 2: Re-query Z2M for the device's `last_seen`**

```bash
ssh root@hassio.h.xxl.cx \
  'mosquitto_sub -h core-mosquitto -t zigbee2mqtt/bridge/devices -C 1 -W 5' \
  > /tmp/z2m_devices_post.json
jq -r ".[] | select(.friendly_name==\"$SLZB_FRIENDLY\") | \"last_seen=\(.last_seen)  software_build_id=\(.software_build_id // \"n/a\")\"" \
  /tmp/z2m_devices_post.json
```

Expected: `last_seen` is within the last few minutes (after the flash). If `software_build_id` is reported, it should reflect the new firmware date/hash.

- [ ] **Step 3: Verify routes through the device**

If the SLZB-06MU is mid-mesh and other devices route through it, request a network map from Z2M:

```bash
ssh root@hassio.h.xxl.cx \
  'mosquitto_pub -h core-mosquitto -t zigbee2mqtt/bridge/request/networkmap -m "{\"type\":\"raw\",\"routes\":true}"'
sleep 60   # Z2M takes time to gather a full map on a 150-device net
ssh root@hassio.h.xxl.cx \
  'mosquitto_sub -h core-mosquitto -t zigbee2mqtt/bridge/response/networkmap -C 1 -W 90' \
  > /tmp/z2m_netmap.json
jq -r ".data.nodes[] | select(.friendlyName==\"$SLZB_FRIENDLY\") | .friendlyName" /tmp/z2m_netmap.json
jq -r ".data.links[] | select(.source==\"$SLZB_FRIENDLY\" or .target==\"$SLZB_FRIENDLY\") | \"\(.source) -> \(.target)  lqi=\(.lqi)\"" /tmp/z2m_netmap.json | head -20
```

Expected: SLZB-06MU appears as a node, and has at least one link (parent + ideally several neighbors). LQI > 30 on at least one link.

- [ ] **Step 4: Watch Z2M errors for 2 minutes**

```bash
timeout 120 tail -n 0 -F "$LATEST_LOG" 2>&1 \
  | grep -i --line-buffered "error\|warn" \
  | tee /tmp/z2m_errors_post.log
wc -l /tmp/z2m_errors_post.log
```

Expected: no flood of errors mentioning the SLZB friendly_name or its IEEE address. Occasional warnings about other devices are fine.

- [ ] **Step 5: Record the deployment in the spec and push**

If success, append a short post-flash note to the spec for traceability.

```bash
cat >> docs/superpowers/specs/2026-04-18-slzb06mu-dense-router-design.md <<EOF

## Implementation log

- $(date +%Y-%m-%d): built via GitHub Actions run $RUN_ID, GBL = \`$(basename "$GBL")\`.
- Flash via SLZB web API (\`POST /fileUpload\` + \`GET /api2?action=6&local=1\`) succeeded.
- zbRev: $ZB_REV_PRE -> $ZB_REV_NOW.
- Device rejoined existing Zigbee network without permit-join.
EOF

git add docs/superpowers/specs/2026-04-18-slzb06mu-dense-router-design.md
git commit -m "docs: record successful first deployment of dense router GBL"
git push origin mr3-dense-router-2025.12.x
```

Expected: commit pushed.

---

## Failure handling

### Build failure (Task 3 step 4 exits non-zero)

Open the run log:

```bash
gh run view "$RUN_ID" --log-failed | tail -200
```

Look for:

1. **`region 'FLASH' overflowed by N bytes`** — drop `SL_ZIGBEE_KEY_TABLE_SIZE` to `4`, then rebuild. If still tight, drop `SL_ZIGBEE_APS_DUPLICATE_REJECTION_MAX_ENTRIES` to `32`.
2. **`region 'RAM' overflowed by N bytes`** — drop `SL_ZIGBEE_ROUTE_TABLE_SIZE` to `64`, rebuild. If still tight, drop the `SL_ZIGBEE_PACKET_BUFFER_HEAP_SIZE` line entirely (revert to default).
3. **Unsupported define error from `slc generate`** — the build log will mention the offending define. For `SL_ZIGBEE_*` table defines that are rejected from `slcp_defines`, try moving them to `c_defines` only (the route/discovery sizes are the most likely culprits — see commit `96aa4d6`).

Each retry: edit the manifest, `git commit --amend --no-edit && git push --force-with-lease`, re-trigger workflow.

### Flash failure (Task 6 step 4 — `zbRev` never changes)

1. **HTTP errors during upload (Task 6 step 2):** the device may be busy. Retry the upload after 30 s. If repeated 5xx responses, check `curl -sk http://192.168.88.144/api2?action=5` (GET_LOG) for an internal error message.

2. **Upload OK but flash trigger returns non-200:** the device's `/fw.bin` slot is locked. Force a Zigbee soft reset and retry:

   ```bash
   curl -sk "http://192.168.88.144/api2?action=4&cmd=1"   # ZB_RST
   sleep 10
   curl -sk "http://192.168.88.144/api2?action=6&zbChipIdx=0&local=1&fwVer=-1&fwType=0&baud=0&fwCh=2"
   ```

3. **Trigger returned 200 but `zbRev` never changes:** the EFR32 may be stuck in the bootloader (the application image was rejected). Recover by re-flashing a known-good baseline:

   ```bash
   gh release download --repo Nerivec/silabs-firmware-builder \
     --pattern '*smlight_slzb06m_zigbee_router*.gbl' --dir /tmp/recovery
   curl -sk -F "update=@/tmp/recovery/<file>.gbl" \
     "http://192.168.88.144/fileUpload?customName=/fw.bin"
   curl -sk "http://192.168.88.144/api2?action=6&zbChipIdx=0&local=1&fwVer=-1&fwType=0&baud=0&fwCh=2"
   ```

   Wait the 5-minute window again. If the stock firmware also fails to install, escalate — the EFR32 itself may be in BSL but unresponsive. Try `/api2?action=4&cmd=2` (ZB_BSL) explicitly, then `/api2?action=4&cmd=9` (HARD_RESET) of the whole device.

### Device boots but does NOT rejoin Zigbee network

- Wait at least 5 minutes — rejoin can take a while on a busy network.
- Open Z2M permit-join briefly (60 s) via MQTT:
  ```bash
  ssh root@hassio.h.xxl.cx \
    'mosquitto_pub -h core-mosquitto -t zigbee2mqtt/bridge/request/permit_join -m "{\"value\":true,\"time\":60}"'
  ```
- If still no rejoin, NVM3 may be corrupted. Recovery: build a `EFR32MG21A020F768IM32_nvm3_clear_*.gbl` from this same repo's `manifests/` (use the existing MG24 NVM3 clear manifest as a template, but change `device:` to `EFR32MG21A020F768IM32` and adjust the NVM3 region addresses for MG21). Then flash that via the same web API, then re-flash the dense router GBL, then permit-join. The existing `stick/EFR32MG24A020F1024IM40_nvm3_clear_*.gbl` is for MG24 and **MUST NOT** be flashed onto MG21 — it will brick the device.

---

## Done = success criteria

(Mirrors the spec's section.)

1. GitHub Actions produced `*slzb06mu_mr3_dense*.gbl`. ← Task 4 step 3
2. SLZB web API reported successful flash (HTTP 200 + `zbRev` changed). ← Task 6 step 4
3. Device rejoined Z2M without permit-join. ← Task 7 step 2 (`last_seen` recent)
4. No error flood for the SLZB friendly_name in Z2M logs. ← Task 7 step 4
