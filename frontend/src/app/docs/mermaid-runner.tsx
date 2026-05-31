"use client";

import { useEffect } from "react";

/**
 * Renders any <pre class="mermaid"> blocks inside the docs article into SVG.
 * Runs after the server-rendered HTML mounts, and re-renders on theme change so
 * the diagram palette matches light/dark. Mermaid is dynamically imported so it
 * stays out of the initial bundle (it's only needed on doc pages with diagrams).
 */
export function MermaidRunner() {
  useEffect(() => {
    let cancelled = false;

    const render = async () => {
      const nodes = Array.from(
        document.querySelectorAll<HTMLElement>("pre.mermaid")
      );
      if (nodes.length === 0) return;

      const { default: mermaid } = await import("mermaid");
      if (cancelled) return;

      const dark = document.documentElement.classList.contains("dark");

      // Restore raw graph source if a previous run already replaced it with SVG.
      for (const el of nodes) {
        const src = el.getAttribute("data-src");
        if (src) {
          el.innerHTML = src;
          el.removeAttribute("data-processed");
        } else {
          el.setAttribute("data-src", el.textContent || "");
        }
      }

      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: dark ? "dark" : "neutral",
        themeVariables: {
          primaryColor: dark ? "#0f1d1a" : "#ecfdf5",
          primaryBorderColor: "#10b981",
          primaryTextColor: dark ? "#e6fffa" : "#0f1717",
          lineColor: dark ? "#5eead4" : "#0f766e",
          fontFamily: "var(--font-sans), ui-sans-serif, system-ui",
        },
      });

      try {
        await mermaid.run({ nodes });
      } catch {
        /* a malformed diagram shouldn't break the page */
      }
    };

    render();
    const onTheme = () => render();
    window.addEventListener("themechange", onTheme);
    return () => {
      cancelled = true;
      window.removeEventListener("themechange", onTheme);
    };
  }, []);

  return null;
}
