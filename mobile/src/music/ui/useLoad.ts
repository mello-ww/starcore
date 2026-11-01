import {useCallback, useEffect, useRef, useState} from 'react';

/** Loads once per dependency change; keeps the last good data visible while reloading. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);

  const reload = useCallback(() => {
    const current = ++generation.current;
    setLoading(true);
    load()
      .then(value => {
        if (current === generation.current) {
          setData(value);
          setError(null);
        }
      })
      .catch((failure: any) => {
        if (current === generation.current) {
          setError(failure?.message ?? 'Something went wrong.');
        }
      })
      .finally(() => current === generation.current && setLoading(false));
  }, deps);

  useEffect(() => {
    reload();
  }, [reload]);

  return {data, error, loading, reload, setData};
}
