import test from 'node:test';
import assert from 'node:assert/strict';
import { storedObjectsForProfile } from '../api/delete-account.js';

const userId = '11111111-1111-4111-8111-111111111111';
const supabaseUrl = 'https://project.supabase.co';

test('account deletion includes every owned profile upload', () => {
  const objects = storedObjectsForProfile({
    video_path: `${userId}/coffee-showcase.mp4`,
    avatar_url: `${supabaseUrl}/storage/v1/object/public/cafe-images/${userId}/profile.jpg?v=2`,
    bar_picture_url: `${supabaseUrl}/storage/v1/object/public/cafe-images/${userId}/bar.webp`,
  }, userId, supabaseUrl);

  assert.deepEqual(objects, [
    ['coffee-videos', `${userId}/coffee-showcase.mp4`],
    ['cafe-images', `${userId}/profile.jpg`],
    ['cafe-images', `${userId}/bar.webp`],
  ]);
});

test('account deletion never targets another member upload or an external URL', () => {
  const otherUserId = '22222222-2222-4222-8222-222222222222';
  const objects = storedObjectsForProfile({
    video_path: `${otherUserId}/coffee-showcase.mp4`,
    avatar_url: `${supabaseUrl}/storage/v1/object/public/cafe-images/${otherUserId}/avatar.jpg`,
    bar_picture_url: `https://example.com/storage/v1/object/public/cafe-images/${userId}/bar.jpg`,
  }, userId, supabaseUrl);

  assert.deepEqual(objects, []);
});

test('account deletion removes a duplicated image only once', () => {
  const image = `${supabaseUrl}/storage/v1/object/public/cafe-images/${userId}/profile.jpg`;
  const objects = storedObjectsForProfile({ avatar_url: image, bar_picture_url: image }, userId, supabaseUrl);
  assert.deepEqual(objects, [['cafe-images', `${userId}/profile.jpg`]]);
});
