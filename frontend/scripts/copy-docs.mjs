// Build-time step: copy the repo-root /docs markdown into the frontend so the
// /docs web view can read them inside the Next project root (Next/Turbopack
// won't bundle files outside the package root — same reason copy-manifest.mjs
// copies deploy.json). Re-run via predev/prebuild.
import { existsSync, mkdirSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// frontend/scripts -> frontend -> slipstream -> docs  (repo-root /docs)
const CANDIDATES = [
  process.env.DOCS_DIR,
  join(here, "..", "..", "docs"),
  join(here, "..", "..", "..", "docs"),
].filter(Boolean);

const SRC = CANDIDATES.find((p) => p && existsSync(p));
const OUT = join(here, "..", "src", "content", "docs");

mkdirSync(OUT, { recursive: true });

if (!SRC) {
  console.warn("[copy-docs] no /docs dir found; skipping (docs page will be empty).");
} else {
  // Clear stale copies, then copy every .md file.
  for (const f of readdirSync(OUT)) {
    if (f.endsWith(".md")) rmSync(join(OUT, f));
  }
  let n = 0;
  for (const f of readdirSync(SRC)) {
    if (f.endsWith(".md")) {
      copyFileSync(join(SRC, f), join(OUT, f));
      n++;
    }
  }
  console.log(`[copy-docs] copied ${n} markdown file(s) from ${SRC} -> ${OUT}`);
}
