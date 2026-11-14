import {NativeModules, Platform} from 'react-native';

/**
 * The download, share and upload actions of the shared interface (UI contract 1.2) in the app: one file
 * from a Satellite's own route, fetched with the session by the app's own Kotlin module
 * (android/.../files/StarCoreFilesModule.kt), then saved to Downloads, opened in the phone's own
 * viewer (a download with `open`) or handed to the system share sheet. Absent on other
 * platforms and under Jest, where these actions are hidden. It knows the contract, never a
 * Satellite.
 */

// control characters are exactly what this strips from a file name
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\\/:*?"<>|\u0000-\u001f]/g;
const LONGEST = 120;

/** The name a file is saved under: the document's `name`, else the route's last segment, with
 * no path separator, reserved or control character or leading dot, and never empty - the same
 * rule as Mission Control's (mission_control/ui/files.js). */
export function fileName(name: unknown, route: string): string {
  let chosen = name === null || name === undefined ? '' : String(name).trim();
  if (!chosen) {
    const segments = String(route || '').split('?')[0].split('/').filter(Boolean);
    chosen = segments.length ? segments[segments.length - 1] : '';
  }
  // no leading dot either: it would be a hidden file
  chosen = chosen.replace(UNSAFE, '_').replace(/^\.+/, '').slice(0, LONGEST);
  return chosen || 'download';
}

function native(): any | null {
  const module = NativeModules.StarCoreFiles;
  return module && Platform.OS === 'android' ? module : null;
}

/** Saving to Downloads needs Android 10 or later (no storage permission there). */
export function canSaveFiles(): boolean {
  return Boolean(native()?.canSave);
}

export function canShareFiles(): boolean {
  return Boolean(native()?.canShare);
}

/** Opening needs no storage permission: the file stays in the app's cache. */
export function canOpenFiles(): boolean {
  return Boolean(native()?.canOpen);
}

type Source = {uri: string; headers?: Record<string, string>};

/** Saves the file to Downloads; resolves the name it was saved under. */
export async function saveFile(source: Source, name: string): Promise<string> {
  const module = native();
  if (!module) {
    throw new Error('Saving files is not available here.');
  }
  const saved = await module.save(source.uri, source.headers ?? {}, name);
  return String(saved?.name ?? name);
}

/** Fetches the file and opens the system share sheet with it. */
export async function shareFile(source: Source, name: string): Promise<void> {
  const module = native();
  if (!module) {
    throw new Error('Sharing files is not available here.');
  }
  await module.share(source.uri, source.headers ?? {}, name);
}

/** Fetches the file and opens it in whichever app on the phone views that kind of file. */
export async function openFile(source: Source, name: string): Promise<void> {
  const module = native();
  if (!module) {
    throw new Error('Opening files is not available here.');
  }
  await module.open(source.uri, source.headers ?? {}, name);
}

/** Picking files to upload needs the module's system document picker. */
export function canUploadFiles(): boolean {
  return Boolean(native()?.canUpload);
}

/** A document chosen on the phone: a content URI only the app can read, while it runs. */
export type PickedFile = {uri: string; name: string; size: number};

/** The system document picker; resolves what was chosen, none when it was closed. */
export async function pickFiles(multiple: boolean): Promise<PickedFile[]> {
  const module = native();
  if (!module) {
    throw new Error('Choosing files is not available here.');
  }
  const chosen = await module.pick(multiple);
  return (Array.isArray(chosen) ? chosen : []).map((item: any) => ({
    uri: String(item?.uri ?? ''),
    name: String(item?.name ?? ''),
    size: Number(item?.size ?? -1),
  }));
}

/** Streams a chosen document as the raw body of a POST to the source's URL, with its headers;
 * resolves the status and the parsed JSON answer (null when it isn't JSON). */
export async function uploadFile(file: PickedFile, target: Source): Promise<{status: number; payload: any}> {
  const module = native();
  if (!module) {
    throw new Error('Uploading files is not available here.');
  }
  const answer = await module.upload(file.uri, target.uri, target.headers ?? {});
  let payload: any = null;
  try {
    payload = answer?.body ? JSON.parse(String(answer.body)) : null;
  } catch {
    payload = null;
  }
  return {status: Number(answer?.status ?? 0), payload};
}
