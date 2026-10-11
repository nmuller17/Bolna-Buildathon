# SignBridge features plan (talha/app-shell, 2026-10-11)

This plan turns Talha's 17 feature suggestions, refined by `CamelHack-handoff/feature_strategy/FEATURE_STRATEGY.md` (the "strategy"), into work for two builders who run in parallel on `talha/app-shell`. Builder G owns the guest side. Builder S owns the staff side, the server and the local speech-to-text process. The shared types are already in `web/lib/app/types.ts` (section "Features plan" at the end of the file, plus a few marked fields earlier in it), so neither builder has to wait for the other.

The order of precedence does not change: `engagement/decision_record.md` first, then `docs/app-plan.md`, then this plan. Where a suggestion collides with a rule in those files, the rule wins, and section 4 says what was changed and why. Talha asked for these features to be built (CLAUDE.md rule 8 is satisfied by that request), and every new file stays inside P4's paths from CLAUDE.md section 3: `web/app`, `web/components`, `web/lib/app`, `web/public`, `web/stt` (the local speech-to-text process, a new P4 folder) and `docs`, plus `scripts/demo.sh`. Nothing in this plan adds a guest listener path, a vendor call that runs without a staff opt-in, or any storage on the guest device.

---

## 1. How the suggestions and the strategy were merged

Talha's list and the strategy's ranked list mostly describe the same product. The strategy adds three things that change how some suggestions are built, and they apply to every row below.

**First, facts are never spoken and never come from speech recognition.** The strategy's top feature is "facts on screen, never said aloud, with a take-home copy". So the take-home card (suggestion 4) is fed by fact tiles that staff type or that come from the hotel's settings, never from captions, and a room number or Wi-Fi password is never sent to a voice or to any vendor.

**Second, every line says whether a machine or a person made it.** The strategy's feature 6 is not in Talha's list, but it costs hours and it protects the live captions (suggestion 3), which are machine output. It is built now as F6.

**Third, the strategy refuses a self-built room messaging channel and any emergency claim.** It argues that building room chat repeats what Kipsu, Canary and Hilton already run, and that it would conflict with the compromised-device rules. It also bans emergency and fire-safety claims, because a screen in a dark room may be asleep. So suggestion 8 ("Ask the front desk from your room") becomes roadmap, and the take-home card carries the hotel's own text number instead. Suggestion 9 (desk alerts) is built only for generic, non-emergency codes inside the live desk session.

Two rules from the engagement documents shape the guest side.

- **AS-3 forbids `localStorage`, `sessionStorage`, IndexedDB, the Cache API and service workers on the guest page.** So "remembered on the guest's own device only" (suggestions 1 and 10) means remembered in the page's memory for this conversation, on this device, and gone at the end. The strategy reached the same answer independently: remembering a communication mode across stays would be disability data. Remembering across visits is roadmap, for a native app on the guest's own phone, with an explicit opt-in.
- **AS-1 limits the guest reconnect snapshot to the last caption and the pending proposal.** Fact tiles and live captions are delivered as events and kept in page memory. They are not added to the snapshot. After a guest reconnect, staff tap "Send the facts again" (`resend_facts`). Adding facts to the snapshot needs Talha to amend AS-1 in the decision record first; the request is logged in `docs/requests.md` (Builder S, step S0).

The live-caption design follows Talha's relayed request and the design of `mcp-terra/src/mcp_terra/audio_summary.py` (read only). His request says to use the browser's built-in speech recognition, to say on screen that it sends audio to the browser maker, and to keep a typed fallback. The terra-mcp module adds the pattern around it: a chain of backends where the one in use is always named, a local backend that needs no cloud, text checked after Unicode normalisation before anything leaves the machine, child processes started with an argument list and never a shell, with timeouts and size caps. So the chain is:

1. **On this laptop**: faster-whisper with the already-cached `Systran/faster-whisper-small.en` model, int8 on the CPU, in a small process that listens on 127.0.0.1 only. This is the default whenever the process is running.
2. **Cloud: OpenAI speech-to-text**: P1's `/api/transcribe`, only when `OPENAI_API_KEY` is set and the profile allows cloud. Utterance at a time, not word by word.
3. **Cloud: Google (Chrome speech recognition)** or **Cloud: Apple (Safari speech recognition)**: the Web Speech API in the staff page. It is built and works with one tap, but only after the staff screen shows the disclosure that the audio goes to the browser maker. The disclosure stays on screen while it runs, and the guest's badge names the vendor too.
4. **Typed**: quick replies and typing, always there.

