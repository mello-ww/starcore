import React, {useEffect, useRef, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {colors, spacing, typography, useAccentStyles} from '../../theme';
import {useMusic} from '../MusicProvider';
import type {SearchResult, Track} from '../types';
import {useMusicNavigation} from '../ui/navigation';
import {Shelf} from '../ui/Shelf';
import {TrackActions} from '../ui/TrackActions';
import {TrackRow} from '../ui/TrackRow';

const QUALITIES = [
  {key: '', label: 'Any quality'},
  {key: 'lossless', label: 'Lossless'},
  {key: 'hires', label: 'Hi-Res'},
];

export function SearchTab() {
  const accentStyle = useAccentStyles();
  const {api, player, downloads} = useMusic();
  const go = useMusicNavigation();
  const [query, setQuery] = useState('');
  const [quality, setQuality] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [offline, setOffline] = useState<Track[] | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [actions, setActions] = useState<Track[] | null>(null);
  const timer = useRef<any>(null);

  useEffect(() => {
    api.recentSearches().then(setRecent).catch(() => setRecent([]));
  }, [api]);

  useEffect(() => {
    clearTimeout(timer.current);
    if (query.trim().length < 2) {
      setResult(null);
      setOffline(null);
      setSuggestions([]);
      return;
    }
    timer.current = setTimeout(async () => {
      api.suggest(query).then(setSuggestions).catch(() => setSuggestions([]));
      try {
        setResult(await api.search(query, {quality: quality || undefined}));
        setOffline(null);
      } catch {
        setResult(null);
        setOffline(downloads.search(query));
      }
    }, 300);
    return () => clearTimeout(timer.current);
  }, [api, downloads, query, quality]);

  const remember = () => {
    if (query.trim().length >= 2) {
      api.rememberSearch(query.trim()).catch(() => undefined);
    }
  };

  const playFrom = (tracks: Track[], index: number) => {
    remember();
    player.playTracks(tracks, index, `search:${query.slice(0, 60).replace(/[^\w.-]/g, '-')}`);
  };

  const empty = result && !result.tracks.length && !result.albums.length && !result.artists.length && !result.playlists.length;

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <TextInput value={query} onChangeText={setQuery} placeholder="Songs, albums, artists, playlists"
        placeholderTextColor={colors.textFaint} style={styles.input} autoCorrect={false} returnKeyType="search"
        onSubmitEditing={remember} accessibilityLabel="Search music" />
      <View style={styles.filters}>
        {QUALITIES.map(option => (
          <Pressable key={option.key} onPress={() => setQuality(option.key)}
            style={[styles.chip, quality === option.key && accentStyle.fill]}>
            <Text style={[styles.chipLabel, quality === option.key && [styles.chipLabelActive, accentStyle.onFill]]}>{option.label}</Text>
          </Pressable>
        ))}
      </View>

      {!query && recent.length > 0 && (
        <View>
          <View style={styles.row}>
            <Text style={typography.heading}>Recent searches</Text>
            <Pressable onPress={() => api.clearSearches().then(() => setRecent([]))}>
              <Text style={accentStyle.text}>Clear</Text>
            </Pressable>
          </View>
          {recent.map(item => (
            <Pressable key={item} onPress={() => setQuery(item)} style={styles.suggestion}>
              <Text style={typography.body}>{item}</Text>
            </Pressable>
          ))}
        </View>
      )}

      {!result && suggestions.slice(0, 5).map(item => (
        <Pressable key={`${item.kind}-${item.text}-${item.id ?? ''}`} onPress={() => setQuery(item.text)} style={styles.suggestion}>
          <Text style={typography.body}>{item.text}</Text>
          <Text style={typography.caption}>{item.kind}</Text>
        </Pressable>
      ))}

      {offline && (
        <View>
          <Text style={typography.caption}>Offline - searching your downloads</Text>
          {offline.map((track, index) => (
            <TrackRow key={track.id} track={track} onPress={() => player.playTracks(offline, index, 'library:offline')} />
          ))}
          {!offline.length && <Text style={typography.caption}>No downloaded songs match.</Text>}
        </View>
      )}

      {result?.corrected && <Text style={typography.caption}>Showing results for “{result.corrected}”</Text>}
      {empty && <Text style={[typography.caption, styles.empty]}>Nothing in your library matches “{query}”.</Text>}

      {result && result.tracks.length > 0 && (
        <View style={styles.section}>
          <Text style={typography.heading}>Songs</Text>
          {result.tracks.slice(0, 10).map((track, index) => (
            <TrackRow key={track.id} track={track} onPress={() => playFrom(result.tracks, index)} onMore={() => setActions([track])} />
          ))}
        </View>
      )}
      {result && (
        <>
          <Shelf title="Artists" items={result.artists.map(artist => ({key: artist.id, title: artist.name, round: true,
            albumId: artist.artwork, onPress: () => { remember(); go.artist(artist.id); }}))} />
          <Shelf title="Albums" items={result.albums.map(album => ({key: album.id, title: album.album, subtitle: album.artist,
            albumId: album.artwork ? album.id : null, onPress: () => { remember(); go.album(album.id); }}))} />
          <Shelf title="Playlists" items={result.playlists.map(playlist => ({key: playlist.id, title: playlist.name,
            mosaic: playlist.mosaic, onPress: () => go.playlist(playlist.id)}))} />
          {result.genres.length > 0 && (
            <Shelf title="Genres" items={result.genres.map(genre => ({key: genre.name, title: genre.name,
              subtitle: `${genre.tracks} songs`, onPress: () => go.tracks('genre', genre.name, genre.name)}))} />
          )}
        </>
      )}
      <TrackActions tracks={actions} onClose={() => setActions(null)} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {padding: spacing.md, paddingBottom: 120},
  input: {backgroundColor: colors.raised, color: colors.text, borderRadius: 999, paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm, fontSize: 16},
  filters: {flexDirection: 'row', gap: spacing.sm, marginVertical: spacing.md},
  chip: {paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: 999, backgroundColor: colors.raised},
  chipLabelActive: {color: colors.onSelected, fontWeight: '700'},
  chipLabel: {color: colors.text, fontSize: 13},
  row: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  suggestion: {paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line},
  empty: {marginTop: spacing.lg},
  section: {marginTop: spacing.md},
});
