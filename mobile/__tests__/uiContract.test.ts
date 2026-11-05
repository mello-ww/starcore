import * as contract from '../src/satellites/ui/contract';

// Node's own modules, through Jest's require (this app's TypeScript setup has no Node types)
declare const __dirname: string;
const {readFileSync} = require('fs') as {readFileSync: (path: string, encoding: string) => string};
const {join} = require('path') as {join: (...parts: string[]) => string};

/**
 * This app's contract module against the shared fixtures in contracts/ui/ -
 * the same ones the Engine (engine/tests/test_ui_contract.py) and Mission
 * Control (contracts/ui/tests/web.test.mjs) are checked against, so the two
 * renderers can't drift apart. See docs/ui-contract.md.
 */
const CONTRACT = join(__dirname, '..', '..', 'contracts', 'ui');
const load = (name: string) => JSON.parse(readFileSync(join(CONTRACT, 'fixtures', name), 'utf-8'));
const vocabulary = JSON.parse(readFileSync(join(CONTRACT, 'vocabulary.json'), 'utf-8'));
const sorted = (values: Iterable<string>) => [...values].sort();

describe('UI contract (shared fixtures)', () => {
  it('implements exactly the shared vocabulary', () => {
    expect(`${contract.MAJOR}.${contract.MINOR}`).toBe(vocabulary.version);
    expect(sorted(contract.BLOCK_TYPES)).toEqual(sorted(Object.keys(vocabulary.blocks)));
    expect(sorted(contract.FORMATS)).toEqual(sorted(vocabulary.formats));
    expect(sorted(contract.TONES)).toEqual(sorted(vocabulary.tones));
    expect(sorted(contract.ICONS)).toEqual(sorted(vocabulary.icons));
    for (const name of Object.keys(contract.CAPABILITY_VERSIONS)) {
      expect(vocabulary.satellite_capabilities[name]).toBeTruthy();
    }
  });

  it('every shared icon is a glyph this app can draw', () => {
    const glyphs = require('react-native-vector-icons/glyphmaps/Feather.json');
    for (const name of contract.ICONS) {
      expect(glyphs[name]).toBeDefined();
    }
  });

  it('resolves bindings', () => {
    const {context, resolve} = load('bindings.json');
    for (const {expr, expected} of resolve) {
      expect(contract.resolve(expr, context)).toEqual(expected);
    }
  });

  it('resolves route templates', () => {
    const {context, templates} = load('bindings.json');
    for (const {template, expected} of templates) {
      expect(contract.resolveTemplate(template, context)).toBe(expected);
    }
  });

  it('only calls routes beneath the Satellite', () => {
    const {safe, unsafe} = load('routes.json');
    for (const route of safe) {
      expect([route, contract.isSafeRoute(route)]).toEqual([route, true]);
    }
    for (const route of unsafe) {
      expect([route, contract.isSafeRoute(route)]).toEqual([route, false]);
    }
  });

  it('formats values and decides visibility', () => {
    const {cases, visible} = load('formats.json');
    for (const {value, format, unit, options, expected} of cases) {
      expect([value, format, contract.formatValue(value, format, unit, options)]).toEqual([value, format, expected]);
    }
    for (const {value, expected} of visible) {
      expect(contract.isVisible(value)).toBe(expected);
    }
  });

  it('accepts valid documents and refuses the ones every client must refuse', () => {
    const {valid, invalid} = load('documents.json');
    for (const {name, document} of valid) {
      expect([name, contract.checkDocument(document)]).toEqual([name, null]);
    }
    for (const {name, document, client} of invalid) {
      if (client) {
        expect([name, contract.checkDocument(document) !== null]).toEqual([name, true]);
      }
    }
  });

  it('finds capability providers and reports what is missing', () => {
    const providers = {
      'files.browse': [
        {satellite: 'Off', version: 1, enabled: false, operations: {list: 'entries'}},
        {satellite: 'On', version: 1, enabled: true, operations: {list: 'entries'}},
      ],
    };
    expect(contract.findProvider(providers, 'files.browse')?.satellite).toBe('On');
    expect(contract.missingRequirements({capabilities: ['files.browse']}, providers)).toEqual([]);
    // the play action (1.2): this app offers media.audio, and plays from any audio.library provider
    const audio = {'audio.library': [{satellite: 'Anything', version: 1, enabled: true, operations: {search: 's', track: 't', resolve: 'r', artwork: 'a'}}]};
    expect(contract.missingRequirements({client: ['media.audio'], capabilities: ['audio.library']}, audio)).toEqual([]);
    expect(contract.missingRequirements({client: ['media.audio'], capabilities: ['audio.library']}, {})).toEqual([
      {kind: 'capability', name: 'audio.library'},
    ]);
    expect(contract.missingRequirements({client: ['device.biometrics'], capabilities: ['media.gallery']}, providers)).toEqual([
      {kind: 'client', name: 'device.biometrics'},
      {kind: 'capability', name: 'media.gallery'},
    ]);
  });
});
