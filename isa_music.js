/**
 * ISA Music - Core Frontend Application & Web Audio API Crossfade Engine
 *
 * Security: ZERO hardcoded API keys. All network calls route through backend /api/ proxies.
 * Audio Engine: Web Audio API dual-deck gain crossfader with equal-power / linear curves.
 */

// ============================================================================
// 1. APPLICATION STATE
// ============================================================================

const appState = {
  // Audio Engine State
  currentTrack: null,
  isPlaying: false,
  playlist: [
    {
      videoId: 'dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up',
      artist: 'Rick Astley',
      thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'
    },
    {
      videoId: '9bZkp7q19f0',
      title: 'Gangnam Style',
      artist: 'PSY',
      thumbnail: 'https://i.ytimg.com/vi/9bZkp7q19f0/hqdefault.jpg'
    }
  ],
  currentIndex: -1,
  quality: (typeof localStorage !== 'undefined' && localStorage.getItem('isa_quality_preset')) || 'high',
  crossfadeDuration: parseFloat((typeof localStorage !== 'undefined' && localStorage.getItem('isa_crossfade_duration')) || '3.0'),
  crossfadeCurve: (typeof localStorage !== 'undefined' && localStorage.getItem('isa_crossfade_curve')) || 'equal-power', // 'equal-power' | 'linear' | 'exponential'
  volume: parseFloat((typeof localStorage !== 'undefined' && localStorage.getItem('isa_volume')) || '0.8'),
  isMuted: false,
  wakeLock: null, // Screen Wake Lock for background/off-screen playback
  // Playback Settings (persisted)
  wakeLockEnabled: (typeof localStorage !== 'undefined' && localStorage.getItem('isa_wake_lock_enabled') !== 'false'),
  bgTetherEnabled: (typeof localStorage !== 'undefined' && localStorage.getItem('isa_bg_tether_enabled') !== 'false'),
  autoResumeEnabled: (typeof localStorage !== 'undefined' && localStorage.getItem('isa_auto_resume_enabled') !== 'false'),

  // UI State
  isExpanded: false,
  activeView: 'home',

  // User & Auth State
  token: (typeof localStorage !== 'undefined' && localStorage.getItem('isa_auth_token')) || null,
  user: (() => {
    if (typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem('isa_user_data');
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  })(),
  likedTracks: new Map(), // videoId -> track

  // Quota Metrics
  quota: {
    used: 0,
    remaining: 10000,
    total: 10000,
    resetsAt: null
  }
};

// ============================================================================
// 2. BACKEND PROXY API CLIENT (ZERO CLIENT SECRETS)
// ============================================================================

const api = {
  // Search proxy: /api/search?q=...&limit=...
  async search(query, limit = 10) {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=${limit}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const error = new Error(err.error || `Search failed with status ${res.status}`);
      error.code = err.code || null;
      error.isQuotaExceeded = Boolean(err.isQuotaExceeded);
      error.resetAt = err.resetAt || null;
      throw error;
    }
    return await res.json(); // { items: [...] }
  },

  // Zero-quota search suggestions: /api/search/suggest?q=...
  async getSuggestions(query) {
    try {
      const res = await fetch(`/api/search/suggest?q=${encodeURIComponent(query)}`);
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data.suggestions) ? data.suggestions : [];
    } catch (_) {
      return [];
    }
  },

  // Audio stream proxy URL generator: /api/stream/:videoId?quality=...
  getStreamUrl(videoId, quality = appState.quality) {
    return `/api/stream/${encodeURIComponent(videoId)}?quality=${encodeURIComponent(quality)}`;
  },

  // Audio stream duration info: /api/stream/:videoId/info
  async getTrackInfo(videoId) {
    try {
      const res = await fetch(`/api/stream/${encodeURIComponent(videoId)}/info`);
      if (!res.ok) return null;
      return await res.json();
    } catch (_) {
      return null;
    }
  },

  // Daily API Quota metrics: /api/quota
  async getQuota() {
    const res = await fetch('/api/quota');
    if (!res.ok) throw new Error(`Quota fetch failed with status ${res.status}`);
    return await res.json(); // { used, remaining, total, resetsAt }
  },

  // User Authentication endpoints
  async login(email, password) {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    return data; // { success, token, user }
  },

  async register(email, password) {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed');
    return data; // { success, token, user }
  },

  async getMe(token) {
    try {
      const res = await fetch('/api/me', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.status === 401) {
        return { status: 401, error: 'unauthorized' };
      }
      if (!res.ok) return null;
      return await res.json();
    } catch (_) {
      return null;
    }
  },

  // Liked Library endpoints
  async getLibrary(token) {
    if (!token) return { tracks: [] };
    const res = await fetch('/api/library', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('Failed to load library');
    return await res.json(); // { success, tracks: [...] }
  },

  async likeTrack(token, track) {
    const res = await fetch('/api/library/like', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        videoId: track.videoId,
        title: track.title,
        artist: track.artist,
        thumbnail: track.thumbnail
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to like track');
    return data;
  },

  async unlikeTrack(token, videoId) {
    const res = await fetch(`/api/library/unlike/${encodeURIComponent(videoId)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to unlike track');
    return data;
  }
};

// ============================================================================
// 3. WEB AUDIO API DUAL-DECK CROSSFADE ENGINE
// ============================================================================

class WebAudioCrossfadeEngine {
  constructor() {
    this.audioCtx = null;
    this.masterGain = null;
    this.decks = [
      { id: 'A', audio: null, source: null, gain: null, track: null, hasTriggeredAdvance: false },
      { id: 'B', audio: null, source: null, gain: null, track: null, hasTriggeredAdvance: false }
    ];
    this.activeDeckIdx = 0;
    this.isCrossfading = false;
    this.crossfadeTimer = null;
    this.isInitialized = false;

    // Hybrid YouTube Iframe Streaming Engine (Zero server bandwidth / 100% cloud-proof)
    this.ytPlayer = null;
    this.ytReady = false;
    this.ytTicker = null;
    this.activeMode = 'youtube'; // 'youtube' (online) | 'html5' (offline IndexedDB)
    this.queuedTrack = null;
    this.queuedStartTime = 0;
    this._ytInitializing = false;
  }

  // Initialize YouTube Iframe Player for zero-bandwidth client playback
  initYouTubePlayer() {
    if (typeof window === 'undefined') return;
    if (this.ytPlayer || this._ytInitializing) return;

    const setupPlayer = () => {
      if (this.ytPlayer || !window.YT || !window.YT.Player) return;
      const target = document.getElementById('youtube-player');
      if (!target) return;

      this._ytInitializing = true;
      try {
        this.ytPlayer = new window.YT.Player('youtube-player', {
          height: '100%',
          width: '100%',
          videoId: '',
          playerVars: {
            autoplay: 0,
            controls: 0,
            disablekb: 1,
            fs: 0,
            modestbranding: 1,
            rel: 0,
            playsinline: 1,
            origin: window.location.origin
          },
          events: {
            onReady: () => {
              this.ytReady = true;
              this._ytInitializing = false;
              console.log('[YouTube Player] Ready for client streaming');
              if (typeof this.ytPlayer.setVolume === 'function') {
                this.ytPlayer.setVolume(Math.round(appState.volume * 100));
              }
              if (this.queuedTrack) {
                const queued = this.queuedTrack;
                const startSec = this.queuedStartTime || 0;
                this.queuedTrack = null;
                this.queuedStartTime = 0;
                this.playTrack(queued, { startTime: startSec });
              }
            },
            onStateChange: (event) => {
              this.handleYouTubeStateChange(event.data);
            },
            onError: (event) => {
              console.warn('[YouTube Player] Event error code:', event.data);
              setBufferingUI(false);
              this.consecutiveErrors = (this.consecutiveErrors || 0) + 1;
              if (this.consecutiveErrors >= 3) {
                showToast('Playback issue. Tap play on any song to retry.', 'error');
                appState.isPlaying = false;
                setPlayPauseUI(false);
                return;
              }
              if (event.data === 101 || event.data === 150 || event.data === 100) {
                showToast('Track embedding restricted by YouTube. Skipping to next...', 'warning');
                setTimeout(() => onAutoAdvance(), 1500);
              } else {
                showToast('Playback issue. Tap play to retry.', 'error');
                setPlayPauseUI(false);
              }
            }
          }
        });
      } catch (err) {
        console.warn('[YouTube Player] Initialization exception:', err);
        this._ytInitializing = false;
      }
    };

    if (window.YT && window.YT.Player) {
      setupPlayer();
    } else {
      const existingCallback = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (typeof existingCallback === 'function') existingCallback();
        setupPlayer();
      };
    }
  }

  handleYouTubeStateChange(state) {
    if (this.activeMode !== 'youtube') return;

    // YT.PlayerState: -1: unstarted, 0: ended, 1: playing, 2: paused, 3: buffering, 5: cued
    if (state === 1) { // PLAYING
      this.consecutiveErrors = 0;
      appState.isPlaying = true;
      setBufferingUI(false);
      setPlayPauseUI(true);
      this.startYouTubeTicker();
      ensureWakeLockForPlayback();
    } else if (state === 2) { // PAUSED
      appState.isPlaying = false;
      setBufferingUI(false);
      setPlayPauseUI(false);
      this.stopYouTubeTicker();
      releaseWakeLock();
    } else if (state === 3) { // BUFFERING
      setBufferingUI(true);
    } else if (state === 0) { // ENDED
      setBufferingUI(false);
      this.stopYouTubeTicker();
      releaseWakeLock();
      onAutoAdvance();
    }
  }

  startYouTubeTicker() {
    this.stopYouTubeTicker();
    this.ytTicker = setInterval(() => {
      if (this.ytPlayer && typeof this.ytPlayer.getCurrentTime === 'function') {
        try {
          const curTime = this.ytPlayer.getCurrentTime() || 0;
          const duration = this.ytPlayer.getDuration() || appState.currentTrack?.duration || 0;
          if (duration > 0 && (!appState.currentTrack?.duration || appState.currentTrack.duration <= 0)) {
            if (appState.currentTrack) appState.currentTrack.duration = duration;
          }
          onPlaybackTimeUpdate(curTime, duration);
        } catch (_) {}
      }
    }, 250);
  }

  stopYouTubeTicker() {
    if (this.ytTicker) {
      clearInterval(this.ytTicker);
      this.ytTicker = null;
    }
  }

  getCurrentTime() {
    if (this.activeMode === 'youtube' && this.ytPlayer && typeof this.ytPlayer.getCurrentTime === 'function') {
      try {
        return this.ytPlayer.getCurrentTime() || 0;
      } catch (_) {}
    }
    const activeDeck = this.getActiveDeck();
    return activeDeck?.audio?.currentTime || 0;
  }

  // Initialize Web Audio graph on user gesture
  ensureAudioContext() {
    if (typeof window === 'undefined') return;

    if (!this.isInitialized) {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      if (AudioCtxClass) {
        try {
          this.audioCtx = new AudioCtxClass();
          this.masterGain = this.audioCtx.createGain();
          this.masterGain.gain.setValueAtTime(appState.volume, this.audioCtx.currentTime);
          this.masterGain.connect(this.audioCtx.destination);

          // Build dual-deck audio channels
          for (let i = 0; i < 2; i++) {
            const pipelineId = i === 0 ? 'audio-pipeline-a' : 'audio-pipeline-b';
            let audio = document.getElementById(pipelineId);
            if (!audio) {
              audio = new Audio();
              audio.id = pipelineId;
            }
            audio.crossOrigin = 'anonymous';
            audio.preload = 'auto';

            const source = this.audioCtx.createMediaElementSource(audio);
            const gain = this.audioCtx.createGain();
            gain.gain.setValueAtTime(i === 0 ? 1.0 : 0.0, this.audioCtx.currentTime);

            source.connect(gain);
            gain.connect(this.masterGain);

            this.decks[i].audio = audio;
            this.decks[i].source = source;
            this.decks[i].gain = gain;

            this.bindDeckEvents(i);
          }
          this.isInitialized = true;
        } catch (err) {
          console.warn('[Web Audio] Graph initialization fallback:', err);
          this.initFallback();
        }
      } else {
        this.initFallback();
      }
    }

    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }
  }

  initFallback() {
    for (let i = 0; i < 2; i++) {
      const pipelineId = i === 0 ? 'audio-pipeline-a' : 'audio-pipeline-b';
      let audio = document.getElementById(pipelineId);
      if (!audio) {
        audio = new Audio();
        audio.id = pipelineId;
      }
      audio.crossOrigin = 'anonymous';
      audio.preload = 'auto';
      audio.volume = i === 0 ? appState.volume : 0;
      this.decks[i].audio = audio;
      this.bindDeckEvents(i);
    }
    this.isInitialized = true;
  }

  getActiveDeck() {
    return this.decks[this.activeDeckIdx];
  }

  getInactiveDeck() {
    return this.decks[1 - this.activeDeckIdx];
  }

  bindDeckEvents(deckIdx) {
    const deck = this.decks[deckIdx];
    const audio = deck.audio;
    if (!audio) return;

    audio.addEventListener('timeupdate', () => {
      if (this.activeMode !== 'html5') return;
      if (deckIdx === this.activeDeckIdx) {
        onPlaybackTimeUpdate(audio.currentTime, audio.duration);

        const effectiveDuration = (audio.duration && isFinite(audio.duration) && audio.duration > 0)
          ? audio.duration
          : (appState.currentTrack?.duration || 0);

        // Auto-advance crossfade detection
        if (!this.isCrossfading && effectiveDuration > 0) {
          const remaining = effectiveDuration - audio.currentTime;
          const crossfadeThreshold = Math.min(appState.crossfadeDuration, effectiveDuration * 0.5);

          if (!deck.hasTriggeredAdvance && appState.crossfadeDuration > 0 && remaining <= crossfadeThreshold && remaining > 0.25) {
            deck.hasTriggeredAdvance = true;
            onAutoAdvance();
          }
        }
      }
    });

    audio.addEventListener('waiting', () => {
      if (this.activeMode !== 'html5') return;
      if (deckIdx === this.activeDeckIdx) {
        setBufferingUI(true);
      }
    });

    audio.addEventListener('stalled', () => {
      if (this.activeMode !== 'html5') return;
      if (deckIdx === this.activeDeckIdx) {
        setBufferingUI(true);
        if (!audio.paused && audio.readyState < 3) {
          setTimeout(() => {
            if (this.activeMode === 'html5' && !audio.paused && audio.readyState < 3) {
              audio.play().catch(() => {});
            }
          }, 2500);
        }
      }
    });

    audio.addEventListener('playing', () => {
      if (this.activeMode !== 'html5') return;
      if (deckIdx === this.activeDeckIdx) {
        setBufferingUI(false);
      }
    });

    audio.addEventListener('canplay', () => {
      if (this.activeMode !== 'html5') return;
      if (deckIdx === this.activeDeckIdx) {
        setBufferingUI(false);
      }
    });

    audio.addEventListener('canplaythrough', () => {
      if (this.activeMode !== 'html5') return;
      if (deckIdx === this.activeDeckIdx) {
        setBufferingUI(false);
      }
    });

    audio.addEventListener('pause', () => {
      if (this.activeMode !== 'html5') return;
      if (deckIdx === this.activeDeckIdx) {
        setBufferingUI(false);
      }
    });

    audio.addEventListener('ended', () => {
      if (this.activeMode !== 'html5') return;
      setBufferingUI(false);
      if (deckIdx === this.activeDeckIdx && !this.isCrossfading) {
        onAutoAdvance();
      }
    });

    audio.addEventListener('error', (e) => {
      if (this.activeMode !== 'html5') return;
      console.warn(`[Deck ${deck.id} Audio Error]:`, e);
      if (deckIdx === this.activeDeckIdx) {
        setBufferingUI(false);
        setPlayPauseUI(false);
      }
    });
  }

  // Play track with hybrid engine (YouTube Iframe for online, Web Audio for offline)
  async playTrack(track, options = {}) {
    if (!track || !track.videoId) return;
    const { startTime = 0, forceInstant = false } = options;

    let isOffline = false;
    let offlineBlobUrl = null;

    // Check if offline audio blob is saved locally in IndexedDB
    try {
      if (typeof getOfflineTrack === 'function') {
        const offlineItem = await getOfflineTrack(track.videoId);
        if (offlineItem && offlineItem.blob) {
          isOffline = true;
          offlineBlobUrl = URL.createObjectURL(offlineItem.blob);
          if (typeof navigator !== 'undefined' && !navigator.onLine) {
            showToast(`Playing "${track.title}" from offline storage`, 'info');
          }
        }
      }
    } catch (_) {}

    if (isOffline && offlineBlobUrl) {
      // -------------------------------------------------------------
      // MODE 1: OFFLINE PLAYBACK (Dual-Deck Web Audio API)
      // -------------------------------------------------------------
      this.activeMode = 'html5';
      this.stopYouTubeTicker();
      if (this.ytPlayer && typeof this.ytPlayer.pauseVideo === 'function') {
        try { this.ytPlayer.pauseVideo(); } catch (_) {}
      }

      this.ensureAudioContext();
      const outDeck = this.getActiveDeck();
      const inDeckIdx = 1 - this.activeDeckIdx;
      const inDeck = this.decks[inDeckIdx];

      if (inDeck._blobUrl) {
        try { URL.revokeObjectURL(inDeck._blobUrl); } catch (_) {}
      }
      inDeck._blobUrl = offlineBlobUrl;
      const duration = forceInstant ? 0 : appState.crossfadeDuration;

      inDeck.track = track;
      inDeck.hasTriggeredAdvance = false;
      inDeck.audio.src = offlineBlobUrl;
      inDeck.audio.currentTime = startTime;

      setBufferingUI(true);

      const playPromise = inDeck.audio.play();
      if (playPromise !== undefined) {
        playPromise.then(() => {
          appState.isPlaying = true;
          appState.currentTrack = track;
          updateNowPlayingUI(track);
          setPlayPauseUI(true);
          ensureWakeLockForPlayback();
          if (typeof recordRecentTrack === 'function') {
            recordRecentTrack(track);
          }

          if (outDeck.audio && !outDeck.audio.paused && duration > 0) {
            this.executeCrossfade(outDeck, inDeck, inDeckIdx, duration);
          } else {
            this.finalizeSwitch(outDeck, inDeck, inDeckIdx);
          }
        }).catch(err => {
          console.warn('[Offline Playback Start Error]:', err);
          setBufferingUI(false);
        });
      }
      return;
    }

    // -----------------------------------------------------------------
    // MODE 2: ONLINE YOUTUBE IFRAME PLAYBACK (Official Client-Side Stream)
    // -----------------------------------------------------------------
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      showToast(`You are offline. Download "${track.title}" while online to play offline.`, 'warning');
      setBufferingUI(false);
      return;
    }

    this.activeMode = 'youtube';

    // Pause any active HTML5 audio decks
    this.decks.forEach(d => {
      if (d.audio && !d.audio.paused) {
        d.audio.pause();
        d.audio.currentTime = 0;
      }
    });

    appState.currentTrack = track;
    updateNowPlayingUI(track);
    setBufferingUI(true);
    if (typeof recordRecentTrack === 'function') {
      recordRecentTrack(track);
    }

    // Fetch track duration info in background if not known
    if (!track.duration || track.duration <= 0) {
      api.getTrackInfo(track.videoId).then(info => {
        if (info && info.duration) {
          track.duration = info.duration;
          if (appState.currentTrack && appState.currentTrack.videoId === track.videoId) {
            const curTime = this.getCurrentTime();
            onPlaybackTimeUpdate(curTime, info.duration);
          }
        }
      }).catch(() => {});
    }

    if (this.ytReady && this.ytPlayer && typeof this.ytPlayer.loadVideoById === 'function') {
      try {
        this.ytPlayer.loadVideoById({
          videoId: track.videoId,
          startSeconds: startTime
        });
        if (typeof this.ytPlayer.setVolume === 'function') {
          this.ytPlayer.setVolume(Math.round(appState.volume * 100));
        }
        this.ytPlayer.playVideo();
        // Request wake lock when YouTube playback starts
        ensureWakeLockForPlayback();
      } catch (err) {
        console.warn('[YouTube Play Video Error]:', err);
        setBufferingUI(false);
      }
    } else {
      this.queuedTrack = track;
      this.queuedStartTime = startTime;
      this.initYouTubePlayer();
    }
  }

  // Execute mathematical crossfade curves
  executeCrossfade(outDeck, inDeck, inDeckIdx, duration) {
    this.isCrossfading = true;
    if (this.crossfadeTimer) clearTimeout(this.crossfadeTimer);

    if (this.audioCtx && outDeck.gain && inDeck.gain) {
      const now = this.audioCtx.currentTime;

      outDeck.gain.gain.cancelScheduledValues(now);
      inDeck.gain.gain.cancelScheduledValues(now);

      if (appState.crossfadeCurve === 'equal-power') {
        // Equal-Power Curve: G_out = cos(t), G_in = sin(t) -> G_out^2 + G_in^2 = 1.0
        const STEPS = 64;
        const outCurve = new Float32Array(STEPS);
        const inCurve = new Float32Array(STEPS);
        for (let i = 0; i < STEPS; i++) {
          const frac = i / (STEPS - 1);
          const angle = frac * 0.5 * Math.PI;
          outCurve[i] = Math.cos(angle);
          inCurve[i] = Math.sin(angle);
        }
        outDeck.gain.gain.setValueCurveAtTime(outCurve, now, duration);
        inDeck.gain.gain.setValueCurveAtTime(inCurve, now, duration);
      } else if (appState.crossfadeCurve === 'exponential') {
        outDeck.gain.gain.setValueAtTime(Math.max(outDeck.gain.gain.value, 0.001), now);
        outDeck.gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
        outDeck.gain.gain.setValueAtTime(0, now + duration);

        inDeck.gain.gain.setValueAtTime(0.001, now);
        inDeck.gain.gain.exponentialRampToValueAtTime(1.0, now + duration);
      } else {
        // Linear fade
        outDeck.gain.gain.setValueAtTime(1.0, now);
        outDeck.gain.gain.linearRampToValueAtTime(0.0, now + duration);

        inDeck.gain.gain.setValueAtTime(0.0, now);
        inDeck.gain.gain.linearRampToValueAtTime(1.0, now + duration);
      }
    } else {
      // HTML Audio stepping fallback
      let elapsed = 0;
      const intervalMs = 50;
      const stepTimer = setInterval(() => {
        elapsed += intervalMs;
        const progress = Math.min(elapsed / (duration * 1000), 1.0);
        if (outDeck.audio) outDeck.audio.volume = Math.max(0, (1 - progress) * appState.volume);
        if (inDeck.audio) inDeck.audio.volume = Math.min(appState.volume, progress * appState.volume);
        if (progress >= 1.0) clearInterval(stepTimer);
      }, intervalMs);
    }

    this.crossfadeTimer = setTimeout(() => {
      this.finalizeSwitch(outDeck, inDeck, inDeckIdx);
    }, duration * 1000);
  }

  finalizeSwitch(outDeck, inDeck, inDeckIdx) {
    if (outDeck.audio) {
      outDeck.audio.pause();
      outDeck.audio.currentTime = 0;
    }

    if (this.audioCtx && outDeck.gain && inDeck.gain) {
      const now = this.audioCtx.currentTime;
      outDeck.gain.gain.cancelScheduledValues(now);
      outDeck.gain.gain.setValueAtTime(0, now);
      inDeck.gain.gain.cancelScheduledValues(now);
      inDeck.gain.gain.setValueAtTime(1.0, now);
    }

    this.activeDeckIdx = inDeckIdx;
    this.isCrossfading = false;
  }

  // Seamless quality stream switch keeping playback timestamp
  switchQuality(newQuality) {
    const activeDeck = this.getActiveDeck();
    if (!activeDeck.audio || !appState.currentTrack) return;

    const currentPos = activeDeck.audio.currentTime;
    const wasPlaying = !activeDeck.audio.paused;
    const newUrl = api.getStreamUrl(appState.currentTrack.videoId, newQuality);

    activeDeck.audio.src = newUrl;
    activeDeck.audio.currentTime = currentPos;

    if (wasPlaying) {
      activeDeck.audio.play().catch(console.warn);
    }
  }

  togglePlayPause() {
    if (this.activeMode === 'youtube' && this.ytPlayer && typeof this.ytPlayer.getPlayerState === 'function') {
      try {
        const state = this.ytPlayer.getPlayerState();
        if (state === 1) { // Currently playing
          this.ytPlayer.pauseVideo();
          appState.isPlaying = false;
          setPlayPauseUI(false);
          this.stopYouTubeTicker();
          releaseWakeLock();
        } else {
          this.ytPlayer.playVideo();
          appState.isPlaying = true;
          setPlayPauseUI(true);
          this.startYouTubeTicker();
          ensureWakeLockForPlayback();
        }
        return;
      } catch (err) {
        console.warn('[YouTube Toggle Error]:', err);
      }
    }

    this.ensureAudioContext();
    const activeDeck = this.getActiveDeck();
    if (!activeDeck.audio) return;

    if (activeDeck.audio.paused) {
      activeDeck.audio.play().then(() => {
        appState.isPlaying = true;
        setPlayPauseUI(true);
        ensureWakeLockForPlayback();
      }).catch(console.warn);
    } else {
      activeDeck.audio.pause();
      appState.isPlaying = false;
      setPlayPauseUI(false);
      releaseWakeLock();
    }
  }

  seek(percentage) {
    if (this.activeMode === 'youtube' && this.ytPlayer && typeof this.ytPlayer.seekTo === 'function') {
      let dur = 0;
      try { dur = this.ytPlayer.getDuration() || 0; } catch (_) {}
      if (!dur || dur <= 0) dur = appState.currentTrack?.duration || 0;

      if (dur > 0) {
        const targetTime = Math.max(0, Math.min(percentage * dur, dur));
        try {
          this.ytPlayer.seekTo(targetTime, true);
          onPlaybackTimeUpdate(targetTime, dur);
        } catch (_) {}
      }
      return;
    }

    const activeDeck = this.getActiveDeck();
    if (!activeDeck.audio) return;
    const effectiveDuration = (activeDeck.audio.duration && isFinite(activeDeck.audio.duration) && activeDeck.audio.duration > 0)
      ? activeDeck.audio.duration
      : (appState.currentTrack?.duration || 0);

    if (effectiveDuration > 0) {
      const targetTime = Math.max(0, Math.min(percentage * effectiveDuration, effectiveDuration));
      activeDeck.audio.currentTime = targetTime;
      onPlaybackTimeUpdate(targetTime, effectiveDuration);
    }
  }

  setVolume(vol) {
    const clamped = Math.max(0, Math.min(1, vol));
    appState.volume = clamped;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('isa_volume', clamped);
    }

    if (this.ytPlayer && typeof this.ytPlayer.setVolume === 'function') {
      try {
        this.ytPlayer.setVolume(Math.round(clamped * 100));
      } catch (_) {}
    }

    if (this.masterGain && this.audioCtx) {
      this.masterGain.gain.setValueAtTime(clamped, this.audioCtx.currentTime);
    } else {
      const activeDeck = this.getActiveDeck();
      if (activeDeck.audio) activeDeck.audio.volume = clamped;
    }
    updateVolumeUI(clamped);
  }
}

const engine = new WebAudioCrossfadeEngine();

// ============================================================================
// 3b. OFFLINE STORAGE & INDEXEDDB ENGINE (PWA Support)
// ============================================================================
const OFFLINE_DB_NAME = 'isa_offline_music_db';
const OFFLINE_DB_VERSION = 1;
const OFFLINE_STORE_NAME = 'downloaded_tracks';
const downloadedTrackIds = new Set();

function openOfflineDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return reject(new Error('IndexedDB not supported in this environment.'));
    }
    const request = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(OFFLINE_STORE_NAME)) {
        db.createObjectStore(OFFLINE_STORE_NAME, { keyPath: 'videoId' });
      }
    };
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

async function saveOfflineTrack(track, blob) {
  const db = await openOfflineDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([OFFLINE_STORE_NAME], 'readwrite');
    const store = tx.objectStore(OFFLINE_STORE_NAME);
    const item = {
      videoId: track.videoId,
      title: track.title,
      artist: track.artist,
      thumbnail: track.thumbnail,
      duration: track.duration || 0,
      blob: blob,
      downloadedAt: Date.now()
    };
    const req = store.put(item);
    req.onsuccess = () => {
      downloadedTrackIds.add(track.videoId);
      updateDownloadButtonsUI(track.videoId, true);
      resolve(item);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

async function getOfflineTrack(videoId) {
  try {
    const db = await openOfflineDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([OFFLINE_STORE_NAME], 'readonly');
      const store = tx.objectStore(OFFLINE_STORE_NAME);
      const req = store.get(videoId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = (e) => reject(e.target.error);
    });
  } catch (_) {
    return null;
  }
}

async function getAllOfflineTracks() {
  try {
    const db = await openOfflineDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([OFFLINE_STORE_NAME], 'readonly');
      const store = tx.objectStore(OFFLINE_STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = (e) => reject(e.target.error);
    });
  } catch (_) {
    return [];
  }
}

async function deleteOfflineTrack(videoId) {
  try {
    const db = await openOfflineDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([OFFLINE_STORE_NAME], 'readwrite');
      const store = tx.objectStore(OFFLINE_STORE_NAME);
      const req = store.delete(videoId);
      req.onsuccess = () => {
        downloadedTrackIds.delete(videoId);
        updateDownloadButtonsUI(videoId, false);
        resolve(true);
      };
      req.onerror = (e) => reject(e.target.error);
    });
  } catch (_) {
    return false;
  }
}

function isOfflineTrack(videoId) {
  return downloadedTrackIds.has(videoId);
}

function updateDownloadButtonsUI(videoId, isDownloaded) {
  document.querySelectorAll(`[data-video-id="${videoId}"] .btn-download-track`).forEach(btn => {
    btn.classList.toggle('is-downloaded', isDownloaded);
    btn.classList.remove('is-downloading');
    btn.setAttribute('title', isDownloaded ? 'Downloaded (Tap to remove)' : 'Download for offline playback');
  });

  if (appState.currentTrack && appState.currentTrack.videoId === videoId) {
    const miniBtn = document.getElementById('mini-btn-download');
    const expBtn = document.getElementById('expanded-btn-download');
    if (miniBtn) {
      miniBtn.classList.toggle('is-downloaded', isDownloaded);
      miniBtn.classList.remove('is-downloading');
      miniBtn.setAttribute('title', isDownloaded ? 'Downloaded (Tap to remove)' : 'Download for offline playback');
    }
    if (expBtn) {
      expBtn.classList.toggle('is-downloaded', isDownloaded);
      expBtn.classList.remove('is-downloading');
      expBtn.setAttribute('title', isDownloaded ? 'Downloaded (Tap to remove)' : 'Download for offline playback');
    }
  }

  const countEl = document.getElementById('offline-count');
  if (countEl) countEl.textContent = downloadedTrackIds.size;
}

async function loadOfflineTracksIndex() {
  try {
    const tracks = await getAllOfflineTracks();
    downloadedTrackIds.clear();
    let purgedCount = 0;

    for (const t of tracks) {
      // Validate offline audio blob:
      // If blob size is less than 200,000 bytes (~200KB), it was the legacy 2-second test fallback beep!
      if (t.blob && t.blob.size < 200000) {
        await deleteOfflineTrack(t.videoId);
        purgedCount++;
        console.warn(`[Offline Purge] Removed legacy test beep track: "${t.title}" (${t.blob.size} bytes)`);
      } else {
        downloadedTrackIds.add(t.videoId);
        updateDownloadButtonsUI(t.videoId, true);
      }
    }

    if (purgedCount > 0) {
      showToast(`Cleaned ${purgedCount} outdated test audio files. Please re-download tracks online.`, 'info');
      renderOfflineView();
    }

    const countEl = document.getElementById('offline-count');
    if (countEl) countEl.textContent = downloadedTrackIds.size;
  } catch (err) {
    console.warn('[OfflineDB] load index error:', err);
  }
}

async function clearAllOfflineTracks() {
  if (!confirm('Delete all offline downloaded songs from this device?')) return;
  try {
    const db = await openOfflineDB();
    const tx = db.transaction([OFFLINE_STORE_NAME], 'readwrite');
    const store = tx.objectStore(OFFLINE_STORE_NAME);
    store.clear();
    tx.oncomplete = () => {
      downloadedTrackIds.clear();
      document.querySelectorAll('.btn-download-track').forEach(b => {
        b.classList.remove('is-downloaded', 'is-downloading');
        b.setAttribute('title', 'Download for offline playback');
      });
      const countEl = document.getElementById('offline-count');
      if (countEl) countEl.textContent = '0';
      showToast('All offline downloads cleared.', 'info');
      renderOfflineView();
    };
  } catch (err) {
    console.error('[clearAllOfflineTracks error]:', err);
  }
}

async function handleDownloadClick(track, btnEl) {
  if (!track || !track.videoId) {
    showToast('No track selected to download.');
    return;
  }

  if (downloadedTrackIds.has(track.videoId)) {
    if (confirm(`Remove "${track.title}" from offline downloads?`)) {
      await deleteOfflineTrack(track.videoId);
      showToast(`Removed "${track.title}" from offline downloads.`);
      renderOfflineView();
    }
    return;
  }

  const buttons = [
    btnEl,
    document.getElementById('mini-btn-download'),
    document.getElementById('expanded-btn-download')
  ].filter(Boolean);

  buttons.forEach(b => {
    b.classList.add('is-downloading');
    b.classList.remove('is-downloaded');
  });

  showToast(`Downloading "${track.title}" for offline playback...`);

  try {
    const streamUrl = api.getStreamUrl(track.videoId, appState.quality);
    const res = await fetch(streamUrl);
    if (!res.ok) {
      throw new Error(`Stream download failed with status ${res.status}`);
    }
    const blob = await res.blob();
    await saveOfflineTrack(track, blob);
    buttons.forEach(b => {
      b.classList.remove('is-downloading');
      b.classList.add('is-downloaded');
    });
    showToast(`Downloaded "${track.title}"! Available offline.`, 'info');
    renderOfflineView();
  } catch (err) {
    buttons.forEach(b => b.classList.remove('is-downloading'));
    console.error('[Download Track Error]:', err);
    showToast(`Download failed: ${err.message}`, 'error');
  }
}

async function renderOfflineView() {
  const container = document.getElementById('offline-song-list');
  const countEl = document.getElementById('offline-count');
  if (!container) return;

  try {
    const tracks = await getAllOfflineTracks();
    if (countEl) countEl.textContent = tracks.length;

    if (tracks.length === 0) {
      container.innerHTML = `
        <div class="empty-state" id="offline-empty-state">
          <div class="empty-icon">&#128229;</div>
          <h4>No downloaded songs yet</h4>
          <p>Tap the download button on any track while online to play it offline anywhere!</p>
        </div>
      `;
      return;
    }

    let html = `
      <div class="song-header">
        <span class="col-play">#</span>
        <span class="col-title">TITLE</span>
        <span class="col-artist">ARTIST</span>
        <span class="col-actions"></span>
      </div>
    `;

    tracks.forEach((item, index) => {
      html += `
        <div class="song-item" data-video-id="${item.videoId}" data-title="${item.title}" data-artist="${item.artist}" data-thumbnail="${item.thumbnail}">
          <span class="col-play btn-play">&#9654;</span>
          <div class="col-title-group">
            <span class="col-title">${item.title}</span>
            <span class="col-artist mobile-only">${item.artist}</span>
          </div>
          <span class="col-artist desktop-only">${item.artist}</span>
          <div class="col-actions">
            <button type="button" class="btn-remove-offline" data-video-id="${item.videoId}" aria-label="Remove download" title="Remove download">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
          </div>
        </div>
      `;
    });

    container.innerHTML = html;

    container.querySelectorAll('.song-item').forEach((itemEl, idx) => {
      const item = tracks[idx];
      itemEl.addEventListener('click', (e) => {
        if (e.target.closest('.btn-remove-offline')) return;
        playTrackDirect(item, tracks, idx);
      });

      const removeBtn = itemEl.querySelector('.btn-remove-offline');
      if (removeBtn) {
        removeBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await deleteOfflineTrack(item.videoId);
          showToast(`Removed "${item.title}" from offline downloads.`);
          renderOfflineView();
        });
      }
    });
  } catch (err) {
    console.error('[renderOfflineView error]:', err);
  }
}

// ============================================================================
// 3c. BACKGROUND PLAYBACK, MEDIASESSION & PICTURE-IN-PICTURE ENGINE
// ============================================================================
// Silent 1-second WAV audio loop to keep mobile audio session alive in pocket/background
const SILENT_WAV_DATA_URI = 'data:audio/wav;base64,UklGRjIAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YRAAAAAAAAAAAAAAAAAAAAAA';

let bgTetherAudio = null;

function ensureWakeLockForPlayback() {
  if (!appState.wakeLockEnabled) return;
  if (appState.isPlaying && appState.currentTrack) {
    requestWakeLock();
  }
}

function ensureBackgroundAudioTether() {
  if (!appState.bgTetherEnabled) return;
  try {
    if (!bgTetherAudio) {
      bgTetherAudio = document.getElementById('bg-audio-tether');
      if (!bgTetherAudio) {
        bgTetherAudio = new Audio();
        bgTetherAudio.id = 'bg-audio-tether';
        bgTetherAudio.loop = true;
        bgTetherAudio.preload = 'auto';
        bgTetherAudio.style.display = 'none';
        document.body.appendChild(bgTetherAudio);
      }
    }
    if (!bgTetherAudio.src || !bgTetherAudio.src.startsWith('data:audio')) {
      bgTetherAudio.src = SILENT_WAV_DATA_URI;
      bgTetherAudio.loop = true;
      bgTetherAudio.volume = 0.001; // Microscopic non-zero volume keeps audio hardware pipe alive
    }
    if (bgTetherAudio.paused) {
      const p = bgTetherAudio.play();
      if (p !== undefined) {
        p.catch(() => {});
      }
    }
  } catch (_) {}
}

function pauseBackgroundAudioTether() {
  try {
    if (bgTetherAudio && !bgTetherAudio.paused) {
      bgTetherAudio.pause();
    }
  } catch (_) {}
}

// Wake Lock API for screen-off playback
let wakeLock = null;

async function requestWakeLock() {
  if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) {
    console.log('[Wake Lock] Wake Lock API not supported');
    return false;
  }

  try {
    if (!wakeLock || wakeLock.released) {
      wakeLock = await navigator.wakeLock.request('screen');
      appState.wakeLock = wakeLock;

      wakeLock.addEventListener('release', () => {
        console.log('[Wake Lock] Screen Wake Lock released');
        appState.wakeLock = null;
      });

      console.log('[Wake Lock] Screen Wake Lock acquired for background playback');
    }
    return true;
  } catch (err) {
    console.warn('[Wake Lock] Failed to acquire wake lock:', err.name, err.message);
    return false;
  }
}

function releaseWakeLock() {
  if (wakeLock && !wakeLock.released) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
    appState.wakeLock = null;
    console.log('[Wake Lock] Screen Wake Lock manually released');
  }
}

function ensureWakeLockForPlayback() {
  if (appState.isPlaying && appState.currentTrack) {
    requestWakeLock();
  }
}

function updateMediaSession(track) {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  if (!track) return;

  const artworkList = [];
  if (track.thumbnail) {
    artworkList.push(
      { src: track.thumbnail, sizes: '96x96', type: 'image/jpeg' },
      { src: track.thumbnail, sizes: '128x128', type: 'image/jpeg' },
      { src: track.thumbnail, sizes: '192x192', type: 'image/jpeg' },
      { src: track.thumbnail, sizes: '256x256', type: 'image/jpeg' },
      { src: track.thumbnail, sizes: '512x512', type: 'image/jpeg' }
    );
  }

  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || 'Unknown Title',
      artist: track.artist || 'ISA Music',
      album: 'ISA Music Stream',
      artwork: artworkList.length > 0 ? artworkList : undefined
    });
    navigator.mediaSession.playbackState = appState.isPlaying ? 'playing' : 'paused';
  } catch (err) {
    console.warn('[MediaSession] Metadata update failed:', err);
  }
}

function updateMediaSessionPlaybackState(isPlaying) {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
  } catch (_) {}
}

function updateMediaSessionPosition(currentTime, duration) {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  if (typeof navigator.mediaSession.setPositionState !== 'function') return;
  if (!duration || !isFinite(duration) || duration <= 0 || !isFinite(currentTime) || currentTime < 0) return;

  try {
    const safePosition = Math.min(Math.max(0, currentTime), duration);
    navigator.mediaSession.setPositionState({
      duration: duration,
      playbackRate: 1.0,
      position: safePosition
    });
  } catch (_) {}
}

function setupMediaSessionHandlers() {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;

  const actionHandlers = [
    ['play', () => {
      if (!appState.isPlaying) {
        if (!appState.currentTrack && appState.playlist.length > 0) {
          playTrackByIndex(0);
        } else {
          engine.togglePlayPause();
        }
      }
    }],
    ['pause', () => {
      if (appState.isPlaying) {
        engine.togglePlayPause();
      }
    }],
    ['previoustrack', () => {
      playPrevTrack();
    }],
    ['nexttrack', () => {
      playNextTrack();
    }],
    ['seekbackward', (details) => {
      const skip = details.seekOffset || 10;
      const cur = engine.getCurrentTime();
      const dur = appState.currentTrack?.duration || 180;
      const target = Math.max(0, cur - skip);
      if (dur > 0) engine.seek(target / dur);
    }],
    ['seekforward', (details) => {
      const skip = details.seekOffset || 10;
      const cur = engine.getCurrentTime();
      const dur = appState.currentTrack?.duration || 180;
      const target = Math.min(dur, cur + skip);
      if (dur > 0) engine.seek(target / dur);
    }],
    ['seekto', (details) => {
      if (details.seekTime !== undefined) {
        const dur = appState.currentTrack?.duration || 180;
        if (dur > 0) {
          engine.seek(Math.min(1, Math.max(0, details.seekTime / dur)));
        }
      }
    }],
    ['stop', () => {
      if (appState.isPlaying) {
        engine.togglePlayPause();
      }
    }]
  ];

  actionHandlers.forEach(([action, handler]) => {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch (_) {}
  });
}

function setupBackgroundVisibilityWatcher() {
  if (typeof document === 'undefined') return;

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      // Screen locked or tab moved to background
      if (appState.isPlaying) {
        ensureBackgroundAudioTether();
        // Request wake lock to keep playback alive when screen is off
        ensureWakeLockForPlayback();
        if (engine.activeMode === 'youtube' && engine.ytPlayer && typeof engine.ytPlayer.getPlayerState === 'function') {
          try {
            const ytState = engine.ytPlayer.getPlayerState();
            if (ytState === 2) {
              engine.ytPlayer.playVideo();
            }
          } catch (_) {}
        }
      }
    } else if (document.visibilityState === 'visible') {
      // Screen unlocked or tab returned to foreground
      if (appState.currentTrack) {
        updateNowPlayingUI(appState.currentTrack);
        setPlayPauseUI(appState.isPlaying);
      }
    }
  });

  window.addEventListener('pageshow', () => {
    if (appState.isPlaying && appState.currentTrack) {
      updateMediaSession(appState.currentTrack);
      updateMediaSessionPlaybackState(true);
      // Re-acquire wake lock when returning to foreground
      ensureWakeLockForPlayback();
    }
    // Auto-resume playback when returning to app (if enabled)
    if (appState.autoResumeEnabled && appState.currentTrack && !appState.isPlaying) {
      engine.togglePlayPause();
    }
  });
}

// Picture-in-Picture floating audio visualizer
let pipVideoEl = null;
let pipCanvasEl = null;
let pipAnimFrame = null;
let pipCoverImg = null;

function setupPictureInPicture() {
  const btnPip = document.getElementById('btn-pip');
  if (!btnPip) return;

  if (typeof document === 'undefined' || !document.pictureInPictureEnabled) {
    btnPip.style.display = 'none';
    return;
  }

  btnPip.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (document.pictureInPictureElement) {
      try {
        await document.exitPictureInPicture();
      } catch (_) {}
      return;
    }

    if (!appState.currentTrack) {
      showToast('Play a song first to open Picture-in-Picture.', 'info');
      return;
    }

    try {
      await startPictureInPicture();
    } catch (err) {
      console.warn('[PiP] Error launching Picture-in-Picture:', err);
      showToast('Could not start Picture-in-Picture mode.', 'warning');
    }
  });
}

async function startPictureInPicture() {
  if (!pipCanvasEl) {
    pipCanvasEl = document.createElement('canvas');
    pipCanvasEl.width = 512;
    pipCanvasEl.height = 512;
  }

  if (!pipCoverImg) {
    pipCoverImg = new Image();
    pipCoverImg.crossOrigin = 'anonymous';
  }
  if (appState.currentTrack?.thumbnail) {
    pipCoverImg.src = appState.currentTrack.thumbnail;
  }

  if (!pipVideoEl) {
    pipVideoEl = document.createElement('video');
    pipVideoEl.muted = true;
    pipVideoEl.playsInline = true;
    pipVideoEl.style.position = 'fixed';
    pipVideoEl.style.opacity = '0.001';
    pipVideoEl.style.pointerEvents = 'none';
    pipVideoEl.style.bottom = '0';
    pipVideoEl.style.right = '0';
    pipVideoEl.style.width = '10px';
    pipVideoEl.style.height = '10px';
    document.body.appendChild(pipVideoEl);

    pipVideoEl.addEventListener('leavepictureinpicture', () => {
      if (pipAnimFrame) {
        cancelAnimationFrame(pipAnimFrame);
        pipAnimFrame = null;
      }
    });
  }

  const ctx = pipCanvasEl.getContext('2d');
  let phase = 0;

  function renderPiPFrame() {
    ctx.fillStyle = '#0a0a0c';
    ctx.fillRect(0, 0, 512, 512);

    if (pipCoverImg.complete && pipCoverImg.naturalWidth > 0) {
      ctx.drawImage(pipCoverImg, 0, 0, 512, 512);
      const grad = ctx.createLinearGradient(0, 300, 0, 512);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, 'rgba(0,0,0,0.85)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 300, 512, 212);
    }

    // Song title
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 28px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText((appState.currentTrack?.title || 'ISA Music').slice(0, 24), 24, 440);

    // Artist
    ctx.fillStyle = '#fa2d56';
    ctx.font = '500 20px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText((appState.currentTrack?.artist || 'Now Playing').slice(0, 30), 24, 475);

    // Live animated audio visualizer
    if (appState.isPlaying) {
      phase += 0.15;
      for (let b = 0; b < 5; b++) {
        const barH = 12 + Math.abs(Math.sin(phase + b * 0.8)) * 26;
        ctx.fillStyle = '#fa2d56';
        ctx.fillRect(410 + b * 15, 480 - barH, 9, barH);
      }
    }

    pipAnimFrame = requestAnimationFrame(renderPiPFrame);
  }

  renderPiPFrame();

  if (!pipVideoEl.srcObject && typeof pipCanvasEl.captureStream === 'function') {
    pipVideoEl.srcObject = pipCanvasEl.captureStream(25);
  }

  await pipVideoEl.play();
  await pipVideoEl.requestPictureInPicture();
}

// ============================================================================
// 4. UI EVENT BINDINGS & DOM CONTROLLERS
// ============================================================================

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    loadLocalLikes();
    loadOfflineTracksIndex();
    initDOM();
    initAuthSession();
    initQuotaWatcher();
  });
}

function initDOM() {
  // Pre-initialize YouTube Player
  engine.initYouTubePlayer();

  // 1. First user interaction unlock for Web Audio API
  const unlockAudio = () => {
    engine.ensureAudioContext();
    document.removeEventListener('pointerdown', unlockAudio);
    document.removeEventListener('keydown', unlockAudio);
  };
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  document.addEventListener('keydown', unlockAudio, { once: true });

  // 1b. PWA Service Worker Registration
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      console.log('[PWA] Service Worker registered with scope:', reg.scope);
    }).catch(err => {
      console.warn('[PWA] Service Worker registration failed:', err);
    });
  }

  // 1c. Online/Offline Network Status & Auto-Switch to Offline Player
  if (typeof window !== 'undefined') {
    window.addEventListener('offline', () => {
      switchView('offline');
      showToast('Internet disconnected. Switched to Offline Player.', 'warning');
    });
    window.addEventListener('online', () => {
      showToast('Internet reconnected! You are back online.', 'info');
    });
  }

  // 1d. Background Playback, Lock Screen Controls & PiP
  setupMediaSessionHandlers();
  setupBackgroundVisibilityWatcher();
  setupPictureInPicture();

  // 2. Play / Pause buttons (mini-player & expanded player)
  const playButtons = [
    document.getElementById('main-play-pause'),
    document.getElementById('expanded-play-pause'),
    document.getElementById('exp-play-pause')
  ].filter(Boolean);

  playButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!appState.currentTrack && appState.playlist.length > 0) {
        playTrackByIndex(0);
      } else {
        engine.togglePlayPause();
      }
    });
  });

  // 3. Track Skip Buttons (Next / Prev)
  document.querySelectorAll('.btn-next, #mini-btn-next, #expanded-btn-next, #btn-exp-next').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      playNextTrack();
    });
  });

  document.querySelectorAll('.btn-prev, #mini-btn-prev, #expanded-btn-prev, #btn-exp-prev').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      playPrevTrack();
    });
  });

  // 3b. Now Playing Like Buttons (Mini & Full-Screen Expanded Player)
  document.querySelectorAll('#mini-like-btn, #expanded-like-btn, .btn-like, .btn-like-expanded, #exp-btn-like').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!appState.currentTrack) {
        showToast('No track is currently playing.');
        return;
      }
      toggleLikeTrack(appState.currentTrack, btn);
    });
  });

  // 3c. Now Playing Download Buttons (Mini & Full-Screen Expanded Player)
  const miniDlBtn = document.getElementById('mini-btn-download');
  if (miniDlBtn) {
    miniDlBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!appState.currentTrack) {
        showToast('No track is currently playing.');
        return;
      }
      handleDownloadClick(appState.currentTrack, miniDlBtn);
    });
  }

  const expDlBtn = document.getElementById('expanded-btn-download');
  if (expDlBtn) {
    expDlBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!appState.currentTrack) {
        showToast('No track is currently playing.');
        return;
      }
      handleDownloadClick(appState.currentTrack, expDlBtn);
    });
  }

  // 3d. Clear All Offline Downloads Button
  const clearOfflineBtn = document.getElementById('btn-clear-offline');
  if (clearOfflineBtn) {
    clearOfflineBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      clearAllOfflineTracks();
    });
  }

  // 4. Real-time Debounced Search & Floating Dropdown
  setupSearchInput();

  // 5. Expandable / Minimizable Player Sheet Handlers
  setupExpandablePlayer();

  // 6. Audio Quality Preset Selector Toggles
  setupQualitySelector();

  // 7. Crossfade Duration Slider Handlers
  setupCrossfadeControl();

  // 8. Progress Seeking Handlers
  setupProgressBars();

  // 9. Volume Bar Handlers
  setupVolumeControl();

  // 10. Navigation Views (Home, Search, Library)
  setupNavigationViews();

  // 11. Initial Placeholder Songs and Grid Cards
  setupStaticContentLinks();
  renderRecentTracks();
}

// ----------------------------------------------------------------------------
// Submit-only Search & Floating Results
// ----------------------------------------------------------------------------
let searchRequestVersion = 0;
let quotaWaitUntil = 0;
let quotaWaitActive = false;
let queuedQuotaSearch = '';
let quotaWaitTimer = null;

function setSearchStatus(title, detail, state = 'loading') {
  const banner = document.getElementById('search-status-banner');
  if (!banner) return;
  banner.hidden = false;
  banner.dataset.state = state;
  const titleEl = document.getElementById('search-status-title');
  const detailEl = document.getElementById('search-status-detail');
  const spinner = document.getElementById('search-status-spinner');
  const retryButton = document.getElementById('search-status-retry');
  const submitButton = document.getElementById('btn-submit-search');
  if (titleEl) titleEl.textContent = title;
  if (detailEl) detailEl.textContent = detail;
  if (spinner) spinner.hidden = state !== 'loading';
  if (retryButton) retryButton.hidden = state !== 'quota-wait';
  if (submitButton) submitButton.disabled = state === 'loading';
}

function hideSearchStatus() {
  if (quotaWaitTimer) clearInterval(quotaWaitTimer);
  quotaWaitTimer = null;
  quotaWaitUntil = 0;
  quotaWaitActive = false;
  queuedQuotaSearch = '';
  const banner = document.getElementById('search-status-banner');
  if (banner) banner.hidden = true;
  const spinner = document.getElementById('search-status-spinner');
  if (spinner) spinner.hidden = true;
  const retryButton = document.getElementById('search-status-retry');
  if (retryButton) {
    retryButton.hidden = true;
    retryButton.disabled = true;
    retryButton.textContent = 'Retry search';
  }
  const submitButton = document.getElementById('btn-submit-search');
  if (submitButton) submitButton.disabled = false;
}

function formatWaitDuration(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return [hours ? `${hours}h` : '', minutes ? `${minutes}m` : '', `${rest}s`].filter(Boolean).join(' ');
}

function updateQuotaWaitStatus() {
  const resetAt = new Date(quotaWaitUntil);
  const remaining = Math.max(0, quotaWaitUntil - Date.now());
  const resetLabel = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit'
  }).format(resetAt);
  setSearchStatus(
    'YouTube daily search limit reached',
    `Search is paused until ${resetLabel} IST. No repeat API requests will be sent while waiting.`,
    'quota-wait'
  );
  const countdown = document.getElementById('search-status-countdown');
  const retryButton = document.getElementById('search-status-retry');
  if (countdown) countdown.textContent = remaining > 0
    ? `Retry available in ${formatWaitDuration(remaining)}.`
    : 'Quota window reset; retry when ready.';
  if (retryButton) {
    retryButton.disabled = remaining > 0;
    retryButton.textContent = remaining > 0 ? 'Waiting…' : 'Retry search';
  }
  if (remaining <= 0 && quotaWaitTimer) {
    clearInterval(quotaWaitTimer);
    quotaWaitTimer = null;
  }
}

function showQuotaWaitStatus(query, resetAt) {
  quotaWaitActive = true;
  queuedQuotaSearch = query;
  quotaWaitUntil = Date.parse(resetAt || '');
  if (!Number.isFinite(quotaWaitUntil)) {
    setSearchStatus(
      'YouTube daily search limit reached',
      'This search is paused. The API did not provide a reset time; check the quota panel before retrying.',
      'quota-wait'
    );
    const retryButton = document.getElementById('search-status-retry');
    if (retryButton) retryButton.hidden = true;
    return;
  }
  if (quotaWaitTimer) clearInterval(quotaWaitTimer);
  updateQuotaWaitStatus();
  if (quotaWaitUntil > Date.now()) quotaWaitTimer = setInterval(updateQuotaWaitStatus, 1000);
}

function retryQueuedQuotaSearch() {
  if (quotaWaitActive && (!Number.isFinite(quotaWaitUntil) || Date.now() < quotaWaitUntil)) {
    if (Number.isFinite(quotaWaitUntil)) updateQuotaWaitStatus();
    return;
  }
  const searchInput = document.getElementById('search-input') || document.querySelector('.search-input');
  const query = queuedQuotaSearch || searchInput?.value.trim();
  if (!query) return;
  hideSearchStatus();
  if (searchInput) searchInput.value = query;
  searchRequestVersion += 1;
  executeFullSearch(query);
}

const localSearchCache = new Map();
let realtimeSearchTimer = null;

function setupSearchInput() {
  const searchInput = document.getElementById('search-input') || document.querySelector('.search-input');
  const searchDropdown = document.getElementById('search-dropdown');
  const btnClearSearch = document.getElementById('btn-clear-search');
  const btnSubmitSearch = document.getElementById('btn-submit-search');

  if (!searchInput) return;

  searchInput.addEventListener('input', () => {
    const query = searchInput.value.trim();
    searchRequestVersion += 1;
    const currentVersion = searchRequestVersion;

    if (btnClearSearch) {
      btnClearSearch.style.display = query ? 'block' : 'none';
    }

    // Only start searching once at least 5 characters are entered (prevents quota loss)
    if (!query || query.length < 5) {
      if (searchDropdown) {
        searchDropdown.style.display = 'none';
        searchDropdown.innerHTML = '';
      }
      return;
    }

    // Check instant local cache first (consumes 0 API quota)
    const cacheKey = query.toLowerCase();
    let cachedItems = localSearchCache.get(cacheKey);
    if (!cachedItems && typeof localStorage !== 'undefined') {
      try {
        const stored = localStorage.getItem('isa_cache_' + cacheKey);
        if (stored) {
          cachedItems = JSON.parse(stored);
          localSearchCache.set(cacheKey, cachedItems);
        }
      } catch (_) {}
    }

    if (cachedItems && cachedItems.length > 0) {
      renderSearchDropdown(cachedItems, query, []);
      return;
    }

    clearTimeout(realtimeSearchTimer);
    realtimeSearchTimer = setTimeout(async () => {
      if (searchRequestVersion !== currentVersion) return;

      try {
        // Fetch zero-quota auto-complete suggestions from Google YouTube Suggest API
        const suggestions = await api.getSuggestions(query);
        if (searchRequestVersion !== currentVersion) return;

        // Render zero-quota suggestions in the dropdown
        renderSearchDropdown([], query, suggestions);
      } catch (err) {
        console.warn('[Suggestions Error]:', err);
      }
    }, 350); // 350ms debounce
  });

  if (btnClearSearch) {
    btnClearSearch.addEventListener('click', () => {
      searchInput.value = '';
      btnClearSearch.style.display = 'none';
      if (searchDropdown) {
        searchDropdown.style.display = 'none';
        searchDropdown.innerHTML = '';
      }
      searchInput.focus();
    });
  }

  if (btnSubmitSearch) {
    btnSubmitSearch.addEventListener('click', submitSearch);
  }

  const quotaRetryButton = document.getElementById('search-status-retry');
  if (quotaRetryButton) quotaRetryButton.addEventListener('click', retryQueuedQuotaSearch);

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(realtimeSearchTimer);
      submitSearch();
    } else if (e.key === 'Escape') {
      if (searchDropdown) searchDropdown.style.display = 'none';
    }
  });

  // Close search dropdown on click outside
  document.addEventListener('click', (e) => {
    if (searchDropdown && !e.target.closest('#search-container') && !e.target.closest('.search-bar') && !e.target.closest('#search-dropdown')) {
      searchDropdown.style.display = 'none';
    }
  });
}

function submitSearch() {
  const searchInput = document.getElementById('search-input') || document.querySelector('.search-input');
  const query = searchInput?.value.trim();
  if (!query) {
    searchInput?.focus();
    return;
  }
  const statusBanner = document.getElementById('search-status-banner');
  if (statusBanner && !statusBanner.hidden && statusBanner.dataset.state === 'loading') return;
  if (quotaWaitActive && (!Number.isFinite(quotaWaitUntil) || Date.now() < quotaWaitUntil)) {
    queuedQuotaSearch = query;
    if (Number.isFinite(quotaWaitUntil)) updateQuotaWaitStatus();
    return;
  }
  if (quotaWaitActive) hideSearchStatus();
  searchRequestVersion += 1;
  executeFullSearch(query);
}

function renderSearchDropdown(items = [], query, suggestions = []) {
  const searchDropdown = document.getElementById('search-dropdown');
  if (!searchDropdown) return;

  if (items.length === 0 && suggestions.length === 0) {
    searchDropdown.innerHTML = `<div class="search-empty" style="padding:12px;font-size:13px;color:rgba(255,255,255,0.6);">Press Enter to search YouTube for "${query}"</div>`;
    searchDropdown.style.display = 'block';
    return;
  }

  let html = '';

  // 1. Zero-Quota Auto-Complete Suggestions
  if (suggestions.length > 0) {
    html += `<div class="dropdown-header" style="padding:8px 14px;font-size:11px;font-weight:700;color:rgba(255,255,255,0.5);letter-spacing:0.5px;">SUGGESTIONS (0 Quota)</div>`;
    suggestions.slice(0, 5).forEach((sug) => {
      html += `
        <div class="search-dropdown-item suggestion-item" data-suggestion="${encodeURIComponent(sug)}" style="display:flex;align-items:center;padding:9px 14px;cursor:pointer;gap:10px;border-bottom:1px solid rgba(255,255,255,0.05);">
          <span style="opacity:0.6;font-size:13px;">&#128269;</span>
          <span style="font-size:13px;color:#fff;font-weight:500;">${sug}</span>
        </div>
      `;
    });
  }

  // 2. Cached / Direct Song Results
  if (items.length > 0) {
    html += `<div class="dropdown-header" style="padding:8px 14px;font-size:11px;font-weight:700;color:rgba(255,255,255,0.5);letter-spacing:0.5px;">SONGS (Cached)</div>`;
    items.forEach((item, idx) => {
      const isLiked = appState.likedTracks.has(item.videoId);
      html += `
        <div class="search-dropdown-item search-item" data-index="${idx}" data-video-id="${item.videoId}">
          <img class="search-item-thumb search-thumb" src="${item.thumbnail}" alt="" />
          <div class="search-item-info search-info">
            <div class="search-item-title search-title">${item.title}</div>
            <div class="search-item-artist search-artist">${item.artist}</div>
          </div>
          <button type="button" class="search-like-btn ${isLiked ? 'liked' : ''}" title="Save to Library">&#9829;</button>
          <span class="search-item-play-icon search-play-btn">&#9654;</span>
        </div>
      `;
    });
  }

  searchDropdown.innerHTML = html;
  searchDropdown.style.display = 'block';

  // Suggestion click handlers
  searchDropdown.querySelectorAll('.suggestion-item').forEach(elem => {
    elem.addEventListener('click', () => {
      const sug = decodeURIComponent(elem.getAttribute('data-suggestion'));
      const input = document.getElementById('search-input') || document.querySelector('.search-input');
      if (input) input.value = sug;
      searchDropdown.style.display = 'none';
      executeFullSearch(sug, false);
    });
  });

  // Song selection handlers
  searchDropdown.querySelectorAll('.search-item').forEach((elem, idx) => {
    const item = items[idx];
    elem.addEventListener('click', (e) => {
      if (e.target.closest('.search-like-btn')) return;
      playTrackDirect(item, items, idx);
      searchDropdown.style.display = 'none';
    });

    const likeBtn = elem.querySelector('.search-like-btn');
    if (likeBtn) {
      likeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleLikeTrack(item, likeBtn);
      });
    }
  });
}

async function executeFullSearch(query, autoPlay = false) {
  const activeBanner = document.getElementById('search-status-banner');
  if (activeBanner && !activeBanner.hidden && activeBanner.dataset.state === 'loading') return;
  if (quotaWaitActive && (!Number.isFinite(quotaWaitUntil) || Date.now() < quotaWaitUntil)) {
    queuedQuotaSearch = query;
    if (Number.isFinite(quotaWaitUntil)) updateQuotaWaitStatus();
    return;
  }
  if (quotaWaitActive) hideSearchStatus();
  const requestVersion = searchRequestVersion;
  const searchDropdown = document.getElementById('search-dropdown');
  if (searchDropdown) searchDropdown.style.display = 'none';

  switchView('search');

  // Check in-memory and localStorage cache first (consumes ZERO quota!)
  const cacheKey = query.toLowerCase().trim();
  let cachedItems = localSearchCache.get(cacheKey);
  if (!cachedItems && typeof localStorage !== 'undefined') {
    try {
      const stored = localStorage.getItem('isa_cache_' + cacheKey);
      if (stored) {
        cachedItems = JSON.parse(stored);
        localSearchCache.set(cacheKey, cachedItems);
      }
    } catch (_) {}
  }

  if (cachedItems && cachedItems.length > 0) {
    hideSearchStatus();
    const searchTitle = document.getElementById('search-view-title');
    const searchSubtitle = document.getElementById('search-view-subtitle');
    if (searchTitle) searchTitle.textContent = `Search: "${query}" (Cached)`;
    if (searchSubtitle) searchSubtitle.textContent = 'Instant results from local cache — 0 quota units consumed';
    renderSongList(cachedItems, 'search-view-song-list');
    if (autoPlay) {
      playTrackDirect(cachedItems[0], cachedItems, 0);
    }
    showToast(`Loaded from cache (0 quota consumed)`);
    return;
  }

  setSearchStatus('Searching YouTube', 'Connecting to YouTube search proxy...', 'loading');
  const searchTitle = document.getElementById('search-view-title');
  const searchSubtitle = document.getElementById('search-view-subtitle');
  if (searchTitle) searchTitle.textContent = `Search: "${query}"`;
  if (searchSubtitle) searchSubtitle.textContent = 'YouTube results for your query';

  try {
    const data = await api.search(query, 20);
    if (requestVersion !== searchRequestVersion) {
      hideSearchStatus();
      return;
    }
    hideSearchStatus();
    const items = data.items || [];

    // Store in both memory and localStorage to guarantee repeated queries consume 0 quota
    localSearchCache.set(cacheKey, items);
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem('isa_cache_' + cacheKey, JSON.stringify(items));
      } catch (_) {}
    }

    renderSongList(items, 'search-view-song-list');
    refreshQuotaMeter();
    if (autoPlay && items.length > 0) {
      playTrackDirect(items[0], items, 0);
    }
  } catch (err) {
    if (err.isQuotaExceeded) {
      const currentQuery = (document.getElementById('search-input') || document.querySelector('.search-input'))?.value.trim();
      showQuotaWaitStatus(currentQuery || query, err.resetAt);
      refreshQuotaMeter();
      return;
    }
    hideSearchStatus();
    if (requestVersion !== searchRequestVersion) return;
    showToast(`Search error: ${err.message}`, 'error');
  }
}

// ----------------------------------------------------------------------------
// Expandable / Minimizable Player Sheet Handlers
// ----------------------------------------------------------------------------
function setupExpandablePlayer() {
  const miniPlayer = document.getElementById('mini-player');
  const expPlayer = document.getElementById('expandable-player');
  const btnExpand = document.getElementById('btn-expand-player');
  const btnCollapse = document.getElementById('btn-collapse-player');

  const openPlayer = () => {
    if (!expPlayer) return;
    expPlayer.classList.add('is-expanded');
    expPlayer.setAttribute('aria-hidden', 'false');
    appState.isExpanded = true;
  };

  const closePlayer = () => {
    if (!expPlayer) return;
    expPlayer.classList.remove('is-expanded');
    expPlayer.setAttribute('aria-hidden', 'true');
    appState.isExpanded = false;
  };

  if (miniPlayer) {
    miniPlayer.addEventListener('click', (e) => {
      if (e.target.closest('button') || e.target.closest('.progress-bar') || e.target.closest('.volume-bar')) return;
      openPlayer();
    });
  }

  if (btnExpand) btnExpand.addEventListener('click', (e) => { e.stopPropagation(); openPlayer(); });
  if (btnCollapse) btnCollapse.addEventListener('click', (e) => { e.stopPropagation(); closePlayer(); });

  // Escape key to minimize
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && appState.isExpanded) {
      closePlayer();
    }
  });
}

// ----------------------------------------------------------------------------
// Quality Selector Toggles
// ----------------------------------------------------------------------------
function setupQualitySelector() {
  const qualityButtons = document.querySelectorAll('#quality-selector [data-quality], .quality-selector [data-quality]');

  qualityButtons.forEach(btn => {
    const quality = btn.getAttribute('data-quality');
    if (quality === appState.quality) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const newQuality = btn.getAttribute('data-quality');
      if (newQuality && newQuality !== appState.quality) {
        appState.quality = newQuality;
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('isa_quality_preset', newQuality);
        }

        qualityButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        engine.switchQuality(newQuality);
        updateQualityBadge(newQuality);
        showToast(`Audio quality: ${newQuality.toUpperCase()}`);
      }
    });
  });

  updateQualityBadge(appState.quality);
}

function updateQualityBadge(quality) {
  const badge = document.getElementById('current-quality-badge') || document.querySelector('.quality-badge');
  if (badge) {
    const labels = { high: '320kbps', medium: '128kbps', low: '64kbps', flac: 'FLAC Lossless' };
    badge.textContent = labels[quality] || quality.toUpperCase();
  }
}

// ----------------------------------------------------------------------------
// Crossfade Duration Slider Handlers
// ----------------------------------------------------------------------------
function setupCrossfadeControl() {
  const crossfadeSlider = document.getElementById('crossfade-slider');
  const crossfadeValText = document.getElementById('crossfade-value-label');

  if (crossfadeSlider) {
    crossfadeSlider.value = appState.crossfadeDuration;
    if (crossfadeValText) crossfadeValText.textContent = `${appState.crossfadeDuration.toFixed(1)}s`;

    crossfadeSlider.addEventListener('input', () => {
      const val = parseFloat(crossfadeSlider.value);
      appState.crossfadeDuration = val;
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('isa_crossfade_duration', val);
      }
      if (crossfadeValText) crossfadeValText.textContent = `${val.toFixed(1)}s`;
    });
  }
}

// ----------------------------------------------------------------------------
// Progress Bar & Scrubbing
// ----------------------------------------------------------------------------
function setupProgressBars() {
  // Desktop mini-player progress bar & expanded scrubber & top mini track
  const scrubbers = [
    document.getElementById('progress-bar'),
    document.getElementById('mini-progress-container'),
    document.getElementById('mini-progress-track'),
    document.getElementById('expanded-scrubber')
  ].filter(Boolean);

  scrubbers.forEach(container => {
    let isDragging = false;

    const calculateAndSeek = (e) => {
      const rect = container.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
      const percentage = rect.width > 0 ? x / rect.width : 0;
      engine.seek(percentage);
    };

    container.addEventListener('mousedown', (e) => {
      isDragging = true;
      calculateAndSeek(e);
    });

    container.addEventListener('touchstart', (e) => {
      isDragging = true;
      calculateAndSeek(e);
    }, { passive: true });

    window.addEventListener('mousemove', (e) => {
      if (isDragging) calculateAndSeek(e);
    });

    window.addEventListener('touchmove', (e) => {
      if (isDragging) calculateAndSeek(e);
    }, { passive: true });

    window.addEventListener('mouseup', () => { isDragging = false; });
    window.addEventListener('touchend', () => { isDragging = false; });
  });
}

function setBufferingUI(isBuffering) {
  appState.isBuffering = Boolean(isBuffering);
  const elements = document.querySelectorAll(
    '#progress-bar, .progress-bar, #mini-progress-container, .mini-progress-track, #mini-progress-track, #expanded-scrubber, .expanded-scrubber-track, #main-play-pause, .btn-play-pause, #expanded-play-pause, .btn-transport-play'
  );
  elements.forEach(el => {
    if (isBuffering) {
      el.classList.add('is-buffering');
    } else {
      el.classList.remove('is-buffering');
    }
  });
}

function onPlaybackTimeUpdate(currentTime, duration) {
  let effectiveDuration = (duration && isFinite(duration) && duration > 0)
    ? duration
    : (appState.currentTrack?.duration || 0);

  // If effectiveDuration is not yet known, trigger async fetch
  if (!effectiveDuration && appState.currentTrack?.videoId) {
    if (!appState.currentTrack._fetchingDuration) {
      appState.currentTrack._fetchingDuration = true;
      api.getTrackInfo(appState.currentTrack.videoId).then(info => {
        if (info && info.duration) {
          appState.currentTrack.duration = info.duration;
          onPlaybackTimeUpdate(currentTime, info.duration);
        }
      }).catch(() => {});
    }
  }

  const currentStr = formatTime(currentTime);
  const totalStr = effectiveDuration > 0 ? formatTime(effectiveDuration) : (currentTime > 0 ? formatTime(Math.max(currentTime, 180)) : '0:00');
  const percent = effectiveDuration > 0 ? Math.min(100, (currentTime / effectiveDuration) * 100) : 0;

  // Mini player displays
  const timeCurrent = document.getElementById('time-current');
  const timeTotal = document.getElementById('time-total');
  const miniTimeStart = document.getElementById('mini-time-start');
  const miniTimeEnd = document.getElementById('mini-time-end');
  const progressFill = document.getElementById('progress-fill');
  const miniProgressFill = document.getElementById('mini-progress-fill');

  if (timeCurrent) timeCurrent.textContent = currentStr;
  if (timeTotal) timeTotal.textContent = totalStr;
  if (miniTimeStart) miniTimeStart.textContent = currentStr;
  if (miniTimeEnd) miniTimeEnd.textContent = totalStr;
  if (progressFill) progressFill.style.width = `${percent}%`;
  if (miniProgressFill) miniProgressFill.style.width = `${percent}%`;

  // Expanded player displays
  const expTimeCurrent = document.getElementById('expanded-time-current');
  const expTimeTotal = document.getElementById('expanded-time-total');
  const expScrubberFill = document.getElementById('expanded-scrubber-fill');
  const expScrubberThumb = document.getElementById('expanded-scrubber-thumb');

  if (expTimeCurrent) expTimeCurrent.textContent = currentStr;
  if (expTimeTotal) expTimeTotal.textContent = totalStr;
  if (expScrubberFill) expScrubberFill.style.width = `${percent}%`;
  if (expScrubberThumb) expScrubberThumb.style.left = `${percent}%`;

  // Update OS Lock Screen & Notification Center Scrubber Position
  updateMediaSessionPosition(currentTime, effectiveDuration);
}

// ----------------------------------------------------------------------------
// Volume Slider Handlers
// ----------------------------------------------------------------------------
function setupVolumeControl() {
  const miniVolBar = document.getElementById('volume-bar');
  const expVolSlider = document.getElementById('expanded-volume-slider');

  if (miniVolBar) {
    let isDragging = false;
    const handleVol = (e) => {
      const rect = miniVolBar.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
      const volume = rect.width > 0 ? x / rect.width : 0;
      engine.setVolume(volume);
    };

    miniVolBar.addEventListener('mousedown', (e) => {
      isDragging = true;
      handleVol(e);
    });
    window.addEventListener('mousemove', (e) => { if (isDragging) handleVol(e); });
    window.addEventListener('mouseup', () => { isDragging = false; });
  }

  if (expVolSlider) {
    expVolSlider.value = appState.volume * 100;
    expVolSlider.addEventListener('input', () => {
      engine.setVolume(parseFloat(expVolSlider.value) / 100);
    });
  }

  updateVolumeUI(appState.volume);
}

function updateVolumeUI(volume) {
  const volProgress = document.getElementById('volume-progress');
  if (volProgress) volProgress.style.width = `${volume * 100}%`;

  const expVolSlider = document.getElementById('expanded-volume-slider');
  if (expVolSlider) expVolSlider.value = volume * 100;
}

// ----------------------------------------------------------------------------
// View Navigation Handlers
// ----------------------------------------------------------------------------
function setupNavigationViews() {
  // Desktop and mobile navigation links
  const navItems = [
    { el: document.getElementById('nav-home'), view: 'home' },
    { el: document.getElementById('nav-search'), view: 'search' },
    { el: document.getElementById('nav-library'), view: 'library' },
    { el: document.getElementById('nav-offline'), view: 'offline' },
    { el: document.getElementById('mobile-nav-home'), view: 'home' },
    { el: document.getElementById('mobile-nav-search'), view: 'search' },
    { el: document.getElementById('mobile-nav-library'), view: 'library' },
    { el: document.getElementById('mobile-nav-offline'), view: 'offline' }
  ];

  navItems.forEach(({ el, view }) => {
    if (el) {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        switchView(view);
      });
    }
  });

  const btnPlayAllLiked = document.getElementById('btn-play-all-liked');
  if (btnPlayAllLiked) {
    btnPlayAllLiked.addEventListener('click', () => {
      const tracks = Array.from(appState.likedTracks.values());
      if (tracks.length > 0) {
        playTrackDirect(tracks[0], tracks, 0);
      } else {
        showToast('Your liked library is empty.');
      }
    });
  }
}

function switchView(viewName) {
  appState.activeView = viewName;

  document.querySelectorAll('.view-section').forEach(sec => {
    sec.style.display = 'none';
    sec.classList.remove('active');
  });

  const activeSec = document.getElementById(`view-${viewName}`);
  if (activeSec) {
    activeSec.style.display = 'block';
    activeSec.classList.add('active');
  }

  if (viewName === 'offline') {
    renderOfflineView();
  } else if (viewName === 'library') {
    renderLibraryView(Array.from(appState.likedTracks.values()));
  }

  // Update nav active classes
  document.querySelectorAll('.sidebar-nav .nav-link').forEach(link => {
    link.classList.toggle('active', link.getAttribute('data-view') === viewName);
  });
  document.querySelectorAll('.mobile-nav .mobile-nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-view') === viewName);
  });
}

// ----------------------------------------------------------------------------
// UI Rendering & Feedback Helpers
// ----------------------------------------------------------------------------
function updateNowPlayingUI(track) {
  if (!track) return;

  // Mini Player
  const npTitle = document.getElementById('np-title');
  const npArtist = document.getElementById('np-artist');
  const miniCover = document.getElementById('mini-np-cover');

  if (npTitle) npTitle.textContent = track.title;
  if (npArtist) npArtist.textContent = track.artist;
  if (miniCover) {
    miniCover.style.backgroundImage = `url("${track.thumbnail}")`;
    miniCover.style.backgroundSize = 'cover';
    miniCover.style.backgroundPosition = 'center';
  }

  // Expanded Player
  const expTitle = document.getElementById('expanded-title');
  const expArtist = document.getElementById('expanded-artist');
  const expArtwork = document.getElementById('expanded-artwork');
  const expGlow = document.getElementById('expanded-backdrop-glow');

  if (expTitle) expTitle.textContent = track.title;
  if (expArtist) expArtist.textContent = track.artist;
  if (expArtwork) {
    expArtwork.style.backgroundImage = `url("${track.thumbnail}")`;
    expArtwork.style.backgroundSize = 'cover';
    expArtwork.style.backgroundPosition = 'center';
  }
  if (expGlow) {
    expGlow.style.backgroundImage = `radial-gradient(circle at center, rgba(250, 45, 86, 0.4), transparent 70%)`;
  }

  // Update heart buttons
  updateLikedHeartsAcrossUI();

  // Update download button states for this track
  const isDownloaded = isOfflineTrack(track.videoId);
  const miniDl = document.getElementById('mini-btn-download');
  const expDl = document.getElementById('expanded-btn-download');
  if (miniDl) {
    miniDl.classList.toggle('is-downloaded', isDownloaded);
    miniDl.classList.remove('is-downloading');
    miniDl.setAttribute('title', isDownloaded ? 'Downloaded (Tap to remove)' : 'Download for offline playback');
  }
  if (expDl) {
    expDl.classList.toggle('is-downloaded', isDownloaded);
    expDl.classList.remove('is-downloading');
    expDl.setAttribute('title', isDownloaded ? 'Downloaded (Tap to remove)' : 'Download for offline playback');
  }

  // Mark active song in song lists
  document.querySelectorAll('.song-item').forEach(item => {
    const isCurrent = item.getAttribute('data-video-id') === track.videoId;
    item.classList.toggle('is-playing', isCurrent);
    const playBtn = item.querySelector('.btn-play');
    if (playBtn) playBtn.innerHTML = isCurrent && appState.isPlaying ? '&#10074;&#10074;' : '&#9654;';
  });

  // Update Picture-in-Picture cover if active
  if (pipCoverImg && track.thumbnail) {
    pipCoverImg.src = track.thumbnail;
  }

  // OS Lock Screen & Notification Center MediaSession metadata
  updateMediaSession(track);
}

function setPlayPauseUI(isPlaying) {
  if (!isPlaying) setBufferingUI(false);
  const icon = isPlaying ? '&#10074;&#10074;' : '&#9654;';
  const mainPlay = document.getElementById('main-play-pause');
  const expPlay = document.getElementById('expanded-play-pause');

  if (mainPlay) mainPlay.innerHTML = icon;
  if (expPlay) expPlay.innerHTML = icon;

  if (appState.currentTrack) {
    document.querySelectorAll(`.song-item[data-video-id="${appState.currentTrack.videoId}"] .btn-play`).forEach(btn => {
      btn.innerHTML = icon;
    });
  }

  // Sync OS Lock Screen playback state
  updateMediaSessionPlaybackState(isPlaying);

  // Background Audio session tethering (prevents mobile OS from killing audio in sleep/pocket)
  if (isPlaying) {
    ensureBackgroundAudioTether();
  } else {
    pauseBackgroundAudioTether();
  }
}

function renderSongList(items, containerId = 'home-song-list') {
  const list = document.getElementById(containerId);
  if (!list) return;

  let html = `
    <div class="song-header">
      <span class="col-play">#</span>
      <span class="col-title">TITLE</span>
      <span class="col-artist">ARTIST</span>
      <span class="col-actions"></span>
    </div>
  `;

  items.forEach((item, index) => {
    const isLiked = appState.likedTracks.has(item.videoId);
    const isDownloaded = isOfflineTrack(item.videoId);
    html += `
      <div class="song-item" data-video-id="${item.videoId}" data-title="${item.title}" data-artist="${item.artist}" data-thumbnail="${item.thumbnail}">
        <span class="col-play btn-play">&#9654;</span>
        <div class="col-title-group">
          <span class="col-title">${item.title}</span>
          <span class="col-artist mobile-only">${item.artist}</span>
        </div>
        <span class="col-artist desktop-only">${item.artist}</span>
        <div class="col-actions">
          <button type="button" class="btn-download-track ${isDownloaded ? 'is-downloaded' : ''}" data-video-id="${item.videoId}" aria-label="Download song" title="${isDownloaded ? 'Downloaded (Tap to remove)' : 'Download for offline playback'}">
            <svg viewBox="0 0 24 24" class="download-icon" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
          </button>
          <button type="button" class="btn-like-track ${isLiked ? 'is-liked' : ''}" data-video-id="${item.videoId}" aria-label="Like song">
            <svg viewBox="0 0 24 24" class="heart-icon"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"></path></svg>
          </button>
        </div>
      </div>
    `;
  });

  list.innerHTML = html;

  list.querySelectorAll('.song-item').forEach((itemEl, idx) => {
    const item = items[idx];
    itemEl.addEventListener('click', (e) => {
      if (e.target.closest('.btn-like-track') || e.target.closest('.btn-download-track')) return;
      playTrackDirect(item, items, idx);
    });

    const likeBtn = itemEl.querySelector('.btn-like-track');
    if (likeBtn) {
      likeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleLikeTrack(item, likeBtn);
      });
    }

    const dlBtn = itemEl.querySelector('.btn-download-track');
    if (dlBtn) {
      dlBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleDownloadClick(item, dlBtn);
      });
    }
  });
}

function setupStaticContentLinks() {
  document.querySelectorAll('.playlist-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const q = btn.getAttribute('data-query');
      if (q) executeFullSearch(q, false);
    });
  });

  document.querySelectorAll('.album-card').forEach(card => {
    card.addEventListener('click', () => {
      const view = card.getAttribute('data-view');
      if (view === 'library') {
        switchView('library');
        return;
      }
      const q = card.getAttribute('data-query') || card.getAttribute('data-title');
      if (q) executeFullSearch(q, false);
    });
  });
}

// ----------------------------------------------------------------------------
// Recent Played Songs Manager (5 tracks)
// ----------------------------------------------------------------------------
const DEFAULT_RECENT_TRACKS = [
  { videoId: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', artist: 'Rick Astley', thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' },
  { videoId: '9bZkp7q19f0', title: 'Gangnam Style', artist: 'PSY', thumbnail: 'https://i.ytimg.com/vi/9bZkp7q19f0/hqdefault.jpg' },
  { videoId: 'vsWxs1tuwDk', title: 'Winning Speech', artist: 'Karan Aujla', thumbnail: 'https://i.ytimg.com/vi/vsWxs1tuwDk/hqdefault.jpg' },
  { videoId: '4tywp83zkmk', title: 'Cheques', artist: 'Shubh', thumbnail: 'https://i.ytimg.com/vi/4tywp83zkmk/hqdefault.jpg' },
  { videoId: 'gSh1oB3U1n4', title: 'Husn', artist: 'Anuv Jain', thumbnail: 'https://i.ytimg.com/vi/gSh1oB3U1n4/hqdefault.jpg' }
];

function getRecentTracks() {
  if (typeof localStorage === 'undefined') return [...DEFAULT_RECENT_TRACKS];
  try {
    const raw = localStorage.getItem('isa_recent_played');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.slice(0, 5);
      }
    }
  } catch (_) {}
  return [...DEFAULT_RECENT_TRACKS];
}

function recordRecentTrack(track) {
  if (!track || !track.videoId) return;
  try {
    let recents = getRecentTracks();
    recents = recents.filter(t => t.videoId !== track.videoId);
    recents.unshift({
      videoId: track.videoId,
      title: track.title,
      artist: track.artist,
      thumbnail: track.thumbnail,
      duration: track.duration || 0
    });
    recents = recents.slice(0, 5);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('isa_recent_played', JSON.stringify(recents));
    }
    renderRecentTracks();
  } catch (err) {
    console.warn('[RecentTracks] record error:', err);
  }
}

function renderRecentTracks() {
  const container = document.getElementById('home-song-list');
  if (!container) return;
  const tracks = getRecentTracks();
  renderSongList(tracks, 'home-song-list');
}

// ----------------------------------------------------------------------------
// Playback Control & Queue Operations
// ----------------------------------------------------------------------------
function playTrackDirect(track, playlist = [], index = -1) {
  if (playlist.length > 0) {
    appState.playlist = playlist;
    appState.currentIndex = index !== -1 ? index : playlist.findIndex(t => t.videoId === track.videoId);
  }
  engine.playTrack(track);
}

function playTrackByIndex(idx) {
  if (idx >= 0 && idx < appState.playlist.length) {
    appState.currentIndex = idx;
    engine.playTrack(appState.playlist[idx]);
  }
}

async function playNextTrack() {
  if (appState.playlist.length === 0) return;

  if (appState.currentIndex < appState.playlist.length - 1) {
    playTrackByIndex(appState.currentIndex + 1);
    return;
  }

  // End of current queue reached - Autoplay Radio Mode (Apple Music / YouTube Music style)
  const current = appState.currentTrack;
  if (current && current.artist && current.artist !== 'Unknown Artist' && current.artist !== '---') {
    try {
      showToast(`Radio: Finding next tracks for ${current.artist}...`);
      const res = await api.search(current.artist, 10);
      if (res && Array.isArray(res.items) && res.items.length > 0) {
        const existingIds = new Set(appState.playlist.map(t => t.videoId));
        const newTracks = res.items.filter(t => !existingIds.has(t.videoId));
        if (newTracks.length > 0) {
          const nextIdx = appState.playlist.length;
          appState.playlist.push(...newTracks);
          playTrackByIndex(nextIdx);
          return;
        }
      }
    } catch (err) {
      console.warn('[Radio Autoplay] Error fetching next songs:', err);
    }
  }

  // Fallback: loop back to beginning seamlessly
  playTrackByIndex(0);
}

function playPrevTrack() {
  const curTime = engine.getCurrentTime();
  if (curTime > 3.0) {
    engine.seek(0);
    return;
  }
  if (appState.playlist.length === 0) return;
  const prevIdx = (appState.currentIndex - 1 + appState.playlist.length) % appState.playlist.length;
  playTrackByIndex(prevIdx);
}

function onAutoAdvance() {
  playNextTrack();
}

// ============================================================================
// 5. API QUOTA CONSUMPTION INDICATOR & METER
// ============================================================================

async function refreshQuotaMeter() {
  try {
    const quotaData = await api.getQuota();
    appState.quota = quotaData;

    const activeKey = quotaData.activeKey;
    const used = activeKey ? activeKey.requestsUsed : (quotaData.searchCallsUsed ?? quotaData.searchCount ?? 0);
    const total = activeKey ? activeKey.requestsLimit : (quotaData.searchCallsLimit || 100);
    const remaining = activeKey ? activeKey.requestsRemaining : (quotaData.searchCallsRemaining !== undefined ? quotaData.searchCallsRemaining : Math.max(0, total - used));
    const percent = Math.min(Math.max((used / total) * 100, 0), 100);

    const usedEl = document.getElementById('quota-used');
    const totalEl = document.getElementById('quota-total');
    const remainingEl = document.getElementById('quota-remaining');
    const fillEl = document.getElementById('quota-bar-fill');
    const pillText = document.getElementById('quota-pill-text');
    const badgeEl = document.getElementById('quota-badge') || document.querySelector('.quota-badge');
    const quotaIndicator = document.getElementById('quota-indicator');

    if (badgeEl && activeKey) {
      badgeEl.textContent = `KEY ${activeKey.keyIndex}/${activeKey.totalKeys}`;
    }
    if (quotaIndicator && activeKey) {
      quotaIndicator.title = `Active Key: ${activeKey.keyMasked} (Key ${activeKey.keyIndex} of ${activeKey.totalKeys}). Automatically switches when exhausted.`;
    }

    if (usedEl) usedEl.textContent = used.toLocaleString();
    if (totalEl) totalEl.textContent = total.toLocaleString();
    if (remainingEl) remainingEl.textContent = remaining.toLocaleString();
    if (fillEl) {
      fillEl.style.width = `${percent}%`;
      if (percent > 85) fillEl.style.background = '#ff453a';
      else if (percent > 60) fillEl.style.background = '#ff9f0a';
      else fillEl.style.background = 'linear-gradient(90deg, #34c759, #30d158)';
    }

    if (pillText) {
      if (activeKey) {
        pillText.textContent = `Key ${activeKey.keyIndex}/${activeKey.totalKeys} • ${remaining} left`;
      } else {
        pillText.textContent = `${remaining.toLocaleString()} left`;
      }
    }

    const resetEl = document.getElementById('quota-reset-text');
    let resetTimeText = 'Midnight PT (approx 12:30 PM IST)';
    if (resetEl && quotaData.resetsAt) {
      const resetDate = new Date(quotaData.resetsAt);
      const indiaResetTime = new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit'
      }).format(resetDate);
      resetTimeText = `Resets ${indiaResetTime} IST`;
      resetEl.textContent = resetTimeText;
      resetEl.title = 'YouTube daily quota resets at midnight Pacific Time; shown here in India time.';
    }

    // Modal Profile & Quota Card updates (Mobile & Desktop)
    const modalQuotaRemaining = document.getElementById('modal-quota-remaining');
    const modalQuotaKey = document.getElementById('modal-quota-key');
    const modalQuotaFill = document.getElementById('modal-quota-fill');
    const modalQuotaUsedText = document.getElementById('modal-quota-used-text');
    const modalQuotaResetText = document.getElementById('modal-quota-reset-text');

    if (modalQuotaRemaining) {
      modalQuotaRemaining.textContent = `${remaining.toLocaleString()} searches left`;
    }
    if (modalQuotaKey && activeKey) {
      modalQuotaKey.textContent = `Key ${activeKey.keyIndex}/${activeKey.totalKeys}`;
    }
    if (modalQuotaFill) {
      modalQuotaFill.style.width = `${percent}%`;
      if (percent > 85) modalQuotaFill.style.background = '#ff453a';
      else if (percent > 60) modalQuotaFill.style.background = '#ff9f0a';
      else modalQuotaFill.style.background = 'linear-gradient(90deg, #34c759, #30d158)';
    }
    if (modalQuotaUsedText) {
      modalQuotaUsedText.textContent = `${used.toLocaleString()} / ${total.toLocaleString()} used today`;
    }
    if (modalQuotaResetText) {
      modalQuotaResetText.textContent = resetTimeText;
    }
  } catch (err) {
    console.warn('[Quota Watcher Error]:', err);
  }
}

function initQuotaWatcher() {
  refreshQuotaMeter();
  setInterval(refreshQuotaMeter, 60000); // Poll every minute
}

// ============================================================================
// 6. LIKED LIBRARY & USER AUTHENTICATION
// ============================================================================

async function initAuthSession() {
  // If user profile is already cached in localStorage, update UI immediately
  if (appState.user) {
    updateUserUI(appState.user);
    loadLikedLibrary();
    showAdminSection();
  }

  if (appState.token) {
    try {
      const me = await api.getMe(appState.token);
      if (me && me.user) {
        appState.user = me.user;
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('isa_user_data', JSON.stringify(me.user));
        }
        updateUserUI(me.user);
        loadLikedLibrary();
        showAdminSection();
      } else if (me && me.status === 401) {
        // Only logout if server explicitly returned 401
        logoutUser();
      }
    } catch (_) {
      // Network hiccup or offline: preserve existing user session
      console.warn('[Auth Session] Network unreachable or offline, preserving local session.');
    }
  }
  setupAuthModal();
}

async function loadLikedLibrary() {
  if (!appState.token) return;
  try {
    const res = await api.getLibrary(appState.token);
    appState.likedTracks.clear();
    const tracks = res.tracks || [];
    tracks.forEach(t => appState.likedTracks.set(t.videoId, t));

    updateLikedHeartsAcrossUI();
    renderLibraryView(tracks);
  } catch (err) {
    console.warn('[Liked Library Load Error]:', err);
  }
}

function renderLibraryView(tracks = Array.from(appState.likedTracks.values())) {
  const countEl = document.getElementById('liked-count');
  const syncStatus = document.getElementById('library-sync-status');
  const list = document.getElementById('library-song-list');
  if (!list) return;

  const validTracks = (tracks || []).filter(t => t && t.videoId && appState.likedTracks.has(t.videoId));

  if (countEl) countEl.textContent = validTracks.length;
  if (syncStatus) {
    syncStatus.textContent = appState.user ? `Synced with ${appState.user.email}` : 'Sign in to save your likes';
  }

  if (validTracks.length === 0) {
    list.innerHTML = `
      <div class="empty-state" id="library-empty-state" style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 48px 20px; text-align: center;">
        <div class="empty-icon" style="font-size: 40px; margin-bottom: 12px; opacity: 0.8;">💜</div>
        <h4 style="font-size: 16px; font-weight: 700; margin-bottom: 6px; color: var(--text-primary);">No liked songs yet</h4>
        <p style="font-size: 13px; color: var(--text-secondary); max-width: 280px; margin: 0 auto; line-height: 1.5;">Songs you like will appear here. Tap the heart icon on any song to save it to your library.</p>
      </div>
    `;
  } else {
    renderSongList(validTracks, 'library-song-list');
  }
}

function saveLocalLikes() {
  if (typeof localStorage === 'undefined') return;
  try {
    const list = Array.from(appState.likedTracks.values());
    localStorage.setItem('isa_liked_tracks', JSON.stringify(list));
  } catch (_) {}
}

function loadLocalLikes() {
  if (typeof localStorage === 'undefined') {
    renderLibraryView([]);
    return;
  }
  try {
    const stored = localStorage.getItem('isa_liked_tracks');
    if (stored) {
      const list = JSON.parse(stored);
      if (Array.isArray(list)) {
        list.forEach(t => {
          if (t && t.videoId) appState.likedTracks.set(t.videoId, t);
        });
      }
    }
  } catch (_) {}
  updateLikedHeartsAcrossUI();
  renderLibraryView(Array.from(appState.likedTracks.values()));
}

async function toggleLikeTrack(track, buttonEl) {
  if (!track || !track.videoId) {
    showToast('No track selected.');
    return;
  }

  const isLiked = appState.likedTracks.has(track.videoId);

  if (isLiked) {
    appState.likedTracks.delete(track.videoId);
    saveLocalLikes();
    if (buttonEl) buttonEl.classList.remove('is-liked', 'liked');
    if (appState.token) {
      api.unlikeTrack(appState.token, track.videoId).catch(err => console.warn('Sync unlike error:', err));
    }
    showToast(`Removed from Liked Songs.`);
  } else {
    appState.likedTracks.set(track.videoId, track);
    saveLocalLikes();
    if (buttonEl) buttonEl.classList.add('is-liked', 'liked');
    if (appState.token) {
      api.likeTrack(appState.token, track).catch(err => console.warn('Sync like error:', err));
      showToast(`Saved to Liked Songs.`);
    } else {
      showToast(`Saved to Liked Songs.`);
    }
  }

  updateLikedHeartsAcrossUI();
  renderLibraryView(Array.from(appState.likedTracks.values()));
}

function updateLikedHeartsAcrossUI() {
  document.querySelectorAll('.btn-like-track').forEach(btn => {
    const videoId = btn.getAttribute('data-video-id') || btn.closest('[data-video-id]')?.getAttribute('data-video-id');
    if (videoId) {
      btn.classList.toggle('is-liked', appState.likedTracks.has(videoId));
    }
  });

  const isCurrentLiked = appState.currentTrack ? appState.likedTracks.has(appState.currentTrack.videoId) : false;
  document.querySelectorAll('#mini-like-btn, #expanded-like-btn, .btn-like, .btn-like-expanded, #exp-btn-like').forEach(btn => {
    btn.classList.toggle('is-liked', isCurrentLiked);
    btn.setAttribute('aria-pressed', isCurrentLiked ? 'true' : 'false');
  });
}

function setupAuthModal() {
  const modal = document.getElementById('auth-modal');
  const settingsModal = document.getElementById('settings-modal');
  const btnOpenAuth = document.getElementById('btn-open-auth');
  const userChip = document.getElementById('user-chip');
  const mobileNavAuth = document.getElementById('mobile-nav-auth');
  const btnCloseAuth = document.getElementById('btn-close-auth');
  const btnCloseSettings = document.getElementById('btn-close-settings');
  const btnApiKeys = document.getElementById('btn-api-keys');
  const btnQuotaStats = document.getElementById('btn-quota-stats');
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');
  const btnLogout = document.getElementById('btn-logout');
  const tabLogin = document.getElementById('tab-login');
  const tabRegister = document.getElementById('tab-register');
  const tabProfile = document.getElementById('tab-profile');
  const tabApiKeys = document.getElementById('tab-api-keys');
  const tabQuotaStats = document.getElementById('tab-quota-stats');
  const addKeyForm = document.getElementById('add-key-form');
  const bulkImportBtn = document.getElementById('btn-bulk-import');
  const bulkKeysInput = document.getElementById('bulk-keys-input');
  const btnQuickApiKeys = document.getElementById('btn-quick-api-keys');
  const btnQuickQuotaStats = document.getElementById('btn-quick-quota-stats');
  const btnModalLogout = document.getElementById('btn-modal-logout');
  const btnModalLogin = document.getElementById('btn-modal-login');

  // Mobile Bottom Nav Profile / Auth Button
  if (mobileNavAuth) {
    mobileNavAuth.addEventListener('click', (e) => {
      e.preventDefault();
      openSettingsModal('profile');
    });
  }

  // Top header user chip
  if (userChip) {
    userChip.addEventListener('click', () => openSettingsModal('profile'));
  }

  // Open auth modal from desktop header button
  if (btnOpenAuth) {
    btnOpenAuth.addEventListener('click', () => openAuthModal());
  }

  // Open settings modal from sidebar
  if (btnApiKeys) {
    btnApiKeys.addEventListener('click', () => openSettingsModal('api-keys'));
  }
  if (btnQuotaStats) {
    btnQuotaStats.addEventListener('click', () => openSettingsModal('quota-stats'));
  }

  // Close modals
  if (btnCloseAuth) btnCloseAuth.addEventListener('click', closeAuthModal);
  if (btnCloseSettings) btnCloseSettings.addEventListener('click', closeSettingsModal);

  // Auth tab switching
  if (tabLogin) tabLogin.addEventListener('click', () => switchAuthTab('login'));
  if (tabRegister) tabRegister.addEventListener('click', () => switchAuthTab('register'));

  // Settings tab switching
  if (tabProfile) tabProfile.addEventListener('click', () => switchSettingsTab('profile'));
  if (tabApiKeys) tabApiKeys.addEventListener('click', () => switchSettingsTab('api-keys'));
  if (tabQuotaStats) tabQuotaStats.addEventListener('click', () => switchSettingsTab('quota-stats'));

  // Quick navigation buttons inside Profile tab
  if (btnQuickApiKeys) {
    btnQuickApiKeys.addEventListener('click', () => switchSettingsTab('api-keys'));
  }
  if (btnQuickQuotaStats) {
    btnQuickQuotaStats.addEventListener('click', () => switchSettingsTab('quota-stats'));
  }
  if (btnModalLogout) {
    btnModalLogout.addEventListener('click', () => {
      closeSettingsModal();
      logoutUser();
    });
  }
  if (btnModalLogin) {
    btnModalLogin.addEventListener('click', () => {
      closeSettingsModal();
      openAuthModal();
    });
  }

  // Backdrop clicks
  if (modal) {
    modal.addEventListener('click', (e) => { if (e.target === modal) closeAuthModal(); });
  }
  if (settingsModal) {
    settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) closeSettingsModal(); });
  }

  // Login form
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearAuthErrors();
      const email = document.getElementById('login-email')?.value.trim();
      const pass = document.getElementById('login-password')?.value;
      try {
        const res = await api.login(email, pass);
        handleAuthSuccess(res);
        showAdminSection();
      } catch (err) {
        showAuthError('login-error', err.message);
      }
    });
  }

  if (registerForm) {
    registerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearAuthErrors();
      const email = document.getElementById('register-email')?.value.trim();
      const pass = document.getElementById('register-password')?.value;
      try {
        const res = await api.register(email, pass);
        handleAuthSuccess(res);
        showAdminSection();
      } catch (err) {
        showAuthError('register-error', err.message);
      }
    });
  }

  if (btnLogout) {
    btnLogout.addEventListener('click', () => logoutUser());
  }

  // Add key form
  if (addKeyForm) {
    addKeyForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const keyInput = document.getElementById('new-api-key');
      const key = keyInput?.value.trim();
      if (!key) return;

      try {
        const res = await fetch('/api/settings/api-keys', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${appState.token}`
          },
          body: JSON.stringify({ key })
        });
        const data = await res.json();
        if (res.ok) {
          showToast(data.message || 'API key added');
          keyInput.value = '';
          loadApiKeysList();
          refreshQuotaMeter();
        } else {
          showToast(data.error || 'Failed to add key', 'error');
        }
      } catch (err) {
        showToast('Failed to add key', 'error');
      }
    });
  }

  // Bulk import
  if (bulkImportBtn && bulkKeysInput) {
    bulkImportBtn.addEventListener('click', async () => {
      const keysText = bulkKeysInput.value.trim();
      if (!keysText) return;

      try {
        const res = await fetch('/api/settings/api-keys/bulk', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${appState.token}`
          },
          body: JSON.stringify({ keys: keysText })
        });
        const data = await res.json();
        if (res.ok) {
          showToast(data.message || 'Keys imported');
          bulkKeysInput.value = '';
          loadApiKeysList();
          refreshQuotaMeter();
        } else {
          showToast(data.error || 'Failed to import keys', 'error');
        }
      } catch (err) {
        showToast('Failed to import keys', 'error');
      }
    });
  }
}

// Auth Modal Functions
function switchAuthTab(tabName) {
  const tabLogin = document.getElementById('tab-login');
  const tabRegister = document.getElementById('tab-register');
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');
  clearAuthErrors();

  if (tabName === 'register') {
    if (tabLogin) tabLogin.classList.remove('active');
    if (tabRegister) tabRegister.classList.add('active');
    if (loginForm) loginForm.style.display = 'none';
    if (registerForm) registerForm.style.display = 'block';
  } else {
    if (tabLogin) tabLogin.classList.add('active');
    if (tabRegister) tabRegister.classList.remove('active');
    if (loginForm) loginForm.style.display = 'block';
    if (registerForm) registerForm.style.display = 'none';
  }
}
window.switchAuthTab = switchAuthTab;

// Settings Modal Functions
function openSettingsModal(tab = 'profile') {
  const modal = document.getElementById('settings-modal');
  if (modal) {
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    switchSettingsTab(tab);
  }
}

function closeSettingsModal() {
  const modal = document.getElementById('settings-modal');
  if (modal) {
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
  }
}

function switchSettingsTab(tabName) {
  document.querySelectorAll('.settings-tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('#settings-tabs .auth-tab-btn').forEach(el => el.classList.remove('active'));

  const tab = document.getElementById(`tab-${tabName}`);
  const content = document.getElementById(`tab-content-${tabName}`);
  if (tab) tab.classList.add('active');
  if (content) content.classList.add('active');

  if (tabName === 'profile') refreshQuotaMeter();
  if (tabName === 'api-keys') loadApiKeysList();
  if (tabName === 'quota-stats') loadQuotaStats();
  if (tabName === 'playback') loadPlaybackSettings();
}

      async function loadApiKeysList() {
        const listEl = document.getElementById('api-keys-list');
        if (!listEl) return;
  
        try {
          const res = await fetch('/api/settings/api-keys', {
            headers: { 'Authorization': `Bearer ${appState.token}` }
          });
          const data = await res.json();
    
          if (!res.ok || !data.keys) {
            listEl.innerHTML = '<div class="api-key-item error">Failed to load keys</div>';
            return;
          }
    
          if (data.keys.length === 0) {
            listEl.innerHTML = '<div class="api-key-item empty">No API keys configured. Add one above.</div>';
            return;
          }
    
          listEl.innerHTML = data.keys.map(k => `
            <div class="api-key-item" data-masked="${k.masked}">
              <span class="key-masked">${k.masked}</span>
              <div class="key-actions">
                <span class="key-status ${k.healthy ? 'healthy' : 'unhealthy'}">${k.healthy ? 'Active' : 'Issues'}</span>
                <span class="key-errors">${k.errors || 0} errors</span>
                <button type="button" class="btn-delete-key" data-masked="${k.masked}" title="Remove key">×</button>
              </div>
            </div>
          `).join('');
    
          // Add delete handlers
          listEl.querySelectorAll('.btn-delete-key').forEach(btn => {
            btn.addEventListener('click', async (e) => {
              e.stopPropagation();
              const masked = btn.dataset.masked;
              if (confirm(`Remove API key ${masked}?`)) {
                try {
                  const res = await fetch(`/api/settings/api-keys/${encodeURIComponent(masked)}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${appState.token}` }
                  });
                  if (res.ok) {
                    showToast('API key removed');
                    loadApiKeysList();
                  } else {
                    showToast('Failed to remove key', 'error');
                  }
                } catch (err) {
                  showToast('Failed to remove key', 'error');
                }
              }
            });
          });
        } catch (err) {
          console.error('[Settings] Error loading API keys:', err);
          listEl.innerHTML = '<div class="api-key-item error">Error loading keys</div>';
        }
      }

      async function loadQuotaStats() {
        const tableEl = document.getElementById('quota-stats-table');
        if (!tableEl) return;
  
        try {
          const res = await fetch('/api/settings/quota-stats', {
            headers: { 'Authorization': `Bearer ${appState.token}` }
          });
          const data = await res.json();
    
          if (!res.ok || !data.stats) {
            tableEl.innerHTML = '<div class="key-loading">Failed to load stats</div>';
            return;
          }
    
          tableEl.innerHTML = `
            <table class="stats-table">
              <thead>
                <tr>
                  <th>API Key</th>
                  <th>Status</th>
                  <th>Requests</th>
                  <th>Errors</th>
                  <th>Last Success</th>
                  <th>Quota Exhausted</th>
                </tr>
              </thead>
              <tbody>
                ${data.stats.map(k => `
                  <tr>
                    <td><code>${k.masked}</code></td>
                    <td><span class="status-badge ${k.healthy ? 'healthy' : 'unhealthy'}">${k.healthy ? 'Healthy' : 'Unhealthy'}</span></td>
                    <td>${k.totalRequests || 0}</td>
                    <td>${k.errors || 0}</td>
                    <td>${k.lastSuccess ? new Date(k.lastSuccess).toLocaleString() : 'Never'}</td>
                    <td>${k.quotaExhausted ? 'Yes' : 'No'}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          `;
        } catch (err) {
          console.error('[Settings] Error loading quota stats:', err);
          tableEl.innerHTML = '<div class="key-loading">Error loading stats</div>';
        }
      }

      function showAdminSection() {
        const adminSection = document.getElementById('admin-section');
        if (adminSection && appState.token) {
          adminSection.style.display = 'block';
        }
      }

function openAuthModal(msg = '') {
  const modal = document.getElementById('auth-modal');
  if (modal) {
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
  }
}

function closeAuthModal() {
  const modal = document.getElementById('auth-modal');
  if (modal) {
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
  }
  clearAuthErrors();
}

function clearAuthErrors() {
  const errLog = document.getElementById('login-error');
  const errReg = document.getElementById('register-error');
  if (errLog) { errLog.style.display = 'none'; errLog.textContent = ''; }
  if (errReg) { errReg.style.display = 'none'; errReg.textContent = ''; }
}

function showAuthError(elementId, msg) {
  const errEl = document.getElementById(elementId);
  if (errEl) {
    errEl.textContent = msg;
    errEl.style.display = 'block';
  } else {
    alert(msg);
  }
}

function handleAuthSuccess(res) {
  appState.token = res.token;
  appState.user = res.user;
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('isa_auth_token', res.token);
    localStorage.setItem('isa_user_data', JSON.stringify(res.user));
  }

  updateUserUI(res.user);
  closeAuthModal();
  loadLikedLibrary();
  showToast(`Welcome, ${res.user.email}!`);
}

function logoutUser() {
  appState.token = null;
  appState.user = null;
  appState.likedTracks.clear();
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('isa_auth_token');
    localStorage.removeItem('isa_user_data');
  }
  updateUserUI(null);
  updateLikedHeartsAcrossUI();
  renderLibraryView([]);
  showToast('Signed out.');
}

function updateUserUI(user) {
  const userChip = document.getElementById('user-chip');
  const btnAuth = document.getElementById('btn-open-auth');
  const userEmail = document.getElementById('user-email');
  const userAvatar = document.getElementById('user-avatar');
  const syncStatus = document.getElementById('library-sync-status');
  const mobileNavAuth = document.getElementById('mobile-nav-auth');

  // Modal Profile Card elements
  const modalEmail = document.getElementById('modal-profile-email');
  const modalAvatar = document.getElementById('modal-profile-avatar');
  const modalBadge = document.getElementById('modal-profile-badge');
  const btnModalLogout = document.getElementById('btn-modal-logout');
  const btnModalLogin = document.getElementById('btn-modal-login');

  if (user) {
    if (btnAuth) btnAuth.style.display = 'none';
    if (userChip) userChip.style.display = 'inline-flex';
    if (userEmail) userEmail.textContent = user.email;
    if (userAvatar) userAvatar.textContent = (user.email || 'U').charAt(0).toUpperCase();
    if (syncStatus) syncStatus.textContent = `Synced with ${user.email}`;

    if (modalEmail) modalEmail.textContent = user.email;
    if (modalAvatar) modalAvatar.textContent = (user.email || 'U').charAt(0).toUpperCase();
    if (modalBadge) {
      modalBadge.textContent = 'Active Account';
      modalBadge.className = 'modal-profile-badge active';
    }
    if (btnModalLogout) btnModalLogout.style.display = 'inline-flex';
    if (btnModalLogin) btnModalLogin.style.display = 'none';

    if (mobileNavAuth) {
      const label = mobileNavAuth.querySelector('span');
      if (label) label.textContent = (user.email || 'Account').split('@')[0];
    }
  } else {
    if (btnAuth) btnAuth.style.display = 'inline-flex';
    if (userChip) userChip.style.display = 'none';
    if (syncStatus) syncStatus.textContent = 'Sign in to save your likes';

    if (modalEmail) modalEmail.textContent = 'Not Signed In';
    if (modalAvatar) modalAvatar.textContent = 'U';
    if (modalBadge) {
      modalBadge.textContent = 'Guest Session';
      modalBadge.className = 'modal-profile-badge guest';
    }
    if (btnModalLogout) btnModalLogout.style.display = 'none';
    if (btnModalLogin) btnModalLogin.style.display = 'inline-flex';

    if (mobileNavAuth) {
      const label = mobileNavAuth.querySelector('span');
      if (label) label.textContent = 'Profile';
    }
  }
}

// ----------------------------------------------------------------------------
// Playback Settings Load & Save
// ----------------------------------------------------------------------------
function loadPlaybackSettings() {
  const wakeLockToggle = document.getElementById('toggle-wake-lock');
  const bgTetherToggle = document.getElementById('toggle-bg-tether');
  const autoResumeToggle = document.getElementById('toggle-auto-resume');
  const crossfadeSlider = document.getElementById('crossfade-duration-slider');
  const crossfadeDisplay = document.getElementById('crossfade-value-display');
  const crossfadeCurveSelect = document.getElementById('crossfade-curve-select');

  if (wakeLockToggle) {
    wakeLockToggle.checked = appState.wakeLockEnabled;
    wakeLockToggle.addEventListener('change', () => {
      appState.wakeLockEnabled = wakeLockToggle.checked;
      localStorage.setItem('isa_wake_lock_enabled', appState.wakeLockEnabled);
      if (appState.wakeLockEnabled && appState.isPlaying) {
        ensureWakeLockForPlayback();
      } else if (!appState.wakeLockEnabled) {
        releaseWakeLock();
      }
      showToast(`Wake Lock ${appState.wakeLockEnabled ? 'enabled' : 'disabled'}`);
    });
  }

  if (bgTetherToggle) {
    bgTetherToggle.checked = appState.bgTetherEnabled;
    bgTetherToggle.addEventListener('change', () => {
      appState.bgTetherEnabled = bgTetherToggle.checked;
      localStorage.setItem('isa_bg_tether_enabled', appState.bgTetherEnabled);
      if (!appState.bgTetherEnabled) {
        pauseBackgroundAudioTether();
      } else if (appState.isPlaying) {
        ensureBackgroundAudioTether();
      }
      showToast(`Background Audio Tether ${appState.bgTetherEnabled ? 'enabled' : 'disabled'}`);
    });
  }

  if (autoResumeToggle) {
    autoResumeToggle.checked = appState.autoResumeEnabled;
    autoResumeToggle.addEventListener('change', () => {
      appState.autoResumeEnabled = autoResumeToggle.checked;
      localStorage.setItem('isa_auto_resume_enabled', appState.autoResumeEnabled);
      showToast(`Auto-resume ${appState.autoResumeEnabled ? 'enabled' : 'disabled'}`);
    });
  }

  if (crossfadeSlider && crossfadeDisplay) {
    crossfadeSlider.value = appState.crossfadeDuration;
    crossfadeDisplay.textContent = `${appState.crossfadeDuration.toFixed(1)}s`;
    crossfadeSlider.addEventListener('input', () => {
      const val = parseFloat(crossfadeSlider.value);
      crossfadeDisplay.textContent = `${val.toFixed(1)}s`;
    });
    crossfadeSlider.addEventListener('change', () => {
      const val = parseFloat(crossfadeSlider.value);
      appState.crossfadeDuration = val;
      localStorage.setItem('isa_crossfade_duration', val);
      showToast(`Crossfade duration: ${val.toFixed(1)}s`);
    });
  }

  if (crossfadeCurveSelect) {
    crossfadeCurveSelect.value = appState.crossfadeCurve;
    crossfadeCurveSelect.addEventListener('change', () => {
      appState.crossfadeCurve = crossfadeCurveSelect.value;
      localStorage.setItem('isa_crossfade_curve', appState.crossfadeCurve);
      showToast(`Crossfade curve: ${appState.crossfadeCurve}`);
    });
  }
}

// ----------------------------------------------------------------------------
// General Utility Functions
// ----------------------------------------------------------------------------
function formatTime(seconds) {
  if (isNaN(seconds) || !isFinite(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function showToast(message, type = 'info') {
  if (typeof document === 'undefined') return;

  let toastContainer = document.getElementById('toast-container');
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.id = 'toast-container';
    toastContainer.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
    document.body.appendChild(toastContainer);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toast.style.cssText = 'background:rgba(20,20,25,0.95);color:#fff;padding:8px 18px;border-radius:20px;font-size:13px;backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.15);box-shadow:0 4px 16px rgba(0,0,0,0.5);transition:opacity 0.3s;';

  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

// Export for module/test verification if in Node environment
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    appState,
    api,
    WebAudioCrossfadeEngine,
    engine,
    formatTime
  };
}
