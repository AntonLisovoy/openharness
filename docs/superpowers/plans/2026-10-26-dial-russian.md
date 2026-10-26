# Russian on the Round Dial Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Russian dictation from the dial is transcribed correctly through the person's own Deepgram key, and Russian (Cyrillic) questions, options, answers and drafts render and can be sent on the dial.

**Architecture:** The daemon's `DaemonCableHost.transcribe` gains a direct-Deepgram branch used when `DEEPGRAM_API_KEY` is set (stock hosted path untouched otherwise). The firmware gets Cyrillic U+0400–U+045F in the fixed-cell atlases (new `ht_cyr_*` from GeistMono) and in the Focus Inter faces (Cyrillic-only instances merged into the existing faces so Latin stays byte-identical), plus one UTF-8-safe copy helper used everywhere display text is cut. Host text filters and the desktop/TUI language pickers learn Russian.

**Tech Stack:** TypeScript (cli, vitest), C11 (ESP-IDF 5.5, host tests via `cc`), Python 3 generators (Pillow 12.2.0, fontTools, `lv_font_conv@1.5.2`), Dart/Flutter (desktop), Rust (tui).

**Spec:** `docs/superpowers/specs/2026-10-26-dial-russian-design.md` (roadmap: `docs/superpowers/specs/2026-10-26-dial-roadmap.md`)

## Global Constraints

- Fork only (`AntonLisovoy/openharness`); work on branch `feat/round-dial` (holds the specs and both plans; this plan runs first). No upstream PR work.
- The Deepgram key never appears in logs, errors, the cable protocol, the dial, git or chat.
- Without `DEEPGRAM_API_KEY`, voice behaves exactly as today (hosted backend, sign-in required).
- Cyrillic range is exactly U+0400–U+045F. Nothing else is added.
- Existing English and Vietnamese rendering must stay byte-identical (Latin and Vietnamese atlases/faces unchanged).
- Dial UI strings stay English (no translation in this plan).
- Generated files (`fonts.c`, `focus_faces.c/.h`) are only ever produced by their generator scripts, never hand-edited.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Commands: CLI single file `cd cli && npx vitest run <file>`; CLI full `make cli-test`; firmware host tests `make device-test`; TUI `cd tui && cargo test`; desktop `make desktop-test ARGS="<test file>"`.

## Review Focus

1. **Key set but rejected (401/403)** — the dial shows "Deepgram key rejected" and nothing else; it must not silently fall back to the hosted path. Test in Task 1.
2. **Silence / empty transcript from Deepgram** — `transcribe` returns `''` and the existing empty-transcript handling runs (no crash, no "sent"). Test in Task 1.
3. **Dial language with region or odd case (`ru-RU`, `RU`)** — passed through lower-cased to Deepgram's `language=`; model lookup uses the base language. Test in Task 1.
4. **Russian text mixed with emoji in a draft** — `canSend` stays false (emoji still undisplayable) while pure Russian is true. Test in Task 3.
5. **Long Russian agent name (> 40 bytes) arriving over the cable** — stored cut at a character boundary, never a half letter. Test in Task 5.

---

### Task 1: Direct Deepgram STT in the daemon

**Files:**
- Create: `cli/src/cable/deepgramDirect.ts`
- Create: `cli/src/cable/deepgramDirect.spec.ts`
- Modify: `cli/src/config/env.ts:384-396` (cable block: add keys)
- Modify: `cli/src/cable/cableHost.ts:806-851` (`transcribe`)
- Modify: `cli/src/cable/cableVoice.spec.ts` (env mock + gate tests)
- Modify: `cli/README.md:266-280` (config section)

**Interfaces:**
- Produces:
  - `export function deepgramModelFor(lang: string, cfg: { model?: string; models?: string }): string`
  - `export async function transcribeWithDeepgram(wavBytes: Buffer, lang: string, cfg: { key: string; model?: string; models?: string }): Promise<string>`
  - `export class DeepgramError extends Error { readonly status: number }` — `message` is dial-ready English.
  - env: `DEEPGRAM_API_KEY: maybe`, `DEEPGRAM_MODEL: maybe`, `DEEPGRAM_MODELS: matching(/^[a-z]{2}=[a-z0-9-]+(,[a-z]{2}=[a-z0-9-]+)*$/)`.

