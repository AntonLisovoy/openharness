# Claude Sessions on the Round Dial Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code sessions not launched by openharness (Claude desktop Code tab, terminal `claude`) appear on the dial as marked agent tiles whose questions/permissions can be answered, which can receive a voice task, and whose running turn can be stopped — through a Claude Code mod, without tmux.

**Architecture:** A mod (`plugins/claude-dial/`) in every Claude session talks over loopback HTTP to a versioned session-source API (`/api/sources/v1/*`) on the daemon's hook server. A core module `linked` (shaped like `core/agents/cloud.ts`, but dial-only) keeps sessions, asks, display-only waits and commands, and sends frames straight to `ports.devices.card`. Linked sessions are **never** core agents: the cable reaches them through a **cable-only overlay** in `DaemonCableHost` that merges their rows after the Fleet listing and intercepts their operations before `viaFleet`, so Fleet, apps, phones, relay and Wi-Fi never see them. Firmware learns a source mark, short turn tokens, command receipts and an "Answer on the computer" wait.

**Tech Stack:** TypeScript (cli, vitest; 100% coverage gate for `src/core`/`src/services`; `src/architecture.spec.ts` import gate; e2e via `IsolatedDaemon` + `HARNESSD_TEST_DIAL_PORT` fake dial), Claude Code mods (TS hooks module, `claude plugin validate|test`), C11 ESP-IDF firmware with host tests and Python source-extraction tests.

**Spec:** `docs/superpowers/specs/2026-10-26-dial-claude-sessions-design.md` (r3). Roadmap: `docs/superpowers/specs/2026-10-26-dial-roadmap.md`.

## Global Constraints

- Fork only. Branch `feat/round-dial`, **after** every task of `2026-10-26-dial-russian.md` is committed there; this plan uses its `cli/src/lib/dialText.ts` (`dialDisplayable`) and firmware `utf8_copy`/`utf8_cut`.
- Linked sessions are visible and actionable **only on the cabled dial**: never `clients.send`, `sendLocal`, `sendRemote`, `backend.sendCommander`/gateway, Wi-Fi, local-window replay, the shared `openQuestions` map, Fleet (`services/fleet.ts`, `fleetRouter.ts`) or `core.agents.*` lists. Dial frames go through `ports.devices?.card(frame)` (the `superTabWaits` pattern, `cli/src/core/main.ts:851`).
- Core modules must not import from `cli/src/cable/` (`src/architecture.spec.ts:193,225,515`); shared predicates live in `cli/src/lib/`.
- Trust boundary: same-user processes holding the 0600 local credential, plus a per-session token on every session-scoped call.
- Every mod failure path falls through to Claude's normal behaviour; `session.start` never awaits the daemon; each hook calls `next(e)` at most once.
- Limits: agent ids ≤ 47 bytes; firmware cap 16 agents (do not raise); question fields ≤ 255 UTF-8 bytes; 1–4 questions × 1–6 options; `JSON.stringify([askId, questions])` ≤ 6,500 bytes; turn tokens ≤ 11 bytes.
- Visibility: shown if waiting for the person or active in the last **2 hours**. Slot order: (1) agents waiting for the person, (2) openharness active-tab tiles, (3) linked by most recent activity; overflow dropped from the end; `agents.end.total` stays the real total.
- Timing: heartbeat 20 s, expiry 60 s; long-poll server deadline 25 s; acceptance expiry `abort` 5 s, `prompt` 60 s; provisional dial answer unsettled for 30 s → "Not confirmed".
- Dial strings stay English. Avoid the word "external" in new names.
- Plugin dir: `plugins/claude-dial/`, appended as the **second** entry of `.claude-plugin/marketplace.json` (harness stays first; do not touch `.cursor-plugin/marketplace.json`).
- Commands: `cd cli && npx vitest run <file>`, `npm run typecheck`, `npm run test:core`, `npx vitest run src/architecture.spec.ts`, `npm run test:e2e -- <file>`, `make cli-test`, `make device-test` (with `IDF_PATH` for cJSON tests), `claude plugin validate plugins/claude-dial`, `claude plugin test plugins/claude-dial`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Shared contracts (every task uses these names exactly)

