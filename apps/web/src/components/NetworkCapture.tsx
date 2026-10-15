import type { UseQueryResult } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { NetworkResponse } from "../api.ts";
import { formatNumber } from "../format.ts";

interface NetworkCaptureProps {
  network: UseQueryResult<NetworkResponse>;
  onCapture: () => void;
  /** Set when the current request can't be captured; disables the trigger and explains why. */
  disabledReason?: string;
}

/** Trigger + status for the on-demand Playwright network capture. */
export function NetworkCapture({ network, onCapture, disabledReason }: NetworkCaptureProps) {
  const [showScreenshot, setShowScreenshot] = useState(false);
  const elapsed = useElapsedSeconds(network.isFetching);
  const { data, error } = network;

  return (
    <div className="network-capture">
      {network.isFetching ? (
        <span className="meta">Capturing network requests… {elapsed}s</span>
      ) : error ? (
        <span className="network-error">
          <strong>{"code" in error ? String(error.code) : "Error"}</strong> {error.message}
        </span>
      ) : disabledReason ? (
        <span className="meta">Network capture is GET-only</span>
      ) : data ? (
        <span className="meta">
          {formatNumber(data.docs.length)} data of {formatNumber(data.totalRequests)} requests ·{" "}
          {(data.durationMs / 1000).toFixed(1)}s{!data.reachedIdle && " (never idle)"}
        </span>
      ) : null}
      {data?.screenshot && !network.isFetching && (
        <button type="button" className="link" onClick={() => setShowScreenshot(true)}>
          Screenshot
        </button>
      )}
      <button
        type="button"
        className="small"
        onClick={onCapture}
        disabled={network.isFetching || disabledReason !== undefined}
        title={disabledReason}
      >
        {data || error ? "Re-capture network" : "Capture network requests"}
      </button>
      {showScreenshot && data?.screenshot && (
        <ScreenshotDialog
          src={data.screenshot}
          url={data.url}
          onClose={() => setShowScreenshot(false)}
        />
      )}
    </div>
  );
}

function useElapsedSeconds(running: boolean) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!running) return;
    setSeconds(0);
    const started = Date.now();
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 250);
    return () => clearInterval(id);
  }, [running]);
  return seconds;
}

function ScreenshotDialog({
  src,
  url,
  onClose,
}: {
  src: string;
  url: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      className="screenshot-dialog"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) ref.current?.close();
      }}
    >
      <header className="dialog-head">
        <h2 className="label">Screenshot · {url}</h2>
        <button
          type="button"
          className="ghost"
          onClick={() => ref.current?.close()}
          aria-label="Close"
        >
          ✕
        </button>
      </header>
      <div className="screenshot-body">
        <img src={src} alt={`Screenshot of ${url} after network capture`} />
      </div>
    </dialog>
  );
}
