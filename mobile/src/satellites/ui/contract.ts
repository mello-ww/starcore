/**
 * StarCore UI contract 1.1 - this app's side of the shared rules: bindings,
 * route templates, route safety, formats and compatibility. Pure functions,
 * tested against the same fixtures (contracts/ui/) as the Engine and
 * Mission Control - see docs/ui-contract.md. Nothing here ever evaluates
 * code from a document.
 */

export const CONTRACT_NAME = 'starcore.ui';
export const MAJOR = 1;
export const MINOR = 2;

export const BLOCK_TYPES = new Set([
  'heading', 'text', 'field', 'metric', 'card', 'list', 'button', 'toggle', 'slider', 'form', 'file-browser',
  // 1.1
  'chart', 'table', 'choice', 'status', 'code',
  // 1.2
  'image', 'media-list', 'media-grid', 'search', 'map',
]);
export const FORMATS = new Set([
  'text', 'number', 'integer', 'percent', 'bytes', 'duration',
  // 1.1
  'bitrate', 'byterate', 'date', 'time', 'datetime', 'relative',
]);
export const TONES = new Set(['neutral', 'ok', 'warn', 'danger']);
/** The shared icon set - every name is a Feather glyph this app can draw. */
export const ICONS = new Set([
  'activity', 'box', 'camera', 'check', 'circle', 'clock', 'cpu', 'file', 'file-text',
  'folder', 'grid', 'hard-drive', 'home', 'image', 'info', 'layers', 'list', 'lock',
  'music', 'plus', 'settings', 'sliders', 'star', 'zap',
  // 1.2
  'chevron-left', 'chevron-right', 'edit-2', 'heart', 'map-pin', 'play', 'rotate-ccw', 'search', 'trash-2', 'x',
]);
/** Device features this app offers a document beyond its blocks: the shared audio host
 * (src/media/), which the play action plays through. */
export const CLIENT_CAPABILITIES = new Set<string>(['media.audio', 'media.picker']);
/** Satellite capabilities this app has a shared block for, and the protocol versions it speaks. */
export const CAPABILITY_VERSIONS: Record<string, number[]> = {'files.browse': [1], 'audio.library': [1], 'media.gallery': [1]};

const RESERVED_SEGMENTS = new Set(['assets', 'enable', 'disable', 'reload', 'ui']);
const FIRST_SEGMENT = /^[A-Za-z0-9_-]+$/;
const SEGMENT = /^[A-Za-z0-9_.~%-]+$/;
const QUERY = /^[A-Za-z0-9_.~%&=+-]*$/;
const CONTRACT_PATTERN = /^starcore\.ui\/(\d+)\.(\d+)$/;

export type Json = null | boolean | number | string | Json[] | {[key: string]: Json};

export interface UiAction {
  navigate?: string;
  params?: Record<string, Json>;
  route?: string;
  method?: 'GET' | 'POST';
  body?: Record<string, Json>;
  confirm?: string;
  then?: 'refresh' | 'back' | {navigate: string; params?: Record<string, Json>};
  /** 1.2: play what the audio.library provider finds, through the app's audio host. */
  play?: {search: Json};
  /** 1.2: choose media through the app's picker; the route then gets the references as $value. */
  pick?: {capability: string; kinds?: string[]; multiple?: boolean; title?: Json};
  /** 1.2: open the Satellite's own native screens at a section they name ("settings"). */
  own?: string;
  /** 1.2: run one secure operation (media.vault move_in) on the items shown or selected, behind
   * the app's own unlock prompt; `item` binds each item's id. */
  secure?: {capability: string; operation: string};
  item?: string;
}

/** One block. Deliberately loose: a document is network data, so every
 * renderer checks what it reads instead of trusting a compile-time shape. */
export interface UiBlock {
  type: string;
  id?: string;
  visible?: Json;
  required?: boolean;
  developer?: boolean;
  [key: string]: any;
}

export interface UiSource {
  route: string;
  refresh?: number;
}

export interface UiPage {
  title?: Json;
  params?: string[];
  source?: UiSource;
  /** 1.1: more sources, bound as $sources.<name> */
  sources?: Record<string, UiSource>;
  /** 1.1: page-local values (a choice's selection), bound as $state.<key> */
  state?: Record<string, Json>;
  /** 1.1: 'stack' (the default) or 'dashboard' */
  template?: string;
  /** 1.2: this page may be kept to show while StarCore can't be reached - only the fields its
   * blocks bind, and never one named in `omit`, at any depth (satellites/ui/offline.ts) */
  offline?: boolean | {omit?: string[]};
  blocks: UiBlock[];
}

/** 1.1: a summary any client may show outside the Satellite's pages (Home).
 * Without a source, its data is the state the Satellite publishes. */
export interface UiWidget {
  id: string;
  title?: Json;
  icon?: string;
  source?: UiSource;
  blocks: UiBlock[];
  action?: UiAction;
}

