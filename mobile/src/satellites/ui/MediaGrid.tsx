import React, {memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState} from 'react';
import {
  AccessibilityInfo, ActivityIndicator, Animated, FlatList, Image, Modal, Pressable, ScrollView, StatusBar, StyleSheet,
  Text, useWindowDimensions, View,
} from 'react-native';
import {GestureDetector, GestureHandlerRootView, type GestureType} from 'react-native-gesture-handler';
import Icon from 'react-native-vector-icons/Feather';
import Video from 'react-native-video';
import {usePinchColumnsGesture} from '../../components/pinchColumns';
import {ZoomableImage} from '../../components/ZoomableImage';
import {keptPages} from './offline';
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

/** The narrowest a tile gets when the person pinches in. */
const MIN_TILE = 48;

/** The fewest and most columns a person can pinch a grid of `width` to. */
export function columnRange(width: number): [number, number] {
  return [2, Math.min(12, Math.max(4, Math.floor((width + GAP) / (MIN_TILE + GAP))))];
}

/** Where a person's choice of a grid's size is kept (per server and Satellite, by the screen). */
export function gridPreferenceKey(block: UiBlock): string {
  return `media-grid:${typeof block.id === 'string' && block.id ? block.id : 'grid'}:columns`;
}

/** The row a scroll offset `y` falls in, from a list's [offset, length] layout. */
export function rowAt(layout: Array<[number, number]>, y: number): number {
  let low = 0;
  let high = layout.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (layout[middle][0] <= y) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return Math.max(0, low);
}

/** The first item at or after `row` (a heading row looks at the tiles below it), or -1. */
export function firstEntryFrom(rows: Row[], row: number): number {
  for (let at = row; at < rows.length; at += 1) {
    const candidate = rows[at];
    if (candidate.kind === 'tiles') {
      return candidate.entries[0].index;
    }
  }
  return -1;
}

