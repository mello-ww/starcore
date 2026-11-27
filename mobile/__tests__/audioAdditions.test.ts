import {additionRunner, linkAction, menuEntries, type AdditionDeps} from '../src/media/additions';
import type {UiAudio} from '../src/satellites/ui/contract';
import type {Track} from '../src/media/types';

/**
 * UI contract 1.2's change 9 on this app's side: what the audio host adds to its player from the
 * provider's document (`audio`), run with the playing track as $. - the same cases as Mission
 * Control's media.test.mjs.
 */

const track = {id: 't1', title: 'One', album_id: 'a1', artist_id: 'r1'} as unknown as Track;

const audio: UiAudio = {
  menu: [
    {label: 'Start radio', icon: 'activity', action: {play: {route: 'radio/track/{$.id}'}}},
    {label: 'Go to album', visible: '$.album_id', action: {navigate: 'album', params: {id: '$.album_id'}}},
    {label: 'Like', action: {route: 'favorites', method: 'POST', body: {id: '$.id', liked: true}, reloads: 'audio.session'}},
    {label: 'Away', action: {route: '../../api/auth/me', method: 'POST'}},
  ],
  album: {navigate: 'album', params: {id: '$.album_id'}},
  library: {label: 'Open Music', action: {navigate: 'home'}},
};

function fakeDeps(overrides: Partial<AdditionDeps> = {}) {
  const calls: any[] = [];
  const deps: AdditionDeps = {
    open: (page, params) => calls.push(['open', page, params]),
    play: async (tracks, options) => {
      calls.push(['play', tracks, options.context]);
      return Array.isArray(tracks) ? tracks.length : 0;
    },
    playSearch: async () => 0,
    load: async route => {
      calls.push(['load', route]);
      return {tracks: [{id: 'x'}, {id: 'y'}], context: 'radio:track:t1'};
    },
    post: async (route, body) => {
      calls.push(['post', route, body]);
      return {message: 'Done.'};
    },
    choose: async () => null,
    confirm: async () => true,
    reload: capability => {
      calls.push(['reload', capability]);
    },
    notify: (message, error) => calls.push(['notify', message, Boolean(error)]),
    ...overrides,
  };
  return {deps, calls};
}

describe('the audio host additions (UI contract 1.2, change 9)', () => {
  it('lists the menu entries whose visible holds, for the playing track', () => {
    expect(menuEntries(audio, track).map(entry => entry.label)).toEqual(['Start radio', 'Go to album', 'Like', 'Away']);
    const single = {...track, album_id: null} as unknown as Track;
    expect(menuEntries(audio, single).map(entry => entry.label)).not.toContain('Go to album');
    expect(menuEntries(null, track)).toEqual([]);
  });

  it('runs a link with the id the player shows standing in for the track own', async () => {
    const found = linkAction(audio, 'album', track, 'a2');
    expect(found?.track).toMatchObject({id: 't1', album_id: 'a2'});
    expect(linkAction(audio, 'artist', track, 'r1')).toBeNull();
    expect(linkAction(audio, 'album', track, null)).toBeNull();
    const {deps, calls} = fakeDeps();
    expect(await additionRunner(deps)(found!.action, found!.track)).toBe(true);
    expect(calls).toEqual([['open', 'album', {id: 'a2'}]]);
  });

  it('plays a route with its context, and posts with a message and a reload', async () => {
    const {deps, calls} = fakeDeps();
    const run = additionRunner(deps);
    expect(await run(audio.menu![0].action, track)).toBe(true);
    expect(calls[0]).toEqual(['load', 'radio/track/t1']);
    expect(calls[1]).toEqual(['play', [{id: 'x'}, {id: 'y'}], 'radio:track:t1']);
    calls.length = 0;
    expect(await run(audio.menu![2].action, track)).toBe(true);
    expect(calls).toEqual([
      ['post', 'favorites', {id: 't1', liked: true}],
      ['notify', 'Done.', false],
      ['reload', 'audio.session'],
    ]);
  });

  it('refuses a route outside its Satellite and says why', async () => {
    const {deps, calls} = fakeDeps();
    expect(await additionRunner(deps)(audio.menu![3].action, track)).toBe(false);
    expect(calls.filter(call => call[0] === 'post')).toEqual([]);
    expect(calls).toEqual([['notify', 'That action points outside its Satellite and was refused.', true]]);
  });

  it('shows the track folder from the path its route answers (change 18)', async () => {
    const located: string[] = [];
    const {deps, calls} = fakeDeps({
      load: async route => (route === 'tracks/t1?page=1' ? {location: '/music/a.flac'} : {}),
      locate: async path => located.push(path) > 0,
    });
    const action = {locate: '$.location', route: 'tracks/{$.id}?page=1'};
    expect(await additionRunner(deps)(action, track)).toBe(true);
    expect(located).toEqual(['/music/a.flac']);
    // a file the session can't browse answers no path; an outside route is refused
    expect(await additionRunner(deps)(action, {...track, id: 't2'} as Track)).toBe(false);
    expect(await additionRunner(deps)({locate: '$.location', route: '../api/x'}, track)).toBe(false);
    expect(located).toEqual(['/music/a.flac']);
    expect(calls.map(call => call[2])).toEqual([true, true]);
  });

  it('sends nothing when a confirm is declined, and notifies a failed request', async () => {
    const declined = fakeDeps({confirm: async () => false});
    expect(await additionRunner(declined.deps)({route: 'x', method: 'POST', confirm: 'Sure?'}, track)).toBe(false);
    expect(declined.calls).toEqual([]);
    const failing = fakeDeps({post: async () => Promise.reject(new Error('Nope.'))});
    expect(await additionRunner(failing.deps)({route: 'x', method: 'POST', reloads: 'audio.session'}, track)).toBe(false);
    expect(failing.calls).toEqual([['notify', 'Nope.', true]]);
  });
});
