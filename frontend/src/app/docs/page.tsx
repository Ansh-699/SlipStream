import { getDoc } from "@/lib/docs";
import { notFound } from "next/navigation";
import { MermaidRunner } from "./mermaid-runner";

export default function DocsIndexPage() {
  const doc = getDoc("");
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
