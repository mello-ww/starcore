import type {OwnIcons} from './ui/contract';

/** Mirrors GET /api/satellites - see docs/reference/api.md. Only the fields this app actually
 * uses; StarCore's Satellite entry has more (commands, state, page) that
 * belong to Mission Control, not this app. */
export interface SatelliteSummary {
  name: string;
  version: string;
  author: string;
  description: string;
  /** Its own icon: a name in `icons` (UI contract 1.2), or null. */
  icon: string | null;
  /** Its own icons, as the Engine validated them from its icons/ folder (src/components/Glyph.tsx). */
  icons?: OwnIcons;
  type: 'native' | 'link';
  enabled: boolean;
  status: 'running' | 'stopped' | 'disabled' | 'error';
  configurable: boolean;
  /** Set when this Satellite's interface is a section of another's, so it
   * gets no list entry of its own.
   * Presentation only - its routes are as protected as any other. */
  section_of?: string | null;
  /** What the Satellite publishes about itself (its state.py) - free-form,
   * except where a legacy screen knows one Satellite's shape (Home's fallback card). */
  state?: Record<string, unknown>;
  /** A name from the shared icon set (contracts/ui/vocabulary.json). */
  icon_name?: string | null;
  /** Satellite capabilities it provides to others - see docs/reference/ui-contract.md. */
  provides?: Record<string, {version: number; operations: Record<string, string>}>;
  /** Its declarative interface (ui.json): a revision when the Engine
   * validated one, an error when it refused it, null when there is none. */
  /** `preview` (UI contract 1.2): the document doesn't replace the Satellite's own screens yet -
   * they stay the default, and Developer Mode offers the shared interface beside them. */
  ui?: {contract: string | null; revision: string | null; error: string | null; preview?: boolean} | null;
}
