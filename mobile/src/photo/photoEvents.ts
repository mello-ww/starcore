type Listener = (photoId: string) => void;

const listeners = new Set<Listener>();

/** Tells open photo lists that a photo left the library (recycle bin or
 * Locked Folder) from somewhere else, e.g. the full-screen viewer, so they
 * can drop it in place without reloading and losing their scroll position. */
export function photoRemoved(photoId: string): void {
  listeners.forEach(listener => listener(photoId));
}

export function onPhotoRemoved(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
