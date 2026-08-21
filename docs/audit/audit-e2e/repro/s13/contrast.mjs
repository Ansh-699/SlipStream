// S13 scratch repro — WCAG 2.1 contrast for the terminal text/background pairs
// that the light-mode remap block (frontend/src/app/globals.css:559-620) rewrites
// while the surface underneath stays the hardcoded terminal dark.
//
//   node docs/audit/audit-e2e/repro/s13/contrast.mjs

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const chan = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const lum = ([r, g, b]) => 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
// src over dst at alpha a
const over = (src, dst, a) => src.map((c, i) => a * c + (1 - a) * dst[i]);
const ratio = (fg, bg) => {
  const [a, b] = [lum(fg) + 0.05, lum(bg) + 0.05].sort((x, y) => y - x);
  return a / b;
};

// The light-mode remaps, verbatim from globals.css.
const INK = [15, 23, 23]; // rgba(15,23,23,α) — :569-:581
const REMAP = {
  "text-white": { ink: INK, a: 0.95, line: "globals.css:569" },
  "text-white/60": { ink: INK, a: 0.78, line: "globals.css:575" },
  "text-white/55": { ink: INK, a: 0.74, line: "globals.css:576" },
  "text-emerald-400": { solid: "#047857", line: "globals.css:597" },
  "text-rose-400": { solid: "#be123c", line: "globals.css:600" },
};

const CASES = [
  // [component:line, utility class, hardcoded background, sample text, px, bold?]
  ["frontend/src/components/trading/fill-toasts.tsx:90", "text-emerald-400", "#121516", '"Bought 1.00 SOL"', 12, true],
  ["frontend/src/components/trading/fill-toasts.tsx:90", "text-rose-400", "#121516", '"Sold 1.00 SOL"', 12, true],
  ["frontend/src/components/trading/fill-toasts.tsx:94", "text-white/55", "#121516", '"MAKER" / "TAKER"', 10, true],
  ["frontend/src/components/trading/fill-toasts.tsx:98", "text-white/60", "#121516", '"@ $91.064 · fill #12"', 11, false],
  ["frontend/src/components/trading/order-form.tsx:461", "text-white", "#16794f", '"Long 5.5 SOL"', 14, true],
  ["frontend/src/components/trading/order-form.tsx:462", "text-white", "#a93436", '"Short 5.5 SOL"', 14, true],
  ["frontend/src/components/trading/session-panel.tsx:23", "text-white", "#16794f", '"Start trading"', 13, true],
];

// WCAG "large text" = >=18.66px bold or >=24px. None of the above qualify, so the
// bar is 4.5:1 for all of them.
const need = (px, bold) => ((bold && px >= 18.66) || px >= 24 ? 3.0 : 4.5);

console.log("Light mode (:root:not(.dark)) — the terminal ground stays dark (globals.css:1352,:1363),");
console.log("but the text utilities are remapped to dark ink. Resulting contrast:\n");
let fails = 0;
for (const [where, cls, bg, sample, px, bold] of CASES) {
  const r = REMAP[cls];
  const bgRgb = hex(bg);
  const fg = r.solid ? hex(r.solid) : over(r.ink, bgRgb, r.a);
  const c = ratio(fg, bgRgb);
  const req = need(px, bold);
  const ok = c >= req;
  if (!ok) fails++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${c.toFixed(2).padStart(5)}:1  (needs ${req}:1)  ${cls} on ${bg}  ${px}px${bold ? " bold" : ""}\n` +
    `        ${where}   ${sample}   remap at ${r.line}`
  );
}

// Same pairs in DARK mode, to show the remap is what breaks them.
console.log("\nSame pairs in dark mode (no remap applies):\n");
for (const [where, cls, bg, , px, bold] of CASES) {
  const solids = { "text-emerald-400": "#34d399", "text-rose-400": "#fb7185" };
  const bgRgb = hex(bg);
  const fg = solids[cls]
    ? hex(solids[cls])
    : over([255, 255, 255], bgRgb, cls === "text-white" ? 1 : cls === "text-white/60" ? 0.6 : 0.55);
  console.log(`      ${ratio(fg, bgRgb).toFixed(2).padStart(5)}:1  ${cls} on ${bg}   ${where}`);
}

console.log(`\n${fails} of ${CASES.length} pairs fail WCAG AA in light mode.`);
process.exit(fails > 0 ? 1 : 0);
