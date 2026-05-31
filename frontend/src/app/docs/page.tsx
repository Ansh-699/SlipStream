import { getDoc } from "@/lib/docs";
import { notFound } from "next/navigation";

export default function DocsIndexPage() {
  const doc = getDoc("");
  if (!doc) notFound();
  return (
    <article
      className="doc-prose"
      dangerouslySetInnerHTML={{ __html: doc.html }}
    />
  );
}
