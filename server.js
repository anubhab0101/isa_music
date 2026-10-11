// server.js - ISA Music Core Express Server
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();

const { initDb, closeDb } = require('./src/db');

// Route Handlers
const authRoutes = require('./src/routes/auth');
const libraryRoutes = require('./src/routes/library');
const searchRoutes = require('./src/routes/search');
const streamRoutes = require('./src/routes/stream');
const quotaRoutes = require('./src/routes/quota');
const settingsRoutes = require('./src/routes/settings');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Database Schemas
initDb();

// 1. Security & Pre-processing Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://www.youtube.com", "https://*.youtube.com", "https://s.ytimg.com", "https://*.ytimg.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:", "https://i.ytimg.com", "https://*.ytimg.com", "https://img.youtube.com", "https://*.googleusercontent.com"],
      mediaSrc: ["'self'", "blob:", "http://localhost:*", "https://*"],
      connectSrc: ["'self'", "https://www.googleapis.com", "https://*.youtube.com", "https://*.googlevideo.com", "https://*.google.com"],
      frameSrc: ["'self'", "https://www.youtube.com", "https://*.youtube.com", "https://www.youtube-nocookie.com"],
      childSrc: ["'self'", "https://www.youtube.com", "https://*.youtube.com", "https://www.youtube-nocookie.com"]
    }
  },
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Range'],
  exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'Content-Type']
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// 2. Health & Diagnostic Endpoints (Render / Deployment Anti-Sleep & Monitoring)
app.get(['/health', '/api/health'], (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    service: 'ISA Music'
  });
});

// 3. API Route Mounting & Aliasing
// Auth Routes: support both /api and /api/auth prefixes
app.use('/api', authRoutes);
app.use('/api/auth', authRoutes);

// Liked Library Routes
app.use('/api/library', libraryRoutes);

// YouTube Search Proxy Routes
app.use('/api/search', searchRoutes);

// Audio Streaming Proxy Routes
app.use('/api/stream', streamRoutes);

// Quota Management Routes
app.use('/api/quota', quotaRoutes);

// Settings Routes
app.use('/api/settings', settingsRoutes);

// 4. Static Asset Delivery
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// Single Page Application (SPA) Fallback for non-API routes
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  const indexPath = path.join(__dirname, 'index.html');
  res.sendFile(indexPath);
});

// 5. Error Handling Middleware
// 404 Handler for unmatched API routes
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found', path: req.originalUrl });
});

// Global Error Handler
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON payload' });
  }
  console.error('[Server Error]:', err.message);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message
  });
});

// 6. Server Lifecycle & Render Keep-Alive Worker
let serverInstance = null;
let keepAliveTimer = null;

function startKeepAliveWorker(port) {
  const targetBase = process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
  const healthUrl = `${targetBase.replace(/\/$/, '')}/health`;
  console.log(`[KeepAlive] Worker active. Pinging ${healthUrl} every 60s to prevent sleeping.`);

  keepAliveTimer = setInterval(async () => {
    try {
      const res = await fetch(healthUrl);
      if (res.ok) {
        // Ping successful, server stays awake
      }
    } catch (_) {
      // Suppress network retry logs
    }
  }, 60 * 1000); // 1 minute

  if (keepAliveTimer && keepAliveTimer.unref) {
    keepAliveTimer.unref();
  }
}

if (require.main === module) {
  serverInstance = app.listen(PORT, () => {
    console.log(`[ISA Music] Server listening on http://localhost:${PORT}`);
    startKeepAliveWorker(PORT);
  });

  const gracefulShutdown = () => {
    console.log('[ISA Music] Shutting down gracefully...');
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    if (serverInstance) {
      serverInstance.close(() => {
        closeDb();
        console.log('[ISA Music] Closed all connections.');
        process.exit(0);
      });
    } else {
      closeDb();
      process.exit(0);
    }
  };

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
}

module.exports = app;
module.exports.serverInstance = serverInstance;
