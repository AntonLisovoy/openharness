# Harness device simulator + loopback TCP dial transport — design

- **Status:** draft r3 (two Codex review rounds applied)
- **Date:** 2026-09-29
- **Branch:** `feat/device-sim` (fork `AntonLisovoy/openharness`, base `upstream/main` @ `249e0f9a`)
- **Scope:** v1 of a longer roadmap (see §9). v1 is intended to be upstreamable.

Paths: `F/` = `devices/harness-device/firmware/main/`, `C/` = `cli/src/cable/`.

## 1. Context and goal

The harness device firmware targets the Waveshare ESP32-S3-Touch-AMOLED-1.75C (466×466 round CO5300
AMOLED, CST9217 touch, AXP2101, ES7210/ES8311). It talks to the daemon only over USB Serial/JTAG
(`303a:1001`) using cable frames (`A5 48 | ver | type | len | payload | crc16`, `C/cableFrame.ts`,
`F/cable_frame.h`).

There is no way to run the device UI without the physical board. Existing host tests
(`make device-test`, `test/run.sh`) compile pieces of the UI and render PPM screenshots, but they
extract functions from `ui_habitat.c` by regex and cannot talk to a real daemon.

**Goal of v1:** a desktop simulator that runs the *real* firmware application, UI and protocol code
in an SDL2 window and connects to a *real* local daemon as if it were a cabled dial, so the full loop
(agents shown → question/permission shown → answered from the device → reaches Claude Code / Codex)
can be exercised without hardware.

**Success criteria:**
1. `make device-sim` builds a `harness-sim` binary on macOS (SDL2 from Homebrew).
2. With `HARNESS_DIAL_TCP=1` set for the daemon, a running `harness-sim` attaches as a dial: the
   desktop app / `hn` shows it as an attached device, and the simulator's carousel shows live agents.
3. A Claude Code and a Codex question/permission prompt appears on the simulator and answering it
   there unblocks the agent.
4. BOOT (keyboard) stops a running turn. Voice (keyboard, synthetic audio) produces a transcript
   routed like a real voice turn when the daemon's transcription prerequisites are met (§4.7).
5. Restarting the daemon makes the simulator reconnect by itself.
6. Without `HARNESS_DIAL_TCP`, daemon behaviour is unchanged; `make device-test`, `cli` vitest and
   `cli` typecheck stay green.

**Non-goals (v1):** Wi-Fi/LAN transport, mDNS, pairing/auth, stable simulator identity across
reconnects (§3.4), quota screen, real microphone capture, battery/PMIC emulation, firmware update
over the simulator, scheduling-accurate timing, deterministic (virtual-time) scheduling and
pixel-exact reference screenshots (deferred to v1.x, §4.9).

## 2. Architecture

```
┌──────────────────────────── macOS ─────────────────────────────┐
│  hn / desktop ──► harness daemon (cli)                          │
│                    └─ CableFleet                                │
│                        ├─ USB: findDialPorts + SerialLink       │ unchanged
│                        └─ TCP: TcpDialListener @127.0.0.1:18474 │ NEW, opt-in
│                                   ▲  identical cable frames     │
│  harness-sim (SDL2 466×466) ──────┘  (sim is the TCP client)    │
│   ├─ firmware sources incl. app_main.c, unmodified              │
│   ├─ sim/link_tcp.c     replaces F/cable_link.c                 │
│   ├─ sim/display_sdl.c  replaces F/ui/habitat/display_habitat.c │
│   ├─ sim/touch_sdl.c    replaces F/ui/habitat/touch_habitat.c   │
│   ├─ sim/shims/         FreeRTOS, esp_timer, esp_log, NVS, …    │
│   └─ sim/stubs/         board, audio_capture, ptt, fw_update, … │
└─────────────────────────────────────────────────────────────────┘
```

Key decisions:

