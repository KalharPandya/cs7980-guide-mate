// Thin fetch wrapper. Every simulated device declares itself via x-demo-source so the
// broker's event log can attribute requests — presentational honesty, not security.
export interface ApiResult<T> {
  status: number;
  data: T;
}

export async function api<T>(
  path: string,
  opts: { method?: "GET" | "POST"; body?: unknown; token?: string; source: string }
): Promise<ApiResult<T>> {
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers: {
      "x-demo-source": opts.source,
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: (await res.json()) as T };
}
