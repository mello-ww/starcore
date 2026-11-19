import React, {useCallback, useEffect, useRef, useState} from 'react';
import {FlatList, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent} from 'react-native';
import {tokens} from '../../theme';
import {
  isShown, ListFooter, ListRow, MediaGroupHeading, mediaGroup, MediaRow, mediaRowKeys, UiBlocks, type BlockContext,
} from './UiBlocks';
import {createListPaging, type ListPaging} from './listPaging';
import {resolve, type Scope, type UiBlock} from './contract';
import {usePlayingId} from './RowMenu';
import {isPlayingRow} from './rows';

const {space, type} = tokens;

/** What a list page is drawn as, one entry per line: a block of the page, a row of one of its
 * lists, a media-list group's heading, a list's empty text, or the footer of a list that loads
 * further pages. `gap` is the space above it. */
export type PageEntry =
  | {kind: 'block'; key: string; block: UiBlock; gap: number}
  | {kind: 'row'; key: string; block: UiBlock; item: any; gap: number}
  | {kind: 'group'; key: string; block: UiBlock; label: string; gap: number}
  | {kind: 'empty'; key: string; block: UiBlock; gap: number}
  | {kind: 'foot'; key: string; block: UiBlock; gap: number};

/** The blocks a list page draws row by row: a list and a media-list (1.2). */
const isRowList = (block: UiBlock | undefined) => block?.type === 'list' || block?.type === 'media-list';

/** Whether a page's own blocks include a list that loads further pages (1.2 `more`). */
export function hasPagedList(blocks: UiBlock[] | undefined, scope: Scope, context: BlockContext): boolean {
  return (blocks ?? []).some(block => isRowList(block) && Boolean(block.more) && isShown(block, scope, context));
}

/** The page's shown blocks as one sequence: each list's rows one by one, everything else whole.
 * Rows of a list sit close together; blocks are spaced as on any page. */
export function pageEntries(blocks: UiBlock[] | undefined, scope: Scope, context: BlockContext, paging: ListPaging): PageEntry[] {
  const entries: PageEntry[] = [];
  const add = (entry: PageEntry) => {
    entries.push(entries.length ? entry : {...entry, gap: 0});
  };
  (blocks ?? []).forEach((block, index) => {
    if (!isShown(block, scope, context)) {
      return;
    }
    const key = block.id ?? `${block.type}-${index}`;
    if (!isRowList(block)) {
      add({kind: 'block', key, block, gap: space.md});
      return;
    }
    const rows = paging.rows(block, scope);
    const status = block.more ? paging.status(block) : null;
    if (!rows.length && !status?.more && !status?.error) {
      add({kind: 'empty', key, block, gap: space.md});
      return;
    }
    if (block.type === 'media-list') {
      // a media-list's rows keep their key (`item.key`) as pages arrive; a group's heading sits
      // above its first row
      const keys = mediaRowKeys(block, rows, scope);
      let label = '';
      rows.forEach((item, row) => {
        const group = mediaGroup(block, {...scope, data: item});
        if (group !== '' && group !== label) {
          add({kind: 'group', key: `${key}:group:${row}`, block, label: group, gap: row ? space.sm : space.md});
          label = group;
          add({kind: 'row', key: `${key}:${keys[row]}`, block, item, gap: 0});
          return;
        }
        add({kind: 'row', key: `${key}:${keys[row]}`, block, item, gap: row ? 2 : space.md});
      });
    } else {
      rows.forEach((item, row) => add({kind: 'row', key: `${key}:${row}`, block, item, gap: row ? 2 : space.md}));
    }
    if (status && (status.more || status.error)) {
      add({kind: 'foot', key: `${key}:more`, block, gap: 2});
    }
  });
  return entries;
}

/** A paged list's footer. It is mounted only near the screen (the page is virtualized), so
 * being mounted is the list's cue to load its next page - again each time one arrives while it
 * still is, until there is none or one failed ("Try again"). */