1. **The simulator compiles the real firmware sources, including `F/app_main.c`.** `app_main()`
   owns boot order and the `refresh_task` worker that copies cable agent snapshots into UI tiles,
   reconciles removals, applies pending focus, services model selection and prunes stale activity
   (`F/app_main.c:72-174`, started at `:234`). None of that is duplicated in the simulator. Only
   drivers (display, touch, link, audio capture, buttons, board) and ESP-IDF/FreeRTOS APIs are
   replaced.
2. **The daemon listens, the device connects.** Same direction a future network transport would use.
3. **Above the byte stream a simulator session is a USB session.** Same `CableSession`, same
   `hello`/`welcome`, same vocabulary. Visible differences: `hw: "sim"` in `hello`, a `tcp://` port
   path, connection-scoped id (§3.4).
4. **No firmware source changes by design.** If a firmware file does not compile on the host, the
   fix is a shim. A firmware edit is allowed only as a pure portability fix that is neutral on the
   device; each such edit is listed in the PR description.
5. **Replacement drivers reproduce the replaced driver's contract, not just its signatures.** Where
   `display_habitat.c`, `touch_habitat.c`, `cable_link.c` or `ptt.c` carry behaviour other modules
   rely on (render/tick/ack sequence, wake-swallow, press semantics, idle ticks), the simulator
   reimplements that behaviour; each is specified below.

## 3. Host changes (`cli/`)

### 3.1 Existing seams used

- `CablePort` / `PortOpener` (`C/cableSession.ts:416-434`).
- `CableFleet` (`C/cableFleet.ts`) polls `discover()` every 2 s and opens new ports via
  `open(path, onData, onClosed)`; both injectable through `CableFleetOptions`. A thrown `discover()`
  aborts that reconcile pass (`C/cableFleet.ts:55-65`).
- `DialPort` = `{ path, vendorId, productId, serialNumber? }` (`C/serial.ts:25`).
- Fleet constructed once in `cli/src/cli.ts:6797`.
- `CableSession` awaits the opener, possibly closes a previous link, then sets `this.link` and resets
  its decoder (`C/cableSession.ts:714-752`). `send()` rejects without a link.

### 3.2 `CablePort.activate()` — small `CableSession` change

`CablePort` gains an optional method:

```ts
/** Called once, after the session has adopted this port as its link. A port may hold inbound
 *  bytes until then; USB ports don't need it. */
activate?(): void
```

`CableSession` calls `opened.activate?.()` immediately after `this.link = opened` and
`this.decoder.reset()`. For `SerialLink` it is absent, so USB behaviour is unchanged. This removes
the race where bytes delivered during `open()` would be decoded before the session can reply, or be
wiped by the decoder reset.

### 3.3 New: `C/tcpDial.ts`

`TcpDialListener`:

- `static async listen(port, log): Promise<TcpDialListener | undefined>` — `net.createServer` bound
  to `127.0.0.1` only. Bind failure (e.g. `EADDRINUSE`) is logged and returns `undefined`; the daemon
  continues with USB only.
- On accept: allocate monotonic `n`, `setNoDelay(true)`, and **pause** reading
  (`socket.pause()`); nothing is read until `activate()`. TCP flow control does the buffering, so
  there is no daemon-side pre-open buffer to bound. A socket accepted but never opened within 10 s
  is destroyed.
- `ports(): DialPort[]` — one per live socket:
  `{ path: "tcp://127.0.0.1:<remotePort>#<n>", vendorId: 0x303a, productId: 0x1001, serialNumber: "SIM<n>" }`.
- `open(path, onData, onClosed): Promise<CablePort>` — rejects for unknown/closed paths. Returns a
  port whose:
  - `activate()` attaches the `data` listener and `resume()`s the socket (idempotent);
  - `write(bytes)` resolves on the socket write callback, rejects if closed;
  - `close(why)` and socket `close`/`error` converge on one idempotent teardown that removes the
    entry from `ports()` and calls `onClosed(why)` **exactly once** (mirrors `SerialLink`'s
    idempotent close, `C/serial.ts:265-268`);
  - `isOpen` reflects that state.
