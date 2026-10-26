# Device Simulator + Loopback TCP Dial Transport — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the real harness-device firmware UI + protocol in an SDL2 window on macOS, connected to a real local daemon over an opt-in loopback TCP "dial", so the full agent loop can be exercised without hardware.

**Architecture:** Host: a `TcpDialListener` (Node `net`, 127.0.0.1 only) produces `DialPort`s/`CablePort`s that plug into the existing `CableFleet` seams; a tiny `CablePort.activate()` hook in `CableSession` removes the open/decoder race. Simulator: a CMake host build that compiles the real firmware sources (incl. `app_main.c`) against ESP-IDF/FreeRTOS shims on pthreads, replacing only drivers (display, touch, link, audio capture, buttons, board) with host implementations; a headless front renders PNGs from scripted scenarios, an SDL2 front gives an interactive window.

**Tech Stack:** TypeScript (NodeNext ESM, vitest 4), C11/gnu11 + pthreads, CMake ≥ 3.16, SDL2 (Homebrew), cJSON (from `$IDF_PATH` or FetchContent), stb_image_write (FetchContent, pinned), macOS `say`.

**Spec:** `docs/superpowers/specs/2026-09-29-device-sim-design.md` (r3). Read it before starting; section refs below (§x.y) point there.

**Status:** reviewed — two independent Codex rounds on the spec, two on this plan; all findings applied. Execution happens in a separate session: start it in this repo on branch `feat/device-sim`, read the spec and this plan, and choose subagent-driven (recommended: 12 tasks with tight cross-task interfaces, each worth its own reviewer gate) or inline execution. `docs/superpowers/` is git-excluded and local to this checkout — back it up if the checkout may be deleted.

Paths: `F/` = `devices/harness-device/firmware/main/`, `C/` = `cli/src/cable/`, `S/` = `devices/harness-device/sim/`.

## Global Constraints

- Branch `feat/device-sim`. `docs/superpowers/` is git-excluded — never `git add` it.
- **No edits to any file under `devices/harness-device/firmware/`.** If something cannot compile on the host, fix it with a shim. The only exception is a pure portability fix neutral on device; record each in `S/README.md` under "Firmware edits" (target: none).
- Without `HARNESS_DIAL_TCP`, daemon behaviour is unchanged: the `CableFleet` options object is exactly today's.
- TCP listener binds `127.0.0.1` only; default port `18474`; `HARNESS_DIAL_TCP`: unset/empty/`0`/`false` → off; `1`/`true` → 18474; integer 1024–65535 → that port; anything else → off + one log line. `CABLE_DISABLE` also disables it.
- Simulator reports `hello.hw = "sim"`, fw version `sim-<git short sha>`.
- Device-side TCP write budgets: 100 ms ordinary frames, 5 ms log frames; a partially written frame closes the connection.
- Keys: `B` BOOT (fires on press; hold ≥ 800 ms also toggles screen), `P` PWR (screen toggle), `V` voice (down → `ui_voice_start()`, up → `ui_voice_stop()`), `S` screenshot, `Q` quit. Key poll cadence 100 ms.
- Voice PCM: 16 kHz, 16-bit mono, paced at real time; after source end return zero-valued PCM, never a zero-length read.
- Headless mode: real time, settle heuristic (all shim tasks parked + no present for `--settle-ms`, default 150; timeout `--settle-timeout`, default 5000), ephemeral NVS from `S/fixtures/nvs-defaults.json`.
- CLI bar for every change under `cli/`: `cd cli && npm run typecheck && npm test`.
- Relative TS imports end in `.js`; Node builtins use `node:` prefix; no new runtime deps in `cli/`.
- Commit style: `feat(device): …`, `test(device): …`, `feat(cable): …`. End commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Simulator started before the daemon, or daemon restarted mid-session** → sim keeps showing the firmware's own "not connected" state, retries every 2 s, reattaches without restart. Pinned in Task 9 (`test_link`: no daemon → ticks, daemon appears → attach, drop → reconnect).
2. **Two simulators with different `--profile` at once** → two independent sessions, each with its own MAC/NVS; neither's settings leak into the other. Pinned in Task 4 (two clients) and Task 7 (`test_mac`: two fresh profiles differ, a profile keeps its MAC).
3. **USB dial plugged in while TCP is enabled and macOS USB enumeration throws** → the live USB session is not stopped/reopened; TCP sims still attach. Pinned in Task 3.
4. **Window resized / Retina `--scale 2` / mouse released outside the window or focus lost mid-drag** → no stuck contact; next tap works. Pinned in Task 7 (`test_touch` cancel-mid-drag case) and Task 10 (manual check).
5. **Voice held longer than the WAV, or `say` unavailable** → silence padding, no capture abort; missing `say` is a clear startup error, sim falls back to the default fixture. Pinned in Task 11 (`test_audio`: malformed WAVs keep the previous clip; paced silence after the clip).

---

## File Structure

Host (`cli/`):
- Modify `C/cableSession.ts` — `CablePort.activate?()` + call site.
- Create `C/tcpDial.ts` — `TcpDialListener`, `TcpPort`, `parseDialTcp`, `combinedDiscover`, `routedOpen`, `DIAL_TCP_DEFAULT_PORT`.
- Modify `C/cableFleet.ts` — log prefix/log-dir name `tcp` for `tcp://` paths.
- Modify `cli/src/cli.ts` — wiring + shutdown.
- Tests: `C/cableSession.spec.ts` (+1 case), `C/tcpDial.spec.ts`, `C/tcpDial.fleet.spec.ts`, `C/fwPush.spec.ts` (+1 case).

Simulator (`S/`):
- `CMakeLists.txt` — targets `simfw` (static lib: firmware + shims + core), `harness-sim`, C tests.
- `shims/include/**` — ESP-IDF/FreeRTOS headers; `shims/rtos.c`, `shims/esp.c`, `shims/nvs.c`.
- `core/sim.h` — options, front contract, cross-module hooks.
- `core/display_core.c` — `F/ui/display.h` + display-side `runtime.h` + render task.
- `core/touch_core.c` — `F/ui/touch.h` + pointer state machine.
- `core/input_keys.c` — `ptt_start()` + key state.
- `core/link_sim.c` — `F/cable_link.h` over an fd (socketpair or TCP); fd owned by `tx_lock`.
- `core/link_tcp.c` — live connect/reconnect to the daemon (Task 9).
- `core/settle.c` — the settle heuristic used by scripts.
- `core/audio_sim.c` — `F/audio_capture.h` incl. `audio_notify_*`.
- `core/stubs.c` — board, power, fw_update, last_words, device_mac.
- `core/script.c` — headless scenario runner (Task 7; used by Task 8's generated scenarios).
- `core/image.c` — PNG writing + pixel stats.
- `front/headless.c`, `front/sdl.c` — the two fronts (exactly one is compiled in, by `SIM_HAS_SDL`).
- `sim_main.c` — args, boot, front selection.
- `test/*.c` — C unit tests (`test_rtos`, `test_nvs`, `test_log`, `test_touch`, `test_mac`, `test_link`, `test_audio`); `test/scenarios/*.jsonl`; `test/run_scenarios.sh`.
- `tools/gen-scenarios.ts` — generates scenarios from the real `CableSession`.
- `fixtures/nvs-defaults.json`, `fixtures/voice-hello.wav`.
- `README.md`.
- Root `Makefile` — `device-sim`, `device-sim-run`, `device-sim-test`.

---

## Part A — Host

### Task 1: `CablePort.activate()` hook in `CableSession`

**Files:**
- Modify: `C/cableSession.ts:412-421` (interface), `C/cableSession.ts:~770` (end of `tryOpen`)
- Test: `C/cableSession.spec.ts`

**Interfaces:**
- Produces: `interface CablePort { …; activate?(): void }` — called exactly once by `CableSession` after the port becomes `this.link` and all per-open state is reset.

- [ ] **Step 1: Write the failing test** — append inside the top-level `describe` of `C/cableSession.spec.ts` (reuse `makeHost`, `tmpLog`, `LoopbackPort` already in the file):

```ts
  it('activates a port only after adopting it, so bytes it held are answered', async () => {
    const order: string[] = []
    let port!: LoopbackPort & { activate(): void }
    const session = new CableSession(makeHost(), tmpLog(), async (onData, onClosed) => {
      const p = new LoopbackPort(onData, onClosed) as LoopbackPort & { activate(): void }
      // Held bytes: a complete hello and the first half of a second frame, delivered on activate.
      const hello = Buffer.from(encodeCableFrame(CableType.Json, Buffer.from(JSON.stringify(
        { t: 'hello', product: 'harness', fw: '0.1.0', proto: 3, mac: 'aa:bb' }))))
      p.activate = () => { order.push('activate'); onData(hello) }
      port = p
      order.push('opened')
      return p
    })
    session.start()
    try {
      await vi.waitFor(() => expect(port?.types()).toContain('welcome'))
      expect(order).toEqual(['opened', 'activate'])
      expect(port.types().filter((t) => t === 'welcome')).toHaveLength(1)
    } finally { await session.stop() }
  })

  it('works with ports that have no activate()', async () => {
    const { session, port } = await connect()
    try {
      port.say({ t: 'hello', product: 'harness', fw: '0.1.0', proto: 3, mac: 'aa:bb' })
      await vi.waitFor(() => expect(port.types()).toContain('welcome'))
    } finally { await session.stop() }
  })
```

- [ ] **Step 2: Run to verify the first test fails**

Run: `cd cli && npx vitest run src/cable/cableSession.spec.ts -t "activates a port"`
Expected: FAIL (timeout waiting for `welcome`; `order` is `['opened']`).

- [ ] **Step 3: Implement** — in `C/cableSession.ts` extend the interface:

```ts
export interface CablePort {
  readonly path: string
  readonly isOpen: boolean
  write(bytes: Uint8Array): Promise<void>
  close(why?: string): Promise<void>
  /**
   * Called once, after the session has adopted this port as its link and reset its decoder. A port that
   * can hold inbound bytes (a socket accepted before anyone opened it) delivers them only from here, so a
   * greeting is never decoded before there is a link to answer on — nor wiped by the reset. USB ports
   * have nothing held and leave this out.
   */
  activate?(): void
}
```

and make the last two lines of `tryOpen()` (after `this.offered.clear()` / `this.lastRx = Date.now()`) read:

```ts
    this.lastRx = Date.now()
    this.log(`cable: open on ${opened.path}`)
    opened.activate?.()
  }
```

- [ ] **Step 4: Run tests**

Run: `cd cli && npx vitest run src/cable/cableSession.spec.ts`
Expected: all PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
cd cli && npm run typecheck && cd ..
git add cli/src/cable/cableSession.ts cli/src/cable/cableSession.spec.ts
git commit -m "feat(cable): let a port hold its first bytes until the session adopts it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `TcpDialListener` and `TcpPort`

**Files:**
- Create: `C/tcpDial.ts`
- Test: `C/tcpDial.spec.ts`

**Interfaces:**
- Consumes: `CablePort` (with `activate?`) from Task 1; `DialPort`, `DIAL_VENDOR_ID`, `DIAL_PRODUCT_ID` from `C/serial.ts`.
- Produces:
  - `export const DIAL_TCP_DEFAULT_PORT = 18474`
  - `export class TcpDialListener { static start(port: number, log: (line: string) => void, opts?: { unopenedTimeoutMs?: number }): TcpDialListener; readonly ready: Promise<number | undefined>; ports(): DialPort[]; open(path: string, onData: (chunk: Buffer) => void, onClosed: (why: string) => void): Promise<CablePort>; close(): Promise<void> }`
  - Paths look like `tcp://127.0.0.1:<remotePort>#<n>`, serials `SIM<n>`, `n` monotonic from 1.

- [ ] **Step 1: Write failing tests** — `C/tcpDial.spec.ts`:

```ts
import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CableDecoder, CableType, encodeCableFrame } from './cableFrame.js'
import { TcpDialListener } from './tcpDial.js'

const listeners: TcpDialListener[] = []
const sockets: Socket[] = []
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy()
  for (const l of listeners.splice(0)) await l.close()
})

async function listen(opts?: { unopenedTimeoutMs?: number }) {
  const log = vi.fn()
  const l = TcpDialListener.start(0, log, opts)
  listeners.push(l)
  const port = await l.ready
  expect(port).toBeGreaterThan(0)
  return { l, port: port!, log }
}
async function client(port: number): Promise<Socket> {
  const s = connect({ host: '127.0.0.1', port }); sockets.push(s)
  await new Promise<void>((r, j) => { s.once('connect', () => r()); s.once('error', j) })
  return s
}
const frame = (msg: object) => Buffer.from(encodeCableFrame(CableType.Json, Buffer.from(JSON.stringify(msg))))

describe('TcpDialListener', () => {
  it('binds loopback only', async () => {
    const { l } = await listen()
    expect((l as unknown as { server: { address(): { address: string } } }).server.address().address).toBe('127.0.0.1')
  })

  it('lists an accepted socket as a dial port and forgets it when the peer leaves', async () => {
    const { l, port } = await listen()
    const s = await client(port)
    await vi.waitFor(() => expect(l.ports()).toHaveLength(1))
    expect(l.ports()[0]).toMatchObject({ vendorId: 0x303a, productId: 0x1001, serialNumber: 'SIM1' })
    expect(l.ports()[0].path).toMatch(/^tcp:\/\/127\.0\.0\.1:\d+#1$/)
    // A paused socket reads nothing — not even the FIN — so a peer leaving is seen once the port is
    // active. Before that, the unopened timeout is what reaps it (tested separately below).
    const p = await l.open(l.ports()[0].path, () => {}, () => {})
    p.activate!()
    s.destroy()
    await vi.waitFor(() => expect(l.ports()).toHaveLength(0))
  })

  it('delivers nothing before activate, then everything, including a split frame', async () => {
    const { l, port } = await listen()
    const s = await client(port)
    const hello = frame({ t: 'hello', product: 'harness' })
    s.write(hello.subarray(0, 5)); s.write(hello.subarray(5))
    await vi.waitFor(() => expect(l.ports()).toHaveLength(1))
    const got: Buffer[] = []
    const p = await l.open(l.ports()[0].path, (c) => got.push(c), () => {})
    await new Promise((r) => setTimeout(r, 50))
    expect(got).toHaveLength(0)
    p.activate!()
    await vi.waitFor(() => expect(Buffer.concat(got).equals(hello)).toBe(true))
  })

  it('round-trips frames written by the daemon', async () => {
    const { l, port } = await listen()
    const s = await client(port)
    await vi.waitFor(() => expect(l.ports()).toHaveLength(1))
    const p = await l.open(l.ports()[0].path, () => {}, () => {})
    p.activate!()
    const seen: unknown[] = []
    const dec = new CableDecoder()
    s.on('data', (c) => dec.feed(c, (f) => seen.push(JSON.parse(Buffer.from(f.payload).toString()))))
    await p.write(frame({ t: 'welcome', proto: 3 }))
    await vi.waitFor(() => expect(seen).toEqual([{ t: 'welcome', proto: 3 }]))
  })

  it.each(['remote close', 'remote error', 'local close', 'local close twice'])('reports %s exactly once', async (how) => {
    const { l, port } = await listen()
    const s = await client(port)
    await vi.waitFor(() => expect(l.ports()).toHaveLength(1))
    const onClosed = vi.fn()
    const p = await l.open(l.ports()[0].path, () => {}, onClosed)
    p.activate!()
    if (how === 'remote close') s.end()
    if (how === 'remote error') s.resetAndDestroy()
    if (how === 'local close') await p.close('bye')
    if (how === 'local close twice') { await Promise.all([p.close('a'), p.close('b')]) }
    await vi.waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 50))
    expect(onClosed).toHaveBeenCalledTimes(1)
    expect(p.isOpen).toBe(false)
    expect(l.ports()).toHaveLength(0)
    await expect(p.write(new Uint8Array([1]))).rejects.toThrow('port closed')
  })

  it('rejects opening an unknown or already-opened path', async () => {
    const { l, port } = await listen()
    await client(port)
    await vi.waitFor(() => expect(l.ports()).toHaveLength(1))
    const path = l.ports()[0].path
    await l.open(path, () => {}, () => {})
    await expect(l.open(path, () => {}, () => {})).rejects.toThrow()
    await expect(l.open('tcp://127.0.0.1:1#99', () => {}, () => {})).rejects.toThrow()
  })

  it('drops a socket nobody opens', async () => {
    const { l, port } = await listen({ unopenedTimeoutMs: 100 })
    const s = await client(port)
    const closed = new Promise<void>((r) => s.once('close', () => r()))
    await closed
    expect(l.ports()).toHaveLength(0)
  })

  it('keeps one stalled peer from blocking another', async () => {
    const { l, port } = await listen()
    const stalled = await client(port); stalled.pause()
    const healthy = await client(port)
    await vi.waitFor(() => expect(l.ports()).toHaveLength(2))
    const [a, b] = l.ports()
    const pa = await l.open(a.path, () => {}, () => {}); pa.activate!()
    const pb = await l.open(b.path, () => {}, () => {}); pb.activate!()
    const big = new Uint8Array(8 * 1024 * 1024)
    void pa.write(big).catch(() => {})
    const got: Buffer[] = []
    healthy.on('data', (c) => got.push(c))
    await pb.write(frame({ t: 'ping' }))
    await vi.waitFor(() => expect(got.length).toBeGreaterThan(0))
  })

  it('logs and stays empty when the port is taken', async () => {
    const { port } = await listen()
    const log = vi.fn()
    const second = TcpDialListener.start(port, log); listeners.push(second)
    expect(await second.ready).toBeUndefined()
    expect(second.ports()).toEqual([])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('EADDRINUSE'))
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/cable/tcpDial.spec.ts`
Expected: FAIL — `Cannot find module './tcpDial.js'`.

- [ ] **Step 3: Implement** — `C/tcpDial.ts`:

```ts
// A dial on the other end of a loopback socket instead of a USB cable: the desktop simulator.
//
// Off unless HARNESS_DIAL_TCP asks for it, and bound to 127.0.0.1 only. Above the byte stream a socket is
// indistinguishable from the cable: the fleet discovers it, opens it, and a CableSession speaks the same
// frames over it. Nothing here widens who can reach the daemon — any local process can already talk to
// its loopback WebSocket — and nothing here listens on a network.
import { createServer, type Server, type Socket } from 'node:net'
import type { CablePort } from './cableSession.js'
import { DIAL_PRODUCT_ID, DIAL_VENDOR_ID, type DialPort } from './serial.js'

export const DIAL_TCP_DEFAULT_PORT = 18474
const UNOPENED_TIMEOUT_MS = 10_000

type OnData = (chunk: Buffer) => void
type OnClosed = (why: string) => void

interface Conn {
  id: number
  path: string
  socket: Socket
  port: TcpPort | null
  timer: ReturnType<typeof setTimeout>
}

/** One accepted socket, adopted by a session. Reads nothing until the session says it is ready. */
class TcpPort implements CablePort {
  private active = false
  private closePromise: Promise<void> | null = null
  private tail: Promise<void> = Promise.resolve()

  constructor(readonly path: string, private readonly socket: Socket, private readonly onData: OnData,
              private readonly onClosed: OnClosed, private readonly forget: () => void) {
    socket.on('close', () => void this.close('disconnected'))
    socket.on('error', (err: NodeJS.ErrnoException) => void this.close(err.code ?? err.message))
  }

  get isOpen(): boolean { return this.closePromise === null }

  activate(): void {
    if (this.active || !this.isOpen) return
    this.active = true
    this.socket.on('data', (chunk: Buffer) => this.onData(chunk))
    this.socket.resume()
  }

  /** Serialised like SerialLink.write, so two frames never interleave on the wire. */
  write(bytes: Uint8Array): Promise<void> {
    if (!this.isOpen) return Promise.reject(new Error('port closed'))
    const next = this.tail.then(() => new Promise<void>((resolve, reject) => {
      if (!this.isOpen) { reject(new Error('port closed')); return }
      this.socket.write(bytes, (err) => (err ? reject(err) : resolve()))
    }))
    this.tail = next.catch(() => {})
    return next
  }

  /** Idempotent: a remote close, an error and a local close all end here, and onClosed runs once. */
  close(why = 'closed'): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.forget()
    this.socket.destroy()
    this.closePromise = Promise.resolve().then(() => this.onClosed(why))
    return this.closePromise
  }
}

export class TcpDialListener {
  private readonly conns = new Map<string, Conn>()
  private next = 1
  readonly ready: Promise<number | undefined>

  private constructor(private readonly server: Server, private readonly log: (line: string) => void,
                      private readonly unopenedTimeoutMs: number, port: number) {
    server.on('connection', (socket) => this.accept(socket))
    this.ready = new Promise((resolve) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        this.log(`cable: tcp dial listener disabled: ${err.code ?? err.message}`)
        resolve(undefined)
      })
      server.listen({ host: '127.0.0.1', port }, () => {
        const address = server.address()
        const bound = typeof address === 'object' && address ? address.port : undefined
        this.log(`cable: tcp dial listening on 127.0.0.1:${bound}`)
        resolve(bound)
      })
    })
  }

  /** Never throws: a port in use is logged and leaves the daemon on USB alone. */
  static start(port: number, log: (line: string) => void,
               opts: { unopenedTimeoutMs?: number } = {}): TcpDialListener {
    return new TcpDialListener(createServer({ pauseOnConnect: true }), log,
      opts.unopenedTimeoutMs ?? UNOPENED_TIMEOUT_MS, port)
  }

  private accept(socket: Socket): void {
    const remote = socket.remoteAddress ?? ''
    if (remote !== '127.0.0.1' && remote !== '::ffff:127.0.0.1') { socket.destroy(); return }
    socket.setNoDelay(true)
    const id = this.next++
    const path = `tcp://127.0.0.1:${socket.remotePort}#${id}`
    const conn: Conn = { id, path, socket, port: null, timer: setTimeout(() => {
      if (!conn.port) { this.log(`cable: ${path} never opened — dropping it`); socket.destroy() }
    }, this.unopenedTimeoutMs) }
    conn.timer.unref()
    socket.on('close', () => { if (!conn.port) this.forget(conn) })
    socket.on('error', () => {})
    this.conns.set(path, conn)
  }

  private forget(conn: Conn): void {
    clearTimeout(conn.timer)
    this.conns.delete(conn.path)
  }

  ports(): DialPort[] {
    return [...this.conns.values()].map((c) => ({
      path: c.path, vendorId: DIAL_VENDOR_ID, productId: DIAL_PRODUCT_ID, serialNumber: `SIM${c.id}`,
    }))
  }

  async open(path: string, onData: OnData, onClosed: OnClosed): Promise<CablePort> {
    const conn = this.conns.get(path)
    if (!conn || conn.port || conn.socket.destroyed) throw new Error(`no tcp dial at ${path}`)
    clearTimeout(conn.timer)
    conn.port = new TcpPort(path, conn.socket, onData, onClosed, () => this.forget(conn))
    return conn.port
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.conns.values()].map((c) =>
      c.port ? c.port.close('daemon stopping') : Promise.resolve(c.socket.destroy())))
    this.conns.clear()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}
```

Note `createServer({ pauseOnConnect: true })`: sockets arrive paused, so TCP flow control buffers held bytes (§3.3).

- [ ] **Step 4: Run tests**

Run: `cd cli && npx vitest run src/cable/tcpDial.spec.ts`
Expected: all PASS. If `server.close` hangs in `afterEach` because of a live socket, confirm every test's sockets are in `sockets` (they are destroyed first).

- [ ] **Step 5: Typecheck + commit**

```bash
cd cli && npm run typecheck && cd ..
git add cli/src/cable/tcpDial.ts cli/src/cable/tcpDial.spec.ts
git commit -m "feat(cable): loopback TCP listener that presents sockets as dial ports

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Env parsing, combined discovery, routed open

**Files:**
- Modify: `C/tcpDial.ts` (append)
- Test: `C/tcpDial.spec.ts` (append)

**Interfaces:**
- Consumes: `TcpDialListener` (Task 2).
- Produces:
  - `export function parseDialTcp(raw: string | undefined, log: (line: string) => void): number | undefined`
  - `export type OpenPort = (path: string, onData: (chunk: Buffer) => void, onClosed: (why: string) => void) => Promise<CablePort>`
  - `export function combinedDiscover(usb: () => Promise<DialPort[]>, tcp: Pick<TcpDialListener, 'ports'>, log: (line: string) => void): () => Promise<DialPort[]>`
  - `export function routedOpen(serial: OpenPort, tcp: Pick<TcpDialListener, 'open'>): OpenPort`

- [ ] **Step 1: Write failing tests** — append to `C/tcpDial.spec.ts` (add `combinedDiscover, parseDialTcp, routedOpen` to the import from `./tcpDial.js` and `import type { DialPort } from './serial.js'`):

```ts
describe('parseDialTcp', () => {
  it.each([
    [undefined, undefined, false], ['', undefined, false], ['0', undefined, false], ['false', undefined, false],
    ['1', 18474, false], ['true', 18474, false], ['TRUE', 18474, false], ['20000', 20000, false],
    ['1023', undefined, true], ['65536', undefined, true], ['abc', undefined, true], ['12.5', undefined, true],
  ])('%s → %s', (raw, port, logs) => {
    const log = vi.fn()
    expect(parseDialTcp(raw, log)).toBe(port)
    expect(log).toHaveBeenCalledTimes(logs ? 1 : 0)
  })
})

describe('combinedDiscover', () => {
  const usbA: DialPort = { path: '/dev/a', vendorId: 0x303a, productId: 0x1001, serialNumber: 'AA' }
  const sim: DialPort = { path: 'tcp://127.0.0.1:5#1', vendorId: 0x303a, productId: 0x1001, serialNumber: 'SIM1' }

  it('adds tcp ports to usb ports', async () => {
    const discover = combinedDiscover(async () => [usbA], { ports: () => [sim] }, vi.fn())
    expect(await discover()).toEqual([usbA, sim])
  })

  it('keeps the last good usb list when enumeration throws, and still returns tcp ports', async () => {
    let fail = false
    const log = vi.fn()
    const discover = combinedDiscover(async () => { if (fail) throw new Error('ioreg died'); return [usbA] },
      { ports: () => [sim] }, log)
    expect(await discover()).toEqual([usbA, sim])
    fail = true
    expect(await discover()).toEqual([usbA, sim])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ioreg died'))
  })
})

describe('routedOpen', () => {
  it('sends tcp paths to the listener and everything else to serial', async () => {
    const serial = vi.fn(async () => ({ path: 's' }) as never)
    const tcp = { open: vi.fn(async () => ({ path: 't' }) as never) }
    const open = routedOpen(serial, tcp)
    await open('/dev/tty.usbmodem1', () => {}, () => {})
    await open('tcp://127.0.0.1:1#1', () => {}, () => {})
    expect(serial).toHaveBeenCalledTimes(1)
    expect(tcp.open).toHaveBeenCalledTimes(1)
  })
})
```

