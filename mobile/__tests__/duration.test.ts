import {durationLabel} from '../src/photo/duration';

describe('durationLabel', () => {
  it('formats seconds under a minute as 0:ss', () => {
    expect(durationLabel(5)).toBe('0:05');
  });

  it('formats minutes and seconds', () => {
    expect(durationLabel(65)).toBe('1:05');
  });

  it('formats hours when the clip is long enough', () => {
    expect(durationLabel(3661)).toBe('1:01:01');
  });

  it('returns empty for null, undefined or negative values', () => {
    expect(durationLabel(null)).toBe('');
    expect(durationLabel(undefined)).toBe('');
    expect(durationLabel(-1)).toBe('');
  });
});