```ts
// cli/src/core/agents/linkedTypes.ts  (Task 3 creates it; no imports from cable/)
export type LinkedSurface = 'desktop' | 'terminal' | 'unknown'
export interface LinkedRegister { source: string; engine: 'claude'; surface: LinkedSurface; sessionKey: string; cwd: string; title?: string }
export interface LinkedRow {
  agentId: string            // 'ln-' + 40 hex chars of sha256(sessionKey)  (43 bytes)
  name: string               // title, else basename(cwd), else 'Claude'; cut by utf8 boundary to 39 bytes
  engine: 'claude'; src: 'mod'; surface: LinkedSurface
  registeredAt: number; lastActivityAt: number
  waiting: boolean           // an ask or display-only wait is open
  turnToken: string | null   // short token of the running main-loop turn, ≤ 11 bytes
}
export type LinkedActivity =
  | { kind: 'turn_start'; turnId: string; text: string }
  | { kind: 'tool'; turnId: string; tool: string; target?: string }
  | { kind: 'turn_done'; turnId: string; final?: string }
  | { kind: 'turn_error'; turnId: string; text: string }
export interface ClaudeQuestion { question: string; header?: string; options: { label: string }[]; multiSelect: boolean }
export type AskInput =
  | { askId: string; kind: 'question'; questions: ClaudeQuestion[] }
  | { askId: string; kind: 'permission'; tool: string; summary: string; allowAlways: boolean }
export type WaitResult =
  | { state: 'pending' } | { state: 'answered'; answers: Record<string, string> }
  | { state: 'approved'; always: boolean } | { state: 'denied' } | { state: 'gone' }
export type Command = { id: string; kind: 'prompt'; text: string } | { id: string; kind: 'abort'; turnId: string }
export type CommandState = 'accepted' | 'running' | 'completed' | 'failed' | 'uncertain' | 'soft'
export type CommandReceipt =
  | { ok: true; cmdId: string; state: 'queued' }
  | { ok: false; cmdId: string | null; state: 'rejected'; reason: 'no_session' | 'stale_turn' | 'no_turn' | 'core_absent' | 'legacy_dial' }
export interface LinkedPort {           // what the cable overlay calls (core in-process, or devicesLink queries)
  rows(): LinkedRow[]
  send(agentId: string, text: string, cmdId: string): Promise<CommandReceipt>
  stop(agentId: string, turnToken: string | undefined, cmdId: string): Promise<CommandReceipt>
  answer(agentId: string, requestId: string, answers: Record<string, string>): Promise<{ ok: true } | { ok: false; error: 'STALE_QUESTION' | 'AGENT_NOT_FOUND' }>
  replay(): Record<string, unknown>[]   // live processing cards, open questions, open waits — for a dial that just attached
}
```

Dial frames (core → `ports.devices.card` → devices → CableSession → dial):
`{type:'commander_event', agentId, dbSessionId: agentId, payload:{kind:'turn_started'|'processing'|'tool'|'done'|'summary'|'error', ..., turnToken?}}`,
`{type:'commander_question', agentId, dbSessionId: agentId, payload:{requestId, questions, notification:{id, kind:'needsYou'}}}`,
`{type:'commander_question_close', agentId, payload:{requestId, reason:'sent'|'elsewhere'|'unconfirmed'}}`,
`{type:'agent_deleted', payload:{agentId}}` (exact cloud shape, `core/agents/cloud.ts:87`),
`{type:'linked_receipt', agentId, payload:{cmdId, state: CommandState | 'queued' | 'rejected' | 'expired'}}`,
`{type:'linked_wait', agentId, payload:{id, text:'Answer on the computer'}}`, `{type:'linked_wait_close', agentId, payload:{id}}`.

Cable wire, compatibility matrix (hello capability `linked: 'v1'`):

| Item | Capable dial | Legacy dial |
|---|---|---|
| Existing pane frames | unchanged | unchanged |
| `agent` frame for linked rows (+ `src`, `surface`) | sent | sent (extra fields ignored) |
| `turn.started` (+ `turnToken`), `question.close` (+ `reason`) | sent | sent (extra fields ignored) |
| `question` / `answer.reviewed` for linked asks | work | work |
| `linked.receipt`, `linked.wait`, `linked.wait.close` | sent | not sent; wait → `toast "Answer on the computer"` |
| `turn.stop` for a linked agent | carries `turnToken` | no token → `rejected: legacy_dial` → `toast "Update the dial to stop this session"` |

Command ids are assigned by CableSession at dial ingress (`turn.send`, the voice turn after transcription, `turn.stop`) as `c` + 10 random base36 chars; the dial never retries these requests, so ingress is the first hop that can dedupe.

## Review Focus

1. **Two dials attached, one legacy** — a linked question shows on both and answering on one closes it on both; stop works on the capable dial and is refused with the update toast on the legacy one. Test in Task 6.
2. **Daemon restarts while a desktop question is open** — the mod re-registers, the old ask is `gone`, the mod keeps waiting on the desktop dialog only; no stale tile. Test in Task 9.
3. **Claude desktop with 20+ old sessions** — only waiting/recent ones take slots; never > 16 agents to the dial. Test in Task 6.
4. **Answer on the Mac a split second after the dial answer** — exactly one answer reaches Claude (the one the mod saw first); the dial shows "Sent" or "Answered elsewhere." accordingly. Test in Task 10.
5. **Mod inside a pane openharness launched (incl. a pane moved to another tmux session)** — the mod stays silent. Test in Task 2.

