import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteHistoryEntry, fetchHistory, type HistoryEntry } from "../api.ts";
import { describeOptions } from "./AdvancedOptions.tsx";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** The signed-in user's previously scraped URLs, with the request options last used for each. */
export function History({ onSelect }: { onSelect: (entry: HistoryEntry) => void }) {
  const queryClient = useQueryClient();
  const history = useQuery({
    queryKey: ["history"],
    queryFn: ({ signal }) => fetchHistory(signal),
  });
  const remove = useMutation({
    mutationFn: deleteHistoryEntry,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["history"] }),
  });

  if (!history.data?.length) return null;

  return (
    <section className="history">
      <h2>Recent</h2>
      <ul>
        {history.data.map((entry) => {
          const options = describeOptions(entry.request);
          return (
            <li key={entry.id}>
              <button type="button" className="history-url" onClick={() => onSelect(entry)}>
                {entry.url}
              </button>
              {options && <span className="history-options">{options}</span>}
              <time dateTime={entry.scrapedAt}>{dateFormat.format(new Date(entry.scrapedAt))}</time>
              <button
                type="button"
                className="ghost history-remove"
                onClick={() => remove.mutate(entry.id)}
                aria-label={`Remove ${entry.url} from history`}
                title="Remove"
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
