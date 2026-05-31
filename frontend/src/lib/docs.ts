// Server-side docs loader for the /docs web view. Reads the markdown copied
// into src/content/docs by scripts/copy-docs.mjs, parses it with `marked`, and
// rewrites internal links so cross-doc references work as /docs routes.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { marked } from "marked";

const DOCS_DIR = join(process.cwd(), "src", "content", "docs");

export interface DocMeta {
  slug: string; // url slug, e.g. "01-architecture-overview" ("" for index)
  file: string; // filename, e.g. "01-architecture-overview.md"
  title: string; // human title from first H1, fallback to filename
  order: number; // numeric prefix for sidebar ordering (README = -1)
}

/** README.md is the docs home (slug ""). Other files use their basename. */
function fileToSlug(file: string): string {
  if (file.toLowerCase() === "readme.md") return "";
  return file.replace(/\.md$/i, "");
}

function firstHeading(md: string, fallback: string): string {
  const m = md.match(/^#\s+(.+?)\s*$/m);
  if (m) return m[1].replace(/[#*`]/g, "").trim();
  return fallback;
}

function orderOf(file: string): number {
  if (file.toLowerCase() === "readme.md") return -1;
  const m = file.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : 999;
}

export function listDocs(): DocMeta[] {
  if (!existsSync(DOCS_DIR)) return [];
  return readdirSync(DOCS_DIR)
    .filter((f) => f.toLowerCase().endsWith(".md"))
    .map((file) => {
      const raw = readFileSync(join(DOCS_DIR, file), "utf-8");
      return {
        slug: fileToSlug(file),
        file,
        title: firstHeading(raw, file.replace(/\.md$/i, "")),
        order: orderOf(file),
      };
    })
    .sort((a, b) => a.order - b.order);
}

function slugToFile(slug: string): string | null {
  if (!existsSync(DOCS_DIR)) return null;
  const want = slug === "" ? "readme.md" : `${slug}.md`;
  const found = readdirSync(DOCS_DIR).find(
    (f) => f.toLowerCase() === want.toLowerCase()
  );
  return found ?? null;
}

/** Rewrite intra-doc markdown links (./04-foo.md, 04-foo.md, ./README.md) to
 *  /docs routes so navigation stays inside the web view. */
function rewriteLinks(html: string): string {
  return html.replace(
    /href="(\.\/)?([A-Za-z0-9._-]+)\.md(#[^"]*)?"/g,
    (_full, _dot, name: string, hash = "") => {
      const slug = name.toLowerCase() === "readme" ? "" : name;
      return `href="/docs${slug ? "/" + slug : ""}${hash}"`;
    }
  );
}

export interface RenderedDoc {
  title: string;
  html: string;
}

export function getDoc(slug: string): RenderedDoc | null {
  const file = slugToFile(slug);
  if (!file) return null;
  const raw = readFileSync(join(DOCS_DIR, file), "utf-8");
  marked.setOptions({ gfm: true, breaks: false });
  const parsed = marked.parse(raw) as string;
  return {
    title: firstHeading(raw, file.replace(/\.md$/i, "")),
    html: rewriteLinks(parsed),
  };
}
