// src/middleware/auth.js - Authentication & JWT Middleware
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const SALT_ROUNDS = 10;
const JWT_SECRET = process.env.JWT_SECRET || 'isa_music_super_secret_jwt_key_2026_dev_env_change_in_prod';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

/**
 * Hashes a plain text password using bcryptjs with 10 salt rounds.
 */
async function hashPassword(plainPassword) {
  if (!plainPassword || typeof plainPassword !== 'string') {
    throw new Error('Password must be a non-empty string');
  }
  return bcrypt.hash(plainPassword, SALT_ROUNDS);
}

/**
 * Compares a plain text password against a bcrypt hash.
 */
async function comparePassword(plainPassword, hashedPassword) {
  if (!plainPassword || !hashedPassword) return false;
  return bcrypt.compare(plainPassword, hashedPassword);
}

/**
 * Issues a signed JWT token containing user id and email.
 */
function generateToken(user) {
  const payload = {
    id: user.id,
    email: user.email
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * Verifies a JWT token.
 */
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

/**
 * Express middleware to authenticate requests via Bearer token.
 * Attaches verified user object { id, email } to req.user.
 */
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];

  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization token required' });
  }

  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    return res.status(401).json({ error: 'Invalid authorization token format' });
  }

  const token = parts[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded || !decoded.id) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    req.user = {
      id: Number(decoded.id),
      email: decoded.email
    };
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Optional authentication middleware for public endpoints.
 */
function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  if (!authHeader) {
    req.user = null;
    return next();
  }

  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    req.user = null;
    return next();
  }

  try {
    const decoded = jwt.verify(parts[1], JWT_SECRET);
    req.user = decoded && decoded.id ? { id: Number(decoded.id), email: decoded.email } : null;
  } catch (_) {
    req.user = null;
  }
  return next();
}

// Assign helper functions to the middleware function for flexible import styles
authMiddleware.authMiddleware = authMiddleware;
authMiddleware.authenticateToken = authMiddleware;
authMiddleware.hashPassword = hashPassword;
authMiddleware.comparePassword = comparePassword;
authMiddleware.generateToken = generateToken;
authMiddleware.verifyToken = verifyToken;
authMiddleware.optionalAuth = optionalAuth;

module.exports = authMiddleware;
