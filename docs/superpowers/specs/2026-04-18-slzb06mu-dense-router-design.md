# SLZB-06MU "MR3 Dense" Zigbee Router firmware

Date: 2026-04-18
Status: design approved, ready for implementation

## Goal

Build a "fat" Zigbee router firmware for SLZB-06MU
(`EFR32MG21A020F768IM32`, 768 KiB flash / 64 KiB RAM) optimized for a heavy
mesh network of ~150 devices with poorly-behaved nodes (e.g. Tuya).

The router must be a balanced mesh helper:

- strong as a relay / concentrator (large route, packet buffer, broadcast,
  APS duplicate-rejection),
- and capable parent for end-devices (child / key tables already at xg21 cap).

## Hard constraints

- Do **not** modify the bootloader (Gecko bootloader from SMLIGHT stays).
- Do **not** modify the SMLIGHT ESP firmware (Wi-Fi/UART bridge stays).
- Do **not** reconfigure the live Zigbee network. The router is currently
  joined; after flashing it must keep its NVM3 join state and rejoin the
  same network automatically.
- Target SoC is `EFR32MG21` only. Some MG24-class "dense" tweaks (e.g.
  `HUGE_PACKET_BUFFER_HEAP`, `ROUTE_TABLE_SIZE=200`) do not fit.
- Flash via the device's existing Wi-Fi bridge (`192.168.88.144`).

## Strategy

Fork `upstream/sisdk-2025.12.x` to a new branch `mr3-dense-router-2025.12.x`
in `AlexMKX/silabs-firmware-builder`.

Add a **new** manifest `manifests/smlight/smlight_slzb06mu_mr3_dense_zigbee_router.yaml`
without touching the existing `smlight_slzb06m_zigbee_router.yaml`. This way:

- the stock Nerivec router build is preserved untouched,
- our "dense" variant is a separate artifact built by the same workflow,
- rollback is trivial (flash the stock GBL).

## Baseline

`src/zigbee_router/zigbee_router.slcp` already contains careful per-MCU
tuning by Nerivec. For MG21 the upstream defaults are:

| Setting                                       | Upstream xg21 default |
|-----------------------------------------------|----------------------:|
| `SL_ZIGBEE_ROUTE_TABLE_SIZE`                  | 16                    |
| `SL_ZIGBEE_DISCOVERY_TABLE_SIZE`              | 16                    |
| `SL_ZIGBEE_NEIGHBOR_TABLE_SIZE`               | 26 (cap)              |
| `SL_ZIGBEE_BROADCAST_TABLE_SIZE`              | 30                    |
| `SL_ZIGBEE_BINDING_TABLE_SIZE`                | 32                    |
| `SL_ZIGBEE_KEY_TABLE_SIZE`                    | 1                     |
| `SL_ZIGBEE_ADDRESS_TABLE_SIZE`                | 32                    |
| `SL_ZIGBEE_APS_UNICAST_MESSAGE_COUNT`         | 64                    |
| `SL_ZIGBEE_MAX_END_DEVICE_CHILDREN`           | 32 (cap)              |
| `SL_ZIGBEE_SOURCE_ROUTE_TABLE_SIZE`           | 254                   |
| `SL_ZIGBEE_GP_PROXY_TABLE_SIZE`               | 10                    |
| `SL_ZIGBEE_MULTICAST_TABLE_SIZE`              | 26                    |
| `SL_ZIGBEE_APS_DUPLICATE_REJECTION_MAX_ENTRIES` | (xg21: not set)     |
| `SL_ZIGBEE_PACKET_BUFFER_HEAP_SIZE`           | (default)             |

Components already on: `zigbee_concentrator` (HIGH_RAM_CONCENTRATOR),
`zigbee_source_route`, `router_eui64_unique`, `router_beacon_filter`,
`zigbee_pro_stack`, `zigbee_security_link_keys`, etc.

So we are not bootstrapping from zero — the upstream router is already a
strong concentrator-style router. We only widen the bottlenecks for very
dense networks.

## Dense-router deltas (xg21)