- `close()` — stops the server, tears down all sockets (daemon shutdown).

### 3.4 Wiring in `cli.ts`, discovery isolation, identity

```ts
const tcpPort = parseDialTcp(process.env.HARNESS_DIAL_TCP)   // undefined | number
const tcp = tcpPort ? await TcpDialListener.listen(tcpPort, log) : undefined
const cable = new CableFleet(CableSession, cableHost, env.HARNESS_LOGS_DIR, DialLog, {
  serials: …unchanged…,
  ...(tcp && { discover: combinedDiscover(findDialPorts, tcp, log), open: routedOpen(SerialLink.open, tcp) }),
})
```

- `parseDialTcp`: unset/empty/`0` → disabled; `1`/`true` → `18474`; integer 1024–65535 → that port;
  anything else → disabled with a log line. Disabled ⇒ the options object equals today's.
- `combinedDiscover`: USB enumeration failures are isolated. On a USB throw it logs and substitutes
  the **last successful USB result**, so live USB dials are neither dropped nor reopened, while TCP
  ports are still returned. With TCP disabled this wrapper is not used, so a USB throw keeps today's
  semantics.
- `routedOpen`: `tcp://` paths → `tcp.open`, everything else → `SerialLink.open`.
- Fleet log prefix `[usb <id>]` → `[tcp <id>]` for tcp paths.
- **Identity is connection-scoped in v1.** `SIM<n>` becomes the fleet entry id, published status id,
  settings address and log identity (`C/cableFleet.ts:110`, `:127`, `:158-160`). Each reconnect is a
  new `n`, so the desktop shows a new device and per-device settings do not carry over. Accepted and
  documented; stable identity arrives with pairing in v2.
- `HARNESS_DIAL_SERIALS`, when set, filters by serial and therefore excludes `SIM<n>` entries —
  documented, not special-cased.
- `otaKeyForBoard("sim")` returns `null` → no firmware offers. Covered by a test.

### 3.5 Security

Loopback only, off by default. Trust model equals the daemon's existing loopback WebSocket on 18473.
No LAN exposure, so the firmware's "plugging the cable in is the authorization" model is unchanged
for remote parties.

## 4. Simulator (`devices/harness-device/sim/`)

### 4.1 Layout

```
devices/harness-device/sim/
  CMakeLists.txt        # host build, SDL2; explicit source + asset manifest (§4.2)
  README.md
  sim_main.c            # process entry: args, SDL on main thread, runs app_main() on a task
  display_sdl.c         # display.h + display-side runtime.h symbols; render loop (§4.4)
  touch_sdl.c           # touch.h; SDL mouse → touch state machine (§4.4)
  link_tcp.c            # cable_link.h over a TCP client socket (§4.4)
  input_keys.c          # keyboard → BOOT / PWR / voice / screenshot (§4.6)
  audio_capture_sim.c   # audio_capture.h fed by synthetic PCM (§4.7)
  clock_sim.c           # time + random source (§4.9)
  shims/                # ESP-IDF / FreeRTOS stand-ins (§4.3)
  stubs/                # board, fw_update, last_words, audio_notify, device_mac, … (§4.5)
  fixtures/             # scenario .jsonl, voice .wav, nvs-defaults.json
  test/                 # headless render tests + reference PNGs
```

Root `Makefile` gains `device-sim`, `device-sim-run`, `device-sim-test`.

### 4.2 Firmware sources: explicit manifest

