// SignBridge app (P4): colour tokens per surface (docs/app-plan.md 4.1, A11Y-1, C2-19) and the
// WCAG 2.2 contrast arithmetic that theme.test.ts uses to check every pair. Builder B uses the
// tokens; builder A owns the check. Values are the plan's table; change both together.

export const THEME = {
  navy: "#0E2A47",
  white: "#FFFFFF",
  brass: "#E2B33C",
  ink: "#142235",
  paper: "#FFFFFF",
  rule: "#D5DCE5",
  gGo: "#66BB6A",
  gWait: "#FFB74D",
  gMissed: "#B0BEC5",
  sGo: "#2E7D32",
  sWait: "#8A5200",
  sStop: "#B3261E",
  alarm: "#B3261E",
} as const;

export type ThemeToken = keyof typeof THEME;

/** Foreground/background pairs the screens use, with the minimum ratio each must reach (4.5 text, 3 graphics). */
export const CONTRAST_PAIRS: readonly { fg: ThemeToken; bg: ThemeToken; min: number; use: string }[] = [
  { fg: "white", bg: "navy", min: 4.5, use: "guest text on navy" },
  { fg: "navy", bg: "brass", min: 4.5, use: "key tag and send button text" },
  { fg: "ink", bg: "paper", min: 4.5, use: "staff text" },
  { fg: "gGo", bg: "navy", min: 3, use: "guest green light shape" },
  { fg: "gWait", bg: "navy", min: 3, use: "guest amber light shape" },
  { fg: "gMissed", bg: "navy", min: 3, use: "guest missed light shape" },
  { fg: "sGo", bg: "paper", min: 4.5, use: "staff green light and word" },
  { fg: "sWait", bg: "paper", min: 4.5, use: "staff amber light and word" },
  { fg: "sStop", bg: "paper", min: 4.5, use: "staff red light and word" },
  { fg: "white", bg: "alarm", min: 4.5, use: "Help banner text" },
];

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a #RRGGBB colour: ${hex}`);
  const n = Number.parseInt(m[1], 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
