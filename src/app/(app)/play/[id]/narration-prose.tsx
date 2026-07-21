"use client";

import type { DirectiveGrant } from "@/lib/types/premise";
import { type ReactElement, type ReactNode, isValidElement } from "react";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import {
  DIRECTIVE_CHROME,
  EYEBROW_DEVICES,
  directiveFenceName,
  resolveDirective,
} from "./directives";

/**
 * The markdown floor (§8 walk-back 2026-07-03: "the product layer renders,
 * never imposes" — until now it imposed plaintext, showing the KA's italics
 * as literal asterisks). Restrained by design: paragraphs, emphasis,
 * blockquotes, scene-break rules, modest headers. The M3-DG display grammar
 * rides on top: a fenced block (` ```readout … ``` `) whose info string names a
 * granted device renders in premise-styled chrome via the directive registry;
 * unknown/ungranted fences degrade to the plain offset fallback, and the whole
 * thing is streaming-safe by construction (react-markdown/CommonMark render an
 * unclosed fence as a forming code block, never garbage).
 */

/** The rendered directive block. Bypasses the inner <code> entirely: it takes
 *  the fence's raw text and wraps it in the resolved chrome (styled / neutral /
 *  fallback). The skin surfaces as `data-skin` + a select-none header eyebrow. */
function DirectiveBlock({
  name,
  granted,
  children,
}: {
  name: string;
  granted: readonly DirectiveGrant[];
  children: ReactNode;
}) {
  const res = resolveDirective(name, granted);
  if (res.mode === "fallback") {
    return (
      <div className={DIRECTIVE_CHROME.fallback} data-device="fallback" data-fence={res.name}>
        {children}
      </div>
    );
  }
  const skin = res.mode === "styled" ? res.skin : "";
  const showEyebrow = EYEBROW_DEVICES.has(res.name) && skin.length > 0;
  return (
    <div
      className={DIRECTIVE_CHROME[res.name]}
      data-device={res.name}
      data-skin={skin || undefined}
    >
      {showEyebrow && (
        <div
          aria-hidden
          className="mb-1 select-none font-semibold text-[0.7em] text-muted-foreground uppercase tracking-[0.15em]"
        >
          {skin}
        </div>
      )}
      {children}
    </div>
  );
}

export function NarrationProse({
  text,
  streaming = false,
  className = "text-[15px] leading-7",
  directives = [],
}: {
  text: string;
  streaming?: boolean;
  /** Replaces the default typography wholesale (recap/booth variants). */
  className?: string;
  /** M3-DG granted display devices (`contract.presentation_vocabulary.directives`).
   *  Absent → every device but the universal `memory` degrades to the plain
   *  offset fallback; `memory` still renders its neutral marking. */
  directives?: readonly DirectiveGrant[];
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
          // Fenced code blocks are the M3-DG directive seam. react-markdown
          // wraps a fence's <code> in this <pre>; a fence with an info string
          // (` ```readout `) gives the <code> a `language-<name>` class. A named
          // fence routes to the directive registry (styled / neutral / offset
          // fallback); a bare ``` fence (no info string, incl. a mid-stream
          // partial) stays the generic monospace block — never garbage.
          pre: ({ children }: { children?: ReactNode }) => {
            const codeEl = children as
              | ReactElement<{ className?: string; children?: ReactNode }>
              | undefined;
            const name = isValidElement(codeEl) ? directiveFenceName(codeEl.props.className) : null;
            if (name) {
              const inner = codeEl?.props?.children;
              // Trim the single trailing newline react-markdown keeps on fence
              // content, so a pre-wrap device doesn't gain a blank last line.
              const content = typeof inner === "string" ? inner.replace(/\n$/, "") : inner;
              return (
                <DirectiveBlock name={name} granted={directives}>
                  {content}
                </DirectiveBlock>
              );
            }
            return (
              <pre className="my-3 overflow-x-auto rounded bg-muted p-3 font-mono text-[13px] leading-6 [&_code]:bg-transparent [&_code]:p-0">
                {children}
              </pre>
            );
          },
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