`CMakeLists.txt` lists sources explicitly — no globs. Starting set, all from `F/`:
`app_main.c`, `ui/habitat/*.c` **by name** excluding `display_habitat.c`, `touch_habitat.c`,
`*_bench.c` and gallery sources that production only builds conditionally (`F/CMakeLists.txt:160-165`,
e.g. `creature_gallery.c` with generated assets); `ui/ui_perf.c`; `cable_client.c`, `cable_frame.c`,
`cable_features.c`, `cable_machines.c`, `cable_scroll.c`, `cable_json_guard.c`; `config_store.c`;
`voice_buffer.c`; `audio_client_habitat.c`; **`ram_telemetry.c`** (it provides the PSRAM allocator
the voice ring uses, `F/audio_client_habitat.c:175-178`, `F/ram_telemetry.h:22-25`; shims make it
host-safe rather than stubbing it). Compile definitions mirror production's `F/CMakeLists.txt` for the
included files, minus hardware-only ones. Any generated header/asset production creates is produced
the same way or excluded with its consumer. cJSON from `$IDF_PATH/components/json/cJSON` (as
`test/run.sh`), otherwise fetched at a pinned tag. The manifest is finalised during implementation;
every exclusion is recorded in `sim/README.md` with the reason.

### 4.3 Shims (`sim/shims/`)

Headers use ESP-IDF include paths so firmware includes resolve unchanged. The **complete callable
surface** is enumerated during step 2 from the compiled set (`nm -u` on the objects) and each symbol
is implemented with real semantics — no silent no-ops for synchronization or allocation. Known set:

| API | Host implementation |
|---|---|
| tasks: `xTaskCreate[PinnedToCore]`, `vTaskDelete(NULL/handle)`, `vTaskDelay`, `xTaskGetCurrentTaskHandle`, `xTaskGetHandle` | pthreads + name registry; core pinning/priorities ignored; 1 tick = 1 ms |
| notify: `xTaskNotifyGive`, `ulTaskNotifyTake`, `vTaskNotifyGiveFromISR` | per-task counter + mutex/condvar |
| semaphores: `Create{Mutex,Binary,RecursiveMutex}`, `Take/Give[Recursive]`, `GiveFromISR`, `GetMutexHolder`, `vSemaphoreDelete` | pthread mutex/condvar with timeouts; misuse (give of unheld mutex) → `abort()` |
| queues: `xQueueCreate/Send/Receive`, `uxQueueSpacesAvailable`, `vQueueDelete` | bounded ring + condvar |
| critical sections: `freertos/portmacro.h`, `portMUX_TYPE`, `portENTER/EXIT_CRITICAL[_ISR]`, `taskENTER/EXIT_CRITICAL` | one process-wide recursive mutex (real exclusion; `F/ui/ui_perf.c:14-39`) |
| `esp_timer_get_time` | `clock_sim` (§4.9) |
| `ESP_LOG{E,W,I,D,V}` | through the firmware's log vprintf hook path so `cable_link` log framing works; stderr fallback |
| `nvs_*`, `nvs_flash_*` | map persisted to `~/.harness-sim/<profile>/nvs.json` on `nvs_commit` |
| `heap_caps_*` | `malloc`/`calloc`/`realloc`/`free`; size/integrity queries return fixed plausible values |
| `EXT_RAM_BSS_ATTR`, `IRAM_ATTR`, … | empty |
| `esp_random` | `clock_sim` RNG (§4.9) |
| `esp_app_get_description` | version `sim-<git short sha>` (CMake-generated) |
| `esp_restart` | log + `exit(0)` |
| `driver/gpio.h` (as used by `app_main.c`) | reads BOOT from `input_keys` state; other pins inert |

### 4.4 Replaced drivers

**Display (`display_sdl.c`).** Provides every symbol `display_habitat.c` defines (all of `F/ui/display.h`
plus the display-side `F/ui/habitat/runtime.h` hooks such as `habitat_input_stamp`,
`habitat_render_notify` consumers, `habitat_perf_get` where it lives there — exact list taken from
`nm` of `display_habitat.o`). The render task reproduces the device sequence in
`F/ui/habitat/display_habitat.c:373-417`:

1. wait for render notify / wake deadline;
2. under the model lock: `habitat_tick()`, `habitat_scene_take()`, capture receipt and
   `habitat_next_wake_ms()`;
