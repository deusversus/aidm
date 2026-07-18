"use client";

import type { ReactNode } from "react";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

/**
 * The markdown floor (§8 walk-back 2026-07-03: "the product layer renders,
 * never imposes" — until now it imposed plaintext, showing the KA's italics
 * as literal asterisks). Restrained by design: paragraphs, emphasis,
 * blockquotes (the readout channel gets real visual offset), scene-break
 * rules, modest headers. The rich display grammar (diegetic System windows,
 * title cards — per-grant skins) is a planned successor, not this component.
 */
export function NarrationProse({
  text,
  streaming = false,
  className = "text-[15px] leading-7",
}: {
  text: string;
  streaming?: boolean;
  /** Replaces the default typography wholesale (recap/booth variants). */
  className?: string;
}) {
  return (
    // While streaming, the last paragraph renders inline so the cursor
    // trails the text instead of dropping to its own line box (audit: the
    // cursor is a sibling AFTER the Markdown blocks — the most-seen pixel
    // in the product must not hop lines). Block-level tails (a forming
    // readout) keep the cursor below, which reads fine under a boxed
    // element.
    <div className={`${className}${streaming ? " [&>p:nth-last-child(2)]:inline" : ""}`}>
      <Markdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          p: ({ children }: { children?: ReactNode }) => (
            <p className="my-3 first:mt-0 last:mb-0">{children}</p>
          ),
          // The offset channel — visually distinct from body prose so an
          // established device reads as its own register (SV4's camera law,
          // product side). pre-wrap keeps space-aligned readout columns.
          blockquote: ({ children }: { children?: ReactNode }) => (
            <blockquote className="my-3 whitespace-pre-wrap border-l-2 border-foreground/25 bg-muted/40 px-3 py-1.5 text-[0.93em] leading-6 text-foreground/85 [&>p]:my-1">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-6 border-border" />,
          h1: ({ children }: { children?: ReactNode }) => (
            <p className="mt-6 mb-3 text-base font-semibold tracking-wide">{children}</p>
          ),
          h2: ({ children }: { children?: ReactNode }) => (
            <p className="mt-6 mb-3 text-base font-semibold tracking-wide">{children}</p>
          ),
          h3: ({ children }: { children?: ReactNode }) => (
            <p className="mt-4 mb-2 text-[15px] font-semibold">{children}</p>
          ),
          ul: ({ children }: { children?: ReactNode }) => (
            <ul className="my-3 list-disc pl-5">{children}</ul>
          ),
          ol: ({ children, start }: { children?: ReactNode; start?: number }) => (
            // start forwarded: a paragraph-start "4." parses as an ordered
            // list — dropping start would silently renumber the KA's "4."
            // to "1." (renders, never imposes — audit repro).
            <ol className="my-3 list-decimal pl-5" start={start}>
              {children}
            </ol>
          ),
          code: ({ children }: { children?: ReactNode }) => (
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.88em]">{children}</code>
          ),
          pre: ({ children }: { children?: ReactNode }) => (
            <pre className="my-3 overflow-x-auto rounded bg-muted p-3 font-mono text-[13px] leading-6 [&_code]:bg-transparent [&_code]:p-0">
              {children}
            </pre>
          ),
          // Narration never reaches outward: links render as their text,
          // images as their alt text — an <img> would fire a live external
          // fetch (react-dom even preloads it), a surface prose must not have.
          a: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
          img: ({ alt }: { alt?: string }) => <span>{alt ?? ""}</span>,
        }}
      >
        {text}
      </Markdown>
      {streaming && <span className="animate-pulse">▋</span>}
    </div>
  );
}
