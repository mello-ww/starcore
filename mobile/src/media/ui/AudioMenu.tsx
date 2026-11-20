// The full player's additions from the provider's document (UI contract 1.2, change 9: its
// `audio`, docs/media-audio.md): its menu after the host's own Play next, the title's and
// artist's links and its way to the Satellite's pages, run by additions.ts with the playing
// track as $. A choose opens the shared choose sheet; a message or an error shows as a toast.
import React, {useCallback, useMemo, useState} from 'react';
import {Platform, ToastAndroid} from 'react-native';
import {useAuth} from '../../auth/AuthContext';
import {useServers} from '../../servers/ServersContext';
import {UiApi} from '../../satellites/ui/api';
import {ChooseSheet} from '../../satellites/ui/ChooseSheet';
import type {ChooseAnswer, ChooseOffer} from '../../satellites/ui/choose';
import type {UiAction} from '../../satellites/ui/contract';
import {RowMenuSheet} from '../../satellites/ui/RowMenu';
import type {RowEntry} from '../../satellites/ui/rows';
import {confirmAction} from '../../satellites/ui/UiBlocks';
import {additionRunner, linkAction, menuEntries} from '../additions';
import {useAudioHost} from '../AudioHost';
import type {Track} from '../types';

function notify(message: string) {
  if (Platform.OS === 'android') {
    ToastAndroid.show(message, ToastAndroid.SHORT);
  }
}

export interface AudioAdditions {
  /** whether the document adds a menu (the player then shows its ⋮) */
  hasMenu: boolean;
  /** the title's and artist's link for the id shown, or null */
  link: (kind: 'album' | 'artist', track: Track, id: string | null | undefined) => (() => void) | null;
  /** opens the menu for a track */
  openMenu: (track: Track) => void;
  /** the menu and the choose sheet, drawn by the player */
  overlays: React.ReactNode;
}

export function useAudioAdditions(): AudioAdditions {
  const host = useAudioHost();
  const {client} = useAuth();
  const {activeServer} = useServers();
  const {audio, provider, player, playSearch, openPage, reload, baseUrl, token} = host;
  const satellite = provider?.satellite ?? '';
  const api = useMemo(() => new UiApi(client, activeServer?.id ?? 'default'), [client, activeServer?.id]);
  const [menuTrack, setMenuTrack] = useState<Track | null>(null);
  const [chooseRequest, setChooseRequest] = useState<{offer: ChooseOffer; resolve: (answer: ChooseAnswer) => void} | null>(null);

  const run = useMemo(
    () =>
      additionRunner({
        open: openPage,
        play: (tracks, options) => host.playTracks(satellite, tracks, options as any),
        playSearch,
        load: route => api.read(satellite, route),
        post: (route, body) => api.act(satellite, route, 'POST', body),
        choose: offer =>
          new Promise<ChooseAnswer>(done =>
            setChooseRequest({
              offer,
              resolve: answer => {
                setChooseRequest(null);
                done(answer);
              },
            }),
          ),
        confirm: text => confirmAction(text),
        reload,
        notify,
      }),
    // host.playTracks is stable (a useCallback in the host)
    [api, openPage, playSearch, reload, satellite, host.playTracks],
  );

  const link = useCallback(
    (kind: 'album' | 'artist', track: Track, id: string | null | undefined) => {
      const found = linkAction(audio, kind, track, id);
      return found ? () => void run(found.action, found.track) : null;
    },
    [audio, run],
  );

  const mediaSource = useCallback(
    (route: string) => ({
      uri: `${baseUrl}/api/satellites/${encodeURIComponent(satellite)}/${route}`,
      headers: token ? {Authorization: `Bearer ${token}`} : undefined,
    }),
    [baseUrl, satellite, token],
  );

  // the host's own entry first, then the document's, then its way to the Satellite's pages
  const entries: Array<RowEntry & {run: () => void}> = [];
  if (menuTrack) {
    entries.push({label: 'Play next', icon: 'skip-forward', action: {} as UiAction, run: () => player.playNext([menuTrack])});
    for (const entry of menuEntries(audio, menuTrack)) {
      entries.push({...entry, run: () => void run(entry.action, menuTrack)});
    }
    const library = audio?.library;
    if (library?.action) {
      entries.push({label: String(library.label ?? ''), icon: 'grid', action: library.action, run: () => void run(library.action, menuTrack)});
    }
  }

  const overlays = (
    <>
      {menuTrack && (
        <RowMenuSheet
          title={menuTrack.title}
          entries={entries}
          scope={{data: menuTrack}}
          onRun={entry => (entry as (typeof entries)[number]).run()}
          onClose={() => setMenuTrack(null)}
        />
      )}
      {chooseRequest && <ChooseSheet offer={chooseRequest.offer} mediaSource={mediaSource} onDone={chooseRequest.resolve} />}
    </>
  );

  return {
    hasMenu: Boolean(audio && ((audio.menu?.length ?? 0) > 0 || audio.library)),
    link,
    openMenu: setMenuTrack,
    overlays,
  };
}
