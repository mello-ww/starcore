import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Pressable, Text, TextInput} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {SatelliteUiScreen} from '../src/screens/SatelliteUiScreen';
import {StarSwitch} from '../src/components/StarSwitch';
import {checkDocument} from '../src/satellites/ui/contract';
import {askSecrets, bodyWithSecrets, revealFrom, secretPrompts} from '../src/satellites/ui/secrets';
import {emptyRow, formBody, formProblem, formValues} from '../src/satellites/ui/forms';

// Secrets, reveal and repeatable form rows (UI contract 1.2) on the app's shared screen: a
// protected document's action names what to ask, the app asks in its own prompt - twice for a new
// PIN - and the values go only into the one request's body, never into a form's values, storage or
// a log; a revealed field is shown once in the app's own dialog and gone once it closes. A rows
// field adds and removes rows, and a submit is refused while a row is incomplete.

const mockClient = {get: jest.fn(), post: jest.fn()};
jest.mock('../src/auth/AuthContext', () => ({
  useAuth: jest.fn(() => ({client: mockClient, state: {status: 'signed-in', session: {token: 'session-one'}}})),
}));
jest.mock('../src/servers/ServersContext', () => ({useServers: jest.fn(() => ({activeServer: {id: 'srv-1', baseUrl: 'https://s.test'}}))}));
jest.mock('../src/developer/DeveloperModeContext', () => ({useDeveloperMode: jest.fn(() => ({enabled: false}))}));
jest.mock('@react-navigation/native', () => ({useIsFocused: () => true}));
jest.mock('../src/platform/privacy', () => ({privacy: {evictImages: jest.fn(), setSecure: jest.fn()}}));
jest.mock('../src/platform/biometrics', () => ({biometricSigner: {}, biometrics: {}}));
jest.mock('../src/platform/secureStorage', () => ({secureStorage: {}}));
jest.mock('../src/satellites/ui/api', () => {
  const mocks = {document: jest.fn(), providers: jest.fn(), read: jest.fn(), act: jest.fn()};
  return {UiApi: jest.fn().mockImplementation(() => mocks), __mocks: mocks};
});
const {__mocks} = jest.requireMock('../src/satellites/ui/api') as {__mocks: Record<string, jest.Mock>};

const DOCUMENT = {
  contract: 'starcore.ui/1.2',
  title: 'Safe',
  entry: 'home',
  protected: {capability: 'media.vault', setup: 'home'},
  pages: {
    home: {
      source: {route: 'settings'},
      blocks: [
        {type: 'button', label: 'Change PIN', action: {route: 'pin', secrets: {current_pin: {kind: 'pin'}, pin: {kind: 'pin', new: true}}}},
        {type: 'button', label: 'New recovery key', action: {route: 'recovery_key', secrets: {pin: {kind: 'pin'}}, reveal: 'recovery_key'}},
        {
          type: 'form',
          id: 'discard',
          fields: [{key: 'run', label: 'Run', kind: 'text', value: '$.run'}],
          submit: {label: 'Delete backup', action: {route: 'discard', secrets: {pin: {kind: 'pin'}}}},
        },
        {
          type: 'form',
          id: 'folders',
          fields: [
            {
              key: 'folders', label: 'Folders', kind: 'rows', required: true, add: 'Add a folder', value: '$.folders',
              fields: [{key: 'path', label: 'Path', kind: 'text', required: true}, {key: 'name', label: 'Name', kind: 'text'}],
            },
          ],
          submit: {label: 'Save folders', action: {route: 'folders'}},
        },
      ],
    },
  },
};
const VAULT = {satellite: 'Safe', version: 1, enabled: true, operations: {status: 'status', unlock: 'unlock', lock: 'lock', keep: 'keep'}};
const OPEN = {configured: true, pin_set: true, unlocked: true, expires_at: 'later'};

const mounted: ReturnType<typeof renderer.create>[] = [];
async function mount() {
  const navigation = {setOptions: jest.fn(), setParams: jest.fn(), push: jest.fn(), navigate: jest.fn(), goBack: jest.fn()} as any;
  let tree!: ReturnType<typeof renderer.create>;
  await act(async () => {
    tree = renderer.create(<SatelliteUiScreen navigation={navigation} route={{params: {name: 'Safe', revision: 'r'}} as any} />);
  });
  mounted.push(tree);
  await settle();
  return tree;
}
const settle = async () => {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      jest.advanceTimersByTime(0);
      await Promise.resolve();
    });
  }
};
const texts = (tree: any): string[] => tree.root.findAllByType(Text).map((node: any) => [node.props.children].flat().join(''));
const byId = (tree: any, id: string) => tree.root.findAll((node: any) => node.props.testID === id && typeof node.type !== 'string');
const control = (tree: any, label: string) =>
  tree.root.findAll(
    (node: any) => node.type === Pressable && [node.props.accessibilityLabel, ...texts({root: node})].includes(label),
  )[0];
