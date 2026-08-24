import type { Metadata } from "next";
import { getDoc, listDocs } from "@/lib/docs";
import { notFound } from "next/navigation";
import { MermaidRunner } from "../mermaid-runner";

// Pre-render every doc slug at build time.
export function generateStaticParams() {
  return listDocs()
    .filter((d) => d.slug !== "")
    .map((d) => ({ slug: d.slug }));
}

// Without this every chapter inherited docs/layout.tsx's "Slipstream Docs",
// so nine open tabs were indistinguishable and every bookmark saved the same
// name. Runs at build time only — these pages are all statically generated.
// An unknown slug returns {} so the layout title stands for the 404.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const doc = getDoc(slug);
  return doc ? { title: `${doc.title} · Slipstream Docs` } : {};
}

export default async function DocPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const doc = getDoc(slug);
  if (!doc) notFound();
  return (
    <>
      <article
        className="doc-prose"
        dangerouslySetInnerHTML={{ __html: doc.html }}
      />
      <MermaidRunner />
    </>
  );
}
