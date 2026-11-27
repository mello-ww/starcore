import React, {type ReactNode, useEffect, useState} from 'react';
import {AccentOverride} from '../../theme';
import {useArtworkUri, useAudioHost} from '../AudioHost';
import {artworkColour} from '../native';
import type {Track} from '../types';

/**
 * The player's accent preference (the audio.session provider's `accent`), as Mission Control
 * reads it (media/theme.js): "#rrggbb" is a colour of the player's own, "artwork" the playing
 * cover's, and "starcore" or anything unknown follows the app's accent.
 */
export function accentMode(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return text === 'artwork' || /^#[0-9a-f]{6}$/.test(text) ? text : 'starcore';
}

const covers = new Map<string, Promise<string | null>>();

function coverColour(uri: string, headers?: Record<string, string>): Promise<string | null> {
  let colour = covers.get(uri);
  if (!colour) {
    colour = artworkColour(uri, headers);
    covers.set(uri, colour);
    // a cover that couldn't be read (offline, say) is tried again next time
    colour.then(value => value === null && covers.delete(uri));
  }
  return colour;
}

function coverOf(track: Track | null): string | null {
  return track?.has_artwork ? track.album_id || null : null;
}

/** The playing track's album when it has a cover, re-read only when the track changes. */
function usePlayingCover(): string | null {
  const {player} = useAudioHost();
  const [album, setAlbum] = useState(() => coverOf(player.state.track));
  useEffect(() => {
    setAlbum(coverOf(player.state.track));
    return player.subscribe(state => setAlbum(coverOf(state.track)));
  }, [player]);
  return album;
}

/** Draws the player (the floating bar, the full player) in the player's own accent. */
export function PlayerAccent({children}: {children: ReactNode}) {
  const {preferences} = useAudioHost();
  const mode = accentMode(preferences?.accent);
  const playing = usePlayingCover();
  const album = mode === 'artwork' ? playing : null;
  const source = useArtworkUri(album, 96);
  const [cover, setCover] = useState<{album: string; colour: string | null} | null>(null);

  useEffect(() => {
    if (!album || !source) {
      return;
    }
    let active = true;
    coverColour(source.uri, source.headers).then(colour => active && setCover({album, colour}));
    return () => {
      active = false;
    };
  }, [album, source]);

  const colour = mode === 'artwork' ? (album && cover?.album === album ? cover.colour : null) : mode === 'starcore' ? null : mode;
  return <AccentOverride color={colour}>{children}</AccentOverride>;
}
