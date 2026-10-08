import type { ReactNode } from "react";

/** Renders `text` with the given [start, end) ranges wrapped in <mark>. */
export function Highlight({
  text,
  ranges,
}: {
  text: string;
  ranges: ReadonlyArray<[number, number]>;
}) {
  if (ranges.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(<mark key={start}>{text.slice(start, end)}</mark>);
    cursor = end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}