Also add a fleet-level test that proves a USB throw does not restart a live USB session — append to `C/tcpDial.spec.ts`:

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CableFleet } from './cableFleet.js'
import { CableSession, type CableHost } from './cableSession.js'
import { DialLog } from './dialLog.js'

describe('fleet with a flaky USB enumerator', () => {
  it('does not stop a live USB session when enumeration throws', async () => {
    const usb: DialPort = { path: '/dev/a', vendorId: 0x303a, productId: 0x1001, serialNumber: 'AA' }
    let fail = false
    const opened = vi.fn(async (path: string, _d: (c: Buffer) => void, onClosed: (w: string) => void) =>
      ({ path, isOpen: true, write: async () => {}, close: async (w = 'x') => onClosed(w) }))
    const host = { log: vi.fn(), onDialStatus: vi.fn(), onDialGone: vi.fn(), onDialAttached: vi.fn() } as unknown as CableHost
    const fleet = new CableFleet(CableSession, host, mkdtempSync(join(tmpdir(), 'tcpdial-')), DialLog, {
      intervalMs: 20,
      discover: combinedDiscover(async () => { if (fail) throw new Error('boom'); return [usb] }, { ports: () => [] }, vi.fn()),
      open: opened,
    })
    fleet.start()
    try {
      await vi.waitFor(() => expect(opened).toHaveBeenCalledTimes(1))
      fail = true
      await new Promise((r) => setTimeout(r, 120))
      expect(opened).toHaveBeenCalledTimes(1)
    } finally { await fleet.stop() }
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/cable/tcpDial.spec.ts`
Expected: FAIL — `parseDialTcp` / `combinedDiscover` / `routedOpen` not exported.

- [ ] **Step 3: Implement** — append to `C/tcpDial.ts`:

```ts
export type OpenPort = (path: string, onData: OnData, onClosed: OnClosed) => Promise<CablePort>

/** HARNESS_DIAL_TCP → a port, or undefined for off. A value that is neither is off, and said so once. */
export function parseDialTcp(raw: string | undefined, log: (line: string) => void): number | undefined {
  const value = raw?.trim().toLowerCase() ?? ''
  if (value === '' || value === '0' || value === 'false') return undefined
  if (value === '1' || value === 'true') return DIAL_TCP_DEFAULT_PORT
  const port = /^\d+$/.test(value) ? Number(value) : NaN
  if (port >= 1024 && port <= 65535) return port
  log(`cable: HARNESS_DIAL_TCP=${raw} is not 1, true or a port in 1024-65535 — tcp dial stays off`)
  return undefined
}

/**
 * USB ports plus tcp ports. A USB enumeration that throws must not take the simulators down with it, and
 * must not make the fleet think a live USB dial was unplugged — so the last list that worked stands in.
 */
export function combinedDiscover(usb: () => Promise<DialPort[]>, tcp: Pick<TcpDialListener, 'ports'>,
                                 log: (line: string) => void): () => Promise<DialPort[]> {
  let lastUsb: DialPort[] = []
  return async () => {
    try { lastUsb = await usb() } catch (err) { log(`cable: USB discovery failed: ${String(err)} — keeping the last list`) }
    return [...lastUsb, ...tcp.ports()]
  }
}

export function routedOpen(serial: OpenPort, tcp: Pick<TcpDialListener, 'open'>): OpenPort {
  return (path, onData, onClosed) =>
    path.startsWith('tcp://') ? tcp.open(path, onData, onClosed) : serial(path, onData, onClosed)
}
```

- [ ] **Step 4: Run tests** — `cd cli && npx vitest run src/cable/tcpDial.spec.ts` → all PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
cd cli && npm run typecheck && cd ..
git add cli/src/cable/tcpDial.ts cli/src/cable/tcpDial.spec.ts
git commit -m "feat(cable): opt-in env switch and discovery that survives a failing USB scan

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Wire into the daemon; fleet naming; end-to-end fleet tests

**Files:**
- Modify: `cli/src/cli.ts:320-325` (module ref), `cli/src/cli.ts:6596-6600` (shutdown), `cli/src/cli.ts:6797-6799` (construction), imports near `cli/src/cli.ts:42-47`
- Modify: `C/cableFleet.ts` (log prefix + log dir name)
- Test: `C/tcpDial.fleet.spec.ts` (new), `C/fwPush.spec.ts` (+1 case)

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: daemon env `HARNESS_DIAL_TCP`; fleet logs `[tcp SIMn]` and log dir `tcp-SIMn` for tcp dials.

- [ ] **Step 1: Write the failing end-to-end fleet test** — `C/tcpDial.fleet.spec.ts`:

```ts
import { mkdtempSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CableFleet } from './cableFleet.js'
import { CableDecoder, CableType, encodeCableFrame } from './cableFrame.js'
import { CableSession, type CableHost } from './cableSession.js'
import { DialLog } from './dialLog.js'
import { combinedDiscover, routedOpen, TcpDialListener } from './tcpDial.js'

function host(): CableHost {
  return {
    localMachine: () => ({ id: 'local', name: 'Fixture' }),
    listMachines: async () => ({ machines: [], source: 'backend' }),
    selectedMachine: () => 'local', selectMachine: async () => ({ ok: true }),
    listSwarms: () => ({ selected: 'tab', swarms: [], tiles: [] }), listUnread: () => [],
    selectSwarm: vi.fn(), appName: () => 'harness', voiceLang: () => 'en',
    listAgents: async () => [{ id: 'a', name: 'A', engine: 'codex' }], agentTotal: () => 1,
    activeSwarm: () => 'tab', describe: () => ({ name: 'A', engine: 'codex', machine: 'local' }),
    sendTurn: vi.fn(), stopTurn: vi.fn(), scrolled: vi.fn(), answer: vi.fn(), focus: vi.fn(),
    openAgent: vi.fn(), forkAgent: async () => ({ ok: true, agentId: 'fork' }), updateAgent: vi.fn(),
    listModels: async () => [], recentSummaries: async () => [],
    transcribe: vi.fn(async () => 'hello'),
    route: async () => ({ agentId: 'a', confidence: 1, reason: 'fixture' }), log: vi.fn(),
    onDialAttached: vi.fn(), onDialGone: vi.fn(), onDialStatus: vi.fn(),
  } as CableHost
}

class Sim {
  readonly got: Record<string, unknown>[] = []
  private dec = new CableDecoder()
  constructor(readonly socket: Socket) {
    socket.on('data', (c) => this.dec.feed(c, (f) => {
      if (f.type === CableType.Json) this.got.push(JSON.parse(Buffer.from(f.payload).toString()))
    }))
  }
  static async open(port: number): Promise<Sim> {
    const s = connect({ host: '127.0.0.1', port })
    await new Promise<void>((r, j) => { s.once('connect', () => r()); s.once('error', j) })
    return new Sim(s)
  }
  say(msg: object) { this.socket.write(encodeCableFrame(CableType.Json, Buffer.from(JSON.stringify(msg)))) }
  pcm() { this.socket.write(encodeCableFrame(CableType.Pcm, Buffer.alloc(3200, 7))) }
  hello(mac: string) { this.say({ t: 'hello', product: 'harness', fw: 'sim-test', proto: 3, mac, hw: 'sim' }) }
  types() { return this.got.map((m) => m.t) }
}

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f() })

async function rig() {
  const h = host()
  const tcp = TcpDialListener.start(0, vi.fn())
  const port = (await tcp.ready)!
  const fleet = new CableFleet(CableSession, h, mkdtempSync(join(tmpdir(), 'tcpfleet-')), DialLog, {
    intervalMs: 25,
    discover: combinedDiscover(async () => [], tcp, vi.fn()),
    open: routedOpen(async () => { throw new Error('no usb in this test') }, tcp),
  })
  fleet.start()
  cleanup.push(() => tcp.close(), () => fleet.stop())
  return { h, tcp, port, fleet }
}

describe('a simulator over tcp, through the real fleet and session', () => {
  it('greets immediately on connect and gets welcome and the agent list without a second hello', async () => {
    const { port } = await rig()
    const sim = await Sim.open(port); cleanup.push(() => { sim.socket.destroy() })
    sim.hello('02:00:00:00:00:01')
    await vi.waitFor(() => expect(sim.types()).toContain('agents.end'))
    expect(sim.types().filter((t) => t === 'welcome')).toHaveLength(1)
  })

  it('stops the session and marks it unplugged when the socket goes', async () => {
    const { port, fleet } = await rig()
    const sim = await Sim.open(port)
    sim.hello('02:00:00:00:00:01')
    await vi.waitFor(() => expect(fleet.devices().some((d) => d.attached)).toBe(true))
    sim.socket.destroy()
    await vi.waitFor(() => expect(fleet.devices().some((d) => d.attached)).toBe(false))
  })

  it('runs two simulators as two independent devices', async () => {
    const { port, fleet } = await rig()
    const a = await Sim.open(port); const b = await Sim.open(port)
    cleanup.push(() => { a.socket.destroy(); b.socket.destroy() })
    a.hello('02:00:00:00:00:0a'); b.hello('02:00:00:00:00:0b')
    await vi.waitFor(() => expect(fleet.devices().filter((d) => d.attached)).toHaveLength(2))
    expect(new Set(fleet.devices().map((d) => d.id))).toEqual(new Set(['SIM1', 'SIM2']))
  })

  it('gives a reconnect a new, connection-scoped id', async () => {
    const { port, fleet } = await rig()
    const first = await Sim.open(port); first.hello('02:00:00:00:00:01')
    await vi.waitFor(() => expect(fleet.devices().find((d) => d.attached)?.id).toBe('SIM1'))
    first.socket.destroy()
    const again = await Sim.open(port); cleanup.push(() => { again.socket.destroy() })
    again.hello('02:00:00:00:00:01')
    await vi.waitFor(() => expect(fleet.devices().find((d) => d.attached)?.id).toBe('SIM2'))
  })

  it('discards a voice turn cut off mid-stream without transcribing it', async () => {
    const { port, h } = await rig()
    const sim = await Sim.open(port)
    sim.hello('02:00:00:00:00:01')
    await vi.waitFor(() => expect(sim.types()).toContain('agents.end'))
    sim.say({ t: 'voice.begin', uploadId: 'cut', agentId: 'a' }); sim.pcm(); sim.pcm()
    await new Promise((r) => setTimeout(r, 50))
    sim.socket.destroy()
    await new Promise((r) => setTimeout(r, 200))
    expect(h.transcribe).not.toHaveBeenCalled()
  })

  it('reconnects cleanly after dropping mid-frame', async () => {
    const { port } = await rig()
    const first = await Sim.open(port)
    const frame = encodeCableFrame(CableType.Json, Buffer.from(JSON.stringify({ t: 'hello', product: 'harness', mac: 'x' })))
    first.socket.write(frame.subarray(0, 7)); first.socket.destroy()
    const again = await Sim.open(port); cleanup.push(() => { again.socket.destroy() })
    again.hello('02:00:00:00:00:02')
    await vi.waitFor(() => expect(again.types()).toContain('welcome'))
  })
})
```

- [ ] **Step 2: Run it** — `cd cli && npx vitest run src/cable/tcpDial.fleet.spec.ts`. Expected: PASS for the behaviour already built in Tasks 1-3 **except** nothing (this suite proves integration). If any case fails, fix the transport, not the test. Then add the naming assertion that must fail now — append to the same `describe`:

```ts
  it('labels tcp dials as tcp in logs', async () => {
    const { port, h } = await rig()
    const sim = await Sim.open(port); cleanup.push(() => { sim.socket.destroy() })
    sim.hello('02:00:00:00:00:01')
    await vi.waitFor(() => expect(sim.types()).toContain('welcome'))
    const lines = (h.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]))
    expect(lines.some((l) => l.endsWith('[tcp SIM1]'))).toBe(true)
    expect(lines.some((l) => l.includes('[usb SIM1]'))).toBe(false)
  })
```

Run again. Expected: the new case FAILS (`[usb SIM1]`).

- [ ] **Step 3: Implement fleet naming** — in `C/cableFleet.ts` inside `reconcile()` for-loop, before the `Proxy`:

```ts
      const kind = port.path.startsWith('tcp://') ? 'tcp' : 'usb'
```

change the log line and log dir:

```ts
          if (key === 'log') return (line: string) => this.host.log(`${line} [${kind} ${id}]`)
```

```ts
        entry.session = new this.Session(host, new this.Log(join(this.logs, `${kind}-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`)), opener)
```

- [ ] **Step 4: `otaKeyForBoard('sim')` test** — append to `C/fwPush.spec.ts` inside its top `describe`:

```ts
  it('offers no firmware to the simulator', () => {
    expect(otaKeyForBoard('sim')).toBeNull()
  })
```

(Import `otaKeyForBoard` if the file does not already.) Run: `cd cli && npx vitest run src/cable/fwPush.spec.ts src/cable/tcpDial.fleet.spec.ts src/cable/cableFleet.spec.ts` → all PASS.

- [ ] **Step 5: Wire `cli.ts`** — imports (next to the other `./cable/` imports):

```ts
import { findDialPorts, SerialLink } from './cable/serial.js'
import { combinedDiscover, parseDialTcp, routedOpen, TcpDialListener } from './cable/tcpDial.js'
```

(If `findDialPorts`/`SerialLink` are already imported, reuse them.) Module scope, after `let cableRef`:

```ts
/** The simulator's loopback listener, when HARNESS_DIAL_TCP asked for one. Closed with the cable on shutdown. */
let dialTcpRef: TcpDialListener | null = null
```

Shutdown, right after `void cableRef?.stop()`:

```ts
    void dialTcpRef?.close()
```

Construction — replace the `new CableFleet(...)` statement:

```ts
  const cableLog = (line: string) => console.log(`[cable] ${line}`)
  const dialTcpPort = env.CABLE_DISABLE ? undefined : parseDialTcp(process.env.HARNESS_DIAL_TCP, cableLog)
  const dialTcp = dialTcpPort ? TcpDialListener.start(dialTcpPort, cableLog) : null
  dialTcpRef = dialTcp
  const cable = new CableFleet(CableSession, cableHost, env.HARNESS_LOGS_DIR, DialLog, {
    serials: process.env.HARNESS_DIAL_SERIALS?.split(',').map(s => s.trim()).filter(Boolean),
    ...(dialTcp ? {
      discover: combinedDiscover(findDialPorts, dialTcp, cableLog),
      open: routedOpen(SerialLink.open, dialTcp),
    } : {}),
  })
```

If `env.CABLE_DISABLE` is not in scope at that line, read it the same way line ~6927 does.

- [ ] **Step 6: Full CLI bar**

Run: `cd cli && npm run typecheck && npm test`
Expected: typecheck clean; all suites PASS (pre-existing flaky suites, if any, fail identically on `main` — verify with `git stash` before blaming this change).

- [ ] **Step 7: Manual smoke with a raw client** — terminal 1: `cd cli && HARNESS_DIAL_TCP=1 npm run dev` (or however the daemon is normally started, see `docs/development.md`). Terminal 2:

```bash
node -e '
const net=require("net");const s=net.connect(18474,"127.0.0.1",()=>{
 const p=Buffer.from(JSON.stringify({t:"hello",product:"harness",fw:"manual",proto:3,mac:"02:00:00:00:00:99",hw:"sim"}));
 const f=Buffer.alloc(8+p.length);f[0]=0xa5;f[1]=0x48;f[2]=1;f[3]=1;f.writeUInt16LE(p.length,4);p.copy(f,6);
 let c=0xffff;for(const b of f.subarray(2,6+p.length)){c^=b<<8;for(let i=0;i<8;i++)c=c&0x8000?((c<<1)^0x1021)&0xffff:(c<<1)&0xffff}
 f.writeUInt16LE(c,6+p.length);s.write(f)});s.on("data",d=>{console.log(d.length,"bytes");});setTimeout(()=>s.end(),3000)'
```

Expected: daemon logs `cable: tcp dial listening on 127.0.0.1:18474`, `cable: open on tcp://…` and `cable: dial 02:00:00:00:00:99 on fw manual …[tcp SIM1]`; the client prints received byte counts. (Layout per `C/cableFrame.ts` `encodeCableFrame`: CRC-16/CCITT-FALSE over bytes 2 … 6+len, i.e. version, type, length and payload — not the magic.) Without `HARNESS_DIAL_TCP`, `nc -z 127.0.0.1 18474` fails.

- [ ] **Step 8: Commit**

```bash
git add cli/src/cli.ts cli/src/cable/cableFleet.ts cli/src/cable/tcpDial.fleet.spec.ts cli/src/cable/fwPush.spec.ts
git commit -m "feat(cable): HARNESS_DIAL_TCP attaches loopback simulators to the dial fleet

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Part B — Simulator

All C in `S/` is `-std=gnu11`. Sim-owned sources compile with `-Wall -Wextra -Werror`; firmware sources with `-Wall -Wno-format-truncation` (no `-Werror`: upstream warnings must not break the canary build; they are printed).

### Task 5: Build skeleton + FreeRTOS shims on pthreads

**Files:**
- Create: `S/CMakeLists.txt`, `S/shims/include/freertos/{FreeRTOS.h,task.h,semphr.h,queue.h,portmacro.h}`, `S/shims/rtos.c`, `S/shims/rtos_sim.h`, `S/test/test_rtos.c`

**Interfaces:**
- Produces (C, `S/shims/rtos_sim.h`):
  - `void sim_rtos_mark_untracked(void);` — current task is excluded from settle tracking.
  - `bool sim_rtos_all_parked(void);` — every tracked live task is inside a shim wait.
  - `TaskHandle_t sim_rtos_spawn(TaskFunction_t fn, const char *name, void *arg, bool tracked);`
  - `void sim_rtos_park_begin(void); void sim_rtos_park_end(void);` — bracket any blocking host call (e.g. `poll()` in the link) so a task waiting on I/O counts as parked.
- FreeRTOS API subset per spec §4.3 with real semantics, including `pcTaskGetName(NULL)` (used by `F/ram_telemetry.c:124`).

- [ ] **Step 1: Write the failing C test** — `S/test/test_rtos.c`:

```c
#include <assert.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "rtos_sim.h"

static SemaphoreHandle_t bin, gate;
static TaskHandle_t waiter;
static atomic_int notified = -1;

/* Both notifications are given while the waiter is held at the gate, so the count it takes is 2 under any
 * scheduling — no reliance on the waiter staying asleep between two gives. */
static void notify_waiter(void *arg) {
    (void)arg;
    xSemaphoreTake(gate, portMAX_DELAY);
    atomic_store(&notified, (int)ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(1000)));
    xSemaphoreGive(bin);
    vTaskDelete(NULL);
}

static void wait_all_parked(void) {
    for (int i = 0; i < 1000 && !sim_rtos_all_parked(); i++) vTaskDelay(1);
    assert(sim_rtos_all_parked());
}

static void test_notify_and_binary(void) {
    bin = xSemaphoreCreateBinary();
    gate = xSemaphoreCreateBinary();
    assert(xTaskCreate(notify_waiter, "waiter", 4096, NULL, 4, &waiter) == pdPASS);
    wait_all_parked();                       /* waiter is inside xSemaphoreTake(gate) */
    xTaskNotifyGive(waiter);
    xTaskNotifyGive(waiter);
    xSemaphoreGive(gate);
    assert(xSemaphoreTake(bin, pdMS_TO_TICKS(1000)) == pdTRUE);
    assert(atomic_load(&notified) == 2);     /* pdTRUE clears the whole count */
    assert(xSemaphoreTake(bin, 0) == pdFALSE);
    vSemaphoreDelete(bin); vSemaphoreDelete(gate);
}

static atomic_bool in_io, io_release;
static void io_task(void *arg) {
    (void)arg;
    sim_rtos_park_begin();
    atomic_store(&in_io, true);
    while (!atomic_load(&io_release)) usleep(1000);   /* stands in for a blocking poll() */
    sim_rtos_park_end();
    for (;;) { }                                      /* busy: never parked again */
}
static void test_park_bracket(void) {
    xTaskCreate(io_task, "io", 4096, NULL, 1, NULL);
    while (!atomic_load(&in_io)) usleep(1000);
    assert(sim_rtos_all_parked());
    atomic_store(&io_release, true);
    usleep(20000);
    assert(!sim_rtos_all_parked());
}

static void test_recursive_mutex(void) {
    SemaphoreHandle_t m = xSemaphoreCreateRecursiveMutex();
    assert(xSemaphoreTakeRecursive(m, portMAX_DELAY) == pdTRUE);
    assert(xSemaphoreTakeRecursive(m, portMAX_DELAY) == pdTRUE);
    assert(xSemaphoreGetMutexHolder(m) == xTaskGetCurrentTaskHandle());
    assert(xSemaphoreGiveRecursive(m) == pdTRUE);
    assert(xSemaphoreGiveRecursive(m) == pdTRUE);
    assert(xSemaphoreGetMutexHolder(m) == NULL);
    vSemaphoreDelete(m);
}

static void test_queue(void) {
    QueueHandle_t q = xQueueCreate(2, sizeof(int));
    int v = 1;
    assert(uxQueueSpacesAvailable(q) == 2);
    assert(xQueueSend(q, &v, 0) == pdTRUE); v = 2;
    assert(xQueueSend(q, &v, 0) == pdTRUE); v = 3;
    assert(xQueueSend(q, &v, pdMS_TO_TICKS(10)) == errQUEUE_FULL);
    assert(uxQueueSpacesAvailable(q) == 0);
    int out = 0;
    assert(xQueueReceive(q, &out, 0) == pdTRUE && out == 1);
    assert(xQueueReceive(q, &out, 0) == pdTRUE && out == 2);
    assert(xQueueReceive(q, &out, pdMS_TO_TICKS(10)) == pdFALSE);
    vQueueDelete(q);
}

static portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
static int shared;
static void bump(void *arg) {
    (void)arg;
    for (int i = 0; i < 100000; i++) { portENTER_CRITICAL(&mux); shared++; portEXIT_CRITICAL(&mux); }
    xTaskNotifyGive((TaskHandle_t)arg);
    vTaskDelete(NULL);
}
static void test_critical(void) {
    TaskHandle_t me = xTaskGetCurrentTaskHandle();
    xTaskCreate(bump, "b1", 4096, me, 1, NULL);
    xTaskCreate(bump, "b2", 4096, me, 1, NULL);
    ulTaskNotifyTake(pdFALSE, portMAX_DELAY);
    ulTaskNotifyTake(pdFALSE, portMAX_DELAY);
    assert(shared == 200000);
}

static void test_get_handle(void) {
    assert(xTaskGetHandle("main_test") == xTaskGetCurrentTaskHandle());
    assert(strcmp(pcTaskGetName(NULL), "main_test") == 0);
}

static void main_task(void *arg) {
    (void)arg;
    sim_rtos_mark_untracked();
    test_notify_and_binary();
    test_recursive_mutex();
    test_queue();
    test_critical();
    test_get_handle();
    test_park_bracket();                     /* last: leaves a busy task behind */
    puts("test_rtos: ok");
    exit(0);
}

int main(void) {
    sim_rtos_spawn(main_task, "main_test", NULL, false);
    for (;;) pause();
}
```

- [ ] **Step 2: Write `S/CMakeLists.txt` (skeleton, grows in later tasks)**:

```cmake
cmake_minimum_required(VERSION 3.16)
project(harness_sim C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_EXTENSIONS ON)          # gnu11: pthreads, clock_gettime, strdup
set(FW ${CMAKE_CURRENT_LIST_DIR}/../firmware/main)
set(SIM ${CMAKE_CURRENT_LIST_DIR})
find_package(Threads REQUIRED)
enable_testing()

set(SIM_WARN -Wall -Wextra -Werror)
set(FW_WARN -Wall -Wno-format-truncation -Wno-unused-parameter)

# ── shims ─────────────────────────────────────────────────────────────────
add_library(simshims STATIC ${SIM}/shims/rtos.c)
target_include_directories(simshims PUBLIC ${SIM}/shims/include ${SIM}/shims)
target_compile_options(simshims PRIVATE ${SIM_WARN})
target_link_libraries(simshims PUBLIC Threads::Threads)

add_executable(test_rtos ${SIM}/test/test_rtos.c)
target_link_libraries(test_rtos simshims)
add_test(NAME rtos COMMAND test_rtos)
```

- [ ] **Step 3: Run to verify failure**

Run: `cmake -S devices/harness-device/sim -B devices/harness-device/sim/build -G Ninja && ninja -C devices/harness-device/sim/build test_rtos`
Expected: FAIL — `freertos/FreeRTOS.h` not found.

- [ ] **Step 4: Implement headers.**

`S/shims/include/freertos/FreeRTOS.h`:

```c
// Host stand-in for the FreeRTOS subset the harness firmware uses. Real semantics on pthreads; see rtos.c.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

typedef long BaseType_t;
typedef unsigned long UBaseType_t;
typedef uint32_t TickType_t;
typedef void (*TaskFunction_t)(void *);
typedef struct sim_task *TaskHandle_t;
typedef struct sim_sem *SemaphoreHandle_t;
typedef struct sim_queue *QueueHandle_t;

#define pdTRUE  ((BaseType_t)1)
#define pdFALSE ((BaseType_t)0)
#define pdPASS  pdTRUE
#define pdFAIL  pdFALSE
#define errQUEUE_FULL ((BaseType_t)0)
#define portMAX_DELAY ((TickType_t)0xffffffffu)
#define configTICK_RATE_HZ 1000
#define portTICK_PERIOD_MS 1
#define pdMS_TO_TICKS(ms) ((TickType_t)(ms))
#define tskIDLE_PRIORITY 0
#define configMAX_PRIORITIES 25
#define portYIELD_FROM_ISR(x) ((void)(x))

