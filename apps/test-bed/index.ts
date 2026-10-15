import { fetchHtml } from "scrape-ts";

const url = process.argv[2] ?? "https://example.com";

const result = await fetchHtml(url);

console.log(result);
