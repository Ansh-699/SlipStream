# R-06 — `S9-C2` clears XSS reachability with a wrong mechanism and a sink list that omits the slice's own P2

- **Severity:** P1
- **Blocked by:** none
- **Owns:** `docs/audit/audit-e2e/s9.md` (`## Cleared` bullet `S9-C2`, and the `**Evidence:**` line of record `S9-05`)
- **Does not touch:** product source; `docs/checks/`.

## Interface contract (published)

After this issue, `S9-C2` and `S9-05` agree: the docs origin holds the session secret, has
one live HTML-injection sink, and has no CSP.

## What is wrong

The `S9-C2` bullet clears "XSS reachability of the session key" as **Sound** on two grounds,
both wrong.

1. *"`frontend/src/lib/docs.ts:89-92` hand-escapes `&`, `<`, `>` into the
   `<pre class="mermaid">` block, so graph source cannot break out."* The escaping is undone
   by an `innerHTML` round-trip the bullet never mentions.
   `frontend/src/app/docs/mermaid-runner.tsx:33` stores `el.textContent` — the decoded text —
   into `data-src`, and `:30` writes it back with `el.innerHTML = src` on the next render
   pass, which the `themechange` listener at `:59` fires. `securityLevel: "strict"` at `:39`
   governs mermaid's own label rendering and runs after `:30`.
2. *"No `eval`, `new Function`, or `srcdoc` anywhere in `frontend/src`."* True and beside the
   point. The live sink is `dangerouslySetInnerHTML={{ __html: doc.html }}` at
   `frontend/src/app/docs/[slug]/page.tsx:24` and `frontend/src/app/docs/page.tsx:12`, over
   `marked.parse()` output (`frontend/src/lib/docs.ts:97`), with `marked ^14.1.4`
   (`frontend/package.json:27`) which passes raw HTML through by default and has had no
   `sanitize` option since v5. There is no `dompurify` in the tree. **`S9` files this sink
   itself as `S9-05`**, so the `## Cleared` bullet clears the class its own P2 sits in.

Exploitability is bounded today because the docs are repo markdown compiled at build time.
The clearance is still wrong as written, on the origin holding the `localStorage` session
secret (`S9-04`).

## Change skeleton

- `docs/audit/audit-e2e/s9.md`, `## Cleared`, bullet `S9-C2`: replace **Sound** with
  **not clear — covered by `S9-05`**; delete the "cannot break out" sentence; keep the
  `eval`/`new Function`/`srcdoc` enumeration but scope it to "these three sinks are absent",
  not to the class.
- `docs/audit/audit-e2e/s9.md`, record `S9-05`, `**Evidence:**` line only: add
  `frontend/src/app/docs/mermaid-runner.tsx:26-35` and one sentence in `**What is wrong.**`
  noting the `textContent` → `data-src` → `innerHTML` round-trip defeats the escaping at
  `frontend/src/lib/docs.ts:89-92`.
- Severity of `S9-05` is unchanged.

<!-- architect-run: audit-e2e -->
