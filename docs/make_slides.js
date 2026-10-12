// ConversAI slides as an editable .pptx, from the drawing operations written by docs/make_slides.py.
//
//   python docs/make_slides.py docs/ConversAI-workflow   # .pdf + .json
//   node docs/make_slides.js docs/ConversAI-workflow     # .pptx (needs pptxgenjs)
//
// Canvas 1280 x 720 (origin bottom-left) -> 13.333 x 7.5 in (LAYOUT_WIDE, origin top-left). Every card, label and
// arrow stays a native shape or text box, so the deck can be edited in PowerPoint or Keynote.
const fs = require("fs");
const PptxGenJS = require("pptxgenjs");

const base = process.argv[2] || "docs/ConversAI-workflow";
const spec = JSON.parse(fs.readFileSync(base + ".json", "utf8"));
const IN = 13.333 / spec.w; // inches per canvas unit
const PT = IN * 72; // points per canvas unit (font sizes, line widths)
const H = spec.h;

const pres = new PptxGenJS();
pres.layout = "LAYOUT_WIDE";
pres.title = "ConversAI - workflow";
pres.author = "ConversAI team";

for (const ops of spec.slides) {
  const slide = pres.addSlide();
  for (const o of ops) {
    if (o.t === "rect") {
      slide.addShape(o.r ? pres.ShapeType.roundRect : pres.ShapeType.rect, {
        x: o.x * IN,
        y: (H - o.y - o.h) * IN,
        w: o.w * IN,
        h: o.h * IN,
        fill: { color: o.fill },
        line: o.stroke ? { color: o.stroke, width: o.lw * PT, dashType: o.dash ? "dash" : "solid" } : { type: "none" },
        ...(o.r ? { rectRadius: o.r * IN } : {}),
      });
    } else if (o.t === "circle") {
      slide.addShape(pres.ShapeType.ellipse, {
        x: (o.cx - o.r) * IN,
        y: (H - o.cy - o.r) * IN,
        w: 2 * o.r * IN,
        h: 2 * o.r * IN,
        fill: { color: o.fill },
        line: { type: "none" },
      });
    } else if (o.t === "text") {
      const ascent = o.size * 0.92; // Arial: baseline sits ~0.92 em under the top of the line box
      const width = o.w * 1.04 + 2; // a little slack so PowerPoint keeps the same line breaks
      const x = o.align === "center" ? o.x - width / 2 : o.x;
      slide.addText(
        o.lines.map((line, i) => ({ text: line, options: { breakLine: i < o.lines.length - 1 } })),
        {
          x: x * IN,
          y: (H - o.y - ascent) * IN,
          w: width * IN,
          h: (o.leading * o.lines.length + o.size * 0.3) * IN,
          margin: 0,
          valign: "top",
          align: o.align,
          fontFace: "Arial",
          fontSize: o.size * PT,
          bold: o.bold,
          color: o.color,
          lineSpacing: o.leading * PT,
          isTextBox: true,
        },
      );
    } else if (o.t === "arrow") {
      const x = Math.min(o.x1, o.x2);
      const yTop = H - Math.max(o.y1, o.y2);
      slide.addShape(pres.ShapeType.line, {
        x: x * IN,
        y: yTop * IN,
        w: Math.abs(o.x2 - o.x1) * IN,
        h: Math.abs(o.y2 - o.y1) * IN,
        flipV: o.y2 < o.y1 && o.x2 !== o.x1,
        flipH: o.x2 < o.x1,
        line: {
          color: o.color,
          width: o.lw * PT,
          ...(o.y2 < o.y1 && o.x1 === o.x2 ? { endArrowType: "triangle" } : {}),
          ...(o.y2 > o.y1 && o.x1 === o.x2 ? { beginArrowType: "triangle" } : {}),
          ...(o.y1 === o.y2 ? { endArrowType: "triangle" } : {}),
        },
      });
    }
  }
}

pres.writeFile({ fileName: base + ".pptx" }).then((f) => console.log("wrote", f));
