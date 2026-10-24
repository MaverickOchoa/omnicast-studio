const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'database.json');
const UPLOADS_VIDEOS_DIR = path.join(PUBLIC_DIR, 'uploads', 'videos');

// Ensure persistent database & video upload directories exist
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOADS_VIDEOS_DIR)) fs.mkdirSync(UPLOADS_VIDEOS_DIR, { recursive: true });
} catch (dirErr) {
  console.warn('Warning creating data/uploads dirs:', dirErr.message);
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg'
};

// Persistent Database Helper (data/database.json)
let persistentDb = {
  libraryItems: [],
  layer3Videos: [],
  updatedAt: null
};

function loadPersistentDatabase() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.libraryItems)) persistentDb.libraryItems = parsed.libraryItems;
        if (Array.isArray(parsed.layer3Videos)) persistentDb.layer3Videos = parsed.layer3Videos;
        persistentDb.updatedAt = parsed.updatedAt || new Date().toISOString();
      }
    }
  } catch (e) {
    console.warn('[OmniCast DB] Error reading database.json:', e.message);
  }
  return persistentDb;
}

function savePersistentDatabase() {
  try {
    persistentDb.updatedAt = new Date().toISOString();
    fs.writeFileSync(DB_FILE, JSON.stringify(persistentDb, null, 2), 'utf8');
  } catch (e) {
    console.warn('[OmniCast DB] Error writing database.json:', e.message);
  }
}

loadPersistentDatabase();

// Global Studio State for Real-Time Multi-Device Sync (WiFi Remote, Stage, Studio)
let studioState = {
  itemIndex: 0,
  slideIndex: 0,
  isBlackout: false,
  timerSeconds: 2100, // 35 min default
  timerRunning: false,
  stageMessage: '',
  theme: 'purple',
  tvMode: 'LOBBY', // 'LOBBY' | 'SERVICE' | 'ANNOUNCEMENTS'
  tvAlert: '',
  lastServiceRecap: null,
  libraryItems: persistentDb.libraryItems.length > 0 ? persistentDb.libraryItems : []
};

// Mobile Cameras & WebRTC State (OmniCast Mobile Cam)
let mobileCamsState = {
  1: { connected: false, name: 'Cámara 1 (Púlpito)', battery: null, fps: 30, res: '1080p', tally: 'IDLE', lastPing: 0 },
  2: { connected: false, name: 'Cámara 2 (Altar)', battery: null, fps: 30, res: '1080p', tally: 'IDLE', lastPing: 0 },
  3: { connected: false, name: 'Cámara 3 (Músicos)', battery: null, fps: 30, res: '1080p', tally: 'IDLE', lastPing: 0 },
  4: { connected: false, name: 'Cámara 4 (Móvil)', battery: null, fps: 30, res: '1080p', tally: 'IDLE', lastPing: 0 }
};

// Master RTMP / RTMPS Live Streaming State (Facebook Live & YouTube Live Multi-Destination)
let liveStreamState = {
  isStreaming: false,
  startTime: null,
  destinations: {
    youtube: { enabled: false, url: '', key: '' },
    facebook: { enabled: false, url: '', key: '' }
  },
  stats: {
    fps: 0,
    bitrate: 0,
    speed: '1x',
    totalBytes: 0,
    droppedFrames: 0,
    error: null
  }
};
let activeFfmpegProcess = null;
let activeStreamWebSocket = null;
let currentTallyState = { programCam: 0, previewCam: 0 };
const camSignalsForStudio = []; // Signals from phones for studio
const camSignalsForPhones = { 1: [], 2: [], 3: [], 4: [] }; // Signals from studio for phones

// Connected SSE clients (phones, iPads, stage monitors, studio)
const sseClients = new Set();

function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

// Background timer ticker
setInterval(() => {
  if (studioState.timerRunning && studioState.timerSeconds > 0) {
    studioState.timerSeconds--;
    broadcastSSE('timer', { seconds: studioState.timerSeconds, running: true });
  } else if (studioState.timerRunning && studioState.timerSeconds === 0) {
    studioState.timerRunning = false;
    broadcastSSE('timer', { seconds: 0, running: false });
  }
}, 1000);

function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const k in interfaces) {
    for (const k2 in interfaces[k]) {
      const address = interfaces[k][k2];
      if (address.family === 'IPv4' && !address.internal) {
        addresses.push(address.address);
      }
    }
  }
  return addresses;
}