- [ ] **Step 1: Write failing tests in `deepgramDirect.spec.ts`**

Assertion contract (write each as a concrete test; `fetch` stubbed with `vi.stubGlobal` as in `cableVoice.spec.ts`):
  - `deepgramModelFor('en', {}) === 'nova-3'`, `('vi', {}) === 'nova-2'`, `('ru', {}) === 'nova-3'`.
  - precedence: `('ru', {model:'nova-3', models:'ru=nova-2'}) === 'nova-2'`; `('vi', {model:'nova-3'}) === 'nova-3'`; `('ru-RU', {models:'ru=nova-2'}) === 'nova-2'`.
  - `transcribeWithDeepgram(Buffer.from([1,2,3]), 'ru', {key:'k', models:'ru=nova-2'})` calls `fetch` once with URL `https://api.deepgram.com/v1/listen?model=nova-2&language=ru&punctuate=true&smart_format=false`, headers `Authorization: Token k` and `Content-Type: audio/wav`, body bytes `[1,2,3]`.
  - language normalisation: `'RU-ru'` → `language=ru-ru`; an empty or invalid code (not `/^[a-z]{2}(-[a-z]{2})?$/i`) → `language=en` and model for `en`.
  - response `{results:{channels:[{alternatives:[{transcript:'  привет '}]}]}}` → `'привет'`; `{results:{}}` → `''`.
  - status 401 and 403 → `DeepgramError` with message `Deepgram key rejected`; 429 → `Voice service busy. Try again shortly`; 500 → `Voice service unavailable. Try again`; fetch rejects → `Transcription failed (network)`, status 0.
  - with key `secret-123`, no thrown message contains `secret-123`.

- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/deepgramDirect.spec.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `deepgramDirect.ts`.** Mirror `backend/src/lib/deepgramWav.ts` (no encoding params; `Content-Type: audio/wav`; body `new Uint8Array(wavBytes)`); copy its vi/nova-3 measurement comment and note that `ru`/`en` use nova-3 by the person's call (override: `DEEPGRAM_MODELS=ru=nova-2`). Network errors become `DeepgramError` with status 0 and message `Transcription failed (network)`.

- [ ] **Step 4: Add env keys** in the cable block of `env.ts` (`DEEPGRAM_API_KEY: maybe`, `DEEPGRAM_MODEL: maybe`, `DEEPGRAM_MODELS: matching(...)`).

- [ ] **Step 5: Write failing tests in `cableVoice.spec.ts`** (add the three keys to the `vi.mock('../config/env.js')` object, default undefined):
  - with `DEEPGRAM_API_KEY` set and `signedIn: () => false`, `transcribe` calls `api.deepgram.com` and not the backend URL, and does not throw "Sign in…";
  - with the key set, a 401 surfaces `Deepgram key rejected` and makes **no** second request to the backend;
  - without the key, the existing backend tests still pass unchanged;
  - the wiring `log` never contains the key.

- [ ] **Step 6: Run** `cd cli && npx vitest run src/cable/cableVoice.spec.ts` — Expected: new tests FAIL.

- [ ] **Step 7: Branch in `transcribe`:** if `env.DEEPGRAM_API_KEY` → `transcribeWithDeepgram(wav(pcm, sampleRate), lang, {key, model: env.DEEPGRAM_MODEL, models: env.DEEPGRAM_MODELS})`, log `cable: stt direct HTTP <status>` on failure (status only), rethrow as `Error(err.message)`; else the existing body unchanged.

- [ ] **Step 8: Run** both spec files, then `make cli-test` — Expected: PASS.

