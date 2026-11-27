import React, {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react';
import {AppState, PermissionsAndroid, Platform, StyleSheet, View} from 'react-native';
import Video, {type VideoRef} from 'react-native-video';
import {useAuth} from '../auth/AuthContext';
import {UiApi} from '../satellites/ui/api';
import {locateProvider, openedPage, type Providers, type UiAudio} from '../satellites/ui/contract';
import {useServers} from '../servers/ServersContext';
import {ConnectClient} from './connect';
import {DownloadManager} from './downloads';
import {handOver, type HandOverOptions} from './handover';
import {AudioLibraryClient, type AudioProvider, type Catalog, resolveAudioProvider} from './library';
import {audioEffects, backgroundTimers, nativeDownloads} from './native';
import {PlayerController, type PlayerState, type Source} from './player';
import {deviceId as loadDeviceId, playerKeys, readJson, type SavedQueue, writeJson} from './storage';
import type {PlaybackPreferences, Track} from './types';

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
  preferences: PlaybackPreferences | null;
  updatePreferences: (changes: Partial<PlaybackPreferences>) => Promise<void>;
  liked: Set<string>;
  setLiked: (trackIds: string[], liked: boolean) => Promise<void>;
  fullPlayer: boolean;
  setFullPlayer: (open: boolean) => void;
  resolveTracks: (ids: string[]) => Promise<Track[]>;
  /** Plays what the provider finds for a search (the UI contract's play action); resolves
   * with how many tracks it found. */
  playSearch: (text: string) => Promise<number>;
  /** Plays tracks a Satellite's own page hands over (the play action with tracks or route):
   * only that Satellite's, and only when it is the provider; resolves with how many it took. */
  playTracks: (satellite: string, tracks: unknown, options?: HandOverOptions) => Promise<number>;
  /** What keeps a Satellite's own tracks on the phone (the offline action, UI contract 1.2):
   * the downloads, only when that Satellite is the provider and this phone can keep files. */
  offlineFor: (satellite: string) => DownloadManager | null;
  /** What the provider's document adds to the player (UI contract 1.2, its `audio`): null
   * without one. */
  audio: UiAudio | null;
  /** Opens a page of the provider's shared interface, wherever the player is. */
  openPage: (page: string, params: Record<string, string>) => void;
  /** Opens the folder holding a path in whichever Satellite browses files (the locate action,
   * change 18); rejects when none can. */
  locate: (path: string) => Promise<boolean>;
  /** Reads again what the app keeps of a capability (`reloads`: "audio.session"). */
  reload: (capability: string) => Promise<void>;
  /** Tells `listener` the capability the app itself changed (a like, a preference), so a page
   * that `follows` it reloads; returns the function that stops it. */
  onChanged: (listener: (capability: string) => void) => () => void;
}

const AudioHostContext = createContext<AudioHostValue | null>(null);

async function requestNotifications() {
  if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
    await PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS' as any).catch(() => undefined);
  }
}

/**
 * The app's one audio player (the `media.audio` client capability, docs/reference/media-audio.md): it
 * plays from whichever Satellite the catalog lists as the `audio.library` provider. One host
 * per signed-in server: AuthProvider is keyed by server, so switching servers unmounts it
 * and with it the player, its queue, Connect device and downloads. It sits under the lock
 * screen overlay, so playback continues while the UI is locked.
 */
