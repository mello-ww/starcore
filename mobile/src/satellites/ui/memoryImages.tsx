import {createContext, useContext, useEffect, useState} from 'react';

/**
 * Images that never reach a disk cache (UI contract 1.2, a protected document): inside a
 * `MemoryImages` provider set to true, every image the shared renderers draw is fetched with
 * its headers and shown from memory as a data URI, never handed to the image loader as a URL -
 * which would keep a copy in its disk cache. The server marks a protected store's files
 * `no-store`, so the HTTP layer keeps none either. Nothing outlives the component that drew it.
 * Elsewhere images load as they always do. The same provider tells a renderer that opens a
 * window of its own (the media viewer) that it shows a protected document, so that window can't
 * be captured either (src/components/SecureWindow.tsx).
 */
export const MemoryImages = createContext(false);

export type ImageSource = {uri: string; headers?: Record<string, string>};

/** Fetches an image into memory: a data URI, or an error when it can't be read. */
export async function loadDataUri(source: ImageSource): Promise<string> {
  const response = await fetch(source.uri, {headers: source.headers});
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('empty')));
    reader.onerror = () => reject(new Error('unreadable'));
    reader.readAsDataURL(blob);
  });
}

/**
 * What an `<Image>` is given for `source`: the source itself, or inside `MemoryImages` its
 * data URI once fetched (null meanwhile). `failed` is true when that fetch failed, so the caller
 * draws its placeholder as it does for an image that can't load.
 */
export function useImageSource(source: ImageSource | null | undefined): [ImageSource | null, boolean] {
  const memory = useContext(MemoryImages);
  const uri = source?.uri ?? null;
  const headers = source?.headers;
  const headersKey = headers ? JSON.stringify(headers) : '';
  const [loaded, setLoaded] = useState<{uri: string; data: string | null} | null>(null);
  useEffect(() => {
    if (!memory || !uri) {
      return;
    }
    let alive = true;
    setLoaded(null);
    loadDataUri({uri, headers: headersKey ? JSON.parse(headersKey) : undefined})
      .then(data => alive && setLoaded({uri, data}))
      .catch(() => alive && setLoaded({uri, data: null}));
    return () => {
      alive = false;
    };
  }, [memory, uri, headersKey]);
  if (!memory || !source) {
    return [source ?? null, false];
  }
  if (!loaded || loaded.uri !== uri) {
    return [null, false];
  }
  return loaded.data ? [{uri: loaded.data}, false] : [null, true];
}