- [ ] **Step 9: Document** in `cli/README.md` config section: `DEEPGRAM_API_KEY`, `DEEPGRAM_MODEL`, `DEEPGRAM_MODELS`; under launchd (`harness service install`) and the desktop app only `HARNESS_ENV_FILE` carries extra vars (`cli/src/lib/platformDaemon.ts:42`), so put the key in that file (mode 0600) and set `HARNESS_ENV_FILE` before installing the service.

- [ ] **Step 10: Commit** `feat(cable): direct Deepgram transcription with your own key`.

### Task 2: (removed)

Clip measurement dropped: the person is confident nova-3 handles Russian and English, and Vietnamese is not
needed. Russian/English quality is accepted by live dictation on the board in Task 9. Task numbers below are
kept as they were.

### Task 3: Host text filters accept Cyrillic

**Files:**
- Create: `cli/src/lib/dialText.ts`, `cli/src/lib/dialText.spec.ts` (neutral `lib/` so core modules may import it — `src/architecture.spec.ts:193,225,515` forbids core → `cable/`)
- Modify: `cli/src/cable/voiceDraft.ts:91,120` (use `dialDisplayable`)
- Modify: `cli/src/lib/voiceRouter.ts:153-168` (`ROUTE_STOP_WORDS`, `routeTokens`)
- Test: `cli/src/cable/voiceDraft.spec.ts`, `cli/src/lib/voiceRouter.spec.ts`

**Interfaces:**
- Produces: `export function dialDisplayable(text: string): boolean` in `cli/src/lib/dialText.ts` — true iff every code point is `\n` or in the set **both** the Focus faces and the mono skins can draw after this plan: U+0020–007E, U+00A0–00FF, the Vietnamese letters U+0102 U+0103 U+0110 U+0111 U+01A0 U+01A1 U+01AF U+01B0 U+1EA0–1EF9, Cyrillic U+0400–045F, and the punctuation present in Focus `TEXT` that mono also aliases: U+2013 U+2014 U+2018 U+2019 U+201C U+201D. (Focus has U+2022/2026/2039/203A but mono does not; mono aliases U+2010–2012/2015/201A–201B/201E–201F/2212 but Focus lacks them — both excluded.) The Claude-sessions plan consumes this predicate.

- [ ] **Step 0: Failing tests** in `dialText.spec.ts`: each listed range's first and last code point → true; U+2010, U+2022, U+2026, U+2212, U+0100, U+0460, `🚀` → false; `\t` → false; empty string → true.
- [ ] **Step 1: Failing tests** in `voiceDraft.spec.ts`: a draft `Проверь тесты и ответь` has `canSend === true` and sends; `Проверь 🚀` has `canSend === false` and send fails with `Some words cannot display. Edit them before sending.`; `Tiếng Việt có dấu` now has `canSend === true` (fixes the existing Vietnamese exclusion); the existing `“this” 🚀` test still expects false.
- [ ] **Step 2: Failing tests** in `voiceRouter.spec.ts` under `pickAgentHeuristic`: with agents named `Бэкенд API` and `frontend`, transcript `почини бэкенд` picks `Бэкенд API` with confidence > 0.2; `ёлка` matches an agent whose recent activity contains `елка`; a Russian stop-word-only transcript (`и в на`) falls back as today.
- [ ] **Step 3: Run** `cd cli && npx vitest run src/lib/dialText.spec.ts src/cable/voiceDraft.spec.ts src/lib/voiceRouter.spec.ts` — FAIL.
- [ ] **Step 4: Implement:** `dialText.ts`; use `dialDisplayable` at both `voiceDraft.ts` sites; `routeTokens` splits on `/[^a-z0-9а-џ]+/` after the existing NFD/diacritic strip and lower-casing; add Russian stop words `и в во на с со по к ко у о об от до за из для что это как не ни но а же ли бы то` to `ROUTE_STOP_WORDS`.
- [ ] **Step 5: Run** the two files, then `make cli-test` — PASS.
- [ ] **Step 6: Commit** `feat(voice): accept Russian in drafts and voice routing`.

### Task 4: "Русский" in the desktop and TUI language pickers

