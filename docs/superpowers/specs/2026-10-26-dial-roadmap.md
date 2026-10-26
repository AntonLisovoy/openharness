# Round dial on the Waveshare ESP32-S3-Touch-AMOLED-1.75C — roadmap

- **Date:** 2026-10-26 (supersedes the stage order in `2026-09-29-device-sim-design.md` §9)
- **Owner:** Anton (fork `AntonLisovoy/openharness`, local checkout only)
- **Upstream:** out of scope for now. Everything lives in the fork; what (if anything) is offered upstream is
  decided later, once it works.

This file is the index. Each stage that needs design has its own spec.

## The hardware

The board on the desk is a **Waveshare ESP32-S3-Touch-AMOLED-1.75C** (silkscreen confirmed, 2026-09-29),
currently running its stock Xiaozhi firmware. It is "board A" in
`devices/harness-device/firmware/main/board/board_table.c` (AXP2101 0x34, CST9217 0x5A, ES8311, ES7210):
the board the openharness round-dial firmware was written for. Pins in `main/board/pins_dial.h` match it,
including I2S MCLK on GPIO16 (GPIO42 is the plain 1.75, not this board). **No pin or driver port is needed.**
The firmware targets 16 MB flash; a 32 MB part boots it with the upper half unused.

## Why

A portable remote for coding agents: see what Claude Code (and later Codex) is doing and answer it from the
dial — pick an AskUserQuestion option or dictate a free-text answer — while away from the Mac. The person
mostly runs Claude Code in the **Claude desktop app (Code tab)**, sometimes in a terminal, and does **not**
want to run agents through tmux. Russian dictation is a hard requirement.

Long term the person wants to stop depending on openharness specifically and support Claude and Codex,
terminal and desktop sessions, directly. Near-term work uses the openharness daemon as the hub but keeps the
new pieces separable (see stage 2).

## Stages, in order

| # | Stage | Spec | Status |
|---|---|---|---|
| 0 | Flash the openharness firmware onto the board, verify over USB with the daemon (incl. voice) | this file, below | done |
| 1 | Russian on the dial: own Deepgram STT with `ru`, Cyrillic glyphs, host fixes | `2026-10-26-dial-russian-design.md` | design |
| 2 | Claude Code sessions without tmux (desktop + terminal) on the dial, via a Claude Code mod | `2026-10-26-dial-claude-sessions-design.md` | design |
| 3 | "v2": Wi-Fi transport in firmware + LAN listener, mDNS discovery, pairing/auth, quota screen (Claude 5h/week + Codex arcs), battery on screen | not yet | later |
| — | Codex as a session source (CLI hooks / Codex desktop) | not yet | later |
| — | Standalone bridge (lift cable host + session-source API out of openharness) | not yet | later |
| — | Russian UI translation of the dial's own strings | not yet | later (deliberately cut from stage 1) |
| — | Desktop simulator + loopback TCP dial transport | `2026-09-29-device-sim-design.md` + plan | parked |
| — | Outside-home use via a relay | not yet | later |
| — | Claude desktop "Hardware Buddy" BLE protocol on the dial (status + approve/deny with no host software) | not yet | idea |

### Stage 0 — flash and verify (no design needed)

1. Back up the Xiaozhi image first so it can be restored:
   `esptool.py --chip esp32s3 -p <PORT> read_flash 0 ALL xiaozhi-1.75c-backup.bin` (keep it outside the repo).
