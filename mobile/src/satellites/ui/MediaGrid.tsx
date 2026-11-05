import React, {memo, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  AccessibilityInfo, Animated, FlatList, Image, Modal, Pressable, ScrollView, StatusBar, StyleSheet, Text,
  useWindowDimensions, View,
} from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import Video from 'react-native-video';
import {tokens, useAccent} from '../../theme';
import {formatValue, isSafeRoute, isVisible, resolve, resolveTemplate, type Scope, type UiAction, type UiBlock} from './contract';
import type {BlockContext} from './UiBlocks';

const {palette, space, type, radii} = tokens;

/**
 * The media-grid block (UI contract 1.2) and its shared viewer. A grid of images and videos
 * from the Satellite's own routes, in groups, revealed a page at a time as the screen scrolls
 * near its end; a long press starts a selection with the document's actions, and a tile opens
 * a full-screen viewer with the document's facts and actions on the item shown. Nothing here
 * knows which Satellite, or what kind of collection, it shows.
 */

/** Tiles revealed at a time: enough for a first screen, little enough to lay out at once. */
export const GRID_PAGE = 60;
/** The width a tile aims for at each size; the grid fits as many columns as that allows. */
const TILE_TARGETS: Record<string, number> = {small: 84, medium: 112, large: 168};
const GAP = 3;

type Source = {uri: string; headers?: Record<string, string>};

export function mediaKind(value: unknown): 'image' | 'video' {
  return value === 'video' ? 'video' : 'image';
}

/** "1:05" for a video tile's badge. */
export function clock(seconds: unknown): string {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

/** How many columns a grid of `width` shows at `size`. */
export function gridColumns(width: number, size: string): number {
  if (size === 'full') {
    return 1;
  }
  const target = TILE_TARGETS[size] ?? TILE_TARGETS.medium;
  return Math.max(2, Math.floor((width + GAP) / (target + GAP)));
}

const present = (value: unknown) => value !== null && value !== undefined && value !== '';
const asText = (value: unknown) => (present(value) ? String(value) : '');

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let active = true;
    Promise.resolve(AccessibilityInfo.isReduceMotionEnabled?.())
      .then(value => active && setReduced(Boolean(value)))
      .catch(() => {});
    const subscription = AccessibilityInfo.addEventListener?.('reduceMotionChanged', value => setReduced(Boolean(value)));
    return () => {
      active = false;
      subscription?.remove?.();
    };
  }, []);
  return reduced;
}

interface Entry {
  item: any;
  key: string;
  index: number;
  scope: Scope;
  kind: 'image' | 'video';
  thumb: Source | null;
}

type Row = {kind: 'group'; label: string; id: string} | {kind: 'tiles'; entries: Entry[]; id: string};

