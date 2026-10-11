# SignBridge vocabulary

Source of truth for every sign the product uses. Lives at `docs/vocabulary.md`.
Sign IDs below are the exact keys used in `signs/index.json`, sign file names, gloss tokens and classifier labels.

## Naming rules
- IDs are uppercase, words joined by a hyphen: `THANK-YOU`, `HOW-MANY`.
- Digits are `0` to `11`. Letters are `A` to `Z` and live in `signs/alphabet/`.
- The pronoun "I" is `ME`, so it never clashes with the letter `I`.
- In a gloss, a fingerspelled word is written `FS:WORD` (example `FS:WIFI`). The player spells it letter by letter.
- In the classifier, a fingerspelled word recognized as one unit is labeled `FS-WORD` (example `FS-WIFI`).

## Totals
| Category | Count |
|---|---|
| Lexical signs (avatar and/or recognition) | 49 |
| Digits 0 to 11 | 12 |
| Letters A to Z (fingerspelling) | 26 |
| **Total signs to capture for the avatar** | **43 + 12 + 26 = 81** |
| **Classifier classes** | **22** (21 signs + `NONE`) |

## Decisions from the ASL check
| English | Decision | Reason |
|---|---|---|
| to | Not signed, replaced by `UNTIL` in time ranges | Usually dropped in ASL |
| on | Not signed | Usually incorporated into other signs |
| ID | `FS:ID` | No common dedicated sign |
| Wi-Fi | `FS:WIFI` | Sign exists but varies, fingerspelling is safer |
| checkout | `LEAVE` | No standard hotel checkout sign; fingerspelling C-H-E-C-K-O-U-T (8 letters) was too long to sign and to recognize |
| password | `PRIVATE` + `WORD` | No single established sign, PRIVATE-WORD is the documented compound |

## 1. Staff to guest, 20 intents (avatar)
Facial marker column: `brows-up` for yes/no questions, `brows-down` for wh-questions.
Signs are captured with a neutral face. The marker is sent as the first gloss token (`BROWS-UP` or `BROWS-DOWN`) and the avatar applies it to the eyebrows for the whole sentence.

| # | Receptionist says | Gloss | Facial marker |
|---|---|---|---|
| 1 | Welcome! | `HELLO WELCOME` | |
| 2 | Do you have a reservation? | `BROWS-UP YOU HAVE RESERVATION` | brows-up |
| 3 | What's your name? | `BROWS-DOWN YOUR NAME WHAT` | brows-down |
| 4 | Can I see your ID? | `FS:ID SHOW PLEASE` | |
| 5 | How many nights? | `BROWS-DOWN NIGHT HOW-MANY` | brows-down |
| 6 | You're in room 412. | `YOUR ROOM 4 1 2` | |
| 7 | Here is your key card. | `YOUR KEY CARD HERE` | |
| 8 | The elevator is on your left. | `ELEVATOR THERE LEFT` | |
| 9 | Breakfast is from 7 to 10. | `BREAKFAST TIME 7 UNTIL 10` | |
| 10 | The Wi-Fi password is on your key card. | `FS:WIFI PRIVATE WORD YOUR KEY CARD` | |
| 11 | Checkout is at 11. | `LEAVE TIME 11` | |
| 12 | Late checkout is fine, until 1 PM. | `LATE LEAVE FINE UNTIL 1` | |
| 13 | I'll send towels to your room. | `TOWEL ME SEND YOUR ROOM` | |
| 14 | Parking is downstairs. | `PARKING DOWN` | |
| 15 | The restaurant is open until 10 PM. | `RESTAURANT OPEN UNTIL 10 NIGHT` | |
| 16 | I'll call a taxi for you. | `TAXI ME CALL` | |
| 17 | One moment, please. | `WAIT PLEASE` | |
| 18 | Sorry, can you repeat? | `BROWS-UP SORRY AGAIN PLEASE` | brows-up |
| 19 | Anything else? | `BROWS-UP OTHER QUESTION` | brows-up |
| 20 | Enjoy your stay! | `ENJOY YOUR STAY` | |

## 2. Guest to staff, 22 intents (recognition)
| # | Guest signs | Spoken sentence |
|---|---|---|
| 1 | `YES` | Yes. |
| 2 | `NO` | No. |
| 3 | `YES RESERVATION` | Yes, I have a reservation. |
| 4 | `NAME` + name typed on keyboard | My name is John Smith. |
| 5 | `THANK-YOU` | Thank you. |
| 6 | `WHERE ELEVATOR` | Where is the elevator? |
| 7 | `FS-WIFI PASSWORD` | What's the Wi-Fi password? |
| 8 | `BREAKFAST TIME` | What time is breakfast? |
| 9 | `WHERE BREAKFAST` | Where is breakfast served? |
| 10 | `MORE TOWEL PLEASE` | Could I have more towels, please? |
| 11 | `LEAVE TIME` | What time is checkout? |
| 12 | `LATE LEAVE PLEASE` | Could I have a late checkout? |
| 13 | `WHERE PARKING` | Where can I park? |
| 14 | `TAXI PLEASE` | Could you call me a taxi? |
| 15 | `HELP PLEASE` | I need some help, please. |
| 16 | `WHERE ROOM` | Where is my room? |
| 17 | `ROOM HELP` | There's a problem with my room. |
| 18 | `WHERE RESTAURANT` | Where is the restaurant? |
| 19 | `RESTAURANT TIME` | When is the restaurant open? |
| 20 | `NO THANK-YOU` | No, that's all, thank you. |
| 21 | `YES NAME` + name fingerspelled (S-A-M) | Yes, my name is Sam. (demo guest name) |
| 22 | `THANK-YOU WHERE ELEVATOR` | Thank you. Where is the elevator? |

