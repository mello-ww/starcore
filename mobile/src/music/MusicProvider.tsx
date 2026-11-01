import React, {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react';
import {AppState, PermissionsAndroid, Platform, StyleSheet, View} from 'react-native';
import Video, {type VideoRef} from 'react-native-video';
import {useAuth} from '../auth/AuthContext';
import {useServers} from '../servers/ServersContext';
import {MusicApi, musicUrl} from './api';
import {ConnectClient} from './connect';
import {DownloadManager} from './downloads';
import {audioEffects, nativeDownloads} from './native';
import {PlayerController, type PlayerState} from './player';
import {deviceId as loadDeviceId, musicKeys, readJson, type SavedQueue, writeJson} from './storage';
import type {MusicPreferences, Track} from './types';

interface MusicContextValue {
  api: MusicApi;
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
}

const MusicContext = createContext<MusicContextValue | null>(null);

async function requestNotifications() {
  if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
    await PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS' as any).catch(() => undefined);
  }
}

/**
 * One music player per signed-in server. AuthProvider is keyed by server, so switching
 * servers unmounts this and with it the player, its queue, Connect device and downloads.
 * It sits under the lock screen overlay, so playback continues while the UI is locked.
 */
export function MusicProvider({children}: {children: React.ReactNode}) {
  const {client, state} = useAuth();
  const {activeServer} = useServers();
  const token = state.status === 'signed-in' ? state.session.token : null;
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const baseUrl = activeServer?.baseUrl ?? '';
  const serverId = activeServer?.id ?? 'server';
  const api = useMemo(() => new MusicApi(client), [client]);
  const [preferences, setPreferences] = useState<MusicPreferences | null>(null);
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const deviceRef = useRef(deviceId);
  deviceRef.current = deviceId;
  const [liked, setLikedState] = useState<Set<string>>(new Set());
  const [fullPlayer, setFullPlayer] = useState(false);
  const videoRef = useRef<VideoRef>(null);

  const downloads = useMemo(
    () =>
      new DownloadManager(
        serverId,
        baseUrl,
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
    [serverId, baseUrl],
  );

  const player = useMemo(
    () =>
      new PlayerController({
        api,
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
    [api, baseUrl, downloads, serverId],
  );

  const resolveTracks = useMemo(
    () => async (ids: string[]) => {
      const known = new Map(player.state.queue.tracks.map(track => [track.id, track]));
      downloads.list().forEach(entry => known.set(entry.track.id, entry.track));
      const missing = ids.filter(id => !known.has(id));
      if (missing.length) {
        const saved = await api.savedQueue(deviceRef.current ?? '').catch(() => null);
        (saved?.tracks ?? []).forEach(track => known.set(track.id, track));
        for (const id of ids.filter(candidate => !known.has(candidate)).slice(0, 200)) {
          const track = await api.track(id).catch(() => null);
          if (track) {
            known.set(id, track);
          }
        }
      }
      return ids.map(id => known.get(id)).filter((track): track is Track => !!track);
    },
    [api, downloads, player],
  );

  const connect = useMemo(
    () =>
      deviceId
        ? new ConnectClient(api, deviceId, 'StarCore Mobile', {
            onCommand: (command, args) => player.handleCommand(command, args, resolveTracks),
            onRemoteState: (device, remoteState) => player.updateRemoteState(device, remoteState),
            onDevicesChanged: () => undefined,
          })
        : null,
    [api, deviceId, player, resolveTracks],
  );

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
    api
      .preferences()
      .then(value => !cancelled && setPreferences(value))
      .catch(() => undefined);
    api
      .favorites()
      .then(value => !cancelled && setLikedState(new Set(value.ids.track ?? [])))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, player, serverId]);

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
      setPreferences(current => (current ? {...current, ...changes} : current));
      const saved = await api.updatePreferences(changes);
      setPreferences(saved);
    },
    [api],
  );

  const setLiked = useCallback(
    async (trackIds: string[], isLiked: boolean) => {
      setLikedState(current => {
        const next = new Set(current);
        trackIds.forEach(id => (isLiked ? next.add(id) : next.delete(id)));
        return next;
      });
      const result = await api.setFavorite('track', trackIds, isLiked);
      setLikedState(new Set(result.ids.track ?? []));
    },
    [api],
  );

  const value: MusicContextValue = {
    api,
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
  };

  return (
    <MusicContext.Provider value={value}>
      {children}
      <AudioOutput player={player} videoRef={videoRef} downloads={downloads} baseUrl={baseUrl} />
    </MusicContext.Provider>
  );
}

function AudioOutput({
  player,
  videoRef,
  downloads,
}: {
  player: PlayerController;
  videoRef: React.RefObject<VideoRef>;
  downloads: DownloadManager;
  baseUrl: string;
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

export function useMusic(): MusicContextValue {
  const value = useContext(MusicContext);
  if (!value) {
    throw new Error('useMusic() must be used inside a MusicProvider');
  }
  return value;
}

export function usePlayerState(player?: PlayerController): PlayerState {
  const context = useContext(MusicContext);
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
  const {player} = useMusic();
  const [id, setId] = useState(player.state.track?.id ?? null);
  useEffect(() => {
    setId(player.state.track?.id ?? null);
    return player.subscribe(state => setId(state.track?.id ?? null));
  }, [player]);
  return id;
}

export function useArtworkUri(albumId: string | null | undefined, size = 300) {
  const {baseUrl, token} = useMusic();
  return useMemo(
    () =>
      albumId
        ? {uri: musicUrl(baseUrl, `artwork/${encodeURIComponent(albumId)}?size=${size}`),
           headers: token ? {Authorization: `Bearer ${token}`} : undefined}
        : null,
    [albumId, baseUrl, size, token],
  );
}
