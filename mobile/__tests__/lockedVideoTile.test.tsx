import React from 'react';
import renderer, {act} from 'react-test-renderer';

jest.mock('../src/lockedFolder/PrivateImage', () => {
  const {useEffect} = require('react');
  return {
    PrivateImage: ({onLoaded}: {onLoaded?: () => void}) => {
      useEffect(() => onLoaded?.(), [onLoaded]);
      return null;
    },
  };
});

import {VideoTile} from '../src/photo/LockedFolderTab';

function texts(tree: ReturnType<typeof renderer.create>): string[] {
  return tree.root.findAllByType(require('react-native').Text).map((node: {props: {children: unknown}}) => String(node.props.children));
}

describe('Locked Folder video tile', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  async function mount(response: unknown) {
    const fetchMock = jest.fn().mockResolvedValue(response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    let tree!: ReturnType<typeof renderer.create>;
    await act(async () => {
      tree = renderer.create(<VideoTile thumbnailUrl="http://s/thumb" durationUrl="http://s/duration" token="t" />);
    });
    return {tree, fetchMock};
  }

  it('shows the length once the server has rendered the video', async () => {
    const {tree, fetchMock} = await mount({ok: true, json: async () => ({duration: 75})});
    expect(fetchMock).toHaveBeenCalledWith('http://s/duration', {headers: {Authorization: 'Bearer t'}});
    expect(texts(tree)).toContain('1:15');
  });

  it('shows just the play badge when there is no length', async () => {
    const {tree} = await mount({ok: false, json: async () => ({})});
    expect(texts(tree).filter(text => /d:dd/.test(text))).toEqual([]);
  });
});
