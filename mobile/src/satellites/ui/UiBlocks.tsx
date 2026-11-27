import React, {memo, useCallback, useEffect, useMemo, useReducer, useRef, useState} from 'react';
import {ActivityIndicator, Alert, Animated, Clipboard, Image, PanResponder, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import {Glyph, useOwnIcons} from '../../components/Glyph';
import {Bars, ChartScale, ColumnChart, Meter, Sparkline} from '../../components/charts';
import {PrimaryButton} from '../../components/PrimaryButton';
import {Slider} from '../../components/Slider';
import {StarInput, useInputAccent} from '../../components/StarInput';
import {Reveal, useSlidingSelection} from '../../components/motion';
import {StarSwitch} from '../../components/StarSwitch';
import {Surface} from '../../components/Surface';
import {TOUCH_TARGET, tokens, useAccent} from '../../theme';
import {MapBlock} from './MapBlock';
import {ActionPill, MediaGridBlock} from './MediaGrid';
import {emptyRow, formBody, formProblem, formValues} from './forms';
import {createListPaging, rowKey, type ListPagingStatus} from './listPaging';
import {moveItem, shiftFor, targetIndex} from './reorder';
import {RowMenuSheet, useKeeper, usePlayingId} from './RowMenu';
import {groupOf, isKeptRow, isPlayingRow, rowMenu, rowQuick, runsHere, type RowEntry} from './rows';
import {boundTracks, offlineLabel, offlineState} from '../../media/offlineAction';
import type {DownloadManager} from '../../media/downloads';
import {useImageSource} from './memoryImages';
import {
  BLOCK_TYPES, findProvider, formatValue, isIconName, isSafeRoute, isVisible, resolve, resolveTemplate, servesBlock, toneOf,
  type Providers, type Scope, type UiAction, type UiBlock,
} from './contract';
import type {UiPreferences} from './preferences';
import type {GridPages} from './offline';

const {palette, space, type, radii} = tokens;

/**
 * This app's components for UI contract 1.1 blocks (docs/ui-contract.md).
 * Each block is drawn with the app's own components and tokens; what it
 * shows comes from bindings into live data, and what it does is an action
 * the screen runs against the Satellite's own routes. No block knows which
 * Satellite it belongs to - shared ones such as the file browser are bound
 * to a capability instead.
 */
export interface BlockContext {
  developer: boolean;
  providers: Providers;
  /** The Satellite whose interface this is: a list marks the row the audio host plays when it
   * plays from this Satellite (`item.audio`, 1.2). */
  satellite?: string;
  /** Runs an action; resolves true once its request (if any) succeeded. `quiet` (one item of
   * a selection) leaves notices and refreshing to the caller; `update` redraws the row an
   * answer's item was merged into (`then: "update"`, 1.2). */
  runAction: (
    action: UiAction | undefined,
    scope: Scope,
    value?: unknown,
    options?: {quiet?: boolean; update?: () => void},
  ) => Promise<boolean>;
  /** Reads one operation of a capability provider - another Satellite's route. */
  readCapability: (satellite: string, route: string) => Promise<any>;
  /** An image from one of the Satellite's own routes, with this session (1.2's image and
   * media-list); null when the route is unsafe or there is no screen to load it from. */
  mediaSource?: (route: string) => {uri: string; headers?: Record<string, string>} | null;
  /** Form values survive a data refresh, keyed per form block. */
  forms: Record<string, Record<string, any>>;
  /** Reads one of the Satellite's own routes with this session (1.2: a grid's next page through
   * `more`, a map's viewport). Stable across renders. */
  load?: (route: string) => Promise<any>;
  /** A slider or text field is being used - background refresh holds off. */
  setEditing: (editing: boolean) => void;
  /** 1.1: the page's own values (a choice's selection), and how a choice changes one. */
  pageState?: Record<string, any>;
  setPageState?: (key: string, value: any) => void;
  /** New data for the page is on its way: what is shown stays, dimmed. */
  refreshing?: boolean;
  /** The header: a field reads as one line of context ("Updated 12s ago · Sampling every 5 s"). */
  inline?: boolean;
  /** 1.2's media-grid: calls `listener` whenever the screen scrolls near its end, so the grid
   * reveals its next page; returns the unsubscribe. Stable across renders. */
  onNearEnd?: (listener: () => void) => () => void;
  /** 1.2's media-grid: what floats over the screen's bottom edge (a selection bar), or null.
   * Stable across renders. */
  setOverlay?: (node: React.ReactNode) => void;
  /** Asks before an action (a selection's confirm). */
  confirm?: (message: string) => Promise<boolean>;
  /** The media picker's own grid (media.picker): every tile selects, and the picker hears the
   * chosen items. Set only by the picker. */
  picking?: {multiple: boolean; onChange: (items: any[]) => void};
  /** After a selection's action ran on each selected item: its `then`, and how many failed. */
  afterSelection?: (then: UiAction['then'], failed: number, total: number) => void;
  /** 1.2's own action: whether this app has the Satellite's own native screens to open. A
   * button that opens them is hidden without. */
  hasOwnScreens?: boolean;
  /** 1.2's secure action: whether it can run here (a control that can't is hidden), and running
   * it once on items (one prompt for a whole selection). `imagesOf` names each item's image URLs,
   * dropped from the image cache once the item has left. True once something was done. */
  canRun?: (action: UiAction | undefined) => boolean;
  runSecure?: (action: UiAction, items: Scope[], imagesOf?: (item: Scope) => string[]) => Promise<boolean>;
  /** What the person chose here before (a media-grid's size), kept per server and Satellite. */
  preferences?: UiPreferences;
  /** An offline page (1.2): a media-grid hands over the pages it loaded, to keep, and gets them
   * back when the page data shown came from what was kept. Stable across renders. */
  offlineGrids?: {restore: (grid: string) => GridPages | null; save: (grid: string, pages: GridPages) => void};
}

const asText = (value: unknown) => (value === null || value === undefined ? '' : String(value));

const TONE_COLORS: Record<string, string> = {neutral: palette.text, ok: palette.text, warn: palette.warn, danger: palette.danger};
const DOT_COLORS: Record<string, string> = {neutral: palette.text3, ok: palette.textIcon, warn: palette.warn, danger: palette.danger};
const METER_LEVELS: Record<string, 'warning' | 'critical' | null> = {neutral: null, ok: null, warn: 'warning', danger: 'critical'};

/** Whether a block is drawn at all - Developer Mode, the client capabilities it requires and `visible`. */
export function isShown(block: UiBlock, scope: Scope, context: BlockContext): boolean {
  if (!block || typeof block !== 'object') {
    return false;
  }
  if ((block.developer && !context.developer) || !servesBlock(block)) {
    return false;
  }
  return !('visible' in block) || isVisible(resolve(block.visible, scope));
}

export function UiBlocks({blocks, scope, context}: {blocks: UiBlock[] | undefined; scope: Scope; context: BlockContext}) {
  return (
    <>
      {(blocks ?? []).map((block, index) => (
        <UiBlockView key={block?.id ?? `${block?.type}-${index}`} block={block} scope={scope} context={context} />
      ))}
    </>
  );
}

/** A page's own blocks. On a dashboard, a run of metrics is a grid of tiles;
 * everything else stacks, as a phone is one column wide. */
export function UiPageBlocks({
  blocks, scope, context, template,
}: {blocks: UiBlock[] | undefined; scope: Scope; context: BlockContext; template?: string}) {
  if (template !== 'dashboard') {
    return <UiBlocks blocks={blocks} scope={scope} context={context} />;
  }
  const groups: Array<{tiles: boolean; items: Array<{block: UiBlock; key: string}>}> = [];
  (blocks ?? []).forEach((block, index) => {
    if (!isShown(block, scope, context)) {
      return;
    }
    const tiles = block.type === 'metric';
    const last = groups[groups.length - 1];
    const key = block.id ?? `${block.type}-${index}`;
    if (tiles && last?.tiles) {
      last.items.push({block, key});
    } else {
      groups.push({tiles, items: [{block, key}]});
    }
  });
  return (
    <>
      {groups.map(group =>
        group.tiles ? (
          <View key={group.items[0].key} style={styles.tiles}>
            {group.items.map(({block, key}) => (
              <MetricBlock key={key} block={block} scope={scope} context={context} tile />
            ))}
          </View>
        ) : (
          <UiBlockView key={group.items[0].key} block={group.items[0].block} scope={scope} context={context} />
        ),
      )}
    </>
  );
}

/** A widget's blocks (Home): a run of metrics shares one compact row. */
export function UiWidgetBlocks({blocks, scope, context}: {blocks: UiBlock[] | undefined; scope: Scope; context: BlockContext}) {
  const shown = (blocks ?? []).map((block, index) => ({block, key: block?.id ?? `${block?.type}-${index}`}))
    .filter(({block}) => isShown(block, scope, context));
  const groups: Array<Array<{block: UiBlock; key: string}>> = [];
  for (const item of shown) {
    const last = groups[groups.length - 1];
    if (item.block.type === 'metric' && last?.[0].block.type === 'metric') {
      last.push(item);
    } else {
      groups.push([item]);
    }
  }
  return (
    <>
      {groups.map(group =>
        group[0].block.type === 'metric' ? (
          <View key={group[0].key} style={styles.compactRow}>
            {group.map(({block, key}) => (
              <MetricBlock key={key} block={block} scope={scope} context={context} compact />
            ))}
          </View>
        ) : group[0].block.type === 'list' ? (
          <WidgetList key={group[0].key} block={group[0].block} scope={scope} />
        ) : (
          <UiBlockView key={group[0].key} block={group[0].block} scope={scope} context={context} />
        ),
      )}
    </>
  );
}

/** A widget's list: a line per row, two at most, then how many more. */
function WidgetList({block, scope}: {block: UiBlock; scope: Scope}) {
  const items = Array.isArray(block.items) ? block.items : resolve(block.items, scope);
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }
  const shown = items.slice(0, 2);
  return (
    <View style={styles.widgetList}>
      {shown.map((item: any, index: number) => {
        const itemScope = {...scope, data: item};
        return (
          <View key={index} style={styles.widgetRow}>
            {block.item?.tone !== undefined && <Dot tone={resolve(block.item.tone, itemScope)} size={6} />}
            <Text style={[type.caption, styles.widgetText]} numberOfLines={1}>
              {asText(resolve(block.item?.title, itemScope))}
            </Text>
          </View>
        );
      })}
      {items.length > shown.length && <Text style={[type.caption, styles.more]}>{`+${items.length - shown.length} more`}</Text>}
    </View>
  );
}