**Files:**
- Modify: `desktop/lib/devices/device_settings.dart:210-227,270-279`
- Modify: `tui/src/hardware.rs:9`
- Test: `desktop/test/devices_screen_test.dart`, `tui/src/hardware.rs` (`mod tests`, ~363)

- [ ] **Step 1: Failing TUI test** `russian_is_a_known_language`: `language("ru") == "Русский"` and the picker rows contain `("ru", "Русский")` with no `language-current` row when the current code is `ru`.
- [ ] **Step 2: Failing desktop test** in `devices_screen_test.dart`: with device settings `voiceLang: 'ru'`, the Voice language row shows `Русский` (not the raw `ru`), and opening the select lists `Русский`.
- [ ] **Step 3: Run** `cd tui && cargo test hardware` and `make desktop-test ARGS="test/devices_screen_test.dart"` — FAIL.
- [ ] **Step 4: Implement:** append `("ru", "Русский")` to `LANGUAGES`; in Dart add `SelectOption(value: 'ru', label: 'Русский')` after Italiano, add `'ru'` to the known-codes list and `'ru': 'Русский'` to `_languageLabel`.
- [ ] **Step 5: Run** both again — PASS.
- [ ] **Step 6: Commit** `feat(devices): Russian voice language in desktop and TUI`.

### Task 5: UTF-8-safe copying of display text in firmware

**Files:**
- Create: `devices/harness-device/firmware/main/utf8_copy.c`, `main/utf8_copy.h`
- Create: `devices/harness-device/firmware/test/test_utf8_copy.c`
- Modify: `main/CMakeLists.txt` (add `utf8_copy.c` to sources)
- Modify: `main/cable_client.c:895,1022,1109,1120,1153,1228-1230`
- Modify: `main/ui/habitat/ui_habitat.c:301-311` (`copy`), `:1432,2273,2820,2922,3898` (precision formats), `:968-990` (`ui_wrap`)
- Modify: `main/ui/habitat/focus.c:752` (`label_runs`), `main/ui/habitat/terminal.c:285,463,500`
- Modify: every other display-text cut found by the Step 0 inventory (known so far: `ui_habitat.c:1251,1502,1527,2086`, `character_layout.c:65-67`)
- Modify: `test/run.sh` (new block **and** add `main/utf8_copy.c` to every existing block that links `terminal.c`, `focus.c`, `cable_client.c` or `ui_habitat.c`, e.g. `test_terminal` ~70-71, `test_character` ~22-30)
- Modify: the Python extraction tests that compile those sources (`test/test_question_ui.py` ~282, `test/test_touch_ui.py` ~3314, and any other compile command `grep -n "terminal.c\|focus.c\|ui_habitat" test/*.py` finds) to add `utf8_copy.c` and `#include "utf8_copy.h"`
- Modify: `test/test_agent_snapshot.py:41` (extract `handle_agent` with the doubles it needs)

**Interfaces:**
- Produces:
  - `size_t utf8_copy(char *dst, size_t cap, const char *src)` — copies at most `cap-1` bytes, never ends inside a multi-byte sequence, always NUL-terminates, returns bytes written.
  - `size_t utf8_cut(const char *src, size_t max_bytes)` — the largest prefix length ≤ `max_bytes` ending on a character boundary (for `%.*s`).