// Master Request Handler (shared by both HTTP and HTTPS listeners)
const requestHandler = (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsedUrl = req.url.split('?')[0];

  // API 1: Local Network Info & QR Details
  if (parsedUrl === '/api/info') {
    const ips = getLocalIpAddresses();
    const primaryIp = ips[0] || 'localhost';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      primaryIp,
      port: PORT,
      httpsPort: HTTPS_PORT,
      allIps: ips,
      remoteUrl: `http://${primaryIp}:${PORT}/remote.html`,
      stageUrl: `http://${primaryIp}:${PORT}/stage.html`,
      projectorUrl: `http://${primaryIp}:${PORT}/projector.html`,
      tvUrl: `http://${primaryIp}:${PORT}/tv.html`,
      camUrls: {
        1: `http://${primaryIp}:${PORT}/cam.html?id=1`,
        2: `http://${primaryIp}:${PORT}/cam.html?id=2`,
        3: `http://${primaryIp}:${PORT}/cam.html?id=3`,
        4: `http://${primaryIp}:${PORT}/cam.html?id=4`
      },
      camHttpsUrls: {
        1: `https://${primaryIp}:${HTTPS_PORT}/cam.html?id=1`,
        2: `https://${primaryIp}:${HTTPS_PORT}/cam.html?id=2`,
        3: `https://${primaryIp}:${HTTPS_PORT}/cam.html?id=3`,
        4: `https://${primaryIp}:${HTTPS_PORT}/cam.html?id=4`
      }
    }));
    return;
  }

  // API 2: Server-Sent Events (Live WiFi Push to phones/iPads/Studio)
  if (parsedUrl === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    while (sseClients.size >= 3) { const oldest = sseClients.values().next().value; if (!oldest) break; sseClients.delete(oldest); try { oldest.end(); } catch (e) {} }
    sseClients.add(res);
    // Send immediate current state
    res.write(`event: state\ndata: ${JSON.stringify(studioState)}\n\n`);
    res.write(`event: cam_tally\ndata: ${JSON.stringify(currentTallyState)}\n\n`);

    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // API 3: Get Current State
  if (parsedUrl === '/api/state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(studioState));
    return;
  }

  // API 4: Sync Studio State from main index.html
  if (parsedUrl === '/api/sync' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        if (typeof payload.itemIndex === 'number') studioState.itemIndex = payload.itemIndex;
        if (typeof payload.slideIndex === 'number') studioState.slideIndex = payload.slideIndex;
        if (typeof payload.isBlackout === 'boolean') studioState.isBlackout = payload.isBlackout;
        if (typeof payload.theme === 'string') studioState.theme = payload.theme;
        if (Array.isArray(payload.libraryItems)) {
          studioState.libraryItems = payload.libraryItems;
          if (payload.persistDb) {
            persistentDb.libraryItems = payload.libraryItems;
            savePersistentDatabase();
          }
        }
        if (payload.currentSlidePayload) {
          studioState.currentSlidePayload = payload.currentSlidePayload;
          broadcastSSE('slide_payload', payload.currentSlidePayload);
        }

        broadcastSSE('state', studioState);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // API 5: Receive Actions from Mobile Remote (Next slide, Prev slide, Timer, etc.)
  if (parsedUrl === '/api/action' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const action = data.action;

        if (action === 'next_slide') {
          studioState.isBlackout = false;
          const currentItem = studioState.libraryItems[studioState.itemIndex];
          if (currentItem && currentItem.slides) {
            if (studioState.slideIndex < currentItem.slides.length - 1) {
              studioState.slideIndex++;
            } else if (studioState.itemIndex < studioState.libraryItems.length - 1) {
              studioState.itemIndex++;
              studioState.slideIndex = 0;
            }
          }
        } else if (action === 'prev_slide') {
          studioState.isBlackout = false;
          if (studioState.slideIndex > 0) {
            studioState.slideIndex--;
          } else if (studioState.itemIndex > 0) {
            studioState.itemIndex--;
            const prevItem = studioState.libraryItems[studioState.itemIndex];
            studioState.slideIndex = (prevItem && prevItem.slides) ? prevItem.slides.length - 1 : 0;
          }
        } else if (action === 'set_slide') {
          studioState.isBlackout = false;
          if (typeof data.itemIndex === 'number') studioState.itemIndex = data.itemIndex;
          if (typeof data.slideIndex === 'number') studioState.slideIndex = data.slideIndex;
        } else if (action === 'blackout') {
          studioState.isBlackout = (typeof data.isBlackout === 'boolean') ? data.isBlackout : !studioState.isBlackout;
        } else if (action === 'timer_start') {
          studioState.timerRunning = true;
        } else if (action === 'timer_pause') {
          studioState.timerRunning = false;
        } else if (action === 'timer_reset') {
          studioState.timerSeconds = typeof data.seconds === 'number' ? data.seconds : 2100;
          studioState.timerRunning = false;
        } else if (action === 'timer_adjust') {
          const delta = typeof data.delta === 'number' ? data.delta : 0;
          studioState.timerSeconds = Math.max(0, studioState.timerSeconds + delta);
        } else if (action === 'stage_message') {
          studioState.stageMessage = data.message || '';
        } else if (action === 'set_tv_mode') {
          studioState.tvMode = data.mode || 'LOBBY';
        } else if (action === 'set_tv_alert') {
          studioState.tvAlert = data.alert || '';
        }

        broadcastSSE('state', studioState);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, state: studioState }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // =========================================================================
  // OMNICAST MOBILE CAM: WEBRTC SIGNALING & TALLY ENDPOINTS
  // =========================================================================

  // Endpoint: Exchange WebRTC Signal (Offer / Answer / ICE Candidate)
  if (parsedUrl === '/api/cam/signal' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const sig = JSON.parse(body);
        const camId = parseInt(sig.camId || 1, 10);
        if (sig.from === 'phone') {
          camSignalsForStudio.push(sig);
          broadcastSSE('cam_signal', sig);
        } else if (sig.from === 'studio') {
          if (!camSignalsForPhones[camId]) camSignalsForPhones[camId] = [];
          camSignalsForPhones[camId].push(sig);
          broadcastSSE('cam_signal', sig);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Endpoint: Poll WebRTC Signals & Tally Status
  if (parsedUrl === '/api/cam/poll' && req.method === 'GET') {
    const fullUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const camId = parseInt(fullUrl.searchParams.get('id') || '1', 10);
    const from = fullUrl.searchParams.get('from') || 'phone';

    let signals = [];
    if (from === 'phone') {
      // Phone is asking for signals from studio
      signals = camSignalsForPhones[camId] || [];
      camSignalsForPhones[camId] = [];
    } else {
      // Studio is asking for signals from phones
      signals = camSignalsForStudio.splice(0, camSignalsForStudio.length);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      signals,
      tally: currentTallyState,
      cams: mobileCamsState
    }));
    return;
  }

  // Endpoint: Update Mobile Camera Telemetry (Battery, Device Name, etc.)
  if (parsedUrl === '/api/cam/status' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const status = JSON.parse(body);
        const camId = parseInt(status.camId || 1, 10);
        if (mobileCamsState[camId]) {
          mobileCamsState[camId].connected = true;
          mobileCamsState[camId].lastPing = Date.now();
          if (status.battery !== undefined) mobileCamsState[camId].battery = status.battery;
          if (status.facingMode) mobileCamsState[camId].facingMode = status.facingMode;
          if (status.userAgent) mobileCamsState[camId].userAgent = status.userAgent;
        }
        broadcastSSE('cam_status', { camId, status: mobileCamsState[camId] });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Endpoint: Update Live Tally from Studio
  if (parsedUrl === '/api/cam/tally' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const tally = JSON.parse(body);
        currentTallyState.programCam = parseInt(tally.programCam || 0, 10);
        currentTallyState.previewCam = parseInt(tally.previewCam || 0, 10);
        broadcastSSE('cam_tally', currentTallyState);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, tally: currentTallyState }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // API 6: Service Recap (Post-Culto & CCLI Licensing Audit)
  if (parsedUrl === '/api/recap') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(studioState.lastServiceRecap || { status: 'empty' }));
      return;
    } else if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const recapData = JSON.parse(body);
          studioState.lastServiceRecap = recapData;
          broadcastSSE('recap', recapData);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Recap guardado en servidor' }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
  }
  // =========================================================================
  // MASTER RTMP / RTMPS LIVE STREAMING PIPELINE (FACEBOOK LIVE & YOUTUBE LIVE)
  // Endpoint: Get Live Streaming Status & Real Telemetry
  if (parsedUrl === '/api/stream/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      isStreaming: liveStreamState.isStreaming,
      startTime: liveStreamState.startTime,
      stats: liveStreamState.stats,
      destinations: liveStreamState.destinations
    }));
    return;
  }

  // Endpoint: Client-Side Stream Diagnostic Logger
  if (parsedUrl === '/api/stream/client-log' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        console.log(`[Client Stream Log] ${data.event}:`, JSON.stringify(data.details || {}));
      } catch (e) {
        console.log('[Client Stream Log Raw]:', body);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // Endpoint: Start Live RTMP/RTMPS Stream via FFmpeg (HTTP Compatibility)
  if (parsedUrl === '/api/stream/start' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const dest = JSON.parse(body || '{}');
        const yt = dest.youtube || {};
        const fb = dest.facebook || {};
        const targetNames = [];
        if (fb.enabled && fb.key && fb.key.trim() && fb.key.trim() !== 'FB-1049284729184712-live') {
          targetNames.push('Facebook Live');
        }
        if (yt.enabled && yt.key && yt.key.trim() && yt.key.trim() !== 'yt-live-9382-7712-4412-omni') {
          targetNames.push('YouTube Live');
        }
        if (targetNames.length === 0) {
          const errPayload = JSON.stringify({ error: 'No hay destinos de transmisión con clave válida configurada.' });
          res.writeHead(400, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(errPayload) });
          res.end(errPayload);
          return;
        }

        // Send HTTP 200 response FIRST before spawning FFmpeg so child_process.spawn on Windows
        // never inherits the open HTTP socket handle or delays the response to the browser!
        const okPayload = JSON.stringify({
          success: true,
          message: `Transmisión iniciada exitosamente a ${targetNames.join(' y ')}`,
          destinations: targetNames
        });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(okPayload),
          'Cache-Control': 'no-cache'
        });
        res.end(okPayload);

        setTimeout(() => {
          startFfmpegStream(dest, null);
        }, 10);
      } catch (err) {
        const errPayload = JSON.stringify({ error: err.message });
        res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(errPayload) });
        res.end(errPayload);
      }
    });
    return;
  }

  // Endpoint: Stop Live Stream (HTTP Fallback)
  if (parsedUrl === '/api/stream/stop' && req.method === 'POST') {
    const okPayload = JSON.stringify({ success: true, stopped: true });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(okPayload) });
    res.end(okPayload);
    setTimeout(() => stopFfmpegStream(), 5);
    return;
  }

  // Endpoint: Ingest Live Binary Stream Chunks (HTTP Compatibility)
  if (parsedUrl === '/api/stream/chunk' && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      if (buffer.length > 0) {
        writeChunkToFfmpeg(buffer, 'HTTP');
      }
      const okPayload = JSON.stringify({ ok: true, bytes: liveStreamState.stats.totalBytes });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(okPayload) });
      res.end(okPayload);
    });
    return;
  }

  // =========================================================================
  // PERSISTENT DATABASE & MEDIA / VIDEO UPLOAD ENGINE (LETRAS & VIDEOS)
  // =========================================================================

  // Endpoint: Get Persistent Database (Lyrics, Bible, Uploaded Videos, Layer 3 Videos)
  if (parsedUrl === '/api/db' && req.method === 'GET') {
    loadPersistentDatabase();
    // Also scan uploads/videos directory to ensure any uploaded .mp4/.webm/.mov is indexed
    let diskVideos = [];
    try {
      if (fs.existsSync(UPLOADS_VIDEOS_DIR)) {
        const files = fs.readdirSync(UPLOADS_VIDEOS_DIR);
        diskVideos = files.filter(f => /\.(mp4|webm|mov|mkv)$/i.test(f)).map(f => {
          const st = fs.statSync(path.join(UPLOADS_VIDEOS_DIR, f));
          return {
            filename: f,
            url: `/uploads/videos/${encodeURIComponent(f)}`,
            sizeBytes: st.size,
            createdAt: st.mtime
          };
        });
      }
    } catch (e) {}

    const payload = JSON.stringify({
      libraryItems: persistentDb.libraryItems,
      layer3Videos: persistentDb.layer3Videos,
      diskVideos,
      updatedAt: persistentDb.updatedAt
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(payload);
    return;
  }

  // Endpoint: Save / Sync Persistent Database (Songs, Lyrics, Videos)
  if (parsedUrl === '/api/db/save' && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        const data = JSON.parse(body || '{}');
        if (Array.isArray(data.libraryItems)) {
          persistentDb.libraryItems = data.libraryItems;
          studioState.libraryItems = data.libraryItems;
        }
        if (Array.isArray(data.layer3Videos)) {
          persistentDb.layer3Videos = data.layer3Videos;
        }
        savePersistentDatabase();
        broadcastSSE('state', studioState);
        broadcastSSE('db_update', {
          libraryItems: persistentDb.libraryItems,
          layer3Videos: persistentDb.layer3Videos,
          updatedAt: persistentDb.updatedAt
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          count: persistentDb.libraryItems.length,
          updatedAt: persistentDb.updatedAt
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Endpoint: Delete an Item (Song or Video) from Persistent Database
  if (parsedUrl === '/api/db/delete' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const targetId = data.id;
        if (!targetId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Falta ID del elemento a eliminar' }));
          return;
        }

        const itemToDelete = persistentDb.libraryItems.find(i => i.id === targetId);
        if (itemToDelete && itemToDelete.videoUrl && itemToDelete.videoUrl.startsWith('/uploads/videos/') && data.deleteFile !== false) {
          try {
            const filename = decodeURIComponent(itemToDelete.videoUrl.replace('/uploads/videos/', ''));
            const safePath = path.join(UPLOADS_VIDEOS_DIR, path.basename(filename));
            if (fs.existsSync(safePath)) fs.unlinkSync(safePath);
          } catch (delErr) {}
        }

        persistentDb.libraryItems = persistentDb.libraryItems.filter(i => i.id !== targetId);
        persistentDb.layer3Videos = persistentDb.layer3Videos.filter(v => v.id !== targetId);
        studioState.libraryItems = persistentDb.libraryItems;
        savePersistentDatabase();

        broadcastSSE('state', studioState);
        broadcastSSE('db_update', {
          libraryItems: persistentDb.libraryItems,
          layer3Videos: persistentDb.layer3Videos,
          updatedAt: persistentDb.updatedAt
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, libraryItems: persistentDb.libraryItems, layer3Videos: persistentDb.layer3Videos }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Endpoint: Stream Upload of Binary Video File (.mp4, .webm, .mov) to Disk & Database
  if (parsedUrl === '/api/upload/video' && req.method === 'POST') {
    try {
      const fullUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const rawFilename = fullUrl.searchParams.get('filename') || 'video.mp4';
      const title = (fullUrl.searchParams.get('title') || rawFilename.replace(/\.[^/.]+$/, '')).trim();
      const author = (fullUrl.searchParams.get('author') || 'Video Proyección HD').trim();
      const scope = (fullUrl.searchParams.get('scope') || '📍 SEDE LOCAL').trim();
      const durationSec = parseFloat(fullUrl.searchParams.get('duration') || '120') || 120;

      const ext = path.extname(rawFilename).toLowerCase() || '.mp4';
      const baseSafe = path.basename(rawFilename, ext).replace(/[^a-zA-Z0-9_\-\.]/g, '_').slice(0, 60) || 'video';
      const finalFilename = `${Date.now()}_${baseSafe}${ext}`;
      const destPath = path.join(UPLOADS_VIDEOS_DIR, finalFilename);

      const writeStream = fs.createWriteStream(destPath);
      let uploadedBytes = 0;

      req.on('data', chunk => {
        uploadedBytes += chunk.length;
      });

      req.pipe(writeStream);

      writeStream.on('finish', () => {
        const videoUrl = `/uploads/videos/${finalFilename}`;
        const mins = Math.floor(durationSec / 60);
        const secs = Math.floor(durationSec % 60);
        const durationFormatted = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        const sizeMb = (uploadedBytes / (1024 * 1024)).toFixed(1);

        const newVideoItem = {
          id: `media-${Date.now()}`,
          category: 'medios',
          isVideo: true,
          videoUrl: videoUrl,
          filename: finalFilename,
          sizeMb: sizeMb,
          duration: Math.round(durationSec),
          durationFormatted: durationFormatted,
          title: title,
          author: `${author} (${durationFormatted} • ${sizeMb} MB)`,
          scope: scope,
          slides: [
            {
              text: title,
              subText: `Video HD (${durationFormatted}) • Listo para Proyectar y Transmitir`,
              badge: '🎬 VIDEO HD'
            }
          ]
        };

        loadPersistentDatabase();
        persistentDb.libraryItems.unshift(newVideoItem);
        persistentDb.layer3Videos.push({
          id: newVideoItem.id,
          title: title,
          scope: scope,
          videoUrl: videoUrl,
          duration: Math.round(durationSec),
          durationFormatted: durationFormatted,
          sizeMb: sizeMb
        });
        studioState.libraryItems = persistentDb.libraryItems;
        savePersistentDatabase();

        broadcastSSE('state', studioState);
        broadcastSSE('db_update', {
          libraryItems: persistentDb.libraryItems,
          layer3Videos: persistentDb.layer3Videos,
          updatedAt: persistentDb.updatedAt
        });

        console.log(`[OmniCast Video Upload] Saved ${finalFilename} (${sizeMb} MB) -> ${videoUrl}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          videoUrl,
          item: newVideoItem,
          libraryItems: persistentDb.libraryItems,
          layer3Videos: persistentDb.layer3Videos
        }));
      });

      writeStream.on('error', (err) => {
        console.error('[OmniCast Video Upload Error]:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Static File Serving (with HTTP 206 Range support for smooth MP4/WebM HTML5 Video playback)
  let reqPath = decodeURIComponent(parsedUrl);
  if (reqPath === '/' || reqPath === '') {
    reqPath = '/index.html';
  }

  const filePath = path.join(PUBLIC_DIR, reqPath);

  // Security: prevent path traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const range = req.headers.range;

    if (range && /\.(mp4|webm|mov|mkv|mp3|wav|ogg)$/i.test(ext)) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10) || 0;
      const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
      const chunksize = (end - start) + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stats.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType
      });
      const stream = fs.createReadStream(filePath, { start, end });
      stream.pipe(res);
      return;
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    const readStream = fs.createReadStream(filePath);
    readStream.pipe(res);
  });
};

// =========================================================================
// MASTER WEBSOCKET STREAMING ENGINE & FFMPEG LIFECYCLE (OBS-GRADE 30FPS PIPE)
// =========================================================================
let streamHasValidHeader = false;
let streamChunkCount = 0;
let pendingStreamChunks = [];
let activeTargetNames = [];
let ffmpegFramePumpTimer = null;
let standbyJpegBuffer = null;
let currentFrameJpeg = null;

function getStandbyJpegBuffer() {
  if (standbyJpegBuffer && standbyJpegBuffer.length > 100) return standbyJpegBuffer;
  try {
    const ffmpegPath = path.join(__dirname, 'bin', 'ffmpeg', 'ffmpeg.exe');
    if (fs.existsSync(ffmpegPath)) {
      const res = spawnSync(ffmpegPath, [
        '-f', 'lavfi',
        '-i', 'color=c=0x0d131f:s=960x540:r=1',
        '-frames:v', '1',
        '-f', 'image2',
        '-vcodec', 'mjpeg',
        '-q:v', '3',
        'pipe:1'
      ], { maxBuffer: 2 * 1024 * 1024 });
      if (res && res.stdout && res.stdout.length > 100 && res.stdout[0] === 0xFF && res.stdout[1] === 0xD8) {
        standbyJpegBuffer = res.stdout;
        if (!currentFrameJpeg) currentFrameJpeg = standbyJpegBuffer;
        return standbyJpegBuffer;
      }
    }
  } catch (e) {}
  return null;
}
getStandbyJpegBuffer();

function writeChunkToFfmpeg(rawData, source = 'WS') {
  const buf = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
  if (!buf || buf.length < 4) return;

  // Accept JPEG frames (0xFF 0xD8) into the live 30fps server frame buffer
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    currentFrameJpeg = buf;
    streamChunkCount++;
    liveStreamState.stats.totalBytes += buf.length;
    if (streamChunkCount <= 4 || streamChunkCount % 25 === 0) {
      console.log(`[Stream ${source}] Live Frame #${streamChunkCount} updated: ${buf.length} bytes (Total: ${Math.round(liveStreamState.stats.totalBytes / 1024)} KB)`);
    }
    return;
  }
}

function stopFfmpegStream(notifyClient = true) {
  if (ffmpegFramePumpTimer) {
    clearInterval(ffmpegFramePumpTimer);
    ffmpegFramePumpTimer = null;
  }
  liveStreamState.isStreaming = false;
  liveStreamState.startTime = null;
  streamHasValidHeader = false;
  streamChunkCount = 0;
  pendingStreamChunks = [];
  activeTargetNames = [];

  if (activeFfmpegProcess) {
    const proc = activeFfmpegProcess;
    activeFfmpegProcess = null;

    try {
      proc.stdin.end(); // Clean EOF -> triggers RTMP unpublish
    } catch (e) {}

    const killTimer = setTimeout(() => {
      try { proc.kill(); } catch (e) {}
    }, 3000);

    proc.once('close', () => {
      clearTimeout(killTimer);
    });
  }

  if (notifyClient) {
    if (activeStreamWebSocket && activeStreamWebSocket.readyState === WebSocket.OPEN) {
      try {
        activeStreamWebSocket.send(JSON.stringify({ type: 'stopped' }));
      } catch (e) {}
    }
    broadcastSSE('stream_status', { isStreaming: false, stopped: true });
  }
}

function resolveLatestFacebookKey(rawKey) {
  const trimmed = (rawKey || '').trim();
  // If key is empty or matches the expired session key from earlier today, check OBS profile for newer key
  if (!trimmed || trimmed === 'FB-10243398655477601-0-Ab7vOtOaRuRCvYfxN4R6KnuS') {
    try {
      const obsProfilePath = path.join(process.env.APPDATA || '', 'obs-studio', 'basic', 'profiles', 'OPEN', 'service.json');
      if (fs.existsSync(obsProfilePath)) {
        const obsSvc = JSON.parse(fs.readFileSync(obsProfilePath, 'utf8'));
        if (obsSvc && obsSvc.settings && obsSvc.settings.key && obsSvc.settings.key.trim().startsWith('FB-')) {
          return obsSvc.settings.key.trim();
        }
      }
    } catch (e) {}
  }
  return trimmed;
}

function startFfmpegStream(dest, activeWs) {
  dest = dest || {};
  const yt = dest.youtube || {};
  const fb = dest.facebook || {};

  // If FFmpeg is already actively running from a concurrent start call within the last 3 seconds, attach the WebSocket and reuse it
  if (activeFfmpegProcess && liveStreamState.isStreaming && liveStreamState.startTime && (Date.now() - liveStreamState.startTime < 3000)) {
    if (activeWs && activeWs.readyState === WebSocket.OPEN) {
      activeWs.send(JSON.stringify({
        type: 'ready',
        message: `Pipeline RTMP listo para ${activeTargetNames.join(' y ')}`,
        destinations: activeTargetNames
      }));
    }
    return { success: true, destinations: activeTargetNames };
  }

  const targets = [];
  const resolvedFbKey = resolveLatestFacebookKey(fb.key);
  if (fb.enabled && resolvedFbKey && resolvedFbKey !== 'FB-1049284729184712-live') {
    // Use OBS Studio's exact RTMPS endpoint for Facebook Live
    let rawUrl = (fb.url || 'rtmps://rtmp-api.facebook.com:443/rtmp/').trim();
    if (rawUrl.includes('live-api-s.facebook.com')) {
      rawUrl = 'rtmps://rtmp-api.facebook.com:443/rtmp/';
    }
    const targetUrl = rawUrl.endsWith('/') ? `${rawUrl}${resolvedFbKey}` : `${rawUrl}/${resolvedFbKey}`;
    targets.push({ name: 'Facebook Live', url: targetUrl });
  }

  if (yt.enabled && yt.key && yt.key.trim() && yt.key.trim() !== 'yt-live-9382-7712-4412-omni') {
    const rawUrl = (yt.url || 'rtmp://a.rtmp.youtube.com/live2').trim();
    const cleanKey = yt.key.trim();
    const targetUrl = rawUrl.endsWith('/') ? `${rawUrl}${cleanKey}` : `${rawUrl}/${cleanKey}`;
    targets.push({ name: 'YouTube Live', url: targetUrl });
  }

  if (targets.length === 0) {
    const err = 'No hay destinos de transmisión con clave válida configurada. Por favor ingresa tu clave en Destinos de Transmisión.';
    console.warn('[WebSocket Stream] Start rejected: No valid targets configured');
    if (activeWs && activeWs.readyState === WebSocket.OPEN) {
      activeWs.send(JSON.stringify({ type: 'error', message: err }));
    }
    return { error: err };
  }

  // Clean up any existing stream process without sending 'stopped' to new client
  stopFfmpegStream(false);

  const ffmpegPath = path.join(__dirname, 'bin', 'ffmpeg', 'ffmpeg.exe');
  if (!fs.existsSync(ffmpegPath)) {
    const err = `Binario FFmpeg no encontrado en ${ffmpegPath}`;
    if (activeWs && activeWs.readyState === WebSocket.OPEN) {
      activeWs.send(JSON.stringify({ type: 'error', message: err }));
    }
    return { error: err };
  }

  // Ensure initial standby JPEG frame exists so FFmpeg starts encoding at t=0.00s immediately
  if (!currentFrameJpeg) {
    getStandbyJpegBuffer();
  }

  // Match OBS Studio's H.264 Main Profile CBR + AAC stereo with lightweight 3-thread ultrafast CPU usage
  const ffmpegArgs = [
    '-thread_queue_size', '4096',
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-framerate', '30',
    '-i', 'pipe:0',
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-vf', 'scale=1280:720,format=yuv420p',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-threads', '3',
    '-profile:v', 'main',
    '-b:v', '3000k',
    '-minrate', '3000k',
    '-maxrate', '3000k',
    '-bufsize', '3000k',
    '-pix_fmt', 'yuv420p',
    '-r', '30',
    '-g', '60',
    '-keyint_min', '60',
    '-sc_threshold', '0',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-ar', '44100',
    '-ac', '2',
    '-shortest',
    '-max_muxing_queue_size', '9999',
    '-flvflags', 'no_duration_filesize'
  ];

  if (targets.length === 1) {
    ffmpegArgs.push('-f', 'flv', targets[0].url);
  } else {
    const teeTargets = targets.map(t => `[f=flv:onfail=ignore]${t.url}`).join('|');
    ffmpegArgs.push('-f', 'tee', teeTargets);
  }

  activeTargetNames = targets.map(t => t.name);
  console.log(`[FFmpeg RTMP] Spawning OBS-grade 30fps pipeline for: ${activeTargetNames.join(' & ')}`);
  const proc = spawn(ffmpegPath, ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
  activeFfmpegProcess = proc;
  streamHasValidHeader = true;
  streamChunkCount = 0;

  liveStreamState.isStreaming = true;
  liveStreamState.startTime = Date.now();
  liveStreamState.destinations = dest;
  liveStreamState.stats = { fps: 30, bitrate: 4500, speed: '1x', totalBytes: 0, droppedFrames: 0, error: null };

  // Immediately pump the initial frame and start the rock-solid 30.00 FPS server clock
  if (currentFrameJpeg && proc.stdin && proc.stdin.writable) {
    try { proc.stdin.write(currentFrameJpeg); } catch (e) {}
  }

  clearInterval(ffmpegFramePumpTimer);
  ffmpegFramePumpTimer = setInterval(() => {
    if (!activeFfmpegProcess || activeFfmpegProcess !== proc || !proc.stdin || !proc.stdin.writable) return;
    if (currentFrameJpeg) {
      try {
        proc.stdin.write(currentFrameJpeg);
      } catch (e) {}
    }
  }, 33);

  proc.stdin.on('error', (err) => {
    console.warn('[FFmpeg stdin error]:', err.message);
  });

  proc.stderr.on('data', (data) => {
    const text = data.toString();
    if (!text.includes('frame=')) {
      console.log('[FFmpeg]:', text.trim());
    } else {
      const lines = text.trim().split(/\r?\n/);
      const lastLine = lines[lines.length - 1];
      console.log('[FFmpeg Frame]:', lastLine);
    }
    const fpsMatch = text.match(/fps=\s*([\d\.]+)/);
    const brMatch = text.match(/bitrate=\s*([\d\.]+)kbits\/s/);
    const spMatch = text.match(/speed=\s*([\d\.]+x)/);
    const dropMatch = text.match(/drop=\s*([\d]+)/);

    if (fpsMatch) liveStreamState.stats.fps = parseFloat(fpsMatch[1]);
    if (brMatch) liveStreamState.stats.bitrate = parseFloat(brMatch[1]);
    if (spMatch) liveStreamState.stats.speed = spMatch[1];
    if (dropMatch) liveStreamState.stats.droppedFrames = parseInt(dropMatch[1], 10);

    if (fpsMatch || brMatch) {
      if (activeWs && activeWs.readyState === WebSocket.OPEN) {
        activeWs.send(JSON.stringify({ type: 'telemetry', stats: liveStreamState.stats }));
      }
      broadcastSSE('stream_telemetry', liveStreamState.stats);
    }

    if (/error in the pull function|connection refused|handshake failed|i\/o error|invalid session|session has been invalidated/i.test(text)) {
      console.warn('[FFmpeg RTMP Warning]:', text.trim());
      const errMsg = 'La plataforma rechazó la conexión RTMP (clave caducada o no válida). Verifica tu clave en Facebook Live Producer o activa "Clave de stream persistente".';
      liveStreamState.stats.error = errMsg;
      if (activeWs && activeWs.readyState === WebSocket.OPEN) {
        activeWs.send(JSON.stringify({ type: 'error', message: errMsg }));
      }
      broadcastSSE('stream_error', { error: errMsg });
    }
  });

  proc.on('close', (code) => {
    console.log(`[FFmpeg RTMP] Stream ended with exit code ${code}`);
    if (activeFfmpegProcess === proc) {
      if (ffmpegFramePumpTimer) {
        clearInterval(ffmpegFramePumpTimer);
        ffmpegFramePumpTimer = null;
      }
      activeFfmpegProcess = null;
      liveStreamState.isStreaming = false;
      streamHasValidHeader = false;
      if (activeWs && activeWs.readyState === WebSocket.OPEN) {
        activeWs.send(JSON.stringify({ type: 'stopped', code }));
      }
      broadcastSSE('stream_status', { isStreaming: false, code });
    }
  });

  proc.on('error', (err) => {
    console.error('[FFmpeg RTMP Process Error]:', err);
    if (activeFfmpegProcess === proc) {
      liveStreamState.stats.error = err.message;
      activeFfmpegProcess = null;
      liveStreamState.isStreaming = false;
      streamHasValidHeader = false;
      if (activeWs && activeWs.readyState === WebSocket.OPEN) {
        activeWs.send(JSON.stringify({ type: 'error', message: err.message }));
      }
      broadcastSSE('stream_status', { isStreaming: false, error: err.message });
    }
  });

  if (activeWs && activeWs.readyState === WebSocket.OPEN) {
    activeWs.send(JSON.stringify({
      type: 'ready',
      message: `Pipeline RTMP listo para ${activeTargetNames.join(' y ')}`,
      destinations: activeTargetNames
    }));
  }
  broadcastSSE('stream_status', { isStreaming: true, destinations: activeTargetNames });

  return { success: true, destinations: activeTargetNames };
}

const liveStreamWss = new WebSocket.Server({ noServer: true });

liveStreamWss.on('connection', (ws, request) => {
  console.log('[WebSocket Stream] Browser client connected');
  activeStreamWebSocket = ws;
  let startedForThisSocket = false;

  // Auto-start if config was passed in the WebSocket URL query string
  try {
    const host = (request && request.headers && request.headers.host) || 'localhost';
    const parsedUrl = new URL(request.url, `http://${host}`);
    const urlConfig = parsedUrl.searchParams.get('config');
    if (urlConfig) {
      const parsedConfig = JSON.parse(urlConfig);
      startedForThisSocket = true;
      startFfmpegStream(parsedConfig, ws);
    }
  } catch (urlErr) {
    console.warn('[WebSocket Stream] URL config parse warning:', urlErr.message);
  }

  ws.on('message', (message, isBinary) => {
    if (!isBinary) {
      try {
        const payload = JSON.parse(message.toString());
        if (payload.action === 'start') {
          if (!startedForThisSocket || !activeFfmpegProcess) {
            startedForThisSocket = true;
            startFfmpegStream(payload.config, ws);
          } else if (ws.readyState === WebSocket.OPEN) {
            // Always reply with ready so any client awaiting 'ready' after sending 'start' receives it
            ws.send(JSON.stringify({
              type: 'ready',
              message: `Pipeline RTMP listo para ${activeTargetNames.join(' y ')}`,
              destinations: activeTargetNames
            }));
          }
        } else if (payload.action === 'stop') {
          stopFfmpegStream();
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'stopped' }));
          }
        } else if (payload.action === 'log') {
          console.log(`[Client WS Log] ${payload.event}:`, JSON.stringify(payload.details || {}));
        }
      } catch (err) {
        console.warn('[WebSocket Stream] Parse message error:', err.message);
      }
    } else {
      writeChunkToFfmpeg(message, 'WS');
    }
  });

  ws.on('close', () => {
    console.log('[WebSocket Stream] Browser client disconnected');
    if (activeStreamWebSocket === ws) {
      activeStreamWebSocket = null;
      if (activeFfmpegProcess) {
        stopFfmpegStream(false);
      }
    }
  });

  ws.on('error', (err) => {
    console.warn('[WebSocket Stream] Socket error:', err.message);
  });
});

const handleUpgrade = (request, socket, head) => {
  try {
    const host = request.headers.host || 'localhost';
    const parsed = new URL(request.url, `http://${host}`);
    if (parsed.pathname === '/api/live-stream-ws') {
      liveStreamWss.handleUpgrade(request, socket, head, ws => {
        liveStreamWss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  } catch (err) {
    socket.destroy();
  }
};

// Start Standard HTTP Server (Port 3000)
const httpServer = http.createServer(requestHandler);
httpServer.on('upgrade', handleUpgrade);
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('\n========================================================');
  console.log('       📡 OMNICAST STUDIO - SERVIDOR LOCAL ACTIVO       ');
  console.log('========================================================');
  console.log(`\n  ► Local (esta máquina):   http://localhost:${PORT}`);
  
  const localIps = getLocalIpAddresses();
  if (localIps.length > 0) {
    console.log('  ► En tu Red Local (WiFi / Otras Laptops / iPads):');
    localIps.forEach(ip => {
      console.log(`     http://${ip}:${PORT}`);
    });
    console.log(`\n  ► Control Remoto Celular / iPad:`);
    console.log(`     http://${localIps[0]}:${PORT}/remote.html`);
    console.log(`\n  ► OmniCast Mobile Cam (Cámaras de Celular):`);
    console.log(`     http://${localIps[0]}:${PORT}/cam.html?id=1`);
  }
  console.log('\n========================================================\n');
});

// Start Secure HTTPS Server (Port 3443 for Mobile Cameras Secure Context)
const keyPath = path.join(__dirname, 'server.key');
const certPath = path.join(__dirname, 'server.crt');

if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  try {
    const sslOptions = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    };
    const httpsServer = https.createServer(sslOptions, requestHandler);
    httpsServer.on('upgrade', handleUpgrade);
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`  🔒 HTTPS Seguro Activo para Cámaras Móviles:`);
      const localIps = getLocalIpAddresses();
      if (localIps.length > 0) {
        console.log(`     https://${localIps[0]}:${HTTPS_PORT}/cam.html?id=1`);
      }
      console.log('========================================================\n');
    });
  } catch (e) {
    console.warn('Advertencia: No se pudo iniciar el servidor HTTPS:', e.message);
  }
}
