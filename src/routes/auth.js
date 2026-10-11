// src/routes/auth.js - Authentication Routes
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb } = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'isa_music_super_secret_jwt_key_2026_dev_env_change_in_prod';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Handler for user registration
const handleRegister = async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const cleanEmail = email.trim();

    if (!EMAIL_REGEX.test(cleanEmail) || cleanEmail.length > 254) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    if (password.length > 128) {
      return res.status(400).json({ error: 'Password exceeds maximum length of 128 characters' });
    }

    const db = getDb();

    // Check if email already registered (SQLite COLLATE NOCASE handles case-insensitivity)
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);
    if (existing) {
      return res.status(409).json({ error: 'Email is already registered' });
    }

    // Hash password with 10 salt rounds
    const passwordHash = await bcrypt.hash(password, 10);

    // Insert user
    const insertStmt = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)');
    const result = insertStmt.run(cleanEmail, passwordHash);
    const userId = Number(result.lastInsertRowid);

    // Generate JWT token
    const token = jwt.sign(
      { id: userId, email: cleanEmail },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    return res.status(201).json({
      success: true,
      message: 'User registered successfully',
      user: {
        id: userId,
        email: cleanEmail
      },
      token
    });
  } catch (error) {
    if (error.message && error.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'Email is already registered' });
    }
    console.error('[Auth Register Error]:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// Handler for user login
const handleLogin = async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const cleanEmail = email.trim();
    if (!cleanEmail || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const db = getDb();
    const user = db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get(cleanEmail);

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { id: Number(user.id), email: user.email },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    return res.status(200).json({
      success: true,
      message: 'Login successful',
      user: {
        id: Number(user.id),
        email: user.email
      },
      token
    });
  } catch (error) {
    console.error('[Auth Login Error]:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// Handler for user profile verification
const handleMe = (req, res) => {
  try {
    const db = getDb();
    const user = db.prepare('SELECT id, email, created_at FROM users WHERE id = ?').get(req.user.id);

    if (!user) {
      return res.status(401).json({ error: 'User no longer exists' });
    }

    return res.status(200).json({
      success: true,
      user: {
        id: Number(user.id),
        email: user.email
      }
    });
  } catch (error) {
    console.error('[Auth Me Error]:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// Route definitions with aliasing
router.post('/register', handleRegister);
router.post('/auth/register', handleRegister);

router.post('/login', handleLogin);
router.post('/auth/login', handleLogin);

router.get('/me', authMiddleware, handleMe);
router.get('/auth/me', authMiddleware, handleMe);

module.exports = router;
