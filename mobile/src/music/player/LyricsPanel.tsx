import React, {useEffect, useRef, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {colors, spacing, typography, useAccentStyles} from '../../theme';
import {activeLine, activeWords, lyricsTime} from '../lyrics';
import {useMusic, usePlayerState} from '../MusicProvider';
import type {Lyrics} from '../types';

const LINE_HEIGHT = 44;

export function LyricsPanel({trackId}: {trackId: string}) {
  const accentStyle = useAccentStyles();
  const {api, player, preferences} = useMusic();
  const state = usePlayerState();
  const [lyrics, setLyrics] = useState<Lyrics | null>(null);
  const [message, setMessage] = useState<string | null>('Loading lyrics…');
  const [language, setLanguage] = useState<string | undefined>(undefined);
  const [offset, setOffset] = useState(0);
  const scroll = useRef<ScrollView>(null);
  const lastIndex = useRef(-1);

  useEffect(() => {
    let cancelled = false;
    setLyrics(null);
    setMessage('Loading lyrics…');
    api.lyrics(trackId, language)
      .then(found => {
        if (!cancelled) {
          setLyrics(found);
          setOffset(found.offset + (preferences?.lyrics_offset ?? 0));
          setMessage(null);
        }
      })
      .catch(() => !cancelled && setMessage('No lyrics for this song. Add a .lrc file next to it to see them here.'));
    return () => {
      cancelled = true;
    };
  }, [api, language, preferences?.lyrics_offset, trackId]);

  const time = lyricsTime(state.position, offset);
  const index = lyrics?.synced ? activeLine(lyrics.lines, time) : -1;

  useEffect(() => {
    if (index !== lastIndex.current && index >= 0) {
      lastIndex.current = index;
      scroll.current?.scrollTo({y: Math.max(index * LINE_HEIGHT - LINE_HEIGHT * 3, 0), animated: true});
    }
  }, [index]);

  const nudge = (delta: number) => {
    const next = offset + delta;
    setOffset(next);
    api.setLyricsOffset(trackId, next - (preferences?.lyrics_offset ?? 0)).catch(() => undefined);
  };

  if (!lyrics) {
    return <Text style={[typography.caption, styles.message]}>{message}</Text>;
  }
  return (
    <View style={styles.panel}>
      <View style={styles.tools}>
        {lyrics.synced && (
          <>
            <Pressable onPress={() => nudge(-250)} hitSlop={6}><Text style={accentStyle.text}>−0.25s</Text></Pressable>
            <Text style={typography.label}>{offset > 0 ? '+' : ''}{(offset / 1000).toFixed(2)}s</Text>
            <Pressable onPress={() => nudge(250)} hitSlop={6}><Text style={accentStyle.text}>+0.25s</Text></Pressable>
          </>
        )}
        {lyrics.languages.map(code => (
          <Pressable key={code} onPress={() => setLanguage(code)}>
            <Text style={[accentStyle.text, (lyrics.language === code) && styles.current]}>{code}</Text>
          </Pressable>
        ))}
      </View>
      <ScrollView ref={scroll} style={styles.scroll}>
        {lyrics.synced ? (
          lyrics.lines.map((line, position) => {
            const active = position === index;
            const reached = active ? activeWords(line, time) : 0;
            return (
              <Pressable key={`${line.time}-${position}`} onPress={() => player.seek((line.time + offset) / 1000)}
                style={styles.line}>
                {active && line.words.length ? (
                  <Text style={[styles.text, styles.active]}>
                    {line.words.map((word, wordIndex) => (
                      <Text key={wordIndex} style={wordIndex < reached ? accentStyle.text : styles.unsung}>{word.text}</Text>
                    ))}
                  </Text>
                ) : (
                  <Text style={[styles.text, active && styles.active, position < index && styles.past]}>{line.text || '♪'}</Text>
                )}
                {!!line.translation && <Text style={typography.caption}>{line.translation}</Text>}
              </Pressable>
            );
          })
        ) : (
          <Text style={styles.plain}>{lyrics.plain}</Text>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {flex: 1},
  message: {padding: spacing.lg, textAlign: 'center'},
  tools: {flexDirection: 'row', gap: spacing.md, alignItems: 'center', paddingBottom: spacing.sm},
  current: {fontWeight: '700'},
  scroll: {flex: 1},
  line: {minHeight: LINE_HEIGHT, justifyContent: 'center'},
  text: {fontSize: 20, color: colors.textFaint, fontWeight: '600'},
  active: {color: colors.text},
  past: {color: colors.textDim},
  unsung: {color: colors.text},
  plain: {...typography.body, lineHeight: 26},
});
