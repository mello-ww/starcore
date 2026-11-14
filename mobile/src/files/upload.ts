import {fileName} from './index';

/**
 * The upload action (UI contract 1.2) in the app: files the person picks with the system
 * document picker, each sent in turn as the raw body of a POST to one of the Satellite's own
 * routes, with a conflict asked about file by file and a report of every file. The sending
 * itself is the host's (the app's Kotlin module, with the session); what is decided here is
 * pure, and the same as Mission Control's (mission_control/ui/upload.js). It knows the
 * contract, never a Satellite.
 */

export type UploadValue = {name: string; size: number};
export type UploadAnswer = {status: number; payload: any};
export type UploadResult = {uploaded: string[]; skipped: string[]; failed: {name: string; error: string}[]};

type UploadAction = {route?: string; conflict?: {confirm?: unknown; route?: string}};

export type UploadHost<F> = {
  /** The Satellite URL for a route template with `$value`, or null when it would leave the Satellite. */
  url: (template: string, value: UploadValue) => string | null;
  /** Resolves `{status, payload}` for any answer; throws when nothing came back. */
  send: (url: string, file: F) => Promise<UploadAnswer>;
  /** Whether to replace the file `value` names; `text` is the document's own, unresolved. */
  confirm: (value: UploadValue, text: unknown) => Promise<boolean>;
  progress?: (index: number, total: number, value: UploadValue) => void;
};

/** What `$value` is while one file is sent: its name, made safe as a download's, and its size. */
export function uploadValue(file: {name?: unknown; size?: unknown}): UploadValue {
  const size = Number(file?.size);
  return {name: fileName(file?.name, 'upload'), size: Number.isFinite(size) && size >= 0 ? size : 0};
}

function failure(answer: UploadAnswer): string {
  const error = typeof answer?.payload?.error === 'string' ? answer.payload.error : '';
  return error || `the server answered ${answer ? answer.status : 'nothing'}`;
}

/** Sends `files` one after another for `action` ({route, conflict}). */
export async function runUploads<F extends {name?: unknown; size?: unknown}>(
  files: F[],
  action: UploadAction,
  host: UploadHost<F>,
): Promise<UploadResult> {
  const result: UploadResult = {uploaded: [], skipped: [], failed: []};
  const conflict = action?.conflict && typeof action.conflict.route === 'string' ? action.conflict : null;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const value = uploadValue(file);
    host.progress?.(index, files.length, value);
    const post = async (template: string | undefined): Promise<UploadAnswer> => {
      const url = host.url(String(template ?? ''), value);
      if (!url) {
        throw new Error('the upload points outside its Satellite and was refused');
      }
      const answer = await host.send(url, file);
      if (!answer || typeof answer.status !== 'number') {
        throw new Error('the upload failed');
      }
      return answer;
    };
    try {
      let answer = await post(action.route);
      if (answer.status === 409 && conflict) {
        if (!(await host.confirm(value, conflict.confirm))) {
          result.skipped.push(value.name);
          continue;
        }
        answer = await post(conflict.route);
      }
      if (answer.status >= 200 && answer.status < 300) {
        result.uploaded.push(value.name);
      } else {
        result.failed.push({name: value.name, error: failure(answer)});
      }
    } catch (error: any) {
      result.failed.push({name: value.name, error: error?.message || 'the upload failed'});
    }
  }
  return result;
}

const NAMED = 3;

function names(list: string[]): string {
  const shown = list.slice(0, NAMED).join(', ');
  return list.length > NAMED ? `${shown} and ${list.length - NAMED} more` : shown;
}

/** What the person is told once every file was tried: an error when any file failed. Part of a
 * selection is never reported as all of it. */
export function uploadReport(result: UploadResult): {text: string; error: boolean} {
  const {uploaded, skipped, failed} = result;
  const total = uploaded.length + skipped.length + failed.length;
  if (total === 0) {
    return {text: 'Nothing was uploaded.', error: false};
  }
  if (uploaded.length === total) {
    return {text: total === 1 ? `Uploaded ${uploaded[0]}.` : `Uploaded ${total} files.`, error: false};
  }
  const parts: string[] = [];
  if (total > 1) {
    parts.push(`Uploaded ${uploaded.length} of ${total} files.`);
  }
  if (skipped.length) {
    parts.push(`Kept the existing ${names(skipped)}.`);
  }
  if (failed.length) {
    const shown = failed.slice(0, NAMED).map(entry => `${entry.name} (${entry.error})`).join('; ');
    const more = failed.length > NAMED ? ` and ${failed.length - NAMED} more` : '';
    parts.push(`Could not upload ${shown}${more}.`);
  }
  return {text: parts.join(' '), error: failed.length > 0};
}