function UiBlockView({block, scope, context}: {block: UiBlock; scope: Scope; context: BlockContext}) {
  if (!isShown(block, scope, context)) {
    return null;
  }
  if (!BLOCK_TYPES.has(block.type)) {
    // a newer block this app doesn't know - skipped, unless the page needs it
    return block.required ? <Text style={styles.unsupported}>Part of this page needs a newer StarCore app.</Text> : null;
  }
  switch (block.type) {
    case 'heading':
      return <Text style={type.title}>{asText(resolve(block.text, scope))}</Text>;
    case 'text':
      if (block.style === 'eyebrow') {
        return <Text style={[type.eyebrow, styles.eyebrow]}>{asText(resolve(block.text, scope)).toUpperCase()}</Text>;
      }
      return (
        <Text style={block.style === 'caption' ? type.caption : block.style === 'mono' ? styles.mono : styles.body}>
          {asText(resolve(block.text, scope))}
        </Text>
      );
    case 'field':
      return context.inline ? <InlineField block={block} scope={scope} /> : <FieldBlock block={block} scope={scope} />;
    case 'metric':
      return <MetricBlock block={block} scope={scope} context={context} />;
    case 'card':
      return (
        <Surface style={styles.card}>
          {block.title !== undefined && <Text style={type.eyebrow}>{asText(resolve(block.title, scope)).toUpperCase()}</Text>}
          <UiBlocks blocks={block.blocks} scope={scope} context={context} />
        </Surface>
      );
    case 'list':
      return <ListBlock block={block} scope={scope} context={context} />;
    case 'breadcrumb':
      return <BreadcrumbBlock block={block} scope={scope} context={context} />;
    case 'button':
      return <ButtonBlock block={block} scope={scope} context={context} />;
    case 'actions':
      return <ActionsBlock block={block} scope={scope} context={context} />;
    case 'dropdown':
      return null; // only drawn by its actions row
    case 'toggle':
      return <ToggleBlock block={block} scope={scope} context={context} />;
    case 'slider':
      return <SliderBlock block={block} scope={scope} context={context} />;
    case 'form':
      return <FormBlock block={block} scope={scope} context={context} />;
    case 'file-browser':
      return <FileBrowserBlock block={block} scope={scope} context={context} />;
    case 'image':
      return <ImageBlock block={block} scope={scope} context={context} />;
    case 'media-list':
      return <MediaListBlock block={block} scope={scope} context={context} />;
    case 'media-grid':
      return <MediaGridBlock block={block} scope={scope} context={context} />;
    case 'search':
      return <SearchBlock block={block} scope={scope} context={context} />;
    case 'map':
      return <MapBlock block={block} scope={scope} context={context} />;
    case 'chart':
      return block.kind === 'bars' ? <BarsBlock block={block} scope={scope} /> : <ChartBlock block={block} scope={scope} context={context} />;
    case 'table':
      return <TableBlock block={block} scope={scope} />;
    case 'choice':
      return <ChoiceBlock block={block} scope={scope} context={context} />;
    case 'status':
      return <StatusBlock block={block} scope={scope} />;
    case 'code':
      return <CodeBlock block={block} scope={scope} />;
    default:
      return null;
  }
}

function Dot({tone, size = 8}: {tone: unknown; size?: number}) {
  return <View style={{width: size, height: size, borderRadius: size / 2, backgroundColor: DOT_COLORS[toneOf(tone)]}} />;
}

function InlineField({block, scope}: {block: UiBlock; scope: Scope}) {
  const detail = block.detail !== undefined ? asText(resolve(block.detail, scope)) : '';
  const value = formatValue(resolve(block.value, scope), block.format, block.unit);
  return <Text style={type.caption}>{`${asText(resolve(block.label, scope))} ${value}${detail ? ` · ${detail}` : ''}`}</Text>;
}

function FieldBlock({block, scope}: {block: UiBlock; scope: Scope}) {
  const detail = block.detail !== undefined ? asText(resolve(block.detail, scope)) : '';
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{asText(resolve(block.label, scope))}</Text>
      <View style={styles.fieldValue}>
        <Text style={[styles.value, {color: TONE_COLORS[toneOf(resolve(block.tone, scope))]}]} selectable>
          {formatValue(resolve(block.value, scope), block.format, block.unit)}
        </Text>
        {detail ? <Text style={styles.detail}>{detail}</Text> : null}
      </View>
    </View>
  );
}

function pointValue(point: unknown): number | null {
  const value = Array.isArray(point) ? point[1] : point;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function MetricBlock({
  block, scope, context, tile, compact,
}: {block: UiBlock; scope: Scope; context: BlockContext; tile?: boolean; compact?: boolean}) {
  const value = resolve(block.value, scope);
  const max = resolve(block.max, scope);
  const tone = toneOf(resolve(block.tone, scope));
  const {color: accent} = useAccent();
  const label = asText(resolve(block.label, scope));
  const shown = formatValue(value, block.format, block.unit);
  const detail = block.detail !== undefined ? asText(resolve(block.detail, scope)) : '';
  const percent = typeof max === 'number' && max > 0 && typeof value === 'number' ? (value / max) * 100 : null;
  const trend = block.trend !== undefined ? resolve(block.trend, scope) : null;
  const values = Array.isArray(trend) ? trend.map(pointValue).filter((item): item is number => item !== null) : [];
  const content = (
    <>
      {tile || compact ? (
        <>
          <Text style={[type.eyebrow, styles.tileLabel]}>{label.toUpperCase()}</Text>
          <Text style={[compact ? styles.compactValue : styles.tileValue, {color: TONE_COLORS[tone]}]} numberOfLines={1} adjustsFontSizeToFit>
            {shown}
          </Text>
        </>
      ) : (
        <View style={styles.field}>
          <Text style={styles.label}>{label}</Text>
          <Text style={[styles.metricValue, {color: TONE_COLORS[tone]}]}>{shown}</Text>
        </View>
      )}
      {detail ? (
        <Text style={type.caption} numberOfLines={2}>
          {detail}
        </Text>
      ) : null}
      {percent !== null && <Meter value={percent} level={METER_LEVELS[tone]} label={label} />}
      {values.length > 1 && <Sparkline values={values} accent={accent} />}
    </>
  );
  const style = tile ? styles.tile : compact ? styles.compact : styles.metric;
  const description = `${label}: ${shown}${detail ? `, ${detail}` : ''}`;
  if (block.action) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={description}
        onPress={() => context.runAction(block.action, scope)}
        style={({pressed}) => [style, pressed && styles.pressed]}>
        {content}
      </Pressable>
    );
  }
  return (
    <View style={style} accessible accessibilityLabel={description}>
      {content}
    </View>
  );
}

/** One row of a list block. A row is drawn again only when its item, the list, what the page
 * binds to or the way actions run changed - not when a further page of rows arrives. */
export const ListRow = memo(
  function ListRow({block, item, scope, context}: {block: UiBlock; item: any; scope: Scope; context: BlockContext}) {
    const formats = block.item?.format ?? {};
    const itemScope = {...scope, data: item};
    const iconName = resolve(block.item?.icon, itemScope);
    const own = useOwnIcons();
    const title = asText(resolve(block.item?.title, itemScope));
    const subtitle = block.item?.subtitle !== undefined ? resolve(block.item.subtitle, itemScope) : undefined;
    return (
      <Row
        icon={isIconName(iconName, own) ? iconName : undefined}
        tone={block.item?.tone !== undefined ? resolve(block.item.tone, itemScope) : undefined}
        title={title}
        subtitle={subtitle !== undefined && subtitle !== null && subtitle !== '' ? formatValue(subtitle, formats.subtitle) : undefined}
        value={block.item?.value !== undefined ? formatValue(resolve(block.item.value, itemScope), formats.value) : undefined}
        onPress={block.action ? () => context.runAction(block.action, itemScope) : undefined}
      />
    );
  },
  (before, after) =>
    before.block === after.block &&
    before.item === after.item &&
    before.context.runAction === after.context.runAction &&
    before.scope.data === after.scope.data &&
    before.scope.page === after.scope.page &&
    before.scope.params === after.scope.params &&
    before.scope.state === after.scope.state &&
    before.scope.sources === after.scope.sources,
);

function listRow(block: UiBlock, item: any, index: number, scope: Scope, context: BlockContext) {
  return <ListRow key={item?.id ?? index} block={block} item={item} scope={scope} context={context} />;
}

/** Below a list that loads further pages: the error and "Try again", "Loading…" while a page
 * comes, "Show more" while there is one, else nothing. */
