/**
 * Regression tests for Photo's automatic sync wiring at app start:
 *
 * - index.js must register the Headless JS task (so Android can run a
 *   periodic sync with no UI mounted) exactly once, and must still import
 *   react-native-gesture-handler before anything else.
 * - App.tsx must configure the periodic schedule and run one foreground
 *   sync pass once per app start, not on every re-render.
 *
 * Both were accidentally dropped once while adding the gesture-handler
 * setup, which nothing caught - hence these tests.
 */
import React from 'react';
import renderer, {act} from 'react-test-renderer';

// records the order in which index.js's imports are first evaluated
const mockImportOrder: string[] = [];

jest.mock('react-native-gesture-handler', () => {
  mockImportOrder.push('react-native-gesture-handler');
  const {View} = require('react-native');
  return {GestureHandlerRootView: View};
});

jest.mock('react-native-background-fetch', () => {
  mockImportOrder.push('react-native-background-fetch');
  return {
    __esModule: true,
    default: {
      registerHeadlessTask: jest.fn(),
      configure: jest.fn(() => Promise.resolve(0)),
      finish: jest.fn(),
      stop: jest.fn(() => Promise.resolve()),
    },
  };
});

jest.mock('../src/photo/backgroundSyncTask', () => ({
  backgroundFetchHeadlessTask: jest.fn(),
  configureBackgroundFetch: jest.fn(() => Promise.resolve()),
  triggerForegroundSync: jest.fn(),
}));

// App's own provider tree isn't under test here - each is replaced by a
// pass-through, with ServersContext reporting "still loading" so ServersGate
// renders nothing
jest.mock('../src/servers/ServersContext', () => ({
  ServersProvider: ({children}: {children: React.ReactNode}) => children,
  useServers: () => ({loading: true}),
}));
jest.mock('../src/auth/AuthContext', () => ({
  AuthProvider: ({children}: {children: React.ReactNode}) => children,
}));
jest.mock('../src/navigation/RootNavigator', () => ({RootNavigator: () => null}));
jest.mock('../src/navigation/OnboardingNavigator', () => ({OnboardingNavigator: () => null}));

type EntryModules = {
  BackgroundFetch: {registerHeadlessTask: jest.Mock};
  sync: {
    backgroundFetchHeadlessTask: jest.Mock;
    configureBackgroundFetch: jest.Mock;
    triggerForegroundSync: jest.Mock;
  };
  registerComponent: jest.SpyInstance;
};

describe('index.js', () => {
  beforeEach(() => {
    mockImportOrder.length = 0;
  });

  /** Evaluates index.js in a fresh module registry, so each test sees its
   * top-level side effects (and every mock) exactly once. Nothing is
   * rendered here, so the separate React copy this loads is never used. */
  function loadEntry(): EntryModules {
    let loaded!: EntryModules;
    jest.isolateModules(() => {
      const {AppRegistry} = require('react-native');
      const registerComponent = jest.spyOn(AppRegistry, 'registerComponent').mockImplementation(() => 'StarCore');
      require('../index');
      loaded = {
        BackgroundFetch: require('react-native-background-fetch').default,
        sync: require('../src/photo/backgroundSyncTask'),
        registerComponent,
      };
    });
    return loaded;
  }

  it('registers the background sync headless task exactly once', () => {
    const {BackgroundFetch, sync} = loadEntry();

    expect(BackgroundFetch.registerHeadlessTask).toHaveBeenCalledTimes(1);
    expect(BackgroundFetch.registerHeadlessTask).toHaveBeenCalledWith(sync.backgroundFetchHeadlessTask);
  });

  it('still registers the app component', () => {
    const {registerComponent} = loadEntry();

    expect(registerComponent).toHaveBeenCalledTimes(1);
    expect(registerComponent.mock.calls[0][0]).toBe(require('../app.json').name);
  });

  it('imports react-native-gesture-handler before anything else', () => {
    loadEntry();

    expect(mockImportOrder[0]).toBe('react-native-gesture-handler');
    expect(mockImportOrder).toContain('react-native-background-fetch');
  });

  it('does not start a sync pass by itself', () => {
    const {sync} = loadEntry();

    // starting sync is App's job, once mounted - the entry file only
    // registers the headless task
    expect(sync.configureBackgroundFetch).not.toHaveBeenCalled();
    expect(sync.triggerForegroundSync).not.toHaveBeenCalled();
  });
});

describe('App startup', () => {
  // not isolated: App must share the test renderer's own React instance
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function renderApp() {
    const App = require('../src/App').default as React.ComponentType;
    let tree: any;
    act(() => {
      tree = renderer.create(<App />);
    });
    return {
      App,
      tree,
      BackgroundFetch: require('react-native-background-fetch').default as {registerHeadlessTask: jest.Mock},
      sync: require('../src/photo/backgroundSyncTask') as {
        configureBackgroundFetch: jest.Mock;
        triggerForegroundSync: jest.Mock;
      },
    };
  }

  it('configures background fetch and runs one foreground sync on mount', () => {
    const {sync} = renderApp();

    expect(sync.configureBackgroundFetch).toHaveBeenCalledTimes(1);
    expect(sync.triggerForegroundSync).toHaveBeenCalledTimes(1);
  });

  it('does not re-trigger sync when App re-renders', () => {
    const {App, tree, sync} = renderApp();

    act(() => {
      tree.update(<App />);
    });
    act(() => {
      tree.update(<App />);
    });

    expect(sync.configureBackgroundFetch).toHaveBeenCalledTimes(1);
    expect(sync.triggerForegroundSync).toHaveBeenCalledTimes(1);
  });

  it('never registers the headless task itself (index.js owns that)', () => {
    const {BackgroundFetch} = renderApp();

    expect(BackgroundFetch.registerHeadlessTask).not.toHaveBeenCalled();
  });
});
