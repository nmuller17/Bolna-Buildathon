# SignBridge app plan (P4, branch p4-app)

This is the build plan for the SignBridge web app: the staff screen on the laptop, the guest screen on a phone or a second laptop, the server that connects them, and the security and privacy controls around them. Two builders should be able to work in parallel from this document and from the shared types in `web/lib/app/types.ts`. Where this plan changes a protected contract from CLAUDE.md section 6, the change is listed in section 15 and logged in `docs/requests.md`.

Throughout the product and this plan, SignBridge is a "front-desk communication aid". The software is never called an "interpreter"; the only interpreter is the human one the guest can ask for.

---

## 1. Goals and non-goals

### Goals

The app has to carry the CLAUDE.md section 9 demo end to end on two devices. The receptionist works on the laptop at `http://127.0.0.1:3000/staff`. The guest scans a QR code from the staff screen and follows the conversation on their own phone, or on a second laptop. A desk camera on the laptop feeds Python MediaPipe and P3's classifier, which posts recognized signs to the app over loopback. The guest device only displays and takes taps and typing; it never uses a camera or a microphone.

The scripted path must be reliable without any cloud service. Every one of the 20 receptionist sentences can be sent with one tap (a quick reply), and every one of the 20 guest requests is matched from a fixed table, so the whole demo can run with no network vendor at all. Speech-to-text, the gloss service, ElevenLabs and Claude are improvements on top of that path, never requirements for it.

The guest stays in control. Recognized signs are shown to the guest as words with their confidence, and nothing is spoken at the desk until the guest taps "Say it". The guest's first screen offers signing, typing and a human interpreter as equal choices, and typing and an emergency button stay visible on every guest screen.

The security and privacy claims must be real and testable: staff functions only from the laptop itself, guest functions only with a valid, expiring, single-device token, no secrets in the browser, nothing written to disk, nothing logged about what people said, and a privacy panel whose numbers come from real counters.

### Non-goals

The app does not handle video. There is no `<video>` element and no camera permission anywhere in the web app; the desk camera belongs to P3's Python process. The app does not run sign recognition, train models or render the avatar itself; it consumes P3's predictions and P2's `playGloss` when they exist and falls back otherwise. It does not persist anything: there is no database, no file, and no browser storage of conversation content. It does not support more than one guest at a time, more than one desk, user accounts, or HTTPS (HTTPS via mkcert is a documented stretch in section 13). It does not translate free signing; recognition is the closed 22-label vocabulary.

---

## 2. Devices, network and process layout

```
 LAPTOP (front desk)                                                     GUEST DEVICE
 ┌──────────────────────────────────────────────────────────────┐        (phone or 2nd laptop)
 │ Desk camera ─► Python MediaPipe + classifier (P3)            │        ┌──────────────────┐
 │                 │  POST /api/guest/signs  (loopback,          │        │ /guest page      │
 │                 │  X-Bridge-Key)                               │        │ captions, sign   │
 │                 ▼                                              │  LAN   │ cards or avatar, │
 │ node web/server.mjs ──► Next.js 16 app (one process)  ◄────────┼────────┤ proposal + Say it│
 │   binds 127.0.0.1 (default) or 0.0.0.0 (GUEST_LAN=1)          │ HTTP   │ Type, Emergency  │
 │                 ▲  SSE + POST (loopback)                      │        └──────────────────┘
 │ Browser: /staff (mic, speaker, quick replies, dashboard)     │
 │ Recognizer health: GET RECOGNITION_URL/health (127.0.0.1:8000)│
 └──────────────────────────────────────────────────────────────┘
          │ optional, staff data only unless stated: OpenAI (P1 transcribe),
          ▼ Anthropic (P1 gloss; P4 english fallback, OFF by default), ElevenLabs (P4 tts, fixed ids)
```

For the demo the laptop and the guest device share an isolated network, preferably a phone hotspot or a travel router that nobody else joins. Guest traffic crosses that network as plain HTTP, which is acceptable only because the network is isolated and the guest device carries no camera data; section 13 describes the HTTPS stretch. Tunnels such as ngrok are not allowed.

Two practical points must be tested early. First, macOS asks whether Node may accept incoming connections the first time the server binds `0.0.0.0`; allow it. Second, a phone that is itself the hotspot can usually reach the laptop on that hotspot, but this should be checked on the actual phones in hour one (open question 6).

---

## 3. Design direction

The visual idea is hotel lobby wayfinding signage: the deep navy and white of a lobby directory board with brass key-tag details. It belongs to the hotel world rather than to a generic dashboard.

| Token | Value | Use |
|---|---|---|
| `--navy` | `#0E2A47` | Guest screen background; staff headers |
| `--white` | `#FFFFFF` | Guest text (contrast with navy about 14:1) |
| `--brass` | `#E2B33C` | Primary guest action ("Say it") with navy text; the 0.6 threshold line; key-tag fill |
| `--ink` | `#142235` | Staff body text on white |
| `--paper` | `#FFFFFF` with `--rule` `#D5DCE5` | Staff background and dividers |
| `--alarm` | `#B3261E` | Emergency only, always with white text and an icon plus words |

The single memorable element is the key tag. Every sign gloss, whether in the staff-to-guest sign cards or in the recognized signs on the guest screen, is drawn as a brass hotel key tag: a rounded rectangle with a punched hole at the left and the gloss word in capitals. Everything else stays quiet and disciplined.

The typeface is Atkinson Hyperlegible Next, designed by the Braille Institute for legibility, loaded through `next/font/google`, which self-hosts the files at build time so the guest page makes no request to Google at run time; the fallback stack is `system-ui, sans-serif`. Guest captions are set with `clamp(2rem, 7vw, 4rem)` on phones and up to 4rem on laptops, with line length capped at about 28 characters per line on phones; guest buttons are at least 64 px tall. Staff body text is 16 px and the confirmed guest sentence on the staff screen is 40 px.

Information is never carried by colour or sound alone. A confidence bar below 0.6 is hatched and labelled "below 0.6", alerts flash a banner with words and an icon in addition to any tone, and `prefers-reduced-motion` turns flashing into a solid banner. Copy is plain English in sentence case; gloss tokens are the one place capitals are used, and the guest screen explains them once: "Words in capitals are sign names."

---

## 4. Screen-by-screen specification

### 4.1 Staff screen (`/staff`, laptop 1440x900, loopback only)

The staff screen is a three-column dashboard that a receptionist can read at a glance. The left column is for talking to the guest, the middle column is the conversation, and the right column is the status of the system.