export function ListFooter({status, scope, onMore}: {status: ListPagingStatus; scope: Scope; onMore: () => void}) {
  const {color: accent} = useAccent();
  if (status.error) {
    return (
      <View style={styles.listFoot} testID="list-more-error">
        <Text style={type.caption}>{status.error}</Text>
        <ActionPill entry={{label: 'Try again'}} scope={scope} onPress={onMore} />
      </View>
    );
  }
  if (status.loading) {
    return (
      <View style={styles.listFoot} testID="list-more-loading">
        <ActivityIndicator color={accent} accessibilityLabel="Loading…" />
      </View>
    );
  }
  if (status.more) {
    return (
      <View style={styles.listFoot} testID="list-more">
        <ActionPill entry={{label: 'Show more'}} scope={scope} onPress={onMore} />
      </View>
    );
  }
  return null;
}

/** A breadcrumb (1.2): the way down to the current place on one scrolling row of pills. Every
 * entry but the last runs the block's action; the last is where the person is, and the row
 * starts scrolled to it when the trail is longer than the screen. */
function BreadcrumbBlock({block, scope, context}: {block: UiBlock; scope: Scope; context: BlockContext}) {
  const {color: accent} = useAccent();
  const scroller = useRef<ScrollView>(null);
  const items = Array.isArray(block.items) ? block.items : resolve(block.items, scope);
  const trail: any[] = Array.isArray(items) ? items : [];
  return (
    <ScrollView
      ref={scroller}
      horizontal
      showsHorizontalScrollIndicator={false}
      onContentSizeChange={() => scroller.current?.scrollToEnd({animated: false})}
      contentContainerStyle={styles.crumbs}
      testID="breadcrumb">
      {trail.map((item, index) => {
        const itemScope = {...scope, data: item};
        const title = asText(resolve(block.item.title, itemScope));
        const last = index === trail.length - 1;
        const step = last || !block.action ? undefined : () => context.runAction(block.action, itemScope);
        return (
          <React.Fragment key={index}>
            {index > 0 && <Icon name="chevron-right" size={14} color={palette.text3} />}
            <Pressable
              onPress={step}
              disabled={!step}
              accessibilityRole={step ? 'button' : 'text'}
              accessibilityLabel={title}
              accessibilityState={{selected: last}}
              style={({pressed}) => [styles.crumb, last && styles.crumbHere, pressed && {opacity: 0.7}]}>
              <Text style={[styles.crumbLabel, last && {color: accent, fontWeight: '700'}]} numberOfLines={1}>{title}</Text>
            </Pressable>
          </React.Fragment>
        );
      })}
    </ScrollView>
  );
}

function ListBlock({block, scope, context}: {block: UiBlock; scope: Scope; context: BlockContext}) {
  if (block.more) {
    return <PagedListBlock block={block} scope={scope} context={context} />;
  }
  const items = Array.isArray(block.items) ? block.items : resolve(block.items, scope);
  if (!Array.isArray(items) || items.length === 0) {
    return <Text style={type.caption}>{block.empty !== undefined ? asText(resolve(block.empty, scope)) : 'Nothing here.'}</Text>;
  }
  return <View style={styles.list}>{items.map((item: any, index: number) => listRow(block, item, index, scope, context))}</View>;
}

/** A list with `more` (1.2) drawn in place, inside a page that scrolls as a whole (in a card):
 * its rows, then the next page - loaded as the screen scrolls near its end, or with "Show
 * more". A paged list among a page's own blocks makes the page a virtualized list instead
 * (VirtualListPage; docs/ui-contract.md, "Paging a list"). */
function PagedListBlock({
  block, scope, context, draw,
}: {block: UiBlock; scope: Scope; context: BlockContext; draw?: (rows: any[]) => React.ReactNode}) {
  const paging = useRef(createListPaging({load: context.load})).current;
  const [, setVersion] = useState(0);
  // the screen reached its end while a page was on its way: it sends no more scroll events once
  // it can't move, so the next page is asked for as soon as this one is in
  const wanted = useRef(false);
  const rows = paging.rows(block, scope);
  const status = paging.status(block);
  const next = useCallback(() => {
    const now = paging.status(block);
    if (!now.more || now.loading) {
      return;
    }
    wanted.current = false;
    paging.loadMore(block).then(() => {
      setVersion(version => version + 1);
      const after = paging.status(block);
      if (wanted.current && after.more && !after.error) {
        next();
      }
    });
    setVersion(version => version + 1);
  }, [paging, block]);
  const {onNearEnd} = context;
  useEffect(() => {
    if (!onNearEnd) {
      return undefined;
    }
    return onNearEnd(() => {
      const now = paging.status(block);
      if (now.loading) {
        wanted.current = true;
      } else if (now.more && !now.error) {
        next();
      }
    });
  }, [onNearEnd, paging, block, next]);
  // after a refresh of the same list: back to as many pages as it had
  useEffect(() => {
    if (status.restoring && !status.loading && !status.error) {
      next();
    }
  }, [status.restoring, status.loading, status.error, next]);

  if (rows.length === 0 && !status.more && !status.error) {
    return <Text style={type.caption}>{block.empty !== undefined ? asText(resolve(block.empty, scope)) : 'Nothing here.'}</Text>;
  }
  return (
    <View style={styles.list}>
      {draw ? draw(rows) : rows.map((item: any, index: number) => listRow(block, item, index, scope, context))}
      <ListFooter status={status} scope={scope} onMore={next} />
    </View>
  );
}

// ---------- media (1.2) ----------

const IMAGE_SIZES: Record<string, number> = {small: 48, medium: 96, large: 240};
const THUMB_SIZES: Record<string, number> = {small: 40, medium: 56, large: 72, full: 96};

/** An image from one of the Satellite's own routes: a quiet placeholder while it loads, a fade
 * in once it has, the image glyph if it can't be. */
function MediaFrame({
  template, scope, context, width, aspect, round, fit, large, alt,
}: {
  template: unknown; scope: Scope; context: BlockContext; width: number | '100%'; aspect: number;
  round: boolean; fit: 'cover' | 'contain'; large?: boolean; alt?: string;
}) {
  const route = typeof template === 'string' ? resolveTemplate(template, scope) : null;
  const source = route && isSafeRoute(route) ? context.mediaSource?.(route) ?? null : null;
  // a protected document's images come from memory, never through the image loader's cache
  const [drawn, unreadable] = useImageSource(source);
  const [failed, setFailed] = useState(false);
  const shown = useRef(new Animated.Value(0)).current;
  const uri = source?.uri;
  useEffect(() => {
    setFailed(false);
    shown.setValue(0);
  }, [uri, shown]);
  const frame = [
    styles.mediaFrame,
    {width, aspectRatio: aspect},
    round ? {borderRadius: 9999} : large ? {borderRadius: radii.card} : null,
  ];
  return (
    <View style={frame} accessible={!!alt} accessibilityRole={alt ? 'image' : undefined} accessibilityLabel={alt || undefined}>
      {drawn && !failed && !unreadable ? (
        <Animated.View style={[StyleSheet.absoluteFill, {opacity: shown}]}>
          <Image
            source={drawn}
            resizeMode={fit}
            style={StyleSheet.absoluteFill}
            onLoad={() => Animated.timing(shown, {toValue: 1, duration: 180, useNativeDriver: true}).start()}
            onError={() => setFailed(true)}
          />
        </Animated.View>
      ) : (
        <Icon name="image" size={18} color={palette.text3} />
      )}
    </View>
  );
}

function ImageBlock({block, scope, context}: {block: UiBlock; scope: Scope; context: BlockContext}) {
  const size = typeof block.size === 'string' ? block.size : 'medium';
  const shape = typeof block.shape === 'string' ? block.shape : 'square';
  const wide = shape === 'wide';
  const width = size === 'full' ? '100%' : (IMAGE_SIZES[size] ?? 96) * (wide ? 16 / 9 : 1);
  const caption = block.caption !== undefined ? asText(resolve(block.caption, scope)) : '';
  return (
    <View style={styles.image}>
      <MediaFrame
        template={block.src}
        scope={scope}
        context={context}
        width={typeof width === 'number' ? Math.min(width, 640) : width}
        aspect={wide ? 16 / 9 : 1}
        round={shape === 'round'}
        fit={block.fit === 'contain' ? 'contain' : 'cover'}
        large={size === 'large' || size === 'full'}
        alt={block.alt !== undefined ? asText(resolve(block.alt, scope)) : undefined}
      />
      {caption ? <Text style={type.caption}>{caption}</Text> : null}
    </View>
  );
}

function MediaListBlock({block, scope, context}: {block: UiBlock; scope: Scope; context: BlockContext}) {
  if (block.more) {
    return (
      <PagedListBlock
        block={block}
        scope={scope}
        context={context}
        draw={rows => <MediaRows block={block} rows={rows} scope={scope} context={context} />}
      />
    );
  }
  const items = Array.isArray(block.items) ? block.items : resolve(block.items, scope);
  if (!Array.isArray(items) || items.length === 0) {
    return <Text style={type.caption}>{block.empty !== undefined ? asText(resolve(block.empty, scope)) : 'Nothing here.'}</Text>;
  }
  return (
    <View style={styles.list}>
      {block.reorder ? (
        <ReorderRows block={block} rows={items} scope={scope} context={context} />
      ) : (
        <MediaRows block={block} rows={items} scope={scope} context={context} />
      )}
    </View>
  );
}

interface ReorderControl {
  start: (index: number) => void;
  update: (dy: number) => void;
  end: (commit: boolean) => void;
  step: (index: number, by: number) => void;
}

/**
 * A reorderable media-list's rows (1.2, change 8): a row is dragged by its handle at once, with
 * no long press, the rows between stepping aside; the handle's accessibility actions move it one
 * place. The rows move at once and the list's route gets {from, to} as $value; if it fails they
 * move back. Only a whole list (never one with `more`, or groups) reorders.
 */
