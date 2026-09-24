import {daysRemaining} from '../src/photo/PhotoTrashTab';

describe('daysRemaining', () => {
  it('returns empty for a photo with no trashed_at', () => {
    expect(daysRemaining(null, 30)).toBe('');
    expect(daysRemaining(undefined, 30)).toBe('');
  });

  it('returns empty when retention_days is not known yet', () => {
    expect(daysRemaining(new Date().toISOString(), null)).toBe('');
  });

  it('counts down from the full retention period for a freshly trashed photo', () => {
    expect(daysRemaining(new Date().toISOString(), 30)).toBe('30 days left');
  });

  it('uses singular wording for exactly one day left', () => {
    const trashedAt = new Date(Date.now() - 29 * 86400000).toISOString();
    expect(daysRemaining(trashedAt, 30)).toBe('1 day left');
  });

  it('reports "Erasing soon" once the retention period has elapsed', () => {
    const trashedAt = new Date(Date.now() - 31 * 86400000).toISOString();
    expect(daysRemaining(trashedAt, 30)).toBe('Erasing soon');
  });

  it('falls back for an unparseable timestamp', () => {
    expect(daysRemaining('not-a-date', 30)).toBe('');
  });
});