```
+--------------------------------------------------------------------------------------------------+
| SignBridge  front-desk communication aid      Guest phone: connected   Recognizer: up   [End guest] |
|                                               Idle wipe in 1:42                                    |
+-------------------------------+----------------------------------------+-------------------------+
| Talk to the guest             | Conversation (memory only)             | Last signs              |
| [   Hold to talk   ]          | 10:02 You   Welcome!                    | WHERE     ████████|  .92|
| or type: [______________][Send]          [HELLO][WELCOME]  quick reply | ELEVATOR  █████▋  |  .71|
| Speech-to-text: OpenAI (P1)   | 10:02 Guest Yes, I have a reservation. |  alternatives: TIME .12 |
|                               |       YES .94  RESERVATION .88          |           0.6 line ↑    |
| Quick replies                 | 10:03 Sign again requested (unclear)   | Repeats 1   Sign->shown |
| [Welcome!]   [Reservation?]   |                                        | 140 ms (incl. return)   |
| [Your name?] [See your ID?]   | +------------------------------------+ +-------------------------+
| [How many nights?] [Room 412] | | Guest says                         | | Pair a guest            |
| [Key card]   [Elevator left]  | | Where is the elevator?             | |  [QR 240px]  code valid |
| [Breakfast 7-10] [Wi-Fi]      | | WHERE .92  ELEVATOR .71  [Speak again]| | 4:12  http://192.168.. |
| [Checkout 11] [Late checkout] | +------------------------------------+ | [New code]              |
| [Towels] [Parking] [Restaurant]|                                       +-------------------------+
| [Taxi] [One moment] [Repeat?] |                                        | Privacy (this guest)    |
| [Anything else?] [Enjoy stay] |                                        | Cloud calls: 0          |
|                               |                                        | Guest data off laptop 0 B|
| [Simulate guest signs ▸] (dev)|                                        | Messages relayed 14     |
|                               |                                        | Files written: none     |
|                               |                                        | Video: none in this app |
|                               |                                        +-------------------------+
|                               |                                        | Benchmark               |
|                               |                                        | No real-data benchmark  |
|                               |                                        | yet.                    |
+-------------------------------+----------------------------------------+-------------------------+
```

Before anything else, the staff screen shows a single "Start desk" button. Pressing it is the user gesture that unlocks audio (speech synthesis, the alert tone and TTS playback), opens the staff event stream, and starts the recognizer health display. Without a guest session, the left and middle columns are disabled and the right column shows a large "New guest" button that creates a session and its QR code.

The left column holds the hold-to-talk button, a text field for typing a sentence, and the 20 quick-reply buttons for vocabulary.md section 1. A note under the talk button says where speech goes ("Speech-to-text: OpenAI, via the P1 route"), and if the Web Speech fallback is in use it says "Speech recognition: your browser's vendor (audio leaves this laptop)". The dev-only "Simulate guest signs" panel opens from the bottom of this column (section 4.5).

The middle column is the conversation log, newest at the bottom, kept in memory only. Staff lines show the English text and the gloss as small key tags with the gloss source ("quick reply", "gloss service", "matched", "captions only"). Guest lines show the confirmed sentence, the signs with their confidences, and the source ("from table" or "suggested wording, confirmed by guest" for the LLM fallback). Typed guest messages and repeat requests appear as their own lines. Under the log, the latest guest sentence is shown at 40 px with a "Speak again" button.

The right column shows the last recognized signs as horizontal confidence bars with a brass line at 0.6 and the top-3 alternatives in small text, the repeat counter, the two latency figures, the pairing panel (QR code, the URL in groups of four characters for typing on a second laptop, the expiry countdown and "New code"), the privacy panel, and the benchmark card. A header strip shows guest-device connection, recognizer status, the idle-wipe countdown, a "SIMULATED" badge when the last signs came from the simulator, and the "End guest" button.

Alerts take over the top of the screen. An emergency shows a full-width red banner, "Guest needs staff now", with a repeating tone until the receptionist presses "I'm coming", which sends `staff_ack` to the guest. An interpreter request shows a navy banner with the configured VRI name, link and phone number and an "I'm on it" button. A typed guest message shows a brass banner with the text.

### 4.2 Pairing

Pairing turns a QR code on the staff screen into a guest device that is bound to one session.

1. Staff presses "New guest". The server ends any previous session, creates a new one, and returns a single-use pairing code of 128 random bits, valid for 5 minutes.
2. The staff screen draws the QR code for `http://<host>:3000/guest?s=<code>` (the host is the LAN IP when `GUEST_LAN=1`) and prints the same URL in groups of four characters.
3. The guest scans it, or types it on a second laptop. The guest page reads `s`, immediately removes it from the address bar with `history.replaceState`, and calls `POST /api/guest/join`.
4. The server checks the code in constant time, burns it, and returns a fresh 256-bit guest token that only this device holds. The staff header changes to "Guest device connected".
5. A second device that scans the same code gets "This code was already used. Ask the front desk for a new one." If the guest's device loses its token (for example the tab was closed), staff presses "New code" (`repair`), which revokes the old guest token and keeps the conversation.

The guest token is kept in memory and in `sessionStorage` of that tab only (wrapped in try/catch), so a page reload reconnects; it is cleared on `session_end`. It is sent in the `X-Session-Token` header on POSTs and as the `s` query parameter on the event stream, because `EventSource` cannot send headers. The server never logs URLs, and every response sets `Referrer-Policy: no-referrer`.

### 4.3 Guest first screen (`/guest`, phone 390x844 and laptop 1440x900)

```
 PHONE 390x844                         LAPTOP 1440x900
+----------------------------+        +-------------------------------------------------------------+
| SignBridge · front desk    |        | SignBridge front desk                     [Emergency: staff] |
|                            |        |                                                             |
| How would you like to talk |        |  How would you like to talk with the front desk?            |
| with the front desk?       |        |                                                             |
|                            |        |  +----------------+ +----------------+ +------------------+ |
| +------------------------+ |        |  | Sign           | | Type           | | Ask for a human  | |
| | Sign                   | |        |  | The desk camera| | Your messages  | | interpreter      | |
| | The desk camera reads  | |        |  | reads your     | | appear on the  | | Staff will set   | |
| | your hands             | |        |  | hands          | | staff screen   | | up video relay   | |
| +------------------------+ |        |  +----------------+ +----------------+ +------------------+ |
| +------------------------+ |        |                                                             |
| | Type                   | |        |  What happens to my data:                                   |
| +------------------------+ |        |  Video stays on the desk laptop. Nothing is saved. You      |
| +------------------------+ |        |  confirm every sentence before it is spoken.                |
| | Ask for a human        | |        |                                                             |
| | interpreter            | |        |                                                             |
| +------------------------+ |        |                                                             |
| What happens to my data ▸  |        |                                                             |
|----------------------------|        |                                                             |
| [ Emergency: need staff ]  |        |                                                             |
+----------------------------+        +-------------------------------------------------------------+
```

The three choices are equal in size and order: Sign, Type, Ask for a human interpreter. Under them is a short data notice: the camera is on the desk laptop and the video stays there; nothing is saved; the guest confirms every sentence before it is spoken; typed messages and names never go to a cloud service; the conversation is wiped when the guest leaves or after two minutes without activity. The emergency button is always visible at the bottom.

Choosing "Sign" sends `guest_choice: sign`. Only after this choice does the server accept recognizer posts for the session (consent gate, section 10). Choosing "Type" opens the text field. Choosing "Ask for a human interpreter" alerts staff and shows the configured VRI provider name, link and phone number, with a note that a video relay call sends the guest's video to that provider. The guest can switch modes at any time from the bottom bar.

Without a valid code or token, the page shows only "Scan the code at the front desk to start."

### 4.4 Guest conversation screen

```
 PHONE 390x844                         LAPTOP 1440x900
+----------------------------+        +------------------------------+------------------------------+
| Front desk said            |        | Front desk said              | You                          |
| The elevator is on         |        | The elevator is on your      | Signing is on. The desk      |
| your left.                 |        | left.                        | camera reads your hands.     |
| (aria-live, 2-4rem)        |        |                              | [Stop signing]               |
| [ELEVATOR][THERE][LEFT]    |        | [ELEVATOR] [THERE] [LEFT]    |                              |
|  key-tag cards, or avatar  |        |  sign cards or avatar        | We saw these signs           |
|----------------------------|        |                              | [WHERE] sure 92%             |
| We saw these signs         |        | Words in capitals are sign   | [ELEVATOR] fairly sure 71%   |
| [WHERE] sure 92%           |        | names.                       |                              |
| [ELEVATOR] fairly sure 71% |        |                              | "Where is the elevator?"     |
| "Where is the elevator?"   |        |                              | [   Say it   ] [   Fix   ]   |
| [   Say it   ] [  Fix  ]   |        |                              |                              |
|----------------------------|        |                              |                              |
| [Type] [Sign] [Emergency]  |        | [Type] [Interpreter]         |         [Emergency: staff]   |
+----------------------------+        +------------------------------+------------------------------+
```