3. `ht_damage` → `ht_raster` into RGB565 strips (panel byte order, `F/ui/habitat/terminal.c:12-21`);
4. hand the finished frame **and its receipt** to the SDL main thread;
5. the main thread converts panel-order RGB565 to the texture format (byte swap), uploads, presents,
   then calls `habitat_scene_presented(receipt)` — acknowledgement only after the pixels are on
   screen, because presentation marks notifications read (`F/ui/habitat/ui_habitat.c:386-395`) and
   tick drives question deadlines (`:2493-2511`).

`display_set_brightness` stays a no-op exactly like the device (`display_habitat.c:243-245`); the UI
already applies brightness in its palette (`ui_habitat.c:566-577`). Sleep/wake and the power callback
(`display_set_power_cb`) behave as on device; asleep ⇒ black window. Outside the 466-px circle is
black. `--scale N` scales the window only.

**Touch (`touch_sdl.c`).** Implements `F/ui/touch.h` and the state machine of
`F/ui/habitat/touch_habitat.c:128-164`: a contact that lands while the display is asleep wakes it and
is swallowed (not delivered as a tap); every contact bumps activity/input stamps; `habitat_touch`
calls happen under the model lock; contacts are cancelled (`habitat_touch_cancel`) across sleep,
when the pointer is released outside the window, and on window focus loss. Mouse wheel becomes a
synthetic vertical drag. Presses outside the circle are ignored.

**Link (`link_tcp.c`).** Implements `F/cable_link.h` with the obligations of `F/cable_link.c`:

- reader thread connects to `127.0.0.1:<port>` (`--port`, default 18474), retries every 2 s;
- decodes with the firmware's `cable_frame` decoder and calls the frame callback on the reader thread;
- keeps invoking the **idle tick callback** at the device cadence whether or not connected
  (`F/cable_link.h:44-48`), so `session_tick` runs;
- resets framing state between sockets and honours `cable_link_reset_decoder` (`:88-95`);
- `cable_link_host_present()` reports socket connected;
- the socket is **non-blocking**; `cable_link_send` writes a frame under a mutex with a
  deadline-bounded partial-write loop using the device's budgets — 100 ms for ordinary frames, 5 ms
  for log frames, bounded lock acquisition for logs (`F/cable_link.c:60-70`, `:118`, `:143`, `:243`) —
  and returns failure on timeout, so "nobody is reading" is survivable exactly as on USB;
- if a deadline expires **after part of a frame was written**, the connection is closed before any
  other frame is written (framing continuity would otherwise be undefined); the reader reconnects;
- log framing uses the same `esp_log_set_vprintf` hook as `F/cable_link.c:155` and mirrors
  `:128-144`: bounded, non-blocking, recursion-safe (a log emitted while sending a log frame is
  dropped and counted in `cable_link_dropped_logs`).

On disconnect the firmware learns the session ended **through its own silence expiry (15 s,
`F/cable_client.c:1289-1295`)**, exactly as after a USB unplug. This is deliberate fidelity, not a gap.

### 4.5 Stubs (`sim/stubs/`)

- `board`: `board_detect()` no-op; `board()` returns `{ name: "sim", PMIC present, round 466×466 }`;
  `board_pins.h` resolved via include path to a sim variant only if needed for compilation.
- `ptt`: `ptt_start()` starts `input_keys` polling instead of GPIO; BOOT semantics per §4.6.
- PWR: `input_keys` performs the same screen toggle as `F/ptt.c:27-34` / `:51` — `display_lock()`,
  `display_sleep()` or `display_wake()`, `display_unlock()`. The replacement display then invokes the
  callback registered via `display_set_power_cb()`, which is how the UI learns about it and cancels
  in-flight interaction (`F/ui/habitat/ui_habitat.c:2573`, `:2608`). The static UI callback is never
  called directly.
- `audio_notify_init` / beep: no-op (terminal bell with `--beep`).
- `fw_update` (`fw_update_tick`, `fw_mark_valid`, offer handling): reports unsupported; offers are
  declined through the normal protocol path.