- [ ] **Step 0: Inventory.** `grep -nE 'snprintf|strncpy|strnlen|memcpy|%\.[0-9*]+s|COPY\(' main/**/*.c` restricted to buffers that hold names, prompts, options, summaries, drafts or labels. Write the list (file:line, buffer, source, verdict "convert" or "bounded: <proof>") into a comment block at the top of `utf8_copy.h`. Every "convert" row is changed in Step 4.
- [ ] **Step 1: Failing tests** in `test_utf8_copy.c`: for every cap 1..64 and inputs `"Привет, мир"`, `"Tiếng Việt"`, `"abc"`, the result is valid UTF-8 (decode with a local checker), is a prefix of the input, and is the longest such prefix; a 2-byte letter at the cut is dropped whole; a 3-byte Vietnamese letter at the cut is dropped whole; `utf8_cut("Привет", 3) == 2`.
- [ ] **Step 2: Add the test block to `run.sh`** (pattern of the `test_terminal` block) and run `make device-test` — FAIL (no `utf8_copy.c`).
- [ ] **Step 3: Implement** `utf8_copy.c` (back off over `(b & 0xC0) == 0x80` continuation bytes, as `recap_preview` does at `ui_habitat.c:333`).
- [ ] **Step 4: Use it:** `copy()` in `ui_habitat.c` calls `utf8_copy`; agent `name`/`machine`, swarm row names, `s_machine_name` and notif `name/machine/summary` in `cable_client.c` use `utf8_copy` instead of `snprintf("%s")`; `s_agents_tab` (an opaque id) is **rejected** when ≥ `ID_MAX`, not cut; the precision formats switch to `%.*s` with `utf8_cut`; `ui_wrap`, `label_runs` and the three `terminal.c` byte cuts back off to a boundary via `utf8_cut`.
- [ ] **Step 5: Helper-level tests** (the real call sites, not only `utf8_copy`): via `test_agent_snapshot.py`'s extracted `handle_agent`, an `agent` frame with a 60-byte Russian name stores valid UTF-8 ≤ 39 bytes (Review Focus 5); `ui_wrap`, `ht_fit_width`, `label_runs` and one precision-format site fed strings whose cut falls inside a 2-byte Cyrillic and a 3-byte Vietnamese character produce valid UTF-8.
- [ ] **Step 6: Run** `make device-test` — PASS (including the frozen renderer references).
- [ ] **Step 7: Commit** `fix(firmware): never cut display text inside a UTF-8 character`.

### Task 6: Cyrillic fixed-cell atlases

**Files:**
- Modify: `devices/harness-device/firmware/scripts/gen_habitat_fonts.py:38-66,144-161`
- Regenerate: `main/ui/habitat/fonts.c`
- Modify: `main/ui/habitat/terminal.h:109-113,224-238`, `main/ui/habitat/terminal.c:52-91,918-944,1480`
- Modify: `test/test_terminal.c` (new `cyrillic_checks()`, goldens)

**Interfaces:**
- Produces: `extern const ht_font_t ht_cyr_16, ht_cyr_20, ht_cyr_24, ht_cyr_28;` (range 0x0400–0x045F, same cells as `ht_mono_*`); `ht_arc_face_t` gains `const ht_font_t *cyr;` placed right after `viet`.

- [ ] **Step 1: Capture goldens before any change.** In `test_terminal.c` add `latin_viet_golden()`: FNV-1a 64 of `ht_raster` output for `"Hello, world!"` and `"Tiếng Việt có dấu"` in each of `ht_mono_16/20/24/28`, compiled with `-DHT_UPDATE_TERMINAL_GOLDEN` to print, values stored in `test/terminal_golden.inc` (same mechanism as `test_arc_pixels.c:10-14,166-180`). Run once to record, commit the `.inc`.
- [ ] **Step 2: Failing `cyrillic_checks()`** modelled on `vietnamese_checks()` (`test_terminal.c:60-92`): for every cp 0x0400..0x045F and each mono face, `ht_can_display(utf8, font, width, 1)` is true, `ht_text` keeps the exact bytes, and the rastered glyph differs from `'?'`; the phrase `"Какой цвет лучше?"` passes `ht_can_display` on all four; the arc face (`ht_arc_geist`) renders `"Ёлка"` without `?`.
- [ ] **Step 3: Run** `make device-test` — FAIL.
- [ ] **Step 4: Generator:** add `('ht_cyr_16',mono,16,10,22,17)`, `('ht_cyr_20',mono,20,12,28,22)`, `('ht_cyr_24',mono,24,15,32,26)`, `('ht_cyr_28',mono,28,17,38,31)`, `CYR = (...)`, range `(0x400, 0x45f)` for `CYR`; GeistMono carries the block, so no proportional squeeze. Run `python3 devices/harness-device/firmware/scripts/gen_habitat_fonts.py` from the repo root.
- [ ] **Step 5: Routing:** `glyph_font()` gains a Cyrillic branch after the Vietnamese one (`0x400 <= cp <= 0x45f`: mono_16→cyr_16, mono_20→cyr_20, face→face->cyr, mono_28→cyr_28); add `cyr` to `ht_arc_face_t` right after `viet`; fix the one **positional** initializer `ht_arc_geist` (`terminal.c:52-54`) — `ht_arc_inter_prop`/`ht_arc_inter_lower` (generated by `gen_focus_faces.py:166-169`) are designated and get `.cyr = NULL` implicitly; the arc ink lookup at `terminal.c:1480` treats `face->cyr` like `face->viet` (`full_ink`).
- [ ] **Step 6: Run** `make device-test` — PASS, with `latin_viet_golden()` unchanged and the frozen reference tests green.
- [ ] **Step 7: Commit** `feat(firmware): Cyrillic in the fixed-cell faces`.

