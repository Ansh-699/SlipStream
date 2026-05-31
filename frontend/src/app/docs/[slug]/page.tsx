import { getDoc, listDocs } from "@/lib/docs";
import { notFound } from "next/navigation";

// Pre-render every doc slug at build time.
export function generateStaticParams() {
  return listDocs()
    .filter((d) => d.slug !== "")
    .map((d) => ({ slug: d.slug }));
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
    <article
      className="doc-prose"
      dangerouslySetInnerHTML={{ __html: doc.html }}
    />
  );
}