- `last_words`, `audio_probe`, `board_probe`: no-ops.
- `device_mac`: random locally-administered MAC generated on first run, stored in the profile's
  `nvs.json` (reported in `hello`; does not stabilise the daemon-side id in v1, §3.4).

### 4.6 Keyboard

| Key | Emulates |
|---|---|
| `B` down | BOOT press: wake if asleep, then `ui_boot_pressed()` (back / stop turn) — fires on press (`F/ptt.c:54-58`) |
| `B` held ≥ 800 ms | additionally BOOT hold: screen toggle, once per press (`F/ptt.c:59-63`) |
| `P` | PWR tap (screen toggle via power callback) |
| `V` down / up | public `ui_voice_start()` / `ui_voice_stop()` (`F/ui/habitat/ui_habitat.c:4046-4068`) — the real UI voice state machine and action worker, which in turn drive `audio_client` (§4.7) |
| `S` | PNG screenshot to `./sim-shots/` |
| `Q` / close | quit |

Keys are sampled at the device's 100 ms poll cadence. Focus loss releases held keys.
`--factory-reset` makes `boot_button_held()` true at startup (runs the firmware's own
`config_clear_all()` path).

### 4.7 Voice (synthetic PCM through the real audio client)

`audio_capture_sim.c` implements `F/audio_capture.h` (`audio_capture_start/read/stop/overruns` and
whatever else `audio_client_habitat.c` calls): `read` **blocks** and returns PCM paced at real time
(16 kHz, 16-bit mono), so the real client's failure/overflow handling (`F/audio_client_habitat.c:54-86`)
and the real `voice.begin` metadata (upload ids, context, `sr`; `F/cable_client.c:507-550`) are
exercised unchanged. PCM source:

- `--voice-wav <file>` — 16 kHz 16-bit mono WAV, played once from the start of each capture;
- `--voice-text "<phrase>"` — rendered once via macOS `say -o <tmp>.wav --data-format=LEI16@16000`;
- default `fixtures/voice-hello.wav` (committed, generated with `say`);
- once the source is exhausted, `read` keeps returning **paced zero-valued PCM** (never a zero-length
  read: three consecutive `n <= 0` reads abort capture, `F/audio_client_habitat.c:60-69`); a hold
  shorter than the source truncates it.

Keyboard voice enters through `ui_voice_start()`/`ui_voice_stop()` (§4.6), touch voice gestures
through the UI as on device; neither calls `audio_client` directly. This keeps the voice surface open
so the UI shows the result or `voice.error` (it ignores `voice.error` otherwise,
`F/ui/habitat/ui_habitat.c:3970-3975`).

**Prerequisite:** transcription happens in the daemon (`CableHost.transcribe`, `C/cableSession.ts:303`),
which requires the daemon to be signed in (SSO) and its HTTP STT endpoint reachable
(`C/cableHost.ts:1011-1032`). Without it the simulator shows the daemon's `voice.error` — correct
behaviour and a separate test case.

### 4.8 Identity

`hello` is built by the unmodified `cable_client.c`: `hw = "sim"`, fw `sim-<sha>`, MAC from §4.5.
`--profile <name>` (default `default`) keeps separate NVS/MAC per profile so two simulators can run
at once.

### 4.9 Time, randomness, headless mode

`clock_sim.c` backs `esp_timer_get_time`, tick counts, `vTaskDelay` and `esp_random` with the
monotonic wall clock and `arc4random` (`--seed` switches `esp_random` to a seeded PRNG for easier
debugging; it does not make runs deterministic).

**NVS isolation.** `--headless` uses an ephemeral in-memory NVS initialised from
`fixtures/nvs-defaults.json` (explicit brightness, character, quiet, etc.); a persisted profile is
used only with an explicit `--profile`. The initial configuration is written next to any shot
(`<shot>.config.json`), because firmware rendering depends on it (`F/app_main.c:196`,
`F/ui/habitat/ui_habitat.c:568-577`, `:2587-2598`).

`harness-sim --headless` runs without SDL, in **real time**:

- `--script <file.jsonl>` replays daemon→device JSON into the frame callback, plus `{"wait_ms"}`,
  `{"touch": …}`, `{"key": …}` steps, instead of connecting; a script can also answer device
  requests it expects (e.g. model selection) with `{"expect": "<t>", "reply": {…}}`;
- after each step the harness waits to **settle**: every task registered through the `xTaskCreate`
  shim is parked in a shim wait (queue/semaphore/notify/delay) and no new frame was presented for
  `--settle-ms` (default 150 ms), bounded by `--settle-timeout` (default 5 s). This is a heuristic,
  not a determinism guarantee;
- `--shot <file.png>` writes the final frame; `--shot-every <dir>` one per step;
- `--record <file.jsonl>` in interactive mode records daemon→device frames for later replay;
- exit non-zero on firmware error-level log, assert, settle timeout, or a failed `{"assert": …}` step
  (see §6.4).

**Deferred to v1.x:** a deterministic scheduler in the shims (virtual time advanced
deadline-by-deadline when all tasks are blocked, distinguishing "blocked awaiting input" from
"completed", deterministic wake ordering) enabling pixel-exact reference screenshots. Everything
above is designed so that it can be added without changing scripts.

## 5. Error handling

- Daemon: bind failure → log, TCP disabled, USB unaffected. Socket error → single teardown, treated
  as unplug. Never-opened socket → destroyed after 10 s. Garbage bytes → existing `CableDecoder`
  resync (magic scan + CRC). USB enumeration error with TCP on → last good USB list reused (§3.4).
- Simulator: connection refused → "waiting for daemon on 127.0.0.1:<port>" on stderr, retry every
  2 s; UI shows the firmware's own no-host state. SDL init failure → exit, suggest `--headless`.
  Shim misuse → `abort()` with message.

## 6. Testing

1. **Host (vitest) — `C/tcpDial.spec.ts`:**
   - accepted socket appears in `ports()`; teardown removes it; `onClosed` fires **exactly once**
     for each of: remote close, remote error, local `close()`, `close()` twice, close during write;
   - no bytes delivered before `activate()`; a complete `hello` and a `hello` split across writes,
     both sent before discovery, are each answered with `welcome` **without a second `hello`**;
   - a connected peer that stops reading: device-side writes are covered in the simulator (below);
     daemon side, a stalled client does not block other sessions;
   - frames round-trip unchanged through `encodeCableFrame`/`CableDecoder`;
   - bound to `127.0.0.1` (assert `server.address()`); `parseDialTcp` table; `EADDRINUSE` → undefined,
     no throw; never-opened socket destroyed after timeout;
   - `combinedDiscover`: USB enumeration throws while a simulator is connected → TCP port still
     returned, previous USB ports preserved (no stop/reopen of a live USB session);
   - **integration:** real `CableFleet` + real `CableSession` + listener + fake TCP client:
     hello→welcome; disconnect → session stopped, status `attached:false`; reconnect mid-frame →
     new session, old one cleanly stopped; disconnect mid-voice (after `voice.begin` + some `Pcm`) →
     voice state discarded, no transcription call; **two simultaneous clients** → two independent
     sessions and statuses; reconnect yields a new id (documents §3.4).
   - `C/cableSession.spec.ts`: `activate()` called exactly once, after `link` is set and decoder reset;
     ports without `activate` unaffected.
   - `otaKeyForBoard("sim") === null`.
2. **Typecheck:** `cd cli && npm run typecheck` (required by `CONTRIBUTING.md:188-192`).
3. **Simulator build:** `make device-sim` on macOS; failure after a firmware change is the canary.
4. **Headless smoke tests** (`make device-sim-test`): replay fixture scenarios with default NVS —
   idle, agents loading → carousel populated (exercises `refresh_task`), running turn, question with
   options, permission prompt, model selection answered by the script. Each must settle, produce a
   PNG, log no errors, and pass its `{"assert": …}` steps, which check facts that are stable without
   determinism: e.g. the number of agent tiles reported via a test-only log line from the sim
   harness (not firmware), non-black pixels inside the circle, and a **known-color check** (a
   `#181818` region reads back as `#181818`, guarding byte order). No pixel-diff against references
   in v1. PNGs are kept as artifacts for review and for the PR.
