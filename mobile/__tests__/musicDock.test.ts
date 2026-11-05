import AsyncStorage from '@react-native-async-storage/async-storage';
import {setPlayerCollapsed} from '../src/media/ui/dock';

describe('the mini-player dock', () => {
  it('remembers whether the player is put away', async () => {
    setPlayerCollapsed(true);
    await Promise.resolve();
    expect(await AsyncStorage.getItem('starcore_music_player_collapsed')).toBe('1');
    setPlayerCollapsed(false);
    await Promise.resolve();
    expect(await AsyncStorage.getItem('starcore_music_player_collapsed')).toBe('0');
  });
});
