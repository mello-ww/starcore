import {useCallback, useEffect, useState} from 'react';
import {FAVORITES_ALBUM_ID} from './types';
import {usePhotoApi} from './usePhotoApi';

/**
 * The set of currently-favorited photo ids, shared by every screen that
 * shows a heart toggle (Library, Albums/PhotoAlbumScreen, the viewer) - one
 * fetch of the Favorites album's own photo_ids (GET /albums/favorites),
 * exactly the same album the web panel's own heart toggle reads and writes
 * (see albums.py's FAVORITES_ID). This hook never invents a second notion
 * of "favorite" - toggling here is the same add/removePhotoFromAlbum call
 * any other album membership change uses.
 */
export function useFavorites() {
  const {api} = usePhotoApi();
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    try {
      const detail = await api.album(FAVORITES_ALBUM_ID);
      setFavoriteIds(new Set(detail.photo_ids ?? detail.photos.map(photo => photo.id)));
    } catch {
      // Favorites is always present server-side (see AlbumStore.
      // ensure_favorites()) - a failure here is a transient network issue,
      // not "no favorites yet"; the set simply stays whatever it last was
    } finally {
      setLoaded(true);
    }
  }, [api]);

  useEffect(() => {
    reload();
  }, [reload]);

  const toggle = useCallback(
    async (photoId: string): Promise<boolean> => {
      const makeFavorite = !favoriteIds.has(photoId);
      // optimistic - the heart flips immediately, and is put back only if
      // the request actually fails, the same pattern PhotoLibraryTab's own
      // selection state already uses
      setFavoriteIds(current => {
        const next = new Set(current);
        if (makeFavorite) {
          next.add(photoId);
        } else {
          next.delete(photoId);
        }
        return next;
      });

      try {
        if (makeFavorite) {
          await api.favorite(photoId);
        } else {
          await api.unfavorite(photoId);
        }
        return makeFavorite;
      } catch (error) {
        setFavoriteIds(current => {
          const next = new Set(current);
          if (makeFavorite) {
            next.delete(photoId);
          } else {
            next.add(photoId);
          }
          return next;
        });
        throw error;
      }
    },
    [api, favoriteIds],
  );

  return {favoriteIds, loaded, reload, toggle};
}
