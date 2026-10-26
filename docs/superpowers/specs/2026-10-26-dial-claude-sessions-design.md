# Claude Code sessions on the round dial without tmux — design

- **Date:** 2026-10-26, r3 (builder check + two Codex review rounds applied; the person's answers recorded)
- **Stage:** 2 of `2026-10-26-dial-roadmap.md` (after stage 1, Russian, because Claude's questions will be in
  Russian and the dial must render them)
- **Where:** fork only. Upstream is not a constraint.

Paths: `C/` = `cli/src/`, `F/` = `devices/harness-device/firmware/main/`.

## 1. Intent

The person runs Claude Code mostly in the **Claude desktop app (Code tab)**, sometimes as plain `claude` in a
terminal, and does not want tmux or a wrapper that owns the terminal. When Claude asks something while the
person is away from the Mac, they want to answer from the dial: pick an AskUserQuestion option or dictate their
own answer. Today the openharness daemon only sees agents it launched in tmux panes; hooks from any other
process are rejected (`UNBOUND_HOOK`), and questions are found by scraping the pane.

Longer term the person wants to stop depending on openharness and support Claude and Codex, terminal and
desktop, directly. So the new pieces are built as a **session source** with its own small API that could later
be lifted out of openharness, not as more openharness-internal plumbing.

**Success:** with the mod installed and the daemon running, recently active Claude Code sessions (desktop Code
tab or terminal) appear on the dial as ordinary agent tiles with a distinct mark; their AskUserQuestion and
permission prompts appear on the dial and can be answered there (option or dictated free text), with whichever
side answers first winning and the other side's prompt closing; voice-to-tile sends that session a new
message; BOOT stop interrupts its running turn.

## 2. Goals, non-goals, anti-goals

**Goals**
- A Claude Code **mod** ("the mod") that, inside each Claude session, reports lifecycle and activity to the
  daemon and lets the daemon answer questions/permissions, submit a prompt, and abort the running turn.
- A **session-source API** in the daemon, versioned and engine-neutral, that the mod speaks.
- A core module ("linked sessions") that turns registered sessions into dial agents, reusing the cloud-agents
  shape (`C/core/agents/cloud.ts`) but with **dial-only, local-only** audiences (4.3).
- A distinct mark for these tiles on the dial (firmware change).
- Works in the Claude desktop Code tab and in terminal `claude` (fallbacks in 4.6).

**Non-goals**
- Codex (CLI or desktop) as a source. The API must not preclude it; it is a later stage.
- Showing these sessions, their questions or activity anywhere except the cabled dial: not the openharness
  desktop app or TUI, not phones/web, not the relay/gateway. (Design call; consistent with reducing reliance on
  openharness's cloud and with the privacy of desktop Claude prompts.)
- Translating dial UI strings. Wi-Fi. Multi-machine fleet behaviour for these sessions.
- Adopting/resuming these sessions into tmux (the existing `externalResume` feature is unrelated; avoid the
  word "external" in new names).

**Anti-goals**
- Claude behaves differently when the daemon is down, the dial is detached, or the mod errors: every failure
  path falls through to Claude's normal behaviour, never blocks startup, never denies a tool.
- A session's questions, permissions, prompts or aborts can be driven by another session, or by anything that
  did not authenticate (see 4.2 for the exact trust boundary).
- A question is answered twice, an answer lands on a different question than the one shown, a stop hits a
  later turn than the one shown, or a dial prompt runs twice.
- The mod makes the desktop app or terminal noticeably slower.
- Existing openharness pane agents change behaviour (incl. the mod staying silent in sessions openharness
  itself launched in panes).

## 3. Facts this design rests on

**Spike (2026-10-26, Claude Code 2.1.308, desktop Code tab).** Throwaway mod `dial-spike`
(`~/.claude/dev-mods/<session>/dial-spike/`), event log kept in the session scratchpad. Observed:
a `tool.call` hook on `AskUserQuestion` raced `next(e)` against an external wait; returning
`{ result: { questions, answers } }` while `next(e)` was pending closed the desktop dialog (seen by the person)
and the model received the answer, including free text not among the options; when the person answered in
the dialog first, the hook returned that result and the external wait was cancelled; the hook waited 25 s on
an in-flight `$.process.run` without hitting the 10 s budget.

**Mod API contracts** (`claude-code.d.ts` / `reference.md` of this build; not yet exercised unless noted):
- Returning from `tool.call` with `next(e)` pending aborts what runs beneath; returning after `next(e)`
  resolved undoes nothing. Each `next(e)` call re-runs the downstream chain — call it **once** per hook.
- `$.turn.abort({ turnId })` cancels the running **main-loop** turn, rejecting a non-current id. Running tools
  are stopped (Bash may background commands rather than kill them — verify).
- `$.prompt.submit({ text })` queues until the session is idle. **When its promise resolves is unresolved:**
  `reference.md` says when its turn starts, the authoritative `claude-code.d.ts` (~9550) says it may resolve
  when queued. Either way a command consumer must not await it before handling a later abort, and the
  command ↔ turn correlation must come from observing `turn.start`, not from the promise (spike item).
- `turn.complete` carries the final answer text (usable for summaries).
- `session.start` is awaited before the first prompt; an in-flight `$` call pauses the hook budget, so awaiting
  the daemon there would delay Claude. `$.clock` waits count against the budget. `session.end` has its own
  short wall-clock bound.
- `session.start`'s `surface` may be null — not a reliable desktop/terminal classifier.
- `$.http.fetch` is request/response only, with no client timeout or abort signal in `HttpInit`.
- `/clear` and resume change the session id without a new `session.start`.
- `tool.check` returns a verdict before the interactive decision and runs no tool.

**Daemon facts** (code survey + review):
- Cloud agents are pane-less agents: rows merged into the device list (`C/services/devices.ts:174`,
  `C/core/devicesLink.ts:109`), answer/deliver doors chained ahead of pane paths (`C/core/main.ts` ~836,
  ~1030, ~1031, ~1403; delivery ~2967; `backend.stopProvider` ~2828). But their audiences are **not** dial-only:
  `clients.send` goes to apps over the relay, `sendLocal` to local windows, `sendCommander` is also forwarded
  to the gateway as `device` (`C/backendSocket.ts:674`), local windows replay every shared `openQuestions`
  entry on connect (`C/localWsServer.ts:464`), and `backend.questionProvider` answers come from remote apps.
- Stop from the dial: `turn.stop` → `core.turns.stop` → `backend.onCancel` → `cancelAgent` (~1020, ~2643);
  no cloud intercept there.
- `voice.begin` replaces the dial's explicit `agentId` with the openharness window's focus before
  transcription (`C/cable/cableSession.ts:1638`).
- The dial only shows the openharness window's active-tab tiles (`listAgentSnapshot`,
  `C/cable/cableHost.ts` ~458-498); empty with no window.
- Firmware holds at most 16 agents and silently ignores extras (`CABLE_MAX_AGENTS`, `F/cable_client.h:81-87`,
  `cable_client.c:1099`); comments record watchdog resets from large reconnect bursts — do not raise it. Ids:
  `ID_MAX 48` includes the terminator → **≤ 47 bytes**. `engine` is `char[12]`. Unknown frame fields are ignored.
  Claude layout keys on `engine == "claude"` (`F/ui/habitat/focus.c` ~906).
- Agent fields are enumerated in several places: core/device-view rows, `FleetRouter` projection
  (`C/services/fleetRouter.ts:186`), `CableAgent`, `CableSession`'s frame writer and change-detection key
  (`C/cable/cableSession.ts` ~2370, ~2435), firmware snapshot/project/UI structs.
- Cards the cable adapter understands: `commander_event` kinds `processing`, `done`, `summary`, `error`, and
  `tool` (`cableEventFor` / `cableStepFor`, `C/cable/cableHost.ts` ~936-972); `turn_started` has extra
  bookkeeping in `C/services/devices.ts` ~453.
- Questions: `ReviewQuestion {key, q, options: string[], multi, canText?}`; 1–4 questions, 1–6 options, unique
  keys, ≤ 6,500-byte signature (`C/cable/questionInbox.ts:33`), else silently dropped; firmware prompt/key/
  option buffers 256 bytes; free text disabled for multi-select (`ui_habitat.c` ~167, ~4669); one question
  bundle per agent in the cable inbox. Permission prompts already travel as ordinary questions, never with free
  text; the Wi-Fi door passes `allowPermissions:false`.
- `agent_deleted` clears activity bookkeeping but not `QuestionInbox` (separate close needed,
  `C/services/devices.ts:465`, `C/cable/cableSession.ts:3208`). The devices process keeps its cached view when
  core disconnects (`C/services/devicesProcess.ts:281`).
- Hook server: core process, loopback Host/Origin check, credential file checked for owner/mode/no-follow
  (`C/lib/hookAuth.ts:22`, `C/lib/localCredential.ts`). The bound port is stored inside
  `<dataDir>/daemon-<configuredPort>.json` (`C/lib/daemonRecord.ts`); `notify.mjs`'s discovery depends on a
  tmux pane and cannot be reused.

## 4. Design

### 4.1 Pieces

```
Claude desktop / terminal claude            openharness daemon (core)                 devices process      dial
┌────────────────────────────┐  HTTP      ┌───────────────────────────────┐ dial-only ┌──────────────┐ cable
│ the mod (one per session)  │──────────► │ session-source API  /api/      │ ───────►  │ CableSession │ ────► tiles,
│  lifecycle, activity,      │ ◄────────  │   sources/v1/*                 │  rows,    │              │       questions,
│  hold questions/perms,     │ long-poll  │ linked-sessions core module    │  cards,   │              │       stop, voice
│  submit prompt, abort turn │            │  (local, dial-only audience)   │ ◄──────── │              │ ◄────
└────────────────────────────┘            └───────────────────────────────┘ answers,  └──────────────┘
                                                                              turns, stop (cable only)
```

### 4.2 Session-source API (daemon) and trust boundary

- **Trust boundary (design call):** the same as the daemon's today — any process of the same OS user that can
  read the 0600 local credential is trusted to talk to the API. On top of that, **per-session capabilities**:
  registration returns a session token; every later call for that session must carry it, so one session (or
  a client that only knows the credential but not the token) cannot read, answer, poll or acknowledge another
  session's asks or commands. A malicious same-user process is out of scope, as it is for the existing daemon.
- **Credential access goes through a host helper**, not `$.fs`: mods have no Node runtime and `$.fs.stat`
  exposes neither uid nor mode and follows links, so the `hookAuth.ts` protections (open with `O_NOFOLLOW`,
  `fstat`, uid and mode checks on the opened descriptor) cannot be reproduced in the mod. The mod calls a
  subcommand of the installed `harness` CLI through `$.process.run` (e.g. `harness sources connect`), which
  performs the descriptor-based checks and returns what the mod needs (port + credential, or better a
  registration already made on the mod's behalf). Helper missing or failing → the mod stays inactive and Claude
  behaves as without it. Helper availability from the desktop app and terminal (PATH, permissions) is a spike
  item. The mod never logs or forwards the credential or the session token.
- **Discovery** (no tmux): default data dir `~/.harness/cli/data`, the configured port's record
  `daemon-<configuredPort>.json` (default 18473), using the **bound port stored inside** it; overrides via a
  mod option/env for data dir and port. With several daemons, only the configured one is used; no scanning.
- Routes under `/api/sources/v1/` (location: hook server or a small service; builder's call). Engine-neutral
  payloads: `source` (`claude-mod`), `engine` (`claude`), `surface` (`desktop` | `terminal` | `unknown`),
  `sessionKey`, `cwd`, `title`.
- Operations (shapes are the builder's; semantics fixed):
  1. **register** → session token + agentId; **heartbeat**; **unregister**. **rekey**: the mod reports a new
     session id after `/clear`/resume/module reload; the old identity's questions, commands and live cards are
     invalidated atomically and the tile is reused or replaced.
  2. **activity**: main-loop turn started (prompt's first line), tool step (name + short target), turn done
     (final text) / error. Subagent turns are filtered out so they never mark the main session idle.
  3. **ask**: the mod generates a client-side ask id **before** posting, then posts the question (or
     permission). The wait is a long-poll in bounded slices with a **server-side deadline** (≤ ~25 s) returning
     `pending` / `answered {answers}` / `approved` / `denied` / `gone`.
     **The mod is the single authority on the winner.** The moment the mod sees either the dial's answer or
     the desktop's result, that side wins, immutably, and the hook returns at once — never after another
     network round trip (a pending `next(e)` is only aborted by returning while it is still pending). The mod
     then reports `settle {askId, winner}` in the background, idempotently, with retries. The daemon treats a
     dial answer as provisional until settle arrives: the dial shows "sent" for it; a settle naming the desktop
     shows "answered on the computer"; no settle before expiry shows "not confirmed". A lost settle never
     changes the winner the mod already returned.
     **Display-only waits:** for a question or permission the dial cannot answer (oversized, unsupported, or
     the permission fallback), the mod posts a `wait {askId, kind, reason}` record instead. It has the same
     identity, lifecycle and cleanup as an ask (cleared by local completion, withdraw, rekey, expiry), counts as
     "waiting for the person" for visibility and ordering, and reaches the dial as a non-answerable "Answer on
     the computer" state.
  4. **withdraw {askId}**: answered locally / call ended. Idempotent; a withdraw for an ask the daemon has not
     seen yet leaves a **tombstone**, so a late `ask` with that id is refused.
  5. **commands**: a long-poll for commands addressed to this session (`prompt {id, text}`,
     `abort {id, turnId}`). Each command moves through `accepted → running → completed | failed | uncertain`;
     the mod reports transitions. After a reconnect the mod reports which command ids it has already seen, so
     redelivery is deduplicated; a command whose outcome is unknown is marked `uncertain` and **never retried
     automatically** (the dial shows it as not confirmed). Commands expire if not accepted within a short time
     (seconds for `abort`, a minute for `prompt`).
     **Receipts reach the dial.** Every command carries an id from the dial's request onwards. Today delivery
     reports success right after a void call (`C/services/fleetRouter.ts` ~481), voice review then returns
     `{ok:true}` and `VoiceDraft` marks the draft sent, and out-of-process delivery is a fire-and-forget notice
     dropped when core is absent (`C/services/devicesProcess.ts` ~112, ~157). For linked agents this becomes: an
     acceptance receipt with the command id (`queued` / `rejected` / `expired`) back through core → devices IPC
     → cable, then status updates (`started` / `uncertain`). The voice draft stays unsent until `queued`; core
     absent → `rejected`, never a silent drop. Firmware shows these states (4.5).
- Errors use the hook server's `{error: CODE}` style.

### 4.3 Linked-sessions core module (daemon)

- Keeps the live set of registered sessions. agentId ≤ 47 bytes, stable per session identity; dial name =
  title, else cwd basename (UTF-8-safe truncation).
- **Audience: dial only, local only.** Rows, cards and questions go to the cable path alone — never
  `clients.send`, never `sendLocal`, never the gateway, never replayed to local windows or phones. Answers,
  turns and stops for linked agents are accepted **only** from cable ingress (`answerReviewed`/`answer` from
  `CableSession`, `turn.send`, voice, `turn.stop`); the relay/app/Wi-Fi doors return "not found" for them.
  Permission questions honour the same `allowPermissions` rules as pane questions.
  Shared routing must not leak them either: `FleetRouter`'s flat list also feeds the desktop task picker
  (`routeTask`, `C/services/fleet.ts` ~251-323) and app delivery (`C/services/devices.ts` ~533-541), selecting a
  dial tile emits `sendLocal` focus/open messages (`devices.ts` ~211-218, `C/cable/cableHost.ts` ~651-662), and
  the Wi-Fi carousel walks the same list (`devices.ts` ~543-545). So: keep cable-visible and app-visible
  candidate lists separate, carry ingress provenance through shared routing, filter linked sessions out of
  desktop task routing and Wi-Fi traversal, and suppress desktop focus/open notifications for them.
- **Which sessions show (the person's answer):** a linked session is on the dial if it is **waiting for the
  person** (open ask/permission) or had **activity in the last 2 hours**; others stay registered but hidden.
  **Order and cap:** the dial's 16 slots are filled in this order: (1) any agent waiting for the person,
  (2) the openharness window's active-tab tiles, (3) linked sessions by most recent activity. Overflow is
  dropped from the end, deterministically; the dial's `agents.end {total}` keeps reporting the real total.
  Linked sessions show even when no openharness window is open. Implemented in `listAgentSnapshot` (or the
  step that feeds it), with tests for both window states and for overflow.
- **Source mark plumbing:** add `src` (and `surface` if the mark distinguishes desktop/terminal) through every
  place agent fields are enumerated: core/device-view rows (inline and out-of-process producers),
  `FleetRouter` projection, `CableAgent`, the frame writer, the change-detection key, and firmware
  snapshot/project/UI structs (4.5). `engine` stays `"claude"`.
- **Cards:** explicit mapping, mod event → commander card → cable frame:
  - turn started → `turn_started` + `processing` card (with the prompt's first line) → `turn.started`;
  - tool step → `tool` card → `turn.activity` step;
  - turn done → `done` (+ `summary` from `turn.complete`'s final text) → `turn.done` / `summary`;
  - turn error → `error` → `turn.error`.
- **Question adapter:** Claude's `{question, header, options[{label, description}], multiSelect}` →
  `ReviewQuestion {key, q, options: string[], multi, canText}` with a reverse map so the answer returns exact
  labels per question text (multi-select comma-joined, as the dialog does). `canText` true for single-select
  AskUserQuestion, false for multi-select and permissions. **Unsupported or oversized** (beyond 4×6, fields of
  255 UTF-8 bytes — firmware rejects ≥ 256 (`ui_habitat.c` ~4684-4692) — a 6,500-byte signature, undisplayable
  text) → not truncated: a display-only wait (4.2) shows "Answer on the computer" and the desktop dialog is the
  only way. Concurrent asks from one session are serialized (the cable
  inbox holds one bundle per agent); the next is shown when the first settles.
- **Turn from the dial / voice-to-tile:** delivery queues a `prompt` command. **Voice targeting fix:** when the
  dial's explicit target is a linked agent, `voice.begin` keeps it through capture, review and delivery
  (pane agents keep today's focus behaviour). Test with different dial and desktop selections.
- **Stop:** `core.turns.stop` / `backend.onCancel` for a linked agent queues `abort {turnId}` instead of
  `cancelAgent`. The turn id must be **the one the dial is showing**, carried end to end: today firmware sends
  only `agentId` in `turn.stop` (`F/cable_client.c` ~404-410) and does not keep a turn id from `turn.started`
  (~1399-1404), and the host/IPC pass only `agentId` (`C/cable/cableSession.ts` ~1528, `C/core/devicesLink.ts`
  ~142). So: `turn.started` carries a turn id for linked agents, firmware stores it per agent and echoes it in
  `turn.stop`, and it is propagated through CableSession, CableHost, FleetRouter, devices IPC and core. A
  linked-agent stop without an exact matching id is rejected (never "stop whatever is current"); firmware that
  does not echo the id therefore cannot stop linked sessions, and the dial says so. Pane agents keep today's
  path.
- **Expiry and core loss:** heartbeat loss (order of a minute), unregister or rekey closes every pending
  question (`QuestionInbox` included), resolves waits as `gone`, expires commands and live cards, then sends
  `agent_deleted`. The devices process holds linked rows on a **lease** renewed from core; if core disconnects,
  linked tiles become non-actionable (questions closed) until core is back and an authoritative reconcile
  replaces the cached view.

### 4.4 The mod

- Lives in the fork (e.g. `integrations/claude-dial-mod/`), installable for every session (a marketplace entry
  in the fork repo; `CLAUDE_CODE_PLUGIN_DIRS`/`--plugin-dir` while developing). README covers desktop and
  terminal. It stays silent inside sessions openharness launched in its own panes (detectable from the
  environment openharness sets).
- **Startup never blocks:** `session.start` only schedules work and returns; discovery and registration run in
  background timers with backoff. Daemon absent → slow retry, `debug` log only.
- **Single-flight polling:** at most one command long-poll and one heartbeat in flight; backoff on errors;
  every wait relies on the server-side deadline (the client has no timeout/abort). Whether an abandoned fetch
  can be cancelled is a spike item.
- **Activity:** `turn.start` (main loop only, remember `turnId`), `tool.call` (all tools; fire-and-forget,
  never awaited in the tool's path), `turn.complete` (final text). Rekey on session-id change.
- **AskUserQuestion:** call `next(e)` **exactly once** and keep that promise; post `ask` with a client-side id;
  race. Whichever side the mod sees first wins immutably (4.2): dial answer first → return
  `{ result: { questions: e.questions, answers } }` immediately (the dialog closes) and report `settle` in the
  background; dialog first → return its result immediately and report `withdraw`/`settle` in the background.
  Any daemon error before a dial answer was seen → return the **same** pending `next(e)` promise. Unsupported
  or oversized questions are posted as a display-only `wait`, not as an `ask`.
- **Permission prompts:** first-answer-wins is required but **unproven**. The plan's first task is a spike
  whose pass criteria are: approve from the dial → the tool runs **exactly once**; deny from the dial → it runs
  **zero** times and Claude gets a normal denial; the losing prompt (desktop or dial) closes; managed/org
  ceilings, deny rules and plan-mode restrictions still win; nothing changes when the daemon is down. If no
  mechanism passes, the fallback in 4.6 applies.
- **Commands:** `prompt` → `$.prompt.submit` without blocking the consumer (abort must stay handleable while a
  prompt is queued); report `running` when submitted and `completed` when its turn starts. `abort {turnId}` →
  `$.turn.abort` only if `turnId` is the current main-loop turn; otherwise report `failed: stale`.
- **Surface:** classify desktop vs terminal by a method the spike proves (env/process facts), not by
  `session.start.surface` alone.

### 4.5 Dial mark (firmware)

- The agent frame gains optional `src` (and `surface`); firmware stores them per agent (UTF-8-safe copies) and
  draws a small distinct mark on the tile, consistent with the Focus skin (artwork: builder). Old firmware
  ignores the fields; without them nothing changes.
- Firmware also gains, for linked agents: storing the turn id from `turn.started` and echoing it in
  `turn.stop`; showing command receipts (`queued` / `rejected` / `expired` / `uncertain`) for voice-to-tile and
  stop; the answer states "sent" / "answered on the computer" / "not confirmed"; and the non-answerable
  "Answer on the computer" wait state. Strings stay English.

### 4.6 Fallbacks if a spike fails (the person's answers)

- Mod does not work in terminal `claude` → terminal sessions use settings hooks in `~/.claude/settings.json`
  instead, for **status and AskUserQuestion only** (no prompt, no stop for those).
- `$.turn.abort` misbehaves → stop becomes **soft**: the next tool call is denied with a "stopped from the
  dial" reason, and the dial says so.
- `$.prompt.submit` from a command is unreliable → voice-to-tile is **dropped from this stage**; answering
  questions stays.
- Permission spike fails → permission prompts show on the dial as display-only "Answer on the computer"; the
  person is told before this ships.

## 5. Testing

- **Spikes first (plan task 1):** permissions (criteria in 4.4); `$.turn.abort` mid-tool (incl. a long Bash —
  killed or backgrounded?) and mid-text; `$.prompt.submit` idle and busy; the mod in terminal `claude`;
  several desktop sessions with independent mods; `/clear` and resume rekeying; surface detection; whether an
  in-flight `$.http.fetch` can be abandoned cleanly; the `harness` credential helper reachable from the
  desktop app and the terminal; `$.prompt.submit` resolution timing vs `turn.start`, its rejection, and
  `/clear`/resume while a prompt is queued.
- **Winner/settle (mod + daemon):** settle committed but its response lost; desktop result arriving during
  settle; a settle request that never returns; in all three the winner the mod returned never changes and the
  dial ends in a defined state.
- **Routing isolation:** linked sessions absent from desktop task routing (`routeTask`), app delivery and
  Wi-Fi traversal; selecting a linked tile on the dial sends no `sendLocal` focus/open.
- **Receipts and stop ids:** voice-to-tile keeps the draft until `queued`; core absent → `rejected`; a stop
  carrying an old turn id does not stop the new turn; a stop without an id is rejected for linked agents.
- **Daemon (vitest):** auth (no credential → 401; wrong session token → refused; non-loopback → refused);
  register/heartbeat/expiry/rekey with full cleanup; ask → candidate → settle; withdraw before ask (tombstone);
  stale answers → `STALE_QUESTION`; commands' state machine, dedup after reconnect, `uncertain` never retried,
  expiry; audience isolation (nothing reaches `clients.send`, `sendLocal`, the gateway or local-window replay;
  relay/app/Wi-Fi answer doors refuse linked agents); visibility and ordering with/without a window and with
  >16 agents; voice targeting with different dial/desktop selections; stop queues `abort {turnId}` and never
  touches panes; core disconnect leaves no actionable linked tile.
- **Mod (`claude plugin test`):** daemon down → every hook behaves as without the mod and startup is not
  delayed; AskUserQuestion race both ways with `next(e)` called once; command handling incl. abort while a
  prompt is queued; rekey.
- **Firmware host tests:** agent frame with `src`/`surface` parses and the mark renders; without them nothing
  changes; long Cyrillic names truncate safely.
- **End to end on the board:** desktop and terminal sessions appear with the mark; a Russian AskUserQuestion
  answered by option and by dictation from the dial; the same question answered on the Mac closes on the dial;
  permission per the spike's outcome; voice-to-tile starts a turn; BOOT stop interrupts a running turn and not
  the next one; quitting the app removes the tiles within the heartbeat window; an old idle session is hidden.

## 6. Left to the builder

Route and field names, module/file names, long-poll slice and heartbeat timing within the bounds above, the
mod's override option names, the summary length, the mark artwork, and hook server vs a small service per
`cli/AGENTS.md` (shortest path is acceptable in the fork).
