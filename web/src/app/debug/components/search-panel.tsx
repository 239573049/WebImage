"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Globe2, LoaderCircle, Search } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { httpRequest } from "@/lib/request";
import { cn } from "@/lib/utils";

import type { SearchResult } from "./types";

const normalizeMarkdown = (text: string) =>
  text
    .replace(/\ue200url\ue202([^\ue202\ue201]*)\ue202([^\ue201]*)\ue201/g, "[$1]($2)")
    .replace(/\ue200cite\ue202[^\ue201]*\ue201/g, "")
    .replace(/\ue200[^\ue201]*\ue201/g, "")
    .replace(/\ue200[^\ue201]*$/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const cleanUrl = (url: string) => url.replace(/[\ue200-\ue202].*$/g, "").trim();

const sourceKind = (url: string) => {
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  })();
  return host.includes("github.com") ? "github" : "web";
};

function MarkdownResult({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ className, ...props }) => <a className={cn("font-medium text-primary underline underline-offset-4 decoration-primary/40 hover:text-primary/80", className)} target="_blank" rel="noreferrer" {...props} />,
        h1: ({ className, ...props }) => <h1 className={cn("mt-8 mb-4 text-2xl font-semibold tracking-tight text-foreground first:mt-0", className)} {...props} />,
        h2: ({ className, ...props }) => <h2 className={cn("mt-8 mb-4 border-b border-border pb-2 text-xl font-semibold tracking-tight text-foreground first:mt-0", className)} {...props} />,
        h3: ({ className, ...props }) => <h3 className={cn("mt-6 mb-3 text-lg font-semibold text-foreground", className)} {...props} />,
        p: ({ className, ...props }) => <p className={cn("my-4 leading-7 text-foreground/85", className)} {...props} />,
        ul: ({ className, ...props }) => <ul className={cn("my-4 list-disc space-y-2 pl-6 leading-7 text-foreground/85", className)} {...props} />,
        ol: ({ className, ...props }) => <ol className={cn("my-4 list-decimal space-y-2 pl-6 leading-7 text-foreground/85", className)} {...props} />,
        blockquote: ({ className, ...props }) => <blockquote className={cn("my-5 rounded-r-xl border-l-4 border-primary/40 bg-muted/60 py-3 pr-4 pl-5 text-foreground/85", className)} {...props} />,
        code: ({ className, ...props }) => <code className={cn("rounded bg-muted px-1.5 py-0.5 font-mono text-[0.9em] text-foreground", className)} {...props} />,
        pre: ({ className, ...props }) => <pre className={cn("my-5 overflow-x-auto rounded-xl border border-border bg-[#0c0e13] p-4 text-sm text-white/90", className)} {...props} />,
        table: ({ className, ...props }) => <div className="my-5 overflow-x-auto rounded-xl border border-border"><table className={cn("w-full border-collapse text-sm", className)} {...props} /></div>,
        th: ({ className, ...props }) => <th className={cn("border-b border-border bg-muted px-3 py-2 text-left font-semibold", className)} {...props} />,
        td: ({ className, ...props }) => <td className={cn("border-b border-border px-3 py-2 align-top", className)} {...props} />,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

export function SearchPanel() {
  const [prompt, setPrompt] = useState("帮我搜索 chatgpt2api 相关项目");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [startedAt, setStartedAt] = useState(0);
  const searched = loading || !!result || !!error;

  useEffect(() => {
    if (!loading || !startedAt) return;
    const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 100);
    return () => window.clearInterval(timer);
  }, [loading, startedAt]);

  const runSearch = async () => {
    const value = prompt.trim();
    if (!value || loading) return;
    const start = Date.now();
    setStartedAt(start);
    setElapsedMs(0);
    setLoading(true);
    setError("");
    setResult(null);
    try {
      setResult(await httpRequest<SearchResult>("/v1/search", { method: "POST", body: { prompt: value } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setElapsedMs(Date.now() - start);
      setLoading(false);
    }
  };

  return (
    <section className={cn("mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col overflow-y-auto px-4 transition-colors", searched ? "py-5" : "justify-center")}>
      <div className={cn("mx-auto w-full max-w-3xl", searched && "sticky top-3 z-10")}>
        {!searched ? (
          <p className="mb-5 text-center text-sm text-muted-foreground">利用ChatGPT先进的网页搜索功能进行搜索</p>
        ) : null}
        <form
          className={cn("mx-auto flex w-full items-center gap-3 rounded-full border border-input bg-field transition-colors focus-within:border-primary/70 focus-within:ring-4 focus-within:ring-primary/20", searched ? "px-4 py-2" : "px-5 py-3")}
          onSubmit={(event) => {
            event.preventDefault();
            void runSearch();
          }}
        >
          <img src="/openai.svg" alt="" aria-hidden="true" className="size-5 shrink-0 opacity-80 dark:invert" />
          <input
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="搜索网页"
            className={cn("min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground/70", searched ? "h-8" : "h-10")}
          />
          <button type="submit" disabled={loading || !prompt.trim()} className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:text-muted-foreground/60">
            {loading ? <LoaderCircle className="size-4 animate-spin" /> : <Search className="size-4" />}
          </button>
        </form>
      </div>

      {searched ? <div className="mx-auto w-full max-w-6xl flex-1 pt-6">
        {loading ? (
          <div className="surface mx-auto flex max-w-3xl items-center gap-3 rounded-2xl px-4 py-3 text-sm text-foreground/80">
            <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
            搜索中... {(elapsedMs / 1000).toFixed(1)}s
          </div>
        ) : null}

        {error ? <div className="rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div> : null}

        {result ? (
          <article className="grid gap-8 pb-12 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="min-w-0">
              <div className="mb-5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="rounded-full border border-border bg-muted px-3 py-1">{result.status || "done"}</span>
                <span className="rounded-full border border-border bg-muted px-3 py-1">{(elapsedMs / 1000).toFixed(2)}s</span>
                <span className="rounded-full border border-border bg-muted px-3 py-1">{result.sources?.length || 0} sources</span>
              </div>
              <div className="text-[15px]">
                <MarkdownResult content={normalizeMarkdown(result.answer || "")} />
              </div>
            </div>
            {result.sources?.length ? (
              <aside className="lg:sticky lg:top-24 lg:self-start">
                <div className="mb-3 text-sm font-medium text-muted-foreground">来源</div>
                <div className="divide-y divide-border">
                  {result.sources.map((source, index) => {
                    const url = cleanUrl(source.url || "");
                    const kind = sourceKind(url);
                    return (
                      <a key={`${url || index}`} href={url} target="_blank" rel="noreferrer" className="flex gap-3 py-3 text-xs transition-colors hover:text-foreground">
                        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center text-foreground/80">
                          {kind === "github" ? <img src="/github.svg" alt="" aria-hidden="true" className="size-3.5 dark:invert" /> : <Globe2 className="size-3.5" />}
                        </span>
                        <span className="min-w-0">
                          <span className="line-clamp-2 font-medium leading-5 text-foreground">{source.title || url || "source"}</span>
                          <span className="mt-1 flex items-center gap-1 truncate text-muted-foreground">
                            <ExternalLink className="size-3 shrink-0" />
                            {url}
                          </span>
                        </span>
                      </a>
                    );
                  })}
                </div>
              </aside>
            ) : null}
          </article>
        ) : null}
      </div> : null}
    </section>
  );
}
