# SignBridge app plan (P4, branch p4-app): the build plan for this build

This is the plan two builders follow to turn the placeholder `/staff` and `/guest` pages into the working app. It replaces the earlier draft (pushed as `89e0bdf`) and folds in everything that has been decided since: the red-team requirements RT1 to RT14, the compromised-device requirements AS-1 to AS-26, the engagement decision record D1 to D11, the TLS and pairing controls LT-01 to LT-31, the "build today" items from the slide work, and the product features Talha asked for. The shared types for both builders are in `web/lib/app/types.ts`, which was rewritten together with this plan.

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

## 1. Goals and non-goals

### Goals

The app has to carry the CLAUDE.md section 9 demo end to end. The receptionist works on the laptop at `http://127.0.0.1:3000/staff`. The guest follows the conversation on a second screen: a wired second display in Mode 0, or a team-owned iPad, phone or wiped laptop joined by one Ethernet cable in Mode C. A desk camera on the laptop feeds Python MediaPipe and P3's classifier, and `recognition/live.py --post` sends recognised signs to the app over loopback. The guest device only displays the conversation and takes taps and typing. It never uses a camera or a microphone, and no video ever leaves the laptop.

The scripted path must work with no cloud service at all. Every one of the 20 receptionist sentences can be sent with one tap, every one of the 20 guest requests is matched from a fixed table, and guest sentences are voiced by Piper or by an on-device browser voice. Speech-to-text, ElevenLabs and Claude are improvements on top of that path, never requirements for it, and during the security engagement window no vendor key is present on the laptop at all.

The guest stays in control. Every recognised sign is shown to the guest as a word with a traffic-light confidence, and nothing is spoken at the desk until the guest taps "Say it". The guest's first screen offers Sign, Type, Ask for a human interpreter and Text only as equal choices, and the Help button stays visible on every guest screen.

The receptionist gets a co-pilot. The staff screen shows which standard check-in items have actually reached the guest, flags the ones that have not with gentle wording, and shows the evidence behind every recognised sign: its confidence, its timestamps and a skeleton snapshot, never video.

The security and privacy claims must be real and testable. Staff functions are reachable only from the laptop itself with a staff capability. Guest functions are reachable only with a valid, expiring, single-device cookie over HTTPS. There are no secrets in the browser, nothing is written to disk, nothing about what people said is logged, and the privacy and latency panels show numbers that come from real counters and real timestamps.

### Non-goals

The app does not handle video. There is no `<video>` element, no `getUserMedia` call and no camera or microphone permission anywhere in the guest page; the desk camera belongs to P3's Python process, and the staff page uses only the microphone for P1's hold-to-talk. The app does not run sign recognition or train models, and it does not render the avatar itself; it consumes P3's bridge events and P2's `mountAvatar`/`playGloss`. It persists nothing: there is no database, no file and no browser storage of conversation content. It supports one guest at a time at one desk, with no user accounts. It does not translate free signing; recognition is the closed vocabulary of 21 signs plus `NONE`. It does not detect spyware and never claims to; the device-health hint is a load indicator only. The local vision-model fallback is a reserved slot and a disabled UI in this build, not a working feature. The pager panel is a mock, built only if time remains.

---

## 2. Deployment modes, devices and listeners

### 2.1 The three modes (decision record D3)

The rule is that nothing listens off loopback over plain HTTP, ever. There is no switch that allows it.

| Mode | Guest device | Network | Guest listener | When it is used |
|---|---|---|---|---|
| **Mode 0, display only** | A second browser window on a **wired** second display (HDMI or USB-C, never AirPlay or Sidecar) attached to the demo laptop | None. Wi-Fi and Bluetooth off | None. The guest window uses the loopback listener | Always available. It is the fallback whenever a gate fails, and what runs if anything goes wrong. It is a degraded mode: the guest reads the proposal and nods or points, and the receptionist presses "Say it for the guest" on the staff screen. The documents and the staff screen say so |
| **Mode C, cable** (default for the attack window, if gate G1 passes) | A team-owned iPad (USB-C Ethernet adapter), a team phone with an adapter, or a wiped team laptop | One Ethernet cable, laptop `10.77.0.1/30`, guest `10.77.0.2/30`. Wi-Fi and Bluetooth off on both | HTTPS on `10.77.0.1:3443`, TLS 1.3, event CA certificate | The normal demo with a separate guest device |
| **Mode W, Wi-Fi** | Team guest device, plus testers' own phones only in scenario S3b | Team-owned travel router with two networks, WPA3-SAE, PMF required, client isolation (decision record D3) | HTTPS on `192.168.8.10:3443` | Only as an announced, separate scenario, and only if gate G2 passes by T minus 1 day |

The iPhone Personal Hotspot is rejected for every mode, and tunnels such as ngrok are never allowed. Talha's development Mac never runs the demo during the engagement and is never joined to the event network (D1, D2); the system under test is a wiped, unmanaged Apple-silicon loaner.

### 2.2 One process, two listeners

```
 DEMO LAPTOP (loaner, standard user)                                           GUEST DEVICE (Mode C/W)
 ┌──────────────────────────────────────────────────────────────────────┐      ┌──────────────────────┐
 │ Desk camera ─► recognition/live.py (P3, Python MediaPipe, local)      │      │ /guest (HTTPS only)  │
 │                 │ POST /api/guest/signs, X-Bridge-Key, events only    │      │ captions, avatar,    │
 │                 ▼ (no video, no landmarks except the opt-in skeleton) │      │ live signs, Say it / │
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

The guest listener starts only when `npm run start:guest-tls` is used. It refuses to start unless `LAN_IP` is set explicitly, lies inside `LAN_NET`, and `TLS_KEY_FILE` and `TLS_CERT_FILE` exist; there is no automatic address choice and no plain-HTTP fallback. Today's `--lan` plain-HTTP listener on `LAN_IP:3000` and its `firstLanIPv4()` fallback are removed in build step 4. Development mode (`npm run dev`) is never reachable from a network: it has the staff listener only. Builders test the guest layout on loopback in a 390x844 browser window; real-device tests happen on the isolated test machine (`docs/security-testing.md`).

| Script | Listeners | Use |
|---|---|---|
| `npm run dev` | Staff 127.0.0.1:3000, development | Building |
| `npm run build` then `npm run start` | Staff 127.0.0.1:3000, production | Mode 0 demo |
| `npm run build` then `npm run start:guest-tls` | Staff 127.0.0.1:3000 plus guest `LAN_IP:3443` HTTPS, production | Mode C and Mode W |
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
| Nath (P4 teammate) | `POST /api/tts`: `{ text }` (one plain sentence, at most 300 characters) -> `audio/wav`; ElevenLabs if a key is set, otherwise Piper; only the 19 fixed guest sentences are cached | Voicing a confirmed **fixed** guest sentence. The staff browser only ever sends the fixed table sentence that the server put in the speak plan; names and typed text never go to this route. RT5 asks Nath to accept `{ id }` instead |
| Nath | `POST /api/english`: `{ signs: Prediction[] }` -> `{ text }`; fixed table first, Claude for other sequences | Not on the scripted path. The app matches intents itself (order-insensitive, which `/api/english` is not). The Claude path is the LATER `ENGLISH_FALLBACK` item |
| Nath | `web/components/speakSigns.ts` `warmUpVoice()` | Called once by the staff page after "Start desk", so Piper pre-generates the fixed sentences before the guest arrives |
| P3 (Talha) | `recognition/live.py --post http://127.0.0.1:3000/api/guest/signs`, header `X-Bridge-Key` (at least 32 characters), events `sign`, `utterance`, `framing`, `status`, each with `t_sent` | The only source of recognised signs (section 6) |

---

## 4. Screen-by-screen specification

### 4.1 Design direction

The visual idea stays the hotel lobby directory board: deep navy and white with brass key-tag details. Every gloss word, whether in a caption's sign cards, the live sign strip or a proposal, is drawn as a brass hotel key tag with a punched hole and the word in capitals. The typeface is the system font stack only (`system-ui, -apple-system, "Segoe UI", sans-serif`), because AS-24 asks for system fonts and the nonce CSP has no font host. Guest captions use `clamp(2rem, 7vw, 4rem)`; guest buttons are at least 64 px tall.

| Token | Value | Use |
|---|---|---|
| `--navy` | `#0E2A47` | Guest background, staff headers |
| `--white` | `#FFFFFF` | Guest text (about 14:1 on navy) |
| `--brass` | `#E2B33C` | "Say it", key tags, threshold line |
| `--ink` / `--paper` / `--rule` | `#142235` / `#FFFFFF` / `#D5DCE5` | Staff text, background, dividers |
| `--go` / `--wait` / `--stop` | `#2E7D32` / `#B26A00` / `#B3261E` | Traffic lights, always with a word ("sure", "fairly sure", "unclear") and a shape (filled, half, hollow) |
| `--alarm` | `#B3261E` | Help alerts only, always with an icon and words |

Information is never carried by colour or sound alone. Copy is plain English in sentence case. `prefers-reduced-motion` turns flashing banners into solid ones.

**Traffic light.** Each recognised sign gets one light from its top-1 confidence and its label's bar (section 6.3): **green "sure"** at 0.8 or above; **amber "fairly sure"** from the label's bar up to 0.8; **red "unclear"** below the label's bar, for `NONE`, or when framing rejected the sign. The light is drawn as a filled, half-filled or hollow circle next to the word, with the percentage.

### 4.2 Staff dashboard (`/staff`, laptop 1440x900, staff listener only)

The staff screen is laptop-only; there is no phone layout for staff. Before anything else it shows one "Start desk" button. Pressing it is the user gesture that unlocks audio, claims the staff capability if the page was opened from the one-time `#k=` URL (section 9.6), opens the staff event stream and calls `warmUpVoice()`.