const press = async (tree: any, label: string) => {
  await act(async () => {
    control(tree, label).props.onPress();
  });
  await settle();
};
const input = (tree: any, label: string, index = 0) =>
  tree.root.findAllByType(TextInput).filter((node: any) => node.props.accessibilityLabel === label)[index];
async function typeSecret(tree: any, value: string) {
  await act(async () => byId(tree, 'secret-input')[0].props.onChangeText(value));
  await act(async () => byId(tree, 'secret-input')[0].props.onSubmitEditing());
  await settle();
}
async function everythingKept(): Promise<string> {
  const keys = await AsyncStorage.getAllKeys();
  return JSON.stringify(await AsyncStorage.multiGet(keys));
}

describe('secrets and reveal on the app’s shared screen', () => {
  let logs: jest.SpyInstance[];
  beforeEach(async () => {
    jest.useFakeTimers();
    await AsyncStorage.clear();
    Object.values(__mocks).forEach(mock => mock.mockReset());
    mockClient.get.mockReset();
    mockClient.post.mockReset();
    mockClient.get.mockImplementation(async (path: string) =>
      path === '/api/satellites/Safe/status' ? {status: 200, body: OPEN} : {status: 404, body: {}});
    mockClient.post.mockImplementation(async () => ({status: 200, body: {expires_at: 'later'}}));
    __mocks.document.mockResolvedValue({document: DOCUMENT, revision: 'r', offline: false});
    __mocks.providers.mockResolvedValue({'media.vault': [VAULT]});
    __mocks.read.mockImplementation(async (_satellite: string, route: string) =>
      route === 'settings' ? {run: 'r1', folders: [{path: '/srv/a', name: 'A'}]} : {});
    __mocks.act.mockResolvedValue({message: 'Done.'});
    logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map(level => jest.spyOn(console, level));
  });
  afterEach(() => {
    logs.forEach(spy => spy.mockRestore());
    mounted.splice(0).forEach(tree => act(() => tree.unmount()));
    act(() => jest.runOnlyPendingTimers()); // the gate closes after the last screen leaves
    jest.useRealTimers();
  });
  const logged = () => JSON.stringify(logs.map(spy => spy.mock.calls));

  it('asks in its own prompt - a new PIN twice - and sends the values only in the request body', async () => {
    const tree = await mount();
    await press(tree, 'Change PIN');
    expect(texts(tree)).toContain('Enter your PIN');
    expect(texts(tree)).toContain('Safe asks for your PIN to do this.');
    await typeSecret(tree, '1111');
    expect(texts(tree)).toContain('Choose a new PIN');
    await typeSecret(tree, '2222');
    expect(texts(tree)).toContain('Enter the new PIN again');
    await typeSecret(tree, '3333'); // not the same: from the start of the new PIN again
    expect(texts(tree)).toContain("The two PINs don't match. Try again.");
    await typeSecret(tree, '2222');
    await typeSecret(tree, '2222');
    expect(__mocks.act).toHaveBeenCalledWith('Safe', 'pin', 'POST', {current_pin: '1111', pin: '2222'});
    expect(byId(tree, 'secret-prompt')).toHaveLength(0);
    expect(texts(tree).join(' ')).not.toMatch(/1111|2222/);
    expect(await everythingKept()).not.toMatch(/1111|2222/);
    expect(logged()).not.toMatch(/1111|2222/);
  });

  it('asks the store’s status again after an action, and shows the unlock card once it is locked', async () => {
    const tree = await mount();
    const asked = () => mockClient.get.mock.calls.filter(([path]: [string]) => path === '/api/satellites/Safe/status').length;
    const before = asked();
    // a new PIN ends every unlock on the server
    mockClient.get.mockImplementation(async (path: string) =>
      path === '/api/satellites/Safe/status' ? {status: 200, body: {...OPEN, unlocked: false}} : {status: 404, body: {}});
    await press(tree, 'Change PIN');
    await typeSecret(tree, '1111');
    await typeSecret(tree, '2222');
    await typeSecret(tree, '2222');
    await settle();
    expect(asked()).toBe(before + 1);
    expect(texts(tree)).not.toContain('Change PIN');
  });

  it('sends nothing when a prompt is cancelled', async () => {
    const tree = await mount();
    await press(tree, 'Change PIN');
    await typeSecret(tree, '1111');
    await press(tree, 'Cancel');
    expect(byId(tree, 'secret-prompt')).toHaveLength(0);
    expect(__mocks.act).not.toHaveBeenCalled();
  });

  it('keeps a secret out of the form it is sent with', async () => {
    const tree = await mount();
    await press(tree, 'Delete backup');
    await typeSecret(tree, '2468');
    expect(__mocks.act).toHaveBeenCalledWith('Safe', 'discard', 'POST', {run: 'r1', pin: '2468'});
    expect(input(tree, 'Run').props.value).toBe('r1');
    expect(tree.root.findAllByType(TextInput).map((node: any) => node.props.value)).not.toContain('2468');
    expect(await everythingKept()).not.toContain('2468');
    expect(logged()).not.toContain('2468');
  });

  it('shows a revealed field once, in its own dialog, and it is gone after closing', async () => {
    __mocks.act.mockResolvedValue({recovery_key: 'ABCD-EFGH-1234', message: 'A new recovery key.'});
    const tree = await mount();
    await press(tree, 'New recovery key');
    await typeSecret(tree, '2468');
    expect(byId(tree, 'secret-reveal')).toHaveLength(1);
    expect(texts(tree)).toContain('ABCD-EFGH-1234');
    expect(texts(tree)).not.toContain('A new recovery key.'); // nothing else before it is stored
    expect(control(tree, 'Done').props.disabled).toBe(true);
    const stored = tree.root.findAllByType(StarSwitch).find((node: any) => node.props.accessibilityLabel === "I've stored it somewhere safe")!;
    await act(async () => stored.props.onValueChange(true));
    await press(tree, 'Done');
    expect(byId(tree, 'secret-reveal')).toHaveLength(0);
    expect(texts(tree).join(' ')).not.toContain('ABCD-EFGH');
    expect(texts(tree)).toContain('A new recovery key.');
    expect(await everythingKept()).not.toContain('ABCD-EFGH');
    expect(logged()).not.toContain('ABCD-EFGH');
  });

  it('adds and removes rows, and refuses a submit with a row incomplete', async () => {
    const tree = await mount();
    expect(input(tree, 'Path').props.value).toBe('/srv/a');
    await press(tree, 'Add a folder');
    expect(tree.root.findAllByType(TextInput).filter((node: any) => node.props.accessibilityLabel === 'Path')).toHaveLength(2);
    await press(tree, 'Save folders');
    expect(texts(tree)).toContain('Folders, row 2: Path is required.');
    expect(__mocks.act).not.toHaveBeenCalled();
    await act(async () => input(tree, 'Path', 1).props.onChangeText('/srv/b'));
    await press(tree, 'Remove row 1');
    await press(tree, 'Save folders');
    expect(__mocks.act).toHaveBeenCalledWith('Safe', 'folders', 'POST', {folders: [{path: '/srv/b', name: ''}]});
  });

  it('refuses a rows field with no row when it is required', async () => {
    const tree = await mount();
    await press(tree, 'Remove row 1');
    expect(texts(tree)).toContain('None yet.');
    await press(tree, 'Save folders');
    expect(texts(tree)).toContain('Folders needs at least one row.');
    expect(__mocks.act).not.toHaveBeenCalled();
  });
});

