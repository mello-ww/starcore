import {accentMode} from '../src/media/ui/PlayerAccent';

// the player's accent preference, read as Mission Control reads it (media/theme.js)
describe('the player accent', () => {
  it('keeps a colour of its own, the cover, or the app accent', () => {
    expect(accentMode('#A1B2C3')).toBe('#a1b2c3');
    expect(accentMode(' artwork ')).toBe('artwork');
    expect(accentMode('starcore')).toBe('starcore');
  });

  it('follows the app accent for anything it does not know', () => {
    for (const value of [undefined, null, '', 'red', '#abc', '#12345g', 12]) {
      expect(accentMode(value)).toBe('starcore');
    }
  });
});