## 3. Classifier classes (22)
Each class: 4 signers x 20 takes (15 if time is short). Default capture window 2 s, use 3 s for the fingerspelled and compound classes.

| Label | How it is performed | Capture window |
|---|---|---|
| `YES` | sign | 2 s |
| `NO` | sign | 2 s |
| `RESERVATION` | sign | 2 s |
| `NAME` | sign | 2 s |
| `THANK-YOU` | sign | 2 s |
| `WHERE` | sign | 2 s |
| `ELEVATOR` | sign | 2 s |
| `FS-WIFI` | fingerspell W-I-F-I as one unit | 3 s |
| `PASSWORD` | compound PRIVATE-WORD as one unit | 3 s |
| `BREAKFAST` | sign | 2 s |
| `TIME` | sign | 2 s |
| `TOWEL` | sign | 2 s |
| `MORE` | sign | 2 s |
| `LEAVE` | sign (both hands pull back toward the shoulder, closing) | 2 s |
| `LATE` | sign | 2 s |
| `PLEASE` | sign | 2 s |
| `PARKING` | sign | 2 s |
| `TAXI` | sign | 2 s |
| `HELP` | sign | 2 s |
| `ROOM` | sign | 2 s |
| `RESTAURANT` | sign | 2 s |
| `NONE` | idle hands, scratching, adjusting hair, random movement | 2 s |

## 4. Master capture list (49 lexical signs)
Avatar = recorded once by the main signer (3 takes, keep the best) into `signs/team/`.
Recognition = recorded by all 4 team members into `data/train/` (section 3).
Check every sign on Lifeprint or Handspeak before recording. Tick the box when done.

| # | ID | Avatar | Recognition | Notes | Done |
|---|---|---|---|---|---|
| 1 | `HELLO` | x | | | [x] |
| 2 | `WELCOME` | x | | | [x] |
| 3 | `YOU` | x | | point at the guest | [x] |
| 4 | `YOUR` | x | | flat hand toward the guest | [x] |
| 5 | `ME` | x | | pronoun "I", point at self | [x] |
| 6 | `HAVE` | x | | | [x] |
| 7 | `RESERVATION` | x | x | | [x] |
| 8 | `NAME` | x | x | | [x] |
| 9 | `WHAT` | x | | | [x] |
| 10 | `SHOW` | x | | | [x] |
| 11 | `PLEASE` | x | x | | [x] |
| 12 | `NIGHT` | x | | | [x] |
| 13 | `HOW-MANY` | x | | | [x] |
| 14 | `ROOM` | x | x | | [x] |
| 15 | `KEY` | x | | | [x] |
| 16 | `CARD` | x | | | [x] |
| 17 | `HERE` | x | | | [x] |
| 18 | `THERE` | x | | point to the side | [x] |
| 19 | `LEFT` | x | | | [x] |
| 20 | `ELEVATOR` | x | x | | [x] |
| 21 | `BREAKFAST` | x | x | | [x] |
| 22 | `TIME` | x | x | | [x] |
| 23 | `UNTIL` | x | | | [x] |
| 24 | `PRIVATE` | x | | first half of PASSWORD | [x] |
| 25 | `WORD` | x | | second half of PASSWORD | [x] |
| 26 | `LATE` | x | x | | [x] |
| 27 | `FINE` | x | | | [x] |
| 28 | `TOWEL` | x | x | | [x] |
| 29 | `SEND` | x | | | [x] |
| 30 | `PARKING` | x | x | | [x] |
| 31 | `DOWN` | x | | | [x] |
| 32 | `RESTAURANT` | x | x | | [x] |
| 33 | `OPEN` | x | | | [x] |
| 34 | `TAXI` | x | x | | [x] |
| 35 | `CALL` | x | | as in phone call | [x] |
| 36 | `WAIT` | x | | | [x] |
| 37 | `SORRY` | x | | | [x] |
| 38 | `AGAIN` | x | | | [x] |
| 39 | `OTHER` | x | | | [x] |
| 40 | `QUESTION` | x | | | [x] |
| 41 | `ENJOY` | x | | | [x] |
| 42 | `STAY` | x | | | [x] |
| 43 | `YES` | | x | | [ ] |
| 44 | `NO` | | x | | [ ] |
| 45 | `THANK-YOU` | | x | | [ ] |
| 46 | `WHERE` | | x | | [ ] |
| 47 | `MORE` | | x | | [ ] |
| 48 | `HELP` | | x | | [ ] |
| 49 | `LEAVE` | x | x | used for "checkout" | [x] |

Recognition-only units built from the list above or the alphabet: `PASSWORD` (PRIVATE-WORD), `FS-WIFI`.

## 5. Digits (avatar, `signs/alphabet/`)
`0` `1` `2` `3` `4` `5` `6` `7` `8` `9` `10` `11`

## 6. Letters (avatar, `signs/alphabet/`)
`A` `B` `C` `D` `E` `F` `G` `H` `I` `J` `K` `L` `M` `N` `O` `P` `Q` `R` `S` `T` `U` `V` `W` `X` `Y` `Z`
`J` and `Z` include movement, capture them with the full 2 s window like the others.
