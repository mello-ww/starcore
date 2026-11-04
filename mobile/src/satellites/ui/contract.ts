/**
 * StarCore UI contract 1.0 - this app's side of the shared rules: bindings,
 * route templates, route safety, formats and compatibility. Pure functions,
 * tested against the same fixtures (contracts/ui/) as the Engine and
 * Mission Control - see docs/ui-contract.md. Nothing here ever evaluates
 * code from a document.
 */

export const CONTRACT_NAME = 'starcore.ui';
export const MAJOR = 1;
export const MINOR = 0;

export const BLOCK_TYPES = new Set([
  'heading', 'text', 'field', 'metric', 'card', 'list', 'button', 'toggle', 'slider', 'form', 'file-browser',
]);
export const FORMATS = new Set(['text', 'number', 'integer', 'percent', 'bytes', 'duration']);
export const TONES = new Set(['neutral', 'ok', 'warn', 'danger']);
/** The shared icon set - every name is a Feather glyph this app can draw. */
export const ICONS = new Set([
  'activity', 'box', 'camera', 'check', 'circle', 'clock', 'cpu', 'file', 'file-text',
  'folder', 'grid', 'hard-drive', 'home', 'image', 'info', 'layers', 'list', 'lock',
  'music', 'plus', 'settings', 'sliders', 'star', 'zap',
]);
/** Device features this app offers a document beyond its blocks - none in 1.0. */
export const CLIENT_CAPABILITIES = new Set<string>();
/** Satellite capabilities this app has a shared block for, and the protocol versions it speaks. */
export const CAPABILITY_VERSIONS: Record<string, number[]> = {'files.browse': [1]};

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

export interface UiPage {
  title?: Json;
  params?: string[];
  source?: {route: string; refresh?: number};
  blocks: UiBlock[];
}

export interface UiDocument {
  contract: string;
  title?: string;
  requires?: {client?: string[]; capabilities?: string[]};
  entry: string;
  navigation?: Array<{page: string; label: string; icon?: string}>;
  pages: Record<string, UiPage>;
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

const ROOTS: Array<[string, keyof Scope]> = [['$.', 'data'], ['$page.', 'page'], ['$params.', 'params'], ['$form.', 'form']];

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

/** A value as display text - see "Formats" in docs/ui-contract.md. */
export function formatValue(value: unknown, format: string = 'text', unit?: string): string {
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
    return scaled(value, ['B', 'KB', 'MB', 'GB', 'TB'], 1024);
  } else if (format === 'duration') {
    return duration(value);
  } else {
    text = trimNumber(value, 2);
  }
  return unit ? `${text} ${unit}` : text;
}