#include "freertos/portmacro.h"
```

`S/shims/include/freertos/portmacro.h`:

```c
#pragma once
// Critical sections are one process-wide recursive mutex: real exclusion, no interrupts to mask.
typedef struct { int unused; } portMUX_TYPE;
#define portMUX_INITIALIZER_UNLOCKED {0}
void sim_critical_enter(void);
void sim_critical_exit(void);
#define portENTER_CRITICAL(m)     ((void)(m), sim_critical_enter())
#define portEXIT_CRITICAL(m)      ((void)(m), sim_critical_exit())
#define portENTER_CRITICAL_ISR(m) portENTER_CRITICAL(m)
#define portEXIT_CRITICAL_ISR(m)  portEXIT_CRITICAL(m)
#define taskENTER_CRITICAL(m)     portENTER_CRITICAL(m)
#define taskEXIT_CRITICAL(m)      portEXIT_CRITICAL(m)
static inline int xPortInIsrContext(void) { return 0; }
```

`S/shims/include/freertos/task.h`:

```c
#pragma once
#include "freertos/FreeRTOS.h"

BaseType_t xTaskCreate(TaskFunction_t fn, const char *name, uint32_t stack, void *arg,
                       UBaseType_t prio, TaskHandle_t *out);
BaseType_t xTaskCreatePinnedToCore(TaskFunction_t fn, const char *name, uint32_t stack, void *arg,
                                   UBaseType_t prio, TaskHandle_t *out, BaseType_t core);
void vTaskDelete(TaskHandle_t task);
void vTaskDelay(TickType_t ticks);
TaskHandle_t xTaskGetCurrentTaskHandle(void);
TaskHandle_t xTaskGetHandle(const char *name);
TickType_t xTaskGetTickCount(void);
UBaseType_t uxTaskGetStackHighWaterMark(TaskHandle_t task);
char *pcTaskGetName(TaskHandle_t task);   /* NULL = calling task */
BaseType_t xTaskNotifyGive(TaskHandle_t task);
void vTaskNotifyGiveFromISR(TaskHandle_t task, BaseType_t *woken);
uint32_t ulTaskNotifyTake(BaseType_t clear_on_exit, TickType_t ticks);
```

`S/shims/include/freertos/semphr.h`:

```c
#pragma once
#include "freertos/FreeRTOS.h"

SemaphoreHandle_t xSemaphoreCreateMutex(void);
SemaphoreHandle_t xSemaphoreCreateRecursiveMutex(void);
SemaphoreHandle_t xSemaphoreCreateBinary(void);
BaseType_t xSemaphoreTake(SemaphoreHandle_t s, TickType_t ticks);
BaseType_t xSemaphoreGive(SemaphoreHandle_t s);
BaseType_t xSemaphoreTakeRecursive(SemaphoreHandle_t s, TickType_t ticks);
BaseType_t xSemaphoreGiveRecursive(SemaphoreHandle_t s);
BaseType_t xSemaphoreGiveFromISR(SemaphoreHandle_t s, BaseType_t *woken);
TaskHandle_t xSemaphoreGetMutexHolder(SemaphoreHandle_t s);
void vSemaphoreDelete(SemaphoreHandle_t s);
```

`S/shims/include/freertos/queue.h`:

```c
#pragma once
#include "freertos/FreeRTOS.h"

QueueHandle_t xQueueCreate(UBaseType_t length, UBaseType_t item_size);
BaseType_t xQueueSend(QueueHandle_t q, const void *item, TickType_t ticks);
BaseType_t xQueueReceive(QueueHandle_t q, void *out, TickType_t ticks);
UBaseType_t uxQueueSpacesAvailable(QueueHandle_t q);
UBaseType_t uxQueueMessagesWaiting(QueueHandle_t q);
void vQueueDelete(QueueHandle_t q);
```

`S/shims/rtos_sim.h`:

```c
#pragma once
#include <stdbool.h>
#include "freertos/FreeRTOS.h"
// Simulator-only controls on top of the FreeRTOS shim.
void sim_rtos_mark_untracked(void);
bool sim_rtos_all_parked(void);
TaskHandle_t sim_rtos_spawn(TaskFunction_t fn, const char *name, void *arg, bool tracked);
/* Bracket a blocking host call (poll/read) so the calling task counts as parked while inside it. */
void sim_rtos_park_begin(void);
void sim_rtos_park_end(void);
```

- [ ] **Step 5: Implement `S/shims/rtos.c`**:

```c
// FreeRTOS on pthreads, for the simulator. Every wait goes through `park`, which is what lets the headless
// front ask "is everyone waiting?" (sim_rtos_all_parked) without touching firmware code.
#include <errno.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "rtos_sim.h"

struct sim_task {
    char name[32];
    pthread_t thread;
    TaskFunction_t fn;
    void *arg;
    pthread_mutex_t mu;
    pthread_cond_t cv;
    uint32_t notify;
    atomic_int parked;
    bool tracked;
    bool live;
    struct sim_task *next;
};

static pthread_mutex_t registry_mu = PTHREAD_MUTEX_INITIALIZER;
static struct sim_task *registry;
static _Thread_local struct sim_task *self;

static void die(const char *what) { fprintf(stderr, "rtos shim: %s\n", what); abort(); }

static void deadline_after(TickType_t ticks, struct timespec *ts) {
    struct timeval now; gettimeofday(&now, NULL);
    uint64_t ns = (uint64_t)now.tv_usec * 1000u + (uint64_t)ticks * 1000000u;
    ts->tv_sec = now.tv_sec + (time_t)(ns / 1000000000u);
    ts->tv_nsec = (long)(ns % 1000000000u);
}

/* Waits on cv until pred() or timeout. Returns true if pred() held. Caller holds mu. */
#define WAIT_UNTIL(cv, mu, ticks, pred)                                                             \
    ({                                                                                              \
        bool ok_ = (pred);                                                                          \
        if (!ok_ && (ticks) != 0) {                                                                 \
            struct sim_task *me_ = xTaskGetCurrentTaskHandle();                                     \
            atomic_fetch_add(&me_->parked, 1);                                                      \
            if ((ticks) == portMAX_DELAY) {                                                         \
                while (!(ok_ = (pred))) pthread_cond_wait((cv), (mu));                              \
            } else {                                                                                \
                struct timespec ts_; deadline_after((ticks), &ts_);                                 \
                while (!(ok_ = (pred))) if (pthread_cond_timedwait((cv), (mu), &ts_) == ETIMEDOUT) {\
                    ok_ = (pred); break; }                                                          \
            }                                                                                       \
            atomic_fetch_sub(&me_->parked, 1);                                                      \
        }                                                                                           \
        ok_;                                                                                        \
    })

static struct sim_task *task_new(const char *name, bool tracked) {
    struct sim_task *t = calloc(1, sizeof *t);
    if (!t) die("out of memory");
    snprintf(t->name, sizeof t->name, "%s", name ? name : "?");
    pthread_mutex_init(&t->mu, NULL);
    pthread_cond_init(&t->cv, NULL);
    t->tracked = tracked;
    t->live = true;
    pthread_mutex_lock(&registry_mu);
    t->next = registry; registry = t;
    pthread_mutex_unlock(&registry_mu);
    return t;
}

static void *trampoline(void *p) {
    self = p;
    self->fn(self->arg);
    vTaskDelete(NULL);   /* a FreeRTOS task must not return; treat it as self-delete */
    return NULL;
}

TaskHandle_t sim_rtos_spawn(TaskFunction_t fn, const char *name, void *arg, bool tracked) {
    struct sim_task *t = task_new(name, tracked);
    t->fn = fn; t->arg = arg;
    pthread_attr_t attr; pthread_attr_init(&attr);
    pthread_attr_setstacksize(&attr, 1u << 20);   /* host stacks are cheap; device sizes are not a limit here */
    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
    if (pthread_create(&t->thread, &attr, trampoline, t) != 0) die("pthread_create failed");
    pthread_attr_destroy(&attr);
    return t;
}

BaseType_t xTaskCreate(TaskFunction_t fn, const char *name, uint32_t stack, void *arg,
                       UBaseType_t prio, TaskHandle_t *out) {
    (void)stack; (void)prio;
    TaskHandle_t t = sim_rtos_spawn(fn, name, arg, true);
    if (out) *out = t;
    return pdPASS;
}

BaseType_t xTaskCreatePinnedToCore(TaskFunction_t fn, const char *name, uint32_t stack, void *arg,
                                   UBaseType_t prio, TaskHandle_t *out, BaseType_t core) {
    (void)core;
    return xTaskCreate(fn, name, stack, arg, prio, out);
}

void vTaskDelete(TaskHandle_t task) {
    if (task && task != xTaskGetCurrentTaskHandle()) die("vTaskDelete(other task) is not supported by the simulator");
    struct sim_task *me = xTaskGetCurrentTaskHandle();
    pthread_mutex_lock(&registry_mu); me->live = false; pthread_mutex_unlock(&registry_mu);
    pthread_exit(NULL);
}

TaskHandle_t xTaskGetCurrentTaskHandle(void) {
    if (!self) self = task_new("foreign", false);   /* a thread the shim did not start (SDL main, tests) */
    return self;
}

TaskHandle_t xTaskGetHandle(const char *name) {
    pthread_mutex_lock(&registry_mu);
    struct sim_task *t = registry;
    while (t && !(t->live && strcmp(t->name, name) == 0)) t = t->next;
    pthread_mutex_unlock(&registry_mu);
    return t;
}

TickType_t xTaskGetTickCount(void) {
    struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
    return (TickType_t)((uint64_t)ts.tv_sec * 1000u + (uint64_t)ts.tv_nsec / 1000000u);
}

UBaseType_t uxTaskGetStackHighWaterMark(TaskHandle_t task) { (void)task; return 4096; }

char *pcTaskGetName(TaskHandle_t task) { return (task ? task : xTaskGetCurrentTaskHandle())->name; }

void sim_rtos_park_begin(void) { atomic_fetch_add(&xTaskGetCurrentTaskHandle()->parked, 1); }
void sim_rtos_park_end(void) { atomic_fetch_sub(&xTaskGetCurrentTaskHandle()->parked, 1); }

void vTaskDelay(TickType_t ticks) {
    struct sim_task *me = xTaskGetCurrentTaskHandle();
    pthread_mutex_lock(&me->mu);
    (void)WAIT_UNTIL(&me->cv, &me->mu, ticks == 0 ? 1 : ticks, false);
    pthread_mutex_unlock(&me->mu);
}

BaseType_t xTaskNotifyGive(TaskHandle_t t) {
    pthread_mutex_lock(&t->mu); t->notify++; pthread_cond_broadcast(&t->cv); pthread_mutex_unlock(&t->mu);
    return pdPASS;
}

void vTaskNotifyGiveFromISR(TaskHandle_t t, BaseType_t *woken) {
    xTaskNotifyGive(t);
    if (woken) *woken = pdFALSE;
}

uint32_t ulTaskNotifyTake(BaseType_t clear_on_exit, TickType_t ticks) {
    struct sim_task *me = xTaskGetCurrentTaskHandle();
    pthread_mutex_lock(&me->mu);
    (void)WAIT_UNTIL(&me->cv, &me->mu, ticks, me->notify > 0);
    uint32_t value = me->notify;
    if (value) me->notify = clear_on_exit ? 0 : value - 1;
    pthread_mutex_unlock(&me->mu);
    return value;
}

bool sim_rtos_all_parked(void) {
    bool all = true;
    pthread_mutex_lock(&registry_mu);
    for (struct sim_task *t = registry; t; t = t->next)
        if (t->live && t->tracked && atomic_load(&t->parked) == 0) { all = false; break; }
    pthread_mutex_unlock(&registry_mu);
    return all;
}

void sim_rtos_mark_untracked(void) {
    struct sim_task *me = xTaskGetCurrentTaskHandle();
    pthread_mutex_lock(&registry_mu); me->tracked = false; pthread_mutex_unlock(&registry_mu);
}

/* ── semaphores ─────────────────────────────────────────────────────────── */

enum { SEM_BINARY, SEM_MUTEX, SEM_RECURSIVE };
struct sim_sem {
    int kind;
    pthread_mutex_t mu;
    pthread_cond_t cv;
    int count;             /* binary: 0/1; mutex: 1 = free */
    TaskHandle_t holder;
    int depth;
};

static SemaphoreHandle_t sem_new(int kind, int count) {
    struct sim_sem *s = calloc(1, sizeof *s);
    if (!s) die("out of memory");
    s->kind = kind; s->count = count;
    pthread_mutex_init(&s->mu, NULL); pthread_cond_init(&s->cv, NULL);
    return s;
}
SemaphoreHandle_t xSemaphoreCreateBinary(void) { return sem_new(SEM_BINARY, 0); }
SemaphoreHandle_t xSemaphoreCreateMutex(void) { return sem_new(SEM_MUTEX, 1); }
SemaphoreHandle_t xSemaphoreCreateRecursiveMutex(void) { return sem_new(SEM_RECURSIVE, 1); }

BaseType_t xSemaphoreTake(SemaphoreHandle_t s, TickType_t ticks) {
    if (s->kind == SEM_RECURSIVE) return xSemaphoreTakeRecursive(s, ticks);
    pthread_mutex_lock(&s->mu);
    bool ok = WAIT_UNTIL(&s->cv, &s->mu, ticks, s->count > 0);
    if (ok) { s->count = 0; if (s->kind == SEM_MUTEX) s->holder = xTaskGetCurrentTaskHandle(); }
    pthread_mutex_unlock(&s->mu);
    return ok ? pdTRUE : pdFALSE;
}

BaseType_t xSemaphoreGive(SemaphoreHandle_t s) {
    if (s->kind == SEM_RECURSIVE) return xSemaphoreGiveRecursive(s);
    pthread_mutex_lock(&s->mu);
    BaseType_t r = pdTRUE;
    if (s->kind == SEM_MUTEX) {
        if (s->holder != xTaskGetCurrentTaskHandle()) die("mutex given by a task that does not hold it");
        s->holder = NULL; s->count = 1;
    } else if (s->count) r = pdFALSE; else s->count = 1;
    pthread_cond_broadcast(&s->cv);
    pthread_mutex_unlock(&s->mu);
    return r;
}

BaseType_t xSemaphoreGiveFromISR(SemaphoreHandle_t s, BaseType_t *woken) {
    if (woken) *woken = pdFALSE;
    return xSemaphoreGive(s);
}

BaseType_t xSemaphoreTakeRecursive(SemaphoreHandle_t s, TickType_t ticks) {
    TaskHandle_t me = xTaskGetCurrentTaskHandle();
    pthread_mutex_lock(&s->mu);
    if (s->holder == me) { s->depth++; pthread_mutex_unlock(&s->mu); return pdTRUE; }
    bool ok = WAIT_UNTIL(&s->cv, &s->mu, ticks, s->holder == NULL);
    if (ok) { s->holder = me; s->depth = 1; }
    pthread_mutex_unlock(&s->mu);
    return ok ? pdTRUE : pdFALSE;
}

BaseType_t xSemaphoreGiveRecursive(SemaphoreHandle_t s) {
    pthread_mutex_lock(&s->mu);
    if (s->holder != xTaskGetCurrentTaskHandle()) die("recursive mutex given by a task that does not hold it");
    if (--s->depth == 0) { s->holder = NULL; pthread_cond_broadcast(&s->cv); }
    pthread_mutex_unlock(&s->mu);
    return pdTRUE;
}

TaskHandle_t xSemaphoreGetMutexHolder(SemaphoreHandle_t s) {
    pthread_mutex_lock(&s->mu); TaskHandle_t h = s->holder; pthread_mutex_unlock(&s->mu);
    return h;
}

void vSemaphoreDelete(SemaphoreHandle_t s) {
    if (!s) return;
    pthread_mutex_destroy(&s->mu); pthread_cond_destroy(&s->cv); free(s);
}

/* ── queues ─────────────────────────────────────────────────────────────── */

struct sim_queue {
    pthread_mutex_t mu;
    pthread_cond_t cv;
    size_t len, size, head, count;
    uint8_t *buf;
};

QueueHandle_t xQueueCreate(UBaseType_t length, UBaseType_t item_size) {
    struct sim_queue *q = calloc(1, sizeof *q);
    if (!q || !(q->buf = calloc(length, item_size))) die("out of memory");
    q->len = length; q->size = item_size;
    pthread_mutex_init(&q->mu, NULL); pthread_cond_init(&q->cv, NULL);
    return q;
}

BaseType_t xQueueSend(QueueHandle_t q, const void *item, TickType_t ticks) {
    pthread_mutex_lock(&q->mu);
    bool ok = WAIT_UNTIL(&q->cv, &q->mu, ticks, q->count < q->len);
    if (ok) {
        memcpy(q->buf + ((q->head + q->count) % q->len) * q->size, item, q->size);
        q->count++;
        pthread_cond_broadcast(&q->cv);
    }
    pthread_mutex_unlock(&q->mu);
    return ok ? pdTRUE : errQUEUE_FULL;
}

BaseType_t xQueueReceive(QueueHandle_t q, void *out, TickType_t ticks) {
    pthread_mutex_lock(&q->mu);
    bool ok = WAIT_UNTIL(&q->cv, &q->mu, ticks, q->count > 0);
    if (ok) {
        memcpy(out, q->buf + q->head * q->size, q->size);
        q->head = (q->head + 1) % q->len; q->count--;
        pthread_cond_broadcast(&q->cv);
    }
    pthread_mutex_unlock(&q->mu);
    return ok ? pdTRUE : pdFALSE;
}

UBaseType_t uxQueueSpacesAvailable(QueueHandle_t q) {
    pthread_mutex_lock(&q->mu); UBaseType_t n = q->len - q->count; pthread_mutex_unlock(&q->mu);
    return n;
}

UBaseType_t uxQueueMessagesWaiting(QueueHandle_t q) {
    pthread_mutex_lock(&q->mu); UBaseType_t n = q->count; pthread_mutex_unlock(&q->mu);
    return n;
}

void vQueueDelete(QueueHandle_t q) {
    if (!q) return;
    pthread_mutex_destroy(&q->mu); pthread_cond_destroy(&q->cv); free(q->buf); free(q);
}

/* ── critical sections ──────────────────────────────────────────────────── */

static pthread_mutex_t critical_mu;
static pthread_once_t critical_once = PTHREAD_ONCE_INIT;
static void critical_init(void) {
    pthread_mutexattr_t a; pthread_mutexattr_init(&a);
    pthread_mutexattr_settype(&a, PTHREAD_MUTEX_RECURSIVE);
    pthread_mutex_init(&critical_mu, &a);
}
void sim_critical_enter(void) { pthread_once(&critical_once, critical_init); pthread_mutex_lock(&critical_mu); }
void sim_critical_exit(void) { pthread_mutex_unlock(&critical_mu); }
```

Note: `WAIT_UNTIL` uses GNU statement expressions (fine under gnu11 with clang/gcc). The binary-semaphore `Give` when already given returns `pdFALSE`, like FreeRTOS.

- [ ] **Step 6: Run test**

Run: `cmake -S devices/harness-device/sim -B devices/harness-device/sim/build -G Ninja && ninja -C devices/harness-device/sim/build test_rtos && ctest --test-dir devices/harness-device/sim/build -R rtos --output-on-failure`
Expected: `test_rtos: ok`, ctest PASS.

- [ ] **Step 7: Commit** (add `S/build/` to `S/.gitignore` first)

```bash
printf 'build/\nsim-shots/\n' > devices/harness-device/sim/.gitignore
git add devices/harness-device/sim/.gitignore devices/harness-device/sim/CMakeLists.txt devices/harness-device/sim/shims devices/harness-device/sim/test/test_rtos.c
git commit -m "feat(device): FreeRTOS shim on pthreads for the desktop simulator

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: ESP-IDF shims (timer, log, err, heap, random, app desc, attr, gpio) + NVS

**Files:**
- Create: `S/shims/include/{esp_timer.h,esp_log.h,esp_err.h,esp_system.h,esp_attr.h,esp_heap_caps.h,esp_random.h,esp_app_desc.h,nvs.h,nvs_flash.h,driver/gpio.h}`, `S/shims/esp.c`, `S/shims/nvs.c`, `S/shims/esp_sim.h`, `S/test/test_nvs.c`, `S/test/test_log.c`
- Modify: `S/CMakeLists.txt`

**Interfaces:**
- Produces (`S/shims/esp_sim.h`):
  - `void sim_log_set_level(int level);` (0 none … 5 verbose; default 3 info)
  - `unsigned sim_log_error_count(void);`
  - `bool sim_log_contains(const char *needle);` — searches the last 512 formatted lines.
  - `void sim_app_set_version(const char *v);`
  - `void sim_nvs_configure(const char *persist_path_or_null, const char *defaults_path_or_null);` — must be called before `nvs_flash_init`.
- NVS API: `nvs_flash_init/erase`, `nvs_open/close/commit`, `nvs_get/set_u8`, `nvs_get/set_str`, `nvs_erase_key`, `nvs_erase_all`; missing key → `ESP_ERR_NVS_NOT_FOUND`.
- Log: `ESP_LOG{E,W,I,D,V}(tag, fmt, ...)` → formatted line through the current `vprintf` hook (`esp_log_set_vprintf`), exactly like IDF, so `cable_link` log framing works.

- [ ] **Step 1: Failing tests.** `S/test/test_nvs.c`:

```c
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "esp_sim.h"
#include "nvs.h"
#include "nvs_flash.h"

int main(void) {
    char path[] = "/tmp/simnvsXXXXXX";
    int fd = mkstemp(path); close(fd); unlink(path);

    /* profile A: persisted */
    sim_nvs_configure(path, NULL);
    assert(nvs_flash_init() == ESP_OK);
    nvs_handle_t h;
    assert(nvs_open("cfg", NVS_READWRITE, &h) == ESP_OK);
    uint8_t v = 7;
    assert(nvs_get_u8(h, "bright", &v) == ESP_ERR_NVS_NOT_FOUND && v == 7);
    assert(nvs_set_u8(h, "bright", 200) == ESP_OK);
    assert(nvs_set_str(h, "lang", "sv") == ESP_OK);
    assert(nvs_commit(h) == ESP_OK);
    nvs_close(h);

    /* reload from disk */
    sim_nvs_configure(path, NULL);
    assert(nvs_flash_init() == ESP_OK);
    assert(nvs_open("cfg", NVS_READONLY, &h) == ESP_OK);
    assert(nvs_get_u8(h, "bright", &v) == ESP_OK && v == 200);
    size_t len = 0;
    assert(nvs_get_str(h, "lang", NULL, &len) == ESP_OK && len == 3);
    char s[2];
    size_t small = sizeof s;
    assert(nvs_get_str(h, "lang", s, &small) == ESP_ERR_NVS_INVALID_LENGTH);
    char buf[8]; len = sizeof buf;
    assert(nvs_get_str(h, "lang", buf, &len) == ESP_OK && strcmp(buf, "sv") == 0);
    nvs_close(h);

    /* profile B: ephemeral with defaults — independent of A */
    char defs[] = "/tmp/simdefsXXXXXX";
    fd = mkstemp(defs);
    const char *json = "{\"cfg\":{\"bright\":{\"u8\":255}}}";
    assert(write(fd, json, strlen(json)) == (ssize_t)strlen(json)); close(fd);
    sim_nvs_configure(NULL, defs);
    assert(nvs_flash_init() == ESP_OK);
    assert(nvs_open("cfg", NVS_READWRITE, &h) == ESP_OK);
    assert(nvs_get_u8(h, "bright", &v) == ESP_OK && v == 255);
    len = sizeof buf;
    assert(nvs_get_str(h, "lang", buf, &len) == ESP_ERR_NVS_NOT_FOUND);
    assert(nvs_erase_all(h) == ESP_OK);
    assert(nvs_get_u8(h, "bright", &v) == ESP_ERR_NVS_NOT_FOUND);
    nvs_close(h);
    unlink(path); unlink(defs);
    puts("test_nvs: ok");
    return 0;
}
```

`S/test/test_log.c`:

```c
#include <assert.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include "esp_log.h"
#include "esp_sim.h"

static char captured[256];
static int hook(const char *fmt, va_list ap) { return vsnprintf(captured, sizeof captured, fmt, ap); }

int main(void) {
    ESP_LOGI("t", "hello %d", 42);
    assert(sim_log_contains("hello 42"));
    vprintf_like_t prev = esp_log_set_vprintf(hook);
    ESP_LOGW("tag", "via hook %s", "x");
    assert(strstr(captured, "W (") && strstr(captured, "tag: via hook x"));
    esp_log_set_vprintf(prev);
    assert(sim_log_error_count() == 0);
    ESP_LOGE("t", "bad");
    assert(sim_log_error_count() == 1);
    puts("test_log: ok");
    return 0;
}
```

Add to `S/CMakeLists.txt` (below `simshims`), and extend the shim library sources:

```cmake
# cJSON: the SDK's copy when present (same version the board links), else a pinned fetch.
if(DEFINED ENV{IDF_PATH} AND EXISTS "$ENV{IDF_PATH}/components/json/cJSON/cJSON.c")
    set(CJSON_DIR "$ENV{IDF_PATH}/components/json/cJSON")
else()
    include(FetchContent)
    FetchContent_Declare(cjson GIT_REPOSITORY https://github.com/DaveGamble/cJSON.git GIT_TAG v1.7.18)
    FetchContent_Populate(cjson)
    set(CJSON_DIR ${cjson_SOURCE_DIR})
endif()
add_library(simcjson STATIC ${CJSON_DIR}/cJSON.c)
target_include_directories(simcjson PUBLIC ${CJSON_DIR})
target_compile_options(simcjson PRIVATE -Wno-deprecated-declarations)

target_sources(simshims PRIVATE ${SIM}/shims/esp.c ${SIM}/shims/nvs.c)
target_link_libraries(simshims PUBLIC simcjson)

foreach(t nvs log)
    add_executable(test_${t} ${SIM}/test/test_${t}.c)
    target_link_libraries(test_${t} simshims)
    add_test(NAME ${t} COMMAND test_${t})
endforeach()
```

Run: `ninja -C devices/harness-device/sim/build` → FAIL (headers missing).

- [ ] **Step 2: Headers.**

`S/shims/include/esp_err.h`:

```c
#pragma once
#include <stdio.h>
#include <stdlib.h>
typedef int esp_err_t;
#define ESP_OK                0
#define ESP_FAIL             -1
#define ESP_ERR_NO_MEM        0x101
#define ESP_ERR_INVALID_ARG   0x102
#define ESP_ERR_INVALID_STATE 0x103
#define ESP_ERR_INVALID_SIZE  0x104
#define ESP_ERR_NOT_FOUND     0x105
#define ESP_ERR_NOT_SUPPORTED 0x106
#define ESP_ERR_TIMEOUT       0x107
#define ESP_ERR_NVS_BASE              0x1100
#define ESP_ERR_NVS_NOT_INITIALIZED   0x1101
#define ESP_ERR_NVS_NOT_FOUND         0x1102
#define ESP_ERR_NVS_INVALID_HANDLE    0x1107
#define ESP_ERR_NVS_INVALID_LENGTH    0x110c
#define ESP_ERR_NVS_NO_FREE_PAGES     0x110d
#define ESP_ERR_NVS_NEW_VERSION_FOUND 0x1110
const char *esp_err_to_name(esp_err_t err);
#define ESP_ERROR_CHECK(x) do { esp_err_t e_ = (x); if (e_ != ESP_OK) { \
    fprintf(stderr, "ESP_ERROR_CHECK failed: %s (0x%x) at %s:%d\n", esp_err_to_name(e_), e_, __FILE__, __LINE__); \
    abort(); } } while (0)
```

`S/shims/include/esp_system.h`:

```c
#pragma once
#include "esp_err.h"
void esp_restart(void) __attribute__((noreturn));
```

`S/shims/include/esp_attr.h`:

```c
#pragma once
#define EXT_RAM_BSS_ATTR
#define EXT_RAM_NOINIT_ATTR
#define IRAM_ATTR
#define DRAM_ATTR
#define RTC_NOINIT_ATTR
#define RTC_DATA_ATTR
```

`S/shims/include/esp_timer.h`:

```c
#pragma once
#include <stdint.h>
int64_t esp_timer_get_time(void);   /* µs since boot, monotonic */
```

`S/shims/include/esp_random.h`:

```c
#pragma once
#include <stdint.h>
uint32_t esp_random(void);
```

`S/shims/include/esp_app_desc.h`:

```c
#pragma once
#include <stdint.h>
typedef struct {
    uint32_t magic_word;
    uint32_t secure_version;
    uint32_t reserv1[2];
    char version[32];
    char project_name[32];
    char time[16];
    char date[16];
    char idf_ver[32];
    uint8_t app_elf_sha256[32];
} esp_app_desc_t;
const esp_app_desc_t *esp_app_get_description(void);
```

`S/shims/include/esp_heap_caps.h`:

```c
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#define MALLOC_CAP_EXEC     (1 << 0)
#define MALLOC_CAP_32BIT    (1 << 1)
#define MALLOC_CAP_8BIT     (1 << 2)
#define MALLOC_CAP_DMA      (1 << 3)
#define MALLOC_CAP_SPIRAM   (1 << 10)
#define MALLOC_CAP_INTERNAL (1 << 11)
#define MALLOC_CAP_DEFAULT  (1 << 12)
void *heap_caps_malloc(size_t size, uint32_t caps);
void *heap_caps_calloc(size_t n, size_t size, uint32_t caps);
void *heap_caps_realloc(void *ptr, size_t size, uint32_t caps);
void heap_caps_free(void *ptr);
size_t heap_caps_get_free_size(uint32_t caps);
size_t heap_caps_get_total_size(uint32_t caps);
size_t heap_caps_get_largest_free_block(uint32_t caps);
size_t heap_caps_get_minimum_free_size(uint32_t caps);
bool heap_caps_check_integrity_all(bool print_errors);
```

`S/shims/include/esp_log.h`:

```c
#pragma once
#include <stdarg.h>
#include <stdint.h>
typedef enum { ESP_LOG_NONE, ESP_LOG_ERROR, ESP_LOG_WARN, ESP_LOG_INFO, ESP_LOG_DEBUG, ESP_LOG_VERBOSE } esp_log_level_t;
typedef int (*vprintf_like_t)(const char *, va_list);
vprintf_like_t esp_log_set_vprintf(vprintf_like_t func);
void esp_log_level_set(const char *tag, esp_log_level_t level);
uint32_t esp_log_timestamp(void);
void esp_log_write(esp_log_level_t level, const char *tag, const char *format, ...)
    __attribute__((format(printf, 3, 4)));
#define ESP_SIM_LOG(lvl, letter, tag, fmt, ...) \
    esp_log_write(lvl, tag, letter " (%lu) %s: " fmt "\n", (unsigned long)esp_log_timestamp(), tag, ##__VA_ARGS__)
#define ESP_LOGE(tag, fmt, ...) ESP_SIM_LOG(ESP_LOG_ERROR,   "E", tag, fmt, ##__VA_ARGS__)
#define ESP_LOGW(tag, fmt, ...) ESP_SIM_LOG(ESP_LOG_WARN,    "W", tag, fmt, ##__VA_ARGS__)
#define ESP_LOGI(tag, fmt, ...) ESP_SIM_LOG(ESP_LOG_INFO,    "I", tag, fmt, ##__VA_ARGS__)
#define ESP_LOGD(tag, fmt, ...) ESP_SIM_LOG(ESP_LOG_DEBUG,   "D", tag, fmt, ##__VA_ARGS__)
#define ESP_LOGV(tag, fmt, ...) ESP_SIM_LOG(ESP_LOG_VERBOSE, "V", tag, fmt, ##__VA_ARGS__)
```

`S/shims/include/nvs.h`:

```c
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
typedef uint32_t nvs_handle_t;
typedef enum { NVS_READONLY, NVS_READWRITE } nvs_open_mode_t;
esp_err_t nvs_open(const char *ns, nvs_open_mode_t mode, nvs_handle_t *out);
void nvs_close(nvs_handle_t h);
esp_err_t nvs_commit(nvs_handle_t h);
esp_err_t nvs_get_u8(nvs_handle_t h, const char *key, uint8_t *out);
esp_err_t nvs_set_u8(nvs_handle_t h, const char *key, uint8_t value);
esp_err_t nvs_get_str(nvs_handle_t h, const char *key, char *out, size_t *len);
esp_err_t nvs_set_str(nvs_handle_t h, const char *key, const char *value);
esp_err_t nvs_erase_key(nvs_handle_t h, const char *key);
esp_err_t nvs_erase_all(nvs_handle_t h);
```

`S/shims/include/nvs_flash.h`:

```c
#pragma once
#include "esp_err.h"
esp_err_t nvs_flash_init(void);
esp_err_t nvs_flash_erase(void);
```

`S/shims/include/driver/gpio.h`:

```c
#pragma once
typedef int gpio_num_t;
#define GPIO_NUM_0 0
static inline int gpio_get_level(gpio_num_t n) { (void)n; return 1; }
```

`S/shims/esp_sim.h`:

```c
#pragma once
#include <stdbool.h>
void sim_log_set_level(int level);
unsigned sim_log_error_count(void);
bool sim_log_contains(const char *needle);
void sim_app_set_version(const char *version);
void sim_nvs_configure(const char *persist_path, const char *defaults_path);
```

- [ ] **Step 3: `S/shims/esp.c`**:

```c
#include <pthread.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "esp_app_desc.h"
#include "esp_err.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_sim.h"
#include "esp_system.h"
#include "esp_timer.h"

/* ── time ── */
static struct timespec boot;
static pthread_once_t boot_once = PTHREAD_ONCE_INIT;
static void boot_init(void) { clock_gettime(CLOCK_MONOTONIC, &boot); }
int64_t esp_timer_get_time(void) {
    pthread_once(&boot_once, boot_init);
    struct timespec now; clock_gettime(CLOCK_MONOTONIC, &now);
    return (int64_t)(now.tv_sec - boot.tv_sec) * 1000000 + (now.tv_nsec - boot.tv_nsec) / 1000;
}
uint32_t esp_log_timestamp(void) { return (uint32_t)(esp_timer_get_time() / 1000); }

/* ── random ── */
uint32_t esp_random(void) { return arc4random(); }

/* ── errors / system ── */
const char *esp_err_to_name(esp_err_t err) {
    switch (err) {
    case ESP_OK: return "ESP_OK";
    case ESP_FAIL: return "ESP_FAIL";
    case ESP_ERR_NO_MEM: return "ESP_ERR_NO_MEM";
    case ESP_ERR_NVS_NOT_FOUND: return "ESP_ERR_NVS_NOT_FOUND";
    default: return "ESP_ERR";
    }
}
void esp_restart(void) { fprintf(stderr, "esp_restart() — simulator exits\n"); exit(0); }

/* ── app description ── */
static esp_app_desc_t desc = { .version = "sim-dev", .project_name = "harness-sim", .idf_ver = "sim" };
void sim_app_set_version(const char *v) { snprintf(desc.version, sizeof desc.version, "%s", v); }
const esp_app_desc_t *esp_app_get_description(void) { return &desc; }

/* ── heap ── */
void *heap_caps_malloc(size_t size, uint32_t caps) { (void)caps; return malloc(size); }
void *heap_caps_calloc(size_t n, size_t size, uint32_t caps) { (void)caps; return calloc(n, size); }
void *heap_caps_realloc(void *p, size_t size, uint32_t caps) { (void)caps; return realloc(p, size); }
void heap_caps_free(void *p) { free(p); }
size_t heap_caps_get_free_size(uint32_t caps) { (void)caps; return 4u << 20; }
size_t heap_caps_get_total_size(uint32_t caps) { (void)caps; return 8u << 20; }
size_t heap_caps_get_largest_free_block(uint32_t caps) { (void)caps; return 2u << 20; }
size_t heap_caps_get_minimum_free_size(uint32_t caps) { (void)caps; return 3u << 20; }
bool heap_caps_check_integrity_all(bool print) { (void)print; return true; }

/* ── log ── */
static _Atomic(vprintf_like_t) hook = vprintf;
static atomic_int level = ESP_LOG_INFO;
static atomic_uint errors;
#define RING 512
static char *ring[RING];
static unsigned ring_next;
static pthread_mutex_t ring_mu = PTHREAD_MUTEX_INITIALIZER;

vprintf_like_t esp_log_set_vprintf(vprintf_like_t f) { return atomic_exchange(&hook, f); }
void esp_log_level_set(const char *tag, esp_log_level_t l) { (void)tag; atomic_store(&level, l); }
void sim_log_set_level(int l) { atomic_store(&level, l); }
unsigned sim_log_error_count(void) { return atomic_load(&errors); }

bool sim_log_contains(const char *needle) {
    bool found = false;
    pthread_mutex_lock(&ring_mu);
    for (unsigned i = 0; i < RING && !found; i++) found = ring[i] && strstr(ring[i], needle);
    pthread_mutex_unlock(&ring_mu);
    return found;
}

static int call_hook(vprintf_like_t f, const char *fmt, ...) {
    va_list ap; va_start(ap, fmt);
    int n = f(fmt, ap);
    va_end(ap);
    return n;
}

void esp_log_write(esp_log_level_t l, const char *tag, const char *format, ...) {
    (void)tag;
    if (l == ESP_LOG_ERROR) atomic_fetch_add(&errors, 1);
    char line[512];
    va_list ap; va_start(ap, format);
    vsnprintf(line, sizeof line, format, ap);
    va_end(ap);
    pthread_mutex_lock(&ring_mu);
    free(ring[ring_next]); ring[ring_next] = strdup(line); ring_next = (ring_next + 1) % RING;
    pthread_mutex_unlock(&ring_mu);
    if ((int)l > atomic_load(&level)) return;
    call_hook(atomic_load(&hook), "%s", line);
}
```

- [ ] **Step 4: `S/shims/nvs.c`**:

```c
// NVS as a small key/value map. Persisted as JSON on commit when a profile path is configured; otherwise
// ephemeral, seeded from a defaults file (headless runs).
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_sim.h"
#include "nvs.h"
#include "nvs_flash.h"

static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static cJSON *root;                 /* { ns: { key: { "u8": n } | { "str": "s" } } } */
static char persist[1024], defaults[1024];
#define MAX_HANDLES 32
static char *handles[MAX_HANDLES];  /* handle - 1 → namespace name */

static cJSON *load(const char *path) {
    FILE *f = path && *path ? fopen(path, "rb") : NULL;
    if (!f) return NULL;
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    char *buf = malloc((size_t)n + 1);
    size_t got = fread(buf, 1, (size_t)n, f); buf[got] = 0; fclose(f);
    cJSON *j = cJSON_Parse(buf); free(buf);
    return j;
}

void sim_nvs_configure(const char *persist_path, const char *defaults_path) {
    pthread_mutex_lock(&mu);
    snprintf(persist, sizeof persist, "%s", persist_path ? persist_path : "");
    snprintf(defaults, sizeof defaults, "%s", defaults_path ? defaults_path : "");
    cJSON_Delete(root); root = NULL;
    pthread_mutex_unlock(&mu);
}

esp_err_t nvs_flash_init(void) {
    pthread_mutex_lock(&mu);
    if (!root) root = load(*persist ? persist : defaults);
    if (!root && *persist) root = load(defaults);
    if (!root) root = cJSON_CreateObject();
    pthread_mutex_unlock(&mu);
    return ESP_OK;
}

esp_err_t nvs_flash_erase(void) {
    pthread_mutex_lock(&mu); cJSON_Delete(root); root = cJSON_CreateObject(); pthread_mutex_unlock(&mu);
    return ESP_OK;
}

esp_err_t nvs_open(const char *ns, nvs_open_mode_t mode, nvs_handle_t *out) {
    (void)mode;
    pthread_mutex_lock(&mu);
    esp_err_t r = ESP_ERR_NO_MEM;
    for (int i = 0; i < MAX_HANDLES; i++) if (!handles[i]) {
        handles[i] = strdup(ns);
        if (!cJSON_GetObjectItemCaseSensitive(root, ns)) cJSON_AddObjectToObject(root, ns);
        *out = (nvs_handle_t)(i + 1); r = ESP_OK; break;
    }
    pthread_mutex_unlock(&mu);
    return r;
}

void nvs_close(nvs_handle_t h) {
    pthread_mutex_lock(&mu);
    if (h >= 1 && h <= MAX_HANDLES) { free(handles[h - 1]); handles[h - 1] = NULL; }
    pthread_mutex_unlock(&mu);
}

static cJSON *space(nvs_handle_t h) {   /* caller holds mu */
    if (h < 1 || h > MAX_HANDLES || !handles[h - 1]) return NULL;
    return cJSON_GetObjectItemCaseSensitive(root, handles[h - 1]);
}

esp_err_t nvs_commit(nvs_handle_t h) {
    pthread_mutex_lock(&mu);
    esp_err_t r = space(h) ? ESP_OK : ESP_ERR_NVS_INVALID_HANDLE;
    if (r == ESP_OK && *persist) {
        char *text = cJSON_Print(root);
        FILE *f = fopen(persist, "wb");
        if (f) { fputs(text, f); fclose(f); } else r = ESP_FAIL;
        free(text);
    }
    pthread_mutex_unlock(&mu);
    return r;
}

static void put(nvs_handle_t h, const char *key, cJSON *value) {
    cJSON *ns = space(h);
    cJSON_DeleteItemFromObjectCaseSensitive(ns, key);
    cJSON_AddItemToObject(ns, key, value);
}

esp_err_t nvs_set_u8(nvs_handle_t h, const char *key, uint8_t value) {
    pthread_mutex_lock(&mu);
    esp_err_t r = ESP_ERR_NVS_INVALID_HANDLE;
    if (space(h)) { cJSON *v = cJSON_CreateObject(); cJSON_AddNumberToObject(v, "u8", value); put(h, key, v); r = ESP_OK; }
    pthread_mutex_unlock(&mu);
    return r;
}

esp_err_t nvs_get_u8(nvs_handle_t h, const char *key, uint8_t *out) {
    pthread_mutex_lock(&mu);
    esp_err_t r = ESP_ERR_NVS_INVALID_HANDLE;
    cJSON *ns = space(h);
    if (ns) {
        cJSON *v = cJSON_GetObjectItemCaseSensitive(cJSON_GetObjectItemCaseSensitive(ns, key), "u8");
        if (cJSON_IsNumber(v)) { *out = (uint8_t)v->valueint; r = ESP_OK; } else r = ESP_ERR_NVS_NOT_FOUND;
    }
    pthread_mutex_unlock(&mu);
    return r;
}

esp_err_t nvs_set_str(nvs_handle_t h, const char *key, const char *value) {
    pthread_mutex_lock(&mu);
    esp_err_t r = ESP_ERR_NVS_INVALID_HANDLE;
    if (space(h)) { cJSON *v = cJSON_CreateObject(); cJSON_AddStringToObject(v, "str", value); put(h, key, v); r = ESP_OK; }
    pthread_mutex_unlock(&mu);
    return r;
}

esp_err_t nvs_get_str(nvs_handle_t h, const char *key, char *out, size_t *len) {
    pthread_mutex_lock(&mu);
    esp_err_t r = ESP_ERR_NVS_INVALID_HANDLE;
    cJSON *ns = space(h);
    if (ns) {
        cJSON *v = cJSON_GetObjectItemCaseSensitive(cJSON_GetObjectItemCaseSensitive(ns, key), "str");
        if (!cJSON_IsString(v)) r = ESP_ERR_NVS_NOT_FOUND;
        else {
            size_t need = strlen(v->valuestring) + 1;
            if (!out) { *len = need; r = ESP_OK; }
            else if (*len < need) r = ESP_ERR_NVS_INVALID_LENGTH;
            else { memcpy(out, v->valuestring, need); *len = need; r = ESP_OK; }
        }
    }
    pthread_mutex_unlock(&mu);
    return r;
}

esp_err_t nvs_erase_key(nvs_handle_t h, const char *key) {
    pthread_mutex_lock(&mu);
    cJSON *ns = space(h);
    esp_err_t r = !ns ? ESP_ERR_NVS_INVALID_HANDLE
                : cJSON_GetObjectItemCaseSensitive(ns, key) ? ESP_OK : ESP_ERR_NVS_NOT_FOUND;
    if (r == ESP_OK) cJSON_DeleteItemFromObjectCaseSensitive(ns, key);
    pthread_mutex_unlock(&mu);
    return r;
}

esp_err_t nvs_erase_all(nvs_handle_t h) {
    pthread_mutex_lock(&mu);
    cJSON *ns = space(h);
    if (ns) while (ns->child) cJSON_DeleteItemFromObjectCaseSensitive(ns, ns->child->string);
    pthread_mutex_unlock(&mu);
    return ns ? ESP_OK : ESP_ERR_NVS_INVALID_HANDLE;
}
```

- [ ] **Step 5: Run** — `cmake -S devices/harness-device/sim -B devices/harness-device/sim/build -G Ninja && ninja -C devices/harness-device/sim/build && ctest --test-dir devices/harness-device/sim/build --output-on-failure` → `rtos`, `nvs`, `log` PASS.

- [ ] **Step 6: Commit**

```bash
git add devices/harness-device/sim/shims devices/harness-device/sim/test/test_nvs.c devices/harness-device/sim/test/test_log.c devices/harness-device/sim/CMakeLists.txt
git commit -m "feat(device): ESP-IDF log/timer/heap/NVS shims for the simulator

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Link the real firmware: drivers, stubs, script runner, headless front → first PNG

**Files:**
- Create: `S/core/sim.h`, `S/core/stubs.c`, `S/core/display_core.c`, `S/core/touch_core.c`, `S/core/input_keys.c`, `S/core/audio_sim.c` (notify + silent mic now; WAV in Task 11), `S/core/link_sim.c` (fd transport; TCP connect in Task 9), `S/core/image.c`, `S/core/settle.c`, `S/core/script.c`, `S/front/headless.c`, `S/sim_main.c`, `S/fixtures/nvs-defaults.json`, `S/test/test_touch.c`, `S/test/test_mac.c`, `S/test/run_scenarios.sh`, `S/test/scenarios/boot-no-host.jsonl`
- Modify: `S/CMakeLists.txt`

**Interfaces:**
- Consumes: all shims (Tasks 5-6), incl. `sim_rtos_park_begin/end`, `pcTaskGetName`.
- Produces (`S/core/sim.h`, complete — later tasks add no declarations):

```c
#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef struct {
    bool headless;
    int port;                 /* TCP port of the daemon, default 18474 */
    const char *script;       /* headless: scenario path, NULL = live link */
    const char *shot;         /* headless: final PNG path */
    const char *profile;      /* NULL = ephemeral NVS seeded from fixtures/nvs-defaults.json */
    bool factory_reset;
    int scale;
    int settle_ms, settle_timeout_ms;
    bool allow_errors;
    bool dump_scene;          /* print every text run of each presented scene (for writing scenarios) */
    const char *voice_wav;    /* Task 11 */
    const char *voice_text;   /* Task 11 */
    const char *record;       /* Task 9: record daemon→device frames */
} sim_options_t;
extern sim_options_t g_sim;

#define SIM_W 466
#define SIM_H 466

/* front contract — front/headless.c or front/sdl.c */
void sim_front_init(void);                          /* main thread, BEFORE firmware starts */
void sim_front_present(const uint16_t *panel_fb, uint32_t seq);  /* returns once frame `seq` is on glass */
int sim_front_run(void);                            /* owns the main thread; never returns normally */

/* display_core */
void sim_display_copy_rgb888(uint8_t *out_rgb, int stride);   /* last presented frame, byte order fixed */
int64_t sim_display_last_present_us(void);
bool sim_display_find_text(const char *needle, int *cx, int *cy);  /* case-insensitive, last presented scene */

/* touch_core — pointer in panel coordinates, from the front or the script */
void sim_pointer_set(bool down, int x, int y);
void sim_pointer_cancel(void);                 /* focus loss / release outside: swallow until up */
void sim_touch_sync(void);                     /* returns after the touch task consumed the current state */

/* input_keys */
typedef enum { SIM_KEY_BOOT, SIM_KEY_PWR, SIM_KEY_VOICE, SIM_KEY_COUNT } sim_key_t;
void sim_key_set(sim_key_t key, bool down);
void sim_keys_release_all(void);
void sim_keys_sync(void);                      /* returns after the key task consumed the current state */

/* settle.c: all tracked tasks parked and nothing presented for settle_ms */
bool sim_settle(int settle_ms, int timeout_ms);

/* link_sim.c / link_tcp.c */
#include <sys/types.h>
extern ssize_t (*sim_link_write)(int fd, const void *buf, size_t len);   /* test seam; defaults to write() */
void sim_link_use_fd(int fd);                  /* install a connected fd (script socketpair or TCP) */
bool sim_link_connected(void);
void sim_link_connect_step(void);              /* reader task, once per loop; TCP in Task 9 */

/* image.c */
bool sim_png_write(const char *path);
double sim_ratio_in_circle(uint32_t rgb);      /* fraction of in-circle pixels exactly equal to rgb */
double sim_ratio_nonblack(void);

/* audio_sim.c */
bool sim_audio_load_wav(const char *path);     /* Task 11 */
unsigned sim_audio_beeps(void);                /* notification beeps actually played (mute respected) */

/* script.c */
void sim_script_start(int daemon_end);
```

- [ ] **Step 1: Failing touch test** — `S/test/test_touch.c`. Fakes use atomics; every "after this input" check goes through `sim_touch_sync()`, which only returns once the touch task has run twice past the input (no sleeps as synchronisation):

```c
#include <assert.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "rtos_sim.h"
#include "sim.h"
#include "ui/display.h"
#include "ui/touch.h"

sim_options_t g_sim;
static atomic_bool asleep;
static atomic_int touches, cancels, wakes, last_x, last_y;
static atomic_bool last_down;
void habitat_touch(bool down, int x, int y, uint32_t ms) {
    (void)ms; atomic_store(&last_down, down); atomic_store(&last_x, x); atomic_store(&last_y, y); atomic_fetch_add(&touches, 1);
}
void habitat_touch_cancel(void) { atomic_fetch_add(&cancels, 1); }
void habitat_input_stamp(int64_t us) { (void)us; }
void display_lock_at(const char *w) { (void)w; }     /* display_lock() is a macro over this */
void display_unlock(void) {}
bool display_is_asleep(void) { return atomic_load(&asleep); }
void display_wake(void) { atomic_store(&asleep, false); atomic_fetch_add(&wakes, 1); }
void display_bump_activity(void) {}

static void tap(bool down, int x, int y) { sim_pointer_set(down, x, y); sim_touch_sync(); }

static void run(void *arg) {
    (void)arg;
    sim_rtos_mark_untracked();
    touch_init();
    /* awake: press and release are delivered */
    tap(true, 100, 120);
    assert(atomic_load(&touches) > 0 && atomic_load(&last_down) && atomic_load(&last_x) == 100 && atomic_load(&last_y) == 120);
    tap(false, 100, 120);
    assert(!atomic_load(&last_down));
    /* asleep: the waking contact is swallowed until its release */
    atomic_store(&asleep, true); int before = atomic_load(&touches);
    tap(true, 50, 50);
    assert(atomic_load(&wakes) == 1 && atomic_load(&touches) == before && atomic_load(&cancels) >= 1);
    tap(true, 60, 60);
    assert(atomic_load(&touches) == before);
    tap(false, 60, 60);
    tap(true, 70, 70);
    assert(atomic_load(&touches) > before);
    tap(false, 70, 70);
    /* cancel mid-drag (focus loss): cancelled now, swallowed until the real release */
    tap(true, 85, 85);
    int c = atomic_load(&cancels);
    sim_pointer_cancel(); sim_touch_sync();
    assert(atomic_load(&cancels) > c);
    before = atomic_load(&touches);       /* baseline only once the cancel has been consumed */
    tap(true, 80, 80);
    sim_touch_sync();                     /* several held samples: none may be delivered */
    assert(atomic_load(&touches) == before);
    tap(false, 80, 80);
    tap(true, 90, 90);
    assert(atomic_load(&touches) > before);
    tap(false, 90, 90);
    /* outside the panel: untrusted → cancel, never delivered */
    before = atomic_load(&touches); c = atomic_load(&cancels);
    tap(true, 500, 10);
    assert(atomic_load(&touches) == before && atomic_load(&cancels) > c);
    puts("test_touch: ok");
    exit(0);
}