function NearFooter({block, scope, paging, next}: {block: UiBlock; scope: Scope; paging: ListPaging; next: (block: UiBlock) => void}) {
  const status = paging.status(block);
  const {more, loading, error} = status;
  useEffect(() => {
    if (more && !loading && !error) {
      next(block);
    }
  }, [more, loading, error, block, next]);
  return <ListFooter status={status} scope={scope} onMore={() => next(block)} />;
}

/**
 * A page whose own blocks include a list that loads further pages (1.2 `more`), drawn as one
 * virtualized list: its blocks, and the rows of each of its lists one by one, so only the lines
 * near the screen are mounted however many rows have loaded. Each paged list loads its next
 * page as its own end nears the screen. What the screen shows above the page comes in as
 * `header`, below it as `footer`.
 */
export function VirtualListPage({
  blocks, scope, context, header, footer, refreshControl, contentContainerStyle, onScroll, dim,
}: {
  blocks: UiBlock[] | undefined;
  scope: Scope;
  context: BlockContext;
  header?: React.ReactElement | null;
  footer?: React.ReactElement | null;
  refreshControl?: React.ReactElement<any>;
  contentContainerStyle?: any;
  onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  /** What is shown is from earlier (offline, not refreshed). */
  dim?: boolean;
}) {
  const paging = useRef(createListPaging({load: context.load})).current;
  const [, setVersion] = useState(0);
  const next = useCallback(
    (block: UiBlock) => {
      const now = paging.status(block);
      if (!now.more || now.loading) {
        return;
      }
      paging.loadMore(block).then(() => setVersion(version => version + 1));
      setVersion(version => version + 1);
    },
    [paging],
  );
  const entries = pageEntries(blocks, scope, context, paging);
  // the row the audio host plays, when a media-list here marks it (`item.audio`, 1.2)
  const marks = (blocks ?? []).some(block => block?.type === 'media-list' && block.item?.audio !== undefined);
  const playing = usePlayingId(context.satellite, marks);
  // after a refresh of the same page: each list back to as many pages as it had
  const restoring = (blocks ?? []).filter(block => {
    if (!isRowList(block) || !block.more) {
      return false;
    }
    const status = paging.status(block);
    return status.restoring && !status.loading && !status.error;
  });
  useEffect(() => {
    restoring.forEach(next);
  });

  const renderItem = ({item: entry}: {item: PageEntry}) => {
    let content: React.ReactNode;
    if (entry.kind === 'row' && entry.block.type === 'media-list') {
      content = (
        <MediaRow
          block={entry.block}
          item={entry.item}
          scope={scope}
          context={context}
          playing={isPlayingRow(entry.block, {...scope, data: entry.item}, playing)}
        />
      );
    } else if (entry.kind === 'row') {
      content = <ListRow block={entry.block} item={entry.item} scope={scope} context={context} />;
    } else if (entry.kind === 'group') {
      content = <MediaGroupHeading label={entry.label} />;
    } else if (entry.kind === 'foot') {
      content = <NearFooter block={entry.block} scope={scope} paging={paging} next={next} />;
    } else if (entry.kind === 'empty') {
      const empty = entry.block.empty !== undefined ? resolve(entry.block.empty, scope) : undefined;
      content = <Text style={type.caption}>{empty === undefined || empty === null ? 'Nothing here.' : String(empty)}</Text>;
    } else {
      content = <UiBlocks blocks={[entry.block]} scope={scope} context={context} />;
    }
    return <View style={[{marginTop: entry.gap}, dim && styles.dim]}>{content}</View>;
  };
  return (
    <FlatList
      testID="ui-list-page"
      data={entries}
      extraData={playing}
      keyExtractor={entry => entry.key}
      renderItem={renderItem}
      initialNumToRender={16}
      maxToRenderPerBatch={12}
      updateCellsBatchingPeriod={40}
      windowSize={11}
      removeClippedSubviews
      keyboardShouldPersistTaps="handled"
      scrollEventThrottle={100}
      onScroll={onScroll}
      refreshControl={refreshControl}
      contentContainerStyle={contentContainerStyle}
      ListHeaderComponent={header}
      ListFooterComponent={footer}
    />
  );
}

const styles = StyleSheet.create({
  dim: {opacity: 0.6},
});