export interface UiDocument {
  contract: string;
  title?: string;
  requires?: {client?: string[]; capabilities?: string[]};
  entry: string;
  navigation?: Array<{page: string; label: string; icon?: string; developer?: boolean}>;
  /** 1.1: a band above the navigation on top-level pages */
  header?: {source?: UiSource; blocks: UiBlock[]};
  widgets?: UiWidget[];
  pages: Record<string, UiPage>;
  /** 1.2: doesn't replace the Satellite's own screens yet (they stay the default). */
  preview?: boolean;
}

export interface CapabilityProvider {
  satellite: string;
  version: number;
  operations: Record<string, string>;
  enabled: boolean;
}

export type Providers = Record<string, CapabilityProvider[]>;

export interface Scope {
  data?: any;
  page?: any;
  params?: Record<string, any>;
  value?: any;
  form?: Record<string, any>;
  state?: Record<string, any>;
  sources?: Record<string, any>;
}

export function parseContract(value: unknown): {major: number; minor: number} | null {
  const match = typeof value === 'string' ? CONTRACT_PATTERN.exec(value) : null;
  return match ? {major: Number(match[1]), minor: Number(match[2])} : null;
}

/** null when this app can render the document, else why not. */
export function checkDocument(document: any): string | null {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return 'The interface description must be an object.';
  }
  const version = parseContract(document.contract);
  if (!version) {
    return 'The interface description has no valid contract version.';
  }
  if (version.major !== MAJOR) {
    return `This interface needs ${document.contract}; this app renders ${CONTRACT_NAME}/${MAJOR}.x. Update StarCore for Android to use it.`;
  }
  const pages = document.pages;
  if (!pages || typeof pages !== 'object' || Array.isArray(pages) || Object.keys(pages).length === 0) {
    return 'The interface description has no pages.';
  }
  if (!Object.prototype.hasOwnProperty.call(pages, document.entry)) {
    return "The interface description's entry page is missing.";
  }
  return null;
}

/** The first enabled Satellite providing `name` in a protocol version this app speaks. */
export function findProvider(providers: Providers | null | undefined, name: string): CapabilityProvider | null {
  const versions = CAPABILITY_VERSIONS[name] ?? [];
  const candidates = providers?.[name] ?? [];
  return candidates.find(entry => entry.enabled && versions.includes(entry.version)) ?? null;
}

export function missingRequirements(
  requires: UiDocument['requires'],
  providers: Providers | null | undefined,
): Array<{kind: 'client' | 'capability'; name: string}> {
  const missing: Array<{kind: 'client' | 'capability'; name: string}> = [];
  for (const name of requires?.client ?? []) {
    if (!CLIENT_CAPABILITIES.has(name)) {
      missing.push({kind: 'client', name});
    }
  }
  for (const name of requires?.capabilities ?? []) {
    if (!findProvider(providers, name)) {
      missing.push({kind: 'capability', name});
    }
  }
  return missing;
}

function lookup(root: any, path: string[]): any {
  let value = root;
  for (const segment of path) {
    if (value === null || value === undefined || typeof value !== 'object') {
      return null;
    }
    value = Object.prototype.hasOwnProperty.call(value, segment) ? value[segment] : null;
  }
  return value === undefined ? null : value;
}

const ROOTS: Array<[string, keyof Scope]> = [
  ['$.', 'data'], ['$page.', 'page'], ['$params.', 'params'], ['$form.', 'form'], ['$state.', 'state'], ['$sources.', 'sources'],
  // 1.2: inside a value that is an object (a map's viewport: $value.bbox, $value.zoom)
  ['$value.', 'value'],
];

function resolveString(expression: string, scope: Scope): any {
  if (!expression.startsWith('$')) {
    return expression;
  }
  if (expression.startsWith('$$')) {
    return expression.slice(1);
  }
  if (expression === '$') {
    return scope.data === undefined ? null : scope.data;
  }
  if (expression === '$value') {
    return scope.value === undefined ? null : scope.value;
  }
  for (const [prefix, key] of ROOTS) {
    if (expression.startsWith(prefix)) {
      return lookup(scope[key], expression.slice(prefix.length).split('.'));
    }
  }
  return null;
}

/** A binding (or any literal, nested object or array) resolved against the
 * scope. Plain lookups only - there is no expression language. */
export function resolve(expression: any, scope: Scope): any {
  if (typeof expression === 'string') {
    return resolveString(expression, scope);
  }
  if (Array.isArray(expression)) {
    return expression.map(item => resolve(item, scope));
  }
  if (expression && typeof expression === 'object') {
    return Object.fromEntries(Object.entries(expression).map(([key, item]) => [key, resolve(item, scope)]));
  }
  return expression;
}

/** Each {binding} placeholder is URL-encoded, so a value can never add a path segment. */
export function resolveTemplate(template: string, scope: Scope): string {
  return String(template).replace(/\{([^{}]*)\}/g, (_, expression: string) => {
    const value = resolve(expression, scope);
    return value === null || value === undefined ? '' : encodeURIComponent(String(value));
  });
}