```
+------------------------------------------------------------------------------------------------------------------+
| SignBridge  front-desk communication aid   [MODE C: cable + HTTPS]                                 [ End guest ] |
| Guest device: iPad, Safari  10.77.0.2   Paired with 960 792   Heard 2 s ago (o)   Streams 1   Idle wipe 1:42      |
| Session ends in 12:10 [Extend 5 min]   Recognizer: ok, 27 fps   Safety: no warnings   Vendor keys: none (offline)  |
+------------------------------+-------------------------------------------------+---------------------------------+
| TALK TO THE GUEST            | CONVERSATION (memory only, wiped at End guest)  | CHECK-IN CO-PILOT               |
| [      Hold to talk      ]   | 10:02 You    Welcome!                           | (*) Greeting       shared 10:02 |
| Speech-to-text is off        |              [HELLO][WELCOME]  shown on device  | (*) Reservation    shared 10:02 |
| (no vendor key)              | 10:02 You    Do you have a reservation?         | (*) Guest name     shared 10:03 |
|                              | 10:02 Guest  Yes, I have a reservation.          | ( ) ID checked  not shared yet  |
| This text will appear on the |              YES (*).94  RESERVATION (*).88 said |                       [I saw it]|
| guest's device:              | 10:03 Guest  My name is Ana Maria.               | (*) Room number    shared 10:04 |
| [___________________] [Send] |              [Speak name]   not spoken yet       | (*) Key card       shared 10:04 |
|                              | 10:04 You    You're in room 412.                 | (!) Wi-Fi  guest asked 10:05;   |
| QUICK REPLIES                | ...                                              |            not answered yet     |
| [Welcome!]  [Reservation?]   |                                                  | ( ) Breakfast   not shared yet  |
| [Your name?] [See your ID?]  | LIVE SIGNS   MORE (*).91  TOWEL (/).72  PLEASE  | ( ) Checkout    not shared yet  |
| [Nights?]   [Room 412]       |              ( ).41 unclear                     | ( ) Anything else? not asked    |
| [Key card]  [Elevator left]  +-------------------------------------------------+ ( ) Farewell    not shared yet  |
| [Breakfast 7-10] [Wi-Fi]     | GUEST SAYS (40 px)                              |                                 |
| [Checkout 11] [Late checkout]| "Could I have more towels, please?"             | Gentle reminders only; nothing  |
| [Towels] [Parking] [Restaur.]| confirmed by guest 10:06   [Speak again]        | here blocks the conversation.   |
| [Taxi] [One moment] [Repeat?]|                                                 |                                 |
| [Anything else?] [Enjoy stay]|                                                 |                                 |
+------------------------------+-------------------------------------------------+---------------------------------+
| [Evidence] [Latency] [Privacy] [Safety] [Benchmark] [Device] [Simulator*]          (* only when SB_SIMULATE=1)    |
| EVIDENCE  #7 TOWEL (/) fairly sure .72   moved 10:06:01.20-01.95   predicted +0.55 s   alternatives MORE .19, NONE .05 |
|           +-------+   #6 MORE (*) sure .91 ...                                                                      |
|           | o  o  |   skeleton snapshot (shoulders, arms, hands; no face; not video)                                |
|           |  /|\  |                                                                                                  |
+------------------------------------------------------------------------------------------------------------------+
```

**Header strip.** It shows the deployment mode badge, the paired device as a parsed class and its address (never the raw User-Agent), the pairing state and check code once confirmed, the guest heartbeat ("Heard 2 s ago", amber after 20 s, red after 45 s), the number of guest streams, the idle-wipe countdown, the time left before the 15-minute cap with "Extend 5 min" during its last 2 minutes, the recognizer state (`ok`, `mock`, `no_model` or `down`) and frame rate, the count of open safety warnings, whether vendor keys are configured, and the End guest button. With no session it shows a large "New guest" button instead.

**Left column.** Hold-to-talk with a note saying where speech goes, the free-text box labelled "This text will appear on the guest's device" (AS-26), and the 20 quick replies for `docs/vocabulary.md` section 1. Staff are briefed never to say or type the Wi-Fi password, card numbers or another guest's details while the guest can read them (RT13).

**Middle column.** The conversation log, newest at the bottom, in memory only. Staff lines show the text, the gloss as small key tags, and whether the guest device has shown it ("shown on device" after its render acknowledgement). Guest lines show the confirmed sentence, each sign with its traffic light, and whether it was said aloud. A guest NAME line shows "Speak name" and "not spoken yet" until staff tap it; a typed guest message shows "Read aloud". Under the log, the live sign strip shows each sign the moment it is recognised, and the latest confirmed guest sentence is shown at 40 px with "Speak again". In Mode 0 a pending proposal also appears here with "Say it for the guest" and "The guest said no", labelled "Mode 0: confirm with the guest by looking at them".

**Right column: the check-in co-pilot.** Thirteen standard check-in items (`CHECKIN_ITEMS` in `types.ts`): greeting, reservation, guest name, ID check, number of nights, room number, key card, elevator, Wi-Fi, breakfast, checkout time, anything else, farewell. An item is **shared** (filled circle, time) only when a staff line carrying one of its intents was rendered on the guest device, which the device acknowledges; **sent** (half circle) when it was sent but not yet acknowledged; and **not shared yet** (hollow circle, grey text) otherwise. When the guest asks about an item (for example `FS-WIFI PASSWORD`) before it was shared, the item shows "(!) guest asked 10:05; not answered yet". The ID check has an "I saw it" button because it happens on paper. The wording is gentle on purpose, and nothing in the checklist blocks or nags; it is a reminder, inspired by ProtoCopilot's per-step review.

**Bottom panel tabs.**

| Tab | What it shows | Source of every number |
|---|---|---|
| Evidence | For each recognised sign of this guest: number, label, traffic light, percentage, movement start and end time, delay to prediction, top-3 alternatives, and the skeleton snapshot drawn as dots and lines (shoulders, arms, hands; no face). Without a snapshot: "No skeleton snapshot from this recognizer build" | Bridge `sign` events (section 6) |
| Latency | Per stage, the last value, the median and the count: movement end to prediction; prediction to the app; the app to the guest screen (round trip, "reported by the guest device"); utterance end to proposal on screen; "Say it" to speech starting at the desk. A stage with no data shows "no data yet" | Bridge timestamps, server receive times, guest acknowledgements (values outside 0 to 10 s dropped), staff-browser speech-start reports |
| Privacy | For this guest and since start: vendor calls by destination with bytes (or "no vendor keys configured: 0 by construction"); guest-derived bytes off the laptop; messages relayed to the guest device; bridge events received ("labels and timestamps only"); skeleton snapshots held in memory now; face points received (always 0: the validator refuses them); video frames received by the app (always 0: no route accepts video); files written (always 0, checked by the hygiene test); time and reason of the last wipe and how many items it erased | Real counters in the server store |
| Safety | Server-side hijack and abuse warnings (section 6.6) with gentle wording and the staff response card: "Go to the guest in person first. Then press End guest. If the guest is still there, start again with New guest and check the new number with them." | Server store |
| Benchmark | "Accuracy figures: not yet audited." Only a report file marked `cleared: true` with an audit reference may replace that text, and then only with the fields it contains | `BENCHMARK_CLEARED_FILE`, never computed |
| Device | The guest device's own load state where its browser supports the Compute Pressure API ("normal", "busy", "very busy", "overloaded", "reported by the guest device"), with "This only reflects how busy the device is. It is not a security check." Where unsupported: "Not available on this browser." The same for the staff laptop | `PressureObserver` reports |
| Simulator | Rehearsal without the camera (section 6.7). Only when `SB_SIMULATE=1` | — |

**Alerts.** Help from the guest takes over the top of the screen with a full-width red banner, "Guest needs staff now", a repeating tone and "I'm coming" (which sends `staff_ack` to the guest); repeated presses raise a count ("Help pressed 3 times") on the same banner. An interpreter request shows a navy banner with the VRI details and "I'm on it". A typed guest message shows a brass banner with the text and "Read aloud".

### 4.3 Pairing (Mode C and Mode W)

```
 STAFF 1440x900, full-screen overlay after "Guest is here"     GUEST PHONE 390x844 after joining
+------------------------------------------------------------+ +----------------------------+
|                                                            | | SignBridge · front desk    |
|            Open this on the guest device                   | |                            |
|                                                            | | Show this number to the    |
|                 +----------------------+                   | | receptionist:              |
|                 |                      |                   | |                            |
|                 |   QR 320 px          |                   | |      960 792               |
|                 |   (drawn as rects)   |                   | |                            |
|                 |                      |                   | | Waiting for the desk to    |
|                 +----------------------+                   | | confirm.                   |
|   https://10.77.0.1:3443/guest#p=....   new code in 0:48   | |                            |
|                                                            | | [ Help: get staff now ]    |
|   Nothing else is shown while this code is on screen.      | +----------------------------+
|   [ Cancel ]                                               |
+------------------------------------------------------------+

 STAFF after a device joins (overlay replaced)                  GUEST LAPTOP 1440x900 after joining
+------------------------------------------------------------+ +--------------------------------------------------+
| A device joined: iPad, Safari, 10.77.0.2                   | | Show this number to the receptionist: 960 792    |
| Check it is the device in the guest's hand.                | | Waiting for the desk to confirm.                 |
| Type the number shown on it:  [ _ _ _  _ _ _ ]  [Confirm]  | |                         [ Help: get staff now ]  |
| 3 tries. "That is not the number on the guest's screen."   | +--------------------------------------------------+
+------------------------------------------------------------+
```

The protocol follows `lan_tls_pairing.md` section 3.1 and decision record D6:

1. Staff press "New guest". The server ends any old session and creates a session in state `WAITING_FOR_GUEST`. No code exists yet.
2. When the guest is at the desk, staff press "Guest is here". The server creates a 128-bit pairing code, valid for 120 seconds, and the staff screen shows the QR code for `https://<LAN_IP>:3443/guest#p=<code>` as a full-screen overlay with nothing else visible. While waiting, the staff page asks for a fresh code every 60 seconds. In Mode C and Mode W with the team device, staff open the link on the device themselves; guests never scan anything in the default modes.
3. The guest page reads the code from the fragment and removes it from the address bar with `history.replaceState` before any network request, then posts it to `/api/guest/join`.
4. The server checks the source address against `GUEST_IPS` first (403, and the code is **not** burned), then the code in constant time against its stored SHA-256, then counts a failure against that address (5 a minute). A valid code is never refused by a rate limit and there is no server-wide ceiling. On success it burns the code, sets the `__Host-sb_g` cookie, records the device binding (address plus a hash of the User-Agent, and a parsed device class for display), creates a random 6-digit check code, and returns it to the guest page only. The session is now `PAIRED_UNCONFIRMED`, and the staff overlay closes.
5. Staff look at the device in the guest's hand, check that it is the device the staff screen names, and type the 6 digits. A wrong number shows "That is not the number on the guest's screen" and leaves two more tries; the third wrong number ends the session with reason `pair_failed`.
6. On a match the session becomes `ACTIVE`. Both screens show "Paired with 960 792", and the guest page says "Connected. The front-desk screen now shows 960 792. If it shows a different number, stop and tell the staff."
7. Until step 6, the guest device may only send `emergency`, and every staff caption is refused with 409, so a device that wins a race for the code learns nothing.

**Mode 0.** Staff press "New guest", then "Open guest window". The staff page opens `/guest#p=<code>` in a new window, which staff drag to the wired display. The join arrives on the loopback listener from the laptop itself, so it is confirmed without a check code and the staff header shows "Guest window on this laptop (Mode 0)". The Mode 0 guest window is display-only (the guest has no keyboard or touch on it), so its proposal panel says "Nod or point if this is right", and the receptionist confirms on the staff screen.

### 4.4 Guest first screen (`/guest`, phone 390x844 and laptop 1440x900)

