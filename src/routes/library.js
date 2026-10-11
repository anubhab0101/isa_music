// src/routes/library.js - Liked Library Routes
const express = require('express');
const { getDb } = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
const VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

// Handler for adding / updating a liked track
const handleLike = (req, res) => {
  try {
    const userId = req.user.id;
    const { videoId, title, artist, thumbnail } = req.body || {};

    if (!videoId || typeof videoId !== 'string' || !VIDEO_ID_REGEX.test(videoId.trim())) {
      return res.status(400).json({ error: 'Valid videoId is required' });
    }

    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'Title is required' });
    }

    const cleanVideoId = videoId.trim();
    const cleanTitle = title.trim().slice(0, 255);
    const cleanArtist = (typeof artist === 'string' && artist.trim())
      ? artist.trim().slice(0, 255)
      : 'Unknown Artist';
    const cleanThumbnail = (typeof thumbnail === 'string' && thumbnail.trim())
      ? thumbnail.trim().slice(0, 500)
      : `https://i.ytimg.com/vi/${cleanVideoId}/hqdefault.jpg`;

    const db = getDb();

    // Idempotent upsert
    const upsertStmt = db.prepare(`
      INSERT INTO liked_library (user_id, video_id, title, artist, thumbnail, liked_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, video_id) DO UPDATE SET
        title = excluded.title,
        artist = excluded.artist,
        thumbnail = excluded.thumbnail,
        liked_at = CURRENT_TIMESTAMP
    `);

    upsertStmt.run(userId, cleanVideoId, cleanTitle, cleanArtist, cleanThumbnail);

    const track = db.prepare(`
      SELECT video_id AS videoId, title, artist, thumbnail, liked_at AS likedAt
      FROM liked_library
      WHERE user_id = ? AND video_id = ?
    `).get(userId, cleanVideoId);

    return res.status(201).json({
      success: true,
      message: 'Track added to liked library',
      track: {
        videoId: track.videoId,
        title: track.title,
        artist: track.artist,
        thumbnail: track.thumbnail,
        likedAt: track.likedAt
      }
    });
  } catch (error) {
    console.error('[Library Like Error]:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// Handler for fetching user's liked library
const handleGetLibrary = (req, res) => {
  try {
    const userId = req.user.id;
    const db = getDb();

    const tracks = db.prepare(`
      SELECT id, video_id AS videoId, title, artist, thumbnail, liked_at AS likedAt
      FROM liked_library
      WHERE user_id = ?
      ORDER BY liked_at DESC
    `).all(userId);

    return res.status(200).json({
      success: true,
      tracks: tracks || []
    });
  } catch (error) {
    console.error('[Library Get Error]:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// Handler for unliking / removing a track
const handleUnlike = (req, res) => {
  try {
    const userId = req.user.id;
    const { videoId } = req.params;

    if (!videoId || !VIDEO_ID_REGEX.test(videoId.trim())) {
      return res.status(400).json({ error: 'Invalid videoId format' });
    }

    const cleanVideoId = videoId.trim();
    const db = getDb();

    const deleteStmt = db.prepare('DELETE FROM liked_library WHERE user_id = ? AND video_id = ?');
    const result = deleteStmt.run(userId, cleanVideoId);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Track not found in liked library' });
    }

    return res.status(200).json({
      success: true,
      message: 'Track removed from liked library'
    });
  } catch (error) {
    console.error('[Library Unlike Error]:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// Route definitions with aliasing
router.post('/like', authMiddleware, handleLike);
router.post('/', authMiddleware, handleLike);

router.get('/', authMiddleware, handleGetLibrary);
router.get('/liked', authMiddleware, handleGetLibrary);

router.delete('/unlike/:videoId', authMiddleware, handleUnlike);
router.delete('/like/:videoId', authMiddleware, handleUnlike);
router.delete('/:videoId', authMiddleware, handleUnlike);

module.exports = router;
