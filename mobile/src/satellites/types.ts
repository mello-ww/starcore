/** Mirrors GET /api/satellites - see docs/api.md and "Exposing a mobile
 * interface" in docs/satellites.md. Only the fields this app actually
 * uses; StarCore's Satellite entry has more (commands, state, page) that
 * belong to Mission Control, not this app. */
export interface SatelliteSummary {
  name: string;
  version: string;
  author: string;
  description: string;
  icon: string | null;
  type: 'native' | 'link';
  enabled: boolean;
  status: 'running' | 'stopped' | 'disabled' | 'error';
  configurable: boolean;
  /** Whether this Satellite has a "mobile" route - the one thing that
   * decides whether tapping it on the Satellites screen opens a real
   * screen or just shows its name/status. See docs/satellites.md. */
  mobile_ui: boolean;
  /** Set when this Satellite's interface is a section of another's (the
   * Locked Folder lives in Photos), so it gets no list entry of its own.
   * Presentation only - its routes are as protected as any other. */
  section_of?: string | null;
  /** What the Satellite publishes about itself (its state.py) - free-form,
   * except where a screen knows one Satellite's shape (Home's Status card). */
  state?: Record<string, unknown>;
  /** A name from the shared icon set (contracts/ui/vocabulary.json). Absent
   * on servers older than UI contract 1.0. */
  icon_name?: string | null;
  /** Satellite capabilities it provides to others - see docs/ui-contract.md. */
  provides?: Record<string, {version: number; operations: Record<string, string>}>;
  /** Its declarative interface (ui.json): a revision when the Engine
   * validated one, an error when it refused it, null when there is none.
   * Absent on servers older than UI contract 1.0. */
  /** `preview` (UI contract 1.2): the document doesn't replace the Satellite's own screens yet -
   * they stay the default, and Developer Mode offers the shared interface beside them. */
  ui?: {contract: string | null; revision: string | null; error: string | null; preview?: boolean} | null;
}

/** The declarative UI schema a Satellite's "mobile" route answers with -
 * see "Exposing a mobile interface" in docs/satellites.md. Deliberately
 * the smallest set of primitives that covers a status-style screen; a
 * `"type"` this app doesn't recognize is skipped, not an error, so an
 * older build stays compatible with a newer Satellite. */
export type UiAction = {
  /** Relative to /api/satellites/<name>/, unless it starts with "/", in
   * which case it's an absolute path (see runAction in api.ts). */
  route: string;
  method?: 'GET' | 'POST';
  confirm?: string;
};

/**
 * Deliberately just these four - not a catch-all `{type: string}` member,
 * which would defeat TypeScript's discriminated-union narrowing on every
 * arm, not only the unknown ones. Forward-compatibility (an item type this
 * app doesn't know yet) is handled at the *value* level instead: the
 * server can send more than this at runtime (this is a network response,
 * not something the compiler enforces), and DeclarativeScreen's `switch`
 * has an explicit `default` that skips whatever doesn't match - see its
 * own docstring.
 */
export type UiItem = (
  | {type: 'text'; value: string; style?: 'heading' | 'body' | 'caption'}
  | {type: 'status'; label: string; value: string}
  | {type: 'list'; items: Array<{title: string; subtitle?: string}>}
  | {type: 'button'; label: string; action: UiAction}
) & {
  /** Shown only in Developer Mode - a display hint, never a permission. */
  developer?: boolean;
};

export interface UiSection {
  type: 'card';
  title?: string;
  items: UiItem[];
  /** Shown only in Developer Mode - see UiItem.developer. */
  developer?: boolean;
}

export interface UiScreen {
  title: string;
  sections: UiSection[];
}

export interface MobileUiResponse {
  screen: UiScreen;
}