int main(void) { sim_rtos_spawn(run, "t", NULL, false); for (;;) pause(); }
```

CMake (append):

```cmake
set(FW_INC ${FW} ${FW}/ui ${FW}/board ${FW}/ui/habitat)
add_executable(test_touch ${SIM}/test/test_touch.c ${SIM}/core/touch_core.c)
target_include_directories(test_touch PRIVATE ${FW_INC} ${SIM}/core)
target_compile_options(test_touch PRIVATE ${SIM_WARN})
target_link_libraries(test_touch simshims)
add_test(NAME touch COMMAND test_touch)
```

Run `ninja -C devices/harness-device/sim/build test_touch` → FAIL (no `touch_core.c`).

- [ ] **Step 2: `S/core/touch_core.c`** — the device state machine (`F/ui/habitat/touch_habitat.c:83-165`) fed by a host pointer:

```c
// Touch, as touch_habitat.c does it, with the pointer as the controller. The rules that matter are copied
// deliberately: a contact that wakes the screen is swallowed; an untrusted sample cancels and swallows
// until a real release; every contact bumps activity; habitat_touch runs under the model lock.
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "runtime.h"
#include "sim.h"
#include "terminal.h"
#include "ui/display.h"
#include "ui/touch.h"

static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static bool p_down, p_cancel;
static int p_x, p_y;
static TaskHandle_t task_handle;
static atomic_uint presses, last_press, processed;
static atomic_bool held;

void sim_pointer_set(bool down, int x, int y) {
    pthread_mutex_lock(&mu); p_down = down; p_x = x; p_y = y; pthread_mutex_unlock(&mu);
    if (task_handle) xTaskNotifyGive(task_handle);
}

/* Cancel now and swallow the rest of this contact. p_down is left alone: the swallow ends only on the
 * front's real release (sim_pointer_set(false, …)). */
void sim_pointer_cancel(void) {
    pthread_mutex_lock(&mu); p_cancel = true; pthread_mutex_unlock(&mu);
    if (task_handle) xTaskNotifyGive(task_handle);
}

/* Two full iterations after the call: the one in flight may have sampled the old state. */
void sim_touch_sync(void) {
    uint32_t start = atomic_load(&processed);
    for (int i = 0; i < 2000 && atomic_load(&processed) < start + 2; i++) {
        if (task_handle) xTaskNotifyGive(task_handle);
        vTaskDelay(1);
    }
    if (atomic_load(&processed) < start + 2) { fputs("touch: input not consumed within 2 s\n", stderr); abort(); }
}

static void task(void *arg) {
    (void)arg;
    bool prev = false, swallow = false;
    for (;;) {
        pthread_mutex_lock(&mu);
        bool down = p_down, cancel = p_cancel; int x = p_x, y = p_y; p_cancel = false;
        pthread_mutex_unlock(&mu);
        int64_t now = esp_timer_get_time();
        bool trusted = !cancel && (!down || (x >= 0 && y >= 0 && x < HT_WIDTH && y < HT_HEIGHT));
        if (!trusted) {
            display_lock(); habitat_touch_cancel(); display_unlock();
            swallow = true;
            down = false;
        }
        if (down && !prev) {
            atomic_fetch_add(&presses, 1);
            atomic_store(&last_press, (uint32_t)(now / 1000));
            if (display_is_asleep()) {
                display_lock(); habitat_touch_cancel(); display_wake(); display_unlock();
                swallow = true;
            } else habitat_input_stamp(now);
        }
        if (down) display_bump_activity();
        if (!swallow && (down || prev)) {
            display_lock();
            if (display_is_asleep()) { habitat_touch_cancel(); swallow = true; }
            else habitat_touch(down, x, y, (uint32_t)(now / 1000));
            display_unlock();
        }
        if (!down && trusted) swallow = false;
        prev = down;
        atomic_store(&held, down);
        atomic_fetch_add(&processed, 1);
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(down ? 4 : 20));
    }
}

void touch_init(void) { xTaskCreatePinnedToCore(task, "habitat_touch", 4096, NULL, 7, &task_handle, 1); }
uint32_t touch_activity_generation(void) { return atomic_load(&presses); }
void touch_stats(touch_stats_t *out) {
    *out = (touch_stats_t){ .presses = atomic_load(&presses),
        .last_press_ms_ago = (uint32_t)(esp_timer_get_time() / 1000) - atomic_load(&last_press),
        .controller_ok = true, .held_now = atomic_load(&held) };
}
```

Run: `ninja -C devices/harness-device/sim/build test_touch && ctest --test-dir devices/harness-device/sim/build -R touch --output-on-failure` → PASS.

- [ ] **Step 3: `S/core/display_core.c`** — the render loop from `F/ui/habitat/display_habitat.c:345-436`, the panel replaced by a framebuffer and `sim_front_present` playing the DMA fence (acknowledge only after it returns):

```c
#include <ctype.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "runtime.h"
#include "sim.h"
#include "terminal.h"
#include "ui/display.h"
#include "ui/touch.h"

#define STRIP_LINES 24
static SemaphoreHandle_t model_lock;
static TaskHandle_t renderer;
static ht_scene_t scenes[2];
static bool painted;
static atomic_bool asleep, force_frame;
static atomic_uint last_activity;
static void (*power_cb)(bool);
static uint16_t fb[HT_WIDTH * HT_HEIGHT];          /* panel byte order, as the raster emits it */
static uint16_t strip[HT_WIDTH * STRIP_LINES];
static uint16_t presented[HT_WIDTH * HT_HEIGHT];   /* last frame handed to the front */
static ht_scene_t presented_scene;                 /* the scene those pixels came from */
static SemaphoreHandle_t presented_mu;
static uint32_t present_seq;
static _Atomic int64_t last_present_us;
static portMUX_TYPE stats_lock = portMUX_INITIALIZER_UNLOCKED;
static habitat_perf_t stats;
static int64_t input_us;

static uint32_t now_ms(void) { return (uint32_t)(esp_timer_get_time() / 1000); }
static uint32_t elapsed_since(atomic_uint *t) { return now_ms() - atomic_load(t); }

void habitat_render_notify(void) { if (renderer) xTaskNotifyGive(renderer); }
void habitat_input_stamp(int64_t us) { portENTER_CRITICAL(&stats_lock); input_us = us; portEXIT_CRITICAL(&stats_lock); }
void habitat_perf_get(habitat_perf_t *out) { portENTER_CRITICAL(&stats_lock); *out = stats; portEXIT_CRITICAL(&stats_lock); }
void display_lock_at(const char *who) { (void)who; if (model_lock) xSemaphoreTakeRecursive(model_lock, portMAX_DELAY); }
void display_unlock(void) { if (model_lock) xSemaphoreGiveRecursive(model_lock); }
bool display_is_asleep(void) { return atomic_load(&asleep); }
void display_set_power_cb(void (*cb)(bool)) { power_cb = cb; }
void display_bump_activity(void) { atomic_store(&last_activity, now_ms()); }
void display_sleep(void) {
    if (atomic_exchange(&asleep, true)) return;
    if (power_cb) power_cb(false);
    habitat_render_notify();
}
void display_wake(void) {
    if (!atomic_exchange(&asleep, false)) return;
    display_bump_activity();
    atomic_store(&force_frame, true);
    if (power_cb) power_cb(true);
    habitat_render_notify();
}
void display_set_brightness(uint8_t value) { (void)value; /* palette already applies it, as on device */ }

static void dump(const ht_scene_t *sc) {
    fprintf(stderr, "scene (%u runs):\n", sc->count);
    for (int i = 0; i < sc->count; i++)
        fprintf(stderr, "  [%d] x=%d y=%d w=%d arc=%u \"%s\"\n", i, sc->runs[i].x, sc->runs[i].y, sc->runs[i].w,
                sc->runs[i].arc, sc->runs[i].text);
}

/* Copy under the lock, hand the copy to the front, and wait there — the front returns once it is shown. */
static void present(const ht_scene_t *sc) {
    xSemaphoreTake(presented_mu, portMAX_DELAY);
    if (sc) { memcpy(presented, fb, sizeof fb); presented_scene = *sc; }
    else { memset(presented, 0, sizeof presented); memset(&presented_scene, 0, sizeof presented_scene); }
    uint32_t seq = ++present_seq;
    xSemaphoreGive(presented_mu);
    if (g_sim.dump_scene && sc) dump(sc);
    sim_front_present(presented, seq);
    atomic_store(&last_present_us, esp_timer_get_time());
}

static void paint(const ht_scene_t *next, const ht_damage_t *damage) {
    int64_t started = esp_timer_get_time();
    for (int n = 0; n < damage->count; n++) {
        ht_rect_t rect = damage->rect[n];
        for (int y = rect.y; y < rect.y + rect.h; y += STRIP_LINES) {
            int h = rect.y + rect.h - y;
            if (h > STRIP_LINES) h = STRIP_LINES;
            ht_rect_t s = { rect.x, (int16_t)y, rect.w, (int16_t)h };
            ht_raster(next, s, strip);
            for (int row = 0; row < h; row++)
                memcpy(&fb[(y + row) * HT_WIDTH + rect.x], &strip[row * rect.w], (size_t)rect.w * 2);
        }
    }
    present(next);
    int64_t finished = esp_timer_get_time();
    portENTER_CRITICAL(&stats_lock);
    stats.frames++;
    stats.bytes += damage->pixels * 2;
    if (finished - started > stats.frame_max_us) stats.frame_max_us = (uint32_t)(finished - started);
    if (input_us && input_us <= started) { stats.input_last_us = (uint32_t)(finished - input_us); input_us = 0; }
    portEXIT_CRITICAL(&stats_lock);
}

static void render_task(void *arg) {
    (void)arg;
    int front = 0;
    bool panel_on = true;
    for (;;) {
        display_lock();
        habitat_tick();
        bool fresh = habitat_scene_take(&scenes[front ^ 1]);
        uint32_t receipt = habitat_scene_receipt();
        uint32_t wake_ms = habitat_next_wake_ms();
        display_unlock();
        bool on = !display_is_asleep();
        if (on != panel_on) { panel_on = on; if (!on) present(NULL); }
        bool force = on && atomic_exchange(&force_frame, false);
        if (on && (fresh || force)) {
            if (!fresh) scenes[front ^ 1] = scenes[front];
            ht_damage_t damage;
            ht_damage(painted && !force ? &scenes[front] : NULL, &scenes[front ^ 1], &damage);
            if (damage.count) paint(&scenes[front ^ 1], &damage);
            front ^= 1;
            painted = true;
            if (receipt) habitat_scene_presented(receipt);
        }
        if (!on && fresh) { front ^= 1; painted = false; }
        if (on && elapsed_since(&last_activity) > 300000) {
            display_lock();
            if (elapsed_since(&last_activity) > 300000) display_sleep();
            display_unlock();
        }
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(wake_ms > 1000 ? 1000 : wake_ms));
    }
}

void display_init(void) {
    model_lock = xSemaphoreCreateRecursiveMutex();
    presented_mu = xSemaphoreCreateMutex();
    display_bump_activity();
    xTaskCreatePinnedToCore(render_task, "habitat_render", 6144, NULL, 5, &renderer, 1);
    touch_init();
    ESP_LOGI("habitat", "simulated %dpx face", HT_WIDTH);
}
void display_init_ota(void) { display_init(); }

int64_t sim_display_last_present_us(void) { return atomic_load(&last_present_us); }

/* panel order is byte-swapped RGB565 (terminal.c); undo the swap, then widen to 8 bits per channel */
void sim_display_copy_rgb888(uint8_t *out, int stride) {
    xSemaphoreTake(presented_mu, portMAX_DELAY);
    for (int y = 0; y < HT_HEIGHT; y++)
        for (int x = 0; x < HT_WIDTH; x++) {
            uint16_t p = presented[y * HT_WIDTH + x];
            p = (uint16_t)((p << 8) | (p >> 8));
            uint8_t *o = out + y * stride + x * 3;
            o[0] = (uint8_t)(((p >> 11) & 0x1f) << 3);
            o[1] = (uint8_t)(((p >> 5) & 0x3f) << 2);
            o[2] = (uint8_t)((p & 0x1f) << 3);
        }
    xSemaphoreGive(presented_mu);
}

static bool contains_ci(const char *hay, const char *needle) {
    size_t n = strlen(needle);
    for (; *hay; hay++) {
        size_t i = 0;
        while (i < n && hay[i] && tolower((unsigned char)hay[i]) == tolower((unsigned char)needle[i])) i++;
        if (i == n) return true;
    }
    return false;
}

/* Center of the first run containing `needle`. Height is the run font's cell height (16 px if unknown). */
bool sim_display_find_text(const char *needle, int *cx, int *cy) {
    bool found = false;
    xSemaphoreTake(presented_mu, portMAX_DELAY);
    for (int i = 0; i < presented_scene.count && !found; i++) {
        const ht_run_t *r = &presented_scene.runs[i];
        if (!contains_ci(r->text, needle)) continue;
        int h = r->font ? r->font->height : 16;
        if (cx) *cx = r->x + r->w / 2;
        if (cy) *cy = r->y + h / 2;
        found = true;
    }
    xSemaphoreGive(presented_mu);
    return found;
}
```

If the link step (Step 12) reports `habitat_scene_receipt` or `habitat_next_wake_ms` undefined, they live in `display_habitat.c` on device — copy their bodies verbatim into this file.

Arc runs (`arc != 0`) are drawn along the rim: their `x,y` is the arc box origin, so `sim_display_find_text` centres on the box, not the glyph. Scenarios tap straight runs; if a needed target is on an arc, say so in the scenario comment and tap its box centre.

- [ ] **Step 4: `S/core/stubs.c`**:

```c
// Hardware modules the simulator does not have. Each answers the way the firmware treats "absent".
#include <stdio.h>
#include <string.h>
#include "board/board.h"
#include "board/power.h"
#include "device_mac.h"
#include "esp_random.h"
#include "fw_update.h"
#include "last_words.h"
#include "nvs.h"
#include "sim.h"

static const board_t sim_board = { .name = "sim", .lcd_rst = -1, .touch_rst = -1,
                                   .touch = TOUCH_CST9217, .touch_mirror = false, .has_pmic = true };
const board_t *board(void) { return &sim_board; }
void board_detect(void) {}
const char *board_describe(void) { return "touch=sim pmic=sim"; }
bool board_factory_reset_requested(void) { return g_sim.factory_reset; }
void board_from_acks(const uint8_t *acks, int n, board_t *out) { (void)acks; (void)n; *out = sim_board; }

bool power_init(void) { return true; }
int power_battery_pct(void) { return 100; }
bool power_is_charging(void) { return false; }
bool power_is_on_external(void) { return true; }
bool power_take_pwrkey_tap(void) { return false; }   /* PWR comes from input_keys.c */

void fw_mark_valid(void) {}
bool fw_update_offer(const char *v, int size, const char *sha) { (void)v; (void)size; (void)sha; return false; }
void fw_update_slice(const uint8_t *d, size_t n) { (void)d; (void)n; }
bool fw_update_active(void) { return false; }
void fw_update_abort(const char *why) { (void)why; }
void fw_update_tick(void) {}

void last_words_boot(void) {}
void last_words_add(const char *line, size_t len) { (void)line; (void)len; }
void last_words_report(void) {}

/* A locally administered MAC, made once per profile and kept in that profile's NVS. */
bool device_mac_str(char *out, size_t cap) {
    nvs_handle_t h;
    size_t len = cap;
    if (nvs_open("sim", NVS_READWRITE, &h) != ESP_OK) { if (cap) out[0] = 0; return false; }
    if (nvs_get_str(h, "mac", out, &len) != ESP_OK) {
        uint32_t r1 = esp_random(), r2 = esp_random();
        snprintf(out, cap, "%02X:%02X:%02X:%02X:%02X:%02X", 0x02, (unsigned)(r1 & 0xff), (unsigned)((r1 >> 8) & 0xff),
                 (unsigned)((r1 >> 16) & 0xff), (unsigned)(r2 & 0xff), (unsigned)((r2 >> 8) & 0xff));
        nvs_set_str(h, "mac", out);
        nvs_commit(h);
    }
    nvs_close(h);
    return true;
}
```

- [ ] **Step 5: `S/test/test_mac.c`** — two fresh profiles differ; a profile keeps its MAC across restarts (Review Focus 2):

```c
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "device_mac.h"
#include "esp_sim.h"
#include "nvs_flash.h"
#include "sim.h"

sim_options_t g_sim;
void sim_front_present(const uint16_t *fb, uint32_t seq) { (void)fb; (void)seq; }

static void mac_for(const char *path, char out[DEVICE_MAC_STR_LEN]) {
    sim_nvs_configure(path, NULL);
    assert(nvs_flash_init() == ESP_OK);
    assert(device_mac_str(out, DEVICE_MAC_STR_LEN));
}

int main(void) {
    char a_path[] = "/tmp/simmacAXXXXXX", b_path[] = "/tmp/simmacBXXXXXX";
    close(mkstemp(a_path)); unlink(a_path); close(mkstemp(b_path)); unlink(b_path);
    char a[DEVICE_MAC_STR_LEN], b[DEVICE_MAC_STR_LEN], again[DEVICE_MAC_STR_LEN];
    mac_for(a_path, a);
    mac_for(b_path, b);
    mac_for(a_path, again);
    assert(strncmp(a, "02:", 3) == 0 && strlen(a) == 17);
    assert(strcmp(a, b) != 0);
    assert(strcmp(a, again) == 0);
    unlink(a_path); unlink(b_path);
    puts("test_mac: ok");
    return 0;
}
```

(CMake target added in Step 13, after `simcore` exists.)

- [ ] **Step 6: `S/core/input_keys.c`** — `ptt_start()` mirrors `F/ptt.c` (BOOT fires on press, hold ≥ 800 ms toggles screen once, PWR tap toggles, 100 ms poll) plus voice keys:

```c
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "ptt.h"
#include "sim.h"
#include "ui/display.h"
#include "ui/ui_screens.h"

#define BOOT_LONG_PRESS_MS 800
static const char *TAG = "ptt";
static atomic_bool keys[SIM_KEY_COUNT];
static atomic_bool pwr_tap;
static atomic_uint loops;

void sim_key_set(sim_key_t k, bool down) {
    if (k == SIM_KEY_PWR) { if (down) atomic_store(&pwr_tap, true); return; }
    atomic_store(&keys[k], down);
}
void sim_keys_release_all(void) { for (int i = 0; i < SIM_KEY_COUNT; i++) atomic_store(&keys[i], false); }

void sim_keys_sync(void) {
    uint32_t start = atomic_load(&loops);
    for (int i = 0; i < 300 && atomic_load(&loops) < start + 2; i++) vTaskDelay(pdMS_TO_TICKS(10));
    if (atomic_load(&loops) < start + 2) { fputs("keys: input not consumed within 3 s\n", stderr); abort(); }
}

static void screen_toggle(const char *why) {
    display_lock();
    if (display_is_asleep()) { ESP_LOGI(TAG, "%s → screen ON", why); display_wake(); }
    else { ESP_LOGI(TAG, "%s → screen OFF", why); display_sleep(); }
    display_unlock();
}