/** The row holding item `index`, or -1. */
export function rowOfEntry(rows: Row[], index: number): number {
  return rows.findIndex(row => row.kind === 'tiles' && row.entries.some(entry => entry.index === index));
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

export type Row = {kind: 'group'; label: string; id: string} | {kind: 'tiles'; entries: Entry[]; id: string};

/** What a grid holds: its page data's items, the pages loaded after them through `more`, and
 * the provider's cursor for the next. Kept in a ref so a page arriving late can be dropped. */
interface Paging {
  base: any[] | null;
  collection: string | null;
  extra: any[];
  /** the pages behind `extra`, one by one, and the cursor after each - what an offline page keeps */
  pages: any[][];
  cursors: (string | null)[];
  cursor: string | null;
  loading: boolean;
  error: string | null;
  token: number;
  depth: number;
}

/** The heights a virtualized grid lays its rows out with. */
const GROUP_HEIGHT = 40;
const TEXT_HEIGHT = 40;

export interface MediaGridModel {
  block: UiBlock;
  entries: Entry[];
  rows: Row[];
  /** [offset, length] of each row, for a FlatList's getItemLayout. */
  layout: Array<[number, number]>;
  columns: number;
  /** Pinching the grid changes its columns (null where it can't: the picker, a `full` grid). */
  pinch: GestureType | null;
  cursor: string | null;
  loading: boolean;
  error: string | null;
  loadMore: () => void;
  renderRow: (row: Row) => React.ReactElement;
  /** The select button above the grid, when the block offers a selection. */
  head: React.ReactElement | null;
  /** Loading, error and retry under the grid. */
  foot: React.ReactElement | null;
  /** The viewer, when it is open. */
  viewer: React.ReactElement | null;
  empty: string | null;
}

/**
 * Everything a media-grid is, apart from where its rows are drawn: paging through `more`
 * (stale pages dropped, a refresh reloading as many pages as were loaded), the selection
 * (kept across pages, and pruned only once everything is loaded again), the viewer, rows.
 */
export function useMediaGrid(block: UiBlock, scope: Scope, context: BlockContext, shown = Infinity): MediaGridModel {
  const {width: windowWidth} = useWindowDimensions();
  const {color: accent, onColor} = useAccent();
  const reduced = useReducedMotion();
  const item = (block.item ?? {}) as Record<string, any>;
  const formats = (item.format ?? {}) as Record<string, string>;
  // the screen's context is a new object every render: depend only on its stable functions
  const {mediaSource, runAction, setOverlay, load} = context;
  const [version, bump] = useReducer((value: number) => value + 1, 0);

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

  const imagesOf = useMemo(() => imageUrls(block, source), [block, source]);

  // ---------- paging ----------
  const more = block.more as {route?: string; cursor?: string} | undefined;
  const resolved = Array.isArray(block.items) ? block.items : resolve(block.items, scope);
  const base: any[] = Array.isArray(resolved) ? resolved : EMPTY;
  const paging = useRef<Paging>({
    base: null, collection: null, extra: [], pages: [], cursors: [], cursor: null, loading: false, error: null, token: 0, depth: 0,
  });
  // an offline page (UI contract 1.2): the screen keeps this grid's loaded pages, and gives them
  // back when the page data itself came from what it kept
  const {offlineGrids} = context;
  const gridId = typeof block.id === 'string' && block.id ? block.id : 'grid';
  const pg = paging.current;
  let changedCollection = false;
  if (pg.base !== base) {
    // new page data (first load, a refresh, another filter): what the grid holds starts again
    const collection = more?.route ? resolveTemplate(more.route, {...scope, value: ''}) : null;
    const same = pg.base !== null && collection === pg.collection;
    changedCollection = !same;
    pg.depth = same ? pg.extra.length : 0;
    pg.base = base;
    pg.collection = collection;
    pg.extra = [];
    pg.pages = [];
    pg.cursors = [];
    pg.token += 1;
    pg.loading = false;
    pg.error = null;
    const first = more?.cursor !== undefined ? resolve(more.cursor, scope) : null;
    pg.cursor = present(first) ? String(first) : null;
    const kept = more?.route ? offlineGrids?.restore(gridId) : null;
    if (kept) {
      pg.pages = kept.pages;
      pg.cursors = kept.pages.map((_, at) => (at === kept.pages.length - 1 ? kept.cursor : null));
      pg.extra = kept.pages.flat();
      pg.cursor = kept.cursor;
      pg.depth = 0;
    }
  }

  const keyOf = useCallback(
    (value: any, index: number) => {
      const key = item.key !== undefined ? resolve(item.key, {...scope, data: value}) : null;
      return present(key) ? String(key) : `#${index}`;
    },
    [item.key, scope.page, scope.state],
  );

  const entries: Entry[] = useMemo(
    () =>
      pg.base!.concat(pg.extra).map((value, index) => {
        const itemScope = {...scope, data: value};
        return {
          item: value,
          key: keyOf(value, index),
          index,
          scope: itemScope,
          kind: mediaKind(item.kind !== undefined ? resolve(item.kind, itemScope) : 'image'),
          thumb: source(item.image, itemScope),
        };
      }),
    [base, version, scope.page, scope.state, source, keyOf],
  );
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const loadMore = useCallback(() => {
    const state = paging.current;
    if (!more?.route || !state.cursor || state.loading || !load) {
      return;
    }
    const token = state.token;
    const route = resolveTemplate(more.route, {...scope, value: state.cursor});
    state.loading = true;
    state.error = null;
    bump();
    (isSafeRoute(route) ? load(route) : Promise.reject(new Error('That page points outside its Satellite.')))
      .then(data => {
        if (token !== paging.current.token) {
          return; // the data changed while this page was on its way
        }
        const pageScope = {...scope, data: data ?? {}, page: data ?? {}};
        const listed = resolve(block.items, pageScope);
        const known = new Set(entriesRef.current.map(entry => entry.key));
        const offset = entriesRef.current.length;
        // a provider's cursor never repeats an item; this keeps a broken one from doing so
        const fresh = (Array.isArray(listed) ? listed : []).filter((value, index) => {
          const key = keyOf(value, offset + index);
          return key.startsWith('#') || !known.has(key);
        });
        const next = more.cursor !== undefined ? resolve(more.cursor, pageScope) : null;
        state.extra = state.extra.concat(fresh);
        state.cursor = present(next) && String(next) !== state.cursor ? String(next) : null;
        state.pages = state.pages.concat([fresh]);
        state.cursors = state.cursors.concat([state.cursor]);
        state.loading = false;
        offlineGrids?.save(gridId, keptPages(state.pages, state.cursors));
        bump();
      })
      .catch((err: any) => {
        if (token === paging.current.token) {
          state.loading = false;
          state.error = err?.message || 'The next items could not be loaded.';
          bump();
        }
      });
  }, [more?.route, more?.cursor, load, block.items, keyOf, scope.page, scope.state, offlineGrids, gridId]);

  // a refresh: back to as many pages as were loaded, so the grid stays where it was
  useEffect(() => {
    if (pg.depth > pg.extra.length && pg.cursor && !pg.loading && !pg.error) {
      loadMore();
    }
  });

  // ---------- selection ----------
  const picking = context.picking;
  const pickingRef = useRef(picking);
  pickingRef.current = picking;
  const multiplePick = picking ? picking.multiple : true;
  const [selected, setSelected] = useState<Map<string, any>>(new Map());
  const [selecting, setSelecting] = useState(Boolean(picking));
  const [viewerKey, setViewerKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // another collection (a filter): the selection starts again
  useEffect(() => {
    if (changedCollection) {
      setSelected(current => (current.size ? new Map() : current));
      if (!pickingRef.current) {
        setSelecting(false);
      }
    }
  });
  // a selection keeps fresh data for what is still there, once everything loaded is loaded again
  useEffect(() => {
    if (pg.depth > pg.extra.length && pg.cursor) {
      return;
    }
    setSelected(current => {
      if (!current.size) {
        return current;
      }
      const byKey = new Map(entries.map(entry => [entry.key, entry.item]));
      const kept = new Map([...current.keys()].filter(key => byKey.has(key)).map(key => [key, byKey.get(key)]));
      return kept.size === current.size && [...kept].every(([key, value]) => current.get(key) === value) ? current : kept;
    });
  }, [entries, pg]);

  const toggle = useCallback(
    (key: string) => {
      setSelecting(true);
      setSelected(current => {
        const next = new Map(multiplePick ? current : []);
        if (current.has(key)) {
          next.delete(key);
        } else {
          next.set(key, entriesRef.current.find(entry => entry.key === key)?.item);
        }
        return next;
      });
    },
    [multiplePick],
  );

  // the picker hears what is chosen
  useEffect(() => {
    pickingRef.current?.onChange([...selected.values()]);
  }, [selected]);

  const clearSelection = useCallback(() => {
    setSelected(new Map());
    setSelecting(false);
  }, []);

  const runOnSelection = useCallback(
    async (action: UiAction) => {
      // everything selected, on whichever loaded page it is
      const chosen = [...selected.values()].map(value => ({...scope, data: value}));
      if (!chosen.length || !action) {
        return;
      }
      if (action.navigate || action.play) {
        runAction(action, chosen[0]);
        return;
      }
      if (action.secure) {
        // one request and one prompt for the whole selection (it confirms and refreshes itself)
        setBusy(true);
        const done = (await context.runSecure?.(action, chosen, imagesOf)) ?? false;
        setBusy(false);
        if (done) {
          clearSelection();
        }
        return;
      }
      const first = {...chosen[0], value: chosen.length};
      if (action.confirm && context.confirm && !(await context.confirm(asText(resolve(action.confirm, first))))) {
        return;
      }
      setBusy(true);
      const single: UiAction = {...action, confirm: undefined, then: undefined};
      let failed = 0;
      for (const itemScope of chosen) {
        if (!(await runAction(single, itemScope, undefined, {quiet: true}))) {
          failed += 1;
        }
      }
      setBusy(false);
      clearSelection();
      context.afterSelection?.(action.then, failed, chosen.length);
    },
    [selected, scope, context, runAction, clearSelection, imagesOf],
  );

  // the selection bar floats over the screen's bottom edge, above the player. It is rebuilt
  // only when the selection changes; what it runs is read from the latest render.
  // which secure actions can run changes only with the catalog: the bar is rebuilt then, never on
  // every render (the context is a new object each time, and the bar is the screen's overlay)
  const offered = (block.selection as {actions?: any[]} | undefined)?.actions;
  const canRunHere = (Array.isArray(offered) ? offered : [])
    .map((entry: any) => (canRun(context, entry?.action) ? '1' : '0'))
    .join('');
  const latest = useRef({scope, runOnSelection, context});
  latest.current = {scope, runOnSelection, context};
  const selection = block.selection as {actions?: any[]} | undefined;
  const selectionBar = useMemo(() => {
    const selectionActions: any[] = (Array.isArray(selection?.actions) ? selection!.actions! : []).filter(entry =>
      canRun(latest.current.context, entry?.action),
    );
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
  }, [block.selection, selection, selecting, selected, busy, clearSelection, picking, canRunHere]);
  useEffect(() => {
    setOverlay?.(selectionBar);
  }, [setOverlay, selectionBar]);
  useEffect(() => () => setOverlay?.(null), [setOverlay]);

  // ---------- rows ----------
  const size = typeof block.size === 'string' ? block.size : 'medium';
  const shape = typeof block.shape === 'string' ? block.shape : 'square';
  const available = Math.min(windowWidth - space.lg * 2, 1200);
  // the person's own choice of size (a pinch), remembered per server, Satellite and grid; the
  // document's `size` until they make one
  const {preferences} = context;
  const preferenceKey = picking || size === 'full' || !preferences ? null : gridPreferenceKey(block);
  const [chosen, setChosen] = useState<number | null>(() => {
    const known = preferenceKey ? preferences?.peek(preferenceKey) : null;
    return known ? Number(known) || null : null;
  });
  useEffect(() => {
    if (!preferenceKey || !preferences) {
      return;
    }
    let current = true;
    preferences
      .get(preferenceKey)
      .then(value => current && setChosen(value ? Number(value) || null : null))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [preferenceKey, preferences]);
  const [fewest, most] = columnRange(available);
  const columns = chosen ? Math.min(most, Math.max(fewest, chosen)) : gridColumns(available, size);
  const choose = useCallback(
    (next: number) => {
      setChosen(next);
      if (preferenceKey) {
        preferences?.set(preferenceKey, String(next));
      }
    },
    [preferenceKey, preferences],
  );
  const pinchGesture = usePinchColumnsGesture(columns, fewest, most, choose);
  const cell = Math.floor((available - GAP * (columns - 1)) / columns);
  const aspect = shape === 'wide' ? 16 / 9 : 1;
  const hasText = item.title !== undefined || item.subtitle !== undefined;

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
    for (const entry of shown < entries.length ? entries.slice(0, shown) : entries) {
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

  const layout = useMemo(() => {
    const tileHeight = Math.round(cell / aspect) + GAP + (hasText ? TEXT_HEIGHT : 0);
    let offset = 0;
    return rows.map(row => {
      const length = row.kind === 'group' ? GROUP_HEIGHT : tileHeight;
      const at: [number, number] = [offset, length];
      offset += length;
      return at;
    });
  }, [rows, cell, aspect, hasText]);

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

  const renderRow = (row: Row) =>
    row.kind === 'group' ? (
      <Text key={row.id} style={styles.group} accessibilityRole="header" numberOfLines={1}>
        {row.label}
      </Text>
    ) : (
      <View key={row.id} style={styles.row}>
        {row.entries.map(entry => (
          <Tile
            key={entry.key}
            entry={entry}
            size={cell}
            textHeight={hasText ? TEXT_HEIGHT : 0}
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
    );

  const head =
    block.selection && !selecting ? (
      <Pressable
        onPress={() => setSelecting(true)}
        accessibilityRole="button"
        style={({pressed}) => [styles.selectButton, pressed && styles.pressed]}>
        <Text style={styles.pillLabel}>Select</Text>
      </Pressable>
    ) : null;

  const foot = pg.error ? (
    <View style={styles.foot} testID="media-grid-error">
      <Text style={type.caption}>{pg.error}</Text>
      <ActionPill entry={{label: 'Try again'}} scope={scope} onPress={loadMore} />
    </View>
  ) : pg.loading ? (
    <View style={styles.foot} testID="media-grid-loading">
      <ActivityIndicator color={accent} />
    </View>
  ) : null;

  const viewer =
    block.viewer && viewerKey !== null ? (
      <MediaViewer
        block={block}
        entries={entries}
        startKey={viewerKey}
        context={context}
        source={source}
        reduced={reduced}
        more={Boolean(pg.cursor)}
        onEnd={loadMore}
        onClose={() => setViewerKey(null)}
      />
    ) : null;

  const emptyText = block.empty !== undefined ? resolve(block.empty, scope) : null;
  return {
    block,
    entries,
    rows,
    layout,
    columns,
    pinch: preferenceKey ? pinchGesture : null,
    cursor: pg.cursor,
    loading: pg.loading,
    error: pg.error,
    loadMore,
    renderRow,
    head,
    foot,
    viewer,
    empty: entries.length ? null : present(emptyText) ? String(emptyText) : 'Nothing here.',
  };
}

const EMPTY: any[] = [];

/** A media-grid drawn in place, inside a page that scrolls as a whole (a card, the picker's
 * old layout, a page with more than one grid): its tiles are revealed a page at a time as the
 * screen nears its end, and its next page loads when all are shown. */
export function MediaGridBlock({block, scope, context}: {block: UiBlock; scope: Scope; context: BlockContext}) {
  const [shown, setShown] = useState(GRID_PAGE);
  const model = useMediaGrid(block, scope, context, shown);
  const {onNearEnd} = context;
  const total = model.entries.length;
  const latest = useRef(model);
  latest.current = model;
  useEffect(() => {
    if (!onNearEnd || (shown >= total && !model.cursor)) {
      return;
    }
    return onNearEnd(() => {
      if (shown < latest.current.entries.length) {
        setShown(current => current + GRID_PAGE);
      } else {
        latest.current.loadMore();
      }
    });
  }, [onNearEnd, shown, total, model.cursor]);

  if (model.empty !== null) {
    return <Text style={type.caption}>{model.empty}</Text>;
  }
  const grid = (
    <View style={styles.grid} testID="media-grid" collapsable={false}>
      {model.head}
      {model.rows.map(model.renderRow)}
      {model.foot}
      {model.viewer}
    </View>
  );
  return model.pinch ? <GestureDetector gesture={model.pinch}>{grid}</GestureDetector> : grid;
}

/**
 * A media-grid that is a page's main content, as the page's own virtualized list: only the
 * rows near the screen are mounted, so a library of any size keeps a bounded number of tiles
 * (and their images) in memory. What the page shows above and below the grid comes in as
 * `header` and `footer`; the next page loads as the list nears its end.
 */
export function VirtualMediaGrid({
  block, scope, context, header, footer, refreshControl, contentContainerStyle, testID,
}: {
  block: UiBlock;
  scope: Scope;
  context: BlockContext;
  header?: React.ReactElement | null;
  footer?: React.ReactElement | null;
  refreshControl?: React.ReactElement<any>;
  contentContainerStyle?: any;
  testID?: string;
}) {
  const model = useMediaGrid(block, scope, context);
  const {layout} = model;
  const getItemLayout = useCallback(
    (_: unknown, index: number) => ({length: layout[index]?.[1] ?? 0, offset: layout[index]?.[0] ?? 0, index}),
    [layout],
  );
  // a new size (a pinch) keeps the item at the top of the screen where it was
  const list = useRef<FlatList<Row>>(null);
  const scrolled = useRef(0);
  const headHeight = useRef(0);
  const before = useRef({columns: model.columns, rows: model.rows, layout});
  // where to scroll once the list has its new height: scrolling before that would be cut short
  // at the old, shorter content (fewer columns make the list taller)
  const pending = useRef<number | null>(null);
  const viewport = useRef(0);
  const latest = useRef(model);
  latest.current = model;
  const settle = useCallback((_width?: number, height?: number) => {
    if (pending.current !== null) {
      list.current?.scrollToOffset({offset: pending.current, animated: false});
      pending.current = null;
      return;
    }
    // a page that arrived while the list was already at its end: the next is due now, not
    // only at the person's next scroll
    if (height !== undefined && viewport.current && height - (scrolled.current + viewport.current) < viewport.current * 1.5) {
      latest.current.loadMore();
    }
  }, []);
  useLayoutEffect(() => {
    const previous = before.current;
    before.current = {columns: model.columns, rows: model.rows, layout};
    const y = scrolled.current - headHeight.current;
    if (previous.columns === model.columns || y <= 0 || !previous.layout.length) {
      return;
    }
    const anchor = firstEntryFrom(previous.rows, rowAt(previous.layout, y));
    const row = anchor >= 0 ? rowOfEntry(model.rows, anchor) : -1;
    if (row >= 0 && layout[row]) {
      pending.current = layout[row][0] + headHeight.current;
      // onContentSizeChange scrolls once the new height is laid out; this, if it never changes
      const timer = setTimeout(() => settle(), 150);
      return () => clearTimeout(timer);
    }
  }, [model.columns, model.rows, layout, settle]);
  const content = (
    <FlatList
      ref={list}
      testID={testID ?? 'media-grid-list'}
      data={model.rows}
      keyExtractor={row => row.id}
      renderItem={({item: row}) => model.renderRow(row)}
      getItemLayout={getItemLayout}
      initialNumToRender={8}
      maxToRenderPerBatch={6}
      updateCellsBatchingPeriod={40}
      windowSize={7}
      removeClippedSubviews
      onEndReachedThreshold={1.5}
      onEndReached={() => model.loadMore()}
      // FlatList reports its end once per content length: after new page data of the same
      // length (a reload), the scroll position itself says when the next page is due
      scrollEventThrottle={100}
      onScroll={event => {
        const {layoutMeasurement, contentOffset, contentSize} = event.nativeEvent;
        scrolled.current = contentOffset.y;
        viewport.current = layoutMeasurement.height;
        if (contentSize.height - (contentOffset.y + layoutMeasurement.height) < layoutMeasurement.height * 1.5) {
          model.loadMore();
        }
      }}
      keyboardShouldPersistTaps="handled"
      onContentSizeChange={settle}
      refreshControl={refreshControl}
      contentContainerStyle={contentContainerStyle}
      ListHeaderComponent={
        <View style={styles.virtualHead} onLayout={event => (headHeight.current = event.nativeEvent.layout.height)}>
          {header}
          {model.empty !== null ? <Text style={type.caption}>{model.empty}</Text> : model.head}
        </View>
      }
      ListFooterComponent={
        <View style={styles.virtualFoot}>
          {model.foot}
          {footer}
        </View>
      }
    />
  );
  return (
    <>
      {model.pinch ? <GestureDetector gesture={model.pinch}>{content}</GestureDetector> : content}
      {model.viewer}
    </>
  );
}

const Tile = memo(function Tile({
  entry, size, textHeight = 0, aspect, round, title, subtitle, subtitleFormat, duration, selectable, selecting, selected,
  accent, onAccent, reduced, onPress, onLongPress,
}: {
  entry: Entry; size: number; aspect: number; round: boolean; title: string; subtitle: unknown; subtitleFormat?: string;
  duration: unknown; selectable: boolean; selecting: boolean; selected: boolean; accent: string; onAccent: string;
  reduced: boolean; onPress?: (entry: Entry) => void; onLongPress?: (key: string) => void;
  /** A fixed height for the text under the tile, so every row of a grid is as tall. */
  textHeight?: number;
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
      {(textHeight > 0 || title !== '' || present(subtitle)) && (
        <View style={[styles.tileText, {width: size}, textHeight > 0 && {height: textHeight}]}>
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
/** Whether an action's control is drawn: a secure action only where it can run (1.2). */
function canRun(context: BlockContext, action: any): boolean {
  return !action?.secure || Boolean(context.canRun?.(action));
}

/** An item's image URLs as the grid and the viewer load them: what leaves the image cache when
 * the item leaves (moved somewhere protected). */
function imageUrls(block: UiBlock, source: (template: unknown, scope: Scope) => Source | null) {
  const viewer = (block.viewer ?? {}) as Record<string, any>;
  const item = (block.item ?? {}) as Record<string, any>;
  return (scope: Scope): string[] =>
    [item.image, viewer.image, viewer.video]
      .map(template => source(template, scope)?.uri)
      .filter((uri): uri is string => typeof uri === 'string' && uri.length > 0);
}

export function MediaViewer({
  block, entries, startKey, context, source, reduced, onClose, more = false, onEnd,
}: {
  block: UiBlock; entries: Entry[]; startKey: string; context: BlockContext;
  source: (template: unknown, scope: Scope) => Source | null; reduced: boolean; onClose: () => void;
  /** More items come after these (the grid's next page): swiping near the end loads them. */
  more?: boolean;
  onEnd?: () => void;
}) {
  const {width, height} = useWindowDimensions();
  const spec = (block.viewer ?? {}) as Record<string, any>;
  const [key, setKey] = useState(startKey);
  const [info, setInfo] = useState(false);
  const [busy, setBusy] = useState(false);
  // a zoomed image pans with one finger: the pager's own swipe waits until it is back to size
  const [zoomed, setZoomed] = useState(false);
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
  const position = `${index + 1} of ${entries.length}${more ? '+' : ''}`;
  const fields: any[] = (Array.isArray(spec.fields) ? spec.fields : []).filter((field: any) => present(resolve(field.value, scope)));
  const actions: any[] = (Array.isArray(spec.actions) ? spec.actions : []).filter(
    (entry: any) => canRun(context, entry?.action) && (entry.visible === undefined || isVisible(resolve(entry.visible, scope))),
  );

  return (
    <Modal visible animationType={reduced ? 'none' : 'fade'} onRequestClose={onClose} statusBarTranslucent>
      <StatusBar barStyle="light-content" />
      {/* a Modal is a window of its own: gestures inside it need their own root */}
      <GestureHandlerRootView style={styles.viewer} testID="media-viewer">
        <FlatList
          ref={list}
          data={entries}
          horizontal
          pagingEnabled
          scrollEnabled={!zoomed}
          initialScrollIndex={index}
          getItemLayout={(_, at) => ({length: width, offset: width * at, index: at})}
          keyExtractor={entry => entry.key}
          showsHorizontalScrollIndicator={false}
          windowSize={3}
          initialNumToRender={1}
          maxToRenderPerBatch={2}
          onEndReachedThreshold={2}
          onEndReached={() => more && onEnd?.()}
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
              onZoomChange={setZoomed}
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
                    if (entry.action?.secure) {
                      await context.runSecure?.(entry.action, [scope], imageUrls(block, source));
                    } else {
                      await context.runAction(entry.action, scope);
                    }
                    setBusy(false);
                  }}
                />
              ))}
            </ScrollView>
          )}
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

function ViewerPage({
  entry, active, width, height, image, video, onZoomChange,
}: {
  entry: Entry; active: boolean; width: number; height: number; image: Source | null; video: Source | null;
  onZoomChange: (zoomed: boolean) => void;
}) {
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
      {still && !failed && !video ? (
        // pinch to zoom, then pan with one finger; double tap zooms in or back out
        <ZoomableImage source={still} active={active} onZoomChange={onZoomChange} onError={() => setFailed(true)} />
      ) : still && !failed ? (
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
  grid: {},
  virtualHead: {gap: space.md, marginBottom: space.md},
  virtualFoot: {gap: space.md, marginTop: space.md},
  foot: {alignItems: 'center', gap: space.sm, paddingVertical: space.md},
  // rows are spaced by their own padding, so a virtualized list knows each row's height
  row: {flexDirection: 'row', gap: GAP, paddingBottom: GAP},
  group: {
    ...type.caption,
    height: GROUP_HEIGHT,
    paddingBottom: space.xs,
    textAlignVertical: 'bottom',
    color: palette.text2,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
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
