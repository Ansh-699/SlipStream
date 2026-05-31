import type { Metadata } from "next";
import { listDocs } from "@/lib/docs";
import { DocsShell } from "./docs-shell";

export const metadata: Metadata = {
  title: "Slipstream Docs",
  description: "Technical documentation for Slipstream — on-chain perpetual futures on Solana.",
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const nav = listDocs().map((d) => ({ slug: d.slug, title: d.title }));
  return <DocsShell nav={nav}>{children}</DocsShell>;
}