function ReorderRows({block, rows, scope, context}: {block: UiBlock; rows: any[]; scope: Scope; context: BlockContext}) {
  const playing = usePlayingId(context.satellite, block.item?.audio !== undefined);
  const keeper = useKeeper(context.satellite, block.item?.audio !== undefined || hasOffline(block));
  const keys = mediaRowKeys(block, rows, scope);
  const [, redraw] = useReducer((value: number) => value + 1, 0);
  const [drag, setDrag] = useState<{from: number; target: number} | null>(null);
  const offset = useRef(new Animated.Value(0)).current;
  const tops = useRef<number[]>([]);
  const held = useRef<{from: number; target: number; pitch: number} | null>(null);
  const pitchAt = (index: number) => {
    const here = tops.current[index];
    const next = tops.current[index + 1];
    const before = tops.current[index - 1];
    if (typeof here === 'number' && typeof next === 'number') {
      return Math.abs(next - here);
    }
    return typeof here === 'number' && typeof before === 'number' ? Math.abs(here - before) : 0;
  };
  const move = async (from: number, to: number) => {
    const moved = rows[from];
    if (!moveItem(rows, from, to)) {
      return;
    }
    redraw();
    const done = await context.runAction(block.reorder, {...scope, data: moved}, {from, to});
    if (!done) {
      moveItem(rows, to, from);
      redraw();
    }
  };
  const control = useRef<ReorderControl | null>(null);
  control.current = {
    start: index => {
      held.current = {from: index, target: index, pitch: pitchAt(index)};
      offset.setValue(0);
      setDrag({from: index, target: index});
    },
    update: dy => {
      const now = held.current;
      if (!now) {
        return;
      }
      offset.setValue(dy);
      const target = targetIndex(now.from, dy, now.pitch, rows.length);
      if (target !== now.target) {
        now.target = target;
        setDrag({from: now.from, target});
      }
    },
    end: commit => {
      const now = held.current;
      held.current = null;
      offset.setValue(0);
      setDrag(null);
      if (now && commit && now.target !== now.from) {
        move(now.from, now.target);
      }
    },
    step: (index, by) => {
      const to = index + by;
      if (to >= 0 && to < rows.length) {
        move(index, to);
      }
    },
  };
  const pitch = drag ? held.current?.pitch ?? 0 : 0;
  return (
    <>
      {rows.map((item, index) => {
        const itemScope = {...scope, data: item};
        const dragging = drag?.from === index;
        const shift = drag && !dragging ? shiftFor(index, drag.from, drag.target, pitch) : 0;
        const title = asText(resolve(block.item?.title, itemScope));
        return (
          <Animated.View
            key={keys[index]}
            onLayout={event => {
              tops.current[index] = event.nativeEvent.layout.y;
            }}
            style={[dragging ? styles.reorderHeld : null, {transform: [{translateY: dragging ? offset : shift}]}]}>
            <MediaRow
              block={block}
              item={item}
              scope={scope}
              context={context}
              playing={isPlayingRow(block, itemScope, playing)}
              kept={isKeptRow(block, itemScope, keeper)}
              keeper={keeper}
              handle={<ReorderHandle index={index} count={rows.length} title={title} control={control} />}
            />
          </Animated.View>
        );
      })}
    </>
  );
}

/** A row's handle: dragged at once (its own responder, so the page does not scroll meanwhile),
 * or moved one place with the accessibility actions Move up and Move down. */
function ReorderHandle({
  index, count, title, control,
}: {index: number; count: number; title: string; control: React.MutableRefObject<ReorderControl | null>}) {
  const indexRef = useRef(index);
  indexRef.current = index;
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => control.current?.start(indexRef.current),
      onPanResponderMove: (_, gesture) => control.current?.update(gesture.dy),
      onPanResponderRelease: () => control.current?.end(true),
      onPanResponderTerminate: () => control.current?.end(false),
    }),
  ).current;
  const actions = [
    ...(index > 0 ? [{name: 'moveUp', label: 'Move up'}] : []),
    ...(index < count - 1 ? [{name: 'moveDown', label: 'Move down'}] : []),
  ];
  return (
    <View
      {...responder.panHandlers}
      accessible
      accessibilityRole="button"
      accessibilityLabel={title ? `Move ${title}` : 'Move'}
      accessibilityHint="Drag up or down, or use the Move up and Move down actions"
      accessibilityActions={actions}
      onAccessibilityAction={event => {
        const action = event.nativeEvent.actionName;
        if (action === 'moveUp') {
          control.current?.step(indexRef.current, -1);
        } else if (action === 'moveDown') {
          control.current?.step(indexRef.current, 1);
        }
      }}
      testID="media-row-handle"
      style={styles.rowHandle}>
      <Icon name="menu" size={18} color={palette.text3} />
    </View>
  );
}

/** A media-list's rows, each group's heading above its first row (`item.group`, 1.2), the row
 * the audio host plays marked (`item.audio`). */
function MediaRows({block, rows, scope, context}: {block: UiBlock; rows: any[]; scope: Scope; context: BlockContext}) {
  const playing = usePlayingId(context.satellite, block.item?.audio !== undefined);
  const keeper = useKeeper(context.satellite, block.item?.audio !== undefined || hasOffline(block));
  const keys = mediaRowKeys(block, rows, scope);
  const out: React.ReactNode[] = [];
  let label = '';
  rows.forEach((item, index) => {
    const itemScope = {...scope, data: item};
    const group = mediaGroup(block, itemScope);
    if (group !== '' && group !== label) {
      out.push(<MediaGroupHeading key={`group:${index}`} label={group} />);
      label = group;
    }
    out.push(
      <MediaRow
        key={keys[index]}
        block={block}
        item={item}
        scope={scope}
        context={context}
        playing={isPlayingRow(block, itemScope, playing)}
        kept={isKeptRow(block, itemScope, keeper)}
        keeper={keeper}
      />,
    );
  });
  return <>{out}</>;
}

/** Each row's React key: its `item.key` (1.2), so a row keeps its place and state as further
 * pages arrive; its position for a row without one, or a key seen already. */
export function mediaRowKeys(block: UiBlock, rows: any[], scope: Scope): string[] {
  const seen = new Set<string>();
  return rows.map((item, index) => {
    const known = block.item?.key !== undefined ? rowKey(block, item, scope) : null;
    const key = known !== null && !seen.has(`k:${known}`) ? `k:${known}` : `#${index}`;
    seen.add(key);
    return key;
  });
}

/** The group a media-list row starts, formatted as the block says; '' for none. */
export function mediaGroup(block: UiBlock, itemScope: Scope): string {
  const format = block.item?.format?.group;
  return groupOf(block, itemScope, value => formatValue(value, format));
}

export function MediaGroupHeading({label}: {label: string}) {
  return (
    <Text style={styles.mediaGroup} accessibilityRole="header" numberOfLines={1}>
      {label}
    </Text>
  );
}

/**
 * One row of a media-list (1.2): its image, title and lines; its quick buttons (every visible
 * one, so a heart pair is one toggle) and its menu - a More button, or a long press - with only
 * what this app can run. An answer merged into the row (`then: "update"`) redraws just it.
 */
