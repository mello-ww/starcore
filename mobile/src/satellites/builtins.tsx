/**
 * The app's composition root for Satellites that still have native code of their own (native
 * screens, and what they add to the shared audio host): the one shared file allowed to import a
 * Satellite's folder, so navigation, layout and the AudioHost never do. Each entry goes once its
 * Satellite moves to its ui.json
 * (docs/ui-contract.md, "Migration"); engine/tests/test_client_modularity.py checks that no
 * other shared file imports a Satellite folder.
 */
import {useIsFocused} from '@react-navigation/native';
import React from 'react';
import {type AudioHostExtensions, useOwnAudioInterface} from '../media/AudioHost';
import {MUSIC_AUDIO_EXTENSIONS} from '../music/MusicProvider';
import {AlbumScreen} from '../music/screens/AlbumScreen';
import {ArtistScreen} from '../music/screens/ArtistScreen';
import {DownloadsScreen} from '../music/screens/DownloadsScreen';
import {EqualizerScreen} from '../music/screens/EqualizerScreen';
import {MusicHomeScreen} from '../music/screens/MusicHomeScreen';
import {MusicSettingsScreen} from '../music/screens/MusicSettingsScreen';
import {PlaylistScreen} from '../music/screens/PlaylistScreen';
import {TrackListScreen} from '../music/screens/TrackListScreen';
import type {TrackListKind} from '../music/ui/navigation';

/** Route params of the native screens below, merged into the Satellites stack's own. */
export type BuiltinScreenParams = {
  MusicHome: undefined;
  MusicAlbum: {id: string};
  MusicArtist: {id: string};
  MusicPlaylist: {id: string};
  MusicTracks: {kind: TrackListKind; id: string; title: string};
  MusicSettings: undefined;
  MusicEqualizer: undefined;
  MusicDownloads: undefined;
};

export interface BuiltinScreen {
  name: keyof BuiltinScreenParams;
  component: React.ComponentType<any>;
  title?: string;
}

/** A native screen of the audio provider's own: while it is shown, the player offers its own
 * extensions (BUILTIN_AUDIO) rather than what the provider's document adds. */
function ownAudioScreen<P extends object>(Screen: React.ComponentType<P>): React.ComponentType<P> {
  const Own = (props: P) => {
    useOwnAudioInterface(useIsFocused());
    return <Screen {...props} />;
  };
  Own.displayName = `Own(${Screen.displayName || Screen.name || 'Screen'})`;
  return Own;
}

/** Native screens in the Satellites stack, until their Satellite's ui.json replaces them. */
export const BUILTIN_SCREENS: BuiltinScreen[] = [
  {name: 'MusicHome', component: ownAudioScreen(MusicHomeScreen), title: ''},
  {name: 'MusicAlbum', component: ownAudioScreen(AlbumScreen), title: 'Album'},
  {name: 'MusicArtist', component: ownAudioScreen(ArtistScreen), title: 'Artist'},
  {name: 'MusicPlaylist', component: ownAudioScreen(PlaylistScreen), title: 'Playlist'},
  {name: 'MusicTracks', component: ownAudioScreen(TrackListScreen)},
  {name: 'MusicSettings', component: ownAudioScreen(MusicSettingsScreen), title: ''},
  {name: 'MusicEqualizer', component: ownAudioScreen(EqualizerScreen), title: 'Equalizer'},
  {name: 'MusicDownloads', component: ownAudioScreen(DownloadsScreen), title: 'Downloads'},
];

/** What native code adds to the shared AudioHost: a track menu and links into its own screens. */
export const BUILTIN_AUDIO: {extensions: AudioHostExtensions} = {
  extensions: MUSIC_AUDIO_EXTENSIONS,
};
