import {useNavigation} from '@react-navigation/native';
import {useMemo} from 'react';

export type TrackListKind = 'mix' | 'radio' | 'mood' | 'liked' | 'recent' | 'genre';

/** Music screens live in the Satellites stack; this reaches them from any tab, mini-player included. */
export function useMusicNavigation() {
  const navigation = useNavigation<any>();
  return useMemo(() => {
    const go = (screen: string, params?: object) => navigation.navigate('Satellites', {screen, params, initial: false});
    return {
      album: (id: string) => go('MusicAlbum', {id}),
      artist: (id: string) => go('MusicArtist', {id}),
      playlist: (id: string) => go('MusicPlaylist', {id}),
      tracks: (kind: TrackListKind, id: string, title: string) => go('MusicTracks', {kind, id, title}),
      settings: () => go('MusicSettings'),
      equalizer: () => go('MusicEqualizer'),
      downloads: () => go('MusicDownloads'),
    };
  }, [navigation]);
}
