import { config } from "@/lib/config";
import { ApiError, parseApiError } from "@/lib/errors";

export interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  params?: Record<string, string | number | undefined>;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

function buildQueryString(
  params?: Record<string, string | number | undefined>
): string {
  if (!params) return "";
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null
  );
  if (entries.length === 0) return "";
  return "?" + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
}

export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const { method = "GET", body, headers = {}, params, idempotencyKey, signal } = options;

  const url = `${config.apiBaseUrl}${path}${buildQueryString(params)}`;

  const fetchHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...headers,
  };

  if (idempotencyKey) {
    fetchHeaders["Idempotency-Key"] = idempotencyKey;
  }

  // Attach tenant headers for header-auth dev mode
  const storedTenant = typeof window !== "undefined" ? localStorage.getItem("vc-tenant") : null;
  if (storedTenant) {
    fetchHeaders["x-vc-tenant"] = storedTenant;
    const storedOrg = localStorage.getItem("vc-org");
    const storedProject = localStorage.getItem("vc-project");
    if (storedOrg) fetchHeaders["x-vc-org"] = storedOrg;
    if (storedProject) fetchHeaders["x-vc-project"] = storedProject;
  }

  const response = await fetch(url, {
    method,
    headers: fetchHeaders,
    body: body ? JSON.stringify(body) : undefined,
    signal,
    credentials: "include",
  });

  if (!response.ok) {
    throw await parseApiError(response);
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

export { ApiError };