Captions come first. The latest staff sentence is the largest text on the page, inside an `aria-live="polite"` region, with the gloss below it as key-tag sign cards or the avatar. Older staff sentences scroll above in smaller type.

The guest panel shows the signing state and the current proposal. A matched proposal shows the recognized signs as key tags with "sure" (at least 0.8), "fairly sure" (0.6 to 0.8) and the percentage, then the sentence in quotes, then two large buttons. "Say it" (brass) confirms and sends; "Fix" opens "Sign again" and "Type instead". For the NAME intent, the proposal shows "My name is ..." with a text field labelled "Type your name"; "Say it" is enabled once the name passes the sanitizer, and an invalid name shows "Use letters, spaces, hyphens or apostrophes, up to 40 characters." An unmatched result shows "We saw: TAXI WHERE" and the message "That doesn't match a request we know," with "Sign again" and "Type instead". A repeat request replaces the panel with "Please sign that again" and shows which sign was unclear; after three repeats in a row "Type instead" becomes the primary button. After "Say it", the panel shows "Sent to the front desk" and whether it was read aloud.

A small toggle in the guest panel, "Read my sentences aloud at the desk", defaults to on; when off, the staff laptop shows the text without speaking it. The bottom bar always holds Type, Sign or Stop signing, Interpreter and Emergency. Emergency shows "Staff has been alerted" and, once staff acknowledges, "Staff is coming", plus the configured text-to-911 note. When the session ends, every guest screen shows "This conversation has ended. Nothing was saved."

There is no autoplay sound on the guest device and nothing depends on hearing. On Android, alerts may also vibrate. The Screen Wake Lock API needs HTTPS, so for the demo the phone's auto-lock must be turned off by hand.

### 4.5 Simulate guest signs (staff screen, loopback only, dev or `SB_SIMULATE=1`)

The simulator is a collapsible panel on the staff screen that lets the team rehearse without the camera. It has one button per guest intent (20) that injects that intent's signs at confidence 0.90 each, a "Shuffle order" switch (to show order-insensitive matching), a "Make one sign unclear" switch (sets one sign to 0.45), a "NONE" button, and a free picker of up to 8 labels with confidence sliders. It calls `POST /api/dev/simulate`, which runs the exact same validator, gate, matcher and event pipeline as `/api/guest/signs`, and marks the result `source: "simulated"` so the staff screen shows a "SIMULATED" badge. The route returns 404 when simulation is disabled.

---

## 5. Data flows

### 5.1 Staff to guest

| Hop | From → to | Transport | Data that crosses | Leaves the laptop? |
|---|---|---|---|---|
| S1 | Microphone → staff browser | MediaRecorder | Receptionist audio (webm, memory) | No |
| S2 | Staff browser → `POST /api/transcribe` (P1) | Loopback HTTP | Audio blob | No |
| S3 | `/api/transcribe` → OpenAI Whisper | HTTPS | Receptionist audio | **Yes, staff data**, counted by server.mjs |
| S4 | Staff browser → `POST /api/gloss` (P1) | Loopback HTTP | English text | No |
| S5 | `/api/gloss` → Anthropic | HTTPS | Receptionist text | **Yes, staff data**, counted by server.mjs |
| S6 | Staff browser → `POST /api/staff/action` (`say_text` or `say_quick`) | Loopback HTTP | Text and gloss, or an intent id | No |
| S7 | Server → guest device, `staff_utterance` | SSE over LAN HTTP | Text, gloss tokens, gloss source | LAN only |
| S8 | Guest browser → avatar or sign cards | In page | Gloss | No |
| S9 | Guest browser → `POST /api/guest/action` (`ack`) | LAN HTTP | Event sequence number | LAN only |

A quick reply uses only S6 to S9 and no cloud call. When P1's routes return 501 or fail, the staff types instead of speaking (S1 to S3 skipped), or uses the browser Web Speech API after an on-screen disclosure that audio goes to the browser vendor; the staff browser then reports that use with `note_vendor` so the privacy panel counts it, labelled "reported by the staff browser". When `/api/gloss` returns 501 or fails, the server matches the text deterministically against the 20 staff sentences (normalized: lowercase, curly quotes to straight, punctuation removed, spaces collapsed); a match uses that intent's fixed gloss, and no match sends captions only with an empty gloss.

### 5.2 Guest to staff

| Hop | From → to | Transport | Data that crosses | Leaves the laptop? |
|---|---|---|---|---|
| G1 | Desk camera → Python MediaPipe (P3) | Local | Video frames (never stored by the app; the app never sees them) | No |
| G2 | Classifier → `POST /api/guest/signs` | Loopback HTTP, `X-Bridge-Key` | Labels and confidences only | No |
| G3 | Server: validate → consent gate → confidence gate → match | Memory | Same | No |
| G4a | Server → guest, `guest_proposal` or `repeat_request` | SSE over LAN | Top-1 words with confidence, matched sentence | LAN only |
| G4b | Server → staff, `recognition` (+ `repeat_request`) | SSE loopback | Top-3 per sign, gate result, match | No |
| G5 | Guest → `POST /api/guest/action` `guest_confirm` | LAN HTTP | Proposal id, and the typed name for NAME | LAN only |
| G6 | Server → staff, `guest_utterance` | SSE loopback | Sentence, signs, speak plan | No |
| G7a | Staff browser → speechSynthesis (local voice) | In page | Sentence | No |
| G7b | Staff browser → `POST /api/tts {id}` → ElevenLabs | Loopback, then HTTPS | Fixed sentence for that id (not free text) | **Yes, guest-derived**, counted, unless already cached |
| G8 | Server → guest, `guest_utterance` echo | SSE over LAN | Sentence, spoken-aloud flag | LAN only |

Typed guest text goes guest → `POST /api/guest/action` (`guest_typed`) → staff SSE, and is never sent to any vendor. The guest name goes only to the staff screen and to a local speechSynthesis voice. When `ENGLISH_FALLBACK=1` and a gated batch is unmatched, the server sends the labels only (no name, no typed text) to Anthropic and returns the suggestion as a proposal that the guest must confirm; this is the only place guest-derived bytes reach Claude, and it is counted.

---

## 6. Event and message catalogue

All events travel as Server-Sent Events from `GET /api/events`. Each SSE message has `id: <seq>` and `data: <BusEnvelope JSON>`, with a single event name so `onmessage` handles everything. The server sends `retry: 2000`, a comment heartbeat every 15 seconds, and on every (re)connect a `snapshot` so the client never needs replay. The guest and staff unions in `types.ts` are separate, and the server builds guest messages only from the guest union, so staff-only fields cannot reach the guest device by accident.