5. **Link:** `link_tcp.c` against a test server that stops reading — `cable_link_send` returns
   failure within its budget, log writes never stall callers beyond 5 ms, a partially written frame
   closes the connection and the next session starts with clean framing.
6. **Voice:** (a) with a signed-in daemon — transcript routed; (b) signed-out/unavailable STT — the
   simulator shows `voice.error`; (c) held longer than the source — silence padding, no overrun abort.
7. **Existing suites:** `make device-test`, `cd cli && npm test`.
8. **Manual end-to-end (definition of done):** §1 criteria with a real Claude Code and a real Codex
   agent started via `hn`.

Simulator results are reported separately from hardware validation; the firmware README's hardware
test notes (`devices/harness-device/firmware/README.md:61-62`) are not claimed by v1.

## 7. Work order on the branch

1. `activate()` in `CableSession` + `tcpDial.ts` + `combinedDiscover` + tests + `cli.ts` wiring
   (verifiable with a tiny Node TCP client).
2. Shims + explicit manifest + headless build with `app_main()` running and a scripted scene rendered
   to PNG (settle heuristic, ephemeral NVS).
3. SDL window, render handoff with receipts, touch state machine, keyboard.
4. `link_tcp.c`; end-to-end with the daemon.
5. Voice (`audio_capture_sim.c`, fixture WAV, `say` path).
6. Headless render tests, docs (`sim/README.md`, one line in the firmware README), screenshots.

## 8. Upstreaming

- Upstream acceptance is a **risk, not a known rejection**: the firmware emphasises one board and
  renderer (`F/CMakeLists.txt:1-15`) and no network transport (`F/cable_link.h:3-5`); a loopback-only
  developer transport plus a simulator does not contradict either, but must be agreed.
- Open an issue early (in parallel with step 1) proposing "device simulator + opt-in loopback TCP dial
  transport": zero behaviour change without the env var, no firmware edits (or a listed few
  portability-only ones), one small `CableSession` hook. Adjust scope to maintainer feedback.
- PR(s) in English, repo conventions (`feat(device): …`). Offer to split host transport and simulator
  into two PRs.
- This spec and the plan live in `docs/superpowers/` (git-excluded locally), never in the PR.

## 9. Roadmap beyond v1 (not designed here)

- **v1.5 — hardware arrives:** flash upstream firmware as-is on the 1.75C; verify USB, voice, touch;
  record hardware notes per the firmware README.
- **v2 — Wi-Fi (fork-only unless upstream agrees):** network link reusing the §3 listener on LAN,
  mDNS discovery, pairing + authenticated transport, **stable device identity**; quota screen fed by
  the daemon's `accountUsage` (`usage_read`); battery indicator from AXP2101.
- **Later:** away-from-home via the existing relay (`backend/`, `adapter-ws`); permission-mode
  switching as a protocol command.

## 10. Risks

- **Firmware coupling.** `ui_habitat.c` (4.2k lines) and `app_main.c` touch many IDF APIs; the
  `nm -u`-driven shim inventory surfaces them early (step 2).
- **Threading fidelity.** pthreads ≠ dual-core FreeRTOS; device-only races are not caught. Shims still
  provide real exclusion so the simulator does not invent races of its own.
- **Upstream churn.** Firmware changes daily (e.g. `977638b2` removed LVGL and the P4 board). No
  firmware edits + explicit manifest keep rebases cheap and make breakage loud.
- **Settle heuristic flakiness.** Real-time settle can misjudge a busy moment; assertions are chosen
  to be timing-tolerant, and the deterministic scheduler is the v1.x fix if it bites.
- **Transcription dependency.** Voice e2e needs a signed-in daemon; verified early in step 5.