2. ESP-IDF 5.5+, then from `devices/harness-device/firmware/`: `idf.py set-target esp32s3`, `idf.py build`,
   `idf.py -p <PORT> flash monitor` (see that folder's README). Default build = Focus skin only.
3. In the monitor, confirm `board_detect` picks `cst9217+axp2101`. If anything is off, build the bring-up probe
   (`idf.py -DBOARD_PROBE=1 …`) and read what answered on the I2C bus.
4. Exit the monitor, start the daemon (`harness start`) and check: the dial attaches, the carousel shows live
   openharness agents, a question can be answered from the dial, BOOT stops a turn, voice (English, through
   the stock backend after `harness login`) produces a transcript.
5. Note anything that does not work; Wi-Fi and battery display are known absent.

### Stage 0 results (2026-10-26)

- Done. The person reports everything in the stage-0 checklist works with the daemon over USB.
- Stock Xiaozhi image backed up to `~/xiaozhi-1.75c-backup.bin` (33,554,432 bytes = 32 MB flash).
- Built with ESP-IDF 5.5.4 (the build rewrites `firmware/dependencies.lock`'s `idf` version locally; not
  committed).

## Decisions log

From 2026-09-29: build on openharness rather than glue VibePulse/Clawdmeter; device-first over USB, wireless
later; no Clawdmeter code (no licence); VibePulse and AgentDeck are sources of ideas, not code.

From 2026-10-26:
- The old simulator plan was never executed (`feat/device-sim` has no commits) and is ~1850 upstream commits
  stale: the host seam (`CablePort`/`PortOpener`, `CableFleet` `discover`/`open`) survives, but fleet wiring
  moved from `cli.ts` to `cli/src/services/devices.ts`, the fleet gained USB-console/lsof/verdict gates, and
  the firmware UI grew (pets, Swarm tab, Focus skin) so the shim set grows. The e2e suite's pseudo-terminal
  dial (`HARNESSD_TEST_DIAL_PORT`, `cli/e2e/harness/fakeDial.ts`) is a possible cheaper seam. Parked.
- tmux remains the only supported terminal backend on macOS (`harness-pty` is Windows-default, unsupported on
  macOS). The daemon cannot see sessions it did not start; it only adopts them by `--resume`.
- Mechanism for sessions outside openharness: a **Claude Code mod** (in-process plugin). Verified by a spike in
  the Claude desktop Code tab (2026-10-26, Claude Code 2.1.308):
  - a `tool.call` hook on `AskUserQuestion` can run `next(e)` (the normal dialog shows) and race it against an
    external answer; when the external answer wins, returning `{ result: { questions, answers } }` closes the
    desktop dialog by itself and the model receives the answer;
  - a free-text answer that is not one of the options is accepted;
  - when the person answers in the dialog first, the hook returns that result and the external wait is
    cancelled;
  - a wait on an in-flight `$` call (here `$.process.run`) does not count against the 10 s hook budget (waited
    25 s).
  Not yet verified: permission prompts through a mod, the same mod in terminal `claude`.
- Settings hooks (`~/.claude/settings.json`) are the fallback, not the plan. Channels need a launch flag and
  are CLI-only; Remote Control has no third-party client API. Neither fits the desktop app.
- STT for Russian: call Deepgram directly from the daemon with the person's own key (option "В"), not the
  hosted openharness backend (which coerces unknown languages to `en`).
- Russian UI translation of the dial: cut from stage 1 to avoid layout risk; separate later stage.
- Stage 2 audience is dial-only and local-only (nothing through the openharness relay, apps or phones).
  Linked Claude sessions show when waiting for the person or active in the last 2 hours; the dial's 16 slots
  go to waiting agents, then the openharness active tab, then linked sessions by recency. Fallbacks if a
  stage-2 spike fails: settings hooks for terminal (status + questions), soft stop, drop voice-to-tile,
  display-only permissions (person told first).
- Specs reviewed by a builder check and two Codex rounds (2026-10-26); findings applied (sessions spec r3).
  Round 2 had no critical findings and confirmed every code claim in the Russian spec.

## Reference projects

- `anthropics/claude-desktop-buddy` (MIT): the Claude desktop app's developer-mode BLE "Hardware Buddy" API
  (Nordic UART, newline JSON; heartbeat with running/waiting counts and the pending permission; approve-once /
  deny only; no AskUserQuestion, no prompt, no interrupt). M5StickC example firmware.
- `puritysb/AgentDeck` (MIT): global settings hooks → local daemon (`X-…-Pid: $PPID` attribution), observed
  plain `claude` without a wrapper; AskUserQuestion answered via a PreToolUse hold; queued prompts via the
  Stop hook; soft stop via PreToolUse deny; permissions deliberately display-only. LVGL firmware for other
  boards; Wi-Fi WS + mDNS + USB-provisioned token.