export function MediaGridBlock({block, scope, context}: {block: UiBlock; scope: Scope; context: BlockContext}) {
  const {width: windowWidth} = useWindowDimensions();
  const {color: accent, onColor} = useAccent();
  const reduced = useReducedMotion();
  const item = (block.item ?? {}) as Record<string, any>;
  const formats = (item.format ?? {}) as Record<string, string>;
  // the screen's context is a new object every render: depend only on its stable functions
  const {mediaSource, runAction, onNearEnd, setOverlay} = context;

  const source = useCallback(
    (template: unknown, itemScope: Scope): Source | null => {
      if (typeof template !== 'string') {
        return null;
      }
      const route = resolveTemplate(template, itemScope);
      return route && isSafeRoute(route) ? mediaSource?.(route) ?? null : null;
    },
    [mediaSource],
  );

  const resolved = Array.isArray(block.items) ? block.items : resolve(block.items, scope);
  const items: any[] = Array.isArray(resolved) ? resolved : [];
  const entries: Entry[] = useMemo(
    () =>
      items.map((value, index) => {
        const itemScope = {...scope, data: value};
        const key = item.key !== undefined ? resolve(item.key, itemScope) : null;
        return {
          item: value,
          key: present(key) ? String(key) : `#${index}`,
          index,
          scope: itemScope,
          kind: mediaKind(item.kind !== undefined ? resolve(item.kind, itemScope) : 'image'),
          thumb: source(item.image, itemScope),
        };
      }),
    [resolved, scope.page, scope.state, source],
  );

  const [shown, setShown] = useState(GRID_PAGE);
  // the media picker (media.picker): every tile selects, one at a time unless `multiple`
  const picking = context.picking;
  const pickingRef = useRef(picking);
  pickingRef.current = picking;
  const multiplePick = picking ? picking.multiple : true;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selecting, setSelecting] = useState(Boolean(picking));
  const [viewerKey, setViewerKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // the next page arrives as the screen scrolls near its end
  const total = entries.length;
  useEffect(() => {
    if (shown >= total || !onNearEnd) {
      return;
    }
    return onNearEnd(() => setShown(current => (current < total ? current + GRID_PAGE : current)));
  }, [onNearEnd, shown, total]);

  // a selection only keeps what is still there
  useEffect(() => {
    setSelected(current => {
      const keys = new Set(entries.map(entry => entry.key));
      const kept = [...current].filter(key => keys.has(key));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [entries]);

  const toggle = useCallback(
    (key: string) => {
      setSelecting(true);
      setSelected(current => {
        const next = new Set(multiplePick ? current : []);
        if (current.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        return next;
      });
    },
    [multiplePick],
  );

  // the picker hears what is chosen
  useEffect(() => {
    pickingRef.current?.onChange(entries.filter(entry => selected.has(entry.key)).map(entry => entry.item));
  }, [selected, entries]);

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setSelecting(false);
  }, []);

  const runOnSelection = useCallback(
    async (action: UiAction) => {
      const chosen = entries.filter(entry => selected.has(entry.key));
      if (!chosen.length || !action) {
        return;
      }
      if (action.navigate || action.play) {
        runAction(action, chosen[0].scope);
        return;
      }
      const first = {...chosen[0].scope, value: chosen.length};
      if (action.confirm && context.confirm && !(await context.confirm(asText(resolve(action.confirm, first))))) {
        return;
      }
      setBusy(true);
      const single: UiAction = {...action, confirm: undefined, then: undefined};
      let failed = 0;
      for (const entry of chosen) {
        if (!(await runAction(single, entry.scope, undefined, {quiet: true}))) {
          failed += 1;
        }
      }
      setBusy(false);
      clearSelection();
      context.afterSelection?.(action.then, failed, chosen.length);
    },
    [entries, selected, context, runAction, clearSelection],
  );

  // the selection bar floats over the screen's bottom edge, above the player. It is rebuilt
  // only when the selection changes; what it runs is read from the latest render.
  const latest = useRef({scope, runOnSelection});
  latest.current = {scope, runOnSelection};
  const selection = block.selection as {actions?: any[]} | undefined;
  const selectionBar = useMemo(() => {
    const selectionActions: any[] = Array.isArray(selection?.actions) ? selection!.actions! : [];
    if (!block.selection || !selecting || picking) {
      return null;
    }
    return (
      <View style={styles.selectionBar} testID="media-selection">
        <Text style={styles.selectionCount} accessibilityLiveRegion="polite">
          {selected.size ? `${selected.size} selected` : 'Select items'}
        </Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.selectionActions}>
          {selectionActions.map((entry, index) => (
            <ActionPill
              key={index}
              entry={entry}
              scope={latest.current.scope}
              disabled={busy || selected.size === 0}
              onPress={() => latest.current.runOnSelection(entry.action)}
            />
          ))}
          <ActionPill entry={{label: 'Cancel'}} scope={latest.current.scope} onPress={clearSelection} />
        </ScrollView>
      </View>
    );
  }, [block.selection, selection, selecting, selected, busy, clearSelection, picking]);
  useEffect(() => {
    setOverlay?.(selectionBar);
  }, [setOverlay, selectionBar]);
  useEffect(() => () => setOverlay?.(null), [setOverlay]);

  const size = typeof block.size === 'string' ? block.size : 'medium';
  const shape = typeof block.shape === 'string' ? block.shape : 'square';
  const available = Math.min(windowWidth - space.lg * 2, 1200);
  const columns = gridColumns(available, size);
  const cell = Math.floor((available - GAP * (columns - 1)) / columns);
  const aspect = shape === 'wide' ? 16 / 9 : 1;

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    let label: string | undefined;
    let row: Entry[] = [];
    const flush = () => {
      if (row.length) {
        out.push({kind: 'tiles', entries: row, id: `t-${row[0].key}`});
        row = [];
      }
    };
    for (const entry of entries.slice(0, shown)) {
      if (item.group !== undefined) {
        const raw = resolve(item.group, entry.scope);
        const next = present(raw) ? formatValue(raw, formats.group) : '';
        if (next !== label) {
          flush();
          label = next;
          if (next) {
            out.push({kind: 'group', label: next, id: `g-${entry.key}`});
          }
        }
      }
      row.push(entry);
      if (row.length === columns) {
        flush();
      }
    }
    flush();
    return out;
  }, [entries, shown, columns, item.group, formats.group]);

  const opens = Boolean(picking || block.viewer || block.action || block.selection);
  const onPress = useCallback(
    (entry: Entry) => {
      if (picking || (block.selection && selecting)) {
        toggle(entry.key);
      } else if (block.viewer) {
        setViewerKey(entry.key);
      } else if (block.action) {
        runAction(block.action, entry.scope);
      } else if (block.selection) {
        toggle(entry.key);
      }
    },
    [picking, block.selection, block.viewer, block.action, selecting, toggle, runAction],
  );

  if (!entries.length) {
    const empty = block.empty !== undefined ? resolve(block.empty, scope) : null;
    return <Text style={type.caption}>{present(empty) ? String(empty) : 'Nothing here.'}</Text>;
  }

  return (
    <View style={styles.grid} testID="media-grid">
      {block.selection && !selecting && (
        <Pressable
          onPress={() => setSelecting(true)}
          accessibilityRole="button"
          style={({pressed}) => [styles.selectButton, pressed && styles.pressed]}>
          <Text style={styles.pillLabel}>Select</Text>
        </Pressable>
      )}
      {rows.map(row =>
        row.kind === 'group' ? (
          <Text key={row.id} style={styles.group} accessibilityRole="header">
            {row.label}
          </Text>
        ) : (
          <View key={row.id} style={styles.row}>
            {row.entries.map(entry => (
              <Tile
                key={entry.key}
                entry={entry}
                size={cell}
                aspect={aspect}
                round={shape === 'round'}
                title={item.title !== undefined ? asText(resolve(item.title, entry.scope)) : ''}
                subtitle={item.subtitle !== undefined ? resolve(item.subtitle, entry.scope) : null}
                subtitleFormat={formats.subtitle}
                duration={item.duration !== undefined ? resolve(item.duration, entry.scope) : null}
                selectable={Boolean(block.selection || picking)}
                selecting={selecting}
                selected={selected.has(entry.key)}
                accent={accent}
                onAccent={onColor}
                reduced={reduced}
                onPress={opens ? onPress : undefined}
                onLongPress={block.selection || picking ? toggle : undefined}
              />
            ))}
          </View>
        ),
      )}
      {block.viewer && viewerKey !== null && (
        <MediaViewer
          block={block}
          entries={entries}
          startKey={viewerKey}
          context={context}
          source={source}
          reduced={reduced}
          onClose={() => setViewerKey(null)}
        />
      )}
    </View>
  );
}