/** Whether a resolved route stays beneath its Satellite - never a Core
 * endpoint, another Satellite or another host. */
export function isSafeRoute(route: unknown): route is string {
  if (typeof route !== 'string' || route === '') {
    return false;
  }
  const question = route.indexOf('?');
  const path = question === -1 ? route : route.slice(0, question);
  if (question !== -1 && !QUERY.test(route.slice(question + 1))) {
    return false;
  }
  const segments = path.split('/');
  if (!FIRST_SEGMENT.test(segments[0]) || RESERVED_SEGMENTS.has(segments[0])) {
    return false;
  }
  return segments.slice(1).every(segment => segment !== '' && segment !== '.' && segment !== '..' && SEGMENT.test(segment));
}

export function isVisible(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

export function toneOf(value: unknown): 'neutral' | 'ok' | 'warn' | 'danger' {
  return typeof value === 'string' && TONES.has(value) ? (value as any) : 'neutral';
}

function trimNumber(value: number, digits: number): string {
  return String(Number(value.toFixed(digits)));
}

function scaled(value: number, units: string[], base: number): string {
  let index = 0;
  let amount = value;
  while (Math.abs(amount) >= base && index < units.length - 1) {
    amount /= base;
    index += 1;
  }
  return `${index === 0 ? Math.round(amount) : trimNumber(amount, 1)} ${units[index]}`;
}

function duration(seconds: number): string {
  const total = Math.round(seconds);
  const parts: Array<[number, string]> = [[86400, 'd'], [3600, 'h'], [60, 'm'], [1, 's']];
  for (let index = 0; index < parts.length; index += 1) {
    const [size, unit] = parts[index];
    if (total >= size || size === 1) {
      const whole = Math.floor(total / size);
      const rest = index < parts.length - 1 ? Math.floor((total % size) / parts[index + 1][0]) : 0;
      return rest ? `${whole}${unit} ${rest}${parts[index + 1][1]}` : `${whole}${unit}`;
    }
  }
  return `${total}s`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
const BIT_UNITS = ['b/s', 'kb/s', 'Mb/s', 'Gb/s', 'Tb/s'];

function moment(seconds: number, format: string, utc: boolean): string {
  const date = new Date(seconds * 1000);
  const hours = utc ? date.getUTCHours() : date.getHours();
  const minutes = utc ? date.getUTCMinutes() : date.getMinutes();
  const clock = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  const day = `${utc ? date.getUTCDate() : date.getDate()} ${MONTHS[utc ? date.getUTCMonth() : date.getMonth()]} ${
    utc ? date.getUTCFullYear() : date.getFullYear()
  }`;
  return format === 'time' ? clock : format === 'date' ? day : `${day}, ${clock}`;
}

function relative(seconds: number, now: number): string {
  const difference = now - seconds;
  const size = Math.abs(difference);
  if (size < 10) {
    return 'just now';
  }
  const amount =
    size < 60
      ? `${Math.floor(size)}s`
      : size < 3600
        ? `${Math.floor(size / 60)} min`
        : size < 86400
          ? `${Math.floor(size / 3600)} h`
          : `${Math.floor(size / 86400)} d`;
  return difference > 0 ? `${amount} ago` : `in ${amount}`;
}

export interface FormatOptions {
  /** Times in UTC instead of the device's time zone - for the tests. */
  utc?: boolean;
  /** The moment `relative` measures from (epoch seconds) - for the tests. */
  now?: number;
}

/** A value as display text - see "Formats" in docs/ui-contract.md. */
export function formatValue(value: unknown, format: string = 'text', unit?: string, options: FormatOptions = {}): string {
  let text: string;
  if (value === null || value === undefined) {
    return '—';
  } else if (typeof value === 'boolean') {
    text = value ? 'Yes' : 'No';
  } else if (typeof value === 'object') {
    return '—';
  } else if (typeof value !== 'number' || !Number.isFinite(value)) {
    text = String(value);
  } else if (format === 'integer') {
    text = String(Math.round(value));
  } else if (format === 'percent') {
    return `${trimNumber(value, 1)}%`;
  } else if (format === 'bytes') {
    return scaled(value, BYTE_UNITS, 1024);
  } else if (format === 'byterate') {
    return `${scaled(value, BYTE_UNITS, 1024)}/s`;
  } else if (format === 'bitrate') {
    return scaled(Math.max(value, 0) * 8, BIT_UNITS, 1000);
  } else if (format === 'duration') {
    return duration(value);
  } else if (format === 'time' || format === 'date' || format === 'datetime') {
    return moment(value, format, Boolean(options.utc));
  } else if (format === 'relative') {
    return relative(value, typeof options.now === 'number' ? options.now : Date.now() / 1000);
  } else {
    text = trimNumber(value, 2);
  }
  return unit ? `${text} ${unit}` : text;
}
