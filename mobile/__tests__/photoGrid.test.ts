import {dateLabel, toSections} from '../src/photo/PhotoGrid';
import type {Photo} from '../src/photo/types';

function photo(id: string, captured_at: string | null, imported_at = captured_at ?? '2024-01-01T00:00:00'): Photo {
  return {
    id,
    filename: `${id}.jpg`,
    path: `photos/${id}.jpg`,
    size: 10,
    width: 10,
    height: 10,
    format: 'jpeg',
    media_type: 'photo',
    duration: null,
    imported_at,
    captured_at,
    metadata: {
      camera_make: null,
      camera_model: null,
      lens_model: null,
      focal_length: null,
      aperture: null,
      shutter_speed: null,
      iso: null,
      orientation: null,
      gps_latitude: null,
      gps_longitude: null,
      gps_coordinates: null,
      megapixels: null,
    },
  };
}

describe('dateLabel', () => {
  it('formats a valid ISO timestamp as a readable date', () => {
    expect(dateLabel('2024-05-17T09:14:03')).toContain('2024');
  });

  it('falls back for an unparseable value', () => {
    expect(dateLabel('not-a-date')).toBe('Unknown date');
  });
});

describe('toSections', () => {
  it('chunks a flat list into rows of 3 when not grouping by date', () => {
    const photos = [photo('a', null), photo('b', null), photo('c', null), photo('d', null)];

    const sections = toSections(photos, false);

    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBe('');
    expect(sections[0].data.map(row => row.length)).toEqual([3, 1]);
  });

  it('groups consecutive same-day photos into one section', () => {
    const photos = [
      photo('a', '2024-05-17T09:00:00'),
      photo('b', '2024-05-17T10:00:00'),
      photo('c', '2024-05-16T08:00:00'),
    ];

    const sections = toSections(photos, true);

    expect(sections).toHaveLength(2);
    expect(sections[0].data.flat().map(p => p.id)).toEqual(['a', 'b']);
    expect(sections[1].data.flat().map(p => p.id)).toEqual(['c']);
  });

  it('returns an empty list of sections for no photos', () => {
    expect(toSections([], true)).toEqual([]);
  });
});