| Type | Guest gets | Staff gets | Produced by | Notes |
|---|---|---|---|---|
| `hello` | yes | no | guest join and stream open | VRI details, idle time, emergency note |
| `snapshot` | yes (mode, last caption, pending proposal) | yes (status, log, pairing, last recognition) | every stream open | replaces replay |
| `session_start` | no | yes | `new_guest`, `repair` | pairing info for the QR |
| `staff_utterance` (6.7, extended) | yes | yes | `say_quick`, `say_text` | id, text, gloss, glossSource; staff also gets captionSource and intentId |
| `recognition` | no | yes | signs ingest | top-3 per sign, gate result, match, source |
| `repeat_request` (6.7, extended) | yes: reason, top-1 words, weak indexes, streak | yes: reason, count, streak | gate failure | guest sees "Please sign that again" |
| `guest_proposal` | yes | no (staff sees `recognition`) | gate pass | match null = unmatched |
| `guest_utterance` (6.7, extended) | echo: text, spokenAloud | yes: signs, text, intentId, source, speak plan | `guest_confirm` | staff laptop speaks per speak plan |
| `guest_fix` | no | yes | `guest_fix` | sign again or type |
| `guest_typed` | no | yes | `guest_typed` | shown as a banner and log line |
| `guest_choice` | no | yes | `guest_choice`, `stop_signing`, `prefs` | mode and speak-aloud setting |
| `interpreter_request` | no | yes (with VRI info) | `interpreter_request` or choice | staff banner |
| `emergency` | no | yes | `emergency` | red banner and tone until ack |
| `staff_ack` | yes | yes | staff `ack` | "Staff is coming" on the guest device |
| `idle_warning` | yes | yes | sweeper, 30 s before wipe | any tap keeps the session |
| `session_end` | yes | yes | `end_guest`, idle wipe, `repair` (guest only, reason `repaired`) | clients clear all state |
| `status` | no | yes, every 2 s and on change | server | recognizer, guest connection, counters, privacy, latency, flags |

`guest_confirm` is a guest action, not an event; its result is `guest_utterance`. The BroadcastChannel in `web/lib/channel.ts` is superseded by this bus because the two screens are on different devices; the file becomes a thin client helper that wraps `EventSource` and the action POSTs.

---

## 7. API route catalogue

"Loopback" means the request reached `server.mjs` from 127.0.0.1, ::1 or ::ffff:127.0.0.1. Every route also passes the Host allowlist and, for state-changing requests, the same-origin check (section 10). Error bodies are `ApiError` from `types.ts`, and API responses carry `Cache-Control: no-store`.

| Method and path | Who may call | Request | Response | Body cap, type | Status codes |
|---|---|---|---|---|---|
| `GET /staff` (page) | Loopback | — | HTML | — | 200; 403 if not loopback |
| `GET /guest` (page) | Anyone on an allowed Host | `?s=<code>` optional | HTML (no data without a token) | — | 200 |
| `GET /api/events?role=staff` | Loopback | — | `text/event-stream` of `StaffEvent` | — | 200; 403; 429 when stream limit reached |
| `GET /api/events?role=guest&s=<guestToken>` | Valid guest token | — | `text/event-stream` of `GuestEvent` | — | 200; 401; 429 |
| `POST /api/staff/action` | Loopback, same origin | `StaffAction` | `StaffActionResponse` | 4 KB, `application/json` | 200; 400; 403; 409 (no session for say/ack); 413; 415 |
| `GET /api/staff/benchmark` | Loopback | — | `BenchmarkResponse` | — | 200; 403 |
| `POST /api/guest/join` | Anyone on an allowed Host | `GuestJoinRequest` | `GuestJoinResponse` | 4 KB, json | 200; 400; 410 (used or expired); 413; 415; 429 (10/min per server) |
| `POST /api/guest/action` | Valid `X-Session-Token` | `GuestAction` | `GuestActionResponse` | 4 KB, json | 200; 400; 401; 409 (stale proposal, wrong mode); 413; 415; 429 (30/min per session, `ack` exempt up to 120/min) |
| `POST /api/guest/signs` | Loopback + `X-Bridge-Key` | `SignsPayload` | `SignsIngestResponse` | 8 KB, json | 200; 400; 401; 403; 409 (no session or guest not signing); 413; 415; 429 (10/s); 503 (BRIDGE_KEY missing or under 32 chars) |
| `GET /api/guest/signs` | Loopback + `X-Bridge-Key` | — | `{ accepting: boolean }` so P3 can pause the camera | — | 200; 401; 403 |
| `POST /api/dev/simulate` | Loopback, same origin, simulation enabled | `SignsPayload` | `SignsIngestResponse` | 8 KB, json | as `/api/guest/signs`; 404 when disabled |
| `POST /api/transcribe` (P1) | Loopback (enforced by server.mjs) | audio webm | `{ text }` | 5 MB checked by server.mjs on Content-Length; `audio/webm` | P1's; 501 until implemented |
| `POST /api/gloss` (P1) | Loopback (server.mjs) | `{ text }` | `{ gloss }` | 4 KB, json | P1's; 501 until implemented |
| `POST /api/english` (P4) | Loopback, `ENGLISH_FALLBACK=1` | `{ signs: RawPrediction[] }` (labels only) | `{ text }` | 8 KB, json | 200; 400; 403; 404 when off; 429 (10/min); 502 |
| `POST /api/tts` (P4) | Loopback, same origin | `{ id: GuestIntentId }` | `audio/mpeg` | 4 KB, json | 200; 400; 403 (id 4, NAME, or anything not a fixed id); 404 when no ElevenLabs key; 429 (20/min); 502 |

The ingest logic sits in one function, `ingestSigns(payload, source)`, used by both `/api/guest/signs` and `/api/dev/simulate`, and in-process by `/api/english` when the fallback is on. `/api/tts` caches each fixed sentence's audio in memory (never on disk) after the first call, and the `prewarm_tts` staff action fetches all 19 fixed sentences before a guest arrives, so that during the conversation no guest-derived bytes leave the laptop.

### Payload validation for `/api/guest/signs`

The body must be a JSON object with exactly the key `signs`, holding an array of 1 to 8 elements. Either every element is a `RawPrediction` (`{label, conf}`, shape A) or every element is `{top: RawPrediction[]}` with 1 to 5 entries (shape B); mixing shapes is a 400. Every label must be one of the 22 labels exactly (case-sensitive, no trimming), and every `conf` must be a finite number in [0, 1]. Extra keys anywhere are a 400. Shape B arrays are sorted by `conf` descending on the server rather than trusting the sender's order.

### Gate and match

For each sign the top-1 prediction is `top[0]` after sorting. If any top-1 label is `NONE`, the result is `repeat_request` with reason `none_sign`. Otherwise, if any top-1 confidence is below 0.6 (0.6 itself passes), the result is `repeat_request` with reason `low_confidence` and the indexes of the weak signs. Otherwise the top-1 labels are matched as a multiset against the 20 guest intents: the labels are sorted and joined, and compared with each intent's sorted signs, so `ELEVATOR WHERE` matches intent 6 just like `WHERE ELEVATOR`, and a duplicated sign does not match a single one. The 20 multisets in vocabulary.md section 2 are all distinct, which a unit test asserts. A match becomes a `guest_proposal` with the fixed sentence; for intent 4 (NAME), `needsName` is true. No match becomes an unmatched proposal, or, with `ENGLISH_FALLBACK=1`, an LLM suggestion that still needs confirmation. There is no fuzzy or second-choice matching in this version (open question 3).

### Guest name and typed text