The badge on both screens shows exactly one of the `CAPTION_BACKEND_LABEL` strings in `types.ts`. A cloud backend is never labelled as local. In the `engagement` profile (decision record D8, no vendor keys) both cloud backends are refused by the server, so only local and typed captions exist there.

---

## 2. What is built now and what is roadmap

"NOW" means built on `talha/app-shell` by this workflow. "ROADMAP" means written down with the reason, not built. G is Builder G, S is Builder S. Every NOW row has acceptance tests in section 5.

| F | Feature (Talha's number, strategy rank) | Decision | Owner | Notes |
|---|---|---|---|---|
| F1 | Facts on screen, never said aloud (strategy 1; feeds Talha 4) | NOW | S (facts, quick-reply pinning), G (tiles) | Tiles for room, Wi-Fi, breakfast, checkout, late checkout, restaurant, parking, hotel text number. Values from staff typing or property settings only. Sensitive facts (room, Wi-Fi password) never reach `/api/tts`, a vendor or a log |
| F2 | Picture request board (Talha 2, strategy 2) | NOW | G | `BOARD_TILES`: all 20 guest intents as pictures with two-word labels, through the same BN-1 confirm card. No tile names a condition. "Key" in Talha's list maps to "Room problem" (intent 17), because there is no key intent in the fixed table |
| F3 | Live captions of the receptionist's speech (Talha 3, strategy 3 and 12) | NOW | S (backends, local process, streaming), G (captions view) | Word-by-word interim captions, large and resizable, `aria-live`, unsure words grey with a dotted underline, the badge, staff mirror and "Remove from guest screen". Captions never drive the avatar, never tick the checklist, and never create a fact tile |
| F4 | Take-home card (Talha 4, strategy 1) | NOW | G (card and QR), S (fact data) | "Show my card" shows the facts as text and as a QR code that holds the text itself, drawn in the browser. Nothing kept by the hotel. QR shown only after the guest's tap |
| F5 | Guest controls (Talha 5, strategy 3) | NOW, avatar speed ROADMAP | G | Existing repair row plus "Say it another way" and "Write the number"; avatar size (CSS, three steps), captions only, text size. Avatar speed needs a `rate` option in P2's `playGloss`, which today has only `onToken`; it stays a P2 request |
| F6 | Machine-or-human label on every line (strategy 6) | NOW | G (guest record), S (staff log) | `LineSourceLabel`: one label per line, enumerated in a test |
| F7 | Typed names and numbers (Talha 7) | NOW | G (number pad), S (event) | Names already exist (NAME intent, AS-13). New number pad: digits only, with "about" (nights, room, people, other), shown big on the staff screen, never spoken without a staff tap |
| F8 | Confirm before speaking with "Did you mean...?" (Talha 6) | NOW (extend) | G | BN-1 confirm and the recognition "Did you mean...?" exist. New: typed text is matched locally to the fixed requests, and the guest sees "Did you mean: What time is checkout?" with up to three choices, plus "Send my words as typed". A picked match is a fixed sentence (`via: "typed_match"`) |
| F9 | Visual alerts from the desk (Talha 9) | NOW (generic codes, in session) | S (sender), G (receiver) | Codes: come to the desk, taxi here, room ready, look at the desk. Full-width card, no sound, one flash unless reduced motion, vibration where the browser allows it. No emergency code (strategy section 4). Pager hardware ROADMAP |
| F10 | Accessibility preferences on the guest device (Talha 10) | NOW (page memory) | G | `GuestPrefs` in React state only (AS-3). Only mode, read-aloud and avatar on/off go to the server, through the existing actions |
| F11 | Human interpreter hand-off with an optional context card (Talha 11, strategy 5) | NOW | G (consent card), S (staff card) | The guest sees the exact card text first and ticks what to share (sign language, topics so far). No provider call: staff read or copy it. "Talk to an interpreter now" leads after HELP or after two failed recognitions |
| F12 | Mode choice, one tap (Talha 1, strategy 4) | NOW | G (screen), S (`tap` mode accepted) | Five equal choices: I sign, Read and type, Tap pictures, Read only (no avatar), Human interpreter. Changeable from the header on every screen. Camera only after "I sign" (recognition is already gated server-side) |
| F13 | Sign-language choice (Talha 13, strategy 4) | NOW | G | After "I sign": ASL (default) and five others. Any other choice shows `SIGN_LANGUAGE_NOT_YET` and leads to typing, pictures or an interpreter in one tap. The language is not sent to the server unless the guest shares it on the interpreter card |
| F14 | Staff micro-course (Talha 15, strategy 11) | NOW | S | Loopback-only `/staff/course`: the 20 receptionist sentences played by the avatar with the English caption and the gloss. Labelled "Computer avatar. Learn signing from a Deaf teacher" |
| F15 | PWA updates | NOW (small) | G | Keep the manifest from `dad4b47` (SES-11 as amended). Still no service worker or storage (AS-3). Only the manifest description changes to mention pictures and captions |
| F16 | Anonymous equal-access counters (Talha 16) | NOW | S | Counts only, in memory, reset on restart, small counts shown as "fewer than 5", no timings |
| F17 | Privacy receipt (Talha 17) | NOW | S (receipt from counters), G (end screen) | End screen lists what was used, which caption backend and voice, and which outside services received data (empty when offline), and that the conversation was erased at a given time |
| R1 | "Ask the front desk from your room" page (Talha 8) | ROADMAP | — | Strategy feature 13 and critique row 20: connect to the hotel's texting vendor instead. A room page on the guest's own phone needs Mode W and guest-owned phones, which are LATER in the decision record. NOW part: the hotel text number on the card (F1, F4) |
| R2 | Personal warm-up (Talha 12) | ROADMAP | — | Not trivial: it needs per-signer data, which conflicts with "nothing kept", and recognizer changes owned by P3 |
| R3 | Emergency alerts and pager integration | ROADMAP | — | Strategy section 4 bans emergency claims; pager hardware is LATER (DSH-9) |
| R4 | Remember preferences across stays | ROADMAP | — | AS-3; needs a native app and an explicit opt-in; it is disability data |
| R5 | Avatar speed | ROADMAP | P2 | Needs `PlayOptions.rate` from P2 |
| R6 | Accessible-stay amenities offer (strategy 7) | ROADMAP | — | Not in Talha's list; needs the hotel system for anything beyond a checklist |
| R7 | Wi-Fi-off self-test (strategy 10), signed YES (strategy 9), recognition fairness (strategy 14), Deaf staff mode (strategy 15) | ROADMAP | — | As the strategy dates them (0-6 and 6-12 months) |
| R8 | "Lobby too loud" warning (strategy 12) | NOW if time remains | S | The audio worklet already measures level; a staff-only hint, never a guest message |

---

## 3. Builder split and files

The two builders touch different files. The only shared file is `web/lib/app/types.ts`, which is already updated; any further change to it is additive and announced in the commit message.

### Builder G (guest side)

| Work | Files |
|---|---|
| F12 first screen with five choices; F13 sign-language step; mode switch in the header | `web/components/guest/GuestApp.tsx` (split new parts into the files below), new `web/components/guest/ModeChooser.tsx` |
| F2 picture board with inline SVG icons | new `web/components/guest/PictureBoard.tsx`, `guest.module.css` |
| F3 captions view: interim and final lines, grey unsure words, badge, backend note, retracted lines, resizable | new `web/components/guest/LiveCaptions.tsx`; `useGuestSession.ts` reducer cases `live_caption`, `caption_backend` |
| F1 tiles; F4 take-home card with QR | new `web/components/guest/FactTiles.tsx`, new `web/components/guest/TakeHomeCard.tsx`, new `web/lib/app/qr.ts` (a vendored, MIT-licensed QR encoder such as Nayuki's `qrcodegen`, with its licence header; no npm install scripts, no network) |
| F5 controls; F10 preferences panel in "More" | `GuestApp.tsx` (`MoreMenu`), new `web/components/guest/Preferences.tsx` |
| F6 line labels in the BN-5 record | `GuestApp.tsx` (`Scrollback`) |
| F7 number pad | new `web/components/guest/NumberPad.tsx` |
| F8 typed "Did you mean...?" | `GuestApp.tsx` (`TypePanel`); the matcher is a pure function in new `web/lib/app/typedmatch.ts` (G writes it with its unit test, because only the guest page calls it) |
| F9 alert receiver | new `web/components/guest/DeskAlert.tsx`; reducer cases `desk_alert`, `desk_alert_cleared`; action `ack_alert` |
| F11 interpreter consent card | `GuestApp.tsx` (`InterpreterPanel`) |
| F17 privacy receipt on the end screen | `GuestApp.tsx` (`EndScreen`) |
| F15 manifest description | `web/public/manifest.webmanifest` |

### Builder S (staff side, server, local speech-to-text)

| Work | Files |
|---|---|
| S0: docs and requests (AS-1 amendment request for facts in the snapshot; P2 `rate` request; route table rows) | `docs/requests.md`, `docs/app-plan.md` (sections 7, 8 and 11 rows pointing here) |
| Text hygiene (NFKC, control and zero-width characters removed, a small confusable fold, card numbers with a Luhn check, long digit runs, emails, "password is ..." phrases, API-key shapes) applied before any vendor call and any log line, and the guest-safe subset (card numbers) on live captions | new `web/lib/app/hygiene.ts`, `hygiene.test.ts` |
| Local speech-to-text process | new `web/stt/local_stt.py`, `web/stt/requirements.txt` (faster-whisper pinned), `web/stt/README.md`; venv `/Users/trehman/.venvs/signbridge-stt` (new; never the recognizer venv) |
| `/api/staff/stt` route, the forwarder to the local process, the caption state, rate limits, the latency stage | new `web/app/api/staff/stt/route.ts`, `web/lib/app/routes.ts`, `web/lib/app/store.ts`, `web/lib/app/runtime.ts` (`LOCAL_STT_PORT`, `LOCAL_STT_KEY`, health poll), `web/server.mjs` (body cap for this one path) |
| Staff capture and backends: audio worklet, energy gate, interim posts, browser speech with the disclosure, P1 cloud path, backend picker and badge, mirror with "Remove from guest screen" | new `web/public/stt/pcm-worklet.js`, new `web/components/staff/CaptionPanel.tsx`, `TalkPanel.tsx`, `useStaffDesk.ts` |
| Facts: property values (env `SB_PROPERTY_FACTS`, a JSON file path, read once at start, or typed in the Facts panel), per-guest values, quick-reply pinning, "Your room number is on your screen" hint, `resend_facts` | `store.ts`, `validate.ts`, new `web/components/staff/FactsPanel.tsx`; `say_quick room_number` uses the typed room ("You're in room 517.") with the digits as gloss tokens |
| Desk alert sender | new `web/components/staff/AlertPanel.tsx`; `store.ts`, `validate.ts` |
| Interpreter context card on the staff side | `store.ts` (build the card from the consent and the session), `StaffApp.tsx` banner |
| Micro-course page | new `web/app/staff/course/page.tsx` (staff listener only, same staff cookie check as `/staff`) |
| Equal-access counters and the privacy receipt | new `web/lib/app/counters.ts`, `counters.test.ts`; `store.ts` (session end builds `GuestPrivacyReceipt`) |
| Validation and rate limits for every new action | `validate.ts`, `store.ts` (`RATE` table), `routes.test.ts`, `store.test.ts`, `security-tests/*.test.mjs` |
| `demo.sh` starts the local STT process if its venv exists (`--no-stt` skips it), with a fresh `LOCAL_STT_KEY` kept in memory, and stops it by PID | `scripts/demo.sh` |

### The local speech-to-text process (Builder S)

This is the terra-mcp pattern applied to speech-to-text.

- **Install.** `python3 -m venv /Users/trehman/.venvs/signbridge-stt`, then `pip install faster-whisper==<pinned>` into that venv only. The model is loaded with `WhisperModel("small.en", device="cpu", compute_type="int8", local_files_only=True)` from `~/.cache/huggingface`, with `HF_HUB_OFFLINE=1` and `HF_HUB_DISABLE_TELEMETRY=1` set by the process itself before the import, so nothing is downloaded or sent. If the model is missing, the process exits with a clear message and the app shows "Local captions are off" (it never falls back to a cloud backend by itself).
- **Listener.** Python standard library HTTP server bound to `127.0.0.1` only (any other `--host` is refused). `GET /health` answers `{ok, ready, model}`. `POST /transcribe` takes raw 16 kHz mono signed 16-bit PCM with `Content-Length` required, at most `FEATURE_LIMITS.sttBodyMaxBytes`, `Content-Type: application/octet-stream`, and the header `X-STT-Key`, compared with `hmac.compare_digest` against `LOCAL_STT_KEY` (at least 32 characters, from the environment, never on the command line). It answers `LocalSttResponse` with word probabilities (`word_timestamps=True`, `vad_filter=True`, `beam_size=1`, `language="en"`).
- **Hardening.** One worker thread and a bounded queue of `FEATURE_LIMITS.sttQueueMax`; a full queue answers 503 "busy", and the app drops interim requests, never final ones. Audio is capped at 15 seconds per request, which bounds decode time; the app side times out at 8 seconds. Audio and text are never written to disk and never logged; the request log is switched off. The text is NFKC-normalised and control characters are removed before it is returned. The process exits cleanly on SIGTERM and SIGINT, and also when its parent process is gone. `demo.sh` starts it with an argument list (no shell string) and stops it by PID.
- **Streaming.** The staff page captures the microphone through an `AudioWorklet` (a same-origin file, allowed by the existing CSP), downsamples to 16 kHz and keeps the current utterance in memory. While the receptionist speaks it posts the whole utterance so far every 700 ms (interim). After 600 ms of silence, or at 15 seconds, it posts the final version with the end-of-speech time. The server forwards one request at a time per staff page, skips interim requests while one is in flight, runs hygiene, and publishes `live_caption` to both screens with a rising `rev`. The target is first words on the guest screen within about 1 to 2 seconds of speech. Builder S measures it and writes the real median and worst values (decode time, and end of speech to final caption) into `PROGRESS_LIVE_features.md` and the staff latency panel. No number is quoted anywhere that was not measured.
- **Where the audio goes.** The staff microphone goes to the staff page, then to `127.0.0.1:3000/api/staff/stt` (staff cookie), then to `127.0.0.1:<LOCAL_STT_PORT>`. The guest page still has no microphone and no `getUserMedia` (AS-19). The guest listener's path list (D6) does not change, because captions travel on the existing guest event stream.
- **Voice output.** No change in design: fixed guest sentences go through `/api/tts` when a key or Piper is configured, and otherwise the staff page uses an on-device `speechSynthesis` voice (`localService === true`). The staff header already names which one is live; the receipt (F17) reports it as "on_device" or "cloud".

---

## 4. Rules every feature keeps

1. **Nothing about the guest is kept on the server beyond the live session.** Facts, live captions, alerts and the interpreter card live in the session object and are wiped with it. The counters (F16) hold numbers only and are reset on restart.
2. **The guest device receives only its own conversation** (AS-1). New guest events carry no scores, no decode times, no counters and no other guests. `decodeMs` is staff-only.
3. **No personal data to vendors.** Facts are never sent to any vendor. Text that goes to a vendor route passes `hygiene.ts` first, and its redaction kinds are counted (not the values) on the privacy panel. Audio sent to a cloud speech backend cannot be redacted, which is why those backends are opt-in, labelled on both screens, and refused in the engagement profile.
4. **Render guest and staff strings as text.** React text nodes only; no `dangerouslySetInnerHTML`; the QR is drawn into a canvas or an SVG built from numbers, never from markup strings.
5. **Accessibility (WCAG 2.2 AA).** Layouts at 390x844, 1440x900 and 844x390 (landscape). Captions in an `aria-live="polite"` region, desk alerts in the assertive region. Nothing is sound-only (alerts never beep). Touch targets at least 44 by 44 CSS pixels. Plain English that never blames the guest ("The camera missed that sign", not "You signed wrong"). Reduced motion turns the alert flash into a steady border.
6. **No regressions.** Builders keep every behaviour from the app-alternative workflow (BN-1 to BN-5 screens, the UX review fixes in `07623d1`, the security review fixes in `25340b3`) and from the robust-demo workflow (`dad4b47`: one-command start, reconnect and stale states, missed-speech replay, WebGL loss fallback, installable guest page).
7. **Network rules on this Mac.** One Next.js server and one Playwright browser at a time; everything bound to 127.0.0.1; every process a builder starts is stopped by PID before the builder finishes; no network attack testing on this Mac.

---

## 5. Acceptance tests

"U" is a `node --test` unit test, "S" a security test in `web/security-tests`, "E" a Playwright run against a production build on 127.0.0.1, "M" a manual check written into the progress file with a screenshot.

### Regression gate (both builders, before and after their work)

- `npx tsc --noEmit -p web` is clean.
- `npm run test:unit` (49 tests at `dad4b47`, plus the new ones) and `npm run test:security` (38 at `dad4b47`, plus the new ones) pass.
- The robust-demo harness (`scratchpad/pw/robust/e2e_fix.mjs`, phases A, B and C as run for `dad4b47`) and the app-alternative UX walks (`scratchpad/pw/ux/*.mjs`) still pass, or each difference is explained in the progress file. `scripts/demo.sh --no-recognizer` still starts the app.

### F1 facts and F4 take-home card

1. U: with room "517" set by staff, `say_quick room_number` produces the caption "You're in room 517." and a `fact` event for `room`; the fact source is `staff_typed`.
2. U: a final live caption containing "room fifteen" or "415" produces no `fact` event (facts never come from speech recognition).
3. U and E: during a scripted session with room and Wi-Fi password set, `/api/tts` receives zero requests containing the room number or the password (instrumented route plus a Playwright request capture), and no server log line contains either value.
4. E: "Show my card" appears only after the guest's tap; the QR decodes (with a JavaScript QR decoder in the test) to plain text equal to the tile list; no request leaves 127.0.0.1 while the card is drawn.
5. U: after End guest, the session store holds no facts; the guest page shows the end screen with no tiles.
6. M: how the iPhone and Android camera apps show a plain-text QR is recorded as UNVERIFIED until tested on real phones (strategy Next 1, test 3).

### F2 picture board

1. U: `BOARD_TILES` covers all 20 guest intents exactly once.
2. E: every tile reaches the staff screen in exactly two taps (tile, then "Say it" or "Text only"), and the staff line reads "Tapped on board".
3. E: with the recognizer down (`--no-recognizer`), a full scripted check-in completes through the board and typing alone.
4. E: after two missed signs in a row, the board, typing and the interpreter are on screen without an extra tap.
5. E: every tile is at least 44 by 44 CSS pixels at 390x844 and 844x390; axe-core reports no serious violations; each tile's accessible name is its label.

### F3 live captions

1. U (Python, `web/stt/test_local_stt.py` with a stub model): 127.0.0.1 binding enforced; a wrong or missing key gives 401; missing Content-Length 411; an oversize body 413; a wrong content type 415; a full queue 503; no request text in the log.
2. M then E: with the real model and a recorded WAV of the 20 receptionist sentences played through the staff page's capture path, measure decode time and end-of-speech-to-final time; record the median and worst values; first interim words reach the guest page, measured in the page.
3. E: the badge reads "On this laptop" with the local process up; stopping the process switches the badge to "Typed" on both screens within 5 seconds and shows "Local captions are off" on the staff screen; it never switches to a cloud backend by itself.
4. E: choosing browser speech shows `BROWSER_SPEECH_DISCLOSURE` before the microphone starts; while it runs, the staff screen keeps the disclosure, the guest badge reads "Cloud: Google (Chrome speech recognition)" and `CLOUD_CAPTION_GUEST_NOTE` is shown, and the privacy panel counts the vendor use.
5. S: in the `engagement` profile, `caption_backend` with any cloud backend answers 409, and `live_caption` from the browser is refused.
6. U: hygiene turns a spoken card number (with or without spaces, Luhn-valid) into "[number hidden]" in the guest caption, normalises full-width digits and ligatures (NFKC) before matching, and removes zero-width characters.
7. E: interim revisions replace each other in place (no duplicate lines); the final line joins the guest record with the label "Staff speech, machine captions"; "Remove from guest screen" strikes the line out on the guest page with "Removed by the desk".
8. E: captions are in a polite live region, resize with the text-size control, and stay readable at 200% zoom; unsure words are grey with a dotted underline and `LIVE_CAPTION_NOTE` is shown.
9. U: live captions never call `playGloss` (the avatar plays only exact sentences) and never change a checklist item.
10. S: `POST /api/staff/stt` without the staff cookie is 401, from the guest listener or with a guest cookie is 403, over the size cap is 413; the guest page bundle contains no `getUserMedia` or `SpeechRecognition` (AS-19 grep).

### F5 guest controls and F10 preferences

1. E: each repair button (including "Say it another way" and "Write the number") produces exactly one prompt on the staff screen within 1 second.
2. E: avatar size has three steps; "Captions only" hides the avatar and stops `playGloss` calls; text size has three steps.
3. E: after a session, a Playwright storage dump of the guest origin shows empty `localStorage`, `sessionStorage`, IndexedDB and Cache Storage, and no service worker registration (AS-3, strategy Next 4 test 4).

### F6 line labels

1. U: a test enumerating every staff and guest line kind fails if any kind has no `LineSourceLabel`.
2. E: the guest record and the staff log show exactly one label per line.

### F7 numbers and F8 typed "Did you mean...?"

1. U: `guest_number` accepts 1 to 6 digits only and rejects anything else with a reason shown next to the field.
2. E: a typed number shows on the staff screen as "Guest typed: 3 (nights)" and is never voiced without a staff tap.
3. U: `typedmatch.ts` maps "what time is check out", "checkout?" and "late check out please" to intents 11, 11 and 12, and "my sister is coming" to no match.
4. E: a typed sentence with a match shows "Did you mean...?" with at most three choices plus "Send my words as typed"; a picked match goes through the BN-1 confirm card with `via: "typed_match"`.

### F9 desk alerts

1. U: `send_alert` accepts only the four codes; more than 3 open alerts or 6 a minute gives 429; an alert carries no free text.
2. E: the guest device shows the alert full width, in the assertive live region, with no sound; it flashes once, or shows a steady border under reduced motion; "OK" sends `ack_alert` and the staff panel shows "Seen".
3. M: `navigator.vibrate` is called only where it exists; the iPad has no vibration, which the staff panel says ("This device cannot vibrate").

### F11 interpreter hand-off

1. E: the guest sees the exact card text before ticking; with nothing ticked, the staff banner shows no card.
2. U: the card holds only the sign language (if ticked), topic names and an open fixed request; never a name, typed text or a number.
3. E: after a HELP proposal, or after two missed signs, "Talk to an interpreter now" is the first option.

### F12 mode choice and F13 sign language

1. E: five equal choices, one tap each; the header button changes mode from every later screen in one tap.
2. E: "I sign" then any language other than ASL shows `SIGN_LANGUAGE_NOT_YET` and reaches typing, pictures or the interpreter in one more tap; the server never receives the language unless it is ticked on the interpreter card.
3. U: `guest_choice` with `tap` is accepted and the staff header reads "Mode: tap pictures" with no per-guest advice text.

### F14 micro-course

1. S: `/staff/course` answers only on the staff listener with the staff cookie; it is 403 from the guest listener.
2. E: each of the 20 sentences plays on the avatar with its caption; with WebGL off it shows the sign key tags instead.

### F16 counters and F17 receipt

1. U: counters move with each event, hold no timestamps or per-session rows, reset on restart, and display "fewer than 5" for small counts.
2. U: the receipt lists exactly the ways used, the caption backends used and the vendors that received data, from real counters; offline it says no outside service received anything.
3. E: the end screen shows the receipt and "Erased at HH:MM".

### F15 manifest

1. E: Chrome's installability check reports 0 errors (as `dad4b47` did); no service worker is registered.

---

## 6. Order of work

1. Types (done in this commit) and this plan.
2. In parallel: Builder S starts with S0 (requests), `hygiene.ts`, the local STT process and its tests, then the route, store and staff panels. Builder G starts with the mode chooser, the board, the captions view (against the typed events, with a fake event source in tests), tiles and the card.
3. Integration: one production build, one Playwright run, the regression gate, then the measured caption latency.
4. Review passes (security and Deaf-guest UX, as in the earlier workflows), fixes, and the final fast-forward push of `talha/app-shell`.

## 7. Stage wording

The strategy's section 4 lines apply. In particular: say "Captions run on this laptop" only while the badge says "On this laptop"; never claim caption accuracy or latency without the measured numbers; say "No Deaf review has happened yet" until one has.
