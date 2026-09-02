import { useEffect, useRef, useCallback, useState } from "react";
import { config } from "@/lib/config";
import type { SSEConnectionState } from "@/types";

export interface UseEventStreamOptions {
  /** Base URL path for the SSE endpoint */
  path: string;
  /** Whether to start streaming */
  enabled?: boolean;
  /** Auto-reconnect on disconnect */
  autoReconnect?: boolean;
  /** Max reconnect attempts (default: 10) */
  maxReconnectAttempts?: number;
  /** Called when a JSON event is received */
  onEvent: (eventType: string, data: unknown, lastSeq: number | null) => void;
  /** Called when stream receives "done" event */
  onDone?: () => void;
}

export function useEventStream(options: UseEventStreamOptions) {
  const {
    path,
    enabled = true,
    autoReconnect = true,
    maxReconnectAttempts = 10,
    onEvent,
    onDone,
  } = options;

  const [state, setState] = useState<SSEConnectionState>({
    status: "connecting",
    lastSeq: null,
    error: null,
  });

  const lastSeqRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const reconnectCountRef = useRef(0);
  const seenSeqsRef = useRef<Set<number>>(new Set());
  const onEventRef = useRef(onEvent);
  const onDoneRef = useRef(onDone);

  onEventRef.current = onEvent;
  onDoneRef.current = onDone;

  const cleanup = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    cleanup();
    if (!enabled) return;

    const controller = new AbortController();
    abortRef.current = controller;

    setState((s) => ({ ...s, status: "connecting", error: null }));

    // Build URL with after cursor for resume
    const url = new URL(`${config.apiBaseUrl}${path}`);
    if (lastSeqRef.current !== null) {
      url.searchParams.set("after", String(lastSeqRef.current));
    }
    url.searchParams.set("follow", "true");

    // For header-auth dev mode, we need to use fetch-based streaming
    // since EventSource doesn't support custom headers
    const headers: Record<string, string> = {};
    const storedTenant = localStorage.getItem("vc-tenant");
    if (storedTenant) {
      headers["x-vc-tenant"] = storedTenant;
      const storedOrg = localStorage.getItem("vc-org");
      const storedProject = localStorage.getItem("vc-project");
      if (storedOrg) headers["x-vc-org"] = storedOrg;
      if (storedProject) headers["x-vc-project"] = storedProject;
    }

    fetch(url.toString(), {
      headers: { Accept: "text/event-stream", ...headers },
      signal: controller.signal,
      credentials: "include",
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`SSE connection failed: ${response.status}`);
        }

        setState((s) => ({ ...s, status: "connected" }));
        reconnectCountRef.current = 0;

        const reader = response.body?.getReader();
        if (!reader) return;

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          let eventType = "message";
          let dataLines: string[] = [];
          let lastEventId: string | null = null;

          for (const line of lines) {
            if (line.startsWith("event:")) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              dataLines.push(line.slice(5).trim());
            } else if (line.startsWith("id:")) {
              lastEventId = line.slice(3).trim();
            } else if (line === "" && dataLines.length > 0) {
              // Event boundary — process
              const dataStr = dataLines.join("\n");
              dataLines = [];

              if (eventType === "done") {
                onDoneRef.current?.();
                cleanup();
                setState((s) => ({ ...s, status: "disconnected" }));
                return;
              }

              try {
                const data = JSON.parse(dataStr);
                const seq = data.seq ?? (lastEventId ? parseInt(lastEventId) : null);

                // Duplicate suppression
                if (seq !== null && seenSeqsRef.current.has(seq)) {
                  continue;
                }

                if (seq !== null) {
                  seenSeqsRef.current.add(seq);
                  lastSeqRef.current = seq;
                }

                onEventRef.current(eventType, data, seq);
              } catch {
                // Non-JSON data, emit raw
                onEventRef.current(eventType, dataStr, null);
              }
            }
          }
        }

        // Stream ended without "done"
        setState((s) => ({ ...s, status: "disconnected" }));
      })
      .catch((error) => {
        if (controller.signal.aborted) return;

        setState((s) => ({
          ...s,
          status: "error",
          error: error.message || "Connection failed",
        }));

        // Auto-reconnect with backoff
        if (autoReconnect && reconnectCountRef.current < maxReconnectAttempts) {
          const delay = Math.min(1000 * Math.pow(2, reconnectCountRef.current), 30000);
          reconnectCountRef.current++;
          setTimeout(() => {
            if (!controller.signal.aborted) {
              connect();
            }
          }, delay);
        }
      });
  }, [path, enabled, autoReconnect, maxReconnectAttempts, cleanup]);

  useEffect(() => {
    connect();
    return cleanup;
  }, [connect, cleanup]);

  return {
    state,
    reconnect: () => {
      reconnectCountRef.current = 0;
      seenSeqsRef.current.clear();
      connect();
    },
    disconnect: cleanup,
  };
}