export function AudioHost({
  children,
  openPage,
}: {
  children: React.ReactNode;
  /** opens a page of a Satellite's shared interface (the app's navigation) */
  openPage?: (satellite: string, page: string, params: Record<string, string>) => void;
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
  const [preferences, setPreferences] = useState<PlaybackPreferences | null>(null);
  // the capability catalog as last read: the player's locate finds the files.browse provider in it
  const catalogRef = useRef<Catalog | null>(null);
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const deviceRef = useRef(deviceId);
  deviceRef.current = deviceId;
  const [liked, setLikedState] = useState<Set<string>>(new Set());
  const [fullPlayer, setFullPlayer] = useState(false);
  const [audioDoc, setAudioDoc] = useState<UiAudio | null>(null);
  const changedListeners = useRef(new Set<(capability: string) => void>());
  // the two native players: the one playing (PlayerState.deck) and the one holding the next track
  const firstDeck = useRef<VideoRef>(null);
  const secondDeck = useRef<VideoRef>(null);

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
        saveLocal: saved => writeJson(playerKeys.queue(serverId), saved),
        requestNotifications,
        ...backgroundTimers(),
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
      const saved = await readJson<SavedQueue>(playerKeys.queue(serverId));
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
      catalogRef.current = catalog;
      const resolved = resolveAudioProvider(catalog);
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
      // what the provider's document adds to the player; one that can't be read adds nothing
      new UiApi(client, serverId)
        .document(resolved.satellite)
        .then(loaded => !cancelled && setAudioDoc(loaded.document.audio ?? null))
        .catch(() => undefined);
    })();
    return () => {
      cancelled = true;
      setAudioDoc(null);
    };
  }, [client, library, serverId]);

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
    player.seeker = seconds => (player.state.deck === 0 ? firstDeck : secondDeck).current?.seek(seconds);
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
    async (changes: Partial<PlaybackPreferences>) => {
      if (!library.offersSession('preferences')) {
        return;
      }
      setPreferences(current => (current ? {...current, ...changes} : current));
      const saved = await library.updatePreferences(changes);
      setPreferences(saved);
      changedListeners.current.forEach(listener => listener('audio.session'));
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
      changedListeners.current.forEach(listener => listener('audio.session'));
    },
    [library],
  );

  // a page's action changed what the session keeps: read it again, without telling the pages
  // that follow it (the page that acted refreshes itself)
  const reload = useCallback(
    async (capability: string) => {
      if (capability !== 'audio.session' || !library.provider) {
        return;
      }
      const reads: Promise<unknown>[] = [];
      if (library.offersSession('preferences')) {
        reads.push(library.preferences().then(setPreferences));
      }
      if (library.offersSession('favorites')) {
        reads.push(library.favorites().then(value => setLikedState(new Set(value.ids.track ?? []))));
      }
      await Promise.all(reads.map(read => read.catch(() => undefined)));
    },
    [library],
  );

  // what the session keeps may have changed elsewhere (the player's accent chosen on the web, say):
  // read it again each time the app comes back to the front
  useEffect(() => {
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener('change', status => {
      if (status === 'active' && previous !== 'active') {
        reload('audio.session').catch(() => undefined);
      }
      previous = status;
    });
    return () => subscription.remove();
  }, [reload]);

  const onChanged = useCallback((listener: (capability: string) => void) => {
    changedListeners.current.add(listener);
    return () => {
      changedListeners.current.delete(listener);
    };
  }, []);

  const satellite = provider?.satellite ?? null;
  const openProviderPage = useCallback(
    (page: string, params: Record<string, string>) => {
      if (satellite && openPage) {
        setFullPlayer(false);
        openPage(satellite, page, params);
      }
    },
    [openPage, satellite],
  );

  // change 18: the folder holding a track's path, in whichever Satellite browses files - the
  // page its locate answers, opened as any other page of that Satellite's shared interface
  const locate = useCallback(
    async (path: string) => {
      const browser = locateProvider(catalogRef.current as Providers | null);
      if (!browser || !openPage) {
        throw new Error("That isn't available in this app.");
      }
      const answer = await new UiApi(client, serverId).act(
        browser.satellite, `${browser.operations.locate}?path=${encodeURIComponent(path)}`, 'GET', null,
      );
      const opened = openedPage(answer);
      if (!opened) {
        throw new Error("That isn't available in this app.");
      }
      setFullPlayer(false);
      openPage(browser.satellite, opened.page, opened.params);
      return true;
    },
    [client, openPage, serverId],
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

  const playTracks = useCallback(
    async (satellite: string, tracks: unknown, options: HandOverOptions = {}) => {
      await library.ready;
      if (!library.provider) {
        throw new Error('There is no audio library to play from.');
      }
      // streams are resolved through the provider from track ids, so a page plays only its own
      if (library.provider.satellite !== satellite) {
        throw new Error('The player plays from another audio library.');
      }
      return handOver(player, tracks, options);
    },
    [library, player],
  );

  const offlineFor = useCallback(
    (satellite: string) => (downloads.supported && provider?.satellite === satellite ? downloads : null),
    [downloads, provider],
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
    playTracks,
    offlineFor,
    audio: audioDoc,
    openPage: openProviderPage,
    locate,
    reload,
    onChanged,
  };

  return (
    <AudioHostContext.Provider value={value}>
      {children}
      <AudioOutput player={player} decks={[firstDeck, secondDeck]} downloads={downloads} />
    </AudioHostContext.Provider>
  );
}