describe('the secret and form rules (pure)', () => {
  it('asks only for kinds it knows, a new PIN twice', async () => {
    expect(secretPrompts({password: {kind: 'password'}})).toBeNull();
    expect(secretPrompts({key: {kind: 'recovery-key', new: true}})).toEqual([{key: 'key', kind: 'recovery-key', isNew: false}]);
    const answers = ['1', '2', '2'];
    const asked: any[] = [];
    const values = await askSecrets({a: {kind: 'pin'}, b: {kind: 'pin', new: true}}, async ask => {
      asked.push(ask);
      return answers.shift() ?? null;
    });
    expect(values).toEqual({a: '1', b: '2'});
    expect(asked.map(ask => [ask.isNew, ask.again])).toEqual([[false, false], [true, false], [true, true]]);
    expect(bodyWithSecrets({run: 'r'}, {pin: '1'})).toEqual({run: 'r', pin: '1'});
    expect(await revealFrom({k: 'S', ok: true}, 'k', async () => undefined)).toEqual({ok: true});
  });

  it('refuses secrets outside a protected document', () => {
    const plain = (action: any) => ({contract: 'starcore.ui/1.2', entry: 'home', pages: {home: {blocks: [{type: 'button', label: 'Go', action}]}}});
    expect(checkDocument(plain({route: 'pin', secrets: {pin: {kind: 'pin'}}}))).toMatch(/isn't protected/);
    expect(checkDocument(plain({route: 'key', reveal: 'recovery_key'}))).toMatch(/isn't protected/);
    expect(checkDocument(DOCUMENT)).toBeNull();
    expect(checkDocument({...DOCUMENT, pages: {home: {blocks: [{type: 'button', label: 'Go', action: {route: 'pin', secrets: {pin: {kind: 'password'}}}}]}}}))
      .toMatch(/doesn't know/);
  });

  it('copies rows in and out', () => {
    const fields = [{key: 'f', label: 'F', kind: 'rows', value: '$.f', fields: [{key: 'p', label: 'P', kind: 'text'}, {key: 'on', label: 'On', kind: 'toggle'}]}];
    const data = {f: [{p: 'x'}, 'junk']};
    const values = formValues(fields, {data});
    expect(values).toEqual({f: [{p: 'x', on: false}]});
    values.f[0].p = 'y';
    expect(data.f[0]).toEqual({p: 'x'});
    expect(emptyRow(fields[0].fields)).toEqual({p: '', on: false});
    expect(formBody(values).f[0]).not.toBe(values.f[0]);
    expect(formProblem([{...fields[0], required: true}], {f: []})).toBe('F needs at least one row.');
  });
});