static void task(void *arg) {
    (void)arg;
    bool boot_prev = false, voice_prev = false, long_fired = false;
    int64_t press_start_us = 0;
    for (;;) {
        bool boot = atomic_load(&keys[SIM_KEY_BOOT]);
        if (boot && !boot_prev) {
            if (display_is_asleep()) { display_lock(); display_wake(); display_unlock(); }
            ESP_LOGI(TAG, "BOOT press → back / stop turn");
            ui_boot_pressed();
            press_start_us = esp_timer_get_time();
            long_fired = false;
        } else if (boot && !long_fired && esp_timer_get_time() - press_start_us >= (int64_t)BOOT_LONG_PRESS_MS * 1000) {
            long_fired = true;
            screen_toggle("BOOT hold");
        }
        boot_prev = boot;
        if (atomic_exchange(&pwr_tap, false)) screen_toggle("PWR tap");
        bool voice = atomic_load(&keys[SIM_KEY_VOICE]);
        if (voice && !voice_prev) ui_voice_start();
        if (!voice && voice_prev) ui_voice_stop();
        voice_prev = voice;
        atomic_fetch_add(&loops, 1);
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}

void ptt_start(void) { xTaskCreate(task, "ptt", 4096, NULL, 5, NULL); }
```

- [ ] **Step 7: `S/core/audio_sim.c`** — notification settings exactly as `F/audio_capture.c:44-52,130-132` (load and persist through `config_store`, mute suppresses the beep); silent paced mic until Task 11:

```c
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include "audio_capture.h"
#include "config_store.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sim.h"

static atomic_bool muted;
static atomic_uint beeps;

bool audio_capture_init(void) { return true; }
bool audio_capture_start(void) { return true; }
int audio_capture_read(uint8_t *buf, int len) {           /* 16 kHz mono 16-bit silence, paced (Task 11: WAV) */
    vTaskDelay(pdMS_TO_TICKS(len / 32 > 0 ? len / 32 : 1));
    memset(buf, 0, (size_t)len);
    return len;
}
void audio_capture_stop(void) {}
uint32_t audio_capture_overruns(void) { return 0; }

void audio_notify_init(void) {
    atomic_store(&muted, config_load_muted());
    if (atomic_load(&muted)) config_save_muted(true);
    ESP_LOGI("audio", "notifications %s", atomic_load(&muted) ? "muted" : "audible");
}
bool audio_notify_is_muted(void) { return atomic_load(&muted); }
bool audio_notify_set_muted(bool m) { atomic_store(&muted, m); return config_save_muted(m); }
void audio_notify_done(void) {
    if (atomic_load(&muted)) return;
    atomic_fetch_add(&beeps, 1);
    if (!g_sim.headless) fputs("\a", stderr);
}
unsigned sim_audio_beeps(void) { return atomic_load(&beeps); }
bool sim_audio_load_wav(const char *path) { (void)path; return false; }   /* Task 11 */
```

(Check `config_load_muted` / `config_save_muted` signatures in `F/config_store.h`; `audio_capture.c` calls exactly these.)

- [ ] **Step 8: `S/core/link_sim.c`** — `cable_link.h` over an fd. **fd ownership:** install, close and every write happen under `tx_lock`; only the reader task closes; the reader reads `fd` without the lock because nobody else changes it after start. Write deadlines start before taking the lock and are re-checked after every partial write:

```c
#include <errno.h>
#include <poll.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>
#include "cable_frame.h"
#include "cable_link.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "rtos_sim.h"
#include "sim.h"

#define READ_WAIT_MS 100
#define FRAME_IDLE_US INT64_C(15000000)
#define WRITE_WAIT_MS 100
#define LOG_WRITE_WAIT_MS 5
#define LOG_LINE_MAX 512

static cable_decoder_t decoder;              /* reader-owned */
static cable_frame_cb s_cb;
static cable_tick_cb s_tick;
static void *s_ctx;
static atomic_bool running, connected;
static SemaphoreHandle_t tx_lock;            /* owns `fd` */
static int fd = -1;
static int early_fd = -1;                    /* installed before cable_link_start (script mode) */
static uint8_t tx_frame[CABLE_MAX_FRAME];
static _Atomic(vprintf_like_t) prev_vprintf = vprintf;
static atomic_bool log_framing;
static atomic_uint dropped_logs;
static FILE *record_f;

/* The one write the link performs. Tests replace it to force a short write or EAGAIN deterministically. */
ssize_t (*sim_link_write)(int, const void *, size_t) = write;

void sim_link_use_fd(int f) {
    if (!tx_lock) { early_fd = f; return; }
    xSemaphoreTake(tx_lock, portMAX_DELAY);
    fd = f; atomic_store(&connected, f >= 0);
    xSemaphoreGive(tx_lock);
}
bool sim_link_connected(void) { return atomic_load(&connected); }

static void drop(void) {                     /* reader task only */
    xSemaphoreTake(tx_lock, portMAX_DELAY);
    if (fd >= 0) close(fd);
    fd = -1; atomic_store(&connected, false);
    xSemaphoreGive(tx_lock);
    cable_decoder_reset(&decoder);
}

static int ms_left(int64_t deadline_us) {
    int64_t left = deadline_us - esp_timer_get_time();
    return left <= 0 ? 0 : (int)((left + 999) / 1000);
}

/* Caller holds tx_lock. Whole frame before the deadline, or false. A frame cut short would leave the
 * stream mid-frame, so the socket is shut down: the reader sees EOF, drops it and reconnects. */
static bool write_all(const uint8_t *buf, size_t len, int64_t deadline_us) {
    if (fd < 0) return false;
    size_t off = 0;
    while (off < len && esp_timer_get_time() < deadline_us) {
        ssize_t n = sim_link_write(fd, buf + off, len - off);
        if (n > 0) { off += (size_t)n; continue; }
        if (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) break;
        struct pollfd p = { .fd = fd, .events = POLLOUT };
        poll(&p, 1, ms_left(deadline_us));
    }
    if (off == len) return true;
    if (off > 0) shutdown(fd, SHUT_RDWR);
    return false;
}

static bool send_locked(uint8_t type, const uint8_t *payload, size_t len, int64_t deadline_us) {
    int n = cable_frame_encode(type, payload, len, tx_frame, sizeof tx_frame);
    return n >= 0 && write_all(tx_frame, (size_t)n, deadline_us);
}

static int log_vprintf(const char *fmt, va_list args) {
    if (!atomic_load(&log_framing)) return atomic_load(&prev_vprintf)(fmt, args);
    static char line[LOG_LINE_MAX];          /* guarded by tx_lock */
    int64_t deadline = esp_timer_get_time() + LOG_WRITE_WAIT_MS * 1000;
    if (!running || xSemaphoreGetMutexHolder(tx_lock) == xTaskGetCurrentTaskHandle() ||
        xSemaphoreTake(tx_lock, pdMS_TO_TICKS(LOG_WRITE_WAIT_MS)) != pdTRUE) {
        atomic_fetch_add(&dropped_logs, 1);
        return 0;
    }
    int n = vsnprintf(line, sizeof line, fmt, args);
    if (n > 0) {
        size_t len = (size_t)n < sizeof line - 1 ? (size_t)n : sizeof line - 1;
        while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r')) len--;
        if (len > 0 && !send_locked(CABLE_TYPE_LOG, (const uint8_t *)line, len, deadline))
            atomic_fetch_add(&dropped_logs, 1);
    }
    xSemaphoreGive(tx_lock);
    return n;
}

void cable_link_set_log_framing(bool on) {
    if (!running) return;
    if (on) {
        if (!atomic_load(&log_framing)) { atomic_store(&prev_vprintf, esp_log_set_vprintf(log_vprintf)); atomic_store(&log_framing, true); }
        return;
    }
    if (atomic_exchange(&log_framing, false)) esp_log_set_vprintf(atomic_load(&prev_vprintf));
}

__attribute__((weak)) void sim_link_connect_step(void) {}   /* Task 9 provides the TCP one */

static void record_cb(uint8_t ver, uint8_t type, const uint8_t *p, size_t n, void *ctx) {
    if (record_f && type == CABLE_TYPE_JSON) { fprintf(record_f, "{\"frame\": %.*s}\n", (int)n, (const char *)p); fflush(record_f); }
    s_cb(ver, type, p, n, ctx);
}

static void reader_task(void *arg) {
    (void)arg;
    uint8_t chunk[256];
    int64_t last_rx_us = 0;
    for (;;) {
        sim_link_connect_step();
        int f = fd;                          /* only this task changes fd after start */
        int n = 0;
        if (f >= 0) {
            struct pollfd p = { .fd = f, .events = POLLIN };
            sim_rtos_park_begin();
            int r = poll(&p, 1, READ_WAIT_MS);
            sim_rtos_park_end();
            if (r > 0) {
                n = (int)read(f, chunk, sizeof chunk);
                if (n == 0 || (n < 0 && errno != EAGAIN && errno != EINTR)) { drop(); ESP_LOGW("cable_link", "link closed"); }
                if (n < 0) n = 0;
            }
        } else vTaskDelay(pdMS_TO_TICKS(READ_WAIT_MS));
        const int64_t now = esp_timer_get_time();
        if (decoder.len && now - last_rx_us >= FRAME_IDLE_US) cable_decoder_reset(&decoder);
        if (n > 0) { cable_decoder_feed(&decoder, chunk, (size_t)n, record_cb, s_ctx); last_rx_us = now; }
        if (s_tick) s_tick(s_ctx);
    }
}

bool cable_link_start(cable_frame_cb cb, cable_tick_cb tick, void *ctx) {
    if (running) return true;
    s_cb = cb; s_tick = tick; s_ctx = ctx;
    cable_decoder_init(&decoder);
    record_f = g_sim.record ? fopen(g_sim.record, "a") : NULL;
    tx_lock = xSemaphoreCreateMutex();
    fd = early_fd; atomic_store(&connected, fd >= 0);
    running = true;
    xTaskCreate(reader_task, "cable_link", 6144, NULL, 5, NULL);
    ESP_LOGI("cable_link", "sim link up (frame v%d)", CABLE_FRAME_VERSION);
    return true;
}

bool cable_link_send(uint8_t type, const uint8_t *payload, size_t len) {
    if (!running) return false;
    int64_t deadline = esp_timer_get_time() + WRITE_WAIT_MS * 1000;
    if (xSemaphoreTake(tx_lock, pdMS_TO_TICKS(WRITE_WAIT_MS)) != pdTRUE) return false;
    bool ok = send_locked(type, payload, len, deadline);
    xSemaphoreGive(tx_lock);
    return ok;
}

bool cable_link_host_present(void) { return running && atomic_load(&connected); }
void cable_link_counters(uint32_t *c, uint32_t *d) { if (c) *c = decoder.corrupt_frames; if (d) *d = decoder.discarded_bytes; }
uint32_t cable_link_dropped_logs(void) { return atomic_load(&dropped_logs); }
void cable_link_reset_decoder(void) { cable_decoder_reset(&decoder); }
```

- [ ] **Step 9: `S/core/image.c`, `S/core/settle.c`, `S/front/headless.c`**:

```c
// image.c
#include <stdlib.h>
#include "sim.h"
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h"

static uint8_t rgb[SIM_W * SIM_H * 3];
static void grab(void) { sim_display_copy_rgb888(rgb, SIM_W * 3); }
static bool in_circle(int x, int y) { int dx = 2 * x + 1 - SIM_W, dy = 2 * y + 1 - SIM_H; return dx * dx + dy * dy <= SIM_W * SIM_W; }

bool sim_png_write(const char *path) {
    grab();
    for (int y = 0; y < SIM_H; y++) for (int x = 0; x < SIM_W; x++)
        if (!in_circle(x, y)) { uint8_t *p = rgb + (y * SIM_W + x) * 3; p[0] = p[1] = p[2] = 0; }
    return stbi_write_png(path, SIM_W, SIM_H, 3, rgb, SIM_W * 3) != 0;
}

static double ratio(bool (*match)(const uint8_t *, uint32_t), uint32_t arg) {
    grab();
    long hit = 0, all = 0;
    for (int y = 0; y < SIM_H; y++) for (int x = 0; x < SIM_W; x++) if (in_circle(x, y)) {
        all++; if (match(rgb + (y * SIM_W + x) * 3, arg)) hit++;
    }
    return all ? (double)hit / (double)all : 0;
}
static bool eq(const uint8_t *p, uint32_t c) { return p[0] == (c >> 16 & 0xff) && p[1] == (c >> 8 & 0xff) && p[2] == (c & 0xff); }
static bool lit(const uint8_t *p, uint32_t c) { (void)c; return p[0] | p[1] | p[2]; }
double sim_ratio_in_circle(uint32_t c) { return ratio(eq, c); }
double sim_ratio_nonblack(void) { return ratio(lit, 0); }
```

```c
// settle.c — "nothing is happening": every tracked task parked (inside a shim wait or a bracketed poll)
// and no frame presented for settle_ms, held for 20 ms. A heuristic by design (spec §4.9).
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "rtos_sim.h"
#include "sim.h"

bool sim_settle(int settle_ms, int timeout_ms) {
    int64_t start = esp_timer_get_time(), quiet_since = 0;
    for (;;) {
        int64_t now = esp_timer_get_time();
        bool quiet = sim_rtos_all_parked() && now - sim_display_last_present_us() >= (int64_t)settle_ms * 1000;
        if (quiet) { if (!quiet_since) quiet_since = now; if (now - quiet_since >= 20000) return true; }
        else quiet_since = 0;
        if (now - start >= (int64_t)timeout_ms * 1000) return false;
        vTaskDelay(pdMS_TO_TICKS(5));
    }
}
```

```c
// front/headless.c — no window: a frame is "on glass" once display_core copied it.
#ifndef SIM_HAS_SDL
#include <unistd.h>
#include "sim.h"
void sim_front_init(void) {}
void sim_front_present(const uint16_t *fb, uint32_t seq) { (void)fb; (void)seq; }
int sim_front_run(void) { for (;;) pause(); }   /* a script, when given, exits the process itself */
#endif
```

- [ ] **Step 10: `S/fixtures/nvs-defaults.json`** — explicit render inputs for headless runs only. Namespace `"pair"` is `F/config_store.c:10`; keys from that file. Brightness 255 makes the palette's canvas exactly `#181818` (the default 0x99 would dim it):

```json
{
  "pair": {
    "bright": { "u8": 255 },
    "muted": { "u8": 1 },
    "habitat": { "u8": 0 },
    "habitat_char": { "u8": 0 },
    "scrollrev": { "u8": 0 },
    "swiperev": { "u8": 0 }
  },
  "sim": { "mac": { "str": "02:51:4D:00:00:01" } }
}
```

Profiles never read this file (see `sim_main.c`): a fresh profile starts empty and generates its own MAC.

- [ ] **Step 11: `S/core/script.c`** — headless scenario runner. It waits until the firmware finished booting (the `proj_refresh` task exists — `F/app_main.c:234`), then plays the daemon over one end of a socketpair. Input steps return only after the touch/key task consumed them. Unknown steps or unknown assert keys fail the scenario:

```c
#include <errno.h>
#include <poll.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "cJSON.h"
#include "cable_frame.h"
#include "esp_sim.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "rtos_sim.h"
#include "sim.h"

static int dfd;
static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static cJSON *seen;           /* device→daemon JSON messages, in order */
static int cursor;            /* first message not yet matched by an `expect` */
static cJSON *auto_replies;   /* [{on, reply, reply_copy}] answered whenever the device asks */
static int line_no;

static void fail(const char *why) { fprintf(stderr, "scenario line %d: %s\n", line_no, why); exit(1); }

/* Runner and auto-replies (reader thread) both send: encode and write under one lock. */
static void send_json(const cJSON *msg) {
    static uint8_t frame[CABLE_MAX_FRAME];
    static pthread_mutex_t wmu = PTHREAD_MUTEX_INITIALIZER;
    char *text = cJSON_PrintUnformatted(msg);
    pthread_mutex_lock(&wmu);
    int n = cable_frame_encode(CABLE_TYPE_JSON, (const uint8_t *)text, strlen(text), frame, sizeof frame);
    bool ok = n >= 0;
    for (size_t off = 0; ok && off < (size_t)n;) {
        ssize_t w = write(dfd, frame + off, (size_t)n - off);
        if (w > 0) off += (size_t)w;
        else if (!(w < 0 && errno == EINTR)) ok = false;
    }
    pthread_mutex_unlock(&wmu);
    free(text);
    if (!ok) fail("could not send frame");
}

static void reply_to(const cJSON *m, const cJSON *reply, const cJSON *copy) {
    cJSON *r = cJSON_Duplicate(reply, 1), *k;
    cJSON_ArrayForEach(k, copy) {
        cJSON *src = cJSON_GetObjectItemCaseSensitive(m, k->valuestring);
        if (!src) continue;
        cJSON_DeleteItemFromObjectCaseSensitive(r, k->valuestring);
        cJSON_AddItemToObject(r, k->valuestring, cJSON_Duplicate(src, 1));
    }
    send_json(r); cJSON_Delete(r);
}

static void on_frame(uint8_t ver, uint8_t type, const uint8_t *p, size_t n, void *ctx) {
    (void)ver; (void)ctx;
    if (type != CABLE_TYPE_JSON) return;
    cJSON *m = cJSON_ParseWithLength((const char *)p, n);
    if (!m) return;
    const cJSON *t = cJSON_GetObjectItemCaseSensitive(m, "t");
    pthread_mutex_lock(&mu);
    cJSON *a;
    cJSON_ArrayForEach(a, auto_replies) {
        const cJSON *on = cJSON_GetObjectItemCaseSensitive(a, "on");
        if (cJSON_IsString(t) && cJSON_IsString(on) && !strcmp(t->valuestring, on->valuestring))
            reply_to(m, cJSON_GetObjectItemCaseSensitive(a, "reply"), cJSON_GetObjectItemCaseSensitive(a, "reply_copy"));
    }
    cJSON_AddItemToArray(seen, m);
    pthread_mutex_unlock(&mu);
}

static void *device_reader(void *arg) {
    (void)arg;
    static cable_decoder_t d; cable_decoder_init(&d);
    uint8_t buf[4096];
    for (;;) {
        ssize_t n = read(dfd, buf, sizeof buf);
        if (n <= 0) return NULL;
        cable_decoder_feed(&d, buf, (size_t)n, on_frame, NULL);
    }
}

static cJSON *wait_for(const char *t, int timeout_ms) {
    int64_t end = esp_timer_get_time() + (int64_t)timeout_ms * 1000;
    while (esp_timer_get_time() < end) {
        pthread_mutex_lock(&mu);
        int size = cJSON_GetArraySize(seen);
        for (int i = cursor; i < size; i++) {
            cJSON *m = cJSON_GetArrayItem(seen, i);
            cJSON *mt = cJSON_GetObjectItemCaseSensitive(m, "t");
            if (cJSON_IsString(mt) && strcmp(mt->valuestring, t) == 0) { cursor = i + 1; pthread_mutex_unlock(&mu); return m; }
        }
        pthread_mutex_unlock(&mu);
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    return NULL;
}

static sim_key_t key_of(const char *k) {
    if (!strcmp(k, "B")) return SIM_KEY_BOOT;
    if (!strcmp(k, "P")) return SIM_KEY_PWR;
    if (!strcmp(k, "V")) return SIM_KEY_VOICE;
    fail("unknown key"); return SIM_KEY_BOOT;
}

static void check(cJSON *a) {
    char why[256];
    if (!strcmp(a->string, "log")) {
        if (!sim_log_contains(a->valuestring)) { snprintf(why, sizeof why, "no log line containing '%s'", a->valuestring); fail(why); }
    } else if (!strcmp(a->string, "no_log")) {
        if (sim_log_contains(a->valuestring)) { snprintf(why, sizeof why, "unexpected log line containing '%s'", a->valuestring); fail(why); }
    } else if (!strcmp(a->string, "text")) {
        if (!sim_display_find_text(a->valuestring, NULL, NULL)) { snprintf(why, sizeof why, "no text '%s' on screen (run with --dump-scene)", a->valuestring); fail(why); }
    } else if (!strcmp(a->string, "canvas_min")) {
        double r = sim_ratio_in_circle(0x181818);   /* HT_THEME_CANVAS; the wrong byte order reads as purple */
        if (r < a->valuedouble) { snprintf(why, sizeof why, "canvas ratio %.3f < %.3f", r, a->valuedouble); fail(why); }
    } else if (!strcmp(a->string, "nonblack_min")) {
        double r = sim_ratio_nonblack();
        if (r < a->valuedouble) { snprintf(why, sizeof why, "non-black ratio %.3f < %.3f", r, a->valuedouble); fail(why); }
    } else { snprintf(why, sizeof why, "unknown assert '%s'", a->string); fail(why); }
}

static void tap_at(int x, int y) {
    sim_pointer_set(true, x, y); sim_touch_sync();
    sim_pointer_set(false, x, y); sim_touch_sync();
}

static void step(cJSON *s) {
    cJSON *v;
    if ((v = cJSON_GetObjectItemCaseSensitive(s, "frame"))) send_json(v);
    else if ((v = cJSON_GetObjectItemCaseSensitive(s, "wait_ms"))) vTaskDelay(pdMS_TO_TICKS(v->valueint));
    else if (cJSON_GetObjectItemCaseSensitive(s, "settle")) {
        if (!sim_settle(g_sim.settle_ms, g_sim.settle_timeout_ms)) fail("did not settle");
    } else if ((v = cJSON_GetObjectItemCaseSensitive(s, "touch"))) {
        sim_pointer_set(cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(v, "down")),
                        cJSON_GetObjectItemCaseSensitive(v, "x")->valueint, cJSON_GetObjectItemCaseSensitive(v, "y")->valueint);
        sim_touch_sync();
    } else if ((v = cJSON_GetObjectItemCaseSensitive(s, "tap_text"))) {
        int x, y;
        if (!sim_display_find_text(v->valuestring, &x, &y)) { char why[160]; snprintf(why, sizeof why, "nothing to tap: no text '%s' (run with --dump-scene)", v->valuestring); fail(why); }
        tap_at(x, y);
    } else if ((v = cJSON_GetObjectItemCaseSensitive(s, "hold_text"))) {
        int x, y;
        cJSON *ms = cJSON_GetObjectItemCaseSensitive(s, "ms");
        if (!sim_display_find_text(v->valuestring, &x, &y)) { char why[160]; snprintf(why, sizeof why, "nothing to hold: no text '%s' (run with --dump-scene)", v->valuestring); fail(why); }
        sim_pointer_set(true, x, y); sim_touch_sync();
        vTaskDelay(pdMS_TO_TICKS(ms ? ms->valueint : 900));
        sim_pointer_set(false, x, y); sim_touch_sync();
    } else if ((v = cJSON_GetObjectItemCaseSensitive(s, "drag"))) {
        /* {"drag": {"from": [x, y], "to": [x, y], "steps": 8}} — a finger moving in even steps */
        cJSON *from = cJSON_GetObjectItemCaseSensitive(v, "from"), *to = cJSON_GetObjectItemCaseSensitive(v, "to");
        cJSON *st = cJSON_GetObjectItemCaseSensitive(v, "steps");
        int steps = st ? st->valueint : 8;
        int x0 = cJSON_GetArrayItem(from, 0)->valueint, y0 = cJSON_GetArrayItem(from, 1)->valueint;
        int x1 = cJSON_GetArrayItem(to, 0)->valueint, y1 = cJSON_GetArrayItem(to, 1)->valueint;
        for (int i = 0; i <= steps; i++) {
            sim_pointer_set(true, x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps);
            sim_touch_sync();
        }
        sim_pointer_set(false, x1, y1); sim_touch_sync();
    } else if ((v = cJSON_GetObjectItemCaseSensitive(s, "key"))) {
        sim_key_set(key_of(v->valuestring), cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(s, "down")));
        sim_keys_sync();
    } else if ((v = cJSON_GetObjectItemCaseSensitive(s, "auto_reply"))) {
        pthread_mutex_lock(&mu); cJSON_AddItemToArray(auto_replies, cJSON_Duplicate(v, 1)); pthread_mutex_unlock(&mu);
    } else if ((v = cJSON_GetObjectItemCaseSensitive(s, "expect"))) {
        cJSON *to = cJSON_GetObjectItemCaseSensitive(s, "timeout_ms");
        cJSON *m = wait_for(v->valuestring, to ? to->valueint : 5000);
        if (!m) { char why[128]; snprintf(why, sizeof why, "device never sent '%s'", v->valuestring); fail(why); }
        cJSON *reply = cJSON_GetObjectItemCaseSensitive(s, "reply");
        if (reply) reply_to(m, reply, cJSON_GetObjectItemCaseSensitive(s, "reply_copy"));
    } else if ((v = cJSON_GetObjectItemCaseSensitive(s, "shot"))) {
        if (!sim_png_write(v->valuestring)) fail("png write failed");
    } else if ((v = cJSON_GetObjectItemCaseSensitive(s, "assert"))) {
        cJSON *a; cJSON_ArrayForEach(a, v) check(a);
    } else fail("unknown step");
}

static void runner(void *arg) {
    FILE *f = arg;
    sim_rtos_mark_untracked();
    for (int i = 0; i < 1000 && !xTaskGetHandle("proj_refresh"); i++) vTaskDelay(pdMS_TO_TICKS(10));
    if (!xTaskGetHandle("proj_refresh")) fail("firmware did not finish booting (no proj_refresh task)");
    char line[16384];
    while (fgets(line, sizeof line, f)) {
        line_no++;
        if (line[0] == '\n' || line[0] == '#') continue;
        cJSON *s = cJSON_Parse(line);
        if (!s) fail("bad JSON");
        step(s);
        cJSON_Delete(s);
    }
    if (!g_sim.allow_errors && sim_log_error_count()) { fprintf(stderr, "firmware logged %u error(s)\n", sim_log_error_count()); exit(1); }
    if (g_sim.shot && !sim_png_write(g_sim.shot)) exit(1);
    exit(0);
}

void sim_script_start(int daemon_end) {
    dfd = daemon_end;
    seen = cJSON_CreateArray();
    auto_replies = cJSON_CreateArray();
    FILE *f = fopen(g_sim.script, "r");
    if (!f) { perror(g_sim.script); exit(2); }
    pthread_t t; pthread_create(&t, NULL, device_reader, NULL); pthread_detach(t);
    sim_rtos_spawn(runner, "sim_script", f, false);
}
```

(cJSON ≥ 1.7.13 has `cJSON_ParseWithLength`; the IDF copy does. The daemon end `dfd` stays blocking: the script is the daemon and may wait. `reply_to` from `on_frame` runs on the reader thread; `send_json` serialises writers with `wmu`.)

- [ ] **Step 12: `S/sim_main.c`**:

```c
#include <fcntl.h>
#include <getopt.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>
#include "esp_sim.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "rtos_sim.h"
#include "sim.h"

sim_options_t g_sim = { .port = 18474, .scale = 1, .settle_ms = 150, .settle_timeout_ms = 5000 };
void app_main(void);

static void app_task(void *arg) { (void)arg; app_main(); }

static void usage(void) {
    fputs("harness-sim [--headless] [--port N] [--script F.jsonl] [--shot F.png] [--profile NAME]\n"
          "            [--factory-reset] [--scale N] [--settle-ms N] [--settle-timeout N] [--allow-errors]\n"
          "            [--dump-scene] [--voice-wav F.wav] [--voice-text TEXT] [--record F.jsonl] [--log-level 0-5]\n", stderr);
    exit(2);
}

static void device_socket(int s) {
    int one = 1;
    setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
    fcntl(s, F_SETFL, fcntl(s, F_GETFL) | O_NONBLOCK);   /* write budgets apply, as on TCP */
}

int main(int argc, char **argv) {
    static struct option opts[] = {
        {"headless", no_argument, 0, 'H'}, {"port", required_argument, 0, 'p'}, {"script", required_argument, 0, 's'},
        {"shot", required_argument, 0, 'o'}, {"profile", required_argument, 0, 'P'}, {"factory-reset", no_argument, 0, 'F'},
        {"scale", required_argument, 0, 'x'}, {"settle-ms", required_argument, 0, 'm'}, {"settle-timeout", required_argument, 0, 't'},
        {"allow-errors", no_argument, 0, 'E'}, {"dump-scene", no_argument, 0, 'D'}, {"voice-wav", required_argument, 0, 'w'},
        {"voice-text", required_argument, 0, 'T'}, {"record", required_argument, 0, 'r'}, {"log-level", required_argument, 0, 'l'},
        {0, 0, 0, 0}};
    int c;
    while ((c = getopt_long(argc, argv, "", opts, NULL)) != -1) switch (c) {
        case 'H': g_sim.headless = true; break;
        case 'p': g_sim.port = atoi(optarg); break;
        case 's': g_sim.script = optarg; break;
        case 'o': g_sim.shot = optarg; break;
        case 'P': g_sim.profile = optarg; break;
        case 'F': g_sim.factory_reset = true; break;
        case 'x': g_sim.scale = atoi(optarg); break;
        case 'm': g_sim.settle_ms = atoi(optarg); break;
        case 't': g_sim.settle_timeout_ms = atoi(optarg); break;
        case 'E': g_sim.allow_errors = true; break;
        case 'D': g_sim.dump_scene = true; break;
        case 'w': g_sim.voice_wav = optarg; break;
        case 'T': g_sim.voice_text = optarg; break;
        case 'r': g_sim.record = optarg; break;
        case 'l': sim_log_set_level(atoi(optarg)); break;
        default: usage();
    }
    if (g_sim.script && !g_sim.headless) { fputs("--script requires --headless\n", stderr); return 2; }

    sim_app_set_version(SIM_FW_VERSION);
    if (g_sim.profile) {                      /* persisted, starts empty: its own MAC, its own settings */
        char dir[1024], persist[1100];
        const char *home = getenv("HOME");
        snprintf(dir, sizeof dir, "%s/.harness-sim", home); mkdir(dir, 0755);
        snprintf(dir, sizeof dir, "%s/.harness-sim/%s", home, g_sim.profile); mkdir(dir, 0755);
        snprintf(persist, sizeof persist, "%s/nvs.json", dir);
        sim_nvs_configure(persist, NULL);
    } else {
        sim_nvs_configure(NULL, SIM_FIXTURES "/nvs-defaults.json");   /* ephemeral, deterministic */
    }

    sim_front_init();                         /* window up before the firmware can present */
    if (g_sim.script) {
        int sv[2];
        if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0) { perror("socketpair"); return 1; }
        device_socket(sv[0]);
        int one = 1; setsockopt(sv[1], SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
        sim_link_use_fd(sv[0]);
        sim_script_start(sv[1]);
    }
    sim_rtos_spawn(app_task, "main", NULL, true);
    return sim_front_run();
}
```

- [ ] **Step 13: CMake — firmware manifest, core, executable, tests** (append to `S/CMakeLists.txt`):

```cmake
include(FetchContent)
FetchContent_Declare(stb GIT_REPOSITORY https://github.com/nothings/stb.git
                     GIT_TAG 5c205738c191bcb0abc65c4febfa9bd25ff35234)
FetchContent_Populate(stb)

execute_process(COMMAND git rev-parse --short HEAD WORKING_DIRECTORY ${SIM}
                OUTPUT_VARIABLE SIM_SHA OUTPUT_STRIP_TRAILING_WHITESPACE)

# Firmware sources compiled as-is. Explicit: a new firmware file is a conscious addition here.
# Mirrors F/CMakeLists.txt BOARD_SRCS minus the replaced drivers: cable_link.c, display_habitat.c,
# touch_habitat.c, board/*.c, ptt.c, audio_capture.c, audio_probe.c, fw_update.c, last_words.c, device_mac.c.
set(FW_SRCS
    ${FW}/app_main.c ${FW}/ram_telemetry.c ${FW}/config_store.c
    ${FW}/cable_frame.c ${FW}/cable_client.c ${FW}/cable_machines.c ${FW}/cable_scroll.c
    ${FW}/cable_json_guard.c ${FW}/cable_features.c
    ${FW}/audio_client_habitat.c ${FW}/voice_buffer.c
    ${FW}/ui/ui_perf.c
    ${FW}/ui/habitat/ui_habitat.c ${FW}/ui/habitat/terminal.c ${FW}/ui/habitat/scroll.c
    ${FW}/ui/habitat/workspace.c ${FW}/ui/habitat/selection.c ${FW}/ui/habitat/carry.c
    ${FW}/ui/habitat/visit.c ${FW}/ui/habitat/form.c ${FW}/ui/habitat/draft.c
    ${FW}/ui/habitat/gestures.c ${FW}/ui/habitat/tim.c ${FW}/ui/habitat/character.c
    ${FW}/ui/habitat/character_motion.c ${FW}/ui/habitat/character_layout.c ${FW}/ui/habitat/tux.c
    ${FW}/ui/habitat/focus.c ${FW}/ui/habitat/octopus.c ${FW}/ui/habitat/ascii_clip.c
    ${FW}/ui/habitat/octopus_font.c ${FW}/ui/habitat/command_face.c ${FW}/ui/habitat/fonts.c)

set(SIM_CORE ${SIM}/core/stubs.c ${SIM}/core/display_core.c ${SIM}/core/touch_core.c
    ${SIM}/core/input_keys.c ${SIM}/core/audio_sim.c ${SIM}/core/link_sim.c ${SIM}/core/image.c
    ${SIM}/core/settle.c ${SIM}/core/script.c)

add_library(simfw STATIC ${FW_SRCS})
target_include_directories(simfw PUBLIC ${FW_INC} ${SIM}/core)
target_compile_options(simfw PRIVATE ${FW_WARN})
target_link_libraries(simfw PUBLIC simshims m)

add_library(simcore STATIC ${SIM_CORE})
target_include_directories(simcore PUBLIC ${FW_INC} ${SIM}/core ${stb_SOURCE_DIR})
target_compile_options(simcore PRIVATE ${SIM_WARN} -Wno-missing-field-initializers)
set_source_files_properties(${SIM}/core/image.c PROPERTIES COMPILE_OPTIONS "-Wno-error")
target_link_libraries(simcore PUBLIC simfw)

# The two archives reference each other (drivers ↔ UI). Force-load both so link order does not matter.
if(APPLE)
    set(SIM_LIBS "-Wl,-force_load,$<TARGET_FILE:simcore>" "-Wl,-force_load,$<TARGET_FILE:simfw>" simcore simfw)
else()
    set(SIM_LIBS -Wl,--whole-archive simcore simfw -Wl,--no-whole-archive simshims simcjson Threads::Threads m)
endif()

add_executable(harness-sim ${SIM}/sim_main.c ${SIM}/front/headless.c)
target_compile_definitions(harness-sim PRIVATE SIM_FW_VERSION="sim-${SIM_SHA}" SIM_FIXTURES="${SIM}/fixtures")
target_compile_options(harness-sim PRIVATE ${SIM_WARN})
target_link_libraries(harness-sim ${SIM_LIBS})

# test_mac links the core but supplies its own sim_front_present; app_main is linked but never called.
add_executable(test_mac ${SIM}/test/test_mac.c)
target_link_libraries(test_mac ${SIM_LIBS})
add_test(NAME mac COMMAND test_mac)

add_test(NAME scenarios COMMAND bash ${SIM}/test/run_scenarios.sh $<TARGET_FILE:harness-sim>)
```

`-force_load` loads every object, so a test that defines `sim_front_present` itself must not also link `front/headless.c` (it doesn't — the front is a source of `harness-sim` only). `script.c` is in the core, so `sim_main.c` links in this task already.

- [ ] **Step 14: Build, iterate on link errors with shims only**

Run: `ninja -C devices/harness-device/sim/build harness-sim test_mac 2>&1 | tee /tmp/sim-link.log`

Expected first time: undefined symbols and/or missing headers. For each:
- missing ESP/FreeRTOS header or symbol → add it to the matching shim header/`.c` with real semantics (never an empty body for sync/alloc);
- missing firmware-driver symbol (from a replaced file) → add it to the right `core/*.c` with the device behaviour;
- a firmware file needing an edit → **stop** and record why in `S/README.md` "Firmware edits"; prefer a shim.
Repeat until it links. Then list the shim surface for the README: `nm -u devices/harness-device/sim/build/CMakeFiles/simfw.dir/**/*.o | sort -u`.

Run: `ctest --test-dir devices/harness-device/sim/build -R mac --output-on-failure` → PASS.

- [ ] **Step 15: First scenario — boot without a host**

`S/test/scenarios/boot-no-host.jsonl` (the device sends `hello` but no daemon answers):

```json
{"expect": "hello", "timeout_ms": 5000}
{"settle": true}
{"shot": "boot-no-host.png"}
{"assert": {"canvas_min": 0.30, "nonblack_min": 0.30, "no_log": "abort"}}
```

`S/test/run_scenarios.sh`:

```bash
#!/usr/bin/env bash
# Replays every scenario headless; each must settle, pass its asserts and log no errors.
set -euo pipefail
bin="$1"; dir="$(cd "$(dirname "$0")" && pwd)/scenarios"; out="${2:-$(mktemp -d)}"
mkdir -p "$out"
fail=0
for s in "$dir"/*.jsonl; do
  name="$(basename "$s" .jsonl)"
  if (cd "$out" && "$bin" --headless --script "$s" --log-level 2 > "$name.log" 2>&1); then
    echo "ok   $name"
  else
    echo "FAIL $name (see $out/$name.log)"; fail=1
  fi
done
echo "shots in $out"
exit $fail
```

Run: `chmod +x devices/harness-device/sim/test/run_scenarios.sh && ninja -C devices/harness-device/sim/build && ctest --test-dir devices/harness-device/sim/build -R scenarios --output-on-failure`

Expected: `ok boot-no-host`. **Open the PNG**: dark-grey face, not purple. If `canvas_min` fails, first confirm the image is right, then (only then) lower the threshold with a one-line `#` comment in the scenario saying what the screen shows. A purple image means the byte swap in `sim_display_copy_rgb888` is wrong — fix that, never the threshold.

- [ ] **Step 16: Commit**

```bash
git add devices/harness-device/sim
git commit -m "feat(device): compile the real firmware UI on the host with simulated drivers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Scenarios from the real cable session — agents, question, permission, model picker

**Files:**
- Create: `S/tools/gen-scenarios.ts`, `S/test/scenarios/{agents,turn-running,question,permission,models}.jsonl` (generated)
- Modify: none in C unless a scenario exposes a driver bug (fix the driver, not the scenario)

**Interfaces:**
- Consumes: script vocabulary from Task 7 (`frame`, `expect`, `reply`, `reply_copy`, `auto_reply`, `tap_text`, `hold_text`, `drag`, `touch`, `key`, `settle`, `shot`, `assert{log,no_log,text,canvas_min,nonblack_min}`), `--dump-scene`.
- Produces: generated scenarios whose every daemon frame is one `CableSession` actually sent, each with assertions on what the screen says.

The firmware flow these scenarios follow (from `F/cable_client.c:1180-1183`, `F/ui/habitat/ui_habitat.c:1570-1586`, `F/cable_client.c:370-376`): a `question` frame shows an alert for the agent; opening it sends `question.read {agentId, requestId}`; the daemon answers `question.state` for that `requestId`; the question view then shows the text and options. The model list: the device sends `models.list {request: n}` and waits up to 4 s for a reply carrying the same `request` (`F/cable_client.c:460-492`); without it it logs `models: no answer`.

- [ ] **Step 1: Write the generator** — `S/tools/gen-scenarios.ts`, run from `cli/` with `npx tsx`:

```ts
// Generates S/test/scenarios/*.jsonl from the real daemon session code: every frame a scenario feeds the
// simulator is one CableSession actually sent, including its replies to question.read and models.list.
// Run: cd cli && npx tsx ../devices/harness-device/sim/tools/gen-scenarios.ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CableDecoder, CableType, encodeCableFrame } from '../../../../cli/src/cable/cableFrame.js'
import { CableSession, type CableAgent, type CableHost, type CablePort } from '../../../../cli/src/cable/cableSession.js'
import { DialLog } from '../../../../cli/src/cable/dialLog.js'

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'scenarios')
const AGENTS: CableAgent[] = [
  { id: 'a1', name: 'Fix login screen', engine: 'claude' },
  { id: 'a2', name: 'Device firmware voice', engine: 'codex' },
]
const noop = () => {}
const host: CableHost = {
  localMachine: () => ({ id: 'mac-local', name: 'MacBook Pro' }),
  listMachines: async () => ({ machines: [{ id: 'mac-local', name: 'MacBook Pro', state: 'ready', local: true }], source: 'backend' }),
  selectedMachine: () => 'mac-local', selectMachine: async () => ({ ok: true }),
  listSwarms: () => ({ selected: '', swarms: [], tiles: [] }), listUnread: () => [], selectSwarm: noop,
  appName: () => 'harness', voiceLang: () => 'en', listAgents: async () => AGENTS, agentTotal: () => AGENTS.length,
  activeSwarm: () => 't1',
  describe: (id) => { const a = AGENTS.find((x) => x.id === id); return a ? { name: a.name, engine: a.engine ?? '', machine: '' } : undefined },
  sendTurn: noop, stopTurn: noop, scrolled: noop, answer: noop, focus: noop, openAgent: noop,
  forkAgent: async (id) => ({ ok: true, agentId: `${id}-fork` }), updateAgent: noop,
  listModels: async () => ['runtime-v1:s1:claude:opus@high', 'runtime-v1:s1:claude:sonnet@low'],
  recentSummaries: async () => [],
  transcribe: async () => 'fix the login screen', route: async () => ({ agentId: 'a1', confidence: 0.9, reason: 'fixture' }),
  log: noop,
} as CableHost

class Recorder implements CablePort {
  readonly path = 'recorder'
  isOpen = true
  readonly sent: Record<string, unknown>[] = []
  private dec = new CableDecoder()
  constructor(readonly onData: (c: Buffer) => void) {}
  async write(bytes: Uint8Array) { this.dec.feed(bytes, (f) => { if (f.type === CableType.Json) this.sent.push(JSON.parse(Buffer.from(f.payload).toString())) }) }
  async close() { this.isOpen = false }
  say(msg: object) { this.onData(Buffer.from(encodeCableFrame(CableType.Json, Buffer.from(JSON.stringify(msg))))) }
}

const until = async (ok: () => boolean) => { for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5)); if (!ok()) throw new Error('timed out') }

