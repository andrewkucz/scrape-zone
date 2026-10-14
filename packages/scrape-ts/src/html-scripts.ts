import { load } from "cheerio";

/** Internal source ranges let consumers remove scripts without serializing the DOM. */
export interface HtmlScript {
  content: string;
  isJson: boolean;
  start: number;
  end: number;
}

export function readHtmlScripts(html: string): HtmlScript[] {
  const $ = load(html, { sourceCodeLocationInfo: true });
  const scripts: HtmlScript[] = [];
  $("script").each((_, element) => {
    const location = element.sourceCodeLocation;
    if (!location) return;
    const type = $(element).attr("type");
    scripts.push({
      content: $(element).html() ?? "",
      isJson: type === "application/json" || type === "application/ld+json",
      start: location.startOffset,
      end: location.endOffset,
    });
  });
  return scripts;
}

export function removeHtmlScripts(html: string, scripts: Set<HtmlScript>): string {
  let result = "";
  let offset = 0;
  for (const script of [...scripts].sort((a, b) => a.start - b.start)) {
    result += html.slice(offset, script.start);
    offset = script.end;
  }
  return result + html.slice(offset);
}
