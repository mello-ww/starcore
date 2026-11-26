import {dragOffset} from '../src/navigation/PagerTabs';

// the main tabs' pages follow the finger like a launcher's home screens

describe('dragging the pages', () => {
  const width = 400;

  it('sits at the page shown before the finger moves past the swipe margin', () => {
    expect(dragOffset(1, 3, width, 0)).toBe(-400);
    expect(dragOffset(1, 3, width, 20)).toBe(-400);
  });

  it('follows the finger once the swipe is claimed', () => {
    expect(dragOffset(1, 3, width, -124)).toBe(-500);
    expect(dragOffset(1, 3, width, 124)).toBe(-300);
  });

  it('gives way only a little past either end', () => {
    expect(dragOffset(0, 3, width, 124)).toBe(25);
    expect(dragOffset(2, 3, width, -124)).toBe(-825);
  });
});