A name is normalized to NFC, trimmed, has inner whitespace collapsed to one space and curly apostrophes mapped to `'`, and must then match `^[\p{L}\p{M}' -]{1,40}$` (Unicode letters including accented ones, combining marks, spaces, hyphen, apostrophe) and contain at least one letter; anything else is rejected rather than silently stripped, so the guest sees what will be said. The sentence becomes `My name is <name>.`, its speak plan is always `local`, and `/api/tts` refuses id 4. Typed guest text is NFC-normalized, has control characters removed, and is limited to 280 characters; it is displayed as text with React escaping and spoken only if the staff presses "Read aloud", with a local voice.

---

## 8. Session, pairing and idle-wipe lifecycle

```
           New guest                     join (code ok, burned)
 NO_SESSION ─────────► AWAITING_PAIR ───────────────────────────► ACTIVE ◄──────────┐
     ▲                   │  code expires (5 min):                  │   any activity  │
     │                   │  staff sees "Code expired, New code"    │   resets timer  │
     │                   ▼                                         │                 │
     │              (stays, code invalid)       repair ───────────►│ AWAITING_PAIR   │
     │                                          (old guest token   │ (log kept)      │
     │                                           revoked)          ▼                 │
     │                                              90 s idle: idle_warning ─ tap ───┘
     │   End guest (any state) / 120 s idle                         │
     └──────────────────────────────── WIPED ◄──────────────────────┘
```

There is at most one session. The store lives on `globalThis[Symbol.for("signbridge.store.v1")]` so it survives dev hot reloads, and it holds the session (pairing code hash and expiry, guest token, mode, speak-aloud setting, pending proposal, log, counters, the ring of SSE subscribers) plus server-lifetime privacy counters and the recognizer status.