---

### Task 1: Spike — settle the unproven behaviours and freeze the capability table

Throwaway code under `~/.claude/dev-mods/` or `--plugin-dir`; nothing committed except the report.

**Files:**
- Modify: `docs/superpowers/specs/2026-10-26-dial-claude-sessions-design.md` (append "Spike results")

- [ ] **Step 1: Permissions.** Try (a) racing `tool.call`'s pending `next(e)` against a remote verdict and (b) answering from `tool.check`. Pass only if: dial-approve → tool runs exactly once; dial-deny → zero runs and a normal denial; the losing prompt closes; managed/org rules, deny rules and plan mode still win; daemon down → unchanged. Record screen captures / logs from a desktop and a terminal session as evidence.
- [ ] **Step 2: `$.turn.abort`** from a timer-driven long-poll command: mid-text, mid-tool, mid `Bash sleep 60` (killed or backgrounded?), and a mismatched `turnId` rejects.
- [ ] **Step 3: `$.prompt.submit`** idle and busy: promise resolution vs `turn.start`, rejection, `/clear` and resume while queued.
- [ ] **Step 4: Environment:** mod in terminal `claude`; two desktop sessions at once; `/clear`/resume (new session id without `session.start`); desktop-vs-terminal signal; an abandoned `$.http.fetch`; `$.process.run(['harness', ...])` from the desktop app (PATH) and terminal; `$.state` surviving a mod reload.
- [ ] **Step 5: Write "Spike results"** with this table filled in — each row `works` or `fallback`:

| Capability | If `fallback` |
|---|---|
| Mod in terminal | Task 12a (settings hooks, status + questions only) replaces Tasks 9–11 for terminal |
| `$.turn.abort` | Task 11 implements soft stop (state `soft`; dial toast "Stops before the next tool") |
| `$.prompt.submit` | Task 11 rejects prompts (`failed: unsupported`); voice-to-tile hidden for linked tiles |
| Permissions | Task 12 posts display-only waits; **stop and ask the person before continuing** |
| `harness` helper reachable | mod stays inactive where unreachable; README documents PATH setup |

  Commit `docs: stage-2 spike results`. Every later task reads this table; Task 13's acceptance follows it.

### Task 2: `harness sources connect` helper (credential, port, pane ownership)

**Files:**
- Create: `cli/src/commands/sourcesConnect.ts`, `cli/src/commands/sourcesConnect.spec.ts`
- Modify: `cli/src/cli.ts` (`case 'sources':` beside `link`, ~2904)