async function session(): Promise<{ s: CableSession; port: Recorder }> {
  let port!: Recorder
  const s = new CableSession(host, new DialLog(mkdtempSync(join(tmpdir(), 'gen-'))), async (onData) => (port = new Recorder(onData)))
  s.start()
  await until(() => !!port)
  port.say({ t: 'hello', product: 'harness', mac: 'gen', fw: 'gen', proto: 3 })
  await until(() => port.sent.some((m) => m.t === 'agents.end'))
  return { s, port }
}

/** The session's answer to a device request, captured by sending the request. */
async function answerTo(port: Recorder, request: Record<string, unknown>, t: string) {
  const mark = port.sent.length
  port.say(request)
  await until(() => port.sent.slice(mark).some((m) => m.t === t))
  return port.sent.slice(mark).find((m) => m.t === t)!
}

const lines = (steps: object[]) => steps.map((x) => JSON.stringify(x)).join('\n') + '\n'
const frames = (msgs: Record<string, unknown>[]) => msgs.map((m) => ({ frame: m }))

async function main() {
  const { s, port } = await session()
  const greeting = [...port.sent]
  const models = await answerTo(port, { t: 'models.list', agentId: 'a1', request: 1 }, 'models')
  // Every scenario answers the model list whenever the device asks. The device accepts a reply only for its
  // own agent and request serial (F/cable_client.c:429-431), so both are echoed from the request.
  const preamble = [
    { auto_reply: { on: 'models.list', reply: models, reply_copy: ['agentId', 'request'] } },
    { expect: 'hello', timeout_ms: 5000 },
    ...frames(greeting),
    { settle: true },
  ]
  const noModelStall = { no_log: 'models: no answer' }

  writeFileSync(join(out, 'agents.jsonl'), lines([
    ...preamble,
    { shot: 'agents.png' },
    { assert: { log: `agents: ${AGENTS.length}`, text: 'login', nonblack_min: 0.3, ...noModelStall } },
  ]))

  let mark = port.sent.length
  await s.turnStarted('a1', 'fixing the login screen')
  const running = port.sent.slice(mark)
  writeFileSync(join(out, 'turn-running.jsonl'), lines([
    ...preamble, ...frames(running), { settle: true }, { shot: 'turn-running.png' },
    { assert: { text: 'login', ...noModelStall } },
  ]))

  // The question view shows the prompt and a [choices] control; options are a separate screen, one at a
  // time, stepped by a vertical drag of 40+ px (F/ui/habitat/ui_habitat.c:972-1012, 1601-1613).
  for (const [name, agentId, id, prompt, options] of [
    ['question', 'a1', 'q1', 'Which scope?', ['File', 'Project']],
    ['permission', 'a2', 'p1', 'Allow Bash: rm -rf build/?', ['Allow', 'Deny']],
  ] as const) {
    mark = port.sent.length
    await s.question(agentId, id, [{ key: name, q: prompt, options: [...options], multi: false }])
    const alert = port.sent.slice(mark)
    const state = await answerTo(port, { t: 'question.read', agentId, requestId: 'FETCH' }, 'question.state')
    const agentWord = agentId === 'a1' ? 'login' : 'firmware'
    const promptWord = prompt.split(' ')[0]
    writeFileSync(join(out, `${name}.jsonl`), lines([
      ...preamble,
      ...frames(alert),
      { settle: true },
      { shot: `${name}-alert.png` },
      { tap_text: agentWord },                                   // open the alert on the agent's tile
      { expect: 'question.read', timeout_ms: 5000, reply: state, reply_copy: ['requestId', 'agentId'] },
      { settle: true },
      { shot: `${name}.png` },
      { assert: { text: promptWord, ...noModelStall } },
      { tap_text: '[choices]' },
      { settle: true },
      { assert: { text: options[0] } },
      { shot: `${name}-choice-1.png` },
      { drag: { from: [233, 330], to: [233, 200], steps: 10 } }, // finger up = next option (see Step 2)
      { settle: true },
      { assert: { text: options[1] } },
      { shot: `${name}-choice-2.png` },
    ]))
  }

  // The model picker: open the agent, open its actions, choose "Model"; the device asks for the list,
  // shows it, and a tap on a model sends agent.update with that model.
  writeFileSync(join(out, 'models.jsonl'), lines([
    ...preamble,
    { tap_text: 'login' },                                       // open agent a1
    { settle: true },
    { hold_text: 'login', ms: 900 },                             // its actions (see Step 2)
    { settle: true },
    { tap_text: 'Model' },
    { expect: 'models.list', timeout_ms: 5000 },                 // answered by the auto_reply
    { settle: true },
    { assert: { text: 'opus', ...noModelStall } },
    { shot: 'models.png' },
    { tap_text: 'sonnet' },
    { expect: 'agent.update', timeout_ms: 5000 },
    { settle: true },
    { assert: { no_log: 'models: no answer' } },
  ]))
  await s.stop()
}
await main()
```

Three UI facts the code does not pin down; Step 2 establishes each with `--dump-scene` and the scenario's own asserts, and the generator records the answer in a one-line comment. None may be "fixed" by weakening an assert:
- **How the alert opens.** `tap_text: agentWord` assumes the alert is reached by tapping the agent's tile, which shows part of its name. Run `harness-sim --headless --script …/question.jsonl --dump-scene` and read the runs printed after the `question` frame; if the alert is its own run, tap a word from that run instead.
- **Which way a drag steps options.** The scenario drags the finger up (y 330 → 200). If `assert text: options[1]` fails while `options[0]` is still shown, the sign is the other way: swap `from`/`to`, re-generate, and the assert must then pass.
- **How the actions menu opens.** `F/ui/habitat/ui_habitat.c:1038` lists the entry `{"Model", A_MODELS, 0}` in the agent's actions. The scenario opens them with a hold on the agent's name; if `tap_text: 'Model'` then reports "no text 'Model'", find in the dumped scene what the agent view offers (a control run such as "[actions]" or similar) and tap it instead. How the model is labelled (`opus`, `sonnet` from `listModels`) is checked the same way.

- [ ] **Step 2: Generate and run — expect failures to diagnose, not to tolerate**

Run:

```bash
cd cli && npx tsx ../devices/harness-device/sim/tools/gen-scenarios.ts && cd ..
ctest --test-dir devices/harness-device/sim/build -R scenarios --output-on-failure
```

Expected: `agents`, `turn-running` pass; `question`, `permission`, `models` may fail on the first run at a `tap_text`/`hold_text`/`drag` step or a `text` assert. Resolve per the three verification points above, re-generate, re-run until all pass. If `tsx` cannot resolve the relative `cli/src` imports, run from the repo root: `npx --prefix cli tsx --tsconfig cli/tsconfig.json devices/harness-device/sim/tools/gen-scenarios.ts`.

- [ ] **Step 3: Look at every shot** (the run prints the directory): `agents.png` shows the carousel, not the loading spinner (this is the `refresh_task` check, together with the `agents: 2` log assert); `question.png` shows "Which scope?" and `[choices]`, `question-choice-1.png` shows File, `question-choice-2.png` shows Project; the `permission*` shots show the command, then Allow, then Deny; `models.png` shows the model list. Assertions pass on scene text; the eye check catches rendering faults text cannot.

- [ ] **Step 4: Commit**

```bash
git add devices/harness-device/sim/tools devices/harness-device/sim/test/scenarios
git commit -m "test(device): simulator scenarios generated from the real cable session

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Live TCP link — connect/reconnect, device-sized buffers, proven write budgets

**Files:**
- Create: `S/core/link_tcp.c`, `S/test/test_link.c`
- Modify: `S/CMakeLists.txt` (add `link_tcp.c` to `SIM_CORE`, `test_link` target)