### Task 7: Cyrillic in the Focus (Inter) faces, Latin byte-identical

**Files:**
- Add: `devices/harness-device/firmware/mockup/fonts-inter/Inter.ttf` (google/fonts `ofl/inter/Inter[opsz,wght].ttf`), plus a `SOURCE.md` with URL, commit and SHA-256
- Modify: `scripts/gen_lvgl_assets.py:34-36` (`TEXT`), `scripts/gen_focus_faces.py:42-50,74-92,108-147`
- Regenerate: `main/ui/habitat/focus_faces.c`, `focus_faces.h`, new `fonts/Inter-*-cyr.ttf`
- Test: `test/test_focus_faces.c` (new), `test/run.sh`, `test/test_touch_ui.py:3177-3179`

**Interfaces:**
- Produces: every `ht_lv_inter_*` face except `inter_bold_48` (wordmark) carries all of 0x0400–0x045F in its `codes`.

- [ ] **Step 1: Goldens before change:** `test_focus_faces.c` records into `test/focus_golden.inc` (print mode under `-DHT_UPDATE_FOCUS_GOLDEN`), per face: (a) FNV-1a 64 over bitmap **and** metrics (advance, box w/h, offsets) of every code point already in the face (all of `TEXT ∩ coverage`, incl. Latin-1, Latin Ext-A and the scattered Vietnamese letters); (b) a hash of the face's kerning data and line height/base line; (c) FNV-1a 64 of rendered straight text `"Hello, Harness — Tiếng Việt"` and of the same string on the curved arc via `ht_arc_inter_prop`. Record, commit.
- [ ] **Step 2: Failing assertions** in `test_focus_faces.c`: each listed face's `codes` contains every cp 0x0400..0x045F (binary search, as `ui_can_display` does at `ui_habitat.c:948-965`); golden hashes unchanged. In `test_touch_ui.py` add `assert(ui_can_display("Какой цвет лучше для экрана?", UI_FONT, 348, 8))`.
- [ ] **Step 3: Run** `make device-test` — FAIL.
- [ ] **Step 4: Fetch Inter** to `mockup/fonts-inter/Inter.ttf`, write `SOURCE.md`, keep `fonts/Inter-OFL.txt`. Install `fonttools` and use `npx lv_font_conv@1.5.2`.
- [ ] **Step 5: Generator:** add `range(0x400, 0x460)` to `TEXT`. In `gen_focus_faces.py`, instance a Cyrillic-only companion per stem (`fonts/{stem}-cyr.ttf`, same opsz/wght, subset to 0x400–0x45F) and pass it to `lv_font_conv` as an **additional** `--font … -r 0x400-0x45F`, keeping the vendored Latin instance with its ranges and the existing marks font (`NotoSansSymbols2`, `gen_focus_faces.py:118-122`) exactly as today. Change the self-check to assert on the generated codes: all of 0x400–0x45F present in every non-wordmark face.
- [ ] **Step 6: Regenerate** with `python3 devices/harness-device/firmware/scripts/gen_focus_faces.py` and run `make device-test` — PASS with every golden in `focus_golden.inc` unchanged. **If any golden changes** (shared metrics/kerning shifted by the combined conversion): convert the Cyrillic glyphs in a separate `lv_font_conv` run per face and merge only their glyph/cmap entries into the existing face tables in the generator, then rerun until goldens are unchanged.
- [ ] **Step 6b: Other generators audit.** For `gen_character_fonts.py`, `gen_creature_font.py`, `gen_octopus.py`, `gen_focus_marks.py`, `gen_lvgl_assets.py` (icons) and the `ht_pixel_40` face, confirm by call-site search that none draws agent/user text (expected from the code survey: portraits, ASCII art, icons, gallery only) and record one line per generator in the spec's Results section.
- [ ] **Step 7: Commit** `feat(firmware): Cyrillic in the Focus faces`.