| Setting                                         | Upstream xg21 | Dense | Reason                                                     |
|-------------------------------------------------|--------------:|------:|------------------------------------------------------------|
| `SL_ZIGBEE_ROUTE_TABLE_SIZE`                    | 16            | 80    | Transit volume in 150-device mesh; biggest single win      |
| `SL_ZIGBEE_DISCOVERY_TABLE_SIZE`                | 16            | 24    | Fewer route-discovery collisions in dense radio space      |
| `SL_ZIGBEE_BROADCAST_TABLE_SIZE`                | 30            | 35    | Tuya-heavy broadcasts; tracks "seen" broadcasts            |
| `SL_ZIGBEE_KEY_TABLE_SIZE`                      | 1             | 8     | Allow unique APS link keys for several joined children     |
| `SL_ZIGBEE_APS_DUPLICATE_REJECTION_MAX_ENTRIES` | (unset)       | 64    | Tuya re-tx flood; matches xg24/xg26 default                |
| `SL_ZIGBEE_PACKET_BUFFER_HEAP_SIZE`             | (default)     | `SL_ZIGBEE_LARGE_PACKET_BUFFER_HEAP` | Bigger transit pool. NOT `HUGE` — that fits MG24, not MG21 |

Settings already at xg21 cap and **left untouched**:

- `NEIGHBOR_TABLE_SIZE = 26` (Zigbee Pro hard cap)
- `MAX_END_DEVICE_CHILDREN = 32` (xg21 stack cap)
- `SOURCE_ROUTE_TABLE_SIZE = 254` (already large)
- `ADDRESS_TABLE_SIZE = 32`, `APS_UNICAST_MESSAGE_COUNT = 64`,
  `BINDING_TABLE_SIZE = 32` — already wider than typical "dense" recipes

## Manifest layout

`manifests/smlight/smlight_slzb06mu_mr3_dense_zigbee_router.yaml`

Inherits pin/clock from upstream `smlight_slzb06m_zigbee_router.yaml`:

- `device: EFR32MG21A020F768IM32`
- `base_project: src/zigbee_router`
- USART0 on PB1 / PB0, soft flow control, 115200
- LED0 on PC0
- `HFXO_CTUNE: 80`, `RSSI_OFFSET: -11`
- Adds `slcp_defines` for `ROUTE_TABLE_SIZE` and `DISCOVERY_TABLE_SIZE` —
  these have to go in `slcp_defines` (not `configuration`), as the prior
  `mr3-large-net` history shows that overriding stack table sizes via
  `configuration:` does not stick (commit `96aa4d6`: "revert unsupported
  neighbor table size override").
- Adds `c_defines` for the rest.

## Build & flash workflow

1. `cd zigbee-silabs-firmware`
2. `git fetch upstream && git checkout -b mr3-dense-router-2025.12.x upstream/sisdk-2025.12.x`
3. Add the new manifest.
4. Commit, push to `origin` — GitHub Actions builds all manifests, including the new one.
5. Download the GBL artifact (`gh run download`).
6. Flash through SLZB Wi-Fi UART bridge:
   `node tools/ember_zli_tool.mjs flash-gbl --gbl <file>.gbl --port tcp://192.168.88.144:6638`
7. Wait ~30 s for SLZB reboot.
8. Verify: tail Z2M logs (`/home/alex/Projects/zigbee/45df7312_zigbee2mqtt`)
   and check MQTT `zigbee2mqtt/<router_friendly_name>` `last_seen`.
   Expect the router to rejoin (NVM3 preserved) and start showing
   neighbors.

## Failure handling

- **Build fails on RAM/flash:** drop `ROUTE_TABLE_SIZE` to 64 first, then
  drop `LARGE_PACKET_BUFFER_HEAP` if still too tight.
- **Device unresponsive after flash:** enter Gecko bootloader via SLZB
  web UI (Tools → Zigbee → enter bootloader) or via `ember-zli`
  bootloader command, then reflash known-good upstream
  `smlight_slzb06m_zigbee_router_*.gbl` (Nerivec releases).
- **NVM3 corrupted (router will not rejoin):** build a MG21 NVM3-clear GBL
  (the existing `EFR32MG24A020F1024IM40_nvm3_clear_*.gbl` in `stick/` is
  for MG24 and will brick MG21 — do not reuse). Plan B only if needed.

## Out of scope

- Network coordinator / Z2M side configuration.
- ESP firmware on the SMLIGHT side.
- Bootloader upgrade.
- Generic MG24/MG26 router builds.
- OpenThread / multi-PAN.

## Done = success criteria

1. GitHub Actions produces `smlight_slzb06mu_mr3_dense_zigbee_router_*.gbl`.
2. Flashing the GBL succeeds.
3. SLZB-06MU rejoins the existing Zigbee network without manual permit-join.
4. Router is visible in Z2M with healthy `last_seen`.
5. No bootloop, no excessive errors in Z2M log relating to this device.
