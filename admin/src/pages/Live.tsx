/**
 * What the customer actually has: everything published, newest first.
 */
import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Undo2 } from "lucide-react";

import { api } from "../lib/api";
import type { ArticleListItem } from "../lib/types";
import { Card, CardHeader, Chip, EmptyState, GhostButton } from "../components/studio";
import { useToast } from "../components/Toast";

export default function Live() {
  const { toast } = useToast();
  const [articles, setArticles] = useState<ArticleListItem[]>([]);
  const [siteBase, setSiteBase] = useState<string | null>(null);
  const [prefix, setPrefix] = useState("/guides");
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listArticles({ status: "published", limit: 300 })
      .then((res) =>
        setArticles(
          [...res.articles].sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
        )
      )
      .catch((err) => toast((err as Error).message, "error"))
      .finally(() => setLoading(false));
    api
      .previewConfig()
      .then((res) => {
        setSiteBase(res.baseUrl);
        setPrefix(res.articlePathPrefix || "/guides");
      })
      .catch(() => undefined);
  }, [toast]);

  useEffect(load, [load]);

  const unpublish = async (article: ArticleListItem) => {
    if (!window.confirm(`Unpublish "${article.title}"?`)) return;
    try {
      await api.unpublishArticle(article.id);
      toast("Unpublished — back to drafts", "success");
      load();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold uppercase tracking-wide">Live</h1>
          <p className="text-sm text-muted-foreground">Everything the customer's readers can see.</p>
        </div>
        <Chip tone="success">{articles.length} published</Chip>
      </div>

      <Card>
        <CardHeader title="Published articles" />
        {loading ? (
          <EmptyState title="Loading…" />
        ) : articles.length === 0 ? (
          <EmptyState title="Nothing live yet">
            The first approval in Review puts an article here.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-5 py-2.5 font-semibold">Title</th>
                  <th className="px-3 py-2.5 font-semibold">Published</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Words</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Score</th>
                  <th className="px-3 py-2.5 font-semibold">Writer</th>
                  <th className="px-5 py-2.5 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {articles.map((article) => (
                  <tr key={article.id} className="hover:bg-accent/40">
                    <td className="max-w-md truncate px-5 py-2.5 font-medium">{article.title}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground">
                      {article.publishedAt ? article.publishedAt.slice(0, 10) : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs text-muted-foreground">
                      {article.wordCount ?? "—"}
                    </td>
                    <td
                      className={`px-3 py-2.5 text-right font-mono text-xs ${
                        (article.aeoScore ?? 0) >= 80
                          ? "text-chart-2"
                          : (article.aeoScore ?? 0) >= 60
                            ? "text-accent-foreground"
                            : "text-muted-foreground"
                      }`}
                    >
                      {article.aeoScore ?? "—"}
                    </td>
                    <td className="px-3 py-2.5">
                      <Chip tone={article.writerId === "commercial" ? "primary" : "neutral"}>
                        {article.writerId ?? "engine"}
                      </Chip>
                    </td>
                    <td className="px-5 py-2.5">
                      <div className="flex justify-end gap-2">
                        {siteBase && (
                          <a
                            href={`${siteBase}${prefix}/${article.slug}/`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <GhostButton>
                              <ExternalLink size={13} /> View
                            </GhostButton>
                          </a>
                        )}
                        <GhostButton danger onClick={() => unpublish(article)}>
                          <Undo2 size={13} /> Unpublish
                        </GhostButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
