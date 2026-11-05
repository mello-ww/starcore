import React, {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react';
import {AppState, PermissionsAndroid, Platform, StyleSheet, View} from 'react-native';
import Video, {type VideoRef} from 'react-native-video';
import {useAuth} from '../auth/AuthContext';
import {useServers} from '../servers/ServersContext';
import {ConnectClient} from './connect';
import {DownloadManager} from './downloads';
import {AudioLibraryClient, type AudioProvider, type Catalog, resolveAudioProvider} from './library';
import {audioEffects, nativeDownloads} from './native';
import {PlayerController, type PlayerState} from './player';
import {deviceId as loadDeviceId, musicKeys, readJson, type SavedQueue, writeJson} from './storage';
import type {MusicPreferences, Track} from './types';

/** What a Satellite's own native code may add to the shared player: a menu for a track
 * (add to a playlist, go to its album...), and links from the full player's title and artist.
 * Passed in once by the app's composition root, never looked up by Satellite name. */
export interface AudioHostExtensions {
  TrackMenu?: React.ComponentType<{tracks: Track[]; onClose: () => void}>;
  useTrackLinks?: () => {album?: (id: string) => void; artist?: (id: string) => void};
}

export interface AudioHostValue {
  library: AudioLibraryClient;
  /** The resolved provider, or null while the catalog is read or when the server has none. */
  provider: AudioProvider | null;
  player: PlayerController;
  downloads: DownloadManager;
  connect: ConnectClient | null;
  serverId: string;
  baseUrl: string;
  token: string | null;
  deviceId: string | null;
  preferences: MusicPreferences | null;
  updatePreferences: (changes: Partial<MusicPreferences>) => Promise<void>;
  liked: Set<string>;
  setLiked: (trackIds: string[], liked: boolean) => Promise<void>;
  fullPlayer: boolean;
  setFullPlayer: (open: boolean) => void;
  resolveTracks: (ids: string[]) => Promise<Track[]>;
  /** Plays what the provider finds for a search (the UI contract's play action); resolves
   * with how many tracks it found. */
  playSearch: (text: string) => Promise<number>;
  extensions: AudioHostExtensions;
}

const AudioHostContext = createContext<AudioHostValue | null>(null);

async function requestNotifications() {
  if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
    await PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS' as any).catch(() => undefined);
  }
}

/**
 * The app's one audio player (the `media.audio` client capability, docs/media-audio.md): it
 * plays from whichever Satellite the catalog lists as the `audio.library` provider. One host
 * per signed-in server: AuthProvider is keyed by server, so switching servers unmounts it
 * and with it the player, its queue, Connect device and downloads. It sits under the lock
 * screen overlay, so playback continues while the UI is locked.
 *
 * `fallbackProvider` is for servers older than the audio.library capability (the released
 * Alpha), whose catalog lists none; the composition root supplies it.
 */