**Interfaces:**
- Produces: `harness sources connect` → exit 0, one JSON line `{"v":1,"baseUrl":"http://127.0.0.1:<port>","credential":"<43 chars>","harnessPane":false}`; exit 3 and no stdout only when the credential is missing or fails the descriptor checks. Port = `savedDaemonPort(dataDir, configuredPort)` (record's bound port, else configured).
- `export async function sourcesConnect(opts: { dataDir: string; configuredPort: number; env: NodeJS.ProcessEnv; tmux?: TmuxQuery }): Promise<{ v: 1; baseUrl: string; credential: string; harnessPane: boolean } | null>`
- `harnessPane` uses the same ownership semantics as `cli/hook/notify.mjs:446-455,530-544` (`HARNESS_PANE` set, or `TMUX_PANE` whose pane carries the `@harness_daemon` owner even if moved to another session); tmux unavailable → false.

- [ ] **Step 1: Failing tests:** valid 0600 credential + `daemon-18473.json {port: 50123}` → baseUrl `:50123`; no record → `:18473`; credential mode 0644 → null; symlinked credential → null; `HARNESS_PANE=h:%3` → `harnessPane:true`; `TMUX_PANE` of a Harness-owned pane moved to session `work` → true; ordinary user tmux pane → false; tmux missing → false; stdout is exactly one JSON line.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/commands/sourcesConnect.spec.ts` — FAIL.
- [ ] **Step 3: Implement** with `readLocalCredential` / `readHookCredential` (`lib/hookAuth.ts:22-45`) and `savedDaemonPort` (`lib/daemonEndpoint.ts:11`); reuse or extract the pane-ownership query from `notify.mjs` into `lib/` (injectable `TmuxQuery`).
- [ ] **Step 4: Run** spec + `npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(cli): harness sources connect for the dial mod`.

### Task 3: Core — linked sessions, activity, turn tokens, expiry

**Files:**
- Create: `cli/src/core/agents/linkedTypes.ts` (the shared contracts above), `cli/src/core/agents/linked.ts`, `linked.spec.ts`

**Interfaces:**
- Produces: `createLinkedSessions(deps: { sendDial(frame: Record<string, unknown>): void; now(): number; randomId(): string; log?(line: string): void }): LinkedSessions` with `register(r: LinkedRegister): { sessionToken: string; agentId: string; heartbeatMs: 20000 }`, `bySessionToken(token): string | null` (agentId), `heartbeat(token): boolean`, `rekey(token, sessionKey): string | null`, `unregister(token): void`, `activity(token, a: LinkedActivity): boolean`, `rows(): LinkedRow[]`, `owns(agentId): boolean`, `currentTurn(agentId): { turnId: string; turnToken: string } | null`, `liveCards(): Record<string, unknown>[]`, `sweep(): void`, `onGone(fn: (agentId: string) => void): void`.
- Turn tokens: `t` + base36 counter per agent (≤ 11 bytes), mapped to the mod's `turnId`; reset on `turn_done`/`turn_error`.

- [ ] **Step 1: Failing tests** (style of `core/agents/cloud.spec.ts`): ids are `ln-` + 40 hex (43 bytes); name fallbacks title → basename(cwd) → `Claude`, cut at a UTF-8 boundary to ≤ 39 bytes (60-byte Russian title); unknown token → false; 60 s without heartbeat then `sweep()` → `{type:'agent_deleted', payload:{agentId}}` and `onGone` once; `rekey` → new agentId, deletion of the old; activity frames exactly as in Shared contracts with `turnToken` on `processing`/`done`/`summary`/`error`; `tool`/`turn_done` for a non-current `turnId` ignored; `liveCards()` only while a turn is open; nothing leaves except via `sendDial`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/core/agents/linked.spec.ts` — FAIL. **Step 3: Implement** (pure, timer-free). **Step 4: Run** + `npm run test:core` — PASS, 100%.
- [ ] **Step 5: Commit** `feat(core): linked sessions — registry, activity, turn tokens, expiry`.

### Task 4: Core — asks, display-only waits, commands

**Files:**
- Create: `cli/src/core/agents/linkedAsks.ts`, `linkedAsks.spec.ts`, `linkedCommands.ts`, `linkedCommands.spec.ts`
- Modify: `cli/src/core/agents/linked.ts` (compose; `waiting`; cleanup on gone/rekey; `replay()`)

**Interfaces:**
- Consumes: `dialDisplayable(text: string): boolean` from `cli/src/lib/dialText.ts` (Russian plan), Task 3.
- Produces on `LinkedSessions`:
  - `validateAsk(a: AskInput): { ok: true; questions: ReviewQuestion[] } | { ok: false; reason: 'too_many' | 'too_long' | 'empty' | 'duplicate' | 'undisplayable' }` — `ReviewQuestion` re-declared structurally in `linkedTypes.ts` (`{key, q, options: string[], multi, canText?}`); permission composes `q = `${tool}: ${summary}``, options `['Allow','Deny']` (+ `'Allow always'` iff `allowAlways`), `canText:false`, key `permission`; validation runs on the **final** composed bundle including `JSON.stringify([askId, questions]) ≤ 6500` bytes, unique non-empty keys, non-empty options, every field ≤ 255 bytes and `dialDisplayable`.
  - `ask(token, a): { ok: true } | { ok: false; error: 'TOMBSTONED' | 'UNSUPPORTED' | 'NO_SESSION' | 'BUSY' }` (one open ask per session; `BUSY` while another is open — the mod queues locally).
  - `wait(token, askId, deadlineMs): Promise<WaitResult>`; `answerFromDial(agentId, requestId, answers): { ok: true } | { ok: false; error: 'STALE_QUESTION' | 'AGENT_NOT_FOUND' }` (provisional); `settle(token, askId, winner: 'dial' | 'local')` (idempotent, emits close `sent`/`elsewhere`); 30 s unsettled → close `unconfirmed`; `withdraw(token, askId)` (close `elsewhere`, or a 60 s tombstone if unseen); `displayWait(token, {askId, kind, reason})`.
  - Commands: `queuePrompt(agentId, text, cmdId): CommandReceipt`, `queueAbort(agentId, turnToken | undefined, cmdId): CommandReceipt`; `poll(token, deadlineMs): Promise<Command[]>` returns commands **not yet `accepted`** (redelivery on a lost poll response); `commandState(token, id, s: CommandState)`; same `cmdId` queued twice → the first receipt; a command `accepted` but without a terminal state when its session goes → `uncertain`; never re-queued; receipts as `linked_receipt` frames; not accepted in time → `expired`.
  - `replay(): Record<string, unknown>[]` = live cards + open linked questions + open waits.

- [ ] **Step 1: Failing tests `linkedAsks.spec.ts`:** exact boundary — a bundle serializing to 6,500 bytes passes and 6,501 fails; 255- vs 256-byte field; duplicate question text → `duplicate`; empty option → `empty`; emoji → `undisplayable`; permission prompt validated after composition; every rejection makes the caller-visible `UNSUPPORTED`; dial answer → `wait` resolves `answered` once; second answer `STALE_QUESTION`; settle `local` after a provisional dial answer → close `elsewhere`; 30 s → `unconfirmed`; withdraw-before-ask tombstone; rekey/gone → waits `gone`, question and wait closed; only `sendDial` used.
- [ ] **Step 2: Failing tests `linkedCommands.spec.ts`:** queued → polled → not `accepted` → polled again (lost response) → `accepted` → not polled again; duplicate `cmdId` → same receipt; abort with missing/stale `turnToken` rejected; abort delivered while a prompt is queued; expiry → `expired`; session gone with an accepted command → `uncertain`; receipt frames exact.
- [ ] **Step 3: Run** both — FAIL. **Step 4: Implement**, compose into `linked.ts`. **Step 5: Run** + `npm run test:core` + `npx vitest run src/architecture.spec.ts` — PASS.
- [ ] **Step 6: Commit** `feat(core): linked asks, display-only waits and commands`.

### Task 5: Session-source API and core wiring

**Files:**
- Create: `cli/src/lib/sourcesApi.ts`, `cli/src/lib/sourcesApi.spec.ts`
- Modify: `cli/src/hookServer.ts` (delegate `/api/sources/v1/*` like `/api/store/*` ~1214; `HookServerHandlers.linked?`)
- Modify: `cli/src/core/main.ts` (construct `linked` near ~851 with `sendDial: f => ports.devices?.card(f)`, adding `fullText` to summaries as the tee at ~3186 does; replay `linked.replay()` in `dialWatching` ~974-982; a 5 s `sweep` interval; **no** chaining at ~836, ~837, ~1030, ~1031, ~1403, ~2828, ~2967)
- Modify: `cli/src/core/api.ts` (`CoreApi.linked?: LinkedPort`; `createCoreApi` deps), `cli/src/core/api.spec.ts`
- Modify: `cli/src/core/devicesLink.ts` (`view.linked: LinkedRow[]` — a separate field, not merged into `view.agents`; queries `linkedSend`, `linkedStop`, `linkedAnswer`, `linkedReplay`), `cli/src/core/devicesLink.spec.ts`

**Interfaces:**
- Routes (POST JSON; `Authorization: Bearer <credential>`; all but `register` need `X-Linked-Session`): `register`, `heartbeat`, `rekey {sessionKey}`, `unregister`, `activity`, `ask`, `wait {askId}` (≤ 25 s), `settle {askId, winner}`, `withdraw {askId}`, `display-wait {askId, kind, reason}`, `commands {}` (≤ 25 s), `command-state {id, state}`. Errors `{error}`: 401 `LOCAL_CREDENTIAL_REQUIRED`, 403 `FORBIDDEN_HOST`, 404 `NO_SESSION`, 400 `BAD_REQUEST`.
- `export async function routeSourcesRequest(req, res, url: string, deps: { linked: LinkedSessions | null; credentialOk: boolean; deadlineMs?: number }): Promise<boolean>`

- [ ] **Step 1: Failing tests** `sourcesApi.spec.ts` (real `startHookServer(0, …)` as in `hookServer.spec.ts`): no credential → 401; another session's token → 404 with no effect; non-loopback Host → 403; `wait`/`commands` return at the injected deadline; register → ask → `answerFromDial` → `wait` `answered`.
- [ ] **Step 2: Failing tests** `api.spec.ts` / `devicesLink.spec.ts`: `CoreApi.linked` present only when wired; `view.linked` carries rows; `view.agents` never contains an `ln-` id; `linkedSend` returns the receipt.
- [ ] **Step 3: Run** — FAIL. **Step 4: Implement.** **Step 5: Run** + `npm run test:core` + `npm run typecheck` + architecture spec — PASS.
- [ ] **Step 6: Commit** `feat(daemon): session-source API v1 and dial-only wiring`.

### Task 6: Cable overlay, ordering, receipts, voice target, turn tokens

**Files:**
- Modify: `cli/src/cable/cableHost.ts` — `CableHostWiring.linked?: LinkedPort`; `listAgentsFlat`/`listAgentSnapshot` (~478-498, 554) merge `linked.rows()` **after** the Fleet result and apply the visibility/ordering/cap rules; `knows`, `sendTurn`, `stopTurn`, `answer`, `answerReviewed`, `canSpeakQuestion`, `focus`, `openAgent`, `stepFocus` check `linked` ids first and never call `viaFleet` or `wiring.focused/opened` for them; `cableEventFor` (~954-972) and `cableQuestionCloseFor` (~1001) keep `turnToken`/`reason`
- Modify: `cli/src/cable/cableSession.ts` — `CableAgent` (~195-210) + `src?`, `surface?`; `agentsKey` (~2370) and the agent frame (~2436-2447) include them; `CableHost.sendTurn(agentId, text, cmdId?): SendResult | Promise<SendResult>` and `stopTurn(agentId, turnToken?, cmdId?): void | Promise<CommandReceipt>`; the three senders await: `turn.send` (~1525), non-review voice (~2275-2286), review `submit` (~2247-2263; draft stays unsent until `ok:true`); conversion `CommandReceipt` → `SendResult`: `ok:true` → `{ok:true}`, `ok:false` → `{ok:false, reason}`; `turn.stop` reads `turnToken` (~1528); voice focus override (~1638) skipped when the explicit target is linked; `turnStarted(agentId, text, update?, turnToken?)` (~2931) and `refreshFocusedActivity` (~3010) send `turnToken`; new `linkedReceipt`, `linkedWait`, `linkedWaitClose`; legacy behaviour per the compatibility matrix
- Modify: `cli/src/cable/cableFleet.ts` — wrappers for every new session method
- Modify: `cli/src/services/devices.ts` — wire `linked` (in-process: `core.linked`; the overlay only); `dispatch` (~317) passes `event.turnToken` to `cable.turnStarted`; `port.card` routes `linked_receipt`, `linked_wait(_close)`, `commander_question_close.reason`
- Modify: `cli/src/services/devicesProcess.ts` — `linked` port backed by `view.linked` and the new queries; core absent → receipts `rejected: core_absent`; on disconnect (~281) clear linked rows and close their questions/waits; reconnect → `linkedReplay`
- Test: `cableHost.spec.ts`, `cableSession.spec.ts`, `cableFleet.spec.ts`, `services/devices.spec.ts`, `services/devicesProcess.spec.ts`

- [ ] **Step 1: Failing tests:**
  - overlay with Fleet present **and** absent: linked rows listed, `knows` true, send/answer/stop reach `LinkedPort`, Fleet mocks never called for `ln-` ids; selecting a linked tile triggers no `focused`/`opened`; `stepFocus` skips linked.
  - ordering (Review Focus 3): no window + 3 linked (waiting / 10 min / 3 h) → waiting, recent; idle hidden; tab of 14 + 5 recent linked + 1 waiting pane → waiting first, 14 tab, 1 linked; never > 16; `total` real.
  - receipts: `turn.send` to a linked agent returns after the receipt; review draft stays unsent on `rejected`; core absent → `rejected: core_absent` toast; `cmdId` generated once per dial request.
  - turn tokens: core frame → devices `dispatch` → `turn.started {turnToken}` → `turn.stop {turnToken}` → `LinkedPort.stop(agentId, token)`.
  - compatibility (Review Focus 1): one capable + one legacy dial on `cableFleet`: both get the question; answer on one closes both; legacy stop → `toast "Update the dial to stop this session"`; legacy gets no `linked.*` frames; pane frames byte-identical.
  - disconnect: core loss clears linked tiles and questions; reconnect replays.
- [ ] **Step 2: Run** each file — FAIL. **Step 3: Implement.** **Step 4: Run** + `npm run test:core` + `make cli-test` — PASS.
- [ ] **Step 5: Commit** `feat(devices): linked Claude sessions on the dial through a cable-only overlay`.

### Task 7: Daemon integration test (isolation end to end)

**Files:**
- Create: `cli/e2e/linkedSessions.e2e.ts` (pattern of `e2e/deviceCompat.e2e.ts:77`: `IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false', HARNESSD_TEST_DIAL_PORT } })` + `e2e/harness/fakeDial.ts`)

- [ ] **Step 1: Write the test:** a fake mod client registers over HTTP and asks a question; the fake dial sees the tile (with `src:'mod'`) and the question, answers it, the mod's `wait` gets `answered`; a local-window WebSocket client connected to the daemon receives **no** linked frame and no linked entry in `commander_questions_open`; a `turn.send` from the fake dial yields a command on the mod's poll; stopping the mod's heartbeat removes the tile; run once with devices in-process (`HARNESSD_SERVICES=none`) and once out-of-process.
- [ ] **Step 2: Run** `cd cli && npm run test:e2e -- linkedSessions` — PASS (fix wiring in Tasks 5–6 if not).
- [ ] **Step 3: Commit** `test(e2e): linked sessions stay on the cable`.

### Task 8: Firmware — mark, turn tokens, receipts, computer-only waits

**Files:**
- Modify: `devices/harness-device/firmware/main/cable_client.h` (`project_t` + `src[8]`, `surface[12]`), `cable_client.c` — `cable_agent_t` + `src`, `surface` (via `utf8_copy`); a **separate** table `static struct { char id[ID_MAX]; char tok[12]; } s_turn_tok[CABLE_MAX_AGENTS]` keyed by agent id, set by `turn.started` (reject tokens ≥ 12 bytes), cleared by `turn.done`/`turn.error`/`agent` removal, untouched by roster refresh (`handle_agent` ~1094-1136); hello adds `msg_string(&root,"linked","v1")` (~312); `cable_client_stop_turn` (~404-411) adds `turnToken` when present; dispatch (~1340) handles `linked.receipt`, `linked.wait`, `linked.wait.close`; `question.close` reads `reason`
- Modify: `main/app_main.c:72-101` (`ui_project_set_source(id, src, surface)`)
- Modify: `main/ui/habitat/character_types.h:23-66` (`ht_character_face_t` + `bool linked;`), the face construction sites in `ui_habitat.c` (~1317, ~1417, ~2195) set it; `ui_habitat.c` `agent_t` (~156-165) gains `linked`/`surface` **after** its first line (keeps `test_question_ui.py` slicing)
- Modify: `main/ui/habitat/focus.c` (~920): when `f->linked`, draw the mark — an 8 px-diameter ring, 2 px stroke, centred 14 px right and 14 px up from the engine mark's centre, in the engine ink at 60% — with the same primitive the badge uses; no new generated asset
- Modify: `main/ui/habitat/ui_habitat.c` — `ui_question_close` toasts `Sent` / `Answered elsewhere.` / `Not confirmed` by `reason`; receipts `rejected`/`expired`/`uncertain`/`soft` → `Not sent` / `Expired` / `Not confirmed` / `Stops before the next tool`; `linked.wait` → tile waiting with `Answer on the computer`, no options
- Test: `test/test_agent_snapshot.py`, `test/test_question_ui.py`, `test/test_character.c` (golden), new `test/test_linked_frames.py`

- [ ] **Step 1: Failing tests:** `agent {src:"mod"}` stores it; a Focus face with `linked=true` differs from the same face with `false` only inside the ring's bounding box, and the unmarked render equals the pre-change golden; `turn.started {turnToken:"t1"}` → roster refresh (reordered agents) → BOOT stop sends `{t:"turn.stop", agentId, turnToken:"t1"}`; a 12-byte token is rejected (no stop token stored); pane agent stop has no token; receipts and wait strings as above; hello contains `"linked":"v1"`.
- [ ] **Step 2: Run** `make device-test` — FAIL. **Step 3: Implement.** **Step 4: Run** `make device-test` (and with `IDF_PATH`) — PASS.
- [ ] **Step 5: Commit** `feat(firmware): linked sessions — mark, turn tokens, receipts, computer-only waits`.

### Task 9: The mod — connection, lifecycle, activity, rekey

**Files:**
- Create: `plugins/claude-dial/.claude-plugin/plugin.json` (`name:"claude-dial"`, `version:"0.1.0"`, `description`, `license:"MIT"`, `types`), `plugins/claude-dial/types/index.d.ts` (`PluginState` for `$.state` keys), `hooks/hooks.json` (`{"modules":["./register.ts"]}`), `hooks/register.ts`, `hooks/daemon.ts`, `hooks/lifecycle.ts`, `hooks/lifecycle.test.ts`, `plugins/claude-dial/README.md`
- Modify: `.claude-plugin/marketplace.json` (second entry `{ "name": "claude-dial", "source": "./plugins/claude-dial" }`)

**Interfaces:**
- Produces (used by Tasks 10–12):
  - `interface Conn { baseUrl: string; credential: string; sessionToken: string; agentId: string }`
  - `daemon.ts`: `connect($, register: LinkedRegister): Promise<Conn | null>` (runs `harness sources connect`; `harnessPane:true` → null), `post<T>($, conn, path: string, body: unknown): Promise<T | null>` (null on any error, never throws)
  - `lifecycle.ts`: `$.state` keys `claudeDial.conn: Conn | null`, `claudeDial.turnId: string | null`, `claudeDial.sessionKey: string`, `claudeDial.seenCommands: string[]` (last 64)

- [ ] **Step 1: Failing tests** (`claude plugin test`): daemon absent → `session.start` returns without awaiting the network; every hook behaves as without the mod; daemon present → one register, heartbeat every 20 s single-flight with backoff; `harnessPane:true` → no register; `turn.start` main loop only → `activity turn_start` fire-and-forget; `tool.call` posts `tool` without delaying `next(e)`; `turn.complete` → `turn_done` with final text; session-id change → `rekey`; daemon restart (404 `NO_SESSION`) → re-register (Review Focus 2).
- [ ] **Step 2: Run** `claude plugin test plugins/claude-dial` — FAIL. **Step 3: Implement.** **Step 4: Run** + `claude plugin validate plugins/claude-dial` — PASS. README: `/plugin install claude-dial@openharness`, `--plugin-dir` for development, desktop/terminal notes, the `harness` PATH requirement.
- [ ] **Step 5: Commit** `feat(mod): claude-dial — connect, lifecycle, activity`.

### Task 10: The mod — AskUserQuestion race and computer-only waits

**Files:**
- Create: `plugins/claude-dial/hooks/ask.ts`, `hooks/ask.test.ts`; Modify: `hooks/register.ts`

- [ ] **Step 1: Failing tests:** `next(e)` called exactly once on every path; dial answer seen first → hook returns `{ result: { questions: e.questions, answers } }` immediately, `settle dial` posted in the background, retried, idempotent; dialog first → returns its result immediately, `withdraw` + `settle local` in the background; a `settle` that never returns does not delay the hook; daemon error before any dial answer → returns the original pending promise; `UNSUPPORTED` → `display-wait` posted and cleared when the dialog resolves; `BUSY` → the ask is queued in the mod and posted after the first settles; dial and Mac answers within 50 ms → exactly one returned, the first seen (Review Focus 4).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (client-side `askId` before posting; single-flight `wait` loop of ≤ 25 s slices). **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(mod): answer AskUserQuestion from the dial`.

### Task 11: The mod — prompt and abort commands

**Files:**
- Create: `plugins/claude-dial/hooks/commands.ts`, `hooks/commands.test.ts`; Modify: `hooks/register.ts`

- [ ] **Step 1: Failing tests:** one `commands` long-poll in flight; each command → `accepted` posted first, then executed; a redelivered id in `claudeDial.seenCommands` is acknowledged `accepted` again but not executed; `prompt` → `$.prompt.submit` not awaited by the consumer, `running` posted, `completed` on the matching `turn.start` (per Task 1's finding), rejection → `failed`; `abort {turnId}` of the current main-loop turn → `$.turn.abort`, `completed`; mismatch → `failed`; abort while a prompt is queued runs immediately; per Task 1's table: soft stop → deny the next `tool.call` with `Stopped from the dial` and post `soft`; prompts unsupported → `failed`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(mod): voice tasks and stop from the dial`.

### Task 12: The mod — permission prompts (per Task 1)

**Files:**
- Create: `plugins/claude-dial/hooks/permission.ts`, `hooks/permission.test.ts`; Modify: `hooks/register.ts`

- [ ] **Step 1: Failing tests (mocked hook contract):** if Task 1 proved a mechanism — dial `Allow` → the mocked downstream runs once; `Deny` → zero runs and a deny result; desktop first → `withdraw`/`settle local`; daemon down → unchanged. If not — every permission prompt posts a `display-wait` (kind `permission`) cleared when it resolves; tool behaviour untouched. (Real acceptance — a person granting on the Mac vs the dial — is Task 13, since plugin tests cannot drive the interactive prompt.)
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(mod): permission prompts on the dial`.

### Task 12a (only if Task 1 marks terminal `fallback`): settings-hook bridge for terminal

**Files:**
- Create: `plugins/claude-dial/hooks-settings/bridge.mjs`, `bridge.test.mjs`; README section with the exact `~/.claude/settings.json` hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse` matcher `AskUserQuestion` returning `permissionDecision:"allow"` + `updatedInput.answers`, `Stop`, `SessionEnd`)

