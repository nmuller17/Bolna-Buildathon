// P4: guest intents and classifier labels, copied from docs/vocabulary.md (sections 2 and 3).

export type Prediction = { label: string; conf: number }; // conf in [0, 1]

/** The 22 classifier labels (vocabulary.md section 3) and what each one means in English. */
export const LABELS: Record<string, string> = {
  YES: "yes",
  NO: "no",
  RESERVATION: "reservation",
  NAME: "name",
  "THANK-YOU": "thank you",
  WHERE: "where",
  ELEVATOR: "elevator",
  "FS-WIFI": "Wi-Fi",
  PASSWORD: "password",
  BREAKFAST: "breakfast",
  TIME: "time",
  TOWEL: "towel",
  MORE: "more",
  LEAVE: "checkout", // ASL LEAVE, used for checkout (docs/vocabulary.md)
  LATE: "late",
  PLEASE: "please",
  PARKING: "parking",
  TAXI: "taxi",
  HELP: "help",
  ROOM: "room",
  RESTAURANT: "restaurant",
  NONE: "no sign",
};

/** Guest intents (vocabulary.md section 2): sign sequence -> exact spoken sentence. #4 (NAME + typed name) is not handled yet. */
export const INTENTS: { signs: string[]; text: string }[] = [
  { signs: ["YES"], text: "Yes." },
  { signs: ["NO"], text: "No." },
  { signs: ["YES", "RESERVATION"], text: "Yes, I have a reservation." },
  { signs: ["THANK-YOU"], text: "Thank you." },
  { signs: ["WHERE", "ELEVATOR"], text: "Where is the elevator?" },
  { signs: ["FS-WIFI", "PASSWORD"], text: "What's the Wi-Fi password?" },
  { signs: ["BREAKFAST", "TIME"], text: "What time is breakfast?" },
  { signs: ["WHERE", "BREAKFAST"], text: "Where is breakfast served?" },
  { signs: ["MORE", "TOWEL", "PLEASE"], text: "Could I have more towels, please?" },
  { signs: ["LEAVE", "TIME"], text: "What time is checkout?" },
  { signs: ["LATE", "LEAVE", "PLEASE"], text: "Could I have a late checkout?" },
  { signs: ["WHERE", "PARKING"], text: "Where can I park?" },
  { signs: ["TAXI", "PLEASE"], text: "Could you call me a taxi?" },
  { signs: ["HELP", "PLEASE"], text: "I need some help, please." },
  { signs: ["WHERE", "ROOM"], text: "Where is my room?" },
  { signs: ["ROOM", "HELP"], text: "There's a problem with my room." },
  { signs: ["WHERE", "RESTAURANT"], text: "Where is the restaurant?" },
  { signs: ["RESTAURANT", "TIME"], text: "When is the restaurant open?" },
  { signs: ["NO", "THANK-YOU"], text: "No, that's all, thank you." },
];

const intentBySigns = new Map(INTENTS.map((i) => [i.signs.join(" "), i.text]));

/** Exact match of a normalized label sequence against INTENTS. */
export function lookupIntent(labels: string[]): string | undefined {
  return intentBySigns.get(labels.join(" "));
}
