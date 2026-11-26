import {isVisible, resolve, type Scope, type UiAction, type UiBlock} from './contract';

/**
 * A row's own actions (UI contract 1.2): a media-list row's or a media-grid tile's `quick`
 * buttons and `menu`, and the answer an action merges into its row (`then: "update"`). The same
 * rules as Mission Control's (mission_control/ui/rows.js); pure, so __tests__/uiRows.test.ts
 * checks it without a screen.
 */
export interface RowEntry {
  label: unknown;
  icon?: string;
  style?: string;
  visible?: unknown;
  action: UiAction;
}

/** Whether this app can run an action at all: an own action only with the Satellite's own
 * screens, and the rest as the screen decides (files, sections, secure actions, syncs). */
export function runsHere(
  action: UiAction | undefined,
  context: {hasOwnScreens?: boolean; canRun?: (action: UiAction | undefined) => boolean},
): boolean {
  if (!action) {
    return false;
  }
  if (action.own !== undefined && !context.hasOwnScreens) {
    return false;
  }
  if (context.canRun) {
    return context.canRun(action);
  }
  const needs = action.secure || ['download', 'share', 'upload', 'section', 'sync', 'offline'].some(key => (action as any)[key] !== undefined);
  return !needs;
}

function shown(entry: any, scope: Scope, canRun?: (action: UiAction) => boolean): entry is RowEntry {
  return Boolean(entry && entry.action)
    && (entry.visible === undefined || isVisible(resolve(entry.visible, scope)))
    && (!canRun || canRun(entry.action));
}

/** A row's quick buttons: every entry whose `visible` holds and that this app can run, so a pair
 * bound to opposite values (`$.liked`, `$.not_liked`) draws as one toggle. */
export function rowQuick(block: UiBlock, scope: Scope, canRun?: (action: UiAction) => boolean): RowEntry[] {
  return (Array.isArray(block.quick) ? block.quick : []).filter((entry: any) => shown(entry, scope, canRun));
}

/** A row's menu: the entries whose `visible` holds and that this app can run - a menu leaves out
 * what can't be done here rather than offering it and failing. Empty: no menu. */
export function rowMenu(block: UiBlock, scope: Scope, canRun?: (action: UiAction) => boolean): RowEntry[] {
  return (Array.isArray(block.menu) ? block.menu : []).filter((entry: any) => shown(entry, scope, canRun));
}

/** `then: "update"`: the answer's `item` (an object) merged into the row, in place, so the row
 * keeps its key and its place in the list. True when something was merged. */
export function mergeItem(row: unknown, answer: unknown): boolean {
  const item = answer && typeof answer === 'object' ? (answer as any).item : null;
  if (!row || typeof row !== 'object' || !item || typeof item !== 'object' || Array.isArray(item)) {
    return false;
  }
  Object.assign(row, item);
  return true;
}

/** The group a row starts (`item.group`), as text; '' for none. */
export function groupOf(block: UiBlock, scope: Scope, format: (value: unknown) => string = value => String(value)): string {
  if (!block.item || block.item.group === undefined) {
    return '';
  }
  const raw = resolve(block.item.group, scope);
  return raw === null || raw === undefined || raw === '' ? '' : format(raw);
}

/** Whether a row is the track playing now: its `item.audio` binding against the host's current
 * track id (null when nothing plays, or it plays from another Satellite). */
/** Whether a row with `item.audio` is one of the tracks kept on this phone (change 10). */
export function isKeptRow(block: UiBlock, scope: Scope, keeper: {isDownloaded(id: string): boolean} | null | undefined): boolean {
  if (!keeper || !block.item || block.item.audio === undefined) {
    return false;
  }
  const id = resolve(block.item.audio, scope);
  return id !== null && id !== undefined && id !== '' && keeper.isDownloaded(String(id));
}

export function isPlayingRow(block: UiBlock, scope: Scope, playing: string | null | undefined): boolean {
  if (!playing || !block.item || block.item.audio === undefined) {
    return false;
  }
  const id = resolve(block.item.audio, scope);
  return id !== null && id !== undefined && String(id) === String(playing);
}