- [ ] **Step 1: Failing tests:** the bridge registers/heartbeats via `harness sources connect`, reports turns, and answers AskUserQuestion from a dial answer with `updatedInput.answers`; no prompts or stops; daemon down → exits 0 with no output.
- [ ] **Step 2: Run** `node --test plugins/claude-dial/hooks-settings` — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS. **Step 5: Commit** `feat(mod): settings-hook bridge for terminal claude`.

### Task 13: End to end on the board (acceptance follows Task 1's table)

**Files:**
- Modify: `docs/superpowers/specs/2026-10-26-dial-claude-sessions-design.md` (append "Results")

- [ ] **Step 1:** Flash the branch firmware (roadmap stage 0), run the branch daemon, install the mod, remove the throwaway `dial-spike` mod.
- [ ] **Step 2:** Desktop and terminal sessions appear with the ring mark; an idle 3 h session does not.
- [ ] **Step 3:** Russian AskUserQuestion answered by option and by dictation on the dial; another answered on the Mac closes on the dial with `Answered elsewhere.`.
- [ ] **Step 4:** Per Task 1's table: permission (dial approve/deny, or "Answer on the computer"); voice-to-tile (`queued` → working, or hidden); stop (interrupts the running turn, or "Stops before the next tool"); a stop for an ended turn does not touch the next one.
- [ ] **Step 5:** Quit the desktop app → tiles gone within ~60 s; stop the daemon mid-question → Claude keeps working normally.
- [ ] **Step 6:** Write "Results" (each row pass/fail, deferred items) and commit `docs: stage-2 results`.
