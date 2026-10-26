# Russian on the round dial — design

- **Date:** 2026-10-26
- **Stage:** 1 of `2026-10-26-dial-roadmap.md`
- **Where:** fork only. Upstream is not a constraint.

Paths: `F/` = `devices/harness-device/firmware/`, `C/` = `cli/src/`.

## 1. Intent

The person speaks Russian to the dial and talks to Claude in Russian. Today that fails three ways:

1. **STT.** The dial sends `lang` (any ≤7-char code; `F/main/config_store.c:32-50`) in `voice.begin`; the daemon
   (`C/cable/cableSession.ts` ~1646) passes it to `CableHost.transcribe` (`C/cable/cableHost.ts` ~806), which
   uploads a WAV to the hosted openharness backend (`/api/voice/stt`). The backend's `pickWavLang`
   (`backend/src/lib/deepgramWav.ts:15-21`) turns anything outside `{en,vi,es,fr,ja,it}` into `en`, so Russian
   speech is decoded as English.
2. **Glyphs.** The dial has no Cyrillic. Fixed-cell atlases cover U+0020–00FF plus a Vietnamese atlas
   (`F/scripts/gen_habitat_fonts.py`, `F/main/ui/habitat/terminal.c`); the Focus skin's Inter faces are cut to
   the `TEXT` set in `F/scripts/gen_lvgl_assets.py:34-36`, which has no Cyrillic. `ht_can_display` /
   `ui_can_display` reject Cyrillic, so:
   - a dictated Russian answer to a question is refused ("Cannot show that answer…", `ui_habitat.c` ~5411);
   - a question whose prompt or options contain Cyrillic is marked unsupported on the dial (~4686, ~4692) —
     which would make stage 2 (answering Claude's Russian questions) useless.
3. **Host text filters.** The voice-draft send check allows only ASCII + Latin-1 (`C/cable/voiceDraft.ts`,
   `/^[\n\x20-\x7e -ÿ]*$/u`, two places), and the fallback voice router's tokenizer drops every
   non-`[a-z0-9]` character (`C/lib/voiceRouter.ts` `routeTokens`), so Russian agent names and activity never
   match.

**Success:** with the dial's voice language set to Russian, (a) Russian speech comes back as correct Russian
text, (b) Russian question prompts, options and dictated answers render on the dial and can be sent,
(c) the review/draft flow can send Russian text, (d) voice routing can match Russian words.

## 2. Goals, non-goals, anti-goals

**Goals**
- Direct Deepgram STT from the daemon with the person's own API key, language passed through (`ru` included).
- "Russian" selectable as the dial's voice language in the desktop app and the TUI.
- Cyrillic U+0400–U+045F renders in every text face the dial can draw user/agent text with, in the default
  (Focus-only) build and in a `-DDEVICE_ALL_SKINS=1` build.
- Host text checks accept Cyrillic wherever the firmware can now display it.

**Non-goals**
- Translating the dial's own UI strings (menus, toasts, errors). They stay English. Separate later stage.
- Language auto-detection, mixed-language utterances.
- Local/offline STT (Whisper etc.). It remains a fallback idea if Deepgram's Russian proves poor.
- Changing the hosted backend.

**Anti-goals** (would be a failure even if it "works")
- The Deepgram key appears in logs, crash reports, the cable protocol, the dial, git, or the chat.
- Without a Deepgram key configured, voice behaves differently than today (stock path must be untouched).
- English/Vietnamese rendering or STT regresses.
- The firmware image no longer fits its OTA slot, or the default build's memory headroom drops enough to
  cause allocation failures.

## 3. Design

### 3.1 Direct Deepgram STT (host)

- New code path in `CableHost.transcribe` (or a small `deepgramDirect.ts` next to it, builder's call): when a
  Deepgram key is configured, POST the same WAV the stock path builds to
  `https://api.deepgram.com/v1/listen?model=<m>&language=<lang>&punctuate=true&smart_format=false` with
  `Authorization: Token <key>` and `Content-Type: audio/wav`, and return
  `results.channels[0].alternatives[0].transcript` trimmed. This mirrors `backend/src/lib/deepgramWav.ts`
  (read its comments: the no-encoding-params rule and the measured per-language model choice).
- When the key is configured, the "Sign in on your computer to use voice" gate does not apply.
- No key → exactly today's path (hosted backend, sign-in required).
- **Language:** pass the dial's `lang` through unchanged (no allow-list on the direct path); an empty/invalid
  value falls back to the existing host fallback.
- **Model:** built-in per-language defaults that start from upstream's measured map: `vi` → `nova-2`
  (nova-3 returns empty transcripts for Vietnamese), everything else → `nova-3`, plus `ru` as measured below.
  Precedence: per-language config override > `DEEPGRAM_MODEL` (all languages) > built-in default. The `ru`
  default is settled by measurement, not assumption: before the stage is called done, transcribe at least one
  real Russian clip recorded on the dial (or the Mac mic at 16 kHz mono) with both nova-3 and nova-2 and
  record the result in the code comment, the way upstream did for `vi`. Also run one English and one
  Vietnamese clip through the direct path as regression checks.
- **Key configuration:** `DEEPGRAM_API_KEY` (and optional `DEEPGRAM_MODEL` / per-language map) read where the
  CLI reads env (`C/config/env.ts`). The devices service runs in its own process (`C/services/devices.ts`,
  `devicesProcess.ts`); the builder must make sure the value reaches that process and document, in the
  firmware README or the CLI docs, exactly where the person puts the key so a daemon started by the desktop
  app / launchd sees it. The person sets the key themselves; nobody pastes it into chat.
- **Errors** reach the dial as short English toasts, same style as `transcriptionFailure`: HTTP status and a
  category, never the key, audio or transcript. 401/403 → "Deepgram key rejected", network → existing
  wording.
- Existing caps unchanged (10 min PCM, 25 MB).

### 3.2 Language selection

- Add `ru` / "Русский" to the desktop picker (`desktop/lib/devices/device_settings.dart` ~200-232, ~270-279)
  and the TUI list (`tui/src/hardware.rs:9`). The CLI schema (`C/lib/harnessDevices.ts:102`) and firmware
  already accept `ru`.
- The mobile app's voice list is a separate feature; leave it.

### 3.3 Cyrillic glyphs (firmware)

- **Range:** U+0400–U+045F (Russian, Ukrainian, Belarusian, Serbian, … letters incl. Ё/ё). Nothing else.
- **Fixed-cell faces** (default/console skins and any fixed-cell text the Focus build still draws): add
  Cyrillic atlases alongside the Vietnamese ones, routed the same way (`glyph_font()`, the arc face struct
  `ht_arc_face_t`, `font_codepoint`). Source font: the generator's existing families; GeistMono and Geist both
  carry the full block (134 glyphs in U+0400–04FF measured). The builder picks mono vs proportional source the
  way the Vietnamese comment in `gen_habitat_fonts.py` reasons about cell width, and keeps the atlases in the
  same sizes the Latin faces come in (16/20/24/28 today).
- **Focus faces:** add `range(0x400, 0x460)` to `TEXT` in `gen_lvgl_assets.py` and regenerate
  `focus_faces.c` via `gen_focus_faces.py`. The vendored Inter instances have no Cyrillic; the variable
  `Inter.ttf` (OFL, google/fonts) must be fetched to re-instance. Record its source URL and hash next to the
  other font notes; keep the OFL text.
- **Other faces:** the builder checks every generator in `F/scripts/gen_*` that produces a face used for
  agent/user text (e.g. character/companion fonts under `DEVICE_ALL_SKINS`) and either adds the range or
  states in the spec's notes why that face never shows such text.
- **Display checks:** `ht_can_display` / `ui_can_display` accept the new range only where a glyph actually
  exists, so the existing "unsupported" paths keep working for scripts still missing (CJK etc.).
- **UTF-8 safety, end to end:** Cyrillic is 2 bytes per letter (Vietnamese up to 3). Byte truncation must
  never split a character anywhere text is copied, not only where it is drawn: cable ingestion (e.g. agent
  names `snprintf`'d into 40-byte buffers, `F/main/cable_client.c` ~1108), the shared `COPY` helper
  (`ui_habitat.c` ~301), precision-limited formatting, and the wrap/ellipsis helpers in `terminal.c` /
  `focus.c`. Display text is cut at a character boundary; opaque ids are rejected, never cut. Host-side byte
  caps (search phrase 120 bytes, answer 1200 bytes) stay as they are.
- **Focus faces keep Latin unchanged:** when re-instancing Inter from the variable font, take only the new
  Cyrillic glyphs from it if regenerating the existing Latin/Vietnamese glyphs would change their rendering.
- **Size:** estimate ~30–40 KB for fixed-cell atlases, ~90–135 KB for Focus faces. Check the built image
  against the OTA slot (`partitions.csv`, 0x7E0000) and report before/after sizes.

### 3.4 Host text checks

- `C/cable/voiceDraft.ts`: the two send/canSend regexes accept the Cyrillic block (and should mirror what the
  firmware can display; the builder may also fix the existing Vietnamese exclusion while there, as one shared
  constant).
- `C/lib/voiceRouter.ts` `routeTokens`: keep Cyrillic letters as token characters (the existing NFD +
  diacritic strip maps й→и, ё→е, which is fine for matching). Adding a handful of Russian stop words is the
  builder's call.

## 4. Testing

- **Host (vitest):** direct-Deepgram path with mocked `fetch` (URL/model/language/headers, key never in logs,
  401 handling, no-key path unchanged); `voiceDraft` accepts Russian; `routeTokens` keeps Russian words.
- **Firmware host tests (`make device-test`):**
  - coverage: every codepoint U+0400–U+045F is present in every generated face that should carry it
    (`gen_focus_faces.py` silently intersects with the source font's coverage, so assert on the output);
  - all four display-gated flows accept Russian: question prompt/options, dictated question answer,
    review/draft pages (`ui_habitat.c` ~5323), and anything else that calls `ui_can_display`;
  - English and Vietnamese rendering is unchanged (golden comparison of existing renders, not just
    "non-`?` pixels");
  - mixed Latin/Vietnamese/Cyrillic renders; truncation at every cut point never splits a 2- or 3-byte
    character, including in cable ingestion.
- **Size:** report image size and free heap/PSRAM headroom before and after, for the Focus-only build and the
  `ALL_SKINS` build (which also carries the ~4.6 MB companion art pack).
- **On the board (after stage 0):** set language to Russian; ask a Russian question to an openharness agent
  and see it on the dial; answer by voice in Russian; send a Russian draft; check the Focus build and an
  `ALL_SKINS` build.
- **STT measurement** as in §3.1.

## 5. Left to the builder

File placement of the Deepgram client, config key names beyond `DEEPGRAM_API_KEY`, atlas naming, source
font choice per face (with reasoning), whether to dedupe the "displayable text" regex into one shared
constant, and Russian stop words.
