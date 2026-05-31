// Build-time step: copy the repo-root deploy.json (the Deploy_Manifest emitted by
// scripts/deploy.ts) into the frontend so it can be imported by client code.
//
// Why a copy instead of a direct import?
//   deploy.json lives at the repository root, two levels above this Next.js
//   package. Next/Turbopack will not bundle modules from outside the project
//   root, and the addresses must reach client ("use client") components. Copying
//   the manifest under src/lib/ keeps the import inside the project root and lets
//   the values be statically bundled.
//
// Requirement 6.2: the frontend resolves program ID, market, and orderbook from
//   the Deploy_Manifest.
// Requirement 6.3: if the manifest is missing, the component reports a descriptive
//   error. This script never hard-fails the build (so CI without a deploy.json
//   still builds); instead it writes a fallback manifest flagged with
//   __manifestPresent__: false, and src/lib/manifest.ts surfaces the error.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// frontend/scripts -> frontend -> slipstream -> repo root
const MANIFEST_SRC = join(__dirname, "..", "..", "..", "deploy.json");
const OUT_DIR = join(__dirname, "..", "src", "lib");
const OUT_FILE = join(OUT_DIR, "deploy-manifest.generated.json");

// Last-known-good live devnet addresses. Used only when deploy.json is absent so
// that the build never breaks in CI without a manifest. Keep in sync with the
// emitted deploy.json shape.
const FALLBACK = {
  network: "https://api.devnet.solana.com",
  erRpc: "https://devnet.magicblock.app",
  programId: "7qujfsb4ZPbQHYVZdqiXq1r8tVAMyyukX94obPqXbVwz",
  market: "ECUp8pXzVLzxjVs8mtKBJma3mdcHf8zSC4cqPeBy8MPy",
  orderBook: "83zMFL6cHjgXkQ7KRNcgtHaZ1fhyNgxhM8aMpPpEnMqe",
  usdcMint: "Fakb9gPACMBbfQgepdAEmPCYmNU4iKAqQhFKfrDU6gDr",
  usdcVault: "BTWVG5oDmomaMkpdX4xYgfjr1gpEGodW5oPe3k5P71qr",
  marketIndex: 0,
};

function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  if (existsSync(MANIFEST_SRC)) {
    const manifest = JSON.parse(readFileSync(MANIFEST_SRC, "utf-8"));
    const out = { ...manifest, __manifestPresent__: true };
    writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + "\n");
    console.log(`[copy-manifest] copied deploy.json -> ${OUT_FILE}`);
  } else {
    const out = { ...FALLBACK, __manifestPresent__: false };
    writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + "\n");
    console.warn(
      `[copy-manifest] deploy.json not found at ${MANIFEST_SRC}; wrote fallback manifest. ` +
        `The frontend will surface a missing-manifest warning until you run scripts/deploy.ts.`
    );
  }
}

main();
