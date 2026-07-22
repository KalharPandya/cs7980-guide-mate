import { useCallback, useState } from "react";
import type { DispatchRequest, DispatchResponse } from "../lib/types";

interface DispatchState {
  data: DispatchResponse | null;
  loading: boolean;
  error: string | null;
}

export function useDispatch() {
  const [state, setState] = useState<DispatchState>({ data: null, loading: false, error: null });

  const dispatch = useCallback(async (req: DispatchRequest): Promise<DispatchResponse | null> => {
    setState({ data: null, loading: true, error: null });
    try {
      const r = await fetch("/api/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      const data = (await r.json()) as DispatchResponse;
      if ((data as unknown as { error?: string }).error) {
        throw new Error((data as unknown as { error: string }).error);
      }
      setState({ data, loading: false, error: null });
      return data;
    } catch (e) {
      setState({ data: null, loading: false, error: String(e) });
      return null;
    }
  }, []);

  const reset = useCallback(() => setState({ data: null, loading: false, error: null }), []);

  return { ...state, dispatch, reset };
}
