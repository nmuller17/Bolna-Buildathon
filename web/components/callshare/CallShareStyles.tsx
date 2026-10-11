// Call-share view (P4): the two small animations (pulsing "signing" dot, "waiting" dots). Inline styles cannot hold keyframes.
const CSS = `
@keyframes cs-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.35; transform: scale(0.75); } }
@keyframes cs-dots { 0% { content: ""; } 25% { content: "."; } 50% { content: ".."; } 75%, 100% { content: "..."; } }
.cs-pulse { animation: cs-pulse 1s ease-in-out infinite; }
.cs-dots::after { content: ""; display: inline-block; width: 1.4em; text-align: left; animation: cs-dots 1.6s steps(1) infinite; }
@media (prefers-reduced-motion: reduce) { .cs-pulse, .cs-dots::after { animation: none; } .cs-dots::after { content: "..."; } }
html, body { margin: 0; background: #0e1117; }
`;

export default function CallShareStyles() {
  return <style>{CSS}</style>;
}