const Tile = memo(function Tile({
  entry, size, aspect, round, title, subtitle, subtitleFormat, duration, selectable, selecting, selected, accent,
  onAccent, reduced, onPress, onLongPress,
}: {
  entry: Entry; size: number; aspect: number; round: boolean; title: string; subtitle: unknown; subtitleFormat?: string;
  duration: unknown; selectable: boolean; selecting: boolean; selected: boolean; accent: string; onAccent: string;
  reduced: boolean; onPress?: (entry: Entry) => void; onLongPress?: (key: string) => void;
}) {
  const [failed, setFailed] = useState(false);
  const opacity = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const uri = entry.thumb?.uri;
  useEffect(() => setFailed(false), [uri]);
  const label = [title || (entry.kind === 'video' ? 'Video' : 'Image'), String(entry.index + 1)].join(', ');
  const height = Math.round(size / aspect);
  const content = (
    <>
      <View
        style={[
          styles.frame,
          {width: size, height},
          round && {borderRadius: size / 2},
          selected && {borderColor: accent, borderWidth: 3},
        ]}>
        {entry.thumb && !failed ? (
          <Animated.View style={[StyleSheet.absoluteFill, {opacity}]}>
            <Image
              source={entry.thumb}
              resizeMode="cover"
              resizeMethod="resize"
              fadeDuration={0}
              style={StyleSheet.absoluteFill}
              onLoad={() => {
                if (!reduced) {
                  Animated.timing(opacity, {toValue: 1, duration: 160, useNativeDriver: true}).start();
                }
              }}
              onError={() => setFailed(true)}
            />
          </Animated.View>
        ) : (
          <Icon name="image" size={18} color={palette.text3} />
        )}
        {entry.kind === 'video' && (
          <View style={styles.badge} pointerEvents="none">
            <Icon name="play" size={10} color="#fff" />
            {present(duration) && <Text style={styles.badgeText}>{clock(duration)}</Text>}
          </View>
        )}
        {selectable && selecting && (
          <View
            style={[styles.check, selected && {backgroundColor: accent, borderColor: accent}]}
            pointerEvents="none"
            testID={selected ? 'media-check-on' : 'media-check'}>
            {selected && <Icon name="check" size={13} color={onAccent} />}
          </View>
        )}
      </View>
      {(title !== '' || present(subtitle)) && (
        <View style={[styles.tileText, {width: size}]}>
          {title !== '' && (
            <Text style={styles.tileTitle} numberOfLines={1}>
              {title}
            </Text>
          )}
          {present(subtitle) && (
            <Text style={type.caption} numberOfLines={1}>
              {formatValue(subtitle, subtitleFormat)}
            </Text>
          )}
        </View>
      )}
    </>
  );
  if (!onPress) {
    return <View accessibilityLabel={label}>{content}</View>;
  }
  return (
    <Pressable
      onPress={() => onPress(entry)}
      onLongPress={onLongPress ? () => onLongPress(entry.key) : undefined}
      delayLongPress={300}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selectable && selecting ? {selected} : undefined}
      testID={`media-tile-${entry.key}`}
      style={({pressed}) => pressed && styles.pressed}>
      {content}
    </Pressable>
  );
});