export function AudioHost({
  children,
  fallbackProvider = null,
  extensions = {},
}: {
  children: React.ReactNode;
  fallbackProvider?: AudioProvider | null;
  extensions?: AudioHostExtensions;
}) {
  const {client, state} = useAuth();
  const {activeServer} = useServers();
  const token = state.status === 'signed-in' ? state.session.token : null;
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const baseUrl = activeServer?.baseUrl ?? '';
  const serverId = activeServer?.id ?? 'server';
  const library = useMemo(() => new AudioLibraryClient(client), [client]);
  const [provider, setProvider] = useState<AudioProvider | null>(null);
  const [preferences, setPreferences] = useState<MusicPreferences | null>(null);
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const deviceRef = useRef(deviceId);
  deviceRef.current = deviceId;
  const [liked, setLikedState] = useState<Set<string>>(new Set());
  const [fullPlayer, setFullPlayer] = useState(false);
  const videoRef = useRef<VideoRef>(null);
  const fallbackRef = useRef(fallbackProvider);
  fallbackRef.current = fallbackProvider;

  const downloads = useMemo(
    () =>
      new DownloadManager(
        serverId,
        baseUrl,
        () => (library.provider ? library : null),
        () => tokenRef.current,
        nativeDownloads(),
        () => audioEffects.getNetworkType(),
        () => ({
          quality: preferencesRef.current?.download_quality ?? 'original',
          format: preferencesRef.current?.transcode_format ?? 'opus',
          network: preferencesRef.current?.download_network ?? 'wifi',
          limitMb: preferencesRef.current?.cache_limit_mb ?? 2048,
        }),
      ),
    [serverId, baseUrl, library],
  );

  const player = useMemo(
    () =>
      new PlayerController({
        api: library,
        baseUrl,
        token: () => tokenRef.current,
        deviceId: () => deviceRef.current,
        downloads,
        effects: audioEffects,
        network: () => audioEffects.getNetworkType(),
        preferences: () => preferencesRef.current,
        saveLocal: saved => writeJson(musicKeys.queue(serverId), saved),
        requestNotifications,
      }),
    [library, baseUrl, downloads, serverId],
  );

  const resolveTracks = useMemo(
    () => async (ids: string[]) => {
      const known = new Map(player.state.queue.tracks.map(track => [track.id, track]));
      downloads.list().forEach(entry => known.set(entry.track.id, entry.track));
      const missing = ids.filter(id => !known.has(id));
      if (missing.length) {
        const saved = library.offersSession('queue') ? await library.savedQueue(deviceRef.current ?? '').catch(() => null) : null;
        (saved?.tracks ?? []).forEach(track => known.set(track.id, track));
        for (const id of ids.filter(candidate => !known.has(candidate)).slice(0, 200)) {
          const track = await library.track(id).catch(() => null);
          if (track) {
            known.set(id, track);
          }
        }
      }
      return ids.map(id => known.get(id)).filter((track): track is Track => !!track);
    },
    [library, downloads, player],
  );

  // StarCore Connect, when the provider's session offers it
  const connect = useMemo(
    () =>
      deviceId && provider?.session.connect
        ? new ConnectClient(library, deviceId, 'StarCore Mobile', {
            onCommand: (command, args) => player.handleCommand(command, args, resolveTracks),
            onRemoteState: (device, remoteState) => player.updateRemoteState(device, remoteState),
            onDevicesChanged: () => undefined,
          })
        : null,
    [library, deviceId, player, resolveTracks, provider],
  );

  // the saved queue is local, so it comes back before the server answers
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const id = await loadDeviceId(serverId);
      if (cancelled) {
        return;
      }
      setDeviceId(id);
      const saved = await readJson<SavedQueue>(musicKeys.queue(serverId));
      if (!cancelled && saved?.tracks?.length) {
        player.restore(saved);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [player, serverId]);

  // the provider, from the capability catalog; then what its session offers
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let catalog: Catalog | null = null;
      try {
        const {status, body} = await client.get('/api/catalog');
        catalog = status === 200 && body?.capabilities ? body.capabilities : null;
      } catch {
        catalog = null;
      }
      if (cancelled) {
        return;
      }
      const resolved = resolveAudioProvider(catalog, fallbackRef.current);
      library.setProvider(resolved);
      setProvider(resolved);
      if (!resolved) {
        return;
      }
      if (library.offersSession('preferences')) {
        library.preferences().then(value => !cancelled && setPreferences(value)).catch(() => undefined);
      }
      if (library.offersSession('favorites')) {
        library.favorites().then(value => !cancelled && setLikedState(new Set(value.ids.track ?? []))).catch(() => undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, library]);

  useEffect(() => {
    if (!connect) {
      return;
    }
    const update = (status: string) => (status === 'active' ? connect.start() : connect.stop());
    update(AppState.currentState);
    const subscription = AppState.addEventListener('change', update);
    return () => {
      subscription.remove();
      connect.stop();
    };
  }, [connect]);

  useEffect(() => () => player.dispose(), [player]);
  useEffect(() => () => downloads.dispose(), [downloads]);

  useEffect(() => {
    player.seeker = seconds => videoRef.current?.seek(seconds);
    return () => {
      player.seeker = null;
    };
  }, [player]);

  useEffect(() => {
    if (preferences) {
      player.setSpeed(preferences.speed ?? 1);
      player.applyEffects();
    }
  }, [player, preferences]);

  const updatePreferences = useCallback(
    async (changes: Partial<MusicPreferences>) => {
      if (!library.offersSession('preferences')) {
        return;
      }
      setPreferences(current => (current ? {...current, ...changes} : current));
      const saved = await library.updatePreferences(changes);
      setPreferences(saved);
    },
    [library],
  );

  const setLiked = useCallback(
    async (trackIds: string[], isLiked: boolean) => {
      // a provider without favorites keeps no likes: nothing to change or to send
      if (!library.offersSession('favorites')) {
        return;
      }
      setLikedState(current => {
        const next = new Set(current);
        trackIds.forEach(id => (isLiked ? next.add(id) : next.delete(id)));
        return next;
      });
      const result = await library.setFavorite('track', trackIds, isLiked);
      setLikedState(new Set(result.ids.track ?? []));
    },
    [library],
  );

  const playSearch = useCallback(
    async (text: string) => {
      await library.ready;
      if (!library.provider) {
        throw new Error('There is no audio library to play from.');
      }
      const found = await library.search(text);
      const tracks = (found.tracks ?? []).filter(track => track && track.id);
      if (tracks.length) {
        await player.playTracks(tracks, 0, `search:${text}`);
      }
      return tracks.length;
    },
    [library, player],
  );

  const value: AudioHostValue = {
    library,
    provider,
    player,
    downloads,
    connect,
    serverId,
    baseUrl,
    token,
    deviceId,
    preferences,
    updatePreferences,
    liked,
    setLiked,
    fullPlayer,
    setFullPlayer,
    resolveTracks,
    playSearch,
    extensions,
  };

  return (
    <AudioHostContext.Provider value={value}>
      {children}
      <AudioOutput player={player} videoRef={videoRef} downloads={downloads} />
    </AudioHostContext.Provider>
  );
}