```
 PHONE 390x844                              LAPTOP 1440x900
+----------------------------+             +-------------------------------------------------------------------+
| SignBridge · front desk    |             | SignBridge front desk                      [ Help: get staff now ] |
|                            |             |                                                                   |
| How would you like to talk |             |  How would you like to talk with the front desk?                  |
| with the front desk?       |             |                                                                   |
| +------------------------+ |             |  +--------------+ +--------------+ +--------------+ +-----------+ |
| | Sign                   | |             |  | Sign         | | Type         | | Ask for a    | | Text only | |
| | The desk camera reads  | |             |  | The desk     | | Your words   | | human        | | Read the  | |
| | your hands             | |             |  | camera reads | | appear on    | | interpreter  | | desk's    | |
| +------------------------+ |             |  | your hands   | | the staff    | | by video     | | words; no |
| | Type                   | |             |  |              | | screen       | | relay        | | avatar,   | |
| +------------------------+ |             |  +--------------+ +--------------+ +--------------+ | no voice  | |
| | Ask for a human        | |             |                                                     +-----------+ |
| | interpreter            | |             |  About this screen                                                |
| +------------------------+ |             |  This page shows only this conversation. It stores nothing about  |
| | Text only              | |             |  the conversation on your device, though your browser may keep    |
| +------------------------+ |             |  the page address in its history. The conversation ends when the  |
| About this screen  >       |             |  desk taps End, or after 15 minutes. We will never ask you for a   |
|----------------------------|             |  password, card number or ID on this screen. The Help button is    |
| [ Help: get staff now ]    |             |  not the only way to get help: you can always wave to the staff.   |
+----------------------------+             |  If you think your phone may be monitored, please use the hotel   |
                                           |  tablet. Video stays on the desk laptop; nothing is spoken until  |
                                           |  you tap "Say it".                                                |
                                           +-------------------------------------------------------------------+
```

The four choices are equal in size and order. The notice text is exactly the one in `compromised_device.md` section 2.4 (AS-23), followed by two sentences about video and confirmation. No input on any guest screen ever asks for a password, card number or ID.

- **Sign** sends `guest_choice: sign`. Only after this does the server accept recognizer events for the session (consent gate), and `GET /api/guest/signs` answers `{accepting: true}`.
- **Type** opens the text field (`autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"`, AS-8).
- **Ask for a human interpreter** alerts staff and shows the configured VRI name and phone number. A link is shown only when the device is not a kiosk (`hello.kiosk` is false, AS-25), with the note "A video relay call sends your video to that provider."
- **Text only** shows the desk's words as captions without the avatar, and the guest's confirmed sentences appear as text at the desk without being spoken. The guest can change mode at any time from the bottom bar.

Without a valid code or cookie, the page shows only "Ask the front desk to connect this screen."

### 4.5 Guest conversation screen

```
 PHONE 390x844                              LAPTOP 1440x900
+----------------------------+             +----------------------------------+--------------------------------+
| Front desk said            |             | Front desk said                  | You                            |
| The elevator is on         |             | The elevator is on your left.    | Signing is on. Stand so your   |
| your left.  (aria-live)    |             | (aria-live, largest text)        | head and waist are in the      |
| +------------------------+ |             | +------------------------------+ | picture.          [Stop]       |
| |   avatar (P2) or       | |             | |                              | |                                |
| |   sign cards           | |             | |   avatar (P2) or sign cards  | | Signs we saw                   |
| +------------------------+ |             | |                              | | [WHERE] (*) sure 92%           |
| [ELEVATOR][THERE][LEFT]    |             | +------------------------------+ | [ELEVATOR] (/) fairly sure 71% |
|----------------------------|             | [ELEVATOR] [THERE] [LEFT]        |                                |
| Signs we saw               |             | Words in capitals are sign names.| "Where is the elevator?"       |
| [WHERE] (*) sure 92%       |             |                                  | [    Say it    ] [   Fix   ]   |
| [ELEVATOR] (/) 71%         |             |                                  |                                |
| "Where is the elevator?"   |             |                                  | [x] Read my sentences aloud    |
| [  Say it  ] [   Fix   ]   |             |                                  |     at the desk                |
|----------------------------|             |                                  |                                |
| [Type][Sign][Interpreter]  |             | [Type] [Interpreter] [Text only] | [ Help: get staff now ]        |
| [ Help: get staff now ]    |             | [I'm finished]                   |                                |
+----------------------------+             +----------------------------------+--------------------------------+
```

Captions come first: the latest staff sentence is the largest text on the page, inside an `aria-live="polite"` region, with `AvatarCaptions` below it and the avatar (or text sign cards) in a container passed to `mountAvatar`. Older staff sentences are not kept on the device beyond the last few in memory (AS-1).

The guest panel changes with the state of the conversation:

| State | What the guest sees | Buttons |
|---|---|---|
| Signing, waiting | "Signing is on" plus the framing message while framing is not OK (section 6.4) | Stop |
| Live signs | Each sign appears as a key tag with its traffic light the moment it is recognised | — |
| **Proposal** (every sign at or above its bar, signs match one request) | The signs with lights, then the sentence in quotes | **Say it**, **Fix** (Fix opens Sign again, Type instead, Ask for an interpreter) |
| **Proposal for NAME** | "My name is ..." with a field "Type your name" | Say it (enabled when the name passes the sanitizer). The name then appears on the staff screen, and is spoken only after staff tap "Speak name" |
| **Did you mean...?** (one sign below its bar, and exactly one replacement from its top 3 matches a request) | "Did you mean: 'Could I have more towels, please?'" | **Yes**, **No, sign again**, Type instead |
| **Did you mean HELP?** (a HELP sign below its bar) | "Did you mean HELP? Staff will come to you." | **Yes, get staff**, **No**. HELP below its bar never sends an alert on its own |
| **Pick one** (two or three possible requests) | "Which one did you mean?" and up to three sentences as large buttons | Each sentence, then **None of these: Type / Sign again / Interpreter** |
| **Not a request we know** (signs clear, no match) | "We saw: TAXI WHERE. That doesn't match a request we know." plus up to three nearest requests | Each nearest request, None of these |
| **Please sign that again** (`NONE`, framing rejection, or no candidate) | Which sign was unclear, and the framing hint if framing caused it. After three repeats in a row "Type instead" becomes the primary button | Sign again, Type instead |
| Sent | "Sent to the front desk" and "Read aloud at the desk" or "Shown as text at the desk" | — |
| Test mode | When the recognizer reports `mock`: "Test mode: these signs were invented by a test program and will not be spoken." | Say it disabled |

The bottom bar always holds Type, Sign or Stop, Interpreter, Text only, "I'm finished" and the Help button. Help shows "Staff has been alerted", then "Staff is coming" when staff acknowledge, plus the configured text-to-911 note. There is no sound on the guest device and nothing depends on hearing. On `pagehide` or when the page becomes hidden, the conversation is replaced by a neutral screen (AS-7).

**Device health.** Where `PressureObserver` exists (Chromium in a secure context), the guest page reports changes of the `cpu` pressure state to the server at most once every 10 seconds. The guest screen shows nothing about it. Safari has no Compute Pressure API, so on the team iPad the staff Device tab says "Not available on this browser".

### 4.6 Session end

```
 PHONE 390x844                              LAPTOP 1440x900
+----------------------------+             +-------------------------------------------------------------------+
|                            |             |                                                                   |
| This conversation has      |             |   This conversation has ended. Nothing about it was saved on      |
| ended.                     |             |   this device.                                                    |
|                            |             |                                                                   |
| Nothing about it was saved |             |   If you need anything else, wave to the front desk.              |
| on this device.            |             |                                                                   |
|                            |             +-------------------------------------------------------------------+
| If you need anything else, |
| wave to the front desk.    |              STAFF (header strip and log after End guest)
+----------------------------+             | No guest.  Last wipe 10:12:40, reason: End guest, 31 items erased. |
                                           | [ New guest ]                                                      |
```

On `session_end` the guest page clears its state, calls `POST /api/guest/leave` (which answers with `Clear-Site-Data: "cache", "cookies", "storage"` and an expired cookie), and replaces its history entry with the ended screen so Back cannot show the conversation (AS-6, AS-7). The staff screen clears the log and the per-guest counters and keeps only the wipe receipt. A guest who taps "I'm finished" ends the session the same way, with reason `guest_left`, and staff see "The guest ended the conversation".

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
| `sign` | `seq`, `top` (top 3, best first), `t_sign_start`, `t_sign_end`, `t_closed`, `t_predicted`, `t_sent`, optional `skeleton` (requested, section 6.2) | Stores it under `seq` for this session; sends `live_sign` (top-1 and light) to the guest and the full detail to staff |
| `utterance` | `signs` (top-1 of each, 1 to 8), `seqs`, `needs_repeat`, `t_end`, `t_sent` | Joins each sign with its stored `sign` event to get the top 3 and times; runs the app's own gate; the result is a repeat when either the app's gate or `needs_repeat` says so; then matches and builds the proposal (section 6.3) |
| `framing` | `status`, `since`, optional `rejected_seq`, `t_sent` | Shows the guidance on the guest screen and the staff screen; with `rejected_seq`, marks that sign red ("framing") |
| `status` | `fps`, `recognizer` (`ok`, `mock`, `no_model`), `t`, `t_sent` | Updates the staff header; in `mock` every later proposal is a test-mode proposal that is never spoken |
| `vlm_suggestion` (reserved) | — | Ignored with 404 unless `VLM_FALLBACK=1` (section 6.8) |

**Validation.** The body is at most 8 KB. `type` must be one of the known types; unknown keys are ignored, as the README asks, but every known key is checked strictly. Labels must be one of the 22 labels exactly, after the alias map (`FS-CHECKOUT` -> `LEAVE`). Each `conf` is a finite number in [0, 1]. `top` has 1 to 5 entries and is re-sorted on the server. An utterance has 1 to 8 signs and as many `seqs`. Any `face`, `frames`, `pose` or `video` key is refused with 400, so nothing but the optional skeleton can ever carry body points.

**Freshness and replay.** An event whose `t_sent` is more than 5 seconds old, or older than the start of the current session, is dropped with `200 {ok: true, outcome: "stale"}` (the recognizer should not retry it). A `sign` whose `seq` was already seen in this recognizer run is dropped and raises the safety warning "repeated recognizer event". A `seq` that falls back to 1 is treated as a recognizer restart, shown as a system line, and starts a new run.

**Consent gate.** `sign`, `utterance` and `framing` are accepted only when the session is `ACTIVE` and the guest chose Sign; otherwise the route answers 409 and `GET /api/guest/signs` answers `{accepting: false}`. `status` is always accepted, because it carries no personal data.

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
| Green "sure" | 0.8 or above, and at or above the label's bar | This plan |
| Amber "fairly sure" | From the label's bar up to 0.8 | This plan |
| Red "unclear" | Below the label's bar, `NONE`, or framing rejection | This plan |

The outcome of an utterance is decided in this order:

1. If any sign is `NONE` or framing-rejected, the outcome is **repeat**.
2. If every sign is at or above its bar, the top-1 labels are matched as a **multiset** against the 20 guest intents of `docs/vocabulary.md` section 2, so `ELEVATOR WHERE` matches "Where is the elevator?" just like `WHERE ELEVATOR`. A match gives a **proposal**. A HELP sign that passed its bar but is amber still gives a proposal; the guest confirms it like any other.
3. If exactly one sign is below its bar and it is `HELP`, the outcome is **"Did you mean HELP?"**.
4. If exactly one sign is below its bar, the server replaces it in turn with each label in its top 3 (including its own top-1) and keeps every replacement that matches an intent, ranked by the product of confidences. One candidate gives **"Did you mean...?"**; two or three give **"Pick one"**; none gives **repeat**.
5. If two or more signs are below their bars, the outcome is **repeat**.
6. If every sign passed but nothing matched, the outcome is **"Not a request we know"** with up to three nearest intents (those sharing the most signs, at least one).