export const MediaRow = memo(
  function MediaRow({
    block, item, scope, context, playing, kept = false, keeper = null, handle,
  }: {
    block: UiBlock; item: any; scope: Scope; context: BlockContext; playing: boolean;
    /** one of the tracks kept on this phone (`item.audio`, change 10) */
    kept?: boolean;
    keeper?: DownloadManager | null;
    handle?: React.ReactNode;
  }) {
    const [, redraw] = useReducer((value: number) => value + 1, 0);
    const [menuOpen, setMenuOpen] = useState(false);
    const {color: accent} = useAccent();
    const size = typeof block.size === 'string' ? block.size : 'small';
    const shape = typeof block.shape === 'string' ? block.shape : 'square';
    const thumb = THUMB_SIZES[size] ?? 40;
    const formats = block.item?.format ?? {};
    const itemScope = {...scope, data: item};
    const runs = (action: UiAction) => runsHere(action, context);
    const quick = rowQuick(block, itemScope, runs);
    // an offline entry's label is the app's own: Download, Downloading… or Remove download
    const menu = rowMenu(block, itemScope, runs).map(entry =>
      entry.action.offline !== undefined
        ? {...entry, label: offlineLabel(keeper ? offlineState(keeper, boundTracks(entry.action.offline, itemScope) ?? []) : null, true)}
        : entry,
    );
    const run = (action: UiAction | undefined) => context.runAction(action, itemScope, undefined, {update: redraw});
    const title = asText(resolve(block.item?.title, itemScope));
    const subtitle = block.item?.subtitle !== undefined ? resolve(block.item.subtitle, itemScope) : undefined;
    const meta = block.item?.meta !== undefined ? resolve(block.item.meta, itemScope) : undefined;
    const opens = block.action !== undefined && runsHere(block.action, context);
    const content = (
      <>
        {block.item?.image !== undefined && (
          <MediaFrame
            template={block.item.image}
            scope={itemScope}
            context={context}
            width={shape === 'wide' ? Math.round(thumb * 16 / 9) : thumb}
            aspect={shape === 'wide' ? 16 / 9 : 1}
            round={shape === 'round'}
            fit="cover"
          />
        )}
        <View style={styles.rowMain}>
          <Text style={[styles.rowTitle, playing && {color: accent}]} numberOfLines={1}>
            {title}
          </Text>
          {(kept || (subtitle !== undefined && subtitle !== null && subtitle !== '')) && (
            <View style={styles.rowSubtitle}>
              {kept && <Icon name="arrow-down-circle" size={12} color={palette.textIcon} accessibilityLabel="Downloaded" testID="media-row-kept" />}
              {subtitle !== undefined && subtitle !== null && subtitle !== '' && (
                <Text style={[type.caption, styles.rowSubtitleText]} numberOfLines={1}>{formatValue(subtitle, formats.subtitle)}</Text>
              )}
            </View>
          )}
        </View>
        {meta !== undefined && meta !== null && meta !== '' && <Text style={type.caption}>{formatValue(meta, formats.meta)}</Text>}
        {opens && !quick.length && !menu.length && <Icon name="chevron-right" size={18} color={palette.text3} />}
      </>
    );
    const showMenu = menu.length ? () => setMenuOpen(true) : undefined;
    return (
      <View
        style={[
          styles.row,
          styles.mediaRow,
          (quick.length > 0 || menu.length > 0) && styles.mediaRowActions,
          handle !== undefined && styles.mediaRowHandled,
        ]}>
        {handle}
        {opens || showMenu ? (
          <Pressable
            accessibilityRole={opens ? 'button' : undefined}
            accessibilityLabel={title}
            accessibilityState={playing ? {selected: true} : undefined}
            accessibilityActions={showMenu ? [{name: 'longpress', label: 'More'}] : undefined}
            onAccessibilityAction={event => {
              if (event.nativeEvent.actionName === 'longpress') {
                showMenu?.();
              }
            }}
            onPress={opens ? () => run(block.action) : undefined}
            onLongPress={showMenu}
            delayLongPress={300}
            testID="media-row"
            style={({pressed}) => [styles.mediaRowOpen, pressed && opens && styles.pressed]}>
            {content}
          </Pressable>
        ) : (
          <View style={styles.mediaRowOpen} accessible accessibilityLabel={title} testID="media-row">
            {content}
          </View>
        )}
        {quick.map((entry, index) => (
          <QuickButton key={`quick:${index}`} entry={entry} scope={itemScope} accent={accent} onPress={() => run(entry.action)} />
        ))}
        {showMenu && (
          <Pressable
            onPress={showMenu}
            hitSlop={4}
            accessibilityRole="button"
            accessibilityLabel={title ? `More for ${title}` : 'More'}
            testID="media-row-more"
            style={({pressed}) => [styles.rowControl, pressed && styles.pressed]}>
            <Icon name="more-vertical" size={18} color={palette.text2} />
          </Pressable>
        )}
        {menuOpen && (
          <RowMenuSheet
            title={title}
            entries={menu}
            scope={itemScope}
            onRun={entry => run(entry.action)}
            onClose={() => setMenuOpen(false)}
          />
        )}
      </View>
    );
  },
  (before, after) =>
    before.block === after.block &&
    before.item === after.item &&
    before.playing === after.playing &&
    before.kept === after.kept &&
    before.keeper === after.keeper &&
    before.handle === after.handle &&
    before.context.runAction === after.context.runAction &&
    before.context.canRun === after.context.canRun &&
    before.scope.page === after.scope.page &&
    before.scope.params === after.scope.params &&
    before.scope.state === after.scope.state &&
    before.scope.sources === after.scope.sources,
);

/** A row's quick button: its icon, the accent when its style is primary (a heart that is on). */
function QuickButton({entry, scope, accent, onPress}: {entry: RowEntry; scope: Scope; accent: string; onPress: () => void}) {
  const label = asText(resolve(entry.label, scope));
  const active = entry.style === 'primary';
  return (
    <Pressable
      onPress={onPress}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{selected: active}}
      testID={active ? 'media-row-quick-on' : 'media-row-quick'}
      style={({pressed}) => [styles.rowControl, pressed && styles.pressed]}>
      <Glyph name={typeof entry.icon === 'string' ? entry.icon : 'star'} size={18} color={active ? accent : palette.text2} />
    </Pressable>
  );
}

function Row({
  icon, tone, title, subtitle, value, onPress,
}: {icon?: string; tone?: unknown; title: string; subtitle?: string; value?: string; onPress?: () => void}) {
  const {color: accent} = useAccent();
  const content = (
    <>
      {tone !== undefined && <Dot tone={tone} />}
      {icon && <Glyph name={icon} size={18} color={accent} />}
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle} numberOfLines={tone !== undefined ? 2 : 1}>
          {title}
        </Text>
        {subtitle !== undefined && (
          <Text style={type.caption} numberOfLines={tone !== undefined ? 3 : 1}>
            {subtitle}
          </Text>
        )}
      </View>
      {value !== undefined && <Text style={[type.caption, tone !== undefined && {color: DOT_COLORS[toneOf(tone)]}]}>{value}</Text>}
      {onPress && <Icon name="chevron-right" size={18} color={palette.text3} />}
    </>
  );
  if (!onPress) {
    return (
      <View style={styles.row} accessible={tone !== undefined} accessibilityLabel={[title, subtitle, value].filter(Boolean).join('. ')}>
        {content}
      </View>
    );
  }
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={title} onPress={onPress} style={({pressed}) => [styles.row, pressed && styles.pressed]}>
      {content}
    </Pressable>
  );
}

/** Whether a media-list's row menu keeps tracks on the phone (an offline entry). */
function hasOffline(block: UiBlock): boolean {
  return Array.isArray(block.menu) && block.menu.some((entry: any) => entry?.action?.offline !== undefined);
}

/** The offline action's button (change 10): its label and state are the app's - Download,
 * Downloading 3 of 12, Downloaded (pressed, it offers Remove download). A route's tracks are
 * known only once pressed, so until then it says Download. */
function OfflineButton({block, scope, context}: {block: UiBlock; scope: Scope; context: BlockContext}) {
  const [busy, setBusy] = useState(false);
  const keeper = useKeeper(context.satellite);
  const tracks = boundTracks(block.action?.offline, scope);
  const state = keeper && tracks ? offlineState(keeper, tracks) : null;
  const downloading = Boolean(state && state.downloading > 0);
  const press = async () => {
    setBusy(true);
    try {
      await context.runAction(block.action, scope);
    } finally {
      setBusy(false);
    }
  };
  return (
    <PrimaryButton
      title={offlineLabel(state)}
      variant={block.style === 'primary' ? 'primary' : 'secondary'}
      loading={busy}
      disabled={downloading}
      onPress={press}
    />
  );
}

function ButtonBlock({block, scope, context}: {block: UiBlock; scope: Scope; context: BlockContext}) {
  const [busy, setBusy] = useState(false);
  if (block.action?.offline !== undefined) {
    return context.canRun?.(block.action) ? <OfflineButton block={block} scope={scope} context={context} /> : null;
  }
  if (block.action?.own !== undefined && !context.hasOwnScreens) {
    return null; // opens native screens this app doesn't have for the Satellite
  }
  const files = block.action?.download !== undefined || block.action?.share !== undefined || block.action?.upload !== undefined;
  const opens = block.action?.section !== undefined || block.action?.sync !== undefined;
  if ((files || opens) && !context.canRun?.(block.action)) {
    return null; // files this phone can't save, share or send here, or a screen it doesn't have
  }
  const label = asText(resolve(block.label, scope));
  const danger = block.style === 'danger';
  const press = async () => {
    setBusy(true);
    try {
      await context.runAction(block.action, scope);
    } finally {
      setBusy(false);
    }
  };
  if (danger) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{disabled: busy}}
        disabled={busy}
        onPress={press}
        style={({pressed}) => [styles.danger, (pressed || busy) && styles.pressed]}>
        <Text style={styles.dangerLabel}>{label}</Text>
      </Pressable>
    );
  }
  return <PrimaryButton title={label} variant={block.style === 'primary' ? 'primary' : 'secondary'} loading={busy} onPress={press} />;
}

/** A page's actions on one line (1.2, change 11): buttons and dropdowns, wrapping where the
 * screen is narrow. A dropdown opens its panel under the row, one at a time; pressing it again
 * closes it, and so does an action inside it that succeeded. */
function ActionsBlock({block, scope, context}: {block: UiBlock; scope: Scope; context: BlockContext}) {
  const [open, setOpen] = useState<number | null>(null);
  const panelContext = useMemo<BlockContext>(
    () => ({
      ...context,
      runAction: async (action, actionScope, value, options) => {
        const done = await context.runAction(action, actionScope, value, options);
        if (done) {
          setOpen(null);
        }
        return done;
      },
    }),
    [context],
  );
  const entries = (Array.isArray(block.blocks) ? block.blocks : [])
    .map((child: UiBlock, index: number) => ({child, index}))
    .filter(({child}: {child: UiBlock}) =>
      (child?.type === 'button' || child?.type === 'dropdown') && isShown(child, scope, context));
  if (entries.length === 0) {
    return null;
  }
  const panel = entries.find(({child, index}: {child: UiBlock; index: number}) => index === open && child.type === 'dropdown');
  return (
    <View style={styles.actions}>
      <View style={styles.actionsRow}>
        {entries.map(({child, index}: {child: UiBlock; index: number}) =>
          child.type === 'dropdown' ? (
            <DropdownToggle
              key={child.id ?? `dropdown-${index}`}
              block={child}
              scope={scope}
              open={open === index}
              onPress={() => setOpen(open === index ? null : index)}
            />
          ) : (
            <ButtonBlock key={child.id ?? `button-${index}`} block={child} scope={scope} context={context} />
          ),
        )}
      </View>
      {panel && (
        <Reveal key={panel.index}>
          <Surface style={styles.dropdownPanel}>
            <UiBlocks blocks={panel.child.blocks} scope={scope} context={panelContext} />
          </Surface>
        </Reveal>
      )}
    </View>
  );
}

