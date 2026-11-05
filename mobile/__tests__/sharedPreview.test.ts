import {hasSharedPreview, opensSharedInterface} from '../src/screens/HomeScreen';
import type {SatelliteSummary} from '../src/satellites/types';

// a preview document (UI contract 1.2) leaves the app's own screen for a Satellite first;
// any other document - or a preview for a Satellite the app has no screen of its own for -
// opens in the shared interface
const satellite = (name: string, ui: SatelliteSummary['ui']): SatelliteSummary =>
  ({name, ui, mobile_ui: false, status: 'running', description: ''}) as unknown as SatelliteSummary;

describe('which interface a Satellite opens in', () => {
  it('opens a document in the shared interface', () => {
    const shown = satellite('Status', {contract: 'starcore.ui/1.1', revision: 'r1', error: null});
    expect(opensSharedInterface(shown)).toBe(true);
    expect(hasSharedPreview(shown)).toBe(false);
  });

  it('keeps the app’s own screen first for a preview, and offers the shared one beside it', () => {
    const preview = satellite('Photo', {contract: 'starcore.ui/1.2', revision: 'r2', error: null, preview: true});
    expect(opensSharedInterface(preview)).toBe(false);
    expect(hasSharedPreview(preview)).toBe(true);
  });

  it('opens a preview in the shared interface when the app has no screen of its own for it', () => {
    const unknown = satellite('Gallery', {contract: 'starcore.ui/1.2', revision: 'r3', error: null, preview: true});
    expect(opensSharedInterface(unknown)).toBe(true);
    expect(hasSharedPreview(unknown)).toBe(false);
  });

  it('has nothing to open without a valid document', () => {
    const refused = satellite('Photo', {contract: null, revision: null, error: 'ui.json is invalid', preview: true});
    expect(opensSharedInterface(refused)).toBe(false);
    expect(hasSharedPreview(refused)).toBe(false);
  });
});
