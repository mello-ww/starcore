/**
 * Secrets a protected document's action asks for, and a secret its answer reveals (UI contract
 * 1.2, docs/reference/ui-contract.md "Protected documents"). The document only names them - `secrets`
 * ({key: {kind, new?}}) and `reveal` (a field of the answer) - and this app asks and shows them in
 * dialogs of its own (./SecretPrompt.tsx), whose words name the Satellite asking. A secret
 * is typed only in those dialogs and goes only into the one request's body: never into a form's
 * values, page state, storage, a notice or a log. A revealed value is shown once and dropped from
 * the answer before anything else (a notice, `then`) sees it. The same rules as Mission Control's
 * ui/secrets.js.
 */
import {SECRET_KINDS} from './contract';

export type SecretKind = 'pin' | 'recovery-key';

export interface SecretAsk {
  kind: SecretKind;
  isNew: boolean;
  again: boolean;
  error: string | null;
}

/** The prompts an action's `secrets` need, in order, or null when one of them is something this
 * app never asks for (an unknown kind, a malformed entry). */
export function secretPrompts(secrets: unknown): {key: string; kind: SecretKind; isNew: boolean}[] | null {
  if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) {
    return null;
  }
  const prompts: {key: string; kind: SecretKind; isNew: boolean}[] = [];
  for (const [key, secret] of Object.entries(secrets as Record<string, any>)) {
    if (!secret || typeof secret !== 'object' || !SECRET_KINDS.has(secret.kind)) {
      return null;
    }
    prompts.push({key, kind: secret.kind, isNew: secret.new === true && secret.kind === 'pin'});
  }
  return prompts.length ? prompts : null;
}

const cancelled = (value: string | null | undefined) => value === null || value === undefined || value === '';

/** Asks for every secret through `ask`, which resolves what was typed or null when cancelled. A new
 * PIN is asked twice, and again from the start while the two differ. Resolves {key: value} for the
 * request body, or null once anything is cancelled. */
export async function askSecrets(
  secrets: unknown,
  ask: (prompt: SecretAsk) => Promise<string | null>,
): Promise<Record<string, string> | null> {
  const prompts = secretPrompts(secrets);
  if (!prompts) {
    return null;
  }
  const values: Record<string, string> = {};
  for (const {key, kind, isNew} of prompts) {
    let error: string | null = null;
    for (;;) {
      const first = await ask({kind, isNew, again: false, error});
      if (cancelled(first)) {
        return null;
      }
      if (!isNew) {
        values[key] = first as string;
        break;
      }
      const second = await ask({kind, isNew, again: true, error: null});
      if (cancelled(second)) {
        return null;
      }
      if (second === first) {
        values[key] = first as string;
        break;
      }
      error = "The two PINs don't match. Try again.";
    }
  }
  return values;
}

/** The request body with the secrets in it: the action's own body (an object) or nothing, and each
 * secret under its key. */
export function bodyWithSecrets(body: unknown, values: Record<string, string>): Record<string, any> {
  const base = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, any>) : {};
  return {...base, ...values};
}

/** Splits an answer: the revealed field's value (a non-empty string, else null) and the answer
 * without it, which is all that a notice or `then` may see. */
export function takeRevealed(result: any, field: unknown): {secret: string | null; rest: any} {
  if (!result || typeof result !== 'object' || Array.isArray(result) || typeof field !== 'string') {
    return {secret: null, rest: result};
  }
  const {[field]: secret, ...rest} = result;
  return {secret: typeof secret === 'string' && secret ? secret : null, rest};
}

/** Shows the revealed field of an answer through `show` (resolves once the person said it is
 * stored), then resolves the answer without it. */
export async function revealFrom(result: any, field: unknown, show: (secret: string) => Promise<void>): Promise<any> {
  const {secret, rest} = takeRevealed(result, field);
  if (secret !== null) {
    await show(secret);
  }
  return rest;
}