function DropdownToggle({block, scope, open, onPress}: {block: UiBlock; scope: Scope; open: boolean; onPress: () => void}) {
  const {color: accent, onColor} = useAccent();
  const primary = block.style === 'primary';
  const danger = block.style === 'danger';
  const color = primary ? onColor : danger ? palette.danger : palette.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{expanded: open}}
      onPress={onPress}
      style={({pressed}) => [
        styles.dropdownToggle,
        primary ? {backgroundColor: accent} : danger ? styles.dropdownDanger : null,
        open && !primary && {borderColor: accent},
        pressed && styles.pressed,
      ]}>
      <Text style={[styles.dropdownLabel, {color}]}>{asText(resolve(block.label, scope))}</Text>
      <Icon name={open ? 'chevron-up' : 'chevron-down'} size={18} color={color} />
    </Pressable>
  );
}

function ToggleBlock({block, scope, context}: {block: UiBlock; scope: Scope; context: BlockContext}) {
  const bound = Boolean(resolve(block.value, scope));
  const [value, setValue] = useState(bound);
  useEffect(() => setValue(bound), [bound]);
  const label = asText(resolve(block.label, scope));
  return (
    <View style={styles.toggle}>
      <View style={styles.rowMain}>
        <Text style={styles.label}>{label}</Text>
        {block.description !== undefined && <Text style={type.caption}>{asText(resolve(block.description, scope))}</Text>}
      </View>
      <StarSwitch
        accessibilityLabel={label}
        value={value}
        onValueChange={async next => {
          setValue(next);
          if (!(await context.runAction(block.action, scope, next))) {
            setValue(bound); // the server said no - show what's actually true
          }
        }}
      />
    </View>
  );
}

function SliderBlock({block, scope, context}: {block: UiBlock; scope: Scope; context: BlockContext}) {
  const min = Number(resolve(block.min, scope));
  const max = Number(resolve(block.max, scope));
  const step = Number(resolve(block.step, scope)) || 1;
  const bound = Number(resolve(block.value, scope));
  const value = Number.isFinite(bound) ? bound : min;
  const [shown, setShown] = useState(value);
  useEffect(() => setShown(value), [value]);
  const label = asText(resolve(block.label, scope));
  return (
    <View>
      <View style={styles.field}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.value}>{formatValue(shown, block.format, block.unit)}</Text>
      </View>
      <Slider
        accessibilityLabel={label}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={setShown}
        onDragStateChange={context.setEditing}
        onComplete={next => {
          setShown(next);
          context.runAction(block.action, scope, next);
        }}
      />
    </View>
  );
}

/** For each screen's forms: the data each form last started from, as JSON. */
const formSeeds = new WeakMap<object, Map<string, string>>();