The guest always confirms, so using a runner-up never speaks something the guest did not choose. Nothing is ever spoken for a repeat. A unit test parses `docs/vocabulary.md` section 2 and checks that all 20 multisets are distinct and that every permutation of each matches its own intent.

### 6.4 Framing guidance shown on the guest screen

| Status | Guest text (the app's copy of `recognition/framing.py` `GUIDANCE`) |
|---|---|
| `OK` | "Ready: sign when you like" |
| `STEP_BACK` | "Please step back: your head to your waist should be in the picture" |
| `COME_CLOSER` | "Please come a little closer" |
| `HANDS_OUT` | "Keep your hands inside the picture" |
| `CENTER` | "Please move to the middle of the picture" |
| `MOVE_CAMERA_DOWN` | "Your waist is below the picture. Staff will tilt the camera down" (staff screen: "Tilt the desk camera down") |
| `NO_PERSON` | "Please stand in front of the desk camera" |

The guidance is shown only while the guest is in Sign mode, and it is removed when `OK` arrives.

### 6.5 Latency from real timestamps

| Stage | Computed as | Clock |
|---|---|---|
| Movement end -> prediction | `t_predicted - t_sign_end` | Laptop (recognizer) |
| Prediction -> app | server receive time - `t_predicted` | Laptop |
| App -> guest screen | ack receive time - event send time (a round trip, labelled "reported by the guest device"; values outside 0 to 10 s dropped, AS-22) | Laptop server |
| Utterance end -> proposal on the guest screen | ack receive time of the proposal - `t_end` | Laptop |
| "Say it" -> speech starts at the desk | `speak_done.startedAt` - confirm receive time | Laptop (staff browser and server) |

Each stage shows the last value, the median and the count for this guest. With no data it shows "no data yet"; nothing is estimated.

### 6.6 Session safety warnings (server-side)

| Warning | Trigger | Staff wording |
|---|---|---|
| Second device | A second guest stream from another address, or a join after the code was used | "Another device tried to join this conversation." |
| Device changed | The bound device's address or browser changed; guest actions except Help are paused until a new check code is typed | "The guest device changed address or browser. Check the device and type its new number." |
| Repeated request | A guest action whose nonce was already used, or a confirm for a proposal that is no longer pending | "A request was sent twice. This can be a network retry." |
| Unusual rate | A guest action kind hit its rate limit, or Help merged above 5 presses | "The guest device is sending requests unusually fast." |
| Failed pairing | Each failed join (per address count) | "Failed pairing attempts: 3" |
| Silent change | The guest device turned signing or read-aloud off | "The guest device switched off signing." (shown as information) |
| Heartbeat | No acknowledgement for 20 s (amber) or 45 s (red) | "Guest device last heard 47 s ago. Check on the guest." |
| Recognizer replay or key | Repeated or out-of-order `seq`, stale events, or failed `X-Bridge-Key` checks | "The recognizer sent an unexpected event." |

Every warning is gentle and factual. None of them claims an attack or spyware; the staff response card (section 4.2) is the action.

### 6.7 Simulator

`POST /api/dev/simulate` accepts exactly the bridge event bodies of section 6.1 and runs them through the same ingest function, marked `source: "simulated"`, so the staff screen shows a "SIMULATED" badge. It needs the staff cookie and answers 404 unless `SB_SIMULATE=1`. The panel has one button per guest intent (signs at 0.9 each, sent as `sign` events then an `utterance`), "Shuffle order", "Make one sign unclear" (one sign at 0.45 with a plausible top 3), "Low HELP", "Framing: step back", and "Recognizer in mock mode".

### 6.8 Reserved: local vision-model fallback (stub only)

`recognition/vlm/` is exploring a local vision-language model that could propose a sign when the classifier is unsure. This build reserves the slot and nothing more: a bridge event type `vlm_suggestion` (`{ type, seq, label, conf, model, t_sent }`), a proposal source `"local_vlm"`, and a "Did you mean...?" rendering that says "Suggested by a second program on this laptop". The route ignores the event with 404 unless `VLM_FALLBACK=1`, and even then a suggestion only ever becomes a candidate the guest must confirm. No video or frames are sent to the app for it; the model runs inside P3's process.

---

## 7. Event catalogue

All events travel as Server-Sent Events from `GET /api/events`. Each message has `id: <seq>` and `data: <BusEnvelope JSON>`. Every (re)connect gets `retry: 2000`, then `hello` (guest) and a `snapshot`, so no replay buffer is needed. The guest and staff unions in `types.ts` are separate, and the server builds guest messages only from the guest union (AS-1). Constant-size guest frames with cover events (`c`) are a LATER item for Mode W (REQ OPS-5).

| Type | Guest | Staff | Produced by | Notes |
|---|---|---|---|---|
| `hello` | yes | — | Every guest stream open | VRI details, kiosk flag, idle and cap times, emergency note, the check code while unconfirmed, the deployment mode |
| `pair_confirmed` | yes (`deskShows`) | yes | Staff `confirm_pair` | Both screens show the number |
| `snapshot` | yes (mode, read-aloud setting, last caption, pending proposal) | yes (status, log, pairing, checklist, evidence, latency, privacy, warnings) | Every stream open | Guest snapshot holds no scrollback (AS-1) |
| `session_state` | — | yes | Any lifecycle change | State, pairing info (code and URL only while the overlay is up), device class and address, tries left |
| `staff_utterance` | yes | yes | `say_quick`, `say_text` | Staff copy adds intent key and caption source |
| `delivered` | — | yes | Guest `ack` of a caption or proposal | Feeds the checklist and latency |
| `live_sign` | yes (label, light, conf) | yes (top 3, times, skeleton) | Bridge `sign` | Shown the moment a sign is recognised |
| `framing` | yes (status, text) | yes (status, rejected seq) | Bridge `framing` | Guest only while in Sign mode |
| `recognition` | — | yes | Bridge `utterance` | Signs, lights, gate outcome, candidates, source |
| `guest_proposal` | yes | — | Gate outcome | Kinds: `proposal`, `did_you_mean`, `did_you_mean_help`, `pick`, `unmatched`; each with candidates; `testMode` when the recognizer is `mock` |
| `repeat_request` | yes (signs with lights, weak indexes, framing hint, streak) | yes (reason, count, streak) | Gate outcome | Nothing is spoken |
| `guest_utterance` | echo (text, spoken or shown) | yes (signs, text, intent, speak plan) | `guest_confirm`, or `confirm_for_guest` in Mode 0 | Staff page voices it per the plan |
| `guest_fix` | — | yes | `guest_fix` | Sign again, type, interpreter, not this |
| `guest_typed` | — | yes | `guest_typed` | Banner and log line, never spoken without "Read aloud" |
| `guest_choice` | — | yes | `guest_choice`, `stop_signing`, `prefs` | Mode and read-aloud setting |
| `interpreter_request` | — | yes (VRI details) | Guest | Merged, at most one a minute |
| `emergency` | — | yes (`count`) | Guest Help | Never refused; merged with a count until acknowledged |
| `staff_ack` | yes | yes | Staff `ack` | "Staff is coming" |
| `warning` | — | yes | Safety rules (section 6.6) | Kind, plain text, time |
| `device_health` | — | yes | Guest `device_health` | "Reported by the guest device" |
| `idle_warning` | yes | yes | Sweeper, 30 s before the idle wipe | Staff "Keep open"; the guest cannot extend |
| `cap_warning` | — | yes | Sweeper, 2 min before the cap | "Extend 5 min" |
| `session_paused` | yes ("Please wait, the desk is checking this screen") | yes | Device change | Only Help works until a new check code |
| `vlm_proposal` (reserved) | — | — | `vlm_suggestion` with `VLM_FALLBACK=1` | Stub only |
| `session_end` | yes | yes | End guest, idle, cap, guest left, pair failed, repair (guest only), restart | Clients clear everything |
| `status` | — | yes, every 2 s and on change | Server | Recognizer, guest connection, counters, privacy, latency, flags |

---

## 8. Route catalogue

"Staff cookie" means the `sb_staff` capability cookie (section 9.6). "Guest cookie" means `__Host-sb_g` on the guest listener (or its Mode 0 loopback form). Every route also passes its listener's Host allowlist, and every state-changing request passes the same-origin check (`Sec-Fetch-Site`, `Origin`). Error bodies are `ApiError`; every response has `Cache-Control: no-store`.

| Method and path | Listener | Who may call | Body cap, type | Rate limit | Status codes | Owner |
|---|---|---|---|---|---|---|
| `GET /staff` | Staff | Loopback (page shell; data needs the staff cookie) | — | — | 200; 403 | P4 |
| `POST /api/staff/claim` | Staff | Loopback, same origin, body `{k}` from the one-time `#k=` URL | 1 KB JSON | 10/min | 200 (sets cookie); 400; 403 wrong key; 410 already claimed | P4 |
| `GET /api/events?role=staff` | Staff | Staff cookie | — | 4 streams | 200; 401; 403 | P4 |
| `POST /api/staff/action` | Staff | Staff cookie, same origin | 4 KB JSON | 120/min | 200; 400 (wrong check code carries `triesLeft`); 401; 403; 409 (wrong state, captions before confirmation); 413; 415; 429 | P4 |
| `GET /api/staff/benchmark` | Staff | Staff cookie | — | — | 200; 401 | P4 |
| `POST /api/guest/signs` | Staff only | Loopback plus `X-Bridge-Key` (at least 32 characters, constant time) | 8 KB JSON | 10/s | 200 (`outcome` includes `stale`); 400; 401; 403 (not loopback, or arrived on the guest listener); 404 (`vlm_suggestion` when off); 409 (no active session, or guest not signing); 413; 415; 429; 503 (`BRIDGE_KEY` unset or short) | P4 |
| `GET /api/guest/signs` | Staff only | Loopback plus `X-Bridge-Key` | — | 10/s | 200 `{accepting}`; 401; 403; 503 | P4 |
| `POST /api/dev/simulate` | Staff only | Staff cookie, `SB_SIMULATE=1` | 8 KB JSON | 10/s | as `/api/guest/signs`; 404 when off | P4 |
| `GET /signs/index.json`, `GET /signs/<dir>/<file>.json` | Staff only | Loopback | — | — | 200; 404 | P4 (route) |
| `GET /signs/bundle` | Both | Guest cookie on the guest listener; loopback on the staff listener | — | 2/min per session | 200 (fixed size, padded); 401 | P4 |
| `GET /guest` | Both (Mode 0 uses the staff listener) | Anyone on an allowed Host; shows nothing without a cookie | — | — | 200; 403 bad Host | P4 |
| `GET /api/events?role=guest` | Both | Guest cookie | — | 2 streams, newest wins | 200; 401 (with `Clear-Site-Data`) | P4 |
| `POST /api/guest/join` | Both | Anyone on an allowed Host; `GUEST_IPS` checked first | 4 KB JSON `{code}` | 5 failures per address per minute; no global ceiling | 200 `{check, hello}` and `Set-Cookie`; 400; 403 (address not in `GUEST_IPS`, code not burned); 410 (used or expired); 413; 415; 429 (that address only) | P4 |
| `POST /api/guest/action` | Both | Guest cookie, same origin | 4 KB JSON | Per action kind (section 9.5) | 200; 400; 401; 409 (stale proposal, wrong mode, not confirmed yet; never for `emergency`); 413; 415; 429 (never for `emergency`) | P4 |
| `POST /api/guest/leave` | Both | Guest cookie (also accepted with a dead cookie) | empty | 10/min | 200 with `Clear-Site-Data` and an expired cookie | P4 |
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
     │   End guest / idle (120 s; 60 s unconfirmed) / cap (15 min) / guest "I'm finished" / pair failed     the idle timer ──┘
     └──────────────────────────────────────────────── WIPED ◄──────────────────────────────────────────────────────────────
```

There is at most one session. The store lives on `globalThis[Symbol.for("signbridge.store.v2")]`, in memory only.

### 9.2 Idle wipe and hard cap

Only staff actions (including "Keep open") and accepted sign batches from the desk camera reset the idle timer. Guest actions, acknowledgements, heartbeats and reconnects never do (AS-16), because a hostile device must not be able to keep a session alive. The idle wipe is 120 seconds in `ACTIVE` and 60 seconds in `PAIRED_UNCONFIRMED`, with a warning 30 seconds before on both screens. A hard cap of 15 minutes ends the session even when it is busy; two minutes before it, the staff screen offers "Extend 5 minutes", which only staff can press, and each extension is logged. In `AWAITING_PAIR` only the code's own 120-second expiry applies.

### 9.3 Wipe

Wiping sends `session_end` to every stream and closes the guest streams; erases the log, names, typed text, proposals, skeleton snapshots, sign events, check code, device binding, token hash and nonce set; clears any cache that could hold guest-derived audio; and resets the per-guest counters. The since-start counters stay because they hold no personal data. A unit test runs a conversation that uses the name and typed text `Zq7Canary`, wipes, and asserts that the canary is absent from `JSON.stringify(store)`. A server restart loses everything, which is intended.

### 9.4 Reconnection and device changes

The guest stream authenticates with the cookie, which `EventSource` sends on its own. Each reconnect rotates the token with `Set-Cookie` (AS-5). When a third stream opens, the oldest is closed (newest wins). The guest page runs a 5-second watchdog and reopens a silent stream itself. A 401 that was not preceded by `session_end` shows a full-screen "Ask the desk to reconnect", and the staff screen shows the device-changed warning with a one-tap re-bind that needs a new check code. Two simultaneous streams from different addresses are refused.

### 9.5 Guest action rate limits (compromised_device.md R7)

| Action | Limit | When exceeded |
|---|---|---|
| `emergency` | One alert while unacknowledged; repeats raise its count; accepted before confirmation and while paused | Never 429 or 409 |
| `interpreter_request` | 1 per 60 s, repeats merged | Merged |
| `guest_typed` | 6 per minute, 280 characters each | 429 "Please wait a moment" |
| `guest_confirm`, `guest_fix` | Only for the pending proposal | 409 |
| `prefs`, `guest_choice`, `stop_signing` | 10 per minute, each shown to staff | 429 |
| `ack` | 120 per minute, not activity | Ignored above the limit |
| `device_health` | 1 per 10 s | Ignored |
| `POST /api/guest/join` | 5 failed attempts per address per minute, no global cap | 429 for that address |

Every guest action carries a client nonce `n` (16 random bytes, hex); a nonce seen before in this session is refused with 409 and raises "Repeated request".

### 9.6 Staff capability

At start, `server.mjs` prints a one-time URL `http://127.0.0.1:3000/staff#k=<random>`. The staff page posts `k` to `/api/staff/claim` and receives the `HttpOnly; SameSite=Strict; Path=/` cookie `sb_staff` (with the `__Host-` prefix if step 0 shows the demo browser accepts it on `http://127.0.0.1`). Every `/api/staff/*` call, the staff stream, the simulator and, through `guard.ts`, the P1 and Nath routes require it. Loopback alone is never treated as authentication, because every local process shares it (D6).

**Mode 0 cookies.** The guest window shares the staff window's browser profile. That is acceptable only because the Mode 0 guest window is display-only, with no keyboard or touch for the guest. The guest cookie in Mode 0 is `sb_g` (no `__Host-` prefix on plain loopback unless step 0 shows it works).

---

## 10. Server and Next.js 16 specifics

- **Header ownership (D7).** `web/server.mjs` alone sets `Content-Security-Policy`, `Permissions-Policy`, `X-Frame-Options`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, `Origin-Agent-Cluster`, `X-Robots-Tag` and, on the guest listener, `Strict-Transport-Security: max-age=86400`. The `headers()` block in `web/next.config.ts` keeps none of them, because Next applies config headers later and would replace the nonce policy. A new pure module `web/lib/app/headers.ts` exports `cspFor(path, nonce, dev, listener)` and `headersFor(path, listener)`.
- **Nonce CSP.** For every page request, `server.mjs` deletes any client-sent CSP request header, creates a 16-byte nonce, sets the policy on the request (Next 16 reads the nonce from there) and on the response. `/guest` and `/staff` call `await connection()` so they render per request. The guest policy is `lan_tls_pairing.md` section 5.3 (`script-src 'nonce-…' 'strict-dynamic'`, `default-src 'none'`, `connect-src 'self'`, `media-src 'none'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`); the staff policy adds `media-src 'self' blob:`. `'unsafe-eval'` and `ws:` are added in development only. P2 runs one avatar rehearsal with the policy as Report-Only before it is enforced (LT-25).
- **Permissions-Policy.** Guest: `camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), publickey-credentials-get=(), clipboard-read=(), screen-wake-lock=(self), compute-pressure=(self)`. Staff: `camera=(), microphone=(self), geolocation=(), compute-pressure=(self)`.
- **TLS.** `https.createServer` with `minVersion: "TLSv1.3"` on every context, a 5-second handshake timeout, a per-address connection cap of 8 counted on `connection` (before the handshake), and fail-closed start-up. Certificates come from the event CA (D5); key files are `0600` outside the repository.
- **SSE.** `export const dynamic = "force-dynamic"`, a `ReadableStream` response with `Content-Type: text/event-stream`, `Cache-Control: no-store, no-transform`, `X-Accel-Buffering: no`, TCP keep-alive, and unsubscribe on `request.signal` abort. `compress: false` in `next.config.ts` so nothing buffers the stream.
- **Same process.** Route handlers and `server.mjs` share one process (the integration merge confirmed the guard's `SB_PROOF` works), so the store and counters are shared.
- **Pure modules for tests.** Logic lives in pure modules that take their clock, random source and config as arguments (`vocab.ts`, `match.ts`, `validate.ts`, `pairing.ts`, `store.ts`, `bus.ts`, `ingest.ts`, `checklist.ts`, `latency.ts`, `warnings.ts`, `headers.ts`), with `node:test` files beside them run by `npm run test:unit`. Modules that read env or keys import `server-only` and contain only wiring.

---

## 11. Consolidated requirements

Each row merges every source that asks for the same thing. Owners: **A** = P4 builder A (server, security, logic), **B** = P4 builder B (screens), **P1** = Maya, **P2** = Cosme, **P3** = Talha (recognition), **Nath** = english and tts routes, **Ops** = Talha in person (demo operations). Tests: **U** = `web/lib/app/*.test.ts` (`npm run test:unit`), **S** = `web/security-tests/*.test.mjs` (`npm run test:security`, loopback only), **T** = new `web/security-tests/tls.test.mjs` (TLS listener bound to 127.0.0.1 with a throwaway test CA in a temporary folder), **H** = new `web/security-tests/hygiene.test.mjs` (repository greps), **E** = Playwright on loopback (added at build step 10), **M** = manual rehearsal or the engagement pre-flight scripts. "Source" uses the IDs of the documents: RT (app-plan 10a), AS (compromised_device 8), R (compromised_device 3), D and G (decision record), LT (lan_tls_pairing 8), BT (slide "build today" item), RY (rylo_final sections 4 and 5), F (feature list from Talha).

### 11.1 Deployment and server

| ID | Requirement | Source | Owner | When | Test that proves it |
|---|---|---|---|---|---|
| SRV-1 | The app runs only through `server.mjs`, from a production build for any demo; development mode is never reachable from a network; every route calls a guard, and a route with no guard is a bug | RT1, B1, RY 7 | A | BUILD-NOW | S: plain `next dev` fails closed (exists). H: every `route.ts` under `web/app/api` calls a guard function |
| SRV-2 | No plain-HTTP listener off loopback, ever: remove `--lan` and `firstLanIPv4`; the guest listener is HTTPS only on an explicit `LAN_IP:3443` inside `LAN_NET`, TLS 1.3 on every context; start-up refuses without certificate, key or `LAN_IP`; no `TLS_MIN` or `ALLOW_PLAIN_HTTP_LAN` | D3, RT2, AS-17, LT-01, LT-06, LT-31, R8 | A | BUILD-NOW | T: plain HTTP to the guest port gets no response; TLS 1.2 refused; start without a key exits non-zero. S: no listener other than 127.0.0.1 without `start:guest-tls` |
| SRV-3 | The listener decides the role: guest-listener requests are never loopback, whatever the socket address | LT-06, AS-17 | A | BUILD-NOW | T: guest listener on 127.0.0.1 answers 403 to `/staff`, `/api/staff/action`, `/api/guest/signs`, `/api/tts` |
| SRV-4 | Host allowlist per listener (`127.0.0.1:3000`, `localhost:3000` for staff; `LAN_IP:3443` and `DESK_NAME:3443` for guest); client `x-sb-*` headers stripped | B3, LT-07 | A | BUILD-NOW | S, T: foreign Host 403; forged `x-sb-*` ignored (exists for staff) |
| SRV-5 | Guest listener path list exactly as D6 (plus `/avatar/bellhop.glb` only if Talha accepts); everything else 403; per-gloss `/signs` removed from the guest listener | D6, RT7, LT-28, B2 | A | BUILD-NOW | U: `lanPathAllowed` cases. T: `/signs/team/LEAVE.json` 403 on the guest listener |
| SRV-6 | `GET /signs/bundle`: every sign file, signer removed, padded to one fixed size, guest cookie required on the guest listener; P2 adds `preloadSigns(bundle)` | D6, LT-28 | A, P2 | BUILD-NOW | T: two bundles for different sessions have identical byte length; 401 without cookie |
| SRV-7 | `server.mjs` alone owns the security headers; `next.config.ts` sets none of them; exactly one CSP header; nonce CSP with `'strict-dynamic'` and no `'unsafe-inline'` or `'unsafe-eval'` on `/guest` and `/staff` in production; client CSP request headers stripped; pages render per request | D7, AS-18, LT-16, LT-17, LT-27, LT-29, R12, B7 | A | BUILD-NOW | S (production build): one `Content-Security-Policy` line, `script-src` has a nonce and no `unsafe-*`, nonce differs between two requests |
| SRV-8 | Header set of `lan_tls_pairing.md` 5.3: guest Permissions-Policy deny list (plus `compute-pressure=(self)`, `screen-wake-lock=(self)`), COOP, CORP, Origin-Agent-Cluster, X-Robots-Tag, HSTS on the guest listener, `Cache-Control: no-store` on every response including HTML and static files | AS-2, AS-19, LT-19, LT-20, R2, R11 | A | BUILD-NOW | S, T: header table checked per listener and path |
| SRV-9 | Per-address connection cap of 8 before the TLS handshake; handshake and request timeouts; no global join ceiling | LT-21, AS-15, D6 | A | BUILD-NOW | T: 20 sockets from one address, the 9th is closed; a request from a fresh connection still succeeds |
| SRV-10 | Staff capability: one-time `#k=` URL printed at start, exchanged once for an HttpOnly SameSite=Strict cookie, required on `/api/staff/*`, the staff stream, the simulator and (through `guard.ts`) P1 and Nath routes | D6, LT-30 | A | BUILD-NOW | S: staff action without the cookie 401; second claim 410; `/api/tts` without the cookie 401 |
| SRV-11 | Body caps with the capped reader, content-type allowlist, strict schema validation on every route | RT12, AS-12, B4, R6 | A | BUILD-NOW | U: validators. S: 413, 415, 400 per route |
| SRV-12 | Logs carry status codes and short error types only: never URLs, codes, tokens, check codes, names, typed text, transcripts or vendor bodies | RT11, LT-22, B8, D6 (finding) | A | BUILD-NOW | S: run a full simulated session with `Zq7Canary` and a known check code; neither appears in server output |
| SRV-13 | No secrets in the browser: no `NEXT_PUBLIC_`, key readers import `server-only`, the guest bundle does not contain staff page code, no key value in `.next/static` | AS-20, RY 13, R12 | A | BUILD-NOW | H: greps. M: after `next build`, grep `.next/static` for key values and for `/api/staff/action` inside guest chunks |
| SRV-14 | Child processes use an absolute executable and an allowlisted environment | RT10, B9, C3, D5 (finding) | Nath, A | BUILD-NOW (exists for Piper) | S: Piper spy test (exists) |
| SRV-15 | Works fully offline with no vendor keys: quick replies, fixed tables, Piper, local voice, P1 local gloss; the staff header says "Vendor keys: none"; the Web Speech fallback is off when no disclosure was accepted | D8, RT13, BT 4 | A, B | BUILD-NOW | E: the whole demo script with no keys in the environment; privacy panel shows 0 vendor calls |
| SRV-16 | Event CA (name-constrained, 3 days, key destroyed), never mkcert; TLS key files `0600` outside the repository; `*.pem`, `*.key`, `*.crt` ignored | D5, LT-04, LT-23, RT2 | Ops | BUILD-NOW (before gate G1) | M: LT-04 and LT-23 checks in `preflight_laptop.sh` |
| SRV-17 | Deploy only a signed, reviewed tag; `npm ci --ignore-scripts`, `pip install --require-hashes`; freeze 24 hours before | RT14, D9, G0 | Ops, all | LATER (gate G0) | M: G0 checklist |
| SRV-18 | Vendor terms read and zero-retention on before any vendor path is used with a guest | RT13, RY "should" | Talha | LATER | M: written record |

### 11.2 Pairing and session lifecycle

| ID | Requirement | Source | Owner | When | Test that proves it |
|---|---|---|---|---|---|
| SES-1 | "New guest" then "Guest is here"; 128-bit code, 120 s, single use, in the URL fragment, removed with `replaceState` before any request; QR as a full-screen overlay, refreshed every 60 s, closed on join, drawn as `<rect>` elements | D6, AS-9, LT-08, RT3, R4 | A, B | BUILD-NOW | U: `pairing.test.ts` expiry and single use. E: after load the address bar has no fragment; overlay closes on join |
| SES-2 | Join checks `GUEST_IPS` first (403, code not burned), then the code in constant time, then counts failures per address (5 a minute); a valid code is never rate-limited; failures shown on staff | D6, AS-15, LT-12 | A | BUILD-NOW | U and T: outside address gets 403 and the real device can still join with the same code |
| SES-3 | 6-digit check code created at join, shown only on the guest device, typed by staff, 3 tries then wipe; before confirmation only Help is accepted and captions get 409; both screens show the number after; Mode 0 loopback join confirmed at once | D6, AS-10, LT-09 | A, B | BUILD-NOW | U: tries and states. T: `say_quick` before `confirm_pair` is 409; `emergency` before confirmation is 200 |
| SES-4 | Guest token only in the `__Host-sb_g` cookie (Secure, HttpOnly, SameSite=Strict, Path=/, no expiry), stored as SHA-256; never in a URL, body, storage or log | D6, AS-4, LT-10, RT3 | A | BUILD-NOW | T: join body has no token; cookie attributes exact; a replayed cookie with another User-Agent gets 401 |
| SES-5 | Token rotated on every stream reconnect and on repair; revoked on End guest, idle, cap and leave | AS-5, LT-13 | A | BUILD-NOW | U: old token refused after rotation and after each kind of end |
| SES-6 | Device binding: address plus User-Agent hash and parsed device class; a change pauses everything except Help, warns staff and needs a fresh check code; two simultaneous streams from different addresses refused; an unexpected 401 shows "Ask the desk to reconnect" | AS-11, LT-11, R5 | A, B | BUILD-NOW | U: store with injected addresses. M: renew the guest address in rehearsal |
| SES-7 | Guest stream: cookie auth, `retry: 2000`, `hello` and snapshot on connect (last caption and pending proposal only), newest stream wins (2), keep-alive, 5 s client watchdog, `no-store, no-transform` | LT-14, LT-20, AS-1, R1 | A, B | BUILD-NOW | U: guest snapshot keys. T: third stream closes the oldest |
| SES-8 | Idle wipe 120 s (60 s unconfirmed) with a 30 s warning; reset only by staff actions and accepted sign batches | AS-16, R14, RY 15 | A | BUILD-NOW | U: guest actions and acks do not move the timer |
| SES-9 | Hard cap 15 minutes; staff-only "Extend 5 minutes" offered 2 minutes before; the guest can never extend | AS-16, R14 | A, B | BUILD-NOW | U: cap fires while busy; a guest `extend` is 400 |
| SES-10 | End guest and every wipe erase everything (log, names, typed text, proposals, skeletons, sign events, tokens, check code, binding, guest-derived audio cache); `session_end` to all streams; afterwards 401 with `Clear-Site-Data`; `/api/guest/leave` expires the cookie | LT-13, AS-6, RT5, old row 24, RY 15 | A | BUILD-NOW | U: `Zq7Canary` absent from the store after wipe. T: `Clear-Site-Data` on leave and on the next 401 |
| SES-11 | Guest page uses no `localStorage`, `sessionStorage`, IndexedDB, Cache API, service worker or manifest; inputs have autocomplete, autocorrect, autocapitalize and spellcheck off; neutral screen on `pagehide` and when hidden; after `session_end` history shows only the ended page | AS-3, AS-7, AS-8, R2, R3 | B | BUILD-NOW | H: greps over `web/app/guest`, `web/components/guest`. E: Back after End guest shows the ended page |
| SES-12 | The guest can end the conversation with "I'm finished" (reason `guest_left`) | D6 (leave route), old open question 4 | A, B | BUILD-NOW | U: leave ends the session; E: staff sees "The guest ended the conversation" |

### 11.3 Recognizer bridge

| ID | Requirement | Source | Owner | When | Test that proves it |
|---|---|---|---|---|---|
| BRG-1 | `POST /api/guest/signs` only on the staff listener, loopback plus `X-Bridge-Key` (at least 32 characters, constant time, 503 when unset), 8 KB, 10 a second | RT9, LT-24, A4, A8 | A | BUILD-NOW | S: 401 wrong key, 503 short key, 413, 429. T: 403 on the guest listener |
| BRG-2 | Accepts the real bridge events (`sign`, `utterance`, `framing`, `status`); unknown keys ignored, known keys strict; 22 labels plus the `FS-CHECKOUT` alias; `face`, `frames`, `pose` or `video` keys refused | Recognizer README "App bridge", old rows 11 | A | BUILD-NOW | U: `validate.test.ts` with the README examples, fuzzed labels, `NaN`, extra `face` |
| BRG-3 | Stale events (`t_sent` older than 5 s or before the session start) dropped; repeated `seq` dropped with a warning; restart detected | README, AS-21 | A | BUILD-NOW | U: injected clock and sequences |
| BRG-4 | Consent gate: signs and framing accepted only in `ACTIVE` with the guest in Sign mode; `GET` answers `{accepting}` | RT4, old row 14, BT 2, RY 12 | A | BUILD-NOW | U and S: 409 in `choosing`, `type`, `text_only` |
| BRG-5 | Recognizer `status` shown; in `mock` every proposal is test mode and never spoken | README status | A, B | BUILD-NOW | U: test-mode proposals have no speak plan |
| BRG-6 | Simulator posts the same events, needs the staff cookie and `SB_SIMULATE=1`, is labelled SIMULATED, 404 otherwise | Old 4.5 | A, B | BUILD-NOW | S: 404 when off |
| BRG-7 | Skeleton snapshot: optional `skeleton` on `sign` events (pose 0 and 11 to 16 plus hands, x and y, no face, one frame, at most 2 KB); staff only, memory only, wiped, counted | F (evidence), RY "privacy mode" | P3 (sender), A, B | BUILD-NOW app side; P3 LATER | U: guest projection never contains `skeleton`; face keys refused; wipe erases snapshots |

### 11.4 Confirm before speaking

| ID | Requirement | Source | Owner | When | Test that proves it |
|---|---|---|---|---|---|
| SPK-1 | Nothing reaches `/api/tts` or a speaker until the guest taps "Say it" (Mode 0: staff tap "Say it for the guest", logged as such); `NONE` and below-bar signs are never spoken; a stale proposal gets 409 | RT4, A8, D1 (finding), BT 2, RY 11, old row 15 | A, B | BUILD-NOW | U: no `guest_utterance` without confirm. E: a fetch spy on `/api/tts` sees no call before the tap |
| SPK-2 | Harm-weighted gate (0.6 default, 0.75 for YES, NO, NAME, ROOM, HELP, provisional) and traffic lights (green 0.8 and above, amber, red); HELP below its bar gives "Did you mean HELP? [Yes, get staff] [No]" and never a silent alert | BT 3, RY harm table | A, B, P3 (final values) | BUILD-NOW | U: `match.test.ts` bars, 0.6 passes, 0.5999 fails, lights, low HELP |
| SPK-3 | "Did you mean...?" for one weak sign with one candidate; "Pick one" for two or three; "None of these: Type / Sign again / Interpreter"; nearest requests for unmatched signs; the guest always confirms | BT 3, F | A, B | BUILD-NOW | U: candidate generation for every intent with one sign weakened |
| SPK-4 | Order-insensitive multiset match for all 20 guest intents with `LEAVE` | RY 10, old row 13 | A | BUILD-NOW | U: parses `docs/vocabulary.md` section 2; every permutation matches; all multisets distinct |
| SPK-5 | Speak plan: the vendor or Piper voice only for fixed table sentences (sent as `{text}` of the fixed sentence until Nath accepts `{id}`); NAME needs staff "Speak name" and typed text needs "Read aloud", both with an on-device voice (`localService`) or text only; the canary never appears in an outgoing request | RT5, RT6, AS-13, D9 (finding), R6, RY 9 | A, B; Nath for `{id}` | BUILD-NOW; `{id}` LATER | U: speak plan for each case. E: fetch spy with name `Zq7Canary` |
| SPK-6 | Name sanitizer (NFC, letters, marks, spaces, hyphen, apostrophe, 1 to 40) and typed text (NFC, no control characters, at most 280); every guest string rendered as text only; no `dangerouslySetInnerHTML` | Old row 16, LT-29, B5 | A, B | BUILD-NOW | U: sanitizer cases. E (LT-29): `<img src=x onerror=…>` in a name, typed text and User-Agent runs nothing on `/staff` |
| SPK-7 | "Read my sentences aloud" toggle and Text only: confirmed sentences shown as text at the desk without speech | BT 2, RY 11 | B | BUILD-NOW | E: toggle off, nothing reaches `/api/tts` or `speechSynthesis` |

### 11.5 Staff to guest

| ID | Requirement | Source | Owner | When | Test that proves it |
|---|---|---|---|---|---|
| CAP-1 | 20 quick replies with fixed glosses, no cloud call | CLAUDE.md 8.1, RY 1 | A, B | BUILD-NOW | U: `vocab.test.ts` matches `docs/vocabulary.md` section 1 |
| CAP-2 | Voice and typed staff text: P1 `/api/transcribe`, then `/api/gloss`; the server accepts only tokens in `signs/index.json`, `FS:` plus `^[A-Z0-9]{1,32}$`, or the two markers, at most 40; otherwise P1 `mapStaffTextToGloss` in process; otherwise captions only; captions at most 600 bytes | RT8, D8 (finding), CLAUDE.md 7.1 | A, B | BUILD-NOW | U: gloss validator rejects `FS:<script>`, 41 tokens, unknown words |
| CAP-3 | The free-text box is labelled "This text will appear on the guest's device" | AS-26, R1 | B | BUILD-NOW | M: read the staff screen |
| CAP-4 | Guest renders captions first, then `mountAvatar` and `playGloss(gloss, {onToken})` with `AvatarCaptions`; without WebGL or images, captions and text sign cards; system fonts only | AS-24, P2 API | B | BUILD-NOW | E: with WebGL disabled the caption and cards still show |
| CAP-5 | The avatar works under the nonce CSP (Report-Only rehearsal first, then only the reported sources are added) | LT-25 | P2, B | BUILD-NOW | E: no CSP violations in the console during a full gloss |

### 11.6 Guest features

| ID | Requirement | Source | Owner | When | Test that proves it |
|---|---|---|---|---|---|
| GST-1 | First screen: Sign, Type, Ask for a human interpreter, Text only as equal choices; notice text exactly as `compromised_device.md` 2.4; nothing ever asks for a password, card number or ID | AS-23, BT 2, RY 3, RY 12, R11 | B | BUILD-NOW | E: the notice text matches the document; H: no input with `type=password` or card or ID wording in the guest page |
| GST-2 | Help button visible on every guest screen; never 429 or 409; merged count; accepted before confirmation and while paused; staff full-screen alert and "I'm coming"; guest heartbeat on staff (amber 20 s, red 45 s); printed "wave or knock" card at the counter | AS-14, AS-21, R7, R7a, BT 2, RY 12 | A, B, Ops (card) | BUILD-NOW | U: emergency never refused. M: drill with the emergency request blocked; the actor waves and staff respond |
| GST-3 | Interpreter: VRI name and phone; a link only when the device is not a kiosk; disclosure that a video relay call sends video to the provider; called "a link" on stage | AS-25, RY 6, BT 2 | B | BUILD-NOW | U: `hello.kiosk` true hides the link |
| GST-4 | Framing guidance (`STEP_BACK`, `COME_CLOSER`, `HANDS_OUT`, `CENTER`, `MOVE_CAMERA_DOWN`, `NO_PERSON`) shown on the guest screen while signing; a framing-rejected sign is red | Recognizer README framing, F | A, B | BUILD-NOW | U: every status maps to text |
| GST-5 | Live sign display: each sign appears on the guest screen (top-1 with light) and the staff screen (top 3 with times) as it is recognised | F | A, B | BUILD-NOW | E: simulator `sign` events appear before the `utterance` |
| GST-6 | Device-health hint only where the browser supports Compute Pressure; reports at most every 10 s; staff wording "reported by the guest device" and "not a security check"; the word "spyware" never appears | F, HANDOFF extras | A, B | BUILD-NOW | H: no "spyware" in `web/app`, `web/components`. U: rate of `device_health` |
| GST-7 | Local vision-model fallback reserved: `vlm_suggestion` event, `local_vlm` source and a disabled "Did you mean...?" path; ignored unless `VLM_FALLBACK=1`; never spoken without confirmation | F | A, B | BUILD-NOW (stub only) | S: 404 with the flag off |
| GST-8 | Per-action guest rate limits and nonce replay refusal (section 9.5) | AS-14, RT12, R7 | A | BUILD-NOW | U: limits per kind |
| GST-9 | No camera or microphone code in the guest bundle; the guest page stub comment no longer mentions a webcam | AS-19, R11 | B | BUILD-NOW (comment fixed with this plan) | H: no `getUserMedia`, `mediaDevices` or `geolocation` under guest paths |

### 11.7 Staff dashboard

| ID | Requirement | Source | Owner | When | Test that proves it |
|---|---|---|---|---|---|
| DSH-1 | Header strip: mode, device class and address, pairing state and number, heartbeat, streams, idle and cap countdowns with Extend, recognizer state, warnings count, vendor keys, End guest | AS-21, R13 | B | BUILD-NOW | E: values follow a simulated session |
| DSH-2 | Check-in co-pilot checklist: 13 items, shared only on the guest device's acknowledgement, "sent" before it, gentle "not shared yet", "guest asked; not answered yet", "I saw it" for ID, evidence time and sentence | F (ProtoCopilot) | A (`checklist.ts`), B | BUILD-NOW | U: checklist reducer over a scripted event list |
| DSH-3 | Evidence: traffic light per recognised sign with timestamps, top 3 and skeleton snapshot; never video | F | B | BUILD-NOW | E: simulator sign with a skeleton draws it |
| DSH-4 | Latency panel only from real timestamps (section 6.5); guest-reported values labelled and limited to 0 to 10 s; "no data yet" otherwise | AS-22, F | A (`latency.ts`), B | BUILD-NOW | U: stage arithmetic and the 10 s filter |
| DSH-5 | Privacy panel only from real counters (section 4.2) | RY 4, F | A, B | BUILD-NOW | U: counters move with each event; H: no file-writing calls in app code |
| DSH-6 | Benchmark card shows only audited figures; today "Accuracy figures: not yet audited"; a file must say `cleared: true` with an audit reference before any number shows | HANDOFF (audit not cleared), F | A, B | BUILD-NOW | U: synthetic or uncleared files give the "not yet audited" state |
| DSH-7 | Session safety warnings (section 6.6) with the staff response card | AS-21, R13, HANDOFF extras, F | A (`warnings.ts`), B | BUILD-NOW | U: each trigger raises its warning once |
| DSH-8 | Simulator panel for rehearsal | Old 4.5 | B | BUILD-NOW | E: rehearsal script |
| DSH-9 | Mock pager "notify guest" panel: generic codes only ("Please come to the desk"), no names, rooms or text, clearly labelled mock | HANDOFF extras, F | B | LATER (only if time remains) | H: the panel sends only codes from a fixed list |

### 11.8 People, operations and later work

| ID | Requirement | Source | Owner | When | Test that proves it |
|---|---|---|---|---|---|
| OPS-1 | Printed "If the screen does not respond, wave or knock. Staff will come to you." card on the guest side; staff script (treat the screen like a person; never give keys or payment details because the screen asked; press End guest) | compromised_device 2.4, `docs/security-testing.md` | Ops | BUILD-NOW (paper) | M: card on the counter at rehearsal |
| OPS-2 | Pairing script: check the device physically, never confirm without reading the guest device, never project the QR, "SignBridge never opens a login page and never asks for payment, passwords or ID" | LT-26 | Ops | BUILD-NOW | M: rehearsal |
| OPS-3 | Live LAN and penetration testing only on an isolated machine; `SB_SECTEST_LAN=1` only there; nothing exposed on the development Mac's network | `docs/security-testing.md`, HANDOFF | All | BUILD-NOW (rule) | M |
| OPS-4 | Wiped unmanaged loaner as the system under test; development Mac away from the venue; gates G0 to G3 | D1, D2, gates | Talha | LATER | M: gate checklists |
| OPS-5 | Constant-size 2048-byte guest frames every 250 ms with cover events, padded POSTs, captions capped in bytes | LT-15, D3 Mode W | A | LATER (required before gate G2 / Mode W only) | T: every frame on the guest stream has the same length |
| OPS-6 | Mode W router controls (two networks, PMF, isolation, RA guard) | D3, G2 | Ops | LATER | M: G2 checklist |
| OPS-7 | `ENGLISH_FALLBACK=1`: unmatched labels sent to Claude through Nath's route, labels only, as a candidate the guest must confirm | CLAUDE.md 7.2, RY 1 | A, Nath | LATER (never during the engagement window) | S: 404 when off |
| OPS-8 | `/api/tts` accepts `{ id }` only | RT5 | Nath | LATER | S: free text 403 |
| OPS-9 | Stronger device binding with a non-extractable WebCrypto key per action | R5 stretch | A | LATER | U |
| OPS-10 | Consent and opaque ids for team recordings; a Deaf reviewer for the script and the avatar, or say on stage that none happened | RT7 (team part), C1, C11, BT 4 | All | LATER | M |
| OPS-11 | Sign-language picker on the first screen (ASL first; others need data) | Roadmap | B | LATER | — |

---

## 12. Build order and time estimates

Builder A owns the server, security and logic; builder B owns the screens. Both work against `web/lib/app/types.ts`. The estimates are honest guesses for people who know the codebase, not promises. If `ps aux | grep "[t]rain_session"` shows Talha's recorder running, `next build` and Playwright wait and are retried every 60 seconds.

| Step | Builder | Work | Hours | Done when |
|---|---|---|---|---|
| 0 | A | Spike: nonce CSP set by `server.mjs` reaches a Next 16 page; `__Host-` cookies on `http://127.0.0.1` in the demo browser; HTTPS listener on 127.0.0.1 with a throwaway CA; `connection()` | 0.5 | Notes in the progress log; cookie names decided |
| 1 | A | Pure modules with unit tests: `vocab.ts`, `match.ts` (bars, lights, multiset, candidates, nearest), `validate.ts` (bridge events, actions, names, typed text, gloss tokens), `pairing.ts`, per-action limiter | 2.0 | `npm run test:unit` green |
| 2 | B | Tokens, layout, `KeyTag`, `TrafficLight`, guest first screen with the exact notice, static staff layout with mock data typed from `types.ts` | 1.5 | Both screens render at 390x844 and 1440x900 |
| 3 | A | `store.ts` (states, idle, cap, extend, wipe, nonces, warnings hooks), `bus.ts` (SSE, guest and staff projections), `/api/events`, `/api/staff/claim`, `/api/staff/action`, `/api/guest/join`, `/api/guest/action`, `/api/guest/leave` | 2.5 | A quick reply reaches a loopback guest window; End guest wipes both |
| 4 | A | `server.mjs`: remove plain `--lan`; guest HTTPS listener with fail-closed start-up; per-listener Host lists and role; D6 path list; `headers.ts` and the nonce CSP; strip headers out of `next.config.ts`; per-address cap before TLS; staff cookie in `guard.ts` | 2.0 | `tls.test.mjs` and the extended `server.test.mjs` pass |
| 5 | B | Guest conversation: captions, avatar swap point (`mountAvatar`, `playGloss`, `AvatarCaptions`, cards fallback), live signs, framing text, every proposal state, Say it and Fix, name field, Type, Interpreter, Text only, Help, I'm finished, ended screen, `pagehide` | 2.5 | The simulator drives every state on the guest window |
| 6 | A | Bridge ingest (`ingest.ts`): events, freshness, replay, consent gate, `seq` join, gate outcome, status and mock; `/api/guest/signs`; `/api/dev/simulate`; VLM stub | 1.5 | `live.py --mock --post` drives a loopback session |
| 7 | B | Staff dashboard: header strip, quick replies, free text, P1 hold-to-talk, log, Speak name, Read aloud, Speak again, speak plan (Nath `/api/tts` for fixed sentences, local voice otherwise), pairing overlay, check-code entry, alerts, Mode 0 "Say it for the guest" | 2.5 | The demo script runs with the simulator |
| 8 | B | Panels: co-pilot checklist, evidence with skeleton drawing, latency, privacy, safety, benchmark "not yet audited", device health | 2.0 | All panels show live values from a simulated session |
| 9 | A | `/signs/bundle` and the P2 preload request; `checklist.ts`, `latency.ts`, `warnings.ts`, privacy counters, `device_health` | 1.5 | Unit tests green; panels fed by real counters |
| 10 | Both | Tests: extend `server.test.mjs`, add `tls.test.mjs` and `hygiene.test.mjs`, add Playwright on loopback (LT-29 XSS canary, confirm-before-speak spy, Back after End guest) | 2.0 | `npm run test:security`, `test:unit` and the e2e suite pass |
| 11 | Both | Integration with the real `live.py` on loopback, accessibility pass (keyboard, screen reader on captions, reduced motion), `next build`, CLAUDE.md section 9 rehearsed twice in Mode 0 | 1.5 | Two clean runs in a row |
| Ops | Talha | Event CA and cable (Mode C), the printed card, pre-flight scripts, gate G1 | 1.0 | G1 passes, or Mode 0 for the window |

Builder A has about 10 hours of work and builder B about 11, so the wall time with both busy is about 11 to 12 hours. If time runs short, cut in this order: the pager panel, the device-health hint, the skeleton drawing (keep the text evidence), the latency panel's median column, the laptop guest layout polish. Never cut: confirm before speaking, the consent gate, Help, End guest with the idle wipe and the cap, the staff capability, the HTTPS-only guest listener (or fall back to Mode 0), quick replies and the simulator.

---

## 13. Demo script mapped to clicks (CLAUDE.md section 9, with LEAVE for checkout)

**Preparation (Mode 0; Mode C differences in brackets).** Start the app with `npm run build && npm run start` [`npm run start:guest-tls` with `LAN_IP=10.77.0.1`, `LAN_NET=10.77.0.0/30`, `GUEST_IPS=10.77.0.2` and the event CA files]. Open the printed one-time `http://127.0.0.1:3000/staff#k=...` URL and press **Start desk**. Start the recognizer: `BRIDGE_KEY=... python -m recognition.live --camera 0 --post http://127.0.0.1:3000/api/guest/signs`. Check that the staff header shows "Recognizer: ok" (never `mock` on stage) and "Vendor keys: none". Put the printed "wave or knock" card on the counter. Press **New guest**, then **Open guest window** and drag it to the wired display [press **Guest is here**, open the link on the team iPad, read the 6 digits off the iPad, type them, press **Confirm**; both screens show "Paired with ..."]. The guest taps **Sign** [in Mode 0 the receptionist presses "Guest chose Sign" after asking].

| # | Staff action (exact click) | Guest screen shows | Guest does | Staff screen shows, laptop does |
|---|---|---|---|---|
| 1 | Quick replies **Welcome!**, then **Reservation?** | "Welcome!" and "Do you have a reservation?" with the avatar and captions | Signs YES RESERVATION; sees both signs light up live, then "Yes, I have a reservation." and taps **Say it** | Live signs with lights; checklist "Greeting" and "Reservation" turn shared; the laptop speaks the sentence (Piper) |
| 2 | Quick reply **Your name?** | "What's your name?" | Signs NAME; types the name; taps **Say it** | "My name is ..." with **Speak name**; the receptionist taps it; a local voice says it; "Guest name" shared |
| 3 | Quick replies **Room 412**, then **Key card** | Captions and avatar | Signs THANK-YOU, **Say it**; then WHERE ELEVATOR, **Say it** | "Thank you." then "Where is the elevator?" spoken; "Room number" and "Key card" shared |
| 4 | Quick reply **Elevator left** | "The elevator is on your left." | Signs FS-WIFI PASSWORD, **Say it** | "What's the Wi-Fi password?"; checklist shows "Wi-Fi: guest asked; not answered yet" |
| 5 | Quick reply **Wi-Fi** | "The Wi-Fi password is on your key card." | Signs BREAKFAST TIME, **Say it** | "What time is breakfast?"; "Wi-Fi" shared |
| 6 | Quick reply **Breakfast 7-10** | "Breakfast is from 7 to 10." | Signs MORE TOWEL PLEASE with one sign deliberately unclear | That sign is red in the evidence panel. The guest sees either "Did you mean: 'Could I have more towels, please?'" or "Please sign that again"; the guest taps **No, sign again** (or simply signs again) |
| 7 | — | "Please sign that again" and which sign was unclear | Repeats MORE TOWEL PLEASE, **Say it** | Repeat counter 1; "Could I have more towels, please?" spoken |
| 8 | Quick replies **Towels**, then **Anything else?** | Captions | Signs LEAVE TIME, **Say it** | "What time is checkout?" spoken; checklist "Checkout time: guest asked" |
| 9 | Quick reply **Checkout 11** | "Checkout is at 11." | Signs NO THANK-YOU, **Say it** | "No, that's all, thank you." spoken; "Checkout time" shared |
| 10 | Quick reply **Enjoy stay** | "Enjoy your stay!" | — | "Farewell" shared; the co-pilot shows "ID checked: not shared yet" as a gentle grey flag; the receptionist taps **I saw it** |
| 11 | A juror types (or, with a P1 key outside the engagement window, holds **Hold to talk** and says) a free sentence | Captions, plus the avatar via the generic gloss path, or captions only | — | Gloss source shown in the log |
| 12 | Point at the **Latency** and **Privacy** tabs, then press **End guest** | "This conversation has ended. Nothing about it was saved on this device." | — | Log cleared; wipe receipt with the number of erased items; per-guest counters reset |

**Rehearsal without the camera** uses the simulator in this order: intents 3, 4, 5, 6, 7, 8, 10 (with "Make one sign unclear" on, then off), 11 and 20, with "Shuffle order" on at least once to show that `WHERE ELEVATOR` and `ELEVATOR WHERE` give the same result, and "Low HELP" once to show that a weak HELP asks before alerting. On stage we say that the unclear-sign repeat is rehearsed, and the "SIMULATED" badge must never appear during the real demo. In Mode 0 we say on stage that the receptionist confirms on the guest's behalf. We do not show or claim any accuracy figure: the benchmark card says "not yet audited".

---

## 14. Contract changes and requests (logged in `docs/requests.md`)

1. Screen sync moves from `BroadcastChannel("signbridge")` (CLAUDE.md 2 and 6.7) to the server SSE bus, because the guest screen is on another device. `web/lib/channel.ts` becomes a thin client helper around `EventSource` and the action POSTs.
2. The 6.7 messages keep their names and gain fields; the full catalogue is section 7.
3. Guest recognition comes from the desk camera through `recognition/live.py --post` events (section 6.1), not from the browser webcam of CLAUDE.md 7.2 steps 1 to 3.
4. P3 is asked for: the optional `skeleton` field on `sign` events (section 6.2); renaming `FS-CHECKOUT` to `LEAVE` in `recognition/labels.py`; final harm-weighted bars from audited calibration; optionally polling `GET /api/guest/signs` for `{accepting}` to switch the camera off; and a benchmark report with `cleared: true` and an audit reference before any figure is shown.
5. CLAUDE.md 7.2 step 5 changes: scripted guest sentences come from the fixed table with order-insensitive matching; `/api/english`'s Claude path is a LATER fallback, labels only, confirmed by the guest.
6. Nath is asked to move `/api/tts` to `{ id }` (RT5). Until then the staff page sends only the fixed sentence text from the server's speak plan.
7. P2 is asked to add `preloadSigns(bundle)` to `web/lib/avatar/lookup.ts` and to run one avatar rehearsal under the Report-Only nonce CSP.
8. Talha is asked to accept or decline adding `GET /avatar/bellhop.glb` to the D6 guest path list.
9. New environment variables for `.env.example`: `BRIDGE_KEY`, `LAN_IP`, `LAN_NET`, `DESK_NAME`, `GUEST_PORT` (3443), `TLS_KEY_FILE`, `TLS_CERT_FILE`, `TLS_PUBLIC_KEY_FILE`, `TLS_PUBLIC_CERT_FILE`, `GUEST_IPS`, `IDLE_WIPE_MS`, `SESSION_CAP_MS`, `PAIR_CODE_TTL_MS`, `SB_SIMULATE`, `VLM_FALLBACK`, `ENGLISH_FALLBACK`, `BENCHMARK_CLEARED_FILE`, `VRI_LABEL`, `VRI_URL`, `VRI_PHONE`, `EMERGENCY_NOTE`, `KIOSK`. `GUEST_LAN` is removed. No variable uses the `NEXT_PUBLIC_` prefix.
10. The draft's RT2 (mkcert), RT3 (`?t=` ticket) and RT7 (per-gloss `/signs` with a session) are superseded by decision record D5 and D6, as section 0 records.

---

## 15. Open questions

1. Does Talha accept `/avatar/bellhop.glb` on the guest listener, or should the guest use the `hologram` style?
2. Are the provisional harm-weighted bars (0.75 for YES, NO, NAME, ROOM, HELP) acceptable for the demo, or should they wait for calibration on held-out recordings?
3. Should "ROOM HELP" stay as "There's a problem with my room," or become a neutral phrase? It is a high-severity confusion; the guest confirms it either way.
4. Which VRI provider name and phone number do we show, and what text-to-911 note applies where the demo happens?
5. Is the 15-minute cap right for a check-in, and should extensions be unlimited?
6. Will the Mode C guest device be the team iPad (Safari: no Compute Pressure, so no device-health hint) or a wiped laptop with Chrome?
7. Does step 0 show that `__Host-` cookies work on `http://127.0.0.1` in the demo browser?
8. Do we tell the expert testers that full control of the guest device is assumed (compromised_device.md open question)?