Activity is any guest action except `ack`, any staff action, and any accepted signs batch. SSE heartbeats, acks, status polls and stream reconnects are not activity. A sweeper (`setInterval`, `unref`'d, every second) sends `idle_warning` 30 seconds before the wipe and wipes after `IDLE_WIPE_MS` (default 120000) without activity. The idle timer runs only in ACTIVE; in AWAITING_PAIR the pairing code's own expiry applies.

Wiping means sending `session_end` to every stream, closing the guest streams, overwriting and dropping the session object (log, names, typed text, proposals, tokens), and resetting the "this guest" counters. The server-lifetime counters (`sinceStart`) stay because they contain no personal data. Clients react to `session_end` by clearing their state and the guest's `sessionStorage` token. A server restart loses everything, which is intended; the guest page then shows "This conversation has ended."

---

## 9. Server and Next.js 16 specifics

This section records what was checked in `web/node_modules/next/dist/docs` for Next 16.4, so builders do not rely on memory.

- **Why a custom server.** In Next 16, Middleware is renamed Proxy (`proxy.ts`, Node runtime by default), but neither Proxy nor Route Handlers expose the socket address (`request.ip` was removed in Next 15), so the only reliable source of the client address is the Node socket. The documented custom server (`next({ dev, hostname, port, httpServer })` plus `http.createServer`) gives us `req.socket.remoteAddress`. We pass `httpServer` so dev HMR upgrades work. Custom servers cannot be combined with `output: "standalone"`, which we do not use.
- **What server.mjs does, in order, before calling `handle(req, res)`.** It deletes every incoming header whose name starts with `x-sb-`. It checks the Host header against the allowlist (`localhost:PORT`, `127.0.0.1:PORT`, `[::1]:PORT`, and `LAN_IP:PORT` when `GUEST_LAN=1`) and answers 403 otherwise. It computes loopback from `req.socket.remoteAddress` (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`) and sets `x-sb-loopback: 1|0` and `x-sb-proof: <SB_PROOF>`, where `SB_PROOF` is 32 random bytes generated at start-up and placed in `process.env` before `next()` is created. For a non-loopback client it allows only an explicit list of paths (`/guest`, `/api/guest/join`, `/api/guest/action`, `/api/events`, `/_next/static/*`, `/favicon.ico`, and in dev the rest of `/_next/*` for HMR) and answers 403 to everything else, including `/staff`, `/api/staff/*`, `/api/guest/signs`, `/api/dev/*`, `/api/transcribe`, `/api/gloss`, `/api/english` and `/api/tts`. It rejects a `Content-Length` above 5 MB for `/api/transcribe` and above 8 KB elsewhere with 413. It sets the security headers (section 10). It counts requests to the P1 routes and their response status on `finish` for the privacy panel. It never logs URLs, headers or bodies.
- **Route-level defence in depth.** Every route handler and the staff page call `guard()` from `web/lib/app/guard.server.ts`, which trusts `x-sb-loopback` only when `x-sb-proof` equals `process.env.SB_PROOF` in constant time. If the app is started with plain `next dev`, `SB_PROOF` is absent and every loopback-only route fails closed with 403.
- **Binding.** `server.mjs` listens on `127.0.0.1` by default. With `GUEST_LAN=1` it listens on `0.0.0.0`, takes `LAN_IP` from the environment or detects the first non-internal IPv4 address, sets `process.env.LAN_IP` before `next()` (so `next.config.ts` sees it), and prints the guest URL with a warning to use an isolated network.
- **next.config.ts.** `compress: false` (gzip would buffer SSE; the LAN app does not need it), `poweredByHeader: false`, `logging: { incomingRequests: false }` (dev request logging would print pairing codes and tokens), and `allowedDevOrigins: [process.env.LAN_IP]` when set, because Next 16 blocks cross-origin requests to dev assets and the guest phone would otherwise fail in dev.
- **Async request APIs.** In Next 16, `headers()`, `cookies()`, `params` and `searchParams` are async only; always `await` them.
- **`server-only`.** Next resolves `import "server-only"` internally, so no package is needed. Modules that are unit-tested under plain Node must not import it. The rule is: a `*.server.ts` module imports `server-only` and holds only wiring (env, the globalThis singleton, real vendor calls); the logic it uses lives in a sibling pure module that takes its clock, random source, config and `fetch` as arguments, and that pure module is what the tests import (section 12).
- **SSE route.** `export const dynamic = "force-dynamic"`, return a `Response` around a `ReadableStream`, headers `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`, and unsubscribe on `request.signal` abort.
- **package.json.** Scripts: `"dev": "NEXT_TELEMETRY_DISABLED=1 node server.mjs"`, `"dev:lan": "NEXT_TELEMETRY_DISABLED=1 GUEST_LAN=1 node server.mjs"`, `"build": "NEXT_TELEMETRY_DISABLED=1 next build"`, `"start": "NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production node server.mjs"`, `"start:lan"` likewise with `GUEST_LAN=1`, `"test": "node --test --disable-warning=ExperimentalWarning lib/app/"`. Add `"type": "module"` (Node otherwise warns that the TypeScript test files are ESM in a typeless package) and `"engines": { "node": ">=22.18" }` for unflagged type stripping. Add `allowImportingTsExtensions: true` to `tsconfig.json` so tested modules can import each other with `.ts` extensions, which Node requires. The only new dependency is `qrcode` (render its `QRCode.create()` module matrix as React `<rect>` elements; never inject its SVG string).
- **Demo mode.** Run the demo from a production build (`npm run build && npm run start:lan`): it is faster, has no HMR socket on the LAN, and has no dev overlay. Use `dev:lan` only for building.

---

## 10. Security controls mapped to tests

| # | Control | Where | Test (U = node:test unit, S = curl smoke script `web/scripts/smoke.sh` against a running server, M = manual) |
|---|---|---|---|
| 1 | Loopback decision from the socket, never from X-Forwarded-For | `lib/app/access.ts` `isLoopback(addr)`; server.mjs | U: `127.0.0.1`, `::1`, `::ffff:127.0.0.1` are loopback; `192.168.1.5`, `::ffff:192.168.1.5`, `127.0.0.1.evil`, `""`, undefined are not. S: a request from the LAN IP with `X-Forwarded-For: 127.0.0.1` to `/staff` gets 403 |
| 2 | Incoming `x-sb-*` headers stripped; proof check | server.mjs, `guard.server.ts` | U: `guardDecision` denies when proof is missing or wrong even if loopback=1. S: `curl -H 'x-sb-loopback: 1'` from the LAN gets 403 |
| 3 | Non-loopback path allowlist (default deny) | `access.ts` `lanPathAllowed(pathname, dev)` | U: allowed `/guest`, `/api/guest/join`, `/api/guest/action`, `/api/events`, `/_next/static/x.js`; denied `/staff`, `/staff/`, `/api/staff/action`, `/api/guest/signs`, `/api/dev/simulate`, `/api/tts`, `/api/transcribe`, `/%2e%2e/staff`, `/guest/../staff` |
| 4 | Host header allowlist (blocks DNS rebinding) | `access.ts` `hostAllowed(host, cfg)` | U: `evil.com:3000`, `127.0.0.1:3001`, missing host denied. S: `curl -H 'Host: evil.com'` gets 403 |
| 5 | Same-origin for state-changing requests (CSRF from a site open in the staff browser) | `guard.server.ts` | U: `Origin: http://evil.com` denied; `Sec-Fetch-Site: cross-site` denied; JSON content type required. S: cross-origin POST to `/api/staff/action` gets 403 |
| 6 | Content-type allowlist per route | `guard.server.ts` | S: `text/plain` to each JSON route gets 415 |
| 7 | Body caps with a capped reader (not `req.json()`) | `lib/app/body.ts` | U: 8193-byte body rejected; chunked body without length over the cap rejected. S: 413 on each route |
| 8 | Rate limits per session and route | `lib/app/ratelimit.ts` | U: fixed-window counter with an injected clock. S: 31st guest action in a minute gets 429 |
| 9 | Pairing code and guest token: 128 / 256 random bits, constant-time compare, single use, expiry, revocation | `lib/app/tokens.ts` | U: length and alphabet; `safeEqual` false on different lengths without throwing; a used code returns `gone`; an expired code returns `gone`; after `repair` the old token is rejected; after `end_guest` and idle wipe every token is rejected |
| 10 | X-Bridge-Key constant time; fail closed without a 32+ char key | `guard.server.ts` | U: missing, wrong, short-config cases. S: 401 without the key, 503 with `BRIDGE_KEY` unset |
| 11 | Strict signs validator | `lib/app/validate.ts` | U: all 22 labels accepted; `yes`, `YES `, `<script>`, `FS:WIFI` rejected; conf `NaN`, `Infinity`, `-0.01`, `1.01`, `"0.9"` rejected; 0 and 9 signs rejected; mixed shapes rejected; extra keys rejected; top length 0 and 6 rejected |
| 12 | Gate | `lib/app/match.ts` | U: 0.6 passes, 0.5999 fails, NONE fails even at 0.99, weak indexes correct, shape B unsorted input sorted |
| 13 | Order-insensitive multiset match for all 20 guest intents | `lib/app/match.ts`, `lib/app/vocab.ts` | U: the test parses docs/vocabulary.md section 2 and checks that every row's signs, and every permutation of them, match that row's id and sentence; duplicates and extras do not match; all 20 multisets distinct |
| 14 | Consent gate: no signs accepted until the guest chooses Sign | `ingest.ts` | U (store with injected clock): ingest returns `conflict` in mode `choosing` and `type` |
| 15 | Confirm before speaking | store | U: no `guest_utterance` exists until `guest_confirm`; a stale proposal id returns `conflict` |
| 16 | Name sanitizer | `validate.ts` | U: `José`, `Zoë O'Brien-Smith`, `Nguyễn Văn An`, `Ana  María` (collapsed) accepted; `<b>`, `Robert'); DROP`, `12`, empty, 41 letters, emoji, only spaces rejected |
| 17 | Name and typed text never reach a vendor | store, `/api/tts`, `/api/english` | U: run `guest_confirm` with name `Zq7Canary` and `guest_typed` with `Zq7Canary` through the handlers with an injected `fetch` spy; the spy is never called with a body containing the canary. U: `/api/tts` handler returns 403 for id 4 and for any non-integer or text body |
| 18 | Guest never receives staff-only data | `bus.ts` projection | U: build every event type for the guest audience and assert the JSON has no `top`, `count`, `privacy`, `status`, `recognizer`, `pairing`, `code` keys |
| 19 | No secrets in the browser | repo | U (`repo-hygiene.test.ts`): no `NEXT_PUBLIC_` in web source; every module reading `process.env.*_KEY` imports `server-only`. M: after `next build`, grep `.next/static` for each key value from `.env.local` and expect nothing |
| 20 | No `dangerouslySetInnerHTML`, no file writes, no content logging | repo | U (`repo-hygiene.test.ts`): grep `web/app`, `web/components`, `web/lib/app`, `web/server.mjs` for `dangerouslySetInnerHTML`, `writeFile`, `appendFile`, `createWriteStream`, `localStorage.setItem`, and `console.log(` with request data; expect none (sessionStorage for the guest token only is allowed and listed) |
| 21 | Bind address | server.mjs | M: `lsof -nP -iTCP:3000 -sTCP:LISTEN` shows `127.0.0.1` without `GUEST_LAN`, `*` with it; a curl from the phone is refused without `GUEST_LAN` |
| 22 | Security headers | server.mjs | S: every response has `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Permissions-Policy: camera=(), geolocation=(), microphone=(self)` (`microphone=()` on `/guest`), and the CSP `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`, with `'unsafe-eval'` added to `script-src` in dev only. A nonce-based CSP through `proxy.ts` is the documented stretch |
| 23 | No outbound requests from the guest page | guest page | M: DevTools network panel on `/guest` shows only requests to the laptop |
| 24 | Wipe on End guest and idle | store | U: after wipe the store holds no log, name, typed text or token; the canary string is absent from `JSON.stringify(store)` |

---

## 11. Fallbacks for teammate dependencies

| Dependency | Detection | Fallback | Shown to whom |
|---|---|---|---|
| P1 `/api/transcribe` (Whisper) | 501, network error, or 10 s timeout | Staff types the sentence; or the Web Speech API after a one-time disclosure ("Audio will be sent to your browser's speech service") and a `note_vendor` count; quick replies always work | Staff: "Speech-to-text unavailable, type or use a quick reply" |
| P1 `/api/gloss` (Claude) | 501, error, 5 s timeout, or invalid tokens (not uppercase gloss tokens, more than 40) | Server-side deterministic match to the 20 staff sentences; else captions only with an empty gloss | Staff log shows the gloss source; guest sees captions without sign cards |
| P2 avatar `playGloss` | Runtime check in the swap point: `await import("@/lib/avatar/player")` and `typeof mod.playGloss === "function"`; also a 15 s timeout or a rejected promise | `SignCards`: the gloss as large key-tag cards shown one at a time (about 900 ms each, a 2-second pause at the end, then all cards stay visible). `BROWS-UP` and `BROWS-DOWN` become a small chip ("yes/no question", "question") rather than a card; `FS:WIFI` shows as "W-I-F-I, fingerspelled" | Guest |
| P3 recognizer down | `GET RECOGNITION_URL/health` every 5 s, 1 s timeout; no POST in a while does not mean down | Staff header shows "Recognizer: down"; the guest Sign panel says "Signing is not available right now" and offers Type; the simulator still works for rehearsal | Both |
| P3 sends only top-1 | Shape A | Staff bars show top-1 only and "alternatives not sent" | Staff |
| ElevenLabs missing or failing | No `ELEVENLABS_API_KEY`, or 502 | Local `speechSynthesis` with a voice whose `localService === true`; if none exists, text only and a staff notice "No on-device voice; read the sentence aloud" (never a network voice) | Staff |
| Anthropic for `/api/english` | Flag off (default) or error | Unmatched proposal with "Sign again" or "Type instead" | Guest |

The single avatar swap point is `web/lib/app/signOutput.ts`, which exports `loadSignRenderer(): Promise<"avatar" | "cards">` and `playSigns(gloss, el)`. It is used only by `web/components/guest/SignOutput.tsx`. When P2 ships `playGloss`, nothing else changes. Contract 6.6 does not say where the avatar draws, so the component renders `<div id="sb-avatar">` and the plan asks P2 (section 15) to render into that element or to export `mountAvatar(el)`; the swap point will call `mountAvatar` if it exists. A guest-side switch "Show sign cards instead" lets the guest pick cards even when the avatar works.

---

## 12. File and ownership map

Everything below is P4-owned per the task brief. P1, P2 and P3 paths are only read or imported.

| Path | Purpose | Tested under Node |
|---|---|---|
| `web/server.mjs` | Custom server: header strip, Host allowlist, loopback, proof, LAN path allowlist, body caps, security headers, P1 call counting, bind | via `access.ts` |
| `web/next.config.ts` | `compress: false`, `poweredByHeader: false`, `logging.incomingRequests: false`, `allowedDevOrigins` | — |
| `web/package.json`, `web/tsconfig.json` | Scripts, `type: module`, engines, `qrcode`, `allowImportingTsExtensions` | — |
| `web/lib/app/types.ts` | Shared types and limits (written with this plan) | yes |
| `web/lib/app/vocab.ts` | `STAFF_INTENTS` and `GUEST_INTENTS`, copied from vocabulary.md sections 1 and 2 | yes |
| `web/lib/app/match.ts` | `gate()`, `matchGuest()`, `matchStaffText()`, `normalizeEnglish()` | yes |
| `web/lib/app/validate.ts` | `parseSignsPayload`, `parseGuestAction`, `parseStaffAction`, `parseGloss`, `sanitizeName`, `sanitizeTyped` | yes |
| `web/lib/app/tokens.ts` | `newSecret(bytes)`, `safeEqual(a, b)` (sha256 both, `timingSafeEqual`), `groupForDisplay` | yes |
| `web/lib/app/access.ts` | Pure decisions: `isLoopback`, `hostAllowed`, `lanPathAllowed`, `guardDecision`; imported by server.mjs through Node type stripping | yes |
| `web/lib/app/ratelimit.ts`, `web/lib/app/body.ts` | Fixed-window limiter with injectable clock; capped body reader | yes |
| `web/lib/app/store.ts` | Session lifecycle, sweeper logic, proposals, counters, with injected clock, id generator and fetch | yes |
| `web/lib/app/bus.ts` | Subscribers, envelopes, guest and staff projections, SSE encoding | yes |
| `web/lib/app/ingest.ts` | `ingestSigns(store, payload, source)` | yes |
| `web/lib/app/store.server.ts` | `import "server-only"`; the singleton on `globalThis[Symbol.for("signbridge.store.v1")]`, wiring real clock, crypto and config into `store.ts` | — |
| `web/lib/app/guard.server.ts` | `guard(req, policy)` for route handlers | partly |
| `web/lib/app/recognizer.server.ts`, `benchmark.server.ts`, `tts.server.ts`, `english.server.ts`, `config.server.ts` | Health poll; report reader; ElevenLabs with memory cache; Anthropic fallback (load the `claude-api` skill before writing it); env parsing | partly |
| `web/lib/app/client/` (`useBus.ts`, `actions.ts`, `speech.ts`, `alarm.ts`) | EventSource hook, POST helpers, local voice selection and audio unlock, WebAudio alert tone | — |
| `web/lib/app/signOutput.ts` | Avatar or cards swap point | — |
| `web/lib/channel.ts` | Thin re-export of the client bus helpers, with a comment that BroadcastChannel is superseded | — |
| `web/app/layout.tsx`, `web/app/globals.css` | Font, tokens, base styles | — |
| `web/app/staff/page.tsx`, `web/app/guest/page.tsx` | Pages (staff page awaits `headers()` and returns 403 content when not loopback) | — |
| `web/app/api/events/route.ts`, `api/staff/action/route.ts`, `api/staff/benchmark/route.ts`, `api/guest/join/route.ts`, `api/guest/action/route.ts`, `api/guest/signs/route.ts`, `api/dev/simulate/route.ts`, `api/english/route.ts`, `api/tts/route.ts` | Routes | handlers tested through their pure parts |
| `web/components/staff/*`, `web/components/guest/*`, `web/components/KeyTag.tsx`, `ConfidenceBar.tsx`, `QrCode.tsx`, `SignCards.tsx` | UI | — |
| `web/scripts/smoke.sh` | curl security smoke tests | — |
| `docs/app-plan.md`, `docs/requests.md`, `docs/demo-script.md`, `docs/privacy-notice.md` | Docs | — |

Not touched: `web/lib/avatar/**` (P2), `web/lib/voice/**` and `web/app/api/transcribe|gloss` (P1), `web/lib/recognition/**`, `recognition/**`, `capture/**` (P3).

Configuration lives in `web/.env.local` only (never committed): `BRIDGE_KEY`, `RECOGNITION_URL` (default `http://127.0.0.1:8000`), `GUEST_LAN`, `LAN_IP`, `PORT`, `IDLE_WIPE_MS`, `PAIR_CODE_TTL_MS`, `ENGLISH_FALLBACK`, `SB_SIMULATE`, `BENCHMARK_DIR` (default `../recognition/reports`), `VRI_LABEL`, `VRI_URL`, `VRI_PHONE`, `EMERGENCY_NOTE`, plus the vendor keys from CLAUDE.md section 5. No variable uses the `NEXT_PUBLIC_` prefix. `.env.example` is outside P4's paths, so the new names go into `docs/requests.md` for whoever owns it.

---

## 13. Build order and time estimates

Two builders work in parallel against `types.ts`. Builder A owns the server, security and logic; builder B owns the screens. Times assume a working Next scaffold and are honest estimates, not promises.

| Step | Builder | Work | Estimate | Done when |
|---|---|---|---|---|
| 0 | A | Spike: `server.mjs` with `next({ dev, httpServer })`; confirm a route handler sees `x-sb-loopback` and runs in the same process (log `process.pid` once in both, then remove the log), and that `/guest` loads on the phone over the hotspot | 30 min | Phone shows the page; pid matches (if not, counters move into route code, open question 8) |
| 1 | A | `vocab.ts`, `match.ts`, `validate.ts`, `tokens.ts`, `access.ts`, `ratelimit.ts`, `body.ts` with all unit tests | 90 min | `npm test` green |
| 2 | B | Tokens, font, layout, `KeyTag`, `ConfidenceBar`, guest first screen, static staff layout with mock data typed from `types.ts` | 75 min | Both screens render at 390x844 and 1440x900 |
| 3 | A | `store`, `bus` (SSE), `/api/events`, `/api/staff/action`, `/api/guest/join`, `/api/guest/action`, sweeper, wipe | 90 min | Quick reply reaches the phone; End guest wipes both |
| 4 | B | `useBus`, guest conversation screen, `SignCards` and swap point, proposal, Say it and Fix, name entry, repeat, alerts | 90 min | Simulated flow works end to end |
| 5 | A | `ingestSigns`, `/api/guest/signs`, `/api/dev/simulate`, consent gate, latency ack | 60 min | Simulator drives the guest phone |
| 6 | B | Staff dashboard: quick replies, log, last signs, pairing QR, simulate panel, emergency banner and tone, audio unlock, local voice | 90 min | Demo script runs with the simulator |
| 7 | A | Recognizer health, privacy counters, benchmark reader, `/api/tts` with cache and prewarm, `/api/english` behind the flag, smoke script | 75 min | Privacy panel shows real numbers; smoke script passes |
| 8 | B | Hold-to-talk with P1 routes and fallbacks, typed staff sentence | 45 min | Voice path works or falls back cleanly |
| 9 | Both | Integration with P3's real recognizer, rehearsal on the hotspot, accessibility pass (keyboard, screen reader on captions, reduced motion), repo-hygiene test, `next build` | 90 min | CLAUDE.md section 9 runs twice in a row |

The critical path is about 6.5 hours of wall time with both builders busy. If time is short, cut in this order: `/api/english`, ElevenLabs prewarm, benchmark card details, laptop guest layout polish. Never cut: quick replies, the simulator, confirm before speaking, End guest and idle wipe, the security guard.

HTTPS stretch (only if everything above is done): `mkcert` a certificate for the LAN IP, serve with `https.createServer` in `server.mjs`, install the mkcert root on the guest phone, and update the privacy notice. This also enables the Wake Lock API on the phone.

---

## 14. Demo script mapped to clicks

Preparation: start the recognizer (`uvicorn ... --host 127.0.0.1 --port 8000`) and the classifier poster with `BRIDGE_KEY`; start the app with `npm run start:lan`; open `http://127.0.0.1:3000/staff`, press "Start desk", then "Prewarm voices" if ElevenLabs is configured; press "New guest" and scan the QR code with the guest phone. The guest taps "Sign".

| # | Staff action (exact click) | Guest device shows | Guest action | Staff screen shows and laptop does |
|---|---|---|---|---|
| 1 | Quick reply "Welcome!", then "Reservation?" (or hold to talk) | "Welcome!" with HELLO WELCOME; then "Do you have a reservation?" with a yes/no question chip | Signs YES RESERVATION | Bars for YES and RESERVATION; guest phone shows "Yes, I have a reservation." |
| 2 | — | Proposal | Taps "Say it" | Log line; laptop speaks "Yes, I have a reservation." |
| 3 | Quick reply "Your name?" | "What's your name?" | Signs NAME, types the name, taps "Say it" | "My name is <name>." spoken with a local voice |
| 4 | Quick replies "Room 412", then "Key card" | Captions and cards | Signs THANK-YOU, Say it; then WHERE ELEVATOR, Say it | "Thank you." then "Where is the elevator?" |
| 5 | Quick reply "Elevator left" | "The elevator is on your left." | Signs FS-WIFI PASSWORD, Say it | "What's the Wi-Fi password?" |
| 6 | Quick reply "Wi-Fi" | "The Wi-Fi password is on your key card." | Signs BREAKFAST TIME, Say it | "What time is breakfast?" |
| 7 | Quick reply "Breakfast 7-10" | "Breakfast is from 7 to 10." | Signs MORE TOWEL PLEASE with one sign deliberately unclear | Repeat counter 1, "Please sign that again" on both screens |
| 8 | — | "Please sign that again" | Repeats MORE TOWEL PLEASE, Say it | "Could I have more towels, please?" |
| 9 | Quick reply "Towels", then "Anything else?" | Captions | Signs NO THANK-YOU, Say it | "No, that's all, thank you." |
| 10 | Quick reply "Enjoy your stay" | "Enjoy your stay!" | — | — |
| 11 | A juror holds "Hold to talk" and says a free sentence | Captions, plus cards or avatar via the generic gloss path, or captions only if P1 is down | — | Gloss source shown in the log |
| 12 | Point at the privacy panel, then press "End guest" | "This conversation has ended. Nothing was saved." | — | Log cleared; counters for this guest reset |

Rehearsal without the camera uses the simulator: buttons 3, 4, 5, 6, 7, 8, 10 (with "Make one sign unclear" on, then off) and 20, with "Shuffle order" on at least once to show that WHERE ELEVATOR and ELEVATOR WHERE give the same result. On stage we say that the unclear-sign repeat is rehearsed, and the staff screen's "SIMULATED" badge must never appear during the real demo.

---

## 15. Contract changes (also logged in `docs/requests.md`)

1. Screen sync moves from `BroadcastChannel("signbridge")` (CLAUDE.md 2 and 6.7) to the server SSE bus, because the guest screen is now on another device.
2. Message types are extended (section 6); the 6.7 messages gain fields but keep their names.
3. Guest-to-staff recognition moves from the browser webcam (CLAUDE.md 7.2 steps 1 to 3) to a desk camera with Python MediaPipe on the laptop. P3's process posts to `POST /api/guest/signs` with `X-Bridge-Key`, in either payload shape, and may poll `GET /api/guest/signs` for `{accepting}` to switch the camera off when the guest is not signing. P3 is asked to expose `GET /health` on the recognizer.
4. CLAUDE.md 7.2 step 5 changes: the scripted path uses the fixed sentence table instead of Claude; `/api/english` becomes an optional fallback behind `ENGLISH_FALLBACK=1`, labels only, always confirmed by the guest.
5. `/api/tts` takes `{ id }` (a fixed guest intent id) instead of `{ text }`; NAME and free text are spoken with a local voice.
6. P2 is asked where `playGloss` renders: into `#sb-avatar`, or via an exported `mountAvatar(el)`.
7. P1 is asked to keep `/api/gloss` deterministic for the 20 staff intents, cap output at 40 allowed tokens, and never log request bodies. The P1 routes are now loopback-only through `server.mjs`, with no code change needed on their side.
8. New environment variables (section 12) for `.env.example`.
9. P3 is asked for the benchmark report fields (n, accuracy, open-set false-accept rate, signer type, model hash, and a `synthetic` flag) so the benchmark card can show them without guessing.

---

## 16. Open questions

1. Does P3's poster send top-1 or top-3 per sign, and will it implement `GET /health` and honour `{accepting}`? The app accepts both shapes either way.
2. Should "ROOM HELP" stay as "There's a problem with my room," or become a neutral phrase? It is a high-severity confusion, and the guest confirms it either way.
3. Should matching ever use the second-choice prediction (for example, when the top-1 multiset does not match but swapping one sign for its runner-up does)? This version says no, to avoid inventing requests.
4. Should the guest be able to end the conversation themselves ("I'm done"), or only the staff and the idle timer?
5. Which VRI provider, link and phone number do we show, and what text-to-911 note applies where the demo happens?
6. Which network do we use on the day: a phone hotspot (and can that phone also be the guest device) or a travel router?
7. Is the 2-minute idle wipe too short while the guest reads? Warning at 90 seconds plus "tap to keep" is the current answer.
8. If step 0 shows that route handlers run in a different process from `server.mjs`, the P1 call counter must move: either P1 adds a counter call inside their routes, or the staff browser reports the calls it made (labelled as such).
9. Is the guest screen dark-only, or should it offer a light theme for a bright lobby?
10. Who reads the vendor terms before the privacy panel's destinations are shown on stage with any claim about retention?