function ActionPill({
  entry, scope, onPress, disabled, dark,
}: {entry: any; scope: Scope; onPress: () => void; disabled?: boolean; dark?: boolean}) {
  const {color: accent, onColor} = useAccent();
  const primary = entry.style === 'primary';
  const danger = entry.style === 'danger';
  const color = primary ? onColor : danger ? palette.danger : palette.text;
  const label = asText(resolve(entry.label, scope));
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{disabled: !!disabled}}
      style={({pressed}) => [
        styles.pill,
        dark && styles.pillDark,
        primary && {backgroundColor: accent},
        disabled && styles.disabled,
        pressed && styles.pressed,
      ]}>
      {typeof entry.icon === 'string' && <Icon name={entry.icon} size={15} color={color} />}
      <Text style={[styles.pillLabel, {color}]}>{label}</Text>
    </Pressable>
  );
}

/** The shared full-screen viewer: swipe between items, a video plays in place (only on the
 * page shown, so swiping away stops it), facts and actions come from the document. */
export function MediaViewer({
  block, entries, startKey, context, source, reduced, onClose,
}: {
  block: UiBlock; entries: Entry[]; startKey: string; context: BlockContext;
  source: (template: unknown, scope: Scope) => Source | null; reduced: boolean; onClose: () => void;
}) {
  const {width, height} = useWindowDimensions();
  const spec = (block.viewer ?? {}) as Record<string, any>;
  const [key, setKey] = useState(startKey);
  const [info, setInfo] = useState(false);
  const [busy, setBusy] = useState(false);
  const list = useRef<FlatList<Entry>>(null);
  const found = entries.findIndex(entry => entry.key === key);
  const lastIndex = useRef(Math.max(0, found));
  // the item shown went away (an action removed it): the next one takes its place
  const index = found >= 0 ? found : Math.min(lastIndex.current, entries.length - 1);
  lastIndex.current = index;
  const current = entries[index];

  useEffect(() => {
    if (!entries.length) {
      onClose();
    } else if (found < 0 && current) {
      setKey(current.key);
    }
  }, [entries.length, found, current, onClose]);

  useEffect(() => {
    if (index >= 0 && entries.length) {
      list.current?.scrollToIndex({index, animated: false});
    }
    // only when the list itself changed under the viewer
  }, [entries.length]);

  if (!current) {
    return null;
  }
  const scope = current.scope;
  const title = spec.title !== undefined ? asText(resolve(spec.title, scope)) : '';
  const subtitle = spec.subtitle !== undefined ? asText(resolve(spec.subtitle, scope)) : '';
  const position = `${index + 1} of ${entries.length}`;
  const fields: any[] = (Array.isArray(spec.fields) ? spec.fields : []).filter((field: any) => present(resolve(field.value, scope)));
  const actions: any[] = (Array.isArray(spec.actions) ? spec.actions : []).filter(
    (entry: any) => entry.visible === undefined || isVisible(resolve(entry.visible, scope)),
  );

  return (
    <Modal visible animationType={reduced ? 'none' : 'fade'} onRequestClose={onClose} statusBarTranslucent>
      <StatusBar barStyle="light-content" />
      <View style={styles.viewer} testID="media-viewer">
        <FlatList
          ref={list}
          data={entries}
          horizontal
          pagingEnabled
          initialScrollIndex={index}
          getItemLayout={(_, at) => ({length: width, offset: width * at, index: at})}
          keyExtractor={entry => entry.key}
          showsHorizontalScrollIndicator={false}
          windowSize={3}
          initialNumToRender={1}
          maxToRenderPerBatch={2}
          onMomentumScrollEnd={event => {
            const at = Math.round(event.nativeEvent.contentOffset.x / width);
            if (entries[at]) {
              setKey(entries[at].key);
            }
          }}
          renderItem={({item: entry}) => (
            <ViewerPage
              entry={entry}
              active={entry.key === current.key}
              width={width}
              height={height}
              image={source(spec.image !== undefined ? spec.image : block.item?.image, entry.scope)}
              video={entry.kind === 'video' ? source(spec.video, entry.scope) : null}
            />
          )}
        />
        <View style={styles.viewerTop} pointerEvents="box-none">
          <ViewerButton icon="x" label="Close" onPress={onClose} />
          <View style={styles.viewerHeading}>
            {title !== '' && (
              <Text style={styles.viewerTitle} numberOfLines={1}>
                {title}
              </Text>
            )}
            <Text style={type.caption} numberOfLines={1}>
              {subtitle ? `${subtitle} · ${position}` : position}
            </Text>
          </View>
          {(Array.isArray(spec.fields) && spec.fields.length > 0) && (
            <ViewerButton icon="info" label={info ? 'Hide details' : 'Show details'} active={info} onPress={() => setInfo(value => !value)} />
          )}
        </View>
        <View style={styles.viewerBottom} pointerEvents="box-none">
          {info && fields.length > 0 && (
            <ScrollView style={styles.details} contentContainerStyle={styles.detailsContent} testID="media-details">
              {fields.map((field, at) => (
                <View key={at} style={styles.detailRow}>
                  <Text style={[type.caption, styles.detailLabel]}>{String(field.label)}</Text>
                  <Text style={styles.detailValue}>
                    {formatValue(resolve(field.value, scope), field.format, field.unit !== undefined ? asText(resolve(field.unit, scope)) : undefined)}
                  </Text>
                </View>
              ))}
            </ScrollView>
          )}
          {actions.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.viewerActions}>
              {actions.map((entry, at) => (
                <ActionPill
                  key={at}
                  entry={entry}
                  scope={scope}
                  dark
                  disabled={busy}
                  onPress={async () => {
                    setBusy(true);
                    await context.runAction(entry.action, scope);
                    setBusy(false);
                  }}
                />
              ))}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

function ViewerPage({
  entry, active, width, height, image, video,
}: {entry: Entry; active: boolean; width: number; height: number; image: Source | null; video: Source | null}) {
  const [failed, setFailed] = useState(false);
  if (video && active) {
    return (
      <View style={[styles.page, styles.videoPage, {width, height}]}>
        {failed ? (
          <Text style={type.caption}>This video can't be played here.</Text>
        ) : (
          <Video source={video} style={styles.media} resizeMode="contain" controls onError={() => setFailed(true)} />
        )}
      </View>
    );
  }
  const still = video ? entry.thumb : image;
  return (
    <View style={[styles.page, {width, height}]}>
      {still && !failed ? (
        <Image source={still} style={styles.media} resizeMode="contain" onError={() => setFailed(true)} accessibilityIgnoresInvertColors />
      ) : (
        <Icon name="image" size={28} color={palette.text3} />
      )}
      {entry.kind === 'video' && !video && <Text style={[type.caption, styles.missing]}>This video can't be played here.</Text>}
    </View>
  );
}

function ViewerButton({icon, label, onPress, active}: {icon: string; label: string; onPress: () => void; active?: boolean}) {
  const {color: accent, onColor} = useAccent();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={active !== undefined ? {selected: active} : undefined}
      hitSlop={8}
      style={({pressed}) => [styles.viewerButton, active && {backgroundColor: accent}, pressed && styles.pressed]}>
      <Icon name={icon} size={20} color={active ? onColor : palette.text} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  grid: {gap: GAP},
  row: {flexDirection: 'row', gap: GAP},
  group: {...type.caption, color: palette.text2, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: space.md, marginBottom: space.xs},
  frame: {
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: palette.controlStrong,
  },
  badge: {
    position: 'absolute',
    right: 5,
    bottom: 5,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: 'rgba(12,13,15,0.72)',
  },
  badgeText: {color: '#fff', fontSize: 10, fontWeight: '700'},
  check: {
    position: 'absolute',
    top: 5,
    left: 5,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.9)',
    backgroundColor: 'rgba(12,13,15,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileText: {paddingTop: 4, paddingHorizontal: 2, paddingBottom: space.sm, gap: 1},
  tileTitle: {...type.caption, color: palette.text, fontWeight: '600'},
  selectButton: {
    alignSelf: 'flex-end',
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    borderRadius: 999,
    backgroundColor: palette.control,
    marginBottom: space.xs,
  },
  selectionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingLeft: space.lg,
    paddingRight: space.xs,
    paddingVertical: space.xs,
    borderRadius: 999,
    backgroundColor: palette.card,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: {width: 0, height: 6},
    elevation: 8,
  },
  selectionCount: {...type.caption, color: palette.text, fontWeight: '700'},
  selectionActions: {gap: space.xs, alignItems: 'center', paddingLeft: space.sm},
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    minHeight: 40,
    paddingHorizontal: space.lg,
    borderRadius: 999,
    backgroundColor: palette.control,
  },
  pillDark: {backgroundColor: 'rgba(36,37,43,0.92)'},
  pillLabel: {...type.caption, color: palette.text, fontWeight: '600'},
  disabled: {opacity: 0.5},
  pressed: {opacity: 0.75},
  viewer: {flex: 1, backgroundColor: '#08090b'},
  page: {alignItems: 'center', justifyContent: 'center'},
  // the player's own controls sit between the viewer's top bar and its action pills
  videoPage: {paddingTop: 96 + (StatusBar.currentHeight ?? 0), paddingBottom: 120},
  media: {width: '100%', height: '100%'},
  missing: {position: 'absolute', bottom: 120},
  viewerTop: {
    position: 'absolute',
    top: space.xl + (StatusBar.currentHeight ?? 0),
    left: space.lg,
    right: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  viewerHeading: {flex: 1, minWidth: 0},
  viewerTitle: {...type.body, color: palette.text, fontWeight: '600'},
  viewerButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(36,37,43,0.85)',
  },
  viewerBottom: {position: 'absolute', left: space.lg, right: space.lg, bottom: space.xl, gap: space.md},
  details: {maxHeight: 280, borderRadius: radii.card, backgroundColor: 'rgba(33,34,40,0.96)'},
  detailsContent: {padding: space.lg, gap: space.sm},
  detailRow: {flexDirection: 'row', gap: space.md},
  detailLabel: {width: 96},
  detailValue: {...type.caption, color: palette.text, flex: 1},
  viewerActions: {gap: space.sm, paddingHorizontal: space.xs, alignItems: 'center'},
});
