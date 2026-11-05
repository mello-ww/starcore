import React, {useMemo} from 'react';
import {useAuth} from '../auth/AuthContext';
import {AudioHost, type AudioHostExtensions, type AudioHostValue, useAudioHost} from '../media/AudioHost';
import type {AudioProvider} from '../media/library';
import {MUSIC_BASE, MusicApi} from './api';
import {TrackActions} from './ui/TrackActions';
import {useMusicNavigation} from './ui/navigation';

export {usePlayerState, useCurrentTrackId, useArtworkUri} from '../media/AudioHost';

/**
 * Music's native screens on top of the shared AudioHost (docs/media-audio.md): the host plays,
 * and Music adds its library API, its track menu and links to its own screens.
 */
export interface MusicContextValue extends AudioHostValue {
  api: MusicApi;
}

/** The provider on a server whose catalog lists no audio.library: one older than the
 * capability, such as the released Alpha. These are Music's routes as they have always been. */
export const MUSIC_LEGACY_PROVIDER: AudioProvider = {
  satellite: MUSIC_BASE.slice('/api/satellites/'.length),
  operations: {search: 'search', track: 'tracks', resolve: 'playback', artwork: 'artwork', lyrics: 'lyrics'},
  session: {queue: 'queue', history: 'history', radio: 'radio', preferences: 'preferences', favorites: 'favorites',
            stream: 'stream', connect: 'connect'},
};

function useTrackLinks() {
  const go = useMusicNavigation();
  return useMemo(() => ({album: go.album, artist: go.artist}), [go]);
}

/** What Music's native code adds to the shared player. */
export const MUSIC_AUDIO_EXTENSIONS: AudioHostExtensions = {TrackMenu: TrackActions, useTrackLinks};

/** The AudioHost with Music's additions - what the app shell mounts through its composition
 * root, and what Music's tests render. */
export function MusicProvider({children}: {children: React.ReactNode}) {
  return (
    <AudioHost fallbackProvider={MUSIC_LEGACY_PROVIDER} extensions={MUSIC_AUDIO_EXTENSIONS}>
      {children}
    </AudioHost>
  );
}

/** The host, plus Music's own API. Music's screens always reach Music's routes: they are
 * Music's own code, and another audio.library provider shouldn't receive them. */
export function useMusic(): MusicContextValue {
  const host = useAudioHost();
  const {client} = useAuth();
  const api = useMemo(() => new MusicApi(client), [client]);
  return {...host, api};
}
