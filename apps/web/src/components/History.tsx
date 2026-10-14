import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteHistoryEntry, fetchHistory } from "../api.ts";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** The signed-in user's previously scraped URLs. */
export function History({ onSelect }: { onSelect: (url: string) => void }) {
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
        {history.data.map((entry) => (
          <li key={entry.id}>
            <button type="button" className="history-url" onClick={() => onSelect(entry.url)}>
              {entry.url}
            </button>
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
        ))}
      </ul>
    </section>
  );
}