**Interfaces:**
- Consumes: `sim_link_use_fd`, `sim_link_connected`, weak `sim_link_connect_step` (Task 7).
- Consumes also: the `sim_link_write` test seam (Task 7).
- Produces: strong `void sim_link_connect_step(void);` — in live mode, when not connected and ≥ 2 s since the last attempt: non-blocking connect to `127.0.0.1:g_sim.port` (500 ms), then `O_NONBLOCK`, `TCP_NODELAY`, `SO_NOSIGPIPE`, `SO_SNDBUF` = 16 KiB (the device's own TX path is a 2 KiB FIFO — `USJ_TX_BUF`; a small buffer keeps "nobody is reading" observable instead of hidden in megabytes of kernel buffer); installs via `sim_link_use_fd`. Logs `waiting for daemon on 127.0.0.1:<port>` once per outage.

- [ ] **Step 1: Failing test** — `S/test/test_link.c`. It proves, separately: ticks while no daemon exists; attach once a daemon appears; each failed send respects its own budget; a partially written frame closes the connection (observed as EOF on the peer **before** the peer closes); reconnect with clean framing.

```c
#include <arpa/inet.h>
#include <assert.h>
#include <errno.h>
#include <netinet/in.h>
#include <poll.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>
#include "cable_frame.h"
#include "cable_link.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "rtos_sim.h"
#include "sim.h"

sim_options_t g_sim;
void sim_front_present(const uint16_t *fb, uint32_t seq) { (void)fb; (void)seq; }
static atomic_int frames, ticks;
static void on_frame(uint8_t v, uint8_t t, const uint8_t *p, size_t n, void *c) { (void)v; (void)t; (void)p; (void)n; (void)c; atomic_fetch_add(&frames, 1); }
static void on_tick(void *c) { (void)c; atomic_fetch_add(&ticks, 1); }

static int free_port(void) {
    int s = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in a = { .sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
    bind(s, (void *)&a, sizeof a);
    socklen_t l = sizeof a; getsockname(s, (void *)&a, &l); close(s);
    return ntohs(a.sin_port);
}
static int listen_on(int port) {
    int s = socket(AF_INET, SOCK_STREAM, 0), one = 1, small = 4096;
    setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    setsockopt(s, SOL_SOCKET, SO_RCVBUF, &small, sizeof small);   /* inherited by accepted sockets */
    struct sockaddr_in a = { .sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK), .sin_port = htons((uint16_t)port) };
    assert(bind(s, (void *)&a, sizeof a) == 0 && listen(s, 4) == 0);
    return s;
}
static int accept_within(int s, int ms) {
    struct pollfd p = { .fd = s, .events = POLLIN };
    return poll(&p, 1, ms) > 0 ? accept(s, NULL, NULL) : -1;
}
static void wait_until(bool (*ok)(void), int ms) { for (int i = 0; i < ms && !ok(); i++) vTaskDelay(1); assert(ok()); }
static bool attached(void) { return sim_link_connected(); }
static bool detached(void) { return !sim_link_connected(); }
static int want_frames;
static bool got_frames(void) { return atomic_load(&frames) >= want_frames; }
static int welcome(uint8_t *buf, size_t cap) { return cable_frame_encode(CABLE_TYPE_JSON, (const uint8_t *)"{\"t\":\"welcome\"}", 15, buf, cap); }

/* write() stand-ins, installed through the link's test seam */
static ssize_t always_eagain(int fd, const void *b, size_t n) { (void)fd; (void)b; (void)n; errno = EAGAIN; return -1; }
static size_t short_budget;
static ssize_t short_then_eagain(int fd, const void *b, size_t n) {
    if (!short_budget) { errno = EAGAIN; return -1; }
    size_t k = n < short_budget ? n : short_budget;
    short_budget -= k;
    return write(fd, b, k);
}

static void run(void *arg) {
    (void)arg; sim_rtos_mark_untracked();
    g_sim.port = free_port();
    cable_link_start(on_frame, on_tick, NULL);

    /* 1. no daemon yet: ticks keep running, nothing attached */
    vTaskDelay(pdMS_TO_TICKS(450));
    assert(atomic_load(&ticks) >= 3 && !sim_link_connected());

    /* 2. the daemon appears: attached within the 2 s retry window */
    int srv = listen_on(g_sim.port);
    int c = accept_within(srv, 3000); assert(c >= 0);
    wait_until(attached, 1000);
    uint8_t frame[64]; int n = welcome(frame, sizeof frame);
    assert(write(c, frame, (size_t)n) == n);
    want_frames = 1; wait_until(got_frames, 1000);

    /* 3. nothing can be written (EAGAIN from the first byte): the send fails within its budget and the
     *    connection stays up — a whole frame that never started leaves framing intact */
    static uint8_t big[CABLE_MAX_PAYLOAD];
    sim_link_write = always_eagain;
    int64_t t0 = esp_timer_get_time();
    assert(!cable_link_send(CABLE_TYPE_PCM, big, sizeof big));
    int64_t dt_ms = (esp_timer_get_time() - t0) / 1000;
    assert(dt_ms >= 90 && dt_ms <= 150);
    vTaskDelay(pdMS_TO_TICKS(200));
    assert(sim_link_connected());

    /* 4. a frame cut short (100 bytes, then EAGAIN until the deadline): the link shuts the socket, the
     *    peer sees EOF on its own, and the link detaches. The listener is closed first so a reconnect cannot
     *    race the detach we are about to observe. */
    close(srv);
    sim_link_write = short_then_eagain; short_budget = 100;
    t0 = esp_timer_get_time();
    assert(!cable_link_send(CABLE_TYPE_PCM, big, sizeof big));
    assert((esp_timer_get_time() - t0) / 1000 <= 150);
    sim_link_write = write;
    int64_t until = esp_timer_get_time() + 2000000;
    bool eof = false;
    static uint8_t sink[65536];
    while (!eof && esp_timer_get_time() < until) {
        struct pollfd p = { .fd = c, .events = POLLIN };
        if (poll(&p, 1, 100) > 0) { ssize_t r = read(c, sink, sizeof sink); if (r == 0) eof = true; }
    }
    assert(eof);
    wait_until(detached, 1000);
    close(c);

    /* 5. the daemon comes back: a fresh session with clean framing */
    srv = listen_on(g_sim.port);
    c = accept_within(srv, 4000); assert(c >= 0);
    wait_until(attached, 1000);
    assert(write(c, frame, (size_t)n) == n);
    want_frames = 2; wait_until(got_frames, 1000);
    puts("test_link: ok");
    exit(0);
}
int main(void) { sim_rtos_spawn(run, "t", NULL, false); for (;;) pause(); }
```

Steps 3 and 4 do not depend on kernel buffer sizes: the link's write goes through `sim_link_write`, and the test installs stand-ins that produce exactly "nothing written" and "100 bytes, then nothing" until the deadline. Step 4 closes the listener before cutting the frame, so the link cannot reconnect before the test has observed the detach; step 5 reopens it.

CMake:

```cmake
add_executable(test_link ${SIM}/test/test_link.c)
target_link_libraries(test_link ${SIM_LIBS})
add_test(NAME link COMMAND test_link)
```

Run: `ninja -C devices/harness-device/sim/build test_link && ctest --test-dir devices/harness-device/sim/build -R link --output-on-failure`
Expected: FAIL at step 2 (weak connect step never connects).

- [ ] **Step 2: `S/core/link_tcp.c`**:

```c
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>
#include "esp_log.h"
#include "esp_timer.h"
#include "sim.h"

#define SIM_SNDBUF (16 * 1024)
static int64_t last_attempt_us = INT64_MIN / 2;
static bool announced;

void sim_link_connect_step(void) {
    if (g_sim.script || sim_link_connected()) { announced = false; return; }
    int64_t now = esp_timer_get_time();
    if (now - last_attempt_us < 2000000) return;
    last_attempt_us = now;
    int s = socket(AF_INET, SOCK_STREAM, 0);
    if (s < 0) return;
    int one = 1, sndbuf = SIM_SNDBUF;
    setsockopt(s, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
    setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
    setsockopt(s, SOL_SOCKET, SO_SNDBUF, &sndbuf, sizeof sndbuf);
    fcntl(s, F_SETFL, fcntl(s, F_GETFL) | O_NONBLOCK);
    struct sockaddr_in a = { .sin_family = AF_INET, .sin_port = htons((uint16_t)g_sim.port),
                             .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
    int r = connect(s, (struct sockaddr *)&a, sizeof a);
    if (r != 0 && errno == EINPROGRESS) {
        struct pollfd p = { .fd = s, .events = POLLOUT };
        int err = 0; socklen_t l = sizeof err;
        r = (poll(&p, 1, 500) == 1 && getsockopt(s, SOL_SOCKET, SO_ERROR, &err, &l) == 0 && err == 0) ? 0 : -1;
    }
    if (r != 0) {
        close(s);
        if (!announced) { ESP_LOGW("cable_link", "waiting for daemon on 127.0.0.1:%d", g_sim.port); announced = true; }
        return;
    }
    ESP_LOGI("cable_link", "connected to daemon on 127.0.0.1:%d", g_sim.port);
    sim_link_use_fd(s);
}
```

Add `${SIM}/core/link_tcp.c` to `SIM_CORE`. (The 500 ms connect poll runs on the reader task; it is not bracketed as parked, so a live run never "settles" while the daemon is absent — correct, settle is only used by scripts, which never connect.)

- [ ] **Step 3: Run** — `ctest --test-dir devices/harness-device/sim/build -R 'link|scenarios|mac' --output-on-failure` → PASS.

- [ ] **Step 4: Live smoke** — terminal 1: daemon with `HARNESS_DIAL_TCP=1`. Terminal 2: `devices/harness-device/sim/build/harness-sim --headless --profile smoke`. Expected daemon log: `cable: dial 02:… on fw sim-<sha> … hw sim [tcp SIM1]`; sim log: `connected to daemon`. Kill the daemon → sim logs `link closed` then `waiting for daemon…`; restart it → reconnects without restarting the sim (Review Focus 1). Try `--record /tmp/live.jsonl` and confirm it fills with `{"frame": …}` lines.

- [ ] **Step 5: Commit**

```bash
git add devices/harness-device/sim
git commit -m "feat(device): simulator connects to the daemon over loopback TCP with device write budgets

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: SDL2 window — sequenced present handoff, round mask, mouse, keyboard, focus

**Files:**
- Create: `S/front/sdl.c`
- Modify: `S/CMakeLists.txt` (`harness-sim` uses `front/sdl.c` when SDL2 is found; headless-only build otherwise)

**Interfaces:**
- Consumes: front contract from `sim.h` (`sim_front_init`, `sim_front_present(fb, seq)`, `sim_front_run`), `sim_pointer_set/cancel`, `sim_key_set`, `sim_keys_release_all`, `sim_png_write`, `sim_rtos_park_begin/end`.
- Produces: interactive `harness-sim` (no `--headless`); `S` writes `./sim-shots/shot-<ms>.png`.

Contract (spec §4.4): the window exists before the firmware starts (`sim_front_init` runs in `main` before `app_main` is spawned). `sim_front_present` copies the frame into the front's own buffer tagged with `seq`, wakes the main thread and blocks — parked — until the main thread reports `shown_seq >= seq`. There is no timeout that acknowledges: a frame is acknowledged only when shown. While waiting longer than 1 s it logs once per second (the window may be minimised; SDL still processes events, so the wait ends when it is restored).

- [ ] **Step 1: `S/front/sdl.c`**:

```c
// The window. SDL lives on the main thread; the render task hands each frame over with a sequence number
// and waits until the main thread has shown exactly that frame — the same promise the DMA fence gives on
// the device, so receipts are acknowledged only after their pixels are on screen.
#ifdef SIM_HAS_SDL
#include <SDL.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include "esp_timer.h"
#include "rtos_sim.h"
#include "sim.h"

static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cv = PTHREAD_COND_INITIALIZER;
static uint16_t frame[SIM_W * SIM_H];          /* the front's own copy, guarded by mu */
static uint32_t queued_seq, shown_seq;
static Uint32 present_event;
static SDL_Window *win;
static SDL_Renderer *ren;
static SDL_Texture *tex;
static int scale = 1;

static bool in_circle(int x, int y) { int dx = 2 * x + 1 - SIM_W, dy = 2 * y + 1 - SIM_H; return dx * dx + dy * dy <= SIM_W * SIM_W; }

void sim_front_init(void) {
    if (g_sim.headless) return;
    if (SDL_Init(SDL_INIT_VIDEO) != 0) { fprintf(stderr, "SDL_Init: %s (try --headless)\n", SDL_GetError()); exit(1); }
    scale = g_sim.scale > 0 ? g_sim.scale : 1;
    win = SDL_CreateWindow("harness-sim", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, SIM_W * scale, SIM_H * scale,
                           SDL_WINDOW_RESIZABLE | SDL_WINDOW_ALLOW_HIGHDPI);
    ren = SDL_CreateRenderer(win, -1, SDL_RENDERER_ACCELERATED | SDL_RENDERER_PRESENTVSYNC);
    /* A 466×466 logical canvas: SDL letterboxes it in any window size and reports mouse events in logical
     * (panel) coordinates, so input mapping never depends on the window's current size or pixel density. */
    if (ren) SDL_RenderSetLogicalSize(ren, SIM_W, SIM_H);
    tex = SDL_CreateTexture(ren, SDL_PIXELFORMAT_RGB565, SDL_TEXTUREACCESS_STREAMING, SIM_W, SIM_H);
    present_event = SDL_RegisterEvents(1);
    if (!win || !ren || !tex || present_event == (Uint32)-1) { fprintf(stderr, "SDL setup: %s\n", SDL_GetError()); exit(1); }
    SDL_SetRenderDrawColor(ren, 0, 0, 0, 255);
    SDL_RenderClear(ren); SDL_RenderPresent(ren);
}

void sim_front_present(const uint16_t *fb, uint32_t seq) {
    if (g_sim.headless) return;
    pthread_mutex_lock(&mu);
    memcpy(frame, fb, sizeof frame);
    queued_seq = seq;
    pthread_mutex_unlock(&mu);
    SDL_Event e = { .type = present_event };
    SDL_PushEvent(&e);                           /* thread-safe in SDL2 */
    sim_rtos_park_begin();
    pthread_mutex_lock(&mu);
    while (shown_seq < seq) {
        struct timespec ts; clock_gettime(CLOCK_REALTIME, &ts); ts.tv_sec += 1;
        if (pthread_cond_timedwait(&cv, &mu, &ts) != 0 && shown_seq < seq)
            fprintf(stderr, "sdl: frame %u still waiting to be shown (window hidden?)\n", seq);
    }
    pthread_mutex_unlock(&mu);
    sim_rtos_park_end();
}

static void show_latest(void) {
    static uint16_t swapped[SIM_W * SIM_H];
    pthread_mutex_lock(&mu);
    uint32_t seq = queued_seq;
    for (int i = 0; i < SIM_W * SIM_H; i++) {
        uint16_t p = frame[i];
        swapped[i] = in_circle(i % SIM_W, i / SIM_W) ? (uint16_t)((p << 8) | (p >> 8)) : 0;   /* panel order → RGB565 */
    }
    pthread_mutex_unlock(&mu);
    SDL_UpdateTexture(tex, NULL, swapped, SIM_W * 2);
    SDL_RenderClear(ren); SDL_RenderCopy(ren, tex, NULL, NULL); SDL_RenderPresent(ren);
    pthread_mutex_lock(&mu);
    if (seq > shown_seq) shown_seq = seq;       /* a later frame shown also covers earlier waiters */
    pthread_cond_broadcast(&cv);
    pthread_mutex_unlock(&mu);
}

int sim_front_run(void) {
    if (g_sim.headless) { for (;;) SDL_Delay(1000); }
    bool down = false;
    for (;;) {
        SDL_Event e;
        if (!SDL_WaitEventTimeout(&e, 100)) continue;
        do {
            if (e.type == present_event) { show_latest(); continue; }
            switch (e.type) {
            case SDL_QUIT: exit(0);
            case SDL_MOUSEBUTTONDOWN:
                if (e.button.button == SDL_BUTTON_LEFT && in_circle(e.button.x, e.button.y)) {
                    down = true; SDL_CaptureMouse(SDL_TRUE); sim_pointer_set(true, e.button.x, e.button.y);
                }
                break;
            case SDL_MOUSEMOTION:
                if (down) sim_pointer_set(true, e.motion.x, e.motion.y);   /* off-panel → untrusted → cancel */
                break;
            case SDL_MOUSEBUTTONUP:
                if (down && e.button.button == SDL_BUTTON_LEFT) {
                    down = false; SDL_CaptureMouse(SDL_FALSE); sim_pointer_set(false, e.button.x, e.button.y);
                }
                break;
            case SDL_MOUSEWHEEL: {
                if (down) break;
                int mx = e.wheel.mouseX, my = e.wheel.mouseY;   /* SDL ≥ 2.26: already logical when a logical size is set */
                int dy = e.wheel.y * 40;
                sim_pointer_set(true, mx, my); SDL_Delay(8);
                sim_pointer_set(true, mx, my + dy / 2); SDL_Delay(8);
                sim_pointer_set(true, mx, my + dy); SDL_Delay(8);
                sim_pointer_set(false, mx, my + dy);
                break;
            }
            case SDL_WINDOWEVENT:
                if (e.window.event == SDL_WINDOWEVENT_FOCUS_LOST) {
                    if (down) { sim_pointer_cancel(); sim_pointer_set(false, 0, 0); down = false; SDL_CaptureMouse(SDL_FALSE); }
                    sim_keys_release_all();
                }
                if (e.window.event == SDL_WINDOWEVENT_EXPOSED || e.window.event == SDL_WINDOWEVENT_SIZE_CHANGED) show_latest();
                break;
            case SDL_KEYDOWN: case SDL_KEYUP: {
                if (e.key.repeat) break;
                bool d = e.type == SDL_KEYDOWN;
                switch (e.key.keysym.sym) {
                case SDLK_b: sim_key_set(SIM_KEY_BOOT, d); break;
                case SDLK_p: sim_key_set(SIM_KEY_PWR, d); break;
                case SDLK_v: sim_key_set(SIM_KEY_VOICE, d); break;
                case SDLK_s: if (d) { mkdir("sim-shots", 0755); char path[64];
                    snprintf(path, sizeof path, "sim-shots/shot-%lld.png", (long long)(esp_timer_get_time() / 1000));
                    fprintf(stderr, sim_png_write(path) ? "saved %s\n" : "failed %s\n", path); } break;
                case SDLK_q: if (d) exit(0); break;
                default: break;
                }
                break;
            }
            default: break;
            }
        } while (SDL_PollEvent(&e));
    }
}
#endif
```

Notes: `sim_png_write` reads display_core's `presented` copy, not SDL's — screenshots match what the firmware drew. The wheel's synthetic drag blocks the main thread ~24 ms; acceptable for a dev tool, and skipped while a real drag is in progress.

- [ ] **Step 2: CMake**:

```cmake
find_package(SDL2 QUIET)
if(SDL2_FOUND)
    target_sources(harness-sim PRIVATE ${SIM}/front/sdl.c)
    target_compile_definitions(harness-sim PRIVATE SIM_HAS_SDL=1)
    target_link_libraries(harness-sim SDL2::SDL2)
else()
    message(STATUS "SDL2 not found: building headless-only harness-sim (brew install sdl2)")
endif()
```

`front/headless.c` is already wrapped in `#ifndef SIM_HAS_SDL` (Task 7), and `sdl.c` in `#ifdef SIM_HAS_SDL`, so exactly one front provides `sim_front_init/present/run`. With SDL, `--headless` still works: `sdl.c` returns early from init/present and `sim_front_run` idles.

- [ ] **Step 3: Build and try it** — `brew install sdl2 cmake ninja` (if needed), `ninja -C devices/harness-device/sim/build harness-sim`, then with a daemon on `HARNESS_DIAL_TCP=1`: `devices/harness-device/sim/build/harness-sim --profile dev --scale 2`.

Check by hand, in order: round face, correct colours (dark canvas, not purple); agents appear; click-drag scrolls; resize the window (and try `--scale 2` on Retina) → the face stays round and a tap lands where the pointer is; drag out of the window and release → next tap works (Review Focus 4); switch apps mid-drag → no stuck contact; `B` goes back / stops a turn; hold `B` ~1 s → screen toggles once; `P` toggles; `S` saves a PNG; minimise and restore the window → the stderr "still waiting" lines stop and the UI continues; `Q` quits.

- [ ] **Step 4: Tests still pass** — `ctest --test-dir devices/harness-device/sim/build --output-on-failure` (headless path unchanged).

- [ ] **Step 5: Commit**

```bash
git add devices/harness-device/sim
git commit -m "feat(device): SDL2 window for the simulator with the device's touch and button rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Voice — paced synthetic PCM through the real UI/audio client; safe WAV loading

**Files:**
- Modify: `S/core/audio_sim.c` (WAV source; keeps Task 7's notification functions), `S/sim_main.c` (voice source selection)
- Create: `S/fixtures/voice-hello.wav` (generated, committed), `S/test/test_audio.c`
- Modify: `S/CMakeLists.txt` (`test_audio`)

**Interfaces:**
- Consumes: `g_sim.voice_wav`, `g_sim.voice_text`; `audio_capture.h`; `config_store.h` (`config_store_init`, `config_load_muted`, `config_save_muted`).
- Produces: `bool sim_audio_load_wav(const char *path)` — accepts only a well-formed 16 kHz mono s16le WAV; on any failure returns false and **keeps the previously loaded clip**. `audio_capture_read` blocks to real-time pace, returns the clip then zeros, never ≤ 0 while started.

- [ ] **Step 1: Generate the fixture**

```bash
say -o devices/harness-device/sim/fixtures/voice-hello.wav --file-format=WAVE --data-format=LEI16@16000 "fix the login screen"
afinfo devices/harness-device/sim/fixtures/voice-hello.wav | grep -E "Data format|duration"
```

Expected: `1 ch, 16000 Hz, Int16`, duration ~1-2 s.

- [ ] **Step 2: Failing test** — `S/test/test_audio.c`:

```c
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "audio_capture.h"
#include "config_store.h"
#include "esp_sim.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"
#include "rtos_sim.h"
#include "sim.h"

sim_options_t g_sim = { .headless = true };
void sim_front_present(const uint16_t *fb, uint32_t seq) { (void)fb; (void)seq; }

static void put32(uint8_t *p, uint32_t v) { p[0] = v; p[1] = v >> 8; p[2] = v >> 16; p[3] = v >> 24; }
static void put16(uint8_t *p, uint16_t v) { p[0] = v; p[1] = v >> 8; }
/* A WAV whose chunks can lie about their sizes. */
static const char *wav(const char *name, uint32_t fmt_len, uint32_t data_len, size_t real_data) {
    static char path[64]; snprintf(path, sizeof path, "/tmp/simwav-%s.wav", name);
    uint8_t h[44] = {0};
    memcpy(h, "RIFF", 4); put32(h + 4, 36 + (uint32_t)real_data); memcpy(h + 8, "WAVE", 4);
    memcpy(h + 12, "fmt ", 4); put32(h + 16, fmt_len); put16(h + 20, 1); put16(h + 22, 1);
    put32(h + 24, 16000); put32(h + 28, 32000); put16(h + 32, 2); put16(h + 34, 16);
    memcpy(h + 36, "data", 4); put32(h + 40, data_len);
    FILE *f = fopen(path, "wb");
    size_t header = fmt_len < 16 ? 20 + fmt_len : 44;   /* a short fmt chunk ends the file early */
    fwrite(h, 1, header, f);
    for (size_t i = 0; i < real_data && header == 44; i++) fputc(i & 1 ? 0x10 : 0x00, f);   /* samples 0x1000 */
    fclose(f);
    return path;
}

static void run(void *arg) {
    (void)arg; sim_rtos_mark_untracked();
    /* a recognisable clip (every sample 0x1000); each malformed load is rejected AND leaves it in place */
    assert(!sim_audio_load_wav("/nonexistent.wav"));
    assert(sim_audio_load_wav(wav("ok", 16, 3200, 3200)));
    const char *bad[] = {
        wav("shortfmt", 8, 0, 0),             /* fmt chunk truncated */
        wav("bigdata", 16, 1u << 30, 100),    /* data claims 1 GiB, has 100 B */
        wav("odd", 16, 101, 101),             /* half a sample, and no pad byte */
    };
    for (size_t i = 0; i < sizeof bad / sizeof *bad; i++) {
        assert(!sim_audio_load_wav(bad[i]));
        int16_t first[4];
        assert(audio_capture_start());
        assert(audio_capture_read((uint8_t *)first, sizeof first) == (int)sizeof first);
        audio_capture_stop();
        assert(first[0] == 0x1000 && first[3] == 0x1000);
    }
    assert(sim_audio_load_wav(SIM_FIXTURES "/voice-hello.wav"));

    /* paced read: 4 s of reads take ~4 s; the clip plays, then silence, never a short read */
    assert(audio_capture_start());
    uint8_t buf[3200];                                   /* 100 ms */
    int64_t t0 = esp_timer_get_time();
    long nonzero = 0;
    for (int i = 0; i < 40; i++) {
        int n = audio_capture_read(buf, sizeof buf);
        assert(n == (int)sizeof buf);
        for (int k = 0; k < n; k++) nonzero += buf[k] != 0;
    }
    int64_t dt = (esp_timer_get_time() - t0) / 1000;
    assert(dt >= 3800 && dt <= 4600);
    assert(nonzero > 0);
    assert(audio_capture_overruns() == 0);
    audio_capture_stop();

    /* notification mute behaves like the device: persisted, and a muted beep does not play */
    sim_nvs_configure(NULL, NULL);
    config_store_init();
    audio_notify_init();
    assert(audio_notify_set_muted(true));
    assert(config_load_muted());
    unsigned before = sim_audio_beeps();
    audio_notify_done();
    assert(sim_audio_beeps() == before);
    assert(audio_notify_set_muted(false));
    assert(!config_load_muted());
    audio_notify_done();
    assert(sim_audio_beeps() == before + 1);
    puts("test_audio: ok");
    exit(0);
}
int main(void) { sim_rtos_spawn(run, "t", NULL, false); for (;;) pause(); }
```

CMake:

```cmake
add_executable(test_audio ${SIM}/test/test_audio.c)
target_compile_definitions(test_audio PRIVATE SIM_FIXTURES="${SIM}/fixtures")
target_link_libraries(test_audio ${SIM_LIBS})
add_test(NAME audio COMMAND test_audio)
```

(Match `config_store_init`'s exact name/signature to `F/config_store.h`; if NVS must be initialised first there, it calls `nvs_flash_init` itself — the shim is configured before.)

Run → FAIL (the Task 7 stub `sim_audio_load_wav` always returns false).

- [ ] **Step 3: Implement** — in `S/core/audio_sim.c`, replace the silent `audio_capture_*` functions and the `sim_audio_load_wav` stub with the following (keep `audio_notify_*` and `sim_audio_beeps` from Task 7 unchanged):

```c
#include <stdlib.h>
#include "esp_timer.h"

static int16_t *pcm; static size_t samples;
static size_t pos; static int64_t started_us, delivered_bytes;

static uint32_t le32(const uint8_t *p) { return p[0] | p[1] << 8 | p[2] << 16 | (uint32_t)p[3] << 24; }
static uint16_t le16(const uint8_t *p) { return (uint16_t)(p[0] | p[1] << 8); }

/* Every size read from the file is checked before use: against the RIFF extent the header declares and
 * against the bytes actually present. Any doubt rejects the file and keeps the current clip. */
bool sim_audio_load_wav(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) return false;
    uint8_t *b = NULL; long n = -1;
    if (fseek(f, 0, SEEK_END) == 0) n = ftell(f);
    bool ok = n >= 12 && n <= (64L << 20) && fseek(f, 0, SEEK_SET) == 0 && (b = malloc((size_t)n)) &&
              fread(b, 1, (size_t)n, f) == (size_t)n && !memcmp(b, "RIFF", 4) && !memcmp(b + 8, "WAVE", 4);
    fclose(f);
    /* The RIFF size counts everything after its own 8-byte header; the walk must not leave that extent. */
    size_t end = 0;
    if (ok) { uint32_t riff = le32(b + 4); ok = riff >= 4 && (size_t)riff <= (size_t)n - 8; end = (size_t)riff + 8; }
    size_t off = 12;
    bool fmt_ok = false; const uint8_t *data = NULL; size_t data_len = 0;
    while (ok && off < end) {
        if (end - off < 8) { ok = false; break; }                          /* a truncated chunk header */
        size_t len = le32(b + off + 4);
        if (len > end - off - 8) { ok = false; break; }                  /* chunk runs past the RIFF extent */
        const uint8_t *body = b + off + 8;
        if (!memcmp(b + off, "fmt ", 4))
            fmt_ok = len >= 16 && le16(body) == 1 && le16(body + 2) == 1 &&          /* PCM, mono */
                     le32(body + 4) == AUDIO_SAMPLE_RATE && le32(body + 8) == AUDIO_SAMPLE_RATE * 2 &&
                     le16(body + 12) == 2 && le16(body + 14) == 16;                  /* align 2, 16-bit */
        else if (!memcmp(b + off, "data", 4)) { data = body; data_len = len; }
        off += 8 + len;
        if (len & 1) { if (off >= end) { ok = false; break; } off++; }  /* the RIFF pad byte must exist */
    }
    ok = ok && fmt_ok && data && data_len >= 2 && data_len % 2 == 0;
    int16_t *copy = ok ? malloc(data_len) : NULL;
    if (ok && copy) {
        memcpy(copy, data, data_len);
        free(pcm); pcm = copy; samples = data_len / 2;
    } else ok = false;
    free(b);
    if (!ok) ESP_LOGW("audio_sim", "%s is not a readable 16 kHz mono 16-bit PCM WAV — keeping the previous clip", path);
    return ok;
}

bool audio_capture_start(void) { pos = 0; delivered_bytes = 0; started_us = esp_timer_get_time(); return true; }

/* Blocks like I2S: returns when `len` bytes' worth of real time has passed since start. */
int audio_capture_read(uint8_t *buf, int len) {
    delivered_bytes += len;
    int64_t due_us = started_us + delivered_bytes * 1000000 / (AUDIO_SAMPLE_RATE * 2);
    int64_t wait_us = due_us - esp_timer_get_time();
    if (wait_us > 0) vTaskDelay(pdMS_TO_TICKS((wait_us + 999) / 1000));
    int16_t *out = (int16_t *)buf;
    for (int i = 0; i < len / 2; i++) out[i] = pos < samples ? pcm[pos++] : 0;
    return len;
}
```

(`audio_capture_init`, `audio_capture_stop`, `audio_capture_overruns` stay as in Task 7.)

In `S/sim_main.c`, just before `sim_rtos_spawn(app_task, …)`, choose the clip. The text reaches `say` through its argv, never through a shell:

```c
#include <spawn.h>
#include <sys/wait.h>
extern char **environ;

static bool say_to_wav(const char *text, const char *out) {
    char *argv[] = { "say", "-o", (char *)out, "--file-format=WAVE", "--data-format=LEI16@16000", (char *)text, NULL };
    pid_t pid; int status;
    if (posix_spawnp(&pid, "say", NULL, NULL, argv, environ) != 0) return false;
    return waitpid(pid, &status, 0) == pid && WIFEXITED(status) && WEXITSTATUS(status) == 0;
}
```

```c
    char tmpwav[] = "/tmp/harness-sim-voice-XXXXXX.wav";
    const char *clip = g_sim.voice_wav;
    if (!clip && g_sim.voice_text) {
        int fd = mkstemps(tmpwav, 4);
        if (fd >= 0) close(fd);
        if (fd >= 0 && say_to_wav(g_sim.voice_text, tmpwav)) clip = tmpwav;
        else fprintf(stderr, "voice: could not run `say` — using the default clip\n");
    }
    if (!clip || !sim_audio_load_wav(clip)) sim_audio_load_wav(SIM_FIXTURES "/voice-hello.wav");
```

- [ ] **Step 4: Run** — `ctest --test-dir devices/harness-device/sim/build -R 'audio|scenarios' --output-on-failure` → PASS.

- [ ] **Step 5: Live voice check** — with a daemon (`HARNESS_DIAL_TCP=1`): `harness-sim --profile dev --voice-text "list the open agents"`, open an agent, hold `V` ~2 s, release. Expected: the UI shows the voice surface, then either the transcript/draft (daemon signed in) or the daemon's `voice.error` text (signed out) — both correct (spec §4.7). Also: `--voice-text` with a quote and `$(…)` in it renders literally (no shell). Record what you saw in Task 12's "Verified" list.

- [ ] **Step 6: Commit**

```bash
git add devices/harness-device/sim
git commit -m "feat(device): simulated microphone plays a WAV at real time through the real voice path

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Make targets, README, end-to-end verification

**Files:**
- Modify: root `Makefile`
- Create: `S/README.md`
- (No change under `devices/harness-device/firmware/` — the global constraint covers docs too. A pointer from the firmware README is proposed in the upstream PR description instead.)

- [ ] **Step 1: Makefile targets** — append to root `Makefile` (match its `## target: help` comment style):

```make
## device-sim: build the desktop simulator of the harness device (needs cmake, ninja; sdl2 for a window).
device-sim:
	cmake -S devices/harness-device/sim -B devices/harness-device/sim/build -G Ninja
	ninja -C devices/harness-device/sim/build

## device-sim-run: run the simulator against a daemon started with HARNESS_DIAL_TCP=1.
device-sim-run: device-sim
	devices/harness-device/sim/build/harness-sim --profile default --scale 2

## device-sim-test: simulator unit tests + headless scenarios (PNGs printed at the end).
device-sim-test: device-sim
	ctest --test-dir devices/harness-device/sim/build --output-on-failure
```

Also add the three to `.PHONY` if the Makefile declares one.

- [ ] **Step 2: `S/README.md`** — sections: what it is (one paragraph); requirements (`brew install cmake ninja sdl2`; optional `IDF_PATH` for the exact cJSON); quick start (`HARNESS_DIAL_TCP=1` daemon + `make device-sim-run`); keys table (copy from Global Constraints); flags (`--headless`, `--script`, `--shot`, `--profile`, `--factory-reset`, `--scale`, `--port`, `--settle-ms`, `--settle-timeout`, `--allow-errors`, `--voice-wav`, `--voice-text`, `--record`, `--log-level`); scenarios (`make device-sim-test`, regenerating with `gen-scenarios.ts`, recording a live session with `--record`); what is simulated vs not (spec §1 non-goals + §10 threading fidelity; connection-scoped device id); "Firmware edits" (expected: none); "Shim surface" (the `nm -u` list from Task 7 Step 12); "Verified" (checklist below with dates).

- [ ] **Step 3: Full verification**

Run:

```bash
cd cli && npm run typecheck && npm test && cd ..
make device-test
make device-sim-test
```

Expected: all green. Then the manual end-to-end (spec §1 / §6.8), with `HARNESS_DIAL_TCP=1` daemon and `hn`:
1. `make device-sim-run` → desktop/`hn` shows an attached device `SIM1`, simulator shows agents.
2. Start a Claude Code agent via `hn`; trigger a permission prompt → it appears on the simulator; answer it there → agent proceeds.
3. Same with a Codex agent.
4. `B` during a running turn → turn stops.
5. Voice via `V` → transcript routed (signed in) or `voice.error` (signed out).
5a. Open an agent's model picker on the simulator → the list comes from the daemon (no `models: no answer` in the sim log), choosing one reaches the agent.
6. Restart the daemon → simulator reconnects by itself.
7. Unset `HARNESS_DIAL_TCP`, restart daemon → `nc -z 127.0.0.1 18474` fails; USB dial behaviour unchanged.
Record results in `S/README.md` "Verified".

- [ ] **Step 4: Commit**

```bash
git add Makefile devices/harness-device/sim/README.md
git commit -m "docs(device): how to build, run and test the desktop simulator

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review notes (for the executor)

- Spec §3.2 → Task 1; §3.3 → Task 2; §3.4 → Tasks 3-4; §3.5 → Task 2 (bind + remote check); §4.2 → Task 7 Step 11; §4.3 → Tasks 5-6 (+ Step 12 iteration); §4.4 display/touch → Task 7, link → Tasks 7+9, SDL handoff → Task 10; §4.5 → Task 7; §4.6 → Tasks 7 (`input_keys`) + 10; §4.7 → Task 11; §4.8 → Task 7 (`device_mac_str`, `--profile`); §4.9 → Task 7 (settle, parked I/O, input sync, readiness gate, ephemeral NVS) + Task 8 (scene-text asserts, model auto-reply); §5 → Tasks 2, 3, 9; §6 → Tasks 1-4, 5-11; §8 docs → Task 12 (simulator README only).
- Where a step says "if the link step reports X undefined", that is the planned discovery loop of §4.3, not an open design question: the rule is fixed (shim/driver with device semantics; never a firmware edit without recording it).
