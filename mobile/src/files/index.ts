import {NativeModules, Platform} from 'react-native';

/**
 * The download and share actions of the shared interface (UI contract 1.2) in the app: one file
 * from a Satellite's own route, fetched with the session by the app's own Kotlin module
 * (android/.../files/StarCoreFilesModule.kt), then saved to Downloads or handed to the system
 * share sheet. Absent on other platforms and under Jest, where both actions are hidden. It
 * knows the contract, never a Satellite.
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