function FormBlock({block, scope, context}: {block: UiBlock; scope: Scope; context: BlockContext}) {
  const fields: any[] = Array.isArray(block.fields) ? block.fields : [];
  const key = block.id ?? `form-${fields.map(field => field.key).join(',')}`;
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  const seeds = formSeeds.get(context.forms) ?? new Map<string, string>();
  formSeeds.set(context.forms, seeds);
  // a form starts from its data, and follows it while nothing in it was changed: the page's
  // data can arrive or come back new (after a save) once the form is drawn
  const seed = formValues(fields, scope);
  const seedText = JSON.stringify(seed);
  const known = seeds.get(key);
  const untouched = known !== undefined && JSON.stringify(context.forms[key]) === known;
  if (!context.forms[key] || (known !== seedText && untouched)) {
    context.forms[key] = seed;
    seeds.set(key, seedText);
  }
  const values: Record<string, any> = context.forms[key];
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const update = (name: string, next: any) => {
    context.forms[key] = {...context.forms[key], [name]: next};
    redraw();
  };
  const submit = async () => {
    const problem = formProblem(fields, values);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      if (await context.runAction(block.submit?.action, {...scope, form: formBody(values)})) {
        // a successful submit starts the form afresh, from its data as it comes back - also
        // when this page stays mounted behind the one the action opened
        delete context.forms[key];
        seeds.delete(key);
        redraw();
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={styles.form}>
      {fields.map(field =>
        field.kind === 'rows' ? (
          <RowsField key={field.key} field={field} rows={values[field.key]} onChange={next => update(field.key, next)} context={context} />
        ) : (
          <FormField key={field.key} field={field} value={values[field.key]} onChange={next => update(field.key, next)} context={context} />
        ),
      )}
      {error && <Text style={styles.error}>{error}</Text>}
      <PrimaryButton title={asText(resolve(block.submit?.label, scope)) || 'Submit'} loading={busy} onPress={submit} />
    </View>
  );
}

/** A rows field (1.2): a list the person adds rows to and removes them from, each row the same few
 * inputs, sent as a list of objects under the field's key. */
function RowsField({field, rows, onChange, context}: {field: any; rows: any; onChange: (rows: any[]) => void; context: BlockContext}) {
  const list: Record<string, any>[] = Array.isArray(rows) ? rows : [];
  const inputs: any[] = Array.isArray(field.fields) ? field.fields : [];
  const label = asText(field.label);
  const setRow = (index: number, key: string, next: any) =>
    onChange(list.map((row, at) => (at === index ? {...row, [key]: next} : row)));
  return (
    <View style={styles.inputField} accessibilityLabel={label}>
      <Text style={styles.label}>{`${label}${field.required ? ' *' : ''}`}</Text>
      {list.length === 0 && <Text style={styles.rowsEmpty}>None yet.</Text>}
      {list.map((row, index) => (
        <View key={index} style={styles.rowsRow} testID={`rows-${field.key}-${index}`}>
          {inputs.map(input => (
            <FormField key={input.key} field={input} value={row[input.key]} onChange={next => setRow(index, input.key, next)} context={context} />
          ))}
          <Pressable
            onPress={() => onChange(list.filter((_, at) => at !== index))}
            accessibilityRole="button"
            accessibilityLabel={`Remove row ${index + 1}`}
            style={({pressed}) => [styles.pill, pressed && styles.pressed]}>
            <Icon name="x" size={15} color={palette.text} />
            <Text style={styles.rowsPillLabel}>Remove</Text>
          </Pressable>
        </View>
      ))}
      <Pressable
        onPress={() => onChange([...list, emptyRow(inputs)])}
        accessibilityRole="button"
        accessibilityLabel={field.add !== undefined ? asText(field.add) : `Add to ${label}`}
        style={({pressed}) => [styles.pill, pressed && styles.pressed]}>
        <Icon name="plus" size={15} color={palette.text} />
        <Text style={styles.rowsPillLabel}>{field.add !== undefined ? asText(field.add) : 'Add'}</Text>
      </Pressable>
    </View>
  );
}

/** A select's options as pills; the accent slides to the one picked (useSlidingSelection). */
function SelectField({field, label, value, onChange}: {field: any; label: string; value: any; onChange: (value: any) => void}) {
  const {onColor} = useAccent();
  const options: any[] = field.options ?? [];
  const {indicator, onItemLayout, selectedBackground} = useSlidingSelection(options.findIndex(option => option.value === value), {
    track: palette.control,
  });
  return (
    <View style={styles.inputField}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.options}>
        {indicator}
        {options.map((option: any, index: number) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={String(option.value)}
              accessibilityRole="radio"
              accessibilityState={{selected}}
              onPress={() => onChange(option.value)}
              onLayout={onItemLayout(index)}
              style={[styles.option, selectedBackground(selected, index)]}>
              <Text style={[styles.optionLabel, selected && {color: onColor}]}>{asText(option.label)}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function FormField({field, value, onChange, context}: {field: any; value: any; onChange: (value: any) => void; context: BlockContext}) {
  const label = `${asText(field.label)}${field.required ? ' *' : ''}`;
  if (field.kind === 'toggle') {
    return (
      <View style={styles.toggle}>
        <Text style={[styles.label, styles.rowMain]}>{label}</Text>
        <StarSwitch accessibilityLabel={asText(field.label)} value={Boolean(value)} onValueChange={onChange} />
      </View>
    );
  }
  if (field.kind === 'select') {
    return <SelectField field={field} label={label} value={value} onChange={onChange} />;
  }
  const numeric = field.kind === 'number';
  return (
    <View style={styles.inputField}>
      <Text style={styles.label}>{label}</Text>
      <StarInput
        accessibilityLabel={asText(field.label)}
        style={styles.input}
        value={value === null || value === undefined ? '' : String(value)}
        placeholder={field.placeholder !== undefined ? asText(field.placeholder) : undefined}
        placeholderTextColor={palette.text3}
        keyboardType={numeric ? 'numeric' : 'default'}
        onFocus={() => context.setEditing(true)}
        onBlur={() => context.setEditing(false)}
        onChangeText={text => onChange(numeric ? (text.trim() === '' || Number.isNaN(Number(text)) ? text : Number(text)) : text)}
      />
    </View>
  );
}

/** A shared block bound to the files.browse capability - it browses through
 * whichever Satellite the catalog says provides it, never a named one. */
function FileBrowserBlock({block, scope, context}: {block: UiBlock; scope: Scope; context: BlockContext}) {
  const provider = findProvider(context.providers, block.capability);
  const route = provider?.operations?.list;
  const select = block.select ?? 'none';
  const [listing, setListing] = useState<{path: string; parent: string | null; entries: any[]} | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = async (path: string) => {
    if (!provider || !isSafeRoute(route)) {
      return;
    }
    setError(null);
    try {
      const body = await context.readCapability(provider.satellite, `${route}?path=${encodeURIComponent(path)}`);
      setListing({path: body?.path ?? '', parent: body?.parent ?? null, entries: Array.isArray(body?.entries) ? body.entries : []});
    } catch (err: any) {
      setError(err?.message || 'Could not open that folder.');
    }
  };

  useEffect(() => {
    open('');
    // only when the provider changes - `open` itself is recreated every render
  }, [provider?.satellite, route]);

  if (!provider || !isSafeRoute(route)) {
    return <Text style={styles.unsupported}>No enabled Satellite provides {String(block.capability)}, so there is nothing to browse yet.</Text>;
  }
  const join = (base: string, name: string) => {
    const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/';
    return base.endsWith(separator) ? `${base}${name}` : `${base}${separator}${name}`;
  };
  return (
    <View style={styles.form}>
      <View style={styles.toggle}>
        <Text style={[styles.mono, styles.rowMain]} numberOfLines={1}>
          {listing?.path || 'Locations'}
        </Text>
        <PrimaryButton title="Up" variant="secondary" disabled={!listing?.path} onPress={() => open(listing?.parent ?? '')} />
      </View>
      {error && <Text style={styles.error}>{error}</Text>}
      {listing === null && !error && <Text style={type.caption}>Loading…</Text>}
      {listing && listing.entries.length === 0 && <Text style={type.caption}>This folder is empty.</Text>}
      <View style={styles.list}>
        {(listing?.entries ?? []).map(entry => {
          const isDir = entry.type === 'dir';
          // at the roots an entry's name is already an absolute path
          const target = listing!.path === '' ? entry.name : join(listing!.path, entry.name);
          const pick = isDir ? () => open(target) : select === 'file' && block.action ? () => context.runAction(block.action, scope, target) : undefined;
          return (
            <Row
              key={entry.name}
              icon={isDir ? 'folder' : 'file'}
              title={String(entry.name)}
              value={!isDir && typeof entry.size === 'number' ? formatValue(entry.size, 'bytes') : undefined}
              onPress={pick}
            />
          );
        })}
      </View>
      {select === 'directory' && block.action && (
        <PrimaryButton
          title={asText(resolve(block.label, scope)) || 'Choose'}
          disabled={!listing?.path}
          onPress={() => context.runAction(block.action, scope, listing?.path)}
        />
      )}
    </View>
  );
}

/** How a chart's axis rounds, from the format its values are shown in. */
function chartScale(format: unknown): ChartScale {
  return format === 'percent' ? 'percent' : format === 'bitrate' ? 'bits' : format === 'bytes' || format === 'byterate' ? 'bytes' : 'plain';
}

function ChartBlock({block, scope, context}: {block: UiBlock; scope: Scope; context: BlockContext}) {
  const {color: accent} = useAccent();
  const colors = [accent, palette.chart2, palette.text3, palette.textIcon];
  const series = (Array.isArray(block.series) ? block.series : []).map((line: any, index: number) => {
    const points = resolve(line?.points, scope);
    return {
      key: `s${index}`,
      label: asText(resolve(line?.label, scope)),
      color: colors[index % colors.length],
      points: Array.isArray(points) ? points.filter((point: any) => Array.isArray(point) && typeof point[1] === 'number') : [],
    };
  });
  const times = series.flatMap(line => line.points.map((point: number[]) => point[0]));
  const now = Date.now() / 1000;
  const to = Number(resolve(block.to, scope)) || (times.length ? Math.max(...times) : now);
  const from = Number(resolve(block.from, scope)) || (times.length ? Math.min(...times) : to - 3600);
  const span = Math.max(1, to - from);
  const resolution = Number(resolve(block.resolution, scope)) || Math.max(1, span / Math.max(1, times.length));
  const max = resolve(block.max, scope);
  const empty = block.empty !== undefined ? asText(resolve(block.empty, scope)) : '';
  return (
    <Surface style={styles.card}>
      <ColumnChart
        title={asText(resolve(block.title, scope))}
        series={series}
        from={from}
        to={to}
        resolution={resolution}
        scale={chartScale(block.format)}
        max={typeof max === 'number' && max > 0 ? max : null}
        format={value => formatValue(value, block.format, block.unit)}
        timeLabel={time => (span <= 2 * 86400 ? formatValue(time, 'time') : formatValue(time, 'date').replace(/ \d{4}$/, ''))}
        dimmed={context.refreshing}
        empty={empty || 'Nothing recorded yet'}
      />
    </Surface>
  );
}

function BarsBlock({block, scope}: {block: UiBlock; scope: Scope}) {
  const {color: accent} = useAccent();
  const line = Array.isArray(block.series) ? block.series[0] : null;
  const points = resolve(line?.points, scope);
  const values = Array.isArray(points) ? points.map(pointValue).filter((value): value is number => value !== null) : [];
  const title = asText(resolve(block.title, scope));
  const max = Number(resolve(block.max, scope)) || Math.max(1, ...values);
  return (
    <View style={styles.bars}>
      {title ? <Text style={[type.eyebrow, styles.eyebrow]}>{title.toUpperCase()}</Text> : null}
      <Bars
        values={values}
        color={accent}
        max={max}
        label={`${title}: ${values.map(value => formatValue(value, block.format, block.unit)).join(', ')}`}
      />
    </View>
  );
}

/** A table on a phone: each row a small card - its first column as the
 * title, the others as labelled values beneath. */
function TableBlock({block, scope}: {block: UiBlock; scope: Scope}) {
  const rows = Array.isArray(block.rows) ? block.rows : resolve(block.rows, scope);
  const columns: any[] = Array.isArray(block.columns) ? block.columns : [];
  if (!Array.isArray(rows) || rows.length === 0) {
    return <Text style={type.caption}>{block.empty !== undefined ? asText(resolve(block.empty, scope)) : 'Nothing to show.'}</Text>;
  }
  const [first, ...rest] = columns;
  return (
    <View style={styles.list}>
      {rows.map((row: any, index: number) => {
        const rowScope = {...scope, data: row};
        return (
          <View key={index} style={styles.tableRow} accessible testID="ui-table-row">
            {first && <Cell column={first} scope={rowScope} title />}
            <View style={styles.tableFacts}>
              {rest.map((column, at) => (
                <View key={at} style={styles.tableFact}>
                  <Text style={styles.tableLabel}>{asText(column.label).toUpperCase()}</Text>
                  <Cell column={column} scope={rowScope} />
                </View>
              ))}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function Cell({column, scope, title}: {column: any; scope: Scope; title?: boolean}) {
  const value = resolve(column.value, scope);
  const unit = column.unit !== undefined ? asText(resolve(column.unit, scope)) : undefined;
  const shown = formatValue(value, column.format, unit);
  const tone = column.tone !== undefined ? resolve(column.tone, scope) : undefined;
  const max = resolve(column.max, scope);
  const text = <Text style={title ? styles.rowTitle : styles.cellText}>{shown}</Text>;
  if (typeof max === 'number' && max > 0 && typeof value === 'number') {
    return (
      <View style={styles.cellUsage}>
        <View style={styles.cellMeter}>
          <Meter value={(value / max) * 100} level={METER_LEVELS[toneOf(tone)]} label={asText(column.label)} />
        </View>
        {text}
      </View>
    );
  }
  if (tone !== undefined) {
    return (
      <View style={styles.cellState}>
        <Dot tone={tone} />
        {text}
      </View>
    );
  }
  return text;
}

/** A search field (1.2): it sets the page state `key` a moment after the person stops typing,
 * and routes templated with $state.<key> load the results, as for a choice. */
const SEARCH_PAUSE = 300;

function SearchBlock({block, scope, context}: {block: UiBlock; scope: Scope; context: BlockContext}) {
  const {color: accent} = useAccent();
  const inputAccent = useInputAccent();
  const current = context.pageState?.[block.key];
  const [text, setText] = useState(typeof current === 'string' ? current : '');
  const [focused, setFocused] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const {setPageState} = context;
  const commit = (value: string) => {
    if (timer.current) {
      clearTimeout(timer.current);
    }
    setPageState?.(block.key, value.trim());
  };
  useEffect(() => () => {
    if (timer.current) {
      clearTimeout(timer.current);
    }
  }, []);
  const label = block.label !== undefined ? asText(resolve(block.label, scope)) : '';
  const placeholder = block.placeholder !== undefined ? asText(resolve(block.placeholder, scope)) : label || 'Search';
  return (
    <View style={[styles.search, focused && {borderColor: accent}]}>
      <Icon name="search" size={18} color={focused ? accent : palette.text3} />
      <TextInput
        {...inputAccent}
        value={text}
        onChangeText={value => {
          setText(value);
          if (timer.current) {
            clearTimeout(timer.current);
          }
          timer.current = setTimeout(() => commit(value), SEARCH_PAUSE);
        }}
        onSubmitEditing={() => commit(text)}
        onFocus={() => {
          setFocused(true);
          context.setEditing(true);
        }}
        onBlur={() => {
          setFocused(false);
          context.setEditing(false);
        }}
        placeholder={placeholder}
        placeholderTextColor={palette.text3}
        accessibilityLabel={label || placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        style={styles.searchInput}
        testID={`ui-search-${block.key}`}
      />
    </View>
  );
}

function ChoiceBlock({block, scope, context}: {block: UiBlock; scope: Scope; context: BlockContext}) {
  const {onColor} = useAccent();
  const current = context.pageState?.[block.key];
  const options: any[] = Array.isArray(block.options) ? block.options : [];
  // the accent slides to the segment picked; the page may draw the row again for the new choice,
  // so it remembers where it was
  const {indicator, onItemLayout, selectedBackground} = useSlidingSelection(
    options.findIndex(option => option.value === current),
    {radius: radii.control - 3, remember: `choice:${block.key}`},
  );
  const label = block.label !== undefined ? asText(resolve(block.label, scope)) : '';
  return (
    // Like the web's segmented control: the segments share the width when they fit, and the
    // row scrolls sideways when they don't, instead of shrinking their labels.
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.segmentsFrame}
      contentContainerStyle={styles.segments}
      accessibilityRole="radiogroup"
      accessibilityLabel={label || undefined}>
      {indicator}
      {options.map((option: any, index: number) => {
        const selected = option.value === current;
        const text = asText(resolve(option.label, scope));
        return (
          <Pressable
            key={String(option.value)}
            onPress={() => context.setPageState?.(block.key, option.value)}
            accessibilityRole="radio"
            accessibilityState={{selected}}
            accessibilityLabel={text}
            testID={`ui-choice-${String(option.value)}`}
            onLayout={onItemLayout(index)}
            style={[styles.segment, selectedBackground(selected)]}>
            <Text numberOfLines={1} style={[styles.segmentLabel, selected && {color: onColor, fontWeight: '700'}]}>
              {text}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function StatusBlock({block, scope}: {block: UiBlock; scope: Scope}) {
  const tone = resolve(block.tone, scope);
  const label = asText(resolve(block.label, scope));
  const detail = block.detail !== undefined ? asText(resolve(block.detail, scope)) : '';
  return (
    <View style={styles.pill} accessible accessibilityLabel={`${label}${detail ? `, ${detail}` : ''}`}>
      <Dot tone={tone} />
      <Text style={type.label}>{label}</Text>
      {detail ? <Text style={type.caption}>{detail}</Text> : null}
    </View>
  );
}

function CodeBlock({block, scope}: {block: UiBlock; scope: Scope}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const value = resolve(block.value, scope);
  const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
  const label = block.label !== undefined ? asText(resolve(block.label, scope)) : 'Details';
  return (
    <View style={styles.form}>
      <Pressable
        onPress={() => setOpen(current => !current)}
        accessibilityRole="button"
        accessibilityState={{expanded: open}}
        style={({pressed}) => [styles.codeToggle, pressed && styles.pressed]}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={16} color={palette.text2} />
        <Text style={type.caption}>{label}</Text>
      </Pressable>
      {open && (
        <>
          <Text style={[styles.mono, styles.code]} selectable>
            {content}
          </Text>
          {block.copy && (
            <PrimaryButton
              title={copied ? 'Copied' : 'Copy'}
              variant="secondary"
              onPress={() => {
                Clipboard.setString(content);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            />
          )}
        </>
      )}
    </View>
  );
}

/** Asks before an action that says to - resolves false when cancelled. `detail`, when given, is
 * shown beneath `message`. */
export function confirmAction(message: string, label = 'Continue', detail?: string): Promise<boolean> {
  return new Promise(done => {
    Alert.alert(message, detail, [
      {text: 'Cancel', style: 'cancel', onPress: () => done(false)},
      {text: label, onPress: () => done(true)},
    ], {cancelable: true, onDismiss: () => done(false)});
  });
}

const styles = StyleSheet.create({
  body: {...type.body, color: palette.text},
  mono: {fontFamily: 'monospace', fontSize: 12, color: palette.text2},
  label: {...type.caption, color: palette.text2},
  value: {...type.label, fontWeight: '600', flexShrink: 1, textAlign: 'right'},
  fieldValue: {flexShrink: 1, alignItems: 'flex-end', gap: 2},
  detail: {...type.caption, color: palette.text3, textAlign: 'right'},
  eyebrow: {marginTop: space.xs},
  metricValue: {...type.title, fontSize: 20},
  field: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: space.md},
  metric: {gap: space.sm},
  tiles: {flexDirection: 'row', flexWrap: 'wrap', gap: space.md},
  tile: {
    flexGrow: 1,
    flexBasis: '45%',
    minWidth: 140,
    padding: space.lg,
    borderRadius: radii.card,
    backgroundColor: palette.card,
    gap: space.xs,
  },
  tileLabel: {fontSize: 10, letterSpacing: 1.6},
  compactRow: {flexDirection: 'row', gap: space.lg},
  compact: {flex: 1, gap: space.xs},
  compactValue: {...type.title, fontSize: 20},
  widgetList: {gap: space.sm},
  widgetRow: {flexDirection: 'row', alignItems: 'center', gap: space.sm},
  widgetText: {flex: 1},
  more: {color: palette.text3},
  tileValue: {...type.title, fontSize: 24, lineHeight: 30},
  card: {gap: space.md},
  list: {gap: 2},
  listFoot: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: space.md, paddingVertical: space.md},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 52,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radii.control,
    backgroundColor: palette.control,
  },
  rowMain: {flex: 1, minWidth: 0, gap: 2},
  rowSubtitle: {flexDirection: 'row', alignItems: 'center', gap: 4, minWidth: 0},
  rowSubtitleText: {flexShrink: 1},
  mediaRow: {minHeight: 64},
  mediaRowActions: {paddingRight: space.xs, gap: 0},
  mediaRowOpen: {flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: space.md, alignSelf: 'stretch'},
  rowControl: {width: 40, minHeight: TOUCH_TARGET, alignItems: 'center', justifyContent: 'center', borderRadius: 9999},
  // a reorderable list (change 8): the handle first, the held row raised above the others
  mediaRowHandled: {paddingLeft: 0, gap: space.sm},
  rowHandle: {width: 36, minHeight: TOUCH_TARGET, alignItems: 'center', justifyContent: 'center'},
  reorderHeld: {zIndex: 2, elevation: 6, borderRadius: radii.control, backgroundColor: palette.controlStrong},
  mediaGroup: {...type.label, fontWeight: '600', paddingTop: space.md, paddingBottom: space.xs, paddingHorizontal: space.xs},
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 48,
    paddingHorizontal: space.lg,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'transparent',
    backgroundColor: palette.control,
  },
  searchInput: {flex: 1, color: palette.text, fontSize: 15, paddingVertical: space.sm},
  mediaFrame: {
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.control,
    backgroundColor: palette.controlStrong,
  },
  image: {gap: space.sm},
  rowTitle: {...type.label, fontWeight: '600'},
  pressed: {opacity: 0.8},
  toggle: {flexDirection: 'row', alignItems: 'center', gap: space.md},
  danger: {
    minHeight: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    backgroundColor: 'rgba(238, 68, 75, 0.14)',
  },
  dangerLabel: {fontSize: 16, fontWeight: '700', color: palette.danger},
  actions: {gap: space.md},
  actionsRow: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: space.sm},
  dropdownToggle: {
    minHeight: 48,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: 'transparent',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    paddingHorizontal: space.lg,
    backgroundColor: palette.controlStrong,
  },
  dropdownDanger: {backgroundColor: 'rgba(238, 68, 75, 0.14)'},
  dropdownLabel: {fontSize: 16, fontWeight: '700'},
  dropdownPanel: {gap: space.md},
  form: {gap: space.md},
  inputField: {gap: space.xs},
  input: {
    minHeight: 46,
    paddingHorizontal: space.md,
    borderRadius: radii.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.line,
    backgroundColor: palette.field,
    color: palette.text,
    fontSize: 15,
  },
  options: {flexDirection: 'row', flexWrap: 'wrap', gap: space.sm},
  option: {paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: 999, backgroundColor: palette.control},
  optionLabel: {...type.caption, color: palette.text, fontWeight: '600'},
  error: {color: palette.danger, fontSize: 13},
  rowsEmpty: {...type.caption, color: palette.text3},
  rowsRow: {
    gap: space.sm,
    padding: space.md,
    borderRadius: radii.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.line,
  },
  rowsPillLabel: {...type.caption, color: palette.text, fontWeight: '600'},
  unsupported: {...type.caption, padding: space.md, borderRadius: radii.control, backgroundColor: palette.control},
  bars: {gap: space.sm},
  tableRow: {padding: space.md, borderRadius: radii.control, backgroundColor: palette.control, gap: space.sm},
  tableFacts: {flexDirection: 'row', flexWrap: 'wrap', columnGap: space.lg, rowGap: space.sm},
  tableFact: {minWidth: 88, gap: 2},
  tableLabel: {fontSize: 10, letterSpacing: 1.2, fontWeight: '600', color: palette.text3},
  cellText: {...type.caption, color: palette.text},
  cellState: {flexDirection: 'row', alignItems: 'center', gap: space.sm},
  cellUsage: {flexDirection: 'row', alignItems: 'center', gap: space.sm, minWidth: 140},
  cellMeter: {flex: 1},
  segmentsFrame: {flexGrow: 0, backgroundColor: palette.card, borderRadius: radii.control},
  segments: {flexGrow: 1, flexDirection: 'row', padding: 3, gap: 3},
  segment: {flexGrow: 1, minHeight: TOUCH_TARGET, paddingHorizontal: space.md, borderRadius: radii.control - 3, alignItems: 'center', justifyContent: 'center'},
  segmentLabel: {...type.caption, color: palette.text2},
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    alignSelf: 'flex-start',
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 2,
    borderRadius: 999,
    backgroundColor: palette.control,
  },
  crumbs: {flexDirection: 'row', alignItems: 'center', gap: 2},
  crumb: {minHeight: TOUCH_TARGET - 8, justifyContent: 'center', paddingHorizontal: space.md, borderRadius: 999},
  crumbHere: {backgroundColor: palette.card},
  crumbLabel: {...type.caption, color: palette.text2},
  codeToggle: {flexDirection: 'row', alignItems: 'center', gap: space.xs, minHeight: TOUCH_TARGET},
  code: {padding: space.md, borderRadius: radii.control, backgroundColor: palette.field},
});
