import { useEffect, useRef, useState } from "react";

/**
 * Poll a function at a given interval until `shouldStop` returns true.
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  shouldStop: (data: T) => boolean,
  enabled = true,
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const poll = async () => {
      try {
        const result = await fetcher();
        setData(result);
        setError(null);
        if (shouldStop(result) && timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Polling error");
      }
    };

    poll(); // immediate first call
    timerRef.current = setInterval(poll, intervalMs);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  return { data, error };
}
