/**
 * The app's composition root for Satellites that still have native code of their own
 * (`src/music/`): the one shared file allowed to import a Satellite's folder, so navigation,
 * layout and the AudioHost never do. Each entry goes once its Satellite moves to its ui.json
 * (docs/ui-contract.md, "Migration"); engine/tests/test_client_modularity.py checks that no
 * other shared file imports a Satellite folder.
 */
import React from 'react';
import type {AudioHostExtensions} from '../media/AudioHost';
import type {AudioProvider} from '../media/library';
import {MUSIC_AUDIO_EXTENSIONS, MUSIC_LEGACY_PROVIDER} from '../music/MusicProvider';
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

/** Native screens in the Satellites stack, until their Satellite's ui.json replaces them. */
export const BUILTIN_SCREENS: BuiltinScreen[] = [
  {name: 'MusicHome', component: MusicHomeScreen, title: ''},
  {name: 'MusicAlbum', component: AlbumScreen, title: 'Album'},
  {name: 'MusicArtist', component: ArtistScreen, title: 'Artist'},
  {name: 'MusicPlaylist', component: PlaylistScreen, title: 'Playlist'},
  {name: 'MusicTracks', component: TrackListScreen},
  {name: 'MusicSettings', component: MusicSettingsScreen, title: ''},
  {name: 'MusicEqualizer', component: EqualizerScreen, title: 'Equalizer'},
  {name: 'MusicDownloads', component: DownloadsScreen, title: 'Downloads'},
];

/** What native code adds to the shared AudioHost: a track menu and links into its own
 * screens, and the provider to assume on a server older than the audio.library capability. */
export const BUILTIN_AUDIO: {extensions: AudioHostExtensions; fallbackProvider: AudioProvider | null} = {
  extensions: MUSIC_AUDIO_EXTENSIONS,
  fallbackProvider: MUSIC_LEGACY_PROVIDER,
};