/** The native player (react-native-video on Media3): background playback, the media
 * notification, lock-screen controls and audio focus all come from it. */
function AudioOutput({
  player,
  videoRef,
  downloads,
}: {
  player: PlayerController;
  videoRef: React.RefObject<VideoRef>;
  downloads: DownloadManager;
}) {
  const state = usePlayerState(player);
  const [artwork, setArtwork] = useState<string | undefined>(undefined);
  const albumId = state.track?.has_artwork ? state.track.album_id : null;

  useEffect(() => {
    let cancelled = false;
    setArtwork(undefined);
    if (albumId) {
      downloads.artworkFile(albumId).then(uri => !cancelled && setArtwork(uri ?? undefined));
    }
    return () => {
      cancelled = true;
    };
  }, [albumId, downloads]);

  if (!state.source || !state.track) {
    return null;
  }
  const track = state.track;
  return (
    <View style={styles.hidden} pointerEvents="none">
      <Video
        key={`${state.sourceKey}`}
        ref={videoRef}
        source={{
          uri: state.source.uri,
          headers: state.source.headers,
          metadata: {
            title: track.title,
            artist: track.artist ?? track.album_artist,
            subtitle: track.album ?? undefined,
            imageUri: artwork,
          },
        }}
        paused={!state.playing}
        rate={state.speed}
        volume={state.volume}
        playInBackground
        playWhenInactive
        showNotificationControls
        progressUpdateInterval={1000}
        onLoad={event => player.onLoad(event.duration)}
        onProgress={event => player.onProgress(event.currentTime)}
        onBuffer={event => player.onBuffer(event.isBuffering)}
        onEnd={() => player.onEnd()}
        onError={event => player.onError(event.error?.errorString)}
        onAudioBecomingNoisy={() => player.onInterrupted()}
        onAudioFocusChanged={event => !event.hasAudioFocus && player.onInterrupted()}
        style={styles.hidden}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  hidden: {position: 'absolute', width: 0, height: 0, opacity: 0},
});

export function useAudioHost(): AudioHostValue {
  const value = useContext(AudioHostContext);
  if (!value) {
    throw new Error('useAudioHost() must be used inside an AudioHost');
  }
  return value;
}

/** The host, or null outside one (a screen rendered on its own, as in tests). */
export function useOptionalAudioHost(): AudioHostValue | null {
  return useContext(AudioHostContext);
}

export function usePlayerState(player?: PlayerController): PlayerState {
  const context = useContext(AudioHostContext);
  const controller = player ?? context!.player;
  const [state, setState] = useState(controller.state);
  useEffect(() => {
    setState(controller.state);
    return controller.subscribe(setState);
  }, [controller]);
  return state;
}

/** Only re-renders when the playing track changes, not on every progress tick. */
export function useCurrentTrackId(): string | null {
  const {player} = useAudioHost();
  const [id, setId] = useState(player.state.track?.id ?? null);
  useEffect(() => {
    setId(player.state.track?.id ?? null);
    return player.subscribe(state => setId(state.track?.id ?? null));
  }, [player]);
  return id;
}

/** An album's cover from the provider's artwork operation, or null without one. */
export function useArtworkUri(albumId: string | null | undefined, size = 300) {
  const {library, provider, baseUrl, token} = useAudioHost();
  return useMemo(() => {
    const path = albumId && provider ? library.artworkPath(albumId, size) : null;
    return path ? {uri: library.url(baseUrl, path), headers: token ? {Authorization: `Bearer ${token}`} : undefined} : null;
  }, [albumId, baseUrl, library, provider, size, token]);
}