### Task 8: Russian through every display-gated dial flow (integration regression coverage)

These tests are expected to **pass** once Tasks 5–7 are in; to prove they guard something, first run them against a checkout of `main` (they must fail there), then on the branch.

**Files:**
- Test: `test/test_question_ui.py`, `test/test_draft_ui.py`, `test/test_voice_ui.py`, `test/test_touch_ui.py`
- Modify (only if a test shows a gap): `main/ui/habitat/ui_habitat.c` near `:4686,4692,5324,5413`

- [ ] **Step 1: Failing tests:** a question with prompt `Какой цвет лучше для экрана квот?` and options `Зелёный`/`Синий` is `supported` (both the mono stub path and the Focus path in `test_touch_ui.py`); a dictated answer `Свой вариант с девайса` is accepted (no "Cannot show that answer…"); a draft page with Russian text has `can_send` true; a Russian line mixed with Latin and Vietnamese renders without `?`; an emoji-containing Russian answer is still refused.
- [ ] **Step 2: Run** the new tests on `main` — FAIL; on the branch `make device-test` — any failure is a gap left by Tasks 5–7 (e.g. the stubbed `ui_can_display` in the Python tests needs the new atlases linked: add `fonts.c` objects to those builds).
- [ ] **Step 3: Fix** any gap in `ui_habitat.c` or the test harness linking; run again — PASS.
- [ ] **Step 4: Commit** `test(firmware): Russian questions, answers and drafts on the dial`.

### Task 9: Build size, headroom and on-board check

**Files:**
- Modify: `docs/superpowers/specs/2026-10-26-dial-russian-design.md` (append a "Results" section)

- [ ] **Step 1: Sizes before:** on `main` (stash nothing; use a separate worktree) `cd devices/harness-device/firmware && idf.py set-target esp32s3 && idf.py build && idf.py size`, and `idf.py -B build-all -DDEVICE_ALL_SKINS=1 build size`. Record app image bytes vs the 0x7E0000 slot.
- [ ] **Step 2: Sizes after** on `feat/dial-russian`, same two builds. Expected: both images < 0x7E0000; growth ≈ 40 KB (atlases) + ≈ 134 KB (Focus faces).
- [ ] **Step 3: Headroom** (requires stage 0 done): for **both** the Focus build and the `ALL_SKINS` build, on `main` and on the branch, flash and read the `RAM tag=…` lines from `ram_telemetry` at boot and after opening a question; compare `psram_free`/`int_free`/`*_largest`. Expected: no allocation failures; record all four sets of numbers. A measurement that could not be taken is recorded as **incomplete**.
- [ ] **Step 4: On the board:** set the dial's voice language to Русский in the desktop app; with `DEEPGRAM_API_KEY` set via `HARNESS_ENV_FILE`, ask a Russian question to an openharness agent → it renders; answer by option and by Russian dictation; dictate one English sentence (direct path, nova-3); send a Russian draft; repeat one question on an `ALL_SKINS` build. Then unset the key and check English voice still works through the hosted path after `harness login`.
- [ ] **Step 5: Write Results** (sizes, headroom deltas, model choice, anything that failed) into the spec and commit `docs: Russian on the dial — results`.
