import React from 'react';
import {Text} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {UiBlocks, type BlockContext} from '../src/satellites/ui/UiBlocks';
import {createListPaging} from '../src/satellites/ui/listPaging';
import type {UiBlock} from '../src/satellites/ui/contract';

// a list that arrives page by page (UI contract 1.2 `more`): the same rules as Mission
// Control's (mission_control/tests/listpaging.test.mjs), then the block on screen

const block: UiBlock = {
  type: 'list', items: '$.files', item: {title: '$.name'},
  more: {route: 'view?path={$params.path}&part=files&cursor={$value}', cursor: '$.files_next'},
};
const scope = (data: any, path = '/srv') => ({data, page: data, params: {path}, state: {}});

function server(answers: any[]) {
  const asked: string[] = [];
  return {
    asked,
    load: jest.fn((route: string) => {
      asked.push(route);
      const answer = answers.shift();
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    }),
  };
}

describe('list paging', () => {
  it('asks for each page with the cursor the provider gave, until it gives none', async () => {
    const host = server([{files: [{name: 'c'}], files_next: 'c'}, {files: [{name: 'd'}], files_next: null}]);
    const paging = createListPaging(host);
    const first = scope({files: [{name: 'a'}, {name: 'b'}], files_next: 'b'});
    expect(paging.rows(block, first).map(row => row.name)).toEqual(['a', 'b']);
    expect((await paging.loadMore(block)).map(row => row.name)).toEqual(['c']);
    expect((await paging.loadMore(block)).map(row => row.name)).toEqual(['d']);
    expect(host.asked).toEqual(['view?path=%2Fsrv&part=files&cursor=b', 'view?path=%2Fsrv&part=files&cursor=c']);
    expect(paging.status(block).more).toBe(false);
    expect(paging.rows(block, first).map(row => row.name)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('never shows a row twice, and the same cursor again ends the list', async () => {
    const paging = createListPaging(server([{files: [{name: 'b'}, {name: 'c'}], files_next: 'b'}]));
    paging.rows(block, scope({files: [{name: 'a'}, {name: 'b'}], files_next: 'b'}));
    expect((await paging.loadMore(block)).map(row => row.name)).toEqual(['c']);
    expect(paging.status(block).more).toBe(false);
  });

  it('drops a page that arrives after the list changed', async () => {
    let release!: (value: any) => void;
    const paging = createListPaging({load: () => new Promise(resolve => (release = resolve))});
    paging.rows(block, scope({files: [{name: 'a'}], files_next: 'a'}, '/one'));
    const pending = paging.loadMore(block);
    const other = scope({files: [{name: 'x'}], files_next: null}, '/two');
    paging.rows(block, other);
    release({files: [{name: 'late'}], files_next: 'late'});
    expect(await pending).toEqual([]);
    expect(paging.rows(block, other).map(row => row.name)).toEqual(['x']);
  });

  it('loads back as many pages after a refresh of the same list', async () => {
    const paging = createListPaging(server([{files: [{name: 'b'}], files_next: 'b'}, {files: [{name: 'b'}], files_next: 'b'}]));
    paging.rows(block, scope({files: [{name: 'a'}], files_next: 'a'}));
    await paging.loadMore(block);
    paging.rows(block, scope({files: [{name: 'a'}], files_next: 'a'}));
    expect(paging.status(block).restoring).toBe(true);
    await paging.loadMore(block);
    expect(paging.status(block).restoring).toBe(false);
  });

  it('never asks for a page outside the Satellite', async () => {
    const host = server([]);
    const paging = createListPaging(host);
    const outside = {...block, more: {route: '../other?cursor={$value}', cursor: '$.next'}};
    paging.rows(outside, scope({files: [{name: 'a'}], next: 'a'}));
    expect(await paging.loadMore(outside)).toEqual([]);
    expect(host.asked).toEqual([]);
    expect(paging.status(outside).error).toMatch(/outside/);
  });
});

describe('a paged list on screen', () => {
  function context(load: jest.Mock): BlockContext & {nearEnd: () => void} {
    const listeners = new Set<() => void>();
    return {
      developer: false,
      providers: {},
      runAction: jest.fn(async () => true),
      readCapability: jest.fn(),
      forms: {},
      setEditing: () => {},
      load,
      onNearEnd: listener => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      nearEnd: () => listeners.forEach(listener => listener()),
    };
  }
  const texts = (tree: ReturnType<typeof renderer.create>) =>
    tree.root.findAllByType(Text).map((node: any) => [node.props.children].flat().join(''));

  function mount(data: any, ctx: BlockContext) {
    let tree!: ReturnType<typeof renderer.create>;
    act(() => {
      tree = renderer.create(<UiBlocks blocks={[block]} scope={scope(data)} context={ctx} />);
    });
    return tree;
  }

  it('loads the next page near the end of the screen, then offers no more', async () => {
    const load = jest.fn(async () => ({files: [{name: 'b'}], files_next: null}));
    const ctx = context(load);
    const tree = mount({files: [{name: 'a'}], files_next: 'a'}, ctx);
    expect(texts(tree)).toContain('a');
    expect(tree.root.findAllByProps({testID: 'list-more'})).not.toHaveLength(0);
    await act(async () => {
      ctx.nearEnd();
    });
    expect(load).toHaveBeenCalledWith('view?path=%2Fsrv&part=files&cursor=a');
    expect(texts(tree)).toEqual(expect.arrayContaining(['a', 'b']));
    expect(tree.root.findAllByProps({testID: 'list-more'})).toHaveLength(0);
  });

  it('asks for the next page as soon as one arrives when the screen reached its end meanwhile', async () => {
    let release!: (value: any) => void;
    const load = jest.fn()
      .mockImplementationOnce(() => new Promise(resolve => (release = resolve)))
      .mockResolvedValueOnce({files: [{name: 'c'}], files_next: null});
    const ctx = context(load);
    const tree = mount({files: [{name: 'a'}], files_next: 'a'}, ctx);
    await act(async () => {
      ctx.nearEnd(); // asks for page 2
    });
    await act(async () => {
      ctx.nearEnd(); // the end again while page 2 is on its way: no scroll event will follow
    });
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => {
      release({files: [{name: 'b'}], files_next: 'b'});
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenLastCalledWith('view?path=%2Fsrv&part=files&cursor=b');
    expect(texts(tree)).toEqual(expect.arrayContaining(['a', 'b', 'c']));
  });

  it('says why a page failed, and tries again on request', async () => {
    const load = jest.fn().mockRejectedValueOnce(new Error('Server unreachable')).mockResolvedValueOnce({files: [{name: 'b'}], files_next: null});
    const ctx = context(load);
    const tree = mount({files: [{name: 'a'}], files_next: 'a'}, ctx);
    await act(async () => {
      tree.root.findByProps({accessibilityLabel: 'Show more'}).props.onPress();
    });
    expect(texts(tree)).toContain('Server unreachable');
    await act(async () => {
      tree.root.findByProps({accessibilityLabel: 'Try again'}).props.onPress();
    });
    expect(texts(tree)).toContain('b');
    expect(texts(tree)).not.toContain('Server unreachable');
  });
});
