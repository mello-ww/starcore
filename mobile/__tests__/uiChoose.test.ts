import {ApiError} from '../src/api/types';
import {chooseRows, runChoose, type ChooseAnswer, type ChooseDeps, type ChooseOffer} from '../src/satellites/ui/choose';
import type {UiAction} from '../src/satellites/ui/contract';
import {moveItem, shiftFor, targetIndex} from '../src/satellites/ui/reorder';

/**
 * UI contract 1.2's change 8 on this app's side: the choose action's flow (what it offers, what
 * it sends for a row and for a new one, how a 409 is asked) and a media-list's reorder
 * arithmetic - the same cases as Mission Control's choose.test.mjs and reorder.test.mjs.
 */

const action: UiAction = {
  choose: {
    source: 'playlists?editable=1',
    items: '$.playlists',
    item: {title: '$.name', subtitle: '$.line', image: 'playlists/{$.id}/picture?size=120'},
    title: 'Add to playlist',
    empty: 'No playlists yet.',
    create: {label: 'New playlist', field: 'Name', route: 'playlists', body: {name: '$value', tracks: ['$.id']}},
  },
  route: 'playlists/{$value.id}/add',
  body: {tracks: ['$.id'], ask: true},
  conflict: {
    confirm: 'This song is already in this playlist. Add it again?',
    body: {tracks: ['$.id'], allow_duplicates: true},
  },
  then: 'refresh',
};

const scope = {data: {id: 't1', title: 'One'}, page: {}, params: {}, state: {}};
const answer = {playlists: [{id: 4, name: 'Road', line: '3 songs'}, {id: 7, name: 'Late', line: '1 song'}]};

function depsWith(picked: (offer: ChooseOffer) => ChooseAnswer, fail?: Error, confirmed = true) {
  const sent: {route: string; body: any}[] = [];
  const asked: string[] = [];
  const offers: ChooseOffer[] = [];
  const deps: ChooseDeps = {
    load: async route => {
      expect(route).toBe('playlists?editable=1');
      return answer;
    },
    choose: async offer => {
      offers.push(offer);
      return picked(offer);
    },
    request: async (route, body) => {
      sent.push({route, body});
      if (fail && sent.length === 1) {
        throw fail;
      }
      return {message: 'Added.'};
    },
    confirm: async text => {
      asked.push(text);
      return confirmed;
    },
  };
  return {deps, sent, asked, offers};
}

const firstRow = (offer: ChooseOffer): ChooseAnswer => ({row: offer.rows[0].row});

describe('the choose action', () => {
  it('offers the source rows, with `$.` the source row', () => {
    const rows = chooseRows(action.choose!, answer, scope);
    expect(rows.map(row => [row.title, row.subtitle, row.image])).toEqual([
      ['Road', '3 songs', 'playlists/4/picture?size=120'],
      ['Late', '1 song', 'playlists/7/picture?size=120'],
    ]);
    expect(chooseRows(action.choose!, {}, scope)).toEqual([]);
    const outside = {...action.choose!, item: {title: '$.name', image: '/api/core/{$.id}'}};
    expect(chooseRows(outside, answer, scope)[0].image).toBeNull();
  });

  it('sends the chosen row as $value, `$.` staying the page row', async () => {
    const {deps, sent, offers} = depsWith(offer => ({row: offer.rows[1].row}));
    expect(await runChoose(action, scope, deps)).toEqual({result: {message: 'Added.'}});
    expect(sent).toEqual([{route: 'playlists/7/add', body: {tracks: ['t1'], ask: true}}]);
    expect(offers[0].title).toBe('Add to playlist');
    expect(offers[0].create).toEqual({label: 'New playlist', field: 'Name'});
  });

  it('sends a new one to the create route, the typed text as $value', async () => {
    const {deps, sent} = depsWith(() => ({create: 'Gym'}));
    await runChoose(action, scope, deps);
    expect(sent).toEqual([{route: 'playlists', body: {name: 'Gym', tracks: ['t1']}}]);
  });

  it('asks on a 409, then sends the conflict body', async () => {
    const {deps, sent, asked} = depsWith(firstRow, new ApiError('This song is already in Road.', 409));
    expect(await runChoose(action, scope, deps)).toEqual({result: {message: 'Added.'}});
    expect(asked).toEqual(['This song is already in this playlist. Add it again?']);
    expect(sent[1]).toEqual({route: 'playlists/4/add', body: {tracks: ['t1'], allow_duplicates: true}});
  });

  it('sends nothing more when the question is declined, or the sheet cancelled', async () => {
    const declined = depsWith(firstRow, new ApiError('Already there.', 409), false);
    expect(await runChoose(action, scope, declined.deps)).toBeNull();
    expect(declined.sent).toHaveLength(1);
    const cancelled = depsWith(() => null);
    expect(await runChoose(action, scope, cancelled.deps)).toBeNull();
    expect(cancelled.sent).toEqual([]);
  });

  it("throws any other error, and a 409 without `conflict`, as the route's own", async () => {
    const missing = depsWith(firstRow, new ApiError('Playlist not found.', 404));
    await expect(runChoose(action, scope, missing.deps)).rejects.toThrow('Playlist not found.');
    const plain: UiAction = {...action};
    delete plain.conflict;
    const already = depsWith(firstRow, new ApiError('Already there.', 409));
    await expect(runChoose(plain, scope, already.deps)).rejects.toThrow('Already there.');
    expect(already.asked).toEqual([]);
  });

  it('refuses a route outside the Satellite before sending anything', async () => {
    const outside = depsWith(firstRow);
    await expect(runChoose({...action, route: '/api/auth/{$value.id}'}, scope, outside.deps)).rejects.toThrow('refused');
    expect(outside.sent).toEqual([]);
  });
});

describe("a media-list's reorder", () => {
  it('moves an item to its final index, and moving back undoes it', () => {
    const items = ['a', 'b', 'c', 'd'];
    expect(moveItem(items, 0, 2)).toBe(true);
    expect(items).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(items, 2, 0)).toBe(true);
    expect(items).toEqual(['a', 'b', 'c', 'd']);
    expect(moveItem(items, 1, 1)).toBe(false);
    expect(moveItem(items, 9, 0)).toBe(false);
  });

  it('lands a dragged row where it is let go, within the list', () => {
    expect(targetIndex(1, 30, 56, 5)).toBe(2);
    expect(targetIndex(1, -200, 56, 5)).toBe(0);
    expect(targetIndex(1, 900, 56, 5)).toBe(4);
    expect(targetIndex(2, 40, 0, 5)).toBe(2);
  });

  it('steps the rows between aside', () => {
    expect([0, 1, 2, 3, 4].map(index => shiftFor(index, 1, 3, 56))).toEqual([0, 0, -56, -56, 0]);
    expect([0, 1, 2, 3, 4].map(index => shiftFor(index, 3, 1, 56))).toEqual([0, 56, 56, 0, 0]);
  });
});
