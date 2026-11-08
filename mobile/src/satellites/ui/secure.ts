import type React from 'react';
import {findProvider, type CapabilityProvider, type Providers} from './contract';

/**
 * The secure action (UI contract 1.2), the app's side: one protected operation - so far
 * media.vault's move_in - on the items a media viewer shows or a selection holds, behind the
 * app's own unlock prompt.
 *
 * - The document names only the operation and how to bind each item's id. The provider comes
 *   from the catalog, the references are built for the document Satellite's own media.gallery
 *   items, and the prompt belongs to the app: a native screen the composition root
 *   (src/satellites/builtins.tsx) registers for the capability, which asks with the PIN (or a
 *   biometric match) for a single-use grant for exactly these items. Nothing opens, so nothing
 *   has to be locked again, and an app killed half way leaves at most a grant that expires.
 * - No PIN passes through here: the prompt hands back only the grant.
 * See docs/ui-contract.md ("secure") and docs/satellites/locked_folder.md.
 */

/** What this app can run (the vocabulary's secure_operations; checked by the shared tests). */
export const SECURE_OPERATIONS: Record<string, string[]> = {'media.vault': ['move_in']};
const GALLERY = 'media.gallery';

export interface Reference {
  provider: string;
  capability: string;
  id: string;
}

/** What a prompt is asked for: one operation, on exactly these references. */
export interface GrantRequest {
  operation: string;
  items: Reference[];
}

/** The app's own prompt for a capability: resolves a single-use grant through `onGrant`, or
 * nothing through `onCancel`. */
export interface SecurePromptProps {
  count: number;
  wanted: GrantRequest;
  onGrant: (grant: string) => void;
  onCancel: () => void;
}

/** A prompt the composition root registers: for which capability, from which provider. */
export interface SecurePrompt {
  capability: string;
  /** the providing Satellite whose own unlock the prompt speaks */
  satellite: string;
  component: React.ComponentType<SecurePromptProps>;
}

/** The provider and prompt an action would run with, or null when this app can't run it here:
 * an operation it doesn't know, no enabled provider offering it, no prompt for that provider,
 * or a Satellite acting on items it doesn't provide. Its control is then hidden. */
export function secureRunner(
  action: any,
  providers: Providers | null | undefined,
  satellite: string,
  prompts: SecurePrompt[],
): {provider: CapabilityProvider; prompt: SecurePrompt} | null {
  const secure = action?.secure;
  if (!secure || !(SECURE_OPERATIONS[secure.capability] ?? []).includes(secure.operation)) {
    return null;
  }
  const gallery = findProvider(providers ?? null, GALLERY);
  if (!gallery || gallery.satellite !== satellite) {
    return null;
  }
  const provider = findProvider(providers ?? null, secure.capability);
  const operations = provider?.operations ?? {};
  if (!provider || !['status', 'unlock', secure.operation].every(name => typeof operations[name] === 'string')) {
    return null;
  }
  const prompt = prompts.find(entry => entry.capability === secure.capability && entry.satellite === provider.satellite);
  return prompt ? {provider, prompt} : null;
}

/** References to the document Satellite's own gallery items: what the server resolves itself. */
export function references(satellite: string, ids: unknown[]): Reference[] {
  const seen = new Set<string>();
  const result: Reference[] = [];
  for (const id of ids) {
    const text = id === null || id === undefined ? '' : String(id);
    if (text && !seen.has(text)) {
      seen.add(text);
      result.push({provider: satellite, capability: GALLERY, id: text});
    }
  }
  return result;
}

export interface SecureResult {
  outcome: 'done' | 'partial' | 'failed' | 'cancelled' | 'setup';
  text: string | null;
  moved: {id?: string}[];
  failed: {id?: string; reason?: string}[];
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * Runs the operation once on `ids`. `read(route)` and `post(route, body)` call the provider;
 * `grant(wanted)` shows the prompt and resolves the grant, or null when cancelled.
 */
export async function runSecure({
  action, ids, satellite, provider, read, post, grant,
}: {
  action: any;
  ids: unknown[];
  satellite: string;
  provider: CapabilityProvider;
  read: (route: string) => Promise<any>;
  post: (route: string, body: any) => Promise<any>;
  grant: (wanted: GrantRequest) => Promise<string | null>;
}): Promise<SecureResult> {
  const items = references(satellite, ids);
  const failedWith = (text: string): SecureResult => ({outcome: 'failed', text, moved: [], failed: []});
  if (!items.length) {
    return failedWith('Nothing to move.');
  }
  const operations = provider.operations;
  const operation: string = action.secure.operation;
  let status: any;
  try {
    status = await read(operations.status);
  } catch (error: any) {
    return failedWith(error?.message || 'Could not check it.');
  }
  if (!status?.configured || !status?.pin_set) {
    return {outcome: 'setup', text: 'This isn’t set up yet: give it a location and a PIN in its own screens first.', moved: [], failed: []};
  }

  const body: {items: Reference[]; grant?: string} = {items};
  if (!status.unlocked) {
    const granted = await grant({operation, items});
    if (!granted) {
      return {outcome: 'cancelled', text: null, moved: [], failed: []};
    }
    body.grant = granted;
  }

  let result: any;
  try {
    result = await post(operations[operation], body);
  } catch (error: any) {
    return failedWith(error?.message || 'That didn’t work.');
  }
  const moved = Array.isArray(result?.moved) ? result.moved : [];
  const failed = Array.isArray(result?.failed) ? result.failed : [];
  if (!failed.length) {
    return {outcome: 'done', text: `Moved ${plural(moved.length, 'item')}.`, moved, failed};
  }
  const reason = failed[0]?.reason ? `: ${failed[0].reason}` : '';
  const text = moved.length
    ? `Moved ${moved.length} of ${items.length}; ${plural(failed.length, 'item')} couldn’t be${reason}.`
    : `Nothing was moved${reason}.`;
  return {outcome: moved.length ? 'partial' : 'failed', text, moved, failed};
}
