// One-shot asset generator: turns the source PNGs in frontend/assets/ into the
// favicon/app-icon/OG-image files Next.js App Router auto-wires, plus a public
// copy of the banner + logo. Re-run with: node scripts/gen-assets.mjs
import sharp from "sharp";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FE = join(here, "..");
const ASSETS = join(FE, "assets");
const APP = join(FE, "src", "app");
const PUBLIC = join(FE, "public");

const FAVICON_SRC = join(ASSETS, "favicon.png");
const BANNER_SRC = join(ASSETS, "banner-slipstream.png");

mkdirSync(PUBLIC, { recursive: true });

async function run() {
  if (!existsSync(FAVICON_SRC)) throw new Error(`missing ${FAVICON_SRC}`);
  if (!existsSync(BANNER_SRC)) throw new Error(`missing ${BANNER_SRC}`);

  // App Router metadata icons (Next auto-generates <link rel="icon"> etc.)
  //  - src/app/icon.png       -> favicon (browsers pick best size)
  //  - src/app/apple-icon.png -> iOS home-screen icon
  await sharp(FAVICON_SRC).resize(256, 256, { fit: "cover" }).png().toFile(join(APP, "icon.png"));
  await sharp(FAVICON_SRC).resize(180, 180, { fit: "cover" }).png().toFile(join(APP, "apple-icon.png"));

  // Public copies used in the UI + README.
  await sharp(FAVICON_SRC).resize(512, 512, { fit: "cover" }).png().toFile(join(PUBLIC, "logo.png"));
  await sharp(FAVICON_SRC).resize(64, 64, { fit: "cover" }).png().toFile(join(PUBLIC, "logo-32.png"));

  // OpenGraph / social share image (1200x630 is the standard). Fit the banner
  // onto a dark canvas so nothing is cropped awkwardly.
  await sharp(BANNER_SRC)
    .resize(1200, 630, { fit: "contain", background: { r: 8, g: 10, b: 12, alpha: 1 } })
    .png()
    .toFile(join(APP, "opengraph-image.png"));

  // A web-optimized banner for the README / in-app hero.
  await sharp(BANNER_SRC).resize(1600, null, { withoutEnlargement: true }).png().toFile(join(PUBLIC, "banner.png"));

  console.log("[gen-assets] wrote icon.png, apple-icon.png, opengraph-image.png, public/logo*.png, public/banner.png");
}

run().catch((e) => {
  console.error("[gen-assets] failed:", e.message);
  process.exit(1);
});
