// The choose action (UI contract 1.2, change 8): the person picks one row from a list the
// Satellite's own route answers - or names a new one - and the action's route then gets that row
// as $value; a 409 from it asks `conflict.confirm` before sending again. The same flow as Mission
// Control's mission_control/ui/choose.js, kept free of the screen so it can be tested.

import {isSafeRoute, resolve, resolveTemplate, type Json, type Scope, type UiAction} from './contract';

export interface ChooseRow {
  row: Record<string, unknown>;
  title: string;
  subtitle: string;
  /** the route of its picture, beneath the Satellite, or null */
  image: string | null;
}

export interface ChooseOffer {
  title: string;
  empty: string;
  rows: ChooseRow[];
  create: {label: string; field: string} | null;
}

export type ChooseAnswer = {row: Record<string, unknown>} | {create: string} | null;

export interface ChooseDeps {
  load: (route: string) => Promise<any>;
  choose: (offer: ChooseOffer) => Promise<ChooseAnswer>;
  /** the POST's answer, or throws with `status` (an ApiError) */
  request: (route: string, body: any) => Promise<any>;
  confirm: (text: string) => Promise<boolean>;
}

const shown = (value: unknown) => (value === null || value === undefined ? '' : String(value));

function refused(): Error {
  return new Error('That action points outside its Satellite and was refused.');
}

/** The rows a choose action offers from its source's answer; inside `item`, `$.` is the row. */
export function chooseRows(spec: NonNullable<UiAction['choose']>, answer: unknown, scope: Scope): ChooseRow[] {
  const rows = resolve(spec.items, {...scope, data: (answer ?? {}) as Json});
  return (Array.isArray(rows) ? rows : [])
    .filter((row): row is {[key: string]: Json} => Boolean(row) && typeof row === 'object' && !Array.isArray(row))
    .map(row => {
      const item = spec.item ?? ({} as any);
      const rowScope: Scope = {...scope, data: row};
      const image = item.image !== undefined ? resolveTemplate(String(item.image), rowScope) : null;
      return {
        row,
        title: shown(resolve(item.title, rowScope)),
        subtitle: item.subtitle !== undefined ? shown(resolve(item.subtitle, rowScope)) : '',
        image: image && isSafeRoute(image) ? image : null,
      };
    });
}

/** Runs a choose action: {result} once a request succeeded, null when the person cancelled or
 * declined; anything else throws, with the route's own error. */
export async function runChoose(action: UiAction, scope: Scope, deps: ChooseDeps): Promise<{result: any} | null> {
  const spec = action.choose;
  if (!spec) {
    return null;
  }
  const source = resolveTemplate(String(spec.source ?? ''), scope);
  if (!source || !isSafeRoute(source)) {
    throw refused();
  }
  const answer = await deps.load(source);
  const rows = chooseRows(spec, answer, scope);
  const picked = await deps.choose({
    title: spec.title !== undefined ? shown(resolve(spec.title, scope)) : '',
    empty: spec.empty !== undefined ? shown(resolve(spec.empty, scope)) : '',
    rows,
    create: spec.create
      ? {label: shown(resolve(spec.create.label, scope)), field: shown(resolve(spec.create.field, scope))}
      : null,
  });
  if (!picked) {
    return null;
  }
  if ('create' in picked) {
    // a new one, named by the person: the create route gets the text as $value
    const created: Scope = {...scope, value: String(picked.create)};
    const route = resolveTemplate(String(spec.create?.route ?? ''), created);
    if (!route || !isSafeRoute(route)) {
      throw refused();
    }
    const body = spec.create?.body !== undefined ? resolve(spec.create.body, created) : {value: created.value as Json};
    return {result: await deps.request(route, body)};
  }
  const chosen: Scope = {...scope, value: picked.row as Json};
  const route = resolveTemplate(String(action.route ?? ''), chosen);
  if (!route || !isSafeRoute(route)) {
    throw refused();
  }
  const body = action.body !== undefined ? resolve(action.body, chosen) : {};
  try {
    return {result: await deps.request(route, body)};
  } catch (error: any) {
    const conflict = action.conflict;
    if (!error || error.status !== 409 || !conflict) {
      throw error;
    }
    // already there: asked, then sent again to the conflict's route (or the same one)
    const asked = conflict.confirm !== undefined ? shown(resolve(conflict.confirm, chosen)) : '';
    if (!(await deps.confirm(asked || error.message || 'It is already there. Go on?'))) {
      return null;
    }
    const again = resolveTemplate(String(conflict.route ?? action.route ?? ''), chosen);
    if (!again || !isSafeRoute(again)) {
      throw refused();
    }
    const second = conflict.body !== undefined ? conflict.body : action.body;
    return {result: await deps.request(again, second !== undefined ? resolve(second, chosen) : {})};
  }
}
