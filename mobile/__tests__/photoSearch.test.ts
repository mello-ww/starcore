import {matches} from '../src/photo/PhotoSearchTab';
import type {Photo} from '../src/photo/types';

function photo(overrides: Partial<Photo> = {}): Photo {
  return {
    id: 'abc123',
    filename: 'holiday.jpg',
    path: 'photos/ab/abc123.jpg',
    size: 1024,
    width: 100,
    height: 100,
    format: 'jpeg',
    media_type: 'photo',
    duration: null,
    imported_at: '2024-01-01T00:00:00',
    captured_at: '2024-01-01T00:00:00',
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
    ...overrides,
  };
}

describe('matches', () => {
  it('matches on filename, case-insensitively', () => {
    expect(matches(photo({filename: 'Holiday-Trip.JPG'}), 'holiday')).toBe(true);
    expect(matches(photo({filename: 'Holiday-Trip.JPG'}), 'birthday')).toBe(false);
  });

  it('matches on camera make/model', () => {
    const withCamera = photo({
      metadata: {...photo().metadata, camera_make: 'Canon', camera_model: 'EOS R5'},
    });
    expect(matches(withCamera, 'canon')).toBe(true);
    expect(matches(withCamera, 'eos r5')).toBe(true);
  });

  it('matches on capture date', () => {
    expect(matches(photo({captured_at: '2024-05-17T09:14:03'}), '2024-05-17')).toBe(true);
  });

  it('does not match a photo with none of the fields present', () => {
    const bare = photo({filename: 'img.png', captured_at: null});
    expect(matches(bare, 'canon')).toBe(false);
  });
});
