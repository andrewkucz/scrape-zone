/**
 * Lowercases for case-insensitive search while guaranteeing the output has the
 * same length as the input, so match offsets map 1:1 back onto the original.
 */
export function foldCase(s: string): string {
  const lower = s.toLowerCase();
  if (lower.length === s.length) return lower;
  // Rare: a few characters expand when lowercased (e.g. "İ"). Leave those as-is.
  let out = "";
  for (const ch of s) {
    const l = ch.toLowerCase();
    out += l.length === ch.length ? l : ch;
  }
  return out;
}

/** Finds every non-overlapping occurrence of `needle` (already folded) in `text`. */
export function findRanges(text: string, needle: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  if (!needle) return ranges;
  const haystack = foldCase(text);
  for (
    let i = haystack.indexOf(needle);
    i !== -1;
    i = haystack.indexOf(needle, i + needle.length)
  ) {
    ranges.push([i, i + needle.length]);
  }
  return ranges;
}
