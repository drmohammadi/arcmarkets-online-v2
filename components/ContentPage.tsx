'use client';

import { Header } from './Header';

/**
 * Shell for static prose pages (About, Terms, Privacy).
 *
 * These pages are plain text with no chain reads, so they share one narrow,
 * readable column and the same heading rhythm. Text is passed as children and
 * rendered as escaped nodes — no `dangerouslySetInnerHTML`, per the repo rule,
 * which is why the content is authored as JSX rather than as a Markdown string.
 *
 * `lastUpdated` is a plain string rather than a formatted Date: these are legal
 * pages where the date is part of the document's meaning, so it should change
 * only when someone edits the copy, never because the page was re-rendered.
 */
export function ContentPage({
  title,
  intro,
  lastUpdated,
  children,
}: {
  title: string;
  intro?: string;
  lastUpdated?: string;
  children: React.ReactNode;
}) {
  return (
    <main className="flex-1">
      <Header />
      <div id="main" className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-10">
        <h1 className="text-xl font-semibold tracking-tight text-content sm:text-2xl">{title}</h1>
        {intro && <p className="mt-2 text-sm text-content-muted">{intro}</p>}
        {lastUpdated && (
          <p className="mt-1 text-2xs uppercase tracking-wide text-content-subtle">
            Last updated {lastUpdated}
          </p>
        )}
        <div className="mt-8 space-y-8">{children}</div>
      </div>
    </main>
  );
}

/** A titled section of a content page. */
export function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-base font-semibold text-content">{heading}</h2>
      <div className="space-y-3 text-sm leading-relaxed text-content-muted">{children}</div>
    </section>
  );
}

/** Bulleted list with the same rhythm as Section prose. */
export function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}
