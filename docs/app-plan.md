# SignBridge app plan (P4, branch p4-app): the build plan for this build

This is the plan two builders follow to turn the placeholder `/staff` and `/guest` pages into the working app. This is **revision 2** (2026-10-10, 22:00): section 0a says what is built tonight and what waits, and section 16 logs how each finding of the two critique passes was handled. It replaces the earlier draft (pushed as `89e0bdf`) and folds in everything that has been decided since: the red-team requirements RT1 to RT14, the compromised-device requirements AS-1 to AS-26, the engagement decision record D1 to D11, the TLS and pairing controls LT-01 to LT-31, the "build today" items from the slide work, and the product features Talha asked for. The shared types for both builders are in `web/lib/app/types.ts`, which was rewritten together with this plan.

Where documents disagree, the order of precedence is: the engagement decision record (`CamelHack-handoff/engagement/decision_record.md`) first, then this plan, then everything else. Where this plan changes a protected contract from CLAUDE.md section 6, the change is listed in section 14 and logged in `docs/requests.md`.

Throughout the product and this plan, SignBridge is a "front-desk communication aid". The software is never called an "interpreter"; the only interpreter is the human one the guest can ask for.

---

## 0. What changed from the draft, in one table

| Topic | Draft said | This plan says | Why |
|---|---|---|---|
| Guest link | Plain HTTP on the LAN, HTTPS a stretch | No plain HTTP off loopback, ever. Mode 0 (wired second display) or Mode C (one Ethernet cable plus HTTPS on `LAN_IP:3443`); Mode W (router) only if gate G2 passes | Decision record D3, RT2, AS-17 |
| Certificates | mkcert | Name-constrained event CA whose key is destroyed after issuing one leaf | D5 (mkcert's root can sign for any website) |
| Pairing code | 5 minutes, in `?s=` | 120 seconds, in the URL fragment `#p=`, QR drawn only after "Guest is here", full-screen, hidden on join | D6, AS-9 |
| Device check | None | 6-digit check code shown on the guest device and typed by staff, 3 tries | D6, AS-10 |
| Guest token | `sessionStorage` plus `X-Session-Token` and `?s=` on the stream | Only the `__Host-sb_g` cookie (Secure, HttpOnly, SameSite=Strict), rotated on reconnect | D6, AS-3, AS-4, AS-5 |
| Staff access | Loopback alone | Loopback plus a one-time staff capability cookie | D6, LT-30 |
| Security headers | `next.config.ts` `headers()`, `'unsafe-inline'` scripts | `server.mjs` alone sets them, with a per-response nonce CSP on `/guest` and `/staff` | D7, LT-27 |
| Sign files on the guest device | Per-gloss `GET /signs/<dir>/<file>.json` | One fixed-size `GET /signs/bundle` at pairing; per-gloss fetches only on loopback | D6 (response sizes would leak the signed sentence) |
| Recognizer input | `{signs: Prediction[]}` per utterance | The real bridge contract from `recognition/live.py --post`: `sign`, `utterance`, `framing` and `status` events with timestamps | `recognition/README.md` "App bridge" |
| Idle timer | Any guest tap resets it | Only staff actions and accepted sign batches reset it; 15-minute hard cap with staff-only "Extend 5 minutes" | AS-16 |
| Name sentence | Spoken on the guest's "Say it" | Shown on the staff screen first; spoken only after staff tap "Speak name", with an on-device voice | AS-13 |
| Gate | 0.6 for every sign | 0.6 by default, a higher bar for YES, NO, NAME, ROOM and HELP, traffic-light display, "Did you mean...?" and a top-3 picker | Slide "build today" item 3 |
| Vendor keys | Optional | None during the attack window; the app must work fully offline | D8 |
| `CHECKOUT` | `FS-CHECKOUT` | `LEAVE` (alias `FS-CHECKOUT` -> `LEAVE` until the recognizer is retrained) | `docs/vocabulary.md` |

---

## 0a. Revision 2 (2026-10-10, 22:00): what we build tonight, and what waits

Two critique passes read revision 1 of this plan: a stage-readiness review and a review from the point of view of a Deaf ASL-using guest. Every finding is accepted, accepted with a change, or rejected in the critique log (section 16), and the sections below already include the result. The most important consequences are these.

**The old plan did not fit the time left.** Revision 1 estimated about 22 builder-hours, and at 21:44 on hackathon day both screens were still stubs. So the work is now split into tiers, and only Tier 0 is BUILD-NOW. Every requirement row in section 11 carries its tier in the "When" column.

| Tier | When column | What it is for | Contents |
|---|---|---|---|
| **Tier 0, stage MVP** | `NOW` | The hackathon demo tonight, all on loopback (Mode 0) | Store and bus on `globalThis`; the guest and staff streams on loopback with a 2-second guest ping; the staff capability cookie with a re-claim path; Mode 0 with separate origins for staff and guest; staff quick replies and reviewed free text; guest captions with the avatar; the guest first screen and every proposal state; bridge ingest with validation, consent gate, the app's own gate, matching, proposal protection, "Send" and "Fix"; the speak plan through Nath's `/api/tts`; Help; End guest, idle wipe and cap with the stage profile; the simulator; the co-pilot checklist; latency, privacy and benchmark panels from real counters; the wording and colour fixes from the guest review |
| **Tier 1, engagement gate G1** | `G1` | The security engagement on the wiped loaner, never on the development Mac | The TLS guest listener; pairing with QR and check code; the nonce CSP and the move of the security headers into `server.mjs`; the per-address connection cap; the sign bundle; device binding; Help with a dead cookie; "I need more time" |
| **Tier 2** | `T2` | After G1 items, if time allows | Token rotation with a grace period; the full safety warning set; device health; the local vision-model UI; skeleton drawing; Playwright and axe-core; landscape guest layouts; the framing position diagram |
| **Later** | `LATER` | Not this event | As in revision 1 (gates G0 and G2, Mode W, the pager, the LLM fallback, and so on) |

**The stage runs on Mode 0.** Mode C (a separate guest device on a cable) cannot be rehearsed on this Mac, because nothing may listen on its network interfaces, and decision record D1 and D2 keep the development Mac out of the engagement entirely. The decision Talha must take now is which kind of Mode 0 the stage uses (section 15, question 1):

- **Recommended: Mode 0 with guest input (stage only).** The guest window runs on the wired second display at `http://localhost:3000/guest`, with its own mouse or a touch monitor and a USB keyboard, so the guest taps "Send", "Fix", "Type" and "Get staff now" themselves. This needs `SB_PROFILE=stage` and `MODE0_GUEST_INPUT=1`. It is a stage compromise, said out loud: both windows run on one laptop. The engagement profile never allows it, because decision record D3 makes Mode 0 display-only.
- **Alternative: Mode 0 display-only, exactly as D3.** The guest window shows no buttons at all, only instructions ("Point to YES or NO on the card"), and the receptionist confirms for the guest with a laminated YES / NO / TYPE / INTERPRETER / HELP card on the counter. On stage we say that confirm-before-speaking is weaker in this mode because staff press the button for the guest.

A phone or a second laptop as the guest device (Talha's earlier choice) is Mode C, which belongs to Tier 1 and gate G1 on the isolated loaner. It is not on stage tonight.

**Demo-killing traps fixed in this revision.** Clear-Site-Data on the shared `127.0.0.1` origin would have deleted the single-use staff cookie at the first End guest; the Mode 0 guest window now runs on `localhost`, a different cookie site, and the staff listener never sends Clear-Site-Data (section 9.6). Honouring the recognizer's `needs_repeat` would have turned every "Did you mean...?" into "sign again"; the app now decides from its own gate (section 6.3). The guest's reach to tap "Send" would have been segmented as a sign and replaced the proposal; a pending proposal is now protected (section 6.3). Rotating the token on every reconnect with no guest ping would have made the guest connection fall over by itself; the guest stream is pinged every 2 seconds and rotation is Tier 2 with a grace period (section 9.4). The 120-second idle wipe would have ended the demo mid-way; the stage profile uses 10 minutes (section 9.2). A recognizer restart could silently drop every sign; a lower `seq` is now a restart, never a replay (section 6.1).

---

## 1. Goals and non-goals

### Goals

The app has to carry the CLAUDE.md section 9 demo end to end. The receptionist works on the laptop at `http://127.0.0.1:3000/staff`. The guest follows the conversation on a second screen: a wired second display in Mode 0, or a team-owned iPad, phone or wiped laptop joined by one Ethernet cable in Mode C. A desk camera on the laptop feeds Python MediaPipe and P3's classifier, and `recognition/live.py --post` sends recognised signs to the app over loopback. The guest device only displays the conversation and takes taps and typing. It never uses a camera or a microphone, and no video ever leaves the laptop.

The scripted path must work with no cloud service at all. Every one of the 20 receptionist sentences can be sent with one tap, every one of the 20 guest requests is matched from a fixed table, and guest sentences are voiced by Piper or by an on-device browser voice. Speech-to-text, ElevenLabs and Claude are improvements on top of that path, never requirements for it, and during the security engagement window no vendor key is present on the laptop at all.

The guest stays in control. Every recognised sign is shown to the guest as a word with a traffic light and a plain word ("clear", "not certain", "missed"), never a percentage, and nothing is spoken at the desk until the guest sends it. The guest's first screen offers Sign, Type (with the 20 requests as phrase buttons), Ask for a human interpreter and Text only as equal choices; the guest can tell the desk "Please repeat" or "I don't understand" with one tap; and the "Get staff now" button stays visible on every guest screen.

The receptionist gets a co-pilot. The staff screen shows which standard check-in items have actually reached the guest, flags the ones that have not with gentle wording, and shows the evidence behind every recognised sign: its uncalibrated model score, its timestamps and, when the recognizer sends one, a skeleton snapshot, never video. The guest is told what the desk sees.

The security and privacy claims must be real and testable. Staff functions are reachable only from the laptop itself with a staff capability. Guest functions are reachable only with a valid, expiring, single-device cookie over HTTPS. There are no secrets in the browser, the app writes nothing about the conversation to disk (Piper's temporary audio of fixed sentences is stated honestly), nothing about what people said is logged, and the privacy and latency panels show numbers that come from real counters and real timestamps.

### Non-goals

The app does not handle video. There is no `<video>` element, no `getUserMedia` call and no camera or microphone permission anywhere in the guest page; the desk camera belongs to P3's Python process, and the staff page uses only the microphone for P1's hold-to-talk. The app does not run sign recognition or train models, and it does not render the avatar itself; it consumes P3's bridge events and P2's `mountAvatar`/`playGloss`. It persists nothing: there is no database, no file and no browser storage of conversation content. It supports one guest at a time at one desk, with no user accounts. It does not translate free signing; recognition is the closed vocabulary of 21 signs plus `NONE`. It does not detect spyware and never claims to; the device-health hint is a load indicator only. The local vision-model fallback is a reserved slot and a disabled UI in this build, not a working feature. The pager panel is a mock, built only if time remains.

---

## 2. Deployment modes, devices and listeners

### 2.1 The three modes (decision record D3)

The rule is that nothing listens off loopback over plain HTTP, ever. There is no switch that allows it.

| Mode | Guest device | Network | Guest listener | When it is used |
|---|---|---|---|---|
| **Mode 0, display only** | A second browser window on a **wired** second display (HDMI or USB-C, never AirPlay or Sidecar) attached to the demo laptop | None. Wi-Fi and Bluetooth off | None. The guest window uses the loopback listener on its own origin, `http://localhost:3000` (staff stays on `http://127.0.0.1:3000`) | Always available, and **the mode for the stage tonight**. In the engagement profile it is display-only, exactly as D3: the guest points at a laminated card and the receptionist confirms on the staff screen; the documents and the staff screen say so. In the stage profile with `MODE0_GUEST_INPUT=1` the guest window has its own mouse or touch screen and keyboard, labelled as a stage compromise (section 0a) |
| **Mode C, cable** (default for the attack window, if gate G1 passes) | A team-owned iPad (USB-C Ethernet adapter), a team phone with an adapter, or a wiped team laptop | One Ethernet cable, laptop `10.77.0.1/30`, guest `10.77.0.2/30`. Wi-Fi and Bluetooth off on both | HTTPS on `10.77.0.1:3443`, TLS 1.3, event CA certificate | The normal demo with a separate guest device |
| **Mode W, Wi-Fi** | Team guest device, plus testers' own phones only in scenario S3b | Team-owned travel router with two networks, WPA3-SAE, PMF required, client isolation (decision record D3) | HTTPS on `192.168.8.10:3443` | Only as an announced, separate scenario, and only if gate G2 passes by T minus 1 day |

The iPhone Personal Hotspot is rejected for every mode, and tunnels such as ngrok are never allowed. Talha's development Mac never runs the demo during the engagement and is never joined to the event network (D1, D2); the system under test is a wiped, unmanaged Apple-silicon loaner.

### 2.2 One process, two listeners

```
 DEMO LAPTOP (loaner, standard user)                                           GUEST DEVICE (Mode C/W)
 ┌──────────────────────────────────────────────────────────────────────┐      ┌──────────────────────┐
 │ Desk camera ─► recognition/live.py (P3, Python MediaPipe, local)      │      │ /guest (HTTPS only)  │
 │                 │ POST /api/guest/signs, X-Bridge-Key, events only    │      │ captions, avatar,    │
 │                 ▼ (no video, no landmarks except the opt-in skeleton) │      │ live signs, Send /   │
 │ node web/server.mjs (one process, one Next app, two listeners)        │      │ Fix, Type, Help      │
 │   ├─ STAFF listener  http://127.0.0.1:3000   (loopback only) ◄──────┐ │      └──────────▲───────────┘
 │   │    /staff, staff APIs and stream, bridge ingest, simulator,     │ │                 │ TLS 1.3, cookie
 │   │    P1 routes, english/tts, per-gloss /signs; in Mode 0 also    │ │                 │ __Host-sb_g
 │   │    the guest window                                             │ │                 │
 │   └─ GUEST listener  https://LAN_IP:3443     (Mode C/W only) ───────┼─┼─────────────────┘
 │        D6 path list only; role "guest" whatever the socket address  │ │
 │ Browser: /staff (mic for hold-to-talk, speaker) ─────────────────────┘ │
 │ Recognizer server (optional) http://127.0.0.1:8000, loopback only      │
 └──────────────────────────────────────────────────────────────────────┘
        │ optional, never during the engagement window (D8):
        ▼ OpenAI (P1 transcribe, staff audio), Anthropic (english fallback, labels only), ElevenLabs (fixed sentences)
```

The **listener decides the role**, not the socket address. Every request that arrives on the guest listener is treated as a guest request (`x-sb-loopback: 0`), even in a test where the guest listener is bound to 127.0.0.1, and only the decision record D6 path list is served there. The staff listener binds only 127.0.0.1 and computes loopback from the socket as today.

The guest listener starts only when `npm run start:guest-tls` is used. It refuses to start unless `LAN_IP` is set explicitly, lies inside `LAN_NET`, and `TLS_KEY_FILE` and `TLS_CERT_FILE` exist; there is no automatic address choice and no plain-HTTP fallback. Today's `--lan` plain-HTTP listener on `LAN_IP:3000`, its `firstLanIPv4()` fallback and the `dev:lan` and `start:lan` scripts are removed in build step 0 (Tier 0), so no teammate or tester can start them. Development mode (`npm run dev`) is never reachable from a network: it has the staff listener only. Builders test the guest layout on loopback in a 390x844 browser window; real-device tests happen on the isolated test machine (`docs/security-testing.md`).

| Script | Listeners | Use |
|---|---|---|
| `npm run dev` | Staff 127.0.0.1:3000, development | Building |
| `npm run build` then `SB_PROFILE=stage MODE0_GUEST_INPUT=1 npm run start` | Staff 127.0.0.1:3000 (guest window on `localhost:3000`), production | Mode 0 stage demo (Tier 0) |
| `npm run build` then `npm run start` | Same, engagement profile, display-only Mode 0 | Mode 0 during the engagement |
| `npm run build` then `npm run start:guest-tls` | Staff 127.0.0.1:3000 plus guest `LAN_IP:3443` HTTPS, production | Mode C and Mode W (Tier 1, isolated loaner only) |
| `npm run test:security`, `npm run test:unit` | Test listeners on 127.0.0.1 only | Regression suites |

---

## 3. Teammate APIs this build uses (as merged on p4-app)

| Owner | API | How the app uses it |
|---|---|---|
| P1 (Maya) | `POST /api/transcribe`: multipart field `audio`, returns `{ text }`; 503 without `OPENAI_API_KEY`; errors `{ error }` | Staff hold-to-talk. The staff page records with `web/lib/voice/recorder.ts` and posts the blob. Without a key the button is disabled with "Speech-to-text is off (no vendor key); type or use a quick reply" |
| P1 | `POST /api/gloss`: `{ text }` -> `{ gloss: string[] }`; local mapping, no vendor call | Gloss for typed or transcribed staff text. The server re-validates every token (REQ CAP-2) |
| P1 | `web/lib/voice/intents.ts`: `mapStaffTextToIntent`, `mapStaffTextToGloss`, `fallbackGlossFromText`, `numberTokens`, `STAFF_INTENTS` (20 string ids such as `"checkout_time"`) | Server-side fallback when `/api/gloss` fails, and the intent key of each staff line for the co-pilot checklist. Our quick replies use the same 20 string ids (`STAFF_INTENT_KEYS` in `types.ts`) |
| P2 (Cosme) | `mountAvatar(container, { style })` -> `{ webgl, unmount }`; `playGloss(gloss, { onToken })`, a newer call interrupts the older one; `setAvatarStyle`; `getAvatarFps`; `lookup.ts` `loadIndex`, `resolveToken` | Guest screen avatar. Captions come first; `onToken` drives the highlighted gloss word |
| P2 | `web/components/AvatarCaptions.tsx` default export `{ text?, gloss, activeIndex, large? }` | Captions under the avatar on the guest screen |
| P2 | `/avatar/bellhop.glb` (8 MB, static) | Avatar model. On the guest listener it is served only if Talha accepts the proposed D6 amendment (section 8); otherwise the guest uses the `hologram` style, which needs no model file |
| Nath (P4 teammate) | `POST /api/tts`: `{ text }` (one plain sentence, at most 300 characters) -> `audio/wav`; ElevenLabs if a key is set, otherwise Piper; only the 19 fixed guest sentences are cached. **Since the 2026-10-11 merge of p4-app 27e6b51: ElevenLabs only; Piper runs only with `PIPER_FALLBACK=1`; without a key the route answers 500 and the staff page falls back to an on-device browser voice (`localService`) or text only** | Voicing a confirmed **fixed** guest sentence. The staff browser only ever sends the fixed table sentence that the server put in the speak plan; names and typed text never go to this route. RT5 asks Nath to accept `{ id }` instead |
| Nath | `POST /api/english`: `{ signs: Prediction[] }` -> `{ text }`; fixed table first, Claude for other sequences | Not on the scripted path. The app matches intents itself (order-insensitive, which `/api/english` is not). The Claude path is the LATER `ENGLISH_FALLBACK` item |
| Nath | `web/components/speakSigns.ts` `warmUpVoice()` | Called once by the staff page after "Start desk", so Piper pre-generates the fixed sentences before the guest arrives; the recognizer is started only after the header says "Voice: ready". The staff page plays WAVs through its own unlocked `AudioContext`, not `new Audio()` (C1-16) |
| P3 (Talha) | `recognition/live.py --post http://127.0.0.1:3000/api/guest/signs`, header `X-Bridge-Key` (at least 32 characters), events `sign`, `utterance`, `framing`, `status`, each with `t_sent` | The only source of recognised signs (section 6) |

---

## 4. Screen-by-screen specification

### 4.1 Design direction

The visual idea stays the hotel lobby directory board: deep navy and white with brass key-tag details. Every gloss word, whether in a caption's sign cards, the live sign strip or a proposal, is drawn as a brass hotel key tag with a punched hole and the word in capitals, with navy text on the brass (white on brass fails contrast). The typeface is the system font stack only (`system-ui, -apple-system, "Segoe UI", sans-serif`), because AS-24 asks for system fonts and the nonce CSP has no font host. Guest captions use `clamp(2rem, 1.25rem + 3vw, 4rem)`, so browser zoom and large text settings still scale them (WCAG 1.4.4); guest buttons are at least 64 px tall.

Colours are defined per surface, because the guest screen is light-on-navy and the staff screen is dark-on-white. Every pair below was computed against WCAG 2.2 AA, and a unit test (`theme.test.ts`) checks every foreground and background pair in the token table: at least 4.5:1 for text and 3:1 for graphics.

| Token | Value | Use | Contrast |
|---|---|---|---|
| `--navy` | `#0E2A47` | Guest background, staff headers | — |
| `--white` | `#FFFFFF` | Guest text | 14.6:1 on navy |
| `--brass` | `#E2B33C` | Key tags, the send button, threshold line; always with navy text | 7.5:1 navy on brass |
| `--ink` / `--paper` / `--rule` | `#142235` / `#FFFFFF` / `#D5DCE5` | Staff text, background, dividers (the rule is decoration only) | 16.0:1 ink on paper |
| Guest lights `--g-go` / `--g-wait` / `--g-missed` | `#66BB6A` / `#FFB74D` / `#B0BEC5` (neutral grey, not red) | Light shapes on navy | 6.2 / 8.4 / 7.7 :1 |
| Staff lights `--s-go` / `--s-wait` / `--s-stop` | `#2E7D32` / `#8A5200` / `#B3261E` | Light shapes and their words on white | 5.1 / 6.4 / 6.5 :1 |
| `--alarm` | `#B3261E` with white text | The Help banner only, always with an icon and words | 6.5:1 |

Information is never carried by colour or sound alone. Copy is plain English in sentence case. `prefers-reduced-motion` turns flashing banners and markers into solid ones.

**Traffic light.** Each recognised sign gets one light from its top-1 model score and its label's bar (section 6.3): green at 0.8 or above, amber from the label's bar up to 0.8, red below the bar, for `NONE`, or when framing rejected the sign. It is drawn as a filled, half-filled or hollow circle next to the word. The words differ by screen (`LIGHT_WORDS_GUEST`, `LIGHT_WORDS_STAFF` in `types.ts`). The guest sees "clear", "not certain" or "missed" and never a number: the scores are uncalibrated, so a percentage would suggest a precision that does not exist, and the guest device never receives the score at all. Staff see "high model score", "borderline model score" or "low model score" with the number labelled "model score (uncalibrated)", and the red reasons say what the system did ("camera missed it (framing)", "camera saw no known sign"), never that the guest signed badly.

### 4.2 Staff dashboard (`/staff`, laptop 1440x900, staff listener only)

The staff screen is laptop-only and needs Chrome (Safari blocks audio started long after the user gesture). Before anything else it shows one "Start desk" button. Pressing it is the user gesture that creates and unlocks one `AudioContext`, which plays every later WAV from `/api/tts`; claims the staff capability if the page was opened from a one-time `#k=` URL and then removes the fragment with `history.replaceState` (section 9.6); opens the staff event stream; and calls `warmUpVoice()`. The header shows "Voice: warming up" until the fixed sentences are ready, and the demo script starts the recognizer only after that, so Piper and MediaPipe do not compete for the processor while the guest signs.

```
+------------------------------------------------------------------------------------------------------------------+
| SignBridge  front-desk communication aid   [MODE 0, STAGE, guest input on]                         [ End guest ] |
| Guest window: this laptop (localhost)   Heard 2 s ago (o)   Streams 1   Idle wipe 9:42 (stage: 10 min)            |
| Session ends in 12:10 [Extend 5 min]   Recognizer: ok, 27 fps   Framing: OK   Voice: ready   Vendor keys: none    |
+------------------------------+-------------------------------------------------+---------------------------------+
| TALK TO THE GUEST            | CONVERSATION (memory only, wiped at End guest)  | CHECK-IN CO-PILOT               |
| [      Hold to talk      ]   | 10:02 You    Welcome!                           | Shown on the guest screen does  |
| Speech-to-text is off        |              [HELLO][WELCOME]  shown on device  | not mean understood. Pause and  |
| (no vendor key)              | 10:02 You    Do you have a reservation?         | check with the guest.           |
|                              | 10:02 Guest  Yes, I have a reservation.          | (*) Greeting       shared 10:02 |
| This text will appear on the |              YES (*) .94  RESERVATION (*) .88   | (*) Reservation    shared 10:02 |
| guest's device:              |              read aloud 10:02                    | (*) Guest name     shared 10:03 |
| [___________________] [Send] | 10:03 Guest  My name is Ana Maria.               | ( ) ID checked  not shared yet  |
| (speech lands here first:    |              [Speak name]   not spoken yet       |                       [I saw it]|
|  [Send] [Discard])           | 10:04 You    You're in room 412.                 | (?) Room number needs another   |
|                              |              Guest: "I don't understand"         |     try (guest did not          |
| QUICK REPLIES                | ...                                              |     understand)                 |
| [Welcome!]  [Reservation?]   | LIVE SIGNS   MORE (*) .91  TOWEL (/) .72        | (!) Wi-Fi  guest asked 10:05;   |
| [Your name?] [See your ID?]  |              ( ) .41 low model score            |            not answered yet     |
| [Nights?]   [Room 412]       +-------------------------------------------------+ ( ) Breakfast   not shared yet  |
| [Key card]  [Elevator left]  | GUEST SAYS (40 px)                              | ( ) Checkout    not shared yet  |
| [Breakfast 7-10] [Wi-Fi]     | "Could I have more towels, please?"             | ( ) Anything else? not asked    |
| [Checkout 11] [Late checkout]| sent by the guest 10:06   [Speak again]         | ( ) Farewell    not shared yet  |
| [Towels] [Parking] [Restaur.]|                                                 |                                 |
| [Taxi] [One moment] [Repeat?]|                                                 | Gentle reminders only; nothing  |
| [Anything else?] [Enjoy stay]|                                                 | here blocks the conversation.   |
+------------------------------+-------------------------------------------------+---------------------------------+
| [Evidence] [Latency] [Privacy] [Benchmark] [Simulator*] [Safety, Tier 2] [Device, Tier 2]  (* SB_SIMULATE=1)    |
| EVIDENCE  Low scores usually mean camera position or a sign the model learned poorly, not how the guest signs.  |
|           #7 TOWEL (/) borderline model score .72 (uncalibrated)  moved 10:06:01.20-01.95  predicted +0.55 s      |
|           alternatives MORE .19, NONE .05   skeleton: none from this recognizer build                            |
+------------------------------------------------------------------------------------------------------------------+
```

**Header strip.** It shows the deployment mode and profile badge (for example "MODE 0, STAGE, guest input on"), where the guest window is (Mode 0) or the paired device class and address (Mode C, never the raw User-Agent), the guest heartbeat ("Heard 2 s ago", amber after 20 s, red after 45 s, fed by the guest's heartbeat POST every 5 s and by its acknowledgements), the number of guest streams, the idle-wipe countdown with the value in force ("stage: 10 min"), the time left before the 15-minute cap with "Extend 5 min" during its last 2 minutes, the recognizer state (`ok`, `mock`, `no_model` or `down`) and frame rate, the framing status with "not OK for 25 s" once it has been bad for 10 seconds, the voice warm-up state, whether vendor keys are configured, and the End guest button. With no session it shows a large "New guest" button instead.

When the recognizer reports `no_model` or `mock`, or sends nothing for 5 seconds, the header is replaced by a large amber band: "Signing is not available: the recognizer reports no model. Use Phrases or Type, or switch to the declared simulator rehearsal." The guest's Sign card is disabled at the same moment (section 4.4). When framing has been bad for 10 seconds the header adds the runbook hint from `FRAMING_STAFF_HINT`, for example "If the counter hides the hips, restart the recognizer with --waist none".

**Left column.** Hold-to-talk with a note saying where speech goes, the free-text box labelled "This text will appear on the guest's device" (AS-26), and the 20 quick replies for `docs/vocabulary.md` section 1. A transcript from hold-to-talk is put into the free-text box for review with "Send" and "Discard"; it never goes to the guest without a tap. Staff are briefed never to say or type the Wi-Fi password, card numbers or another guest's details while the guest can read them (RT13).

**Middle column.** The conversation log, newest at the bottom, in memory only. Staff lines show the text, the gloss as small key tags, whether the guest device has shown it ("shown on device" after its render acknowledgement), and any repair reply the guest tapped under it ("Guest: I don't understand"). Guest lines show the sent sentence, each sign with its light and score, and whether it was read aloud. A guest NAME line shows "Speak name" and "not spoken yet" until staff tap it; a typed guest message shows "Read aloud". The guest's own changes ("Guest chose to type", "Guest turned off reading aloud") appear as neutral grey log lines, never as warnings. An utterance ignored because a proposal was waiting appears as a grey line "Camera saw a movement while the guest was choosing; ignored". Under the log, the live sign strip shows each sign the moment it is recognised, and the latest sent guest sentence is shown at 40 px with "Speak again". When the Mode 0 guest window is display-only, a pending proposal also appears here with "Guest pointed YES: send for the guest" and "Guest pointed NO", labelled "The guest cannot tap in this mode. Ask them to point at the card on the counter."

**Right column: the check-in co-pilot.** Thirteen standard check-in items (`CHECKIN_ITEMS` in `types.ts`): greeting, reservation, guest name, ID check, number of nights, room number, key card, elevator, Wi-Fi, breakfast, checkout time, anything else, farewell. A fixed note sits at the top: "Shown on the guest screen does not mean understood. Pause and check with the guest." An item is **shared** (filled circle, time) only when a staff line carrying one of its intents was rendered on the guest device, which the device acknowledges; **sent** (half circle) when it was sent but not yet acknowledged; **needs another try** (question mark) when the guest tapped "I don't understand" or "Please repeat" under that line; and **not shared yet** (hollow circle, grey text) otherwise. When the guest asks about an item (for example `FS-WIFI PASSWORD`) before it was shared, the item shows "(!) guest asked 10:05; not answered yet". The ID check has an "I saw it" button because it happens on paper. The checklist tracks staff actions only: it never shows how fast the guest answered or how often they repeated a sign. Nothing in it blocks or nags; it is a reminder, inspired by ProtoCopilot's per-step review.

**Bottom panel tabs.**

| Tab | Tier | What it shows | Source of every number |
|---|---|---|---|
| Evidence | NOW (text); skeleton drawing T2 | The note "Low scores usually mean camera position or a sign the model learned poorly, not how the guest signs." Then, for each recognised sign of this guest: number, label, light, model score (uncalibrated), movement start and end time, delay to prediction, top-3 alternatives (or "top-1 only: the sign event did not arrive"), and whether a skeleton snapshot exists. Tier 2 draws it as dots and lines (shoulders, arms, hands; no face) | Bridge `sign` events (section 6) |
| Latency | NOW | Per stage, the last value, the median and the count: movement end to prediction; prediction to the app; the app to the guest screen (round trip, "reported by the guest device"); utterance end to proposal on screen; "Send" to speech starting at the desk. A stage with no data shows "no data yet" | Bridge timestamps, server receive times, guest acknowledgements (values outside 0 to 10 s dropped), staff-browser speech-start reports |
| Privacy | NOW | For this guest and since start: vendor calls by destination with bytes (or "no vendor keys configured: 0 by construction"); guest-derived bytes off the laptop; messages and bytes relayed to the guest device; bridge events accepted ("labels and timestamps only"); bridge events refused for carrying face, frames, pose or video keys, per key; skeleton snapshots held in memory now; fixed sentences sent to `/api/tts`; time and reason of the last wipe and how many items it erased. Under the counters, the fixed sentence `PRIVACY_DISK_NOTE`: "Guest names and typed text are never written to disk by the app. Piper writes temporary audio of the fixed sentences to the system temporary folder and deletes it. Next.js may write its own build cache." | Real counters in the server store, each incremented where the event happens; no hard-coded zeros |
| Benchmark | NOW | "Accuracy figures: not yet audited." Only a report file marked `cleared: true` with an audit reference may replace that text, and then only with the fields it contains | `BENCHMARK_CLEARED_FILE`, never computed |
| Simulator | NOW | Rehearsal without the camera (section 6.7). Only when `SB_SIMULATE=1`. Simulated signs carry a "SIMULATED" badge on both screens | — |
| Safety | T2 | Server-side session warnings (section 6.6) with gentle wording and the staff response card: "Go to the guest in person first. Then press End guest. If the guest is still there, start again with New guest and check the new number with them." Help and the guest's own choices never appear here | Server store |
| Device | T2 | The guest device's load state, only from a team-owned (kiosk) device whose browser supports the Compute Pressure API ("normal", "busy", "very busy", "overloaded", "reported by the guest device"), with "This only reflects how busy the device is. It is not a security check." Where unsupported or not a kiosk: "Not available." The same for the staff laptop | `PressureObserver` reports |

**Alerts.** Help from the guest takes over the top of the screen with a full-width red banner, "Guest wants staff at the desk now", a repeating tone and "I'm coming" (which sends `staff_ack` to the guest); repeated presses raise the count on the same banner ("Help pressed 6 times: go now"), and never anything in Safety. An interpreter request shows a navy banner with the VRI details, or "No interpreter service is configured: arrange one by phone and tell the guest how long it will take", and "I'm on it", which tells the guest "The desk is arranging an interpreter". A typed guest message shows a brass banner with the text and "Read aloud". A repair reply ("Please repeat", "I don't understand", "Please type it", "Wait, please") shows a short brass banner. In Tier 1, "Guest needs more time: Keep open" appears when the guest taps "I need more time".

### 4.3 Pairing (Mode C and Mode W; Tier 1, gate G1)

```
 STAFF 1440x900, full-screen overlay after "Guest is here"     GUEST PHONE 390x844 after joining
+------------------------------------------------------------+ +----------------------------+
|                                                            | | SignBridge · front desk    |
|            Open this on the guest device                   | |                            |
|                                                            | | The desk is connecting     |
|                 +----------------------+                   | | this screen. This takes    |
|                 |                      |                   | | about a minute.            |
|                 |   QR 320 px          |                   | |                            |
|                 |   (drawn as rects)   |                   | |      960 792               |
|                 |                      |                   | |   (the desk reads this     |
|                 +----------------------+                   | |    number off this screen) |
|   https://10.77.0.1:3443/guest#p=....   new code in 0:48   | |                            |
|                                                            | | [ Get staff now ]          |
|   Nothing else is shown while this code is on screen.      | +----------------------------+
|   [ Cancel ]                                               |
+------------------------------------------------------------+

 STAFF after a device joins (overlay replaced)
+------------------------------------------------------------+
| A device joined: iPad, Safari, 10.77.0.2                   |
| Check it is the device in the guest's hand.                |
| Type the number shown on it:  [ _ _ _  _ _ _ ]  [Confirm]  |
| 3 tries. "That is not the number on the guest's screen."   |
| If the numbers differ, stop and go to the guest.           |
+------------------------------------------------------------+
```

The protocol follows `lan_tls_pairing.md` section 3.1 and decision record D6:

1. Staff press "New guest". The server ends any old session and creates a session in state `WAITING_FOR_GUEST`. No code exists yet.
2. When the guest is at the desk, staff press "Guest is here". The server creates a 128-bit pairing code, valid for 120 seconds, and the staff screen shows the QR code for `https://<LAN_IP>:3443/guest#p=<code>` as a full-screen overlay with nothing else visible. The QR is drawn as `<rect>` elements by a small vendored MIT encoder (`qrcode-generator`, one file, its hash recorded in `docs/security-testing.md`). While waiting, the staff page asks for a fresh code every 60 seconds; the previous code stays valid until its own 120-second expiry, so at most two codes are live and a device that scanned at 59 seconds still joins. In Mode C and Mode W with the team device, staff open the link on the device themselves; guests never scan anything in the default modes.
3. The guest page reads the code from the fragment and removes it from the address bar with `history.replaceState` before any network request, then posts it to `/api/guest/join`.
4. The server checks the source address against `GUEST_IPS` first (403, and the code is **not** burned), then the code in constant time against its stored SHA-256, then counts a failure against that address (5 a minute). A valid code is never refused by a rate limit and there is no server-wide ceiling. On success it burns every live code, sets the `__Host-sb_g` cookie, records the device binding (address plus a hash of the User-Agent, and a parsed device class for display), creates a random 6-digit check code, and returns it to the guest page only. The session is now `PAIRED_UNCONFIRMED`, and the staff overlay closes.
5. Staff look at the device in the guest's hand, check that it is the device the staff screen names, and type the 6 digits. The check is the receptionist's job: the guest page only says "The desk is connecting this screen. This takes about a minute." and shows the number with "(the desk reads this number off this screen)"; it never asks a Deaf guest to compare it with a screen that faces away from them. A wrong number shows "That is not the number on the guest's screen" and leaves two more tries; the third wrong number ends the session with reason `pair_failed`.
6. On a match the session becomes `ACTIVE`, and both screens show "Paired with 960 792".
7. Until step 6, the guest device may only send `emergency`, and every staff caption is refused with 409, so a device that wins a race for the code learns nothing. "Get staff now" is shown during pairing.

**Mode 0 (Tier 0).** Staff press "New guest", then "Open guest window". The staff page (on `http://127.0.0.1:3000`) opens `http://localhost:3000/guest#p=<code>` in a new window, which staff drag to the wired display. Because `localhost` and `127.0.0.1` are different cookie sites, the guest window never shares the staff cookie, and anything the guest side clears cannot touch it. The join arrives on the loopback listener from the laptop itself with `Host: localhost:3000`, so it is confirmed without a check code and the staff header shows "Guest window on this laptop (Mode 0)". In the engagement profile the guest window is display-only (decision record D3, section 4.4). In the stage profile with `MODE0_GUEST_INPUT=1` it takes taps and typing from its own mouse or touch screen and keyboard, and the header says "guest input on".

### 4.4 Guest first screen (`/guest`, phone 390x844 and laptop or display 1440x900)

```
 PHONE 390x844                              DISPLAY 1440x900 (Mode 0 with guest input; Mode C laptop)
+----------------------------+             +-------------------------------------------------------------------+
| SignBridge · front desk    |             | SignBridge front desk                           [ More v ]        |
|                            |             |                                                                   |
| How would you like to talk |             |  How would you like to talk with the front desk?                  |
| with the front desk?       |             |                                                                   |
| +------------------------+ |             |  +--------------+ +--------------+ +--------------+ +-----------+ |
| | Sign                   | |             |  | Sign         | | Type         | | Ask for a    | | Text only | |
| | The desk camera can    | |             |  | The desk     | | Type, or tap | | human        | | Read the  | |
| | recognise about 20     | |             |  | camera can   | | one of 20    | | interpreter  | | desk's    | |
| | hotel requests, one    | |             |  | recognise    | | requests     | | by video     | | words; no |
| | sign at a time. It     | |             |  | about 20     | |              | | relay        | | avatar    | |
| | does not understand    | |             |  | hotel        | |              | |              | |           | |
| | full ASL.              | |             |  | requests ... | |              | |              | |           | |
| +------------------------+ |             |  +--------------+ +--------------+ +--------------+ +-----------+ |
| | Type                   | |             |                                                                   |
| +------------------------+ |             |  [x] Read my sentences aloud at the desk. People nearby will      |
| | Ask for a human        | |             |      hear it.                                                     |
| | interpreter            | |             |                                                                   |
| +------------------------+ |             |  About this screen                                                |
| | Text only              | |             |  (GUEST_NOTICE, then GUEST_NOTICE_EXTRA, see below)               |
| +------------------------+ |             |                                                                   |
| [x] Read my sentences      |             |  This app does not call 911. Text-to-911 here: <note>             |
|     aloud at the desk      |             |                                                                   |
| About this screen  >       |             | +---------------------------------------------------------------+ |
|----------------------------|             | |                     Get staff now                             | |
| [    Get staff now     ]   |             | +---------------------------------------------------------------+ |
+----------------------------+             +-------------------------------------------------------------------+
```

The four choices are equal in size and order. The notice is `GUEST_NOTICE` in `types.ts`: the text of `compromised_device.md` section 2.4 (AS-23) with exactly one substitution, "The Emergency button" becoming "The Get staff now button", so that the button and the notice use the same name (requested from the notice's owner in `docs/requests.md`). It is followed by the two sentences of `GUEST_NOTICE_EXTRA`: that camera video stays on the laptop and nothing is read aloud until the guest sends it, and what the desk sees (which signs the camera read, how certain the computer was, a stick-figure drawing of arms and hands when the recognizer provides one, and when a message appeared on this screen, all erased at the end). The text-to-911 note is a separate, factual line. No input on any guest screen ever asks for a password, card number or ID.

- **Sign** sends `guest_choice: sign`. Only after this does the server accept sign events for the session (consent gate), and `GET /api/guest/signs` answers `{accepting: true}`. The card says what the system really does (`SIGN_CARD_TEXT`). When `signingAvailable` is false (recognizer down, `mock` or `no_model`), the card reads "Signing is not available right now. Please type or ask for an interpreter" with that text visible, and is disabled.
- **Type** opens the text field and, above it, the 20 guest requests as large phrase buttons (C2-3), so a guest can pick a request without being recognised at all. A picked phrase shows the same confirmation as a recognised one ("Send and read aloud" / "Fix") and the same echo. The field uses `autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"` on every team-owned device (`hello.kiosk`, which is every device in Mode 0 and Mode C), per AS-8; on a guest's own phone (Mode W scenario S3b, LATER) the platform defaults stay on, a trade-off recorded for the AS owner. When text fails validation, the reason is shown next to the field ("Messages can be up to 280 characters"), never just a disabled button.
- **Ask for a human interpreter** alerts staff. With VRI configured, it shows the provider name and the contact labelled by its kind ("Videophone: ..." or "Text: ..."), never a bare phone number, and a link only when the device is not a kiosk (AS-25), with "A video relay call sends your video to that provider." Without VRI configured it says honestly: "Ask the desk to arrange a sign language interpreter. This may take time." The guest then sees "Request sent", then "The desk is arranging an interpreter" after staff tap "I'm on it", then any free text staff send with a time estimate.
- **Text only** shows the desk's words as captions without the avatar.
- **Read my sentences aloud at the desk** is asked once on this screen, with "People nearby will hear it." It is separate from the avatar setting, and both can be changed later from the "More" menu. The guest's own screen confirms every change ("Reading aloud is now off").

**Display-only (Mode 0, engagement profile).** When `hello.displayOnly` is true the page renders no tappable controls at all. The first screen says "The desk will ask how you want to talk. Point to one:" with Sign, Type, Interpreter and Text only as large non-interactive labels, and later screens say "Point to YES or NO on the card" and "Wave to the desk for help". A laminated YES / NO / TYPE / INTERPRETER / HELP card sits on the counter (OPS-1).

Without a valid code or cookie, the page shows only "Ask the front desk to connect this screen."

### 4.5 Guest conversation screen

```
 PHONE 390x844                              DISPLAY 1440x900
+----------------------------+             +----------------------------------+--------------------------------+
| Front desk said   [More v] |             | Front desk said      | New |     | You                    [More v]|
| The elevator is on         |             | The elevator is on your left.    | Signing is on. Put the phone   |
| your left.   | New |       |             | (largest text, brass edge until  | in the stand so both hands are |
| [Show again]               |             |  tapped or scrolled) [Show again]| free.                          |
| You're in room 412.        |             | You're in room 412. (smaller)    | Ready: sign when you like      |
| +------------------------+ |             | Welcome! (smaller)               | [What can I sign?]             |
| |   avatar (P2) or       | |             | +------------------------------+ |                                |
| |   sign cards           | |             | |   avatar (P2) or sign cards  | | Signs the camera read          |
| +------------------------+ |             | +------------------------------+ | [WHERE] (*) clear              |
| Computer avatar. It signs  |             | Computer avatar. It signs word   | [ELEVATOR] (/) not certain     |
| word by word ...           |             | by word and may look unnatural.  |                                |
| [Show sign names]          |             | The English sentence above is    | "Where is the elevator?"       |
| [Please repeat] [I don't   |             | exact.  [Show sign names]        |                                |
|  understand] [Please type  |             | [Please repeat] [I don't         |                                |
|  it] [Wait, please]        |             |  understand] [Please type it]    |                                |
|----------------------------|             |  [Wait, please]                  |                                |
| Signs the camera read      |             |                                  |                                |
| [WHERE] (*) clear          |             |                                  | [ Send and read aloud ] [ Fix ]|
| [ELEVATOR] (/) not certain |             |                                  |                                |
| "Where is the elevator?"   |             |                                  |                                |
| [Send and read aloud][Fix] |             |                                  |                                |
| [    Get staff now     ]   |             | [         Get staff now          ]                                |
+----------------------------+             +----------------------------------+--------------------------------+
```

Captions come first: the latest staff sentence is the largest text on the page, with a brass "New" edge that stays until the guest taps or scrolls (no flashing under reduced motion), and "Show again" replays the avatar for it. The page keeps the last three staff sentences in memory, newest largest; the server's reconnect snapshot still holds only the last one (AS-1). A caption that came from speech-to-text carries "From speech recognition, may contain mistakes." `AvatarCaptions` and the avatar (or text sign cards) sit below, in a container passed to `mountAvatar`; the avatar canvas is `aria-hidden`, with the caption as its text alternative. Under the avatar is `AVATAR_DISCLAIMER`: "Computer avatar. It signs word by word and may look unnatural. The English sentence above is exact." The gloss key tags are hidden behind "Show sign names", which also shows a key ("fs = fingerspelled", "eyebrows up = a yes/no question"). Under the latest caption is a row of tap-only repair replies: "Please repeat", "I don't understand", "Please type it" and "Wait, please". Each shows on the staff screen and in the log, marks that caption "Guest did not understand" where it applies, and turns its checklist item to "needs another try"; it is never spoken unless staff choose to.

The guest panel changes with the state of the conversation. The send button's label follows the read-aloud setting: "Send and read aloud" when it is on, "Send as text" when it is off or the guest chose Text only.

| State | What the guest sees | Buttons |
|---|---|---|
| Signing, waiting | "Signing is on. Put the phone in the stand so both hands are free." plus the framing message while framing is not OK (section 6.4), and "What can I sign?" which lists the 20 requests with their signs as key tags | Stop |
| Live signs | Each sign appears as a key tag with its light and word the moment it is recognised | — |
| **Proposal** (every sign at or above its bar, signs match one request) | The signs with lights, then the sentence in quotes | **Send...**, **Fix** (Fix opens Sign again, Type instead, Ask for an interpreter) |
| **Proposal for NAME** | "My name is ..." with a field "Type your name" | Send (enabled when the name passes the sanitizer; otherwise the reason is shown: "Names can use letters, spaces, hyphens and apostrophes"). The name then appears on the staff screen, and is spoken only after staff tap "Speak name" |
| **Did you mean...?** (one sign below its bar, and exactly one replacement from its top 3 matches a request) | "Did you mean: 'Could I have more towels, please?'" | **Yes**, **No, sign again**, Type instead |
| **Did you mean HELP?** (a HELP sign below its bar, or a confident HELP on its own) | "Did you mean HELP? Staff will come to you." | **Yes, get staff**, **No**. HELP never sends an alert without the guest's tap |
| **Pick one** (two or three possible requests) | "Which one did you mean?" and up to three sentences as large buttons | Each sentence, then **None of these: Type / Sign again / Interpreter** |
| **Not a request we know** (signs clear, no match, and no next utterance within 4 seconds) | "The camera read: TAXI WHERE. That doesn't match a request we know." plus up to three nearest requests | Each nearest request, None of these |
| **Sign again** (`NONE`, framing rejection, two weak signs, or no candidate) | `REPEAT_TEXT`: "Sorry, the camera missed that sign. Could you sign it again, or type it?", the missed sign as a grey outlined tag, and the framing hint if framing caused it. After three in a row, "Type instead" becomes the primary button | Sign again, Type instead |
| Sent | "Sent to the front desk", the exact echo "The desk received: '...'", and "Read aloud at the desk" or "Shown as text at the desk" | — |
| Test mode | When the recognizer reports `mock`: "Test mode: these signs were invented by a test program and will not be spoken." | Send disabled |
| Simulated | When the signs came from the simulator: a "SIMULATED" badge on the live signs and the proposal | As normal |

**Layout and controls.** On a phone the guest device sits in a stand at eye level next to the desk camera (OPS-1), because most of the recognised signs need two hands. Send, Fix and "Get staff now" are in the bottom third of the screen, within thumb reach. "Get staff now" always has its own full-width row and is visible on every screen, including pairing and the end screen. Mode and setting changes, the interpreter request and "I'm finished" live in the "More" menu in the header, far from Help. "I'm finished" asks first: "End this conversation? Everything on this screen will be cleared." with "Yes, end it" and "Keep talking".

**Help.** "Get staff now" shows "Staff has been alerted", then "Staff is coming" when staff acknowledge. If staff have not acknowledged within 20 seconds, the screen adds "No reply yet. Wave or knock at the desk." The text-to-911 note is a separate line on the first screen and in "More". There is no sound on the guest device and nothing depends on hearing. The printed "wave or knock" card and the staff heartbeat are the independent path; the button is a convenience, because a compromised device could swallow it (section 9.5).

**Timing warnings.** Both the idle warning and the cap warning reach the guest: "This conversation will end in 30 seconds unless the desk keeps it open" and "This conversation will end in 2 minutes unless the desk keeps it open". In Tier 1 they carry "I need more time", which puts "Guest needs more time: Keep open" on the staff screen without resetting any timer itself (AS-16 stays intact).

**Accessibility rules.** Status messages (live signs, framing, proposals, "Sent", "Staff has been alerted") go into one `aria-live="polite"` region; Help status, idle and cap warnings and the session end go into one `aria-live="assertive"` region. When a proposal appears, focus moves to its heading only if focus is not in a text field, so a proposal never steals focus from typing. The step-8 accessibility pass checks keyboard order, screen reader output on captions, 200% zoom and large iOS text. Landscape layouts at 844x390 and 1180x820 (captions left, guest panel right, Help always visible) and an axe-core run on every guest state are Tier 2.

**Hiding and restoring.** On `pagehide` or when the page becomes hidden, the conversation is replaced by a neutral screen (AS-7). When it becomes visible again and the session is still active, the page restores the captions and the pending proposal from memory (or asks for a snapshot), so a guest who switched apps, or an iPad that dimmed, comes back to the same screen. The ops checklist sets the iPad's auto-lock to Never.

**Device health (Tier 2).** Only on a team-owned device (`hello.kiosk`), and only where `PressureObserver` exists (Chromium in a secure context), the guest page reports changes of the `cpu` pressure state at most once every 10 seconds. A guest's own phone never sends it. The guest screen shows nothing about it. Safari has no Compute Pressure API, so on the team iPad the staff Device tab says "Not available".

### 4.6 Session end

```
 PHONE 390x844                              DISPLAY 1440x900
+----------------------------+             +-------------------------------------------------------------------+
|                            |             |                                                                   |
| This conversation has      |             |   This conversation has ended.                                    |
| ended.                     |             |   The desk ended the conversation.                                |
| The desk ended the         |             |                                                                   |
| conversation.              |             |   This page did not save the conversation. Your browser may keep  |
|                            |             |   its own history.                                                |
| This page did not save the |             |                                                                   |
| conversation. Your browser |             |   If you need anything else, wave to the front desk.              |
| may keep its own history.  |             |                                                                   |
|                            |             +-------------------------------------------------------------------+
| If you need anything else, |
| wave to the front desk.    |              STAFF (header strip and log after End guest)
+----------------------------+             | No guest.  Last wipe 10:12:40, reason: End guest, 31 items erased. |
                                           | [ New guest ]                                                      |
```

The end screen gives the reason from `END_REASON_GUEST` ("The desk ended the conversation", "It ended because no one used it for a while", "It reached the time limit for one conversation", and so on) and the honest storage sentence `END_SCREEN_STORAGE_NOTE`, because Safari's support for Clear-Site-Data and the timing of iOS page snapshots are unverified. If a proposal, a confirm in flight or unsent typed text was pending, it adds "Your unsent message was not sent. Wave to the desk if you still need something."

On `session_end` the guest page clears its state, calls `POST /api/guest/leave`, and replaces its history entry with the ended screen so Back cannot show the conversation (AS-6, AS-7). On the guest TLS listener (Tier 1) `leave` answers with `Clear-Site-Data: "cache", "cookies", "storage"` and an expired cookie. On the staff listener (Mode 0) it only expires the `sb_g` cookie and **never** sends Clear-Site-Data, so nothing can clear the staff cookie (section 9.6). The staff screen clears the log and the per-guest counters and keeps only the wipe receipt. A guest who confirms "I'm finished" ends the session the same way, with reason `guest_left`, and staff see "The guest ended the conversation".

### 4.7 Builder B screen notes (2026-10-11, talha/app-shell)

These are how the screens apply `BIGTECH_TO_PRODUCT.md` BN-1 to BN-5 on top of sections 4.2 to 4.6.

- **BN-1, confirm before speaking.** Every sentence the guest sends, whether recognised, picked from "Did you mean...?" or "Pick one", or chosen from the phrase list, goes through one confirmation: the exact sentence, the signs with their lights, and three equal buttons, "Say it", "Text only" and "Fix". "Text only" sends `voice: false`, so the server's speak plan is `none` (`guest_chose_text`) and the staff log says "do not read it aloud". When the guest turned reading aloud off, the buttons are "Send as text" and "Fix". "Did you mean...?" now leads to that confirmation after "Yes" instead of sending at once. "Fix" never re-runs recognition: it offers Choose another (when there were several), Type instead, Sign again and Ask for an interpreter. BN-2 line (d) sits under every sign-based confirmation.
- **Skeleton snapshot.** It is drawn as dots and lines (shoulders, arms and hands, no face) in the staff Evidence tab only. The guest device never receives it (AS-1); the guest sees the signs and their lights.
- **BN-2.** Lines (a) to (c) are on the guest's first screen, in `GUEST_HONEST_LINES`. The staff Privacy tab says "Vendor calls made by the SignBridge server" and "Session data wiped". "Face points passed to the classifier: 0" is not shown, because its BN-2 check has not run on this branch.
- **BN-3.** Under the latest caption: "Show again", "Captions only" / "Show the avatar", and six replies to the desk (Please repeat that, Slower please, Please type it, Please show me on paper, I don't understand, Wait please). A three-step text size is in "More" (memory only).
- **BN-5.** The guest page keeps "This conversation", every desk sentence and every sentence the guest sent, in memory only, with "You may photograph this screen". "End and delete my session" (in the record and in "More") asks first, then ends the session the same way as "I'm finished" did. Both screens say "This session will end soon"; the staff button is "Guest is still here: keep open". The server's reconnect snapshot still holds only the last caption.
- **Layout.** On a phone a pending sentence moves above the captions; on a display the guest panel stays in view. The staff header is a row of labelled slats, open session warnings show as a strip with "Open Safety", and the details drawer can be hidden.
- **Restart pass (2026-10-11).** Key-triggered signing with `live_key.py` (section 6.1, "Driving live_key.py"): Record / Finish / Undo and the countdown dial; on a phone the Sign panel comes first while key-triggered signing is on. The voice slat is honest: without an ElevenLabs key or `PIPER_FALLBACK=1` (`flags.ttsAvailable`), the staff page no longer calls `/api/tts` (which answers 500) or says "Voice: ready"; it says "on-device only" and uses the laptop's own voice. Choosing Sign, Type, Text only or the interpreter in "More" closes the menu and returns focus to its button; the guest page has `scroll-padding-bottom` so keyboard focus never lands behind the sticky Help row (WCAG 2.4.11). Known axe note: when a full-page capture stops with the repair buttons half under the sticky Help row, axe reports target-size for that scroll position only.

---

## 5. Data flows

### 5.1 Staff to guest

| Hop | From -> to | Transport | Data | Leaves the laptop? |
|---|---|---|---|---|
| S1 | Microphone -> staff page | P1 `recorder.ts` (MediaRecorder) | Receptionist audio, in memory | No |
| S2 | Staff page -> `POST /api/transcribe` (P1) | Loopback HTTP | Audio (multipart, at most 5 MB) | No |
| S3 | `/api/transcribe` -> OpenAI Whisper | HTTPS | Receptionist audio | **Yes, staff data**, counted; impossible without a key (D8 window) |
| S4 | Staff page -> `POST /api/gloss` (P1) | Loopback HTTP | English text | No (P1's gloss is a local mapping) |
| S5 | Staff page -> `POST /api/staff/action` `say_quick {intent}` or `say_text {text, gloss, source}` | Loopback HTTP, staff cookie | Intent key, or text plus gloss | No |
| S6 | Server: validate gloss tokens (REQ CAP-2), else P1 `mapStaffTextToGloss`, else captions only; cap the caption at 600 bytes | Memory | Same | No |
| S7 | Server -> guest device `staff_utterance` | SSE, HTTPS (Mode C/W) or loopback (Mode 0) | Text, gloss, gloss source | Over the cable or router only |
| S8 | Guest page -> `mountAvatar`/`playGloss(gloss, {onToken})` and `AvatarCaptions` | In page; sign files from the bundle fetched once at pairing (guest listener) or per gloss (loopback) | Gloss | No |
| S9 | Guest page -> `POST /api/guest/action` `ack {seq}` | Same as S7 | Event number | Over the cable only |
| S10 | Server -> staff `delivered` | Loopback SSE | Seq, round-trip time | No |

A quick reply uses only S5 to S10 and no cloud call. Typed staff text uses S4 to S10. When `/api/gloss` fails or returns an invalid token, the server uses P1's `mapStaffTextToGloss` in process; when that yields nothing usable, the guest gets captions only.

### 5.2 Guest to staff

| Hop | From -> to | Transport | Data | Leaves the laptop? |
|---|---|---|---|---|
| G1 | Desk camera -> `recognition/live.py` (P3) | Local | Video frames, never stored, never seen by the app | No |
| G2 | `live.py` -> `POST /api/guest/signs` | Loopback HTTP, `X-Bridge-Key` | Bridge events: labels, confidences, timestamps, framing status, and an optional skeleton snapshot (section 6.2) | No |
| G3 | Server: validate, drop stale or replayed events, consent gate, traffic lights, gate, match, candidates | Memory | Same | No |
| G4a | Server -> guest `live_sign`, `framing`, `guest_proposal` or `repeat_request` | SSE over the cable | Top-1 words with lights, guidance text, candidate sentences | Over the cable only |
| G4b | Server -> staff `live_sign`, `framing`, `recognition` | Loopback SSE | Top-3, timestamps, skeleton, gate result | No |
| G5 | Guest -> `POST /api/guest/action` `guest_confirm {proposalId, candidateId, name?}` | Over the cable | Choice, and the typed name for NAME | Over the cable only |
| G6 | Server -> staff `guest_utterance` with a speak plan | Loopback SSE | Sentence, signs, plan | No |
| G7a | Staff page -> `POST /api/tts {text}` (Nath) | Loopback | The **fixed** sentence from the server's plan, never guest text | No with Piper; **yes** with an ElevenLabs key (counted as guest-derived, though the sentence is fixed) |
| G7b | Staff page -> `speechSynthesis` with a `localService` voice | In page | Name sentence after "Speak name", typed text after "Read aloud" | No |
| G8 | Staff page -> `POST /api/staff/action` `speak_done` | Loopback | How it was voiced and when speech started | No |
| G9 | Server -> guest `guest_utterance` echo | Over the cable | Sentence, spoken or shown | Over the cable only |

Typed guest text goes guest -> `guest_typed` -> staff banner and log, and is never sent to any vendor. The guest name goes only to the staff screen and to a local voice after a staff tap.

---

## 6. Recognizer bridge ingest

### 6.1 The contract (from `recognition/README.md`, "App bridge")

`live.py --post http://127.0.0.1:3000/api/guest/signs` sends each event as its own POST with `Content-Type: application/json` and `X-Bridge-Key`. Times are Unix seconds from the laptop's clock, comparable with `Date.now() / 1000`.

| Event | Fields the app reads | What the app does |
|---|---|---|
| `sign` | `seq`, `top` (top 3, best first), `t_sign_start`, `t_sign_end`, `t_closed`, `t_predicted`, `t_sent`, optional `skeleton` (requested, section 6.2), optional `run` (requested) | Stores it under (`run`, `seq`) for this session; sends `live_sign` (top-1 and light, no score) to the guest and the full detail to staff |
| `utterance` | `signs` (top-1 of each, 1 to 8), `seqs`, `needs_repeat`, `t_end`, `t_sent`, optional `run` | Joins each sign with its stored `sign` event to get the top 3 and times. A sign whose `sign` event is missing (dropped, stale or refused) uses the utterance's top-1 value with no runner-ups and is marked "top-1 only". The app then runs **its own gate** (section 6.3). `needs_repeat` is only a hint, shown on the staff log as "recognizer suggested a repeat"; the app never repeats because of it alone, because `live.py` sets it whenever any sign is below 0.6, which would turn every "Did you mean...?" into "sign again" |
| `framing` | `status`, `since`, optional `rejected_seq`, `t_sent` | Always stored as the latest framing status, even before the guest chose Sign (it carries no personal data); shown on the guest screen only in Sign mode, and on the staff header always, with how long it has not been `OK`. With `rejected_seq`, it marks that sign red ("camera missed it (framing)") |
| `status` | `fps`, `recognizer` (`ok`, `mock`, `no_model`), `t`, `t_sent` | Updates the staff header and `signingAvailable` on the guest screen; in `mock` every later proposal is a test-mode proposal that is never spoken; in `no_model` the staff header shows the large fallback band (section 4.2) |
| `vlm_suggestion` (reserved) | — | Ignored with 404 unless `VLM_FALLBACK=1` (section 6.8) |

**Shared contract with p4-app (2026-10-11, talha/app-shell).** So that this app and the p4-app screens consume the same recognizer events, the app accepts what the recognizers really send (p4-app c335161, p3-recognition ad90509): no recognizer sends `t_sent` yet, so it is optional and a missing one means "sent when it arrived"; the four `sign` timestamps, `seqs`, `since`, `fps` and `t` are optional (latency is recorded only from timestamps that were sent); `live_key.py` sends a sentence-shaped `utterance` `{raw, labels, text, snapped}` with no seqs, and a `capture` event `{phase: "countdown" | "processing", countdown?, duration?}`, accepted outside the consent gate like `framing`. An utterance without seqs is joined, from the end, with the run's `sign` events since the last utterance, skipping unmatched ones (a sign undone with BACKSPACE sends no event). The sentence shape carries no score, so an unjoined sign there has none (red), and no confidence is ever invented. When `labels` differ from `raw` (the recognizer's sentence correction), the app's own gate runs on the raw signs first, and the corrected sentence is then offered as "Did you mean...?" (candidate source `sentence`) unless the gate already made a proposal, asks for a repeat because of framing or `NONE`, or asks "Did you mean HELP?". The recognizer's `text` is validated (at most 300 characters) and never spoken or shown: guest sentences come only from the fixed table. Known gap: `live_key.py` sends no `status`, so `signingAvailable` stays false and the guest cannot choose Sign until P3 adds a 1-second `status` event (requested in `docs/requests.md`). Tests: `web/lib/app/bridge.test.ts` (`npm run test:unit`).

**Driving `live_key.py` from the guest screen (2026-10-11, builder B restart).** The team's demo path is `python -m recognition.live_key --no-preview --control-port 8765 --post http://127.0.0.1:3000/api/guest/signs` (ad90509): no OpenCV window, and the guest page triggers each recording. This app does that through its own server, never from the browser: with `LIVE_KEY_CONTROL_PORT=8765` set for `server.mjs`, `hello.signTrigger` is `"key"`, and the guest's Sign panel shows "Record a sign", "Finish sentence" and "Undo last sign" plus a countdown dial drawn from the recognizer's `capture` events on the guest screen's own clock ("Get ready", "Sign now", "Reading your sign"). Each tap is the guest action `sign_control {cmd: "record" | "undo" | "end"}` (validated to exactly those three words; 40 a minute), accepted only when the guest chose Sign, signing is available and no sentence is waiting for Say it / Text only / Fix; the route then POSTs to `http://127.0.0.1:<port>/sign`, `/undo` or `/end` (fixed table, empty body, 1 s timeout, no redirects) and answers 503 "The desk camera did not answer" if it fails, with a system line on the staff log. The server also probes `GET /health` every second: an answering control port counts as the recognizer's heartbeat (mode `ok` unless a `status` event says otherwise), which closes the known gap above whenever the control port is used. An accepted undo drops the newest sign from the sentence join (so a re-recorded sign is joined, not the undone one), removes it from both live-sign strips and marks it "undone by the guest" in Evidence. The staff header shows "live_key (tap to record)" or "live_key not answering", Framing "not reported" (live_key sends none), and the evidence row says "no movement times from this recognizer" instead of empty times. The `capture` event reaches the guest only while it is signing. Display-only Mode 0 has no Record button (staff-side recording is not built). Tests: six `live_key control` cases in `bridge.test.ts`, and a Playwright run against a loopback stand-in for `live_key.py` (record, record, record, undo, record, finish, "Did you mean", Yes, Say it) with axe-core clean at 390x844 and 1440x900.

**Validation.** The body is at most 8 KB. `type` must be one of the known types; unknown keys are ignored, as the README asks, but every known key is checked strictly. Labels must be one of the 22 labels exactly, after the alias map (`FS-CHECKOUT` -> `LEAVE`). Each `conf` is a finite number in [0, 1]. `top` has 1 to 5 entries and is re-sorted on the server. An utterance has 1 to 8 signs and as many `seqs`. Any `face`, `frames`, `pose` or `video` key is refused with 400 and counted per key on the privacy panel, so nothing but the optional skeleton can ever carry body points.

**Freshness, replay and restarts.** An event whose `t_sent` is more than 5 seconds old, or older than the start of the current session, is dropped with `200 {ok: true, outcome: "stale"}` (the recognizer should not retry it). Replay detection is keyed on (`run`, `seq`) once P3 sends a random per-process `run` id (requested in `docs/requests.md`). Until then, a `sign` whose `seq` equals one already stored is dropped as a duplicate, and a `seq` **lower** than the last one seen is treated as a recognizer restart: it starts a new run, is shown as a system line "The recognizer restarted", and is never dropped. This matters because `live.py` drops queued events older than 5 seconds and on queue overflow, so after a restart its `seq 1` may never arrive; with the old "falls back to 1" rule, every later sign would have been discarded until `seq` passed the old maximum.

**Consent gate.** `sign` and `utterance` are accepted only when the session is `ACTIVE` and the guest chose Sign; otherwise the route answers 409 and `GET /api/guest/signs` answers `{accepting: false}`. `framing` and `status` are always accepted, because they carry no personal data. P3 is asked to re-send the current framing status every few seconds, so that the app knows it right after the guest taps Sign.

### 6.2 Skeleton snapshot (contract change requested from P3)

The evidence panel needs a picture of what the camera saw, without video. P3 is asked to add an optional field to `sign` events:

```json
"skeleton": { "t": 1760112001.6, "pose": [[x, y], ... 7 points: pose 0, 11, 12, 13, 14, 15, 16], "lh": [[x, y] x 21] | null, "rh": [[x, y] x 21] | null }
```

It is one frame from the middle of the sign, x and y only, rounded to 3 decimals, in the normalized coordinates the model already uses, with no face points. That is at most 49 points and under 1.5 KB. The app accepts it only in that exact shape, keeps it in memory for this session, shows it on the staff screen only (never to the guest device, AS-1), counts it in the privacy panel, and erases it at the wipe. Until P3 sends it, the evidence panel says "No skeleton snapshot from this recognizer build". Landmarks are far less identifying than video, but they are never called "anonymous".

### 6.3 Traffic lights, harm-weighted gate and matching

| Rule | Value | Source |
|---|---|---|
| Default bar for a sign's top-1 | 0.6 (0.6 passes, 0.5999 fails) | CLAUDE.md 7.2 |
| Higher bar for harm-weighted labels | 0.75 for `YES`, `NO`, `NAME`, `ROOM`, `HELP` (provisional; P3 sets the final values from audited calibration) | Slide "build today" item 3; harm table in `rylo_final.md` |
| Green ("clear" for the guest, "high model score" for staff) | 0.8 or above, and at or above the label's bar | This plan |
| Amber ("not certain", "borderline model score") | From the label's bar up to 0.8 | This plan |
| Red ("missed", "low model score" or the reason) | Below the label's bar, `NONE`, or framing rejection | This plan |

The app computes the outcome itself from the joined signs. The recognizer's `needs_repeat` never decides it (section 6.1). The rules run in this order:

1. If any sign is `NONE` or framing-rejected, the outcome is **repeat**.
2. If two or more signs are below their bars, the outcome is **repeat**.
3. If every sign is at or above its bar, the top-1 labels are matched as a **multiset** against the 20 guest intents of `docs/vocabulary.md` section 2, so `ELEVATOR WHERE` matches "Where is the elevator?" just like `WHERE ELEVATOR`. A match gives a **proposal**. A HELP sign that passed its bar but is amber still gives a proposal; the guest confirms it like any other. A confident `HELP` on its own, which matches no intent (only `HELP PLEASE` and `ROOM HELP` exist), gives **"Did you mean HELP?"**.
4. If exactly one sign is below its bar and it is `HELP`, the outcome is **"Did you mean HELP?"**.
5. If exactly one sign is below its bar, the server replaces it in turn with each label in its top 3 (including its own top-1; only the top-1 when its `sign` event was missing) and keeps every replacement that matches an intent, ranked by the product of scores. One candidate gives **"Did you mean...?"**; two or three give **"Pick one"**; none gives **repeat**.
6. If every sign passed but nothing matched, the app **holds** the result for up to 4 seconds. If another utterance arrives in that time, the two are merged (at most 8 signs) and the rules run again on the merged signs, because the segmenter can split `WHERE ELEVATOR` into two utterances at a 1.5-second pause. If nothing arrives, the outcome is **"Not a request we know"** with up to three nearest intents (those sharing the most signs, at least one).

**A pending proposal is protected.** While a proposal waits for the guest, an utterance whose outcome is a repeat, or which holds only `NONE` signs, is ignored: it is logged on the staff screen as "Camera saw a movement while the guest was choosing; ignored" and the guest screen does not change. Only a new matched proposal (kinds `proposal`, `did_you_mean`, `did_you_mean_help`, `pick`) may replace the pending one. This exists because the guest stands in the camera's view and reaches toward the device to tap "Send", and the segmenter counts that reach as a sign. After a replacement, a `guest_confirm` for the previous proposal is still accepted for 10 seconds. While a NAME proposal is pending, every new utterance is ignored until the guest sends or fixes it, because the guest is typing. (Type mode closes the consent gate anyway.)

The guest always confirms, so using a runner-up never speaks something the guest did not choose. Nothing is ever spoken for a repeat. Unit tests in `match.test.ts`: all 20 multisets are distinct and every permutation matches its own intent (parsing `docs/vocabulary.md` section 2); an utterance with `needs_repeat: true` and one sign at 0.45 whose runner-up matches gives `did_you_mean`; a confident lone `HELP` gives `did_you_mean_help`; a NONE-only utterance while a proposal is pending is ignored; `WHERE` then `ELEVATOR` within 4 seconds gives the elevator proposal; an unjoined weak sign uses its top-1 only.

### 6.4 Framing guidance shown on the guest screen

There is deliberately no camera preview, so the guidance talks about the desk camera and the guest's body, not about "the picture". These are the app's own words (`FRAMING_GUIDANCE` in `types.ts`); the statuses are those of `recognition/framing.py`.

| Status | Guest text | Staff hint (always shown on the staff header) |
|---|---|---|
| `OK` | "Ready: sign when you like" | — |
| `STEP_BACK` | "Please take a step back from the desk camera" | "Ask the guest to step back. If the counter hides the hips, restart the recognizer with --waist none" |
| `COME_CLOSER` | "Please come a little closer to the desk camera" | Same text |
| `HANDS_OUT` | "Please keep your hands a little closer to your body" | Same text |
| `CENTER` | "Please stand in front of the desk camera, on the floor marker" | Same text |
| `CENTER_LEFT` / `CENTER_RIGHT` (requested from P3, direction from the guest's side) | "Please move a little to your left" / "... right" | Same text |
| `MOVE_CAMERA_DOWN` | "The camera cannot see your waist. Staff will tilt it down" | "Tilt the desk camera down. If the counter hides the hips, restart the recognizer with --waist none" |
| `NO_PERSON` | "Please stand in front of the desk camera" | Same text |

The guidance is shown on the guest screen only while the guest is in Sign mode, and it is removed when `OK` arrives. A floor or counter marker shows where to stand (OPS-1). A simple position diagram (a frame outline with a silhouette and an arrow per status, no video) is Tier 2. The real camera position at the counter is rehearsed before the demo, because a laptop camera at a counter often cannot see the hips, and a sign is classified only when 80% of its frames are `OK`.

### 6.5 Latency from real timestamps

| Stage | Computed as | Clock |
|---|---|---|
| Movement end -> prediction | `t_predicted - t_sign_end` | Laptop (recognizer) |
| Prediction -> app | server receive time - `t_predicted` | Laptop |
| App -> guest screen | ack receive time - event send time (a round trip, labelled "reported by the guest device"; values outside 0 to 10 s dropped, AS-22) | Laptop server |
| Utterance end -> proposal on the guest screen | ack receive time of the proposal - `t_end` | Laptop |
| "Send" -> speech starts at the desk | `speak_done.startedAt` - confirm receive time | Laptop (staff browser and server) |

Each stage shows the last value, the median and the count for this guest. With no data it shows "no data yet"; nothing is estimated.

### 6.6 Session safety warnings (server-side; full set Tier 2)

| Warning | Trigger | Staff wording |
|---|---|---|
| Second device | A second guest stream from another address, or a join after the code was used | "Another device tried to join this conversation." |
| Device changed | The bound device's address or browser changed; guest actions except Help are paused until a new check code is typed | "The guest device changed address or browser. Check the device and type its new number." |
| Repeated request | A guest action whose nonce was already used, or a confirm for a proposal that is no longer pending and past its grace period | "A request was sent twice. This can be a network retry." |
| Unusual rate | A guest action kind other than `emergency` hit its rate limit | "The guest device is sending requests unusually fast." |
| Failed pairing | Each failed join (per address count) | "Failed pairing attempts: 3" |
| Heartbeat | No heartbeat or acknowledgement for 20 s (amber) or 45 s (red) | "Guest device last heard 47 s ago. Check on the guest." |
| Recognizer event or key | A duplicate `seq` in the same run, or failed `X-Bridge-Key` checks | "The recognizer sent an unexpected event." |

Two things are never safety warnings. **Help** is urgency, not abuse: repeated presses only raise the count on the red Help banner ("Help pressed 6 times: go now"), and a unit test sends 20 `emergency` actions and checks that no `warning` event is produced. **The guest's own consent choices** (switching off signing, turning off reading aloud, changing mode) are neutral log lines ("Guest chose to type"), never in the Safety tab or its count; the control against a hostile device switching settings silently is that the guest's own screen confirms every change ("Signing is now off"), and the staff header always shows the current mode (AS-21). Every warning is gentle and factual. None of them claims an attack or spyware; the staff response card (section 4.2) is the action. In Tier 0 only the heartbeat display and the recognizer-event line exist; the rest come with Tier 1 and Tier 2, because Mode 0 has no second device to warn about.

### 6.7 Simulator

`POST /api/dev/simulate` accepts exactly the bridge event bodies of section 6.1 and runs them through the same ingest function, marked `source: "simulated"`, so both screens show a "SIMULATED" badge. It needs the staff cookie and answers 404 unless `SB_SIMULATE=1`. The panel has one button per guest intent (signs at 0.9 each, sent as `sign` events then an `utterance`), "Shuffle order", "Make one sign weak" (one sign at 0.45 with a plausible top 3, sent with `needs_repeat: true` exactly as `live.py` would), "Low HELP", "Lone HELP", "Split utterance" (WHERE, then ELEVATOR 2 seconds later), "Reach to tap" (a NONE-only utterance while a proposal is pending), "Drop a sign event", "Restart recognizer" (seq falls to 1), "Framing: step back", "Recognizer in mock mode" and "Recognizer: no model".

### 6.8 Reserved: local vision-model fallback (stub only)

`recognition/vlm/` is exploring a local vision-language model that could propose a sign when the classifier is unsure. This build reserves the slot and nothing more: a bridge event type `vlm_suggestion` (`{ type, seq, label, conf, model, t_sent }`), a proposal source `"local_vlm"`, and a "Did you mean...?" rendering that says "Suggested by a second program on this laptop". The route ignores the event with 404 unless `VLM_FALLBACK=1`, and even then a suggestion only ever becomes a candidate the guest must confirm. No video or frames are sent to the app for it; the model runs inside P3's process.

---

## 7. Event catalogue

All events travel as Server-Sent Events from `GET /api/events`. Each message has `id: <seq>` and `data: <BusEnvelope JSON>`. Every (re)connect gets `retry: 2000`, then `hello` (guest) and a `snapshot`, so no replay buffer is needed. The guest and staff unions in `types.ts` are separate, and the server builds guest messages only from the guest union (AS-1). Constant-size guest frames with cover events (`c`) are a LATER item for Mode W (REQ OPS-5).

| Type | Guest | Staff | Produced by | Notes |
|---|---|---|---|---|
| `hello` | yes | — | Every guest stream open | Mode, profile, VRI details, kiosk flag, idle and cap times, emergency note, the check code while unconfirmed (G1), `displayOnly`, `signingAvailable` |
| `pair_confirmed` | yes (`deskShows`) | yes | Staff `confirm_pair` (G1) | Both screens show the number |
| `snapshot` | yes (state, settings, last caption, pending proposal, latest framing, `signingAvailable`, Help pending) | yes (status, log, pairing, checklist, evidence, latency, privacy, warnings) | Every stream open | Guest snapshot holds one caption and no scrollback (AS-1) |
| `settings` | yes | — | Any guest mode or setting change | The guest's own screen confirms the change ("Reading aloud is now off") |
| `session_state` | — | yes | Any lifecycle change | State, pairing info (code and URL only while the overlay is up), device class and address, tries left |
| `staff_utterance` | yes (with `captionSource`) | yes | `say_quick`, `say_text` | Staff copy adds intent key; guest marks speech captions |
| `delivered` | — | yes | Guest `ack` of a caption or proposal | Feeds the checklist and latency |
| `live_sign` | yes (label, light; no score) | yes (top 3 or top-1 only, times, skeleton) | Bridge `sign` | Shown the moment a sign is recognised; `simulated` flag on both |
| `framing` | yes (status, text) | yes (status, hint, rejected seq, not-OK since) | Bridge `framing`, accepted outside the consent gate | Guest only while in Sign mode |
| `recognition` | — | yes | Bridge `utterance` | Signs, lights, gate outcome (including `ignored_pending` and `held`), the `needs_repeat` hint, candidates, source |
| `guest_proposal` | yes | — | Gate outcome, or a phrase pick | Kinds: `proposal`, `did_you_mean`, `did_you_mean_help`, `pick`, `unmatched`; each with candidates; `testMode` when the recognizer is `mock`; `simulated` |
| `repeat_request` | yes (signs with lights, weak indexes, framing hint, streak) | yes (reason, count, streak) | Gate outcome, never while a proposal is pending | Nothing is spoken |
| `guest_utterance` | echo (exact text, spoken or shown) | yes (signs, text, intent, speak plan) | `guest_confirm`, `guest_phrase`, or `confirm_for_guest` in display-only Mode 0 | Staff page voices it per the plan |
| `guest_fix` | — | yes | `guest_fix` | Sign again, type, interpreter, not this |
| `guest_typed` | — | yes | `guest_typed` | Banner and log line, never spoken without "Read aloud" |
| `guest_reply` | — | yes | `guest_reply` | Repair reply; marks the caption and its checklist item |
| `guest_choice` | — | yes | `guest_choice`, `stop_signing`, `prefs` | Neutral log line, never a warning |
| `interpreter_request` | — | yes (VRI details) | Guest | Merged, at most one a minute |
| `emergency` | — | yes (`count`) | Guest "Get staff now" | Dispatched first; never refused; merged with a count until acknowledged; never a warning |
| `more_time` (G1) | — | yes | Guest "I need more time" | Banner "Guest needs more time: Keep open"; resets nothing |
| `staff_ack` | yes | yes | Staff `ack` | "Staff is coming", "The desk is arranging an interpreter" |
| `warning` (T2) | — | yes | Safety rules (section 6.6) | Kind, plain text, time |
| `device_health` (T2) | — | yes | Kiosk guest `device_health` | "Reported by the guest device" |
| `idle_warning` | yes | yes | Sweeper, 30 s before the idle wipe | Staff "Keep open"; the guest sees it and (G1) can ask for more time |
| `cap_warning` | yes | yes | Sweeper, 2 min before the cap | Staff "Extend 5 min"; the guest sees it and (G1) can ask for more time |
| `session_paused` (G1) | yes ("Please wait, the desk is checking this screen") | yes | Device change | Only Help works until a new check code |
| `signing_available` | yes | — (staff sees `status`) | Recognizer status change | Sign card enabled or disabled with its reason |
| `vlm_proposal` (reserved) | — | — | `vlm_suggestion` with `VLM_FALLBACK=1` | Stub only |
| `session_end` | yes (reason, `pendingLost`) | yes | End guest, idle, cap, guest left, pair failed, repair (guest only), restart | Clients clear everything; the guest end screen says why |
| `status` | — | yes, every 2 s and on change | Server | Recognizer (with framing and restarts), guest connection, counters, privacy, latency, profile, flags |

Guest streams also receive an SSE comment ping (`: p`) every 2 seconds, which is not an event.

---

## 8. Route catalogue

"Staff cookie" means the `sb_staff` capability cookie (section 9.6). "Guest cookie" means `__Host-sb_g` on the guest listener (or its Mode 0 loopback form). Every route also passes its listener's Host allowlist, and every state-changing request passes the same-origin check (`Sec-Fetch-Site`, `Origin`). Error bodies are `ApiError`; every response has `Cache-Control: no-store`.

| Method and path | Listener | Who may call | Body cap, type | Rate limit | Status codes | Owner |
|---|---|---|---|---|---|---|
| `GET /staff` | Staff | Loopback (page shell; data needs the staff cookie) | — | — | 200; 403 | P4 |
| `POST /api/staff/claim` | Staff | Loopback, `Host: 127.0.0.1:3000`, same origin, body `{k}` from the one-time `#k=` URL (a new one after `SIGUSR2`) | 1 KB JSON | 10/min | 200 (sets cookie); 400; 403 wrong key; 410 already claimed | P4 |
| `GET /api/events?role=staff` | Staff | Staff cookie | — | 4 streams | 200; 401; 403 | P4 |
| `POST /api/staff/action` | Staff | Staff cookie, same origin | 4 KB JSON | 120/min | 200; 400 (wrong check code carries `triesLeft`); 401; 403; 409 (wrong state, captions before confirmation); 413; 415; 429 | P4 |
| `GET /api/staff/benchmark` | Staff | Staff cookie | — | — | 200; 401 | P4 |
| `POST /api/guest/signs` | Staff only | Loopback plus `X-Bridge-Key` (at least 32 characters, constant time) | 8 KB JSON | 10/s | 200 (`outcome` includes `stale`, `framing`, `ignored_pending`, `held`); 400; 401; 403 (not loopback, or arrived on the guest listener); 404 (`vlm_suggestion` when off); 409 (no active session, or guest not signing; never for `framing` or `status`); 413; 415; 429; 503 (`BRIDGE_KEY` unset or short) | P4 |
| `GET /api/guest/signs` | Staff only | Loopback plus `X-Bridge-Key` | — | 10/s | 200 `{accepting}`; 401; 403; 503 | P4 |
| `POST /api/dev/simulate` | Staff only | Staff cookie, `SB_SIMULATE=1` | 8 KB JSON | 10/s | as `/api/guest/signs`; 404 when off | P4 |
| `GET /signs/index.json`, `GET /signs/<dir>/<file>.json` | Staff only | Loopback | — | — | 200; 404 | P4 (route) |
| `GET /signs/bundle` | Both | Guest cookie on the guest listener; loopback on the staff listener | — | 2/min per session | 200 (fixed size, padded); 401 | P4 |
| `GET /guest` | Both (Mode 0 uses the staff listener with `Host: localhost:3000`) | Anyone on an allowed Host; shows nothing without a cookie | — | — | 200; 403 bad Host | P4 |
| `GET /api/events?role=guest` | Both | Guest cookie | — | 2 streams, newest wins; comment ping every 2 s | 200; 401 (with `Clear-Site-Data` on the guest listener only; on the staff listener only `sb_g` is expired) | P4 |
| `POST /api/guest/join` | Both | Anyone on an allowed Host; `GUEST_IPS` checked first | 4 KB JSON `{code}` | 5 failures per address per minute; no global ceiling | 200 `{check, hello}` and `Set-Cookie`; 400; 403 (address not in `GUEST_IPS`, code not burned); 410 (used or expired); 413; 415; 429 (that address only) | P4 |
| `POST /api/guest/action` | Both | Guest cookie, same origin (`emergency` is dispatched before every other check) | 4 KB JSON | Per session and action kind (section 9.5) | 200; 400; 401; 409 (stale proposal after the 10 s grace, wrong mode, not confirmed yet; never for `emergency`); 413; 415; 429 (never for `emergency`) | P4 |
| `POST /api/guest/leave` | Both | Guest cookie (also accepted with a dead cookie) | empty | 10/min | 200 with an expired cookie; `Clear-Site-Data` only on the guest listener (never on the staff listener, section 9.6) | P4 |
| `GET /_next/static/*`, `GET /favicon.ico` | Both | Anyone on an allowed Host | — | — | 200; 404 | Next |
| `GET /avatar/bellhop.glb` | Staff; guest **only if Talha accepts the D6 amendment** | — | — | — | 200 | P2 file |
| `POST /api/transcribe` | Staff only | Loopback, same origin, staff cookie (added in `guard.ts`) | 5 MB multipart, Content-Length required | 20/min | 200; 403; 411; 413; 415; 429; 502 (status only); 503 no key | P1 |
| `POST /api/gloss` | Staff only | Loopback, same origin, staff cookie | 4 KB JSON | 30/min | 200; 400; 403; 413; 415; 429 | P1 |
| `POST /api/english` | Staff only | Loopback, same origin, staff cookie | 8 KB JSON | 10/min | 200; 400; 403; 413; 415; 429 | Nath |
| `POST /api/tts` | Staff only | Loopback, same origin, staff cookie | 4 KB JSON | 20/min | 200 `audio/wav`; 400; 403; 413; 415; 429; 500; 503 busy | Nath |
| `/p1-test`, `/avatar-preview` | Staff only | Loopback | — | — | 200 | P1, P2 |

**Guest listener path list** (decision record D6, default deny, everything else 403): `GET /guest`, `GET /favicon.ico`, `GET /_next/static/*`, `GET /api/events`, `GET /signs/bundle`, `POST /api/guest/join`, `POST /api/guest/action`, `POST /api/guest/leave`. Per-gloss `/signs/*` is removed from the guest listener. **Proposed amendment for Talha:** add exactly `GET /avatar/bellhop.glb`, a fixed 8 MB file that is the same for every guest and reveals nothing; if declined, the guest uses the `hologram` avatar style.

**Sign bundle.** `GET /signs/bundle` returns `{index, files}` with every file referenced by `signs/index.json` (signer removed), padded to a fixed size, fetched once at pairing. P2 is asked to add `preloadSigns(bundle)` to `web/lib/avatar/lookup.ts` so `loadIndex` and `loadSign` read from it; until then the guest listener shows captions and text sign cards, which is the documented fallback (AS-24).

---

## 9. Session, pairing, idle wipe and hard cap

### 9.1 States

```
                New guest                    Guest is here                 join ok (code burned, cookie set)
 NO_SESSION ─────────────► WAITING_FOR_GUEST ─────────────► AWAITING_PAIR ─────────────────────► PAIRED_UNCONFIRMED
     ▲                                                       │  code refreshed every 60 s            │  staff types check code
     │                                                       │  (expires after 120 s)                │  wrong x3 -> WIPED (pair_failed)
     │                                                       │                                       ▼
     │                         Mode 0: join from loopback is confirmed at once ───────────────────► ACTIVE ◄──────────────┐
     │                                                                                              │  │                  │
     │                                                       device address/browser changed ────────┘  ▼                  │
     │                                                       PAUSED (Help only) ── new check code ok ───┘ staff action or  │
     │                                                                                                 accepted signs reset│
     │   End guest / idle (profile) / cap (15 min) / guest "I'm finished" / pair failed     the idle timer ──┘
     └──────────────────────────────────────────────── WIPED ◄──────────────────────────────────────────────────────────────
```

There is at most one session. The store lives on `globalThis[Symbol.for("signbridge.store.v2")]`, in memory only.

### 9.2 Idle wipe and hard cap

Only staff actions (including "Keep open") and accepted sign batches from the desk camera reset the idle timer. Guest actions, acknowledgements, heartbeats and reconnects never do (AS-16), because a hostile device must not be able to keep a session alive.

The values come from the profile (`SESSION_PROFILES` in `types.ts`, chosen with `SB_PROFILE`; `IDLE_WIPE_MS` and `SESSION_CAP_MS` override both) and the staff header always shows the value in force:

| Profile | Idle wipe (active / unconfirmed) | Cap | Mode 0 guest input | Use |
|---|---|---|---|---|
| `stage` | 10 min / 10 min | 15 min, staff "Extend 5 min" | Allowed with `MODE0_GUEST_INPUT=1` | The hackathon demo: pausing to point at the Latency and Privacy tabs, a juror typing, or framing trouble can easily pass 2 minutes with no staff action |
| `engagement` (default) | 120 s / 60 s | 15 min, staff "Extend 5 min" | Never (D3) | The security engagement |

A warning goes to both screens 30 seconds before the idle wipe and 2 minutes before the cap; the guest sees both (section 4.5). Two minutes before the cap, the staff screen offers "Extend 5 minutes", which only staff can press, and each extension is logged. In `AWAITING_PAIR` only the code's own 120-second expiry applies.

**The WCAG 2.2.1 trade-off.** A 120-second idle wipe that guest typing cannot delay works against a Deaf guest writing a long message or waiting while staff fetch key cards. We keep AS-16 (guest actions never reset the timer) because a hostile device must not keep a session alive, and mitigate it three ways: the guest sees the warnings, the staff profile for the stage is 10 minutes, and in Tier 1 the guest can tap "I need more time", which alerts staff but resets nothing. A 5-minute engagement idle limit was considered and is left to the AS owner (critique log C2-10).

### 9.3 Wipe

Wiping sends `session_end` to every stream and closes the guest streams; erases the log, names, typed text, proposals, skeleton snapshots, sign events, held utterances, check code, device binding, token hash and nonce set; clears any cache that could hold guest-derived audio; and resets the per-guest counters. The since-start counters stay because they hold no personal data. A unit test runs a conversation that uses the name and typed text `Zq7Canary`, wipes, and asserts that the canary is absent from `JSON.stringify(store)`. A server restart loses everything, which is intended.

### 9.4 Reconnection and device changes

The guest stream authenticates with the cookie, which `EventSource` sends on its own. The server sends an SSE comment ping (`: p`) to every guest stream every 2 seconds, well under the guest page's 5-second watchdog, so a quiet conversation never looks dead. The guest page also posts a `heartbeat` action every 5 seconds; it is rate-limited, never counts as activity, and feeds only the "Heard N s ago" display.

**Token rotation (Tier 2).** AS-5 asks for the token to rotate on every stream reconnect. Rotating on every reconnect without a grace period would make in-flight action POSTs carry the old cookie and fail with 401, which then shows "Ask the desk to reconnect" and pauses the session. So when rotation is built, the previous token stays valid for 30 seconds after a rotation, and a unit test checks that a reconnect while an action POST is in flight still succeeds. Rotation buys little against a compromised device, which can read its own cookie anyway; it is defence in depth. In Tier 0 the Mode 0 token does not rotate; it is revoked at every end.

When a third stream opens, the oldest is closed (newest wins). A 401 that was not preceded by `session_end` shows a full-screen "Ask the desk to reconnect", and (Tier 1) the staff screen shows the device-changed warning with a one-tap re-bind that needs a new check code. Two simultaneous streams from different addresses are refused (Tier 1).

### 9.5 Guest action rate limits (compromised_device.md R7)

Limits are keyed per session and per action kind, never one global window per route, so one kind can never use up another kind's budget. `emergency` is dispatched **before** any limiter, nonce check or state check.

| Action | Limit | When exceeded |
|---|---|---|
| `emergency` | One alert while unacknowledged; repeats raise its count; accepted before confirmation and while paused; in Tier 1 also accepted from an address in `GUEST_IPS` with a dead or expired cookie (as `leave` already is) | Never 429 or 409 |
| `interpreter_request` | 1 per 60 s, repeats merged | Merged |
| `guest_typed` | 6 per minute, 280 characters each | 429 "Please wait a moment" |
| `guest_reply` | 10 per minute | 429 |
| `guest_confirm`, `guest_fix` | Only for the pending proposal, or the previous one within 10 s of its replacement | 409 |
| `guest_phrase` | 10 per minute | 429 |
| `prefs`, `guest_choice`, `stop_signing` | 10 per minute, each shown to staff as a neutral line | 429 |
| `ack` | 120 per minute, not activity | Ignored above the limit |
| `heartbeat` | 1 per 2 s, not activity | Ignored above the limit |
| `more_time` (Tier 1) | 1 per 30 s | Merged |
| `device_health` (Tier 2) | 1 per 10 s, kiosk only | Ignored |
| `POST /api/guest/join` | 5 failed attempts per address per minute, no global cap | 429 for that address |

Every guest action carries a client nonce `n` (16 random bytes, hex); a nonce seen before in this session is refused with 409 and raises "Repeated request". The nonce catches retries; it does not stop a compromised device, which can always make fresh nonces (section 10, honest strength labels).

Help does not travel on an independent path: it uses the same connection, cookie and stream as everything else, and a compromised device can simply not send it. The printed "wave or knock" card and the staff heartbeat are the independent path; the button is a convenience, and the documents say so.

### 9.6 Staff capability and Mode 0 cookies

At start, `server.mjs` prints a one-time URL `http://127.0.0.1:3000/staff#k=<random>`. The staff page posts `k` to `/api/staff/claim`, receives the `HttpOnly; SameSite=Strict; Path=/` cookie `sb_staff` (with the `__Host-` prefix if step 0 shows the demo browser accepts it on `http://127.0.0.1`), and immediately removes the fragment with `history.replaceState`. The terminal that shows the URL is never projected. Every `/api/staff/*` call, the staff stream, the simulator and, through `guard.ts`, the P1 and Nath routes require the cookie and `Host: 127.0.0.1:3000`. Loopback alone is never treated as authentication, because every local process shares it (D6).

**Re-claim without a restart.** A server restart wipes everything, so a receptionist who loses the staff cookie must not need one. Sending `SIGUSR2` to the server process (`kill -USR2 <pid>`, from the same user's terminal) prints a new one-time `#k=` URL; claiming it replaces the old staff cookie. The current guest session is not touched.

**Mode 0 cookies.** The staff window runs on `http://127.0.0.1:3000` and the guest window on `http://localhost:3000`. These are different hosts, so they are different cookie sites: the guest window never receives `sb_staff`, and nothing the guest side clears can touch it. The Mode 0 guest cookie is `sb_g` (`HttpOnly; SameSite=Strict; Path=/`, stored as a SHA-256), set only for `localhost`. Guest routes on the staff listener accept only `Host: localhost:3000` with `Origin: http://localhost:3000`; staff routes accept only `Host: 127.0.0.1:3000` with `Origin: http://127.0.0.1:3000`. The staff listener **never** sends `Clear-Site-Data`; on `leave` and on a dead guest cookie it only expires `sb_g`. Clear-Site-Data is sent only by the guest TLS listener (Tier 1).

---

## 10. Server and Next.js 16 specifics

- **Header ownership (D7, Tier 1).** `web/server.mjs` alone sets `Content-Security-Policy`, `Permissions-Policy`, `X-Frame-Options`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, `Origin-Agent-Cluster`, `X-Robots-Tag` and, on the guest listener, `Strict-Transport-Security: max-age=86400`. The `headers()` block in `web/next.config.ts` keeps none of them, because Next applies config headers later and would replace the nonce policy. A new pure module `web/lib/app/headers.ts` exports `cspFor(path, nonce, dev, listener)` and `headersFor(path, listener)`. On stage tonight (loopback only) the current headers stay; `Cache-Control: no-store` on every app API response is Tier 0.
- **Nonce CSP (Tier 1).** For every page request, `server.mjs` deletes any client-sent CSP request header, creates a 16-byte nonce, sets the policy on the request (Next 16 reads the nonce from there) and on the response. `/guest` and `/staff` call `await connection()` so they render per request. The guest policy is `lan_tls_pairing.md` section 5.3 (`script-src 'nonce-…' 'strict-dynamic'`, `default-src 'none'`, `connect-src 'self'`, `media-src 'none'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`); the staff policy adds `media-src 'self' blob:`. `'unsafe-eval'` and `ws:` are added in development only. P2 runs one avatar rehearsal with the policy as Report-Only before it is enforced (LT-25).
- **Permissions-Policy (Tier 1).** Guest: `camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), publickey-credentials-get=(), clipboard-read=(), screen-wake-lock=(self), compute-pressure=(self)`. Staff: `camera=(), microphone=(self), geolocation=(), compute-pressure=(self)`.
- **TLS (Tier 1).** `https.createServer` with `minVersion: "TLSv1.3"` on every context, a 5-second handshake timeout, a per-address connection cap counted on `connection` (before the handshake): 24 for an address in `GUEST_IPS`, 8 for any other. The guest page is served over HTTP/1.1, where a browser opens up to 6 parallel keep-alive connections for Next chunks and the avatar model, plus one or two event streams, watchdog reconnects and half-closed sockets, so 8 would starve the real guest device. The real connection count from Safari is measured on the isolated machine before gate G1. Fail-closed start-up. Certificates come from the event CA (D5); key files are `0600` outside the repository.
- **SSE.** `export const dynamic = "force-dynamic"`, a `ReadableStream` response with `Content-Type: text/event-stream`, `Cache-Control: no-store, no-transform`, `X-Accel-Buffering: no`, TCP keep-alive, a 2-second comment ping on guest streams, and `compress: false` in `next.config.ts` so nothing buffers the stream. A subscriber is removed on **any** of: `request.signal` abort, the stream's `cancel()`, or a failed `enqueue`. Whether `request.signal` fires on client disconnect under the custom server is unverified, so step 0 tests it; if it does not, `/api/events` is served directly from `server.mjs` (Node 22.22 strips types) using the same `globalThis` store.
- **One store, one bus, one sweeper.** Route handlers are bundled per route, so a module-level store would be duplicated per route chunk. The store and bus live on `globalThis[Symbol.for("signbridge.store.v2")]`, and the idle/cap sweeper starts behind a `globalThis` flag, so a route chunk or a development hot reload never adds a second sweeper.
- **Same process.** Route handlers and `server.mjs` share one process (the integration merge confirmed the guard's `SB_PROOF` works), so the store and counters are shared. `server.mjs` handles `SIGUSR2` for the staff re-claim (section 9.6).
- **Pure modules for tests.** Logic lives in pure modules that take their clock, random source and config as arguments (`vocab.ts`, `match.ts`, `validate.ts`, `store.ts`, `bus.ts`, `ingest.ts`, `checklist.ts`, `latency.ts`, `theme.ts`, and in Tier 1 `pairing.ts`, `warnings.ts`, `headers.ts`), with `node:test` files beside them run by `npm run test:unit`. They import each other with explicit `.ts` extensions, and step 0 sets `allowImportingTsExtensions: true` in `web/tsconfig.json` (`noEmit` is already on), so the same files load under Next and under Node type stripping. Modules that read env or keys import `server-only` and contain only wiring.
- **Core controls are proved at server level, not in a browser.** Playwright needs a browser download, which conflicts with `npm ci --ignore-scripts` on the loaner, so the tests that guard the core promises are `node:test` checks against the server modules: no `guest_utterance` and no speak plan exist before `guest_confirm`; the canary name never appears in any outgoing request the speak plan would make; emergency is never refused. Playwright and axe-core are Tier 2.

### 10.1 Honest strength labels

Expert testers will check what each control really does, so the documents and the stage claims label these as defence in depth or speed bumps, never as protections:

- HSTS `max-age` on an IP-address URL is ignored by browsers. The real control is that there is no plain-HTTP listener at all.
- Clear-Site-Data support in iPad Safari is partial. The real control is the cookie's expiry and revocation on the server.
- Client nonces catch retries. Against a compromised device they do nothing, because it can make fresh ones; TLS already stops network replay.
- Binding the token to the User-Agent is a speed bump. The address binding and the staff check code do more.
- "A compromised guest device sees everything shown or typed on it: every caption, the room number, and the name it typed. We minimise what is shown and default to the team iPad." This sentence goes into `docs/security-testing.md` and the stage notes as written.

---

## 11. Consolidated requirements

Each row merges every source that asks for the same thing. **When**: `NOW` = Tier 0, the stage MVP built tonight on loopback (this is the only BUILD-NOW tier); `G1` = Tier 1, required before engagement gate G1 on the isolated loaner; `T2` = Tier 2; `LATER` = not this event. Owners: **A** = P4 builder A (server, security, logic), **B** = P4 builder B (screens), **P1** = Maya, **P2** = Cosme, **P3** = Talha (recognition), **Nath** = english and tts routes, **Ops** = Talha in person (demo operations). Tests: **U** = `web/lib/app/*.test.ts` (`npm run test:unit`, `node:test`), **S** = `web/security-tests/*.test.mjs` (`npm run test:security`, loopback only), **T** = `web/security-tests/tls.test.mjs` (TLS listener bound to 127.0.0.1 with a throwaway test CA in a temporary folder), **H** = `web/security-tests/hygiene.test.mjs` (repository greps), **E** = Playwright on loopback (Tier 2), **M** = manual rehearsal or the engagement pre-flight scripts. "Source" uses the IDs of the documents: RT (app-plan 10a of revision 0), AS (compromised_device 8), R (compromised_device 3), D and G (decision record), LT (lan_tls_pairing 8), BT (slide "build today" item), RY (rylo_final sections 4 and 5), F (feature list from Talha), C1-n and C2-n (critique log, section 16).

### 11.1 Deployment and server

| ID | Requirement | Source | Owner | When | Test that proves it |
|---|---|---|---|---|---|
| SRV-1 | The app runs only through `server.mjs`, from a production build for any demo; development mode is never reachable from a network; every route calls a guard, and a route with no guard is a bug | RT1, B1, RY 7 | A | NOW | S: plain `next dev` fails closed (exists). H: every `route.ts` under `web/app/api` calls a guard function |
| SRV-2a | Remove the plain-HTTP `--lan` code path, `firstLanIPv4`, and the `dev:lan` and `start:lan` scripts now | D3, RT2, AS-17, C1-20 | A | NOW | S: no listener other than 127.0.0.1 can be started; H: no `--lan` in `package.json` |
| SRV-2b | Guest listener HTTPS only on an explicit `LAN_IP:3443` inside `LAN_NET`, TLS 1.3 on every context; start-up refuses without certificate, key or `LAN_IP`; no `TLS_MIN` or `ALLOW_PLAIN_HTTP_LAN` | D3, LT-01, LT-06, LT-31, R8 | A | G1 | T: plain HTTP to the guest port gets no response; TLS 1.2 refused; start without a key exits non-zero |
| SRV-3 | The listener decides the role: guest-listener requests are never loopback, whatever the socket address | LT-06, AS-17 | A | G1 | T: guest listener on 127.0.0.1 answers 403 to `/staff`, `/api/staff/action`, `/api/guest/signs`, `/api/tts` |
| SRV-4a | Staff listener Host allowlist `127.0.0.1:3000` and `localhost:3000`; staff routes only on `127.0.0.1:3000`, Mode 0 guest routes only on `localhost:3000`, each with its matching Origin; client `x-sb-*` headers stripped | B3, LT-07, C1-3 | A | NOW | S: staff action with Host `localhost:3000` is 403; guest action with Host `127.0.0.1:3000` is 403; forged `x-sb-*` ignored (exists) |
| SRV-4b | Guest listener Host allowlist `LAN_IP:3443` and `DESK_NAME:3443` | LT-07 | A | G1 | T: foreign Host 403 |
| SRV-5 | Guest listener path list exactly as D6 (plus `/avatar/bellhop.glb` only if Talha accepts); everything else 403; per-gloss `/signs` removed from the guest listener | D6, RT7, LT-28, B2 | A | G1 | U: `lanPathAllowed` cases. T: `/signs/team/LEAVE.json` 403 on the guest listener |
| SRV-6 | `GET /signs/bundle`: every sign file, signer removed, padded to one fixed size, guest cookie required on the guest listener; P2 adds `preloadSigns(bundle)` | D6, LT-28, C1-12 | A, P2 | G1 | T: two bundles for different sessions have identical byte length; 401 without cookie |
| SRV-7 | `server.mjs` alone owns the security headers; `next.config.ts` sets none of them; exactly one CSP header; nonce CSP with `'strict-dynamic'` and no `'unsafe-inline'` or `'unsafe-eval'` on `/guest` and `/staff` in production; client CSP request headers stripped | D7, AS-18, LT-16, LT-17, LT-27, LT-29, R12, B7 | A | G1 | S (production build): one `Content-Security-Policy` line, `script-src` has a nonce and no `unsafe-*`, nonce differs between two requests |
| SRV-8a | `Cache-Control: no-store` on every app API response and on `/guest` and `/staff` | AS-2 | A | NOW | S: header present per route |
| SRV-8b | The rest of the header set of `lan_tls_pairing.md` 5.3 (guest Permissions-Policy, COOP, CORP, Origin-Agent-Cluster, X-Robots-Tag, HSTS on the guest listener, no-store on static files) | AS-2, AS-19, LT-19, LT-20, R2, R11 | A | G1 | S, T: header table checked per listener and path |
| SRV-9 | Per-address connection cap before the TLS handshake: 24 for an address in `GUEST_IPS`, 8 for others; handshake and request timeouts; no global join ceiling; real Safari connection count measured on the isolated machine | LT-21, AS-15, D6, C1-14 | A, Ops | G1 | T: 30 sockets from a non-guest address, the 9th is closed; a guest-address browser load with 12 connections succeeds |
| SRV-10 | Staff capability: one-time `#k=` URL printed at start, exchanged once for an HttpOnly SameSite=Strict cookie, fragment removed with `replaceState`; `SIGUSR2` prints a new one-time URL without a restart; required on `/api/staff/*`, the staff stream, the simulator and (through `guard.ts`) P1 and Nath routes | D6, LT-30, C1-3, C1-20 | A | NOW | S: staff action without the cookie 401; second claim 410; after `SIGUSR2` a new claim succeeds and the session survives; `/api/tts` without the cookie 401 |
| SRV-11 | Body caps with the capped reader, content-type allowlist, strict schema validation on every route | RT12, AS-12, B4, R6 | A | NOW | U: validators. S: 413, 415, 400 per route |
| SRV-12 | Logs carry status codes and short error types only: never URLs, codes, tokens, check codes, names, typed text, transcripts or vendor bodies | RT11, LT-22, B8, D6 | A | NOW | S: run a full simulated session with `Zq7Canary`; it never appears in server output |
| SRV-13 | No secrets in the browser: no `NEXT_PUBLIC_`, key readers import `server-only`, no key value in `.next/static`; guest bundle without staff page code | AS-20, RY 13, R12 | A | NOW | H: greps. M: after `next build`, grep `.next/static` for key values |
| SRV-14 | Child processes use an absolute executable and an allowlisted environment | RT10, B9 | Nath, A | NOW (exists for Piper) | S: Piper spy test (exists) |
| SRV-15 | Works fully offline with no vendor keys: quick replies, fixed tables, phrases, Piper, local voice, P1 local gloss; the staff header says "Vendor keys: none" | D8, RT13, BT 4 | A, B | NOW | M: the demo script with no keys in the environment; privacy panel shows 0 vendor calls |
| SRV-16 | Event CA (name-constrained, 3 days, key destroyed), never mkcert; TLS key files `0600` outside the repository; `*.pem`, `*.key`, `*.crt` ignored | D5, LT-04, LT-23 | Ops | G1 | M: LT-04 and LT-23 checks in `preflight_laptop.sh` |
| SRV-17 | Deploy only a signed, reviewed tag; `npm ci --ignore-scripts`, `pip install --require-hashes`; freeze 24 hours before | RT14, D9, G0 | Ops, all | LATER (gate G0) | M: G0 checklist |
| SRV-18 | Vendor terms read and zero-retention on before any vendor path is used with a guest | RT13 | Talha | LATER | M: written record |
| SRV-19 | Store and bus on `globalThis`; sweeper started once behind a `globalThis` flag; a subscriber is removed on abort, `cancel()` or a failed `enqueue` | C1-18 | A | NOW | U: two imports of the store module share state; S: 20 reconnects leave the subscriber count at the open streams |
| SRV-20 | `allowImportingTsExtensions` in `web/tsconfig.json`; `.ts` extensions in `web/lib/app` imports; `npm run test:unit` runs `node --test` with type stripping | C1-19 | A | NOW | `npx tsc --noEmit`, `next build` and `npm run test:unit` all pass |
| SRV-21 | QR drawn with a vendored MIT encoder (`qrcode-generator`, one file), its SHA-256 recorded in `docs/security-testing.md` | C1-19 | A | G1 | H: the file's hash matches the recorded one |

### 11.2 Pairing and session lifecycle

| ID | Requirement | Source | Owner | When | Test that proves it |
|---|---|---|---|---|---|
| SES-1a | Mode 0 join: "Open guest window" opens `http://localhost:3000/guest#p=<code>`; 128-bit code, 120 s, single use, removed with `replaceState` before any request; the loopback join is confirmed at once | D6, AS-9, C1-3 | A, B | NOW | U: code expiry and single use. S: a second join with the same code is 410 |
| SES-1b | Mode C pairing: "Guest is here", QR as a full-screen overlay drawn as `<rect>`, refreshed every 60 s with the previous code still valid until its own expiry (at most two live), closed on join | D6, AS-9, LT-08, R4, C1-17 | A, B | G1 | U: a code issued at 0 s still joins at 110 s after a refresh at 60 s; a third code kills the first |
| SES-2 | Join checks `GUEST_IPS` first (403, code not burned), then the code in constant time, then counts failures per address (5 a minute); a valid code is never rate-limited; failures shown on staff | D6, AS-15, LT-12 | A | G1 | U and T: outside address gets 403 and the real device can still join with the same code |
| SES-3 | 6-digit check code created at join, shown only on the guest device (with "the desk reads this number off this screen"), typed by staff, 3 tries then wipe; before confirmation only Help is accepted and captions get 409; both screens show the number after | D6, AS-10, LT-09, C2-24 | A, B | G1 | U: tries and states. T: `say_quick` before `confirm_pair` is 409; `emergency` before confirmation is 200 |
| SES-4a | Mode 0 guest cookie `sb_g` on `localhost` only (HttpOnly, SameSite=Strict, Path=/), stored as SHA-256; never in a URL, body, storage or log | D6, AS-4, C1-3 | A | NOW | S: join body has no token; `sb_g` is never set for `127.0.0.1` |
| SES-4b | Guest token in the `__Host-sb_g` cookie (Secure, HttpOnly, SameSite=Strict, Path=/, no expiry) on the guest listener | D6, AS-4, LT-10, RT3 | A | G1 | T: cookie attributes exact; a replayed cookie with another User-Agent gets 401 |
| SES-5 | Token rotated on stream reconnect and on repair, with the previous token valid for 30 s after a rotation; revoked on End guest, idle, cap and leave | AS-5, LT-13, C1-6 | A | T2 (revocation NOW) | U: old token refused after the grace and after each kind of end; a reconnect during an in-flight action POST still succeeds |
| SES-6 | Device binding: address plus User-Agent hash and parsed device class; a change pauses everything except Help, warns staff and needs a fresh check code; two simultaneous streams from different addresses refused; an unexpected 401 shows "Ask the desk to reconnect" | AS-11, LT-11, R5 | A, B | G1 | U: store with injected addresses. M: renew the guest address in rehearsal |
| SES-7 | Guest stream: cookie auth, `retry: 2000`, `hello` and snapshot on connect (last caption, pending proposal, latest framing, `signingAvailable`), a comment ping every 2 s, newest stream wins (2), 5 s client watchdog, `no-store, no-transform` | LT-14, LT-20, AS-1, R1, C1-6 | A, B | NOW | U: guest snapshot keys. S: a silent conversation of 30 s causes no reconnect |
| SES-8 | Idle wipe reset only by staff actions and accepted sign batches; values from the profile (stage 10 min, engagement 120 s and 60 s unconfirmed); 30 s warning on both screens; the value in force shown on the staff header | AS-16, R14, RY 15, C1-8, C2-10 | A, B | NOW | U: guest actions, heartbeats and acks do not move the timer; the profile sets the value |
| SES-9 | Hard cap 15 minutes; staff-only "Extend 5 minutes" offered 2 minutes before; the guest sees the cap warning and can never extend | AS-16, R14, C2-10 | A, B | NOW | U: cap fires while busy; a guest `extend` is 400; `cap_warning` reaches the guest projection |
| SES-10 | End guest and every wipe erase everything (log, names, typed text, proposals, held utterances, skeletons, sign events, tokens, check code, binding, guest-derived audio cache); `session_end` to all streams; the staff listener never sends Clear-Site-Data and only expires `sb_g`; the guest TLS listener (G1) sends Clear-Site-Data on `leave` and on the next 401 | LT-13, AS-6, RT5, RY 15, C1-3 | A | NOW (G1 for the TLS part) | U: `Zq7Canary` absent from the store after wipe. S: after End guest the staff cookie still works and the staff can start a new guest |
| SES-11 | Guest page uses no `localStorage`, `sessionStorage`, IndexedDB, Cache API, service worker or manifest; inputs have autocomplete, autocorrect, autocapitalize and spellcheck off on kiosk devices; neutral screen on `pagehide` and when hidden, restored from memory when visible again; after `session_end` history shows only the ended page | AS-3, AS-7, AS-8, R2, R3, C2-25, C2-27 | B | NOW | H: greps over `web/app/guest`, `web/components/guest`. M: hide and show the window; the proposal is still there |
| SES-12 | The guest can end the conversation with "I'm finished" in the "More" menu, after a confirmation dialog (reason `guest_left`) | D6, C2-9 | A, B | NOW | U: leave ends the session. M: staff sees "The guest ended the conversation" |
| SES-13 | Mode 0 separate origins: staff on `127.0.0.1:3000`, guest on `localhost:3000` | C1-3 | A, B | NOW | S: after a guest `leave` the staff action still returns 200 |
| SES-14 | Profiles: `SB_PROFILE=stage` (idle 10 min, `MODE0_GUEST_INPUT` allowed) and `engagement` (strict values, Mode 0 display-only); the header shows profile and mode | C1-2, C1-8, D3 | A, B | NOW | U: `engagement` ignores `MODE0_GUEST_INPUT=1` and sets `displayOnly: true` |
| SES-15 | Guest heartbeat POST every 5 s, rate-limited, never activity, feeding "Heard N s ago" | C1-7 | A, B | NOW | U: heartbeat updates `lastHeardAt` and not `lastActivityAt` |

### 11.3 Recognizer bridge

| ID | Requirement | Source | Owner | When | Test that proves it |
|---|---|---|---|---|---|
| BRG-1 | `POST /api/guest/signs` only on the staff listener, loopback plus `X-Bridge-Key` (at least 32 characters, constant time, 503 when unset), 8 KB, 10 a second | RT9, LT-24 | A | NOW | S: 401 wrong key, 503 short key, 413, 429 |
| BRG-2 | Accepts the real bridge events (`sign`, `utterance`, `framing`, `status`); unknown keys ignored, known keys strict; 22 labels plus the `FS-CHECKOUT` alias; `face`, `frames`, `pose` or `video` keys refused and counted | Recognizer README "App bridge", C1-13 | A | NOW | U: `validate.test.ts` with the README examples, fuzzed labels, `NaN`, extra `face`; the refusal counter moves |
| BRG-3 | Stale events (`t_sent` older than 5 s or before the session start) dropped; duplicate `seq` in a run dropped; a lower `seq` starts a new run and is never dropped; (`run`, `seq`) once P3 sends `run` | README, AS-21, C1-11 | A, P3 (`run`) | NOW | U: a restart whose `seq 1` was lost still delivers `seq 2` and `seq 3` |
| BRG-4 | Consent gate: `sign` and `utterance` accepted only in `ACTIVE` with the guest in Sign mode; `framing` and `status` always accepted and stored; `GET` answers `{accepting}` | RT4, BT 2, RY 12, C1-10 | A | NOW | U and S: 409 for signs in `choosing`, `type`, `text_only`; framing accepted in `choosing` and shown after the guest taps Sign |
| BRG-5 | Recognizer `status` shown; `signingAvailable` follows it; in `mock` every proposal is test mode and never spoken; `no_model` or 5 s of silence shows the staff fallback band | README status, C1-9, C2-23 | A, B | NOW | U: test-mode proposals have no speak plan; `no_model` sets `signingAvailable: false` |
| BRG-6 | Simulator posts the same events, needs the staff cookie and `SB_SIMULATE=1`, is labelled SIMULATED on both screens, 404 otherwise | Revision 0 4.5 | A, B | NOW | S: 404 when off |
| BRG-7a | Skeleton snapshot accepted in its exact shape (pose 0 and 11 to 16 plus hands, x and y, no face, one frame, at most 2 KB); staff only, memory only, wiped, counted; text evidence on the staff screen | F, RY "privacy mode" | A, B | NOW | U: guest projection never contains `skeleton`; face keys refused; wipe erases snapshots |
| BRG-7b | Skeleton drawn as dots and lines; P3 sends the field | F | B, P3 | T2 | M: simulator sign with a skeleton draws it |
| BRG-8 | Utterance join falls back to the utterance's top-1 when a `sign` event is missing; `needs_repeat` is a hint for the log only | C1-4, C1-11 | A | NOW | U: `needs_repeat: true` with one sign at 0.45 whose runner-up matches gives `did_you_mean`; an unjoined weak sign uses its top-1 |
| BRG-9 | Staff header shows the latest framing status and how long it has not been OK, with the `--waist none` hint after 10 s | C1-10 | A, B | NOW | U: `framingNotOkSince` set and cleared |

### 11.4 Confirm before speaking

| ID | Requirement | Source | Owner | When | Test that proves it |
|---|---|---|---|---|---|
| SPK-1 | Nothing reaches `/api/tts` or a speaker until the guest taps the send button (display-only Mode 0: staff tap "Guest pointed YES", logged as such); `NONE` and below-bar signs are never spoken; a stale proposal past its grace gets 409 | RT4, A8, BT 2, RY 11 | A, B | NOW | U (server level): no `guest_utterance` and no speak plan without `guest_confirm` |
| SPK-2 | Harm-weighted gate (0.6 default, 0.75 for YES, NO, NAME, ROOM, HELP, provisional) and traffic lights; guest words "clear", "not certain", "missed" and no score; staff words with "model score (uncalibrated)" | BT 3, RY harm table, C2-4, C2-5 | A, B, P3 (final values) | NOW | U: `match.test.ts` bars, 0.6 passes, 0.5999 fails, lights; H: the guest projection has no `conf` |
| SPK-3 | The app's own gate (section 6.3): repeat only for `NONE`, framing, two weak signs or no candidate; "Did you mean...?" for one weak sign with one candidate; "Pick one" for two or three; "Did you mean HELP?" for a weak HELP or a confident lone HELP; nearest requests for unmatched signs; the guest always confirms | BT 3, F, C1-4, C1-17 | A, B | NOW | U: candidate generation for every intent with one sign weakened; lone HELP |
| SPK-4 | Order-insensitive multiset match for all 20 guest intents with `LEAVE` | RY 10 | A | NOW | U: parses `docs/vocabulary.md` section 2; every permutation matches; all multisets distinct |
| SPK-5 | Speak plan: Piper or the vendor voice only for fixed table sentences (sent as `{text}` of the fixed sentence until Nath accepts `{id}`), played through the staff page's one unlocked `AudioContext`; NAME needs staff "Speak name" and typed text needs "Read aloud", both with an on-device voice (`localService`) or text only; the canary never appears in an outgoing request | RT5, RT6, AS-13, R6, RY 9, C1-16 | A, B; Nath for `{id}` | NOW; `{id}` LATER | U (server level): speak plan for each case; the canary name never appears in a `tts` plan |
| SPK-6 | Name sanitizer (NFC, letters, marks, spaces, hyphen, apostrophe, 1 to 40) and typed text (NFC, no control characters, at most 280); the reason shown next to the field on failure; every guest string rendered as text only; no `dangerouslySetInnerHTML` | LT-29, B5, C2-25 | A, B | NOW | U: sanitizer cases and `field` in the error. H: no `dangerouslySetInnerHTML` |
| SPK-7 | Two separate settings, "Read my sentences aloud at the desk" (asked once on the first screen, "People nearby will hear it") and "Show avatar"; the send button reads "Send and read aloud" or "Send as text" to match | BT 2, RY 11, C2-22 | B | NOW | M: toggle off, nothing reaches `/api/tts` or `speechSynthesis` |
| SPK-8 | A pending proposal is protected: repeat and NONE-only utterances are ignored while it waits; only a new matched proposal replaces it; a confirm for the replaced proposal is accepted for 10 s; nothing replaces a pending NAME proposal | C1-5 | A | NOW | U: a NONE utterance during a pending proposal leaves it pending; confirm 5 s after a replacement succeeds, at 11 s gets 409 |
| SPK-9 | An unmatched utterance is held 4 s and merged with the next one if it arrives | C1-17 | A | NOW | U: `WHERE` then `ELEVATOR` 2 s later gives the elevator proposal |

### 11.5 Staff to guest

| ID | Requirement | Source | Owner | When | Test that proves it |
|---|---|---|---|---|---|
| CAP-1 | 20 quick replies with fixed glosses, no cloud call | CLAUDE.md 8.1, RY 1 | A, B | NOW | U: `vocab.test.ts` matches `docs/vocabulary.md` section 1 |
| CAP-2 | Voice and typed staff text: P1 `/api/transcribe` (transcript lands in the free-text box for review: Send / Discard), then `/api/gloss`; the server accepts only tokens in `signs/index.json`, `FS:` plus `^[A-Z0-9]{1,32}$`, or the two markers, at most 40; otherwise P1 `mapStaffTextToGloss` in process; otherwise captions only; captions at most 600 bytes | RT8, D8, CLAUDE.md 7.1, C2-13 | A, B | NOW | U: gloss validator rejects `FS:<script>`, 41 tokens, unknown words |
| CAP-3 | The free-text box is labelled "This text will appear on the guest's device" | AS-26, R1 | B | NOW | M: read the staff screen |
| CAP-4a | Guest renders captions first, then `mountAvatar` and `playGloss(gloss, {onToken})` with `AvatarCaptions`, per-gloss sign files on loopback; without WebGL, captions and text sign cards; system fonts only | AS-24, P2 API | B | NOW | M: with WebGL disabled the caption and cards still show |
| CAP-4b | On the guest listener, the avatar reads the sign bundle through P2's `preloadSigns`; until it lands, Mode C shows captions and cards, and the docs and stage say so | D6, C1-12 | B, P2 | G1 | T: no per-gloss request on the guest listener |
| CAP-5 | The avatar works under the nonce CSP (Report-Only rehearsal first) | LT-25 | P2, B | G1 | M: no CSP violations in the console during a full gloss |
| CAP-6 | Captions from speech-to-text carry "From speech recognition, may contain mistakes." on the guest screen | C2-13 | B | NOW | U: guest projection carries `captionSource` |

### 11.6 Guest features

| ID | Requirement | Source | Owner | When | Test that proves it |
|---|---|---|---|---|---|
| GST-1 | First screen: Sign, Type, Ask for a human interpreter, Text only as equal choices; the Sign card says what the system really recognises; `GUEST_NOTICE` (AS-23 with the one logged substitution) plus `GUEST_NOTICE_EXTRA` (video and what the desk sees); nothing ever asks for a password, card number or ID | AS-23, BT 2, RY 3, RY 12, R11, C2-3, C2-8, C2-14 | B | NOW | U: `GUEST_NOTICE` equals the document text with exactly that substitution (exists as a check). H: no input with `type=password` or card or ID wording in the guest page |
| GST-2a | "Get staff now" (one name everywhere) visible on every guest screen in its own row; dispatched before any limiter; never 429 or 409; merged count; accepted before confirmation and while paused; staff full-screen alert "Guest wants staff at the desk now" and "I'm coming"; "No reply yet. Wave or knock at the desk." after 20 s without acknowledgement; guest heartbeat on staff; printed "wave or knock" card | AS-14, AS-21, R7, R7a, BT 2, RY 12, C1-15, C2-14 | A, B, Ops (card) | NOW | U: emergency never refused, also when every other limiter is exhausted; 20 emergencies give no `warning`. M: drill with the request blocked; the actor waves and staff respond |
| GST-2b | Help accepted from an address in `GUEST_IPS` with a dead or expired cookie | C1-15 | A | G1 | T: emergency with an expired cookie from the guest address is 200 |
| GST-3 | Interpreter: VRI name and a contact labelled by kind ("Videophone", "Text"); a link only when the device is not a kiosk, with the video relay disclosure; honest text when VRI is unset; guest copy for each state ("Request sent", "The desk is arranging an interpreter"); called "a link" on stage | AS-25, RY 6, BT 2, C2-15 | B | NOW | U: `hello.kiosk` true hides the link; unset VRI gives `VRI_UNSET_TEXT` |
| GST-4a | Framing guidance in plain words without "the picture" shown on the guest screen in Sign mode; a framing-rejected sign is marked "missed" | Recognizer README framing, F, C2-16 | A, B | NOW | U: every status maps to text |
| GST-4b | Position diagram per framing status (outline, silhouette, arrow; no video) | C2-16 | B | T2 | M |
| GST-5 | Live sign display: each sign appears on the guest screen (top-1 with light and word, no score) and the staff screen (top 3 with times) as it is recognised | F, C2-4 | A, B | NOW | M: simulator `sign` events appear before the `utterance` |
| GST-6 | Device-health hint only from team-owned (kiosk) devices whose browser supports Compute Pressure; at most every 10 s; staff wording "reported by the guest device" and "not a security check"; the word "spyware" never appears | F, HANDOFF extras, C2-8 | A, B | T2 (the "spyware" grep NOW) | H: no "spyware" in `web/app`, `web/components`. U: rate and kiosk-only |
| GST-7a | Local vision-model fallback reserved: `vlm_suggestion` type, `local_vlm` source, the route answers 404 unless `VLM_FALLBACK=1` | F | A | NOW (types and 404 only) | S: 404 with the flag off |
| GST-7b | The "Suggested by a second program on this laptop" rendering of a VLM candidate, still confirmed by the guest | F | B | T2 | M |
| GST-8 | Per-session, per-kind guest rate limits and nonce replay refusal (section 9.5) | AS-14, RT12, R7, C1-15 | A | NOW | U: limits per kind; one kind cannot exhaust another |
| GST-9 | No camera or microphone code in the guest bundle | AS-19, R11 | B | NOW | H: no `getUserMedia`, `mediaDevices` or `geolocation` under guest paths |
| GST-10 | Phrases: the Type screen offers the 20 guest requests as large buttons with the same confirm and echo flow; the Sign screen has "What can I sign?" | C2-3, C1-9 | A, B | NOW | U: `guest_phrase` creates the same speak plan as a recognised proposal |
| GST-11 | Repair row under the latest caption: "Please repeat", "I don't understand", "Please type it", "Wait, please"; shown to staff, never spoken unless staff choose; marks the caption and its checklist item | C2-11, C2-26 | A, B | NOW | U: `guest_reply` sets the checklist item to `needs_retry` |
| GST-12 | The page keeps the last three staff sentences in memory, newest largest, with a "New" marker until tapped or scrolled and "Show again"; the snapshot still holds only the last one | C2-12, AS-1 | B | NOW | U: guest snapshot has one caption |
| GST-13 | End screen gives the reason and the honest storage sentence, and says when an unsent message was not sent | C2-18 | B | NOW | U: every end reason has text |
| GST-14 | "I need more time" on the idle and cap warnings: a non-resetting staff alert "Guest needs more time: Keep open" | C2-10 | A, B | G1 | U: `more_time` does not move the idle timer |
| GST-15 | Display-only rendering when `hello.displayOnly`: no tappable controls, only pointing instructions; laminated card on the counter | C2-1, D3 | B, Ops | NOW | M: no focusable control on the display-only guest window |
| GST-16 | `signingAvailable` on `hello`, snapshot and `signing_available`; the Sign card says why it is disabled | C2-23 | A, B | NOW | U: `no_model` sets it false |
| GST-17 | Avatar disclaimer line under the avatar; gloss key tags behind "Show sign names" with a key | C2-17 | B | NOW | M: read the guest screen |

### 11.7 Staff dashboard

| ID | Requirement | Source | Owner | When | Test that proves it |
|---|---|---|---|---|---|
| DSH-1 | Header strip: mode, profile, guest window or device, heartbeat, streams, idle value and countdown, cap with Extend, recognizer state, framing timer, voice warm-up, vendor keys, End guest (pairing state, failed joins and warning count in G1) | AS-21, R13, C1-8, C1-10 | B | NOW | M: values follow a simulated session |
| DSH-2 | Check-in co-pilot: 13 items, shared only on the guest device's acknowledgement, "sent" before it, "needs another try" after a repair reply, gentle "not shared yet", "guest asked; not answered yet", "I saw it" for ID, the fixed note, staff actions only | F (ProtoCopilot), C2-26 | A (`checklist.ts`), B | NOW | U: checklist reducer over a scripted event list |
| DSH-3 | Evidence: light and model score per recognised sign with timestamps, top 3 (or "top-1 only") and whether a skeleton snapshot exists; the evidence note; never video | F, C2-5 | B | NOW | M: simulator signs appear with times |
| DSH-4 | Latency panel only from real timestamps (section 6.5); guest-reported values labelled and limited to 0 to 10 s; "no data yet" otherwise | AS-22, F | A (`latency.ts`), B | NOW | U: stage arithmetic and the 10 s filter |
| DSH-5 | Privacy panel only from real counters, with the refused-key counters, the fixed-sentence TTS count and `PRIVACY_DISK_NOTE`; no hard-coded zeros | RY 4, F, C1-13 | A, B | NOW | U: counters move with each event. H: no file-writing calls in `web/lib/app`, `web/app/guest`, `web/app/staff` |
| DSH-6 | Benchmark card shows only audited figures; today "Accuracy figures: not yet audited"; a file must say `cleared: true` with an audit reference before any number shows | HANDOFF, F | A, B | NOW | U: synthetic or uncleared files give the "not yet audited" state |
| DSH-7 | Session safety warnings (section 6.6) with the staff response card; Help and consent choices never appear there | AS-21, R13, F, C2-6, C2-7 | A (`warnings.ts`), B | T2 (heartbeat display and recognizer line NOW) | U: each trigger raises its warning once; 20 emergencies give none |
| DSH-8 | Simulator panel for rehearsal, with the new buttons of section 6.7 | Revision 0 4.5 | B | NOW | M: rehearsal script |
| DSH-9 | Mock pager "notify guest" panel: generic codes only, no names, rooms or text, clearly labelled mock | HANDOFF extras, F | B | LATER (only if time remains) | H: the panel sends only codes from a fixed list |
| DSH-10 | Chrome required for staff; one `AudioContext` created and unlocked on "Start desk" plays every WAV; `warmUpVoice()` finishes before the recognizer is started | C1-16 | B, Ops | NOW | M: a sentence sent 5 minutes after Start desk is heard |
| DSH-11 | Large fallback band when the recognizer reports `no_model` or `mock` or is silent for 5 s, naming the declared fallback (Phrases, Type, or the simulator rehearsal said out loud) | C1-9 | B | NOW | M: stop the recognizer during rehearsal |

### 11.8 Accessibility

| ID | Requirement | Source | Owner | When | Test that proves it |
|---|---|---|---|---|---|
| A11Y-1 | Colour tokens per surface (section 4.1); navy text on brass | C2-19 | B | NOW | U: `theme.test.ts` checks every pair (4.5:1 text, 3:1 graphics) |
| A11Y-2 | Caption size `clamp(2rem, 1.25rem + 3vw, 4rem)`; usable at 200% zoom and large iOS text | C2-20 | B | NOW | M: 200% zoom check in rehearsal |
| A11Y-3 | One polite live region for status messages, one assertive region for Help, idle, cap and end; focus moves to a new proposal only when not in a text field; avatar canvas `aria-hidden` | C2-21 | B | NOW | M: screen reader pass on captions and a proposal |
| A11Y-4 | Landscape layouts 844x390 and 1180x820; axe-core run on every guest state | C2-20, C2-21 | B | T2 | E |
| A11Y-5 | Every miss message has the system as its subject; no "sure", "unclear" or percentage on the guest screen; missed signs grey outlined, not red | C2-4, C2-5 | B | NOW | H: no "unclear" or "%" in guest components |
| A11Y-6 | Send, Fix and Help in the bottom third; Help in its own full-width row; "I'm finished" in "More" with a confirmation dialog | C2-2, C2-9 | B | NOW | M: phone layout check |

### 11.9 People, operations and later work

| ID | Requirement | Source | Owner | When | Test that proves it |
|---|---|---|---|---|---|
| OPS-1 | On the counter: the printed "If the screen does not respond, wave or knock. Staff will come to you." card; the laminated YES / NO / TYPE / INTERPRETER / HELP card for display-only Mode 0; a stand for the guest device at eye level next to the desk camera; a "stand here" floor or counter marker; iPad auto-lock set to Never. Staff script: treat the screen like a person; never give keys or payment details because the screen asked; press End guest | compromised_device 2.4, `docs/security-testing.md`, C2-1, C2-2, C2-16, C1-17 | Ops | NOW (paper and props) | M: all on the counter at rehearsal |
| OPS-2 | Pairing script: check the device physically, never confirm without reading the guest device, never project the QR, "SignBridge never opens a login page and never asks for payment, passwords or ID" | LT-26 | Ops | G1 | M: rehearsal |
| OPS-3 | Live LAN and penetration testing only on an isolated machine; `SB_SECTEST_LAN=1` only there; nothing exposed on the development Mac's network | `docs/security-testing.md`, HANDOFF | All | NOW (rule) | M |
| OPS-4 | Wiped unmanaged loaner as the system under test; development Mac away from the venue; gates G0 to G3 | D1, D2, gates | Talha | LATER | M: gate checklists |
| OPS-5 | Constant-size 2048-byte guest frames every 250 ms with cover events, padded POSTs | LT-15, D3 Mode W | A | LATER (before gate G2 / Mode W only) | T: every frame on the guest stream has the same length |
| OPS-6 | Mode W router controls (two networks, PMF, isolation, RA guard) | D3, G2 | Ops | LATER | M: G2 checklist |
| OPS-7 | `ENGLISH_FALLBACK=1`: unmatched labels sent to Claude through Nath's route, labels only, as a candidate the guest must confirm | CLAUDE.md 7.2, RY 1 | A, Nath | LATER (never during the engagement window) | S: 404 when off |
| OPS-8 | `/api/tts` accepts `{ id }` only | RT5 | Nath | LATER | S: free text 403 |
| OPS-9 | Stronger device binding with a non-extractable WebCrypto key per action | R5 stretch | A | LATER | U |
| OPS-10 | A Deaf ASL user reviews the guest copy and the avatar, even a remote 30-minute review, before expert testing; if none happened, we say so on stage. Consent and opaque ids for team recordings | RT7, C1, C11, BT 4, C2-17 | Talha, all | NOW (ask tonight; the on-stage sentence is the fallback) | M: written note of who reviewed, or the stage sentence |
| OPS-11 | Sign-language picker on the first screen (ASL first; others need data) | Roadmap | B | LATER | — |
| OPS-12 | `BRIDGE_KEY` set with `read -s` or read from a `0600` file, never typed inline; the terminal that prints `#k=` is never projected | C1-20 | Ops | NOW | M: `history | grep BRIDGE_KEY` is empty after rehearsal |
| OPS-13 | Honest strength labels (section 10.1) in `docs/security-testing.md` and the stage notes | C1-21 | A | NOW | M: read the document |
| OPS-14 | Rehearse the real camera position at the counter; know the `--waist none` fallback | C1-10 | Ops, P3 | NOW | M: framing reaches `OK` at the counter |

**BUILD-NOW requirement IDs (Tier 0):** SRV-1, SRV-2a, SRV-4a, SRV-8a, SRV-10, SRV-11, SRV-12, SRV-13, SRV-14, SRV-15, SRV-19, SRV-20; SES-1a, SES-4a, SES-5 (revocation only), SES-7, SES-8, SES-9, SES-10, SES-11, SES-12, SES-13, SES-14, SES-15; BRG-1, BRG-2, BRG-3, BRG-4, BRG-5, BRG-6, BRG-7a, BRG-8, BRG-9; SPK-1 to SPK-9; CAP-1, CAP-2, CAP-3, CAP-4a, CAP-6; GST-1, GST-2a, GST-3, GST-4a, GST-5, GST-6 (grep only), GST-7a, GST-8, GST-9, GST-10, GST-11, GST-12, GST-13, GST-15, GST-16, GST-17; DSH-1, DSH-2, DSH-3, DSH-4, DSH-5, DSH-6, DSH-7 (heartbeat display and recognizer line only), DSH-8, DSH-10, DSH-11; A11Y-1, A11Y-2, A11Y-3, A11Y-5, A11Y-6; OPS-1, OPS-3, OPS-10, OPS-12, OPS-13, OPS-14.

---

## 12. Build order and time estimates

Builder A owns the server and logic; builder B owns the screens. Both work against `web/lib/app/types.ts`. The estimates are honest guesses for people who know the codebase, not promises. If `ps aux | grep "[t]rain_session"` shows Talha's recorder running, `next build` and any browser run wait and are retried every 60 seconds. Every process a builder starts is bound to 127.0.0.1 and killed by its PID afterwards.

### 12.1 Tier 0, the stage MVP (BUILD-NOW)

| Step | Builder | Work | Hours | Done when |
|---|---|---|---|---|
| 0 | A | Spike and cleanup: `allowImportingTsExtensions` in `web/tsconfig.json`; a store module imported from two route chunks shares state on `globalThis`; the sweeper starts once; `request.signal` abort and `ReadableStream` `cancel()` fire on client disconnect under `server.mjs`; cookies on `localhost` and `127.0.0.1` stay separate in Chrome; remove `--lan`, `firstLanIPv4`, `dev:lan` and `start:lan`; `SIGUSR2` re-claim | 0.75 | Notes in the progress log; `tsc`, `test:security` pass |
| 1 | A | Pure modules with `node:test` tests: `vocab.ts` (both tables of `docs/vocabulary.md`), `match.ts` (bars, lights, the app's own gate, multiset, candidates, lone HELP, nearest, merge helper), `validate.ts` (bridge events with refusal counters, actions, names and text with `field`, gloss tokens), `checklist.ts`, `latency.ts`, `theme.ts` with the contrast test | 1.5 | `npm run test:unit` green |
| 2 | B | Theme tokens, `KeyTag`, `TrafficLight` (shape plus word per screen), guest first screen (four choices, Sign card text, read-aloud question, `GUEST_NOTICE` and extras, display-only variant), static staff layout with mock data typed from `types.ts` | 1.25 | Both screens render at 390x844 and 1440x900 |
| 3 | A | `store.ts` (Mode 0 states, profiles, idle, cap, extend, wipe with the canary test, nonces, per-kind limiter, emergency first), `bus.ts` (`globalThis`, guest and staff projections, 2 s ping), routes `/api/events`, `/api/staff/claim`, `/api/staff/action`, `/api/guest/join` (Mode 0 loopback join only), `/api/guest/action`, `/api/guest/leave` (expires `sb_g`, never Clear-Site-Data on this listener); Host and Origin checks per route | 2.0 | A quick reply reaches the `localhost` guest window; End guest wipes both and the staff cookie still works |
| 4 | A | `ingest.ts`: validation, freshness, restart-tolerant replay, framing outside the gate, consent gate, join with the top-1 fallback, the app's own gate, proposal protection with the 10 s grace, the 4 s merge, status, mock and no_model, `signingAvailable`; `/api/guest/signs`; `/api/dev/simulate` with the new buttons' events; `vlm_suggestion` 404; server-level tests for confirm-before-speak and the canary | 1.75 | `live.py --mock --post` and the simulator drive a loopback session; the C1 traps have passing tests |
| 5 | B | Guest conversation: captions (three in memory, "New" marker, Show again, speech note), avatar through `mountAvatar`, `playGloss` and `AvatarCaptions` (per-gloss on loopback, cards fallback), disclaimer and "Show sign names", repair row, live signs without scores, framing text in Sign mode, every proposal state with the new wording, send label from the setting, Fix, name field with reasons, Type with phrases, Interpreter states, "Get staff now" with the 20 s line, "More" menu with "I'm finished" and its dialog, idle and cap warnings, end screen with reasons, display-only rendering, hide and restore, live regions, heartbeat POST | 2.25 | The simulator drives every state on the guest window |
| 6 | B | Staff dashboard: header strip (mode, profile, heartbeat, idle value, cap and Extend, recognizer, framing timer, voice), the fallback band, quick replies, free text with transcript review, P1 hold-to-talk, log with neutral guest lines, Speak name, Read aloud, Speak again, the speak plan through one `AudioContext` and Nath's `/api/tts`, display-only "Guest pointed YES / NO" and "Guest chose ..." buttons, alerts (Help count, interpreter, typed, repair replies) | 2.0 | The demo script runs with the simulator |
| 7 | B | Panels: co-pilot checklist with the note and "needs another try", evidence (text) with the note, latency, privacy with real counters and `PRIVACY_DISK_NOTE`, benchmark "not yet audited", simulator | 1.0 | All panels show live values from a simulated session |
| 8 | Both, Ops | Integration with the real `live.py` on loopback (camera position at the counter, `--waist none` if needed), the accessibility checks of A11Y-2 and A11Y-3, `next build`, the demo script twice in a row in Mode 0 with the stage profile, one fallback drill (stop the recognizer; switch to Phrases); paper props (OPS-1); `docs/security-testing.md` strength labels; ask for a Deaf review (OPS-10) | 1.0 | Two clean runs in a row |

Builder A has about 6 hours and builder B about 6.5 hours, so the wall time with both busy is about 7 hours (steps 0, 1 and 2 run in parallel; 3 and 5 in parallel; 4 and 6 in parallel). That is still a long night. If time runs short, cut inside Tier 0 in this order: "Show again" and the "New" marker; the 4-second merge (say "sign the whole question in one go" instead); the latency panel's median column; "What can I sign?"; the evidence panel's timestamps (keep the light and score); the repair row's checklist link (keep the staff banner). **Never cut:** confirm before speaking, the consent gate, the app's own gate with proposal protection, Help, End guest with the idle wipe and the cap, the staff capability with separate Mode 0 origins, quick replies, phrases (the declared fallback), the simulator, the honest wording, and the privacy and benchmark panels' honesty (better a missing panel than a wrong number).

### 12.1a Builder A status on talha/app-shell (2026-10-11)

The Tier 0 server is built on the local branch `talha/app-shell` (never pushed by this workflow). Logic sits in pure modules with tests; each `route.ts` is a one-line wrapper.

| Piece | Where | Notes |
|---|---|---|
| Store, bus and one sweeper on `globalThis`; config from the environment | `web/lib/app/runtime.ts` | `SB_PROFILE`, `MODE0_GUEST_INPUT`, `IDLE_WIPE_MS`, `SESSION_CAP_MS`, `SB_SIMULATE`, `VLM_FALLBACK`, `BRIDGE_KEY`, `VRI_*`, `EMERGENCY_NOTE`, `BENCHMARK_CLEARED_FILE` |
| Staff capability | `web/lib/app/staffcap.ts`, `web/server.mjs` | One-time `#k=` link printed at start and on `kill -USR2 <pid>`; cookie `sb_staff` (HttpOnly, SameSite=Strict, Path=/; no `__Host-` prefix, because that needs Secure on plain http); a new claim replaces the old cookie |
| Routes | `web/lib/app/routes.ts` | `/api/staff/claim`, `/api/staff/action`, `/api/staff/benchmark`, `/api/events?role=staff\|guest`, `/api/guest/join`, `/api/guest/action`, `/api/guest/leave`, `/api/guest/signs` (POST and GET), `/api/dev/simulate` |
| Host rules | `routes.ts`, `guard.ts` | Staff routes and the P1 and Nath routes: Host `127.0.0.1:PORT`, staff cookie. Mode 0 guest routes: Host `localhost:PORT`, cookie `sb_g`. Bridge: loopback plus `X-Bridge-Key`; any request with an `Origin` is refused, so a browser page cannot post events |
| Help first | `routes.ts` `guestAction` | `emergency` is dispatched before the content-type, origin, nonce, limiter and state checks; it still needs the SameSite=Strict guest cookie |
| Session safety lines (Tier 0 subset) | `store.ts` | Reused code (second device), reused nonce and a confirm for a proposal that is gone (repeated request), per-kind rate (unusual rate), wrong bridge key and duplicate seq (recognizer event), and a guest cookie from a different browser (device changed: refused except Help; a speed bump, plan 10.1) |
| TTS | `web/app/api/tts/route.ts` | Accepts `{ id }` (1 to 20, not NAME) next to `{ text }`; only a fixed table sentence ever goes to ElevenLabs; other text goes to local Piper with `PIPER_FALLBACK=1`, else 500 and the staff page uses an on-device voice; real ElevenLabs requests are counted on the privacy panel; vendor bodies and Piper stderr are never logged |
| Removed | `server.mjs`, `package.json` | `--lan`, `firstLanIPv4`, `dev:lan`, `start:lan` (SRV-2a); `--lan` now exits with an error |
| Tests | `web/lib/app/routes.test.ts`, `store.test.ts`, `web/security-tests/server.test.mjs` | `npm run test:unit` and `npm run test:security` (loopback only) |

Still open from Tier 0 for builder A: nothing blocking. Tier 1 items (TLS guest listener, QR pairing with check code, nonce CSP, sign bundle) are not started.

### 12.2 Tier 1, engagement gate G1 (not tonight, on the isolated loaner)

| Step | Builder | Work | Hours |
|---|---|---|---|
| G1-1 | A | `server.mjs` guest HTTPS listener with fail-closed start-up, listener-decides-role, D6 path list, Host lists, per-address cap (24 guest, 8 other) | 1.5 |
| G1-2 | A, B | Pairing: QR overlay with the vendored encoder, two live codes, check code, `__Host-sb_g`, device binding and pause, Help with a dead cookie, `more_time` | 2.5 |
| G1-3 | A, P2 | `headers.ts`, nonce CSP, header move out of `next.config.ts`; `/signs/bundle` and P2's `preloadSigns`; avatar Report-Only rehearsal | 2.0 |
| G1-4 | A | `tls.test.mjs`, extended `server.test.mjs`, `hygiene.test.mjs` | 1.5 |
| G1-5 | Ops | Event CA, cable, the printed cards, pre-flight scripts, Safari connection count, gate G1 run from the guest side of the cable | 1.5 |

### 12.3 Tier 2

Token rotation with the 30-second grace; the full safety warning set; device health from kiosk devices; the VLM candidate rendering; skeleton drawing; Playwright and axe-core on every guest state; landscape guest layouts; the framing position diagram; a "the desk may be busy" state. About 6 to 8 builder-hours in total.

---

## 13. Demo script mapped to clicks (CLAUDE.md section 9, with LEAVE for checkout)

**Preparation (Mode 0, stage profile).** Put the props on the counter: the "wave or knock" card, the laminated YES / NO / TYPE / INTERPRETER / HELP card, the floor marker, and (with guest input) a mouse or touch display and a USB keyboard on the guest side. Start the app with `npm run build`, then `SB_PROFILE=stage MODE0_GUEST_INPUT=1 npm run start` (leave out `MODE0_GUEST_INPUT` for display-only). Do not project the terminal. Open the printed one-time `http://127.0.0.1:3000/staff#k=...` URL in **Chrome** and press **Start desk**; wait for "Voice: ready". Only then start the recognizer, with the key set without typing it on the command line: `read -s BRIDGE_KEY && export BRIDGE_KEY && python -m recognition.live --camera 0 --post http://127.0.0.1:3000/api/guest/signs` (or read it from a `0600` file). Check that the staff header shows "Recognizer: ok" (never `mock` on stage), "Framing: OK" with the actor standing on the marker, "Vendor keys: none" and "Idle wipe ... (stage: 10 min)". Press **New guest**, then **Open guest window**, and drag the `localhost` window to the wired display. The guest taps **Sign** (display-only: the guest points at SIGN on the card and the receptionist presses "Guest chose Sign").

| # | Staff action (exact click) | Guest screen shows | Guest does | Staff screen shows, laptop does |
|---|---|---|---|---|
| 1 | Quick replies **Welcome!**, then **Reservation?** | "Welcome!" and "Do you have a reservation?" with the avatar and captions | Signs YES RESERVATION; sees both signs light up live, then "Yes, I have a reservation." and taps **Send and read aloud** | Live signs with lights; checklist "Greeting" and "Reservation" turn shared; the laptop speaks the sentence (Piper) |
| 2 | Quick reply **Your name?** | "What's your name?" | Signs NAME; types the name; taps **Send** | "My name is ..." with **Speak name**; the receptionist taps it; a local voice says it; "Guest name" shared |
| 3 | Quick replies **Room 412**, then **Key card** | Captions and avatar | Signs THANK-YOU, **Send**; then WHERE ELEVATOR, **Send** | "Thank you." then "Where is the elevator?" spoken; "Room number" and "Key card" shared |
| 4 | Quick reply **Elevator left** | "The elevator is on your left." | Signs FS-WIFI PASSWORD, **Send** | "What's the Wi-Fi password?"; checklist shows "Wi-Fi: guest asked; not answered yet" |
| 5 | Quick reply **Wi-Fi** | "The Wi-Fi password is on your key card." | Signs BREAKFAST TIME, **Send** | "What time is breakfast?"; "Wi-Fi" shared |
| 6 | Quick reply **Breakfast 7-10** | "Breakfast is from 7 to 10." | Signs MORE TOWEL PLEASE with one sign deliberately weak | That sign shows "low model score" in the evidence panel. The guest sees "Did you mean: 'Could I have more towels, please?'" (the usual case, because the weak sign's own label still matches) or, if two signs were weak, "Sorry, the camera missed that sign..."; for the script the guest taps **No, sign again** |
| 7 | — | "Sorry, the camera missed that sign. Could you sign it again, or type it?" | Repeats MORE TOWEL PLEASE, **Send** | Repeat counter 1; "Could I have more towels, please?" spoken |
| 8 | Quick replies **Towels**, then **Anything else?** | Captions | Signs LEAVE TIME, **Send** | "What time is checkout?" spoken; checklist "Checkout time: guest asked" |
| 9 | Quick reply **Checkout 11** | "Checkout is at 11." | Signs NO THANK-YOU, **Send** | "No, that's all, thank you." spoken; "Checkout time" shared |
| 10 | Quick reply **Enjoy stay** | "Enjoy your stay!" | — | "Farewell" shared; the co-pilot shows "ID checked: not shared yet" as a gentle grey flag; the receptionist taps **I saw it** |
| 11 | A juror types a free sentence in the free-text box (with a P1 key outside the engagement window, **Hold to talk**, review, **Send**) | Captions, plus the avatar via the generic gloss path, or captions only | — | Gloss source shown in the log |
| 12 | Point at the **Latency** and **Privacy** tabs, then press **End guest** | "This conversation has ended. The desk ended the conversation. This page did not save the conversation. Your browser may keep its own history." | — | Log cleared; wipe receipt with the number of erased items; per-guest counters reset; the staff screen is still signed in |

**If the recognizer cannot produce signs.** Decide this before rehearsal, not on stage. If the staff header shows the amber fallback band (`no_model`, `mock`, or silence), the guest's Sign card is already disabled with its reason. The presenter says so plainly and switches to one of two declared paths: (a) the guest taps **Type** and uses the **phrase buttons**, which run the same confirm, echo and speak plan, so steps 1 to 10 still work without recognition; or (b) a **declared simulator rehearsal**, with the "SIMULATED" badge visible on both screens and said out loud ("these signs are simulated because the camera model is not running"). Never let a simulated sign pass as a recognised one.

**If framing stalls.** If the header shows "Framing: STEP_BACK (or MOVE_CAMERA_DOWN) for 10 s", move the actor to the marker and tilt the camera; if the counter hides the hips, restart the recognizer with `--waist none` (the header shows the hint), and say on stage that this is a fallback because the model was trained on head-to-waist takes.

**Rehearsal without the camera** uses the simulator in this order: intents 3, 4, 5, 6, 7, 8, 10 (with "Make one sign weak" on, then off), 11 and 20, with "Shuffle order" on at least once to show that `WHERE ELEVATOR` and `ELEVATOR WHERE` give the same result, "Split utterance" once, "Reach to tap" once to show that a pending proposal survives, "Low HELP" and "Lone HELP" once each to show that HELP always asks before alerting, and "Restart recognizer" once. In Mode 0 display-only we say on stage that the receptionist confirms on the guest's behalf. With guest input we say that both windows run on one laptop for the stage, and that the separate guest device (Mode C) is the engagement setup. We do not show or claim any accuracy figure: the benchmark card says "not yet audited". If no Deaf reviewer has looked at the guest copy and the avatar, we say so.

---

## 14. Contract changes and requests (logged in `docs/requests.md`)

1. Screen sync moves from `BroadcastChannel("signbridge")` (CLAUDE.md 2 and 6.7) to the server SSE bus, because the guest screen is on another device or another origin. `web/lib/channel.ts` becomes a thin client helper around `EventSource` and the action POSTs.
2. The 6.7 messages keep their names and gain fields; the full catalogue is section 7.
3. Guest recognition comes from the desk camera through `recognition/live.py --post` events (section 6.1), not from the browser webcam of CLAUDE.md 7.2 steps 1 to 3.
4. P3 is asked for: the optional `skeleton` field on `sign` events (section 6.2); a random per-process `run` id on every event (C1-11); re-sending the current framing status every few seconds (C1-10); splitting `CENTER` into `CENTER_LEFT` and `CENTER_RIGHT` from the guest's point of view (C2-16); renaming `FS-CHECKOUT` to `LEAVE` in `recognition/labels.py`; final harm-weighted bars from audited calibration; optionally polling `GET /api/guest/signs` for `{accepting}` to switch the camera off; and a benchmark report with `cleared: true` and an audit reference before any figure is shown. Until `run` exists, the app treats a lower `seq` as a restart.
5. CLAUDE.md 7.2 step 4 changes: the app recomputes the gate itself; `needs_repeat` is a hint. Step 5 changes: scripted guest sentences come from the fixed table with order-insensitive matching; `/api/english`'s Claude path is a LATER fallback, labels only, confirmed by the guest.
6. Nath is asked to move `/api/tts` to `{ id }` (RT5). Until then the staff page sends only the fixed sentence text from the server's speak plan. The staff page plays the WAV through its own unlocked `AudioContext` instead of `new Audio()` in `speakSigns.ts`, and `warmUpVoice()` runs before the recognizer starts.
7. P2 is asked, with a deadline before gate G1, to add `preloadSigns(bundle)` to `web/lib/avatar/lookup.ts` and to run one avatar rehearsal under the Report-Only nonce CSP. P2 is also asked whether the `BROWS-UP` / `BROWS-DOWN` markers should be drawn as tokens on the guest screen at all (C2-17); the app hides gloss tags behind "Show sign names" meanwhile.
8. Talha is asked to accept or decline adding `GET /avatar/bellhop.glb` to the D6 guest path list. Until both item 7 and this land, the avatar runs in Mode 0, and Mode C shows captions and cards; the docs and the stage say so.
9. The owner of the AS-23 notice (`compromised_device.md` section 2.4) is asked to change "The Emergency button" to "The Get staff now button", so that the button and the notice use one name (C2-14). The app already uses that text (`GUEST_NOTICE`), and the GST-1 test checks the document text with exactly that substitution.
10. AS-5 (rotate on every reconnect) gets a 30-second grace period and moves to Tier 2; AS-8 applies on every team-owned device and not on a guest's own phone (Mode W scenario S3b); AS-21's "silent `stop_signing` or `prefs`" alert becomes a neutral staff log line plus a confirmation on the guest's own screen. All three are logged for the AS owner.
11. New environment variables for `.env.example`: `SB_PROFILE` (`stage` or `engagement`), `MODE0_GUEST_INPUT`, `BRIDGE_KEY`, `LAN_IP`, `LAN_NET`, `DESK_NAME`, `GUEST_PORT` (3443), `TLS_KEY_FILE`, `TLS_CERT_FILE`, `TLS_PUBLIC_KEY_FILE`, `TLS_PUBLIC_CERT_FILE`, `GUEST_IPS`, `IDLE_WIPE_MS`, `SESSION_CAP_MS`, `PAIR_CODE_TTL_MS`, `SB_SIMULATE`, `VLM_FALLBACK`, `ENGLISH_FALLBACK`, `BENCHMARK_CLEARED_FILE`, `VRI_LABEL`, `VRI_URL`, `VRI_CONTACT_KIND`, `VRI_CONTACT`, `EMERGENCY_NOTE`, `KIOSK`. `GUEST_LAN` is removed. No variable uses the `NEXT_PUBLIC_` prefix.
12. The draft's RT2 (mkcert), RT3 (`?t=` ticket) and RT7 (per-gloss `/signs` with a session) are superseded by decision record D5 and D6, as section 0 records.

## 15. Open questions

1. **Decide now: which Mode 0 does the stage use?** Recommended: Mode 0 with guest input (`SB_PROFILE=stage MODE0_GUEST_INPUT=1`, a mouse or touch display and a keyboard on the guest side), said on stage as a one-laptop compromise. Alternative: display-only Mode 0 exactly as decision record D3, with the laminated card and the receptionist confirming for the guest. A phone or second laptop is Mode C and cannot be shown from this Mac.
2. Does Talha accept `/avatar/bellhop.glb` on the guest listener, or should the guest use the `hologram` style in Mode C?
3. Are the provisional harm-weighted bars (0.75 for YES, NO, NAME, ROOM, HELP) acceptable for the demo, or should they wait for calibration on held-out recordings?
4. Should "ROOM HELP" stay as "There's a problem with my room," or become a neutral phrase? It is a high-severity confusion; the guest confirms it either way.
5. Which VRI provider name and contact (videophone or text) do we show, and what text-to-911 note applies where the demo happens? Until answered, the honest unset text is shown.
6. Is the 15-minute cap right for a check-in, should extensions be unlimited, and should the engagement idle limit be 5 minutes rather than 120 seconds (WCAG 2.2.1, section 9.2)?
7. Will the Mode C guest device be the team iPad (Safari: no Compute Pressure) or a wiped laptop with Chrome?
8. Does step 0 show that `__Host-` cookies work on `http://127.0.0.1` in Chrome?
9. Do we tell the expert testers that full control of the guest device is assumed (compromised_device.md open question)?
10. Can a Deaf ASL user review the guest copy and the avatar tonight, even remotely for 30 minutes?

---

## 16. Critique log (revision 2)

Two reviews read revision 1 on 2026-10-10 at about 21:44. **C1** is the stage-readiness review (21 findings), **C2** the review from the point of view of a Deaf ASL-using guest (27 findings). Each row gives the decision in one line and where it landed.

| ID | Finding (short) | Decision | One line |
|---|---|---|---|
| C1-1 | BUILD-NOW scope (about 22 h) does not fit tonight | Accepted | Tiers added (section 0a); only Tier 0 is `NOW`; every row re-marked; Tier 0 is about 7 h wall time with a cut list (section 12.1) |
| C1-2 | Mode C cannot be rehearsed on this Mac; Mode 0 takes away the guest's taps | Accepted | Stage runs on Mode 0; Talha picks guest input (recommended, stage profile) or display-only (section 15 q1); Mode C stays behind G1 |
| C1-3 | Clear-Site-Data on the shared origin deletes the single-use staff cookie | Accepted | Guest on `localhost`, staff on `127.0.0.1`; staff listener never sends Clear-Site-Data; `SIGUSR2` re-claim (sections 9.6, SES-13, SRV-10) |
| C1-4 | Honouring `needs_repeat` disables "Did you mean" and the picker | Accepted with change | The app recomputes the gate; `needs_repeat` is a log hint only, never decisive, even for unjoined signs, which use their top-1 (section 6.1, BRG-8) |
| C1-5 | The guest's reach to tap becomes a NONE utterance that replaces the proposal | Accepted with change | Pending proposals ignore repeat and NONE-only utterances; 10 s grace; a pending NAME proposal ignores every utterance instead of a focus-based gate pause (section 6.3, SPK-8) |
| C1-6 | Token rotation plus a 5 s watchdog with no guest ping makes the connection fall over | Accepted with change | 2 s SSE ping; AS-5 rotation kept but with a 30 s grace and moved to Tier 2; Tier 0 does not rotate (section 9.4) |
| C1-7 | Staff heartbeat turns red while staff simply talk | Accepted | Guest heartbeat POST every 5 s, rate-limited, never activity (SES-15) |
| C1-8 | 120 s idle wipe ends the demo mid-way | Accepted | Stage profile 10 min, shown in the header; engagement keeps strict values (section 9.2, SES-14) |
| C1-9 | No stage fallback when the recognizer reports `no_model` or `mock` | Accepted | Large staff fallback band; Sign card disabled; declared paths: phrases or a said-aloud simulator rehearsal (sections 4.2, 13, DSH-11) |
| C1-10 | Framing guidance can stall the demo; status unknown after Sign | Accepted | Framing accepted outside the gate and stored; staff timer with the `--waist none` hint; P3 asked to re-send framing; camera position rehearsed (BRG-4, BRG-9, OPS-14) |
| C1-11 | A recognizer restart can silently drop every sign; unjoined utterances | Accepted | Lower `seq` = restart, never dropped; `run` id requested from P3; top-1 fallback (BRG-3, BRG-8) |
| C1-12 | Avatar will not animate on the guest device in Mode C | Accepted | Open question 2 raised; P2 asked for `preloadSigns` with a G1 deadline; docs and stage say Mode C shows cards until then; D6 not bypassed (CAP-4b) |
| C1-13 | Privacy zeros are hard-coded; "files written: 0" is false (Piper temp files) | Accepted | Real counters including refused body-point keys and fixed-sentence TTS count; honest `PRIVACY_DISK_NOTE` replaces "files written" (DSH-5, `types.ts`) |
| C1-14 | Connection cap of 8 starves the real guest device | Accepted | 24 for a `GUEST_IPS` address, 8 for others; Safari count measured before G1 (SRV-9) |
| C1-15 | Help shares the channel and could be limited or 401'd; docs overstate it | Accepted | Emergency dispatched before any limiter; per-session per-kind limiters; dead-cookie Help from `GUEST_IPS` in G1; the card and heartbeat called the independent path (section 9.5) |
| C1-16 | Safari autoplay and Piper warm-up contending with MediaPipe | Accepted | Chrome required; one `AudioContext` unlocked on Start desk; warm-up before `live.py` (DSH-10) |
| C1-17 | QR refresh, split utterances, lone HELP, iPad dimming | Accepted | Two live codes; 4 s merge; lone HELP asks; restore on visible and auto-lock Never (SES-1b, SPK-9, SPK-3, SES-11, OPS-1) |
| C1-18 | Next per-route bundling duplicates store and sweepers; `request.signal` unverified | Accepted | `globalThis` store and sweeper flag; unsubscribe on abort, cancel and failed enqueue; step 0 spike with a `server.mjs` fallback (SRV-19) |
| C1-19 | No QR encoder, Playwright not installed, `.ts` imports need a tsconfig flag | Accepted | Vendored `qrcode-generator` (G1); core controls proved with server-level `node:test`; Playwright Tier 2; `allowImportingTsExtensions` in step 0 (SRV-20, SRV-21) |
| C1-20 | `--lan` scripts still exist; key in shell history; `#k=` on a projected terminal | Accepted | `--lan` removed now; `read -s` or a `0600` file; `replaceState` after claim; terminal never projected (SRV-2a, OPS-12, SRV-10) |
| C1-21 | Some controls presented as stronger than they are | Accepted | Honest strength labels, including "a compromised guest device sees everything shown or typed on it" (section 10.1, OPS-13) |
| C2-1 | Display-only Mode 0 takes control from the guest and still draws dead buttons | Accepted | No tappable controls when `displayOnly`; pointing instructions; laminated card; guest input variant for the stage; weaker confirmation said on stage (GST-15) |
| C2-2 | A phone held in one hand cannot be used while signing two-handed signs | Accepted | Stand at eye level by the camera; first-use line in Sign mode; controls in the bottom third (OPS-1, A11Y-6) |
| C2-3 | "The desk camera reads your hands" overclaims | Accepted with change | Honest Sign card; "What can I sign?"; the 20 requests as phrase buttons inside Type, keeping Talha's four equal choices (GST-10) |
| C2-4 | Percentages and "sure" overclaim | Accepted | Score removed from `GuestSignView`; guest words "clear", "not certain", "missed"; staff "model score (uncalibrated)" (SPK-2) |
| C2-5 | Red "unclear" and "sign that again" blame the guest | Accepted | The system is the subject of every miss; grey outline for missed signs; evidence note (A11Y-5, `REPEAT_TEXT`, `EVIDENCE_NOTE`) |
| C2-6 | Repeated Help flagged as an unusual rate | Accepted | Help never raises a warning; count on the Help banner; unit test with 20 presses (section 6.6, GST-2a) |
| C2-7 | Consent choices shown as security events | Accepted with change | Neutral log lines, never in Safety; the guest's own screen confirms each change; the header shows the mode, which satisfies AS-21 (section 6.6) |
| C2-8 | Staff see things the guest is never told; device health from a guest's own phone | Accepted | `GUEST_NOTICE_EXTRA` says what the desk sees; device health from kiosk devices only (GST-1, GST-6) |
| C2-9 | "I'm finished" ends at once and sits next to Help | Accepted | Confirmation dialog; moved to the "More" menu; Help in its own row (SES-12, A11Y-6) |
| C2-10 | Timing works against the guest (WCAG 2.2.1) | Accepted with change | Guest sees idle and cap warnings now; "I need more time" in G1; stage 10 min; the 5-minute engagement limit is left to the AS owner as open question 6 (section 9.2) |
| C2-11 | No way to say "please repeat" or "I don't understand" | Accepted | Tap-only repair row, shown to staff, linked to the checklist (GST-11) |
| C2-12 | Only the latest staff sentence survives | Accepted with change | The page keeps three in memory with a "New" marker and "Show again"; the reconnect snapshot keeps only the last one, because AS-1 says so (GST-12) |
| C2-13 | Staff speech goes to the guest unchecked; speech captions unmarked | Accepted | Transcript lands in the free-text box for review; speech captions marked (CAP-2, CAP-6) |
| C2-14 | Help named differently from the notice; alarm for any question | Accepted | One name, "Get staff now"; AS-23 wording change requested; staff alert "Guest wants staff at the desk now"; 911 note separate; 20 s no-reply line (GST-2a, section 14 item 9) |
| C2-15 | Interpreter choice has nothing defined behind it | Accepted | Honest unset text; contact labelled by kind; guest copy per state; staff script for "I'm on it" (GST-3) |
| C2-16 | Framing text refers to a picture the guest cannot see | Accepted with change | Wording rewritten without "the picture"; floor marker now; `CENTER_LEFT/RIGHT` requested from P3; position diagram Tier 2 (GST-4a, GST-4b) |
| C2-17 | Gloss on screen unexplained; avatar not disclosed; no Deaf review | Accepted | Disclaimer under the avatar; gloss behind "Show sign names" with a key; P2 asked about markers; Deaf review asked for tonight, else said on stage (GST-17, OPS-10) |
| C2-18 | End screen gives no reason and overclaims | Accepted | Reason per `END_REASON_GUEST`; honest storage sentence; unsent-message line (GST-13) |
| C2-19 | Several colours fail WCAG AA on navy | Accepted | Per-surface tokens (computed ratios in section 4.1); navy on brass; contrast unit test (A11Y-1) |
| C2-20 | Caption size in viewport units; no landscape layout | Accepted with change | New `clamp()` now; landscape layouts Tier 2 because the stage display is landscape 1440x900 already (A11Y-2, A11Y-4) |
| C2-21 | Only captions are a live region; focus may be stolen | Accepted | Polite and assertive regions, focus rule, `aria-hidden` canvas; axe-core Tier 2 (A11Y-3, A11Y-4) |
| C2-22 | "Say it" wrong when read-aloud is off; Text only mixes two settings | Accepted | Label follows the setting; "Show avatar" and "Read aloud" split; read-aloud asked on the first screen (SPK-7) |
| C2-23 | Sign offered when the recognizer cannot work | Accepted | `signingAvailable` on hello, snapshot and its own event (GST-16) |
| C2-24 | Pairing asks the guest to check a screen they cannot see | Accepted | The check is staff's job; the guest page says the desk is connecting it (section 4.3, SES-3) |
| C2-25 | Autocorrect off everywhere; no reason when input fails | Accepted with change | AS-8 attributes on every team-owned device (all of Mode 0 and Mode C); platform defaults only on a guest's own phone (Mode W S3b, LATER); reasons shown next to fields (SES-11, SPK-6) |
| C2-26 | "Shared" may be misread as understood | Accepted | Fixed note on the panel; "needs another try" after a repair reply; staff actions only (DSH-2) |
| C2-27 | Hiding on visibility change has no restore | Accepted | Restore from memory or snapshot when visible; manual test now, Playwright in Tier 2 (SES-11) |

No finding was rejected outright. Where a finding conflicted with an engagement requirement (AS-1, AS-5, AS-8, AS-16, AS-21, AS-23, D3, D6), the requirement was kept and the finding was met another way; each such change is in section 14 for the AS owner.