/** A track's cover as a file on the phone, for the media notification. */
function useArtworkFile(track: Track | null | undefined, downloads: DownloadManager): string | undefined {
  const [artwork, setArtwork] = useState<string | undefined>(undefined);
  const albumId = track?.has_artwork ? track.album_id : null;
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
  return artwork;
}

function videoSource(source: Source, track: Track, artwork: string | undefined) {
  return {
    uri: source.uri,
    headers: source.headers,
    metadata: {
      title: track.title,
      artist: track.artist ?? track.album_artist,
      subtitle: track.album ?? undefined,
      imageUri: artwork,
    },
  };
}

/** The native players (react-native-video on Media3): background playback, the media
 * notification, lock-screen controls and audio focus all come from the one playing. The other
 * holds the next track, loaded and paused, so it starts the moment the current one ends
 * (gapless playback), then the track that ended until the new one has the notification. Each
 * keeps its place and its key when the roles swap, so neither native player is recreated. */
function AudioOutput({
  player,
  decks,
  downloads,
}: {
  player: PlayerController;
  decks: [React.RefObject<VideoRef>, React.RefObject<VideoRef>];
  downloads: DownloadManager;
}) {
  const state = usePlayerState(player);
  const artwork = useArtworkFile(state.track, downloads);
  const standby = state.standby;
  const standbyArtwork = useArtworkFile(standby?.role === 'next' ? standby.track : null, downloads);

  const deck = (slot: 0 | 1) => {
    if (slot === state.deck) {
      if (!state.source || !state.track) {
        return null;
      }
      return (
        <Video
          key={`${slot}-${state.sourceKey}`}
          ref={decks[slot]}
          source={videoSource(state.source, state.track, artwork)}
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
          onPlaybackStateChanged={event => player.onNativePlaying(event.isPlaying, event.isSeeking)}
          onReadyForDisplay={() => player.onNativeReady()}
          onError={event => player.onError(event.error?.errorString)}
          onAudioBecomingNoisy={() => player.onInterrupted()}
          onAudioFocusChanged={event => !event.hasAudioFocus && player.onInterrupted()}
          style={styles.hidden}
        />
      );
    }
    if (!standby) {
      return null;
    }
    const next = standby.role === 'next';
    const key = standby.key;
    return (
      <Video
        key={`${slot}-${key}`}
        ref={decks[slot]}
        source={videoSource(standby.source, standby.track, next ? standbyArtwork : undefined)}
        paused
        rate={state.speed}
        volume={standby.gainDb < 0 ? Math.pow(10, standby.gainDb / 20) : 1}
        playInBackground
        playWhenInactive
        // the next track has no notification of its own; the one that ended keeps its own
        // until the new one holds the notification
        showNotificationControls={!next}
        progressUpdateInterval={1000}
        onLoad={event => next && player.onStandbyLoad(key, event.duration)}
        onError={() => next && player.onStandbyError(key)}
        style={styles.hidden}
      />
    );
  };

  if (!state.source && !standby) {
    return null;
  }
  return (
    <View style={styles.hidden} pointerEvents="none">
      {deck(0)}
      {deck(1)}
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
