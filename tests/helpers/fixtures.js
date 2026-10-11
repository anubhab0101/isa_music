/**
 * Shared fixtures and test data generators for E2E and integration tests.
 */

function generateUniqueEmail(prefix = 'testuser') {
  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  return `${prefix}_${timestamp}_${randomSuffix}@example.com`;
}

const SAMPLE_TRACKS = [
  {
    videoId: 'dQw4w9WgXcQ',
    title: 'Never Gonna Give You Up',
    artist: 'Rick Astley',
    thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'
  },
  {
    videoId: 'kJQP7kiw5Fk',
    title: 'Despacito',
    artist: 'Luis Fonsi ft. Daddy Yankee',
    thumbnail: 'https://i.ytimg.com/vi/kJQP7kiw5Fk/hqdefault.jpg'
  },
  {
    videoId: '9bZkp7q19f0',
    title: 'Gangnam Style',
    artist: 'PSY',
    thumbnail: 'https://i.ytimg.com/vi/9bZkp7q19f0/hqdefault.jpg'
  },
  {
    videoId: 'fJ9rUzIMcZQ',
    title: 'Bohemian Rhapsody',
    artist: 'Queen',
    thumbnail: 'https://i.ytimg.com/vi/fJ9rUzIMcZQ/hqdefault.jpg'
  },
  {
    videoId: 'JGwWNGJdvx8',
    title: 'Shape of You',
    artist: 'Ed Sheeran',
    thumbnail: 'https://i.ytimg.com/vi/JGwWNGJdvx8/hqdefault.jpg'
  }
];

const VALID_VIDEO_IDS = [
  'dQw4w9WgXcQ',
  'kJQP7kiw5Fk',
  '9bZkp7q19f0',
  'fJ9rUzIMcZQ',
  'JGwWNGJdvx8'
];

const INVALID_VIDEO_IDS = [
  '',
  'abc',
  'too_long_video_id_12345',
  '../../../etc/passwd',
  'id;rm -rf /',
  'invalid!@#$%',
  '1234567890' // 10 chars, needs 11
];

const QUALITY_TIERS = ['high', 'medium', 'low', 'flac'];

module.exports = {
  generateUniqueEmail,
  SAMPLE_TRACKS,
  VALID_VIDEO_IDS,
  INVALID_VIDEO_IDS,
  QUALITY_TIERS
};
