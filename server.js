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
const TV_HLS_DIR = path.join(PUBLIC_DIR, 'tv-hls');

// Ensure persistent database & video upload directories exist
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOADS_VIDEOS_DIR)) fs.mkdirSync(UPLOADS_VIDEOS_DIR, { recursive: true });
  if (!fs.existsSync(TV_HLS_DIR)) fs.mkdirSync(TV_HLS_DIR, { recursive: true });
} catch (dirErr) {
  console.warn('Warning creating data/uploads dirs:', dirErr.message);
}

process.on('uncaughtException', (err) => {
  console.error('[OmniCast Server UncaughtException]:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[OmniCast Server UnhandledRejection]:', reason);
});

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
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg'
};

// Persistent Database Helper (data/database.json)
let persistentDb = {
  libraryItems: [],
  layer3Videos: [],
  organizations: [],
  churches: [],
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
        if (Array.isArray(parsed.organizations)) persistentDb.organizations = parsed.organizations;
        if (Array.isArray(parsed.churches)) persistentDb.churches = parsed.churches;
        persistentDb.updatedAt = parsed.updatedAt || new Date().toISOString();
      }
    }
  } catch (e) {
    console.warn('[OmniCast DB] Error reading database.json:', e.message);
  }

  // Seed default Multi-Tenant organizations and churches if not present
  if (!persistentDb.organizations || persistentDb.organizations.length === 0) {
    persistentDb.organizations = [
      {
        id: 'org-alianza',
        name: 'Alianza Cristiana Nacional',
        slug: 'alianza',
        adminEmail: 'red@alianzacristiana.org',
        username: 'alianza',
        password: 'admin',
        headquarters: 'Ciudad de México',
        phone: '+52 55 1234 5678',
        plan: 'Enterprise Multi-Sede',
        createdAt: '2026-01-15'
      }
    ];
  }
  if (!persistentDb.churches || persistentDb.churches.length === 0) {
    persistentDb.churches = [
      {
        id: 'church-gdl',
        name: 'Campus Guadalajara Norte',
        type: 'branch', // 'branch' = pertenece a organización, 'independent' = iglesia sola
        orgId: 'org-alianza',
        orgName: 'Alianza Cristiana Nacional',
        city: 'Guadalajara, Jalisco',
        email: 'gdl@iglesianacional.org',
        username: 'gdl',
        password: 'gdl',
        operator: 'Carlos M.',
        role: 'Master de Sede Filial',
        status: 'active'
      },
      {
        id: 'church-mty',
        name: 'Campus Monterrey Sur',
        type: 'branch',
        orgId: 'org-alianza',
        orgName: 'Alianza Cristiana Nacional',
        city: 'Monterrey, Nuevo León',
        email: 'mty@iglesianacional.org',
        username: 'mty',
        password: 'mty',
        operator: 'Jorge T.',
        role: 'Master de Sede Filial',
        status: 'active'
      },
      {
        id: 'church-hebron',
        name: 'Comunidad Cristiana Hebrón',
        type: 'independent', // Iglesia sola / independiente
        orgId: null,
        orgName: null,
        city: 'Zapopan, Jalisco',
        email: 'hebron@iglesialocal.org',
        username: 'hebron',
        password: '123',
        operator: 'Pastor Roberto G.',
        role: 'Iglesia Local Independiente',
        status: 'active'
      }
    ];
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
  tvServiceLive: false,
  lastServiceRecap: null,
  libraryItems: persistentDb.libraryItems.length > 0 ? persistentDb.libraryItems : []
};

// Mobile Cameras & WebRTC State (OmniCast Mobile Cam)
let mobileCamsState = {
  1: { connected: false, name: 'Cámara 1 (Púlpito)', battery: null, fps: 30, res: '1080p', tally: 'IDLE', lastPing: 0 },
  2: { connected: false, name: 'Cámara 2 (Altar)', battery: null, fps: 30, res: '1080p', tally: 'IDLE', lastPing: 0 },
  3: { connected: false, name: 'Cámara 3 (Músicos)', battery: null, fps: 30, res: '1080p', tally: 'IDLE', lastPing: 0 },
  4: { connected: false, name: 'Cámara 4 (Móvil)', battery: null, fps: 30, res: '1080p', tally: 'IDLE', lastPing: 0 },
  5: { connected: false, name: 'Cámara 5 (Auxiliar)', battery: null, fps: 30, res: '1080p', tally: 'IDLE', lastPing: 0 }
};

const mobileCamLatestFrames = { 1: null, 2: null, 3: null, 4: null, 5: null };

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

let activeCloudflareTunnelUrl = '';
try {
  const initTunnelFile = path.join(__dirname, 'data', 'public_tunnel.json');
  if (fs.existsSync(initTunnelFile)) {
    const initTunnel = JSON.parse(fs.readFileSync(initTunnelFile, 'utf8'));
    if (initTunnel && initTunnel.active && initTunnel.url) {
      activeCloudflareTunnelUrl = initTunnel.url;
    }
  }
} catch (e) {}
let activeFfmpegProcess = null;
let activeStreamWebSocket = null;
let activeTvFfmpegProcess = null;
let tvFramePumpTimer = null;
let tvAudioPumpTimer = null;
let tvFmp4InitSegment = null;
let tvLatestFragment = null;
let tvFmp4Mime = 'video/mp4; codecs="avc1.42E01F, mp4a.40.2"';
let tvFragmentCount = 0;
const tvStreamClients = new Set();
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

// SSE Keepalive Heartbeat: prevents Cloudflare tunnels, NAT routers, and Chrome from dropping idle connections
setInterval(() => {
  for (const client of sseClients) {
    try {
      client.write(': keepalive\n\n');
    } catch (e) {
      sseClients.delete(client);
    }
  }
}, 10000);

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

  // API 1: Local Network Info & Cloudflare Public Tunnel Details
  if (parsedUrl === '/api/info') {
    const ips = getLocalIpAddresses();
    const primaryIp = ips[0] || 'localhost';
    if (!activeCloudflareTunnelUrl) {
      try {
        const tFile = path.join(__dirname, 'data', 'public_tunnel.json');
        if (fs.existsSync(tFile)) {
          const tData = JSON.parse(fs.readFileSync(tFile, 'utf8'));
          if (tData.active && tData.url) activeCloudflareTunnelUrl = tData.url;
        }
      } catch (e) {}
    }
    const publicUrl = activeCloudflareTunnelUrl || null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      primaryIp,
      port: PORT,
      httpsPort: HTTPS_PORT,
      allIps: ips,
      tunnelUrl: publicUrl,
      isTunnelActive: Boolean(publicUrl),
      remoteUrl: publicUrl ? `${publicUrl}/remote.html` : `http://${primaryIp}:${PORT}/remote.html`,
      localRemoteUrl: `http://${primaryIp}:${PORT}/remote.html`,
      stageUrl: publicUrl ? `${publicUrl}/stage.html` : `http://${primaryIp}:${PORT}/stage.html`,
      projectorUrl: `http://${primaryIp}:${PORT}/projector.html`,
      tvUrl: publicUrl ? `${publicUrl}/tv.html?room=Cuneros&mode=service` : `http://${primaryIp}:${PORT}/tv.html?room=Cuneros&mode=service`,
      localTvUrl: `http://${primaryIp}:${PORT}/tv.html?room=Cuneros&mode=service`,
      camUrls: {
        1: publicUrl ? `${publicUrl}/cam.html?id=1` : `http://${primaryIp}:${PORT}/cam.html?id=1`,
        2: publicUrl ? `${publicUrl}/cam.html?id=2` : `http://${primaryIp}:${PORT}/cam.html?id=2`,
        3: publicUrl ? `${publicUrl}/cam.html?id=3` : `http://${primaryIp}:${PORT}/cam.html?id=3`,
        4: publicUrl ? `${publicUrl}/cam.html?id=4` : `http://${primaryIp}:${PORT}/cam.html?id=4`
      },
      camHttpsUrls: {
        1: publicUrl ? `${publicUrl}/cam.html?id=1` : `https://${primaryIp}:${HTTPS_PORT}/cam.html?id=1`,
        2: publicUrl ? `${publicUrl}/cam.html?id=2` : `https://${primaryIp}:${HTTPS_PORT}/cam.html?id=2`,
        3: publicUrl ? `${publicUrl}/cam.html?id=3` : `https://${primaryIp}:${HTTPS_PORT}/cam.html?id=3`,
        4: publicUrl ? `${publicUrl}/cam.html?id=4` : `https://${primaryIp}:${HTTPS_PORT}/cam.html?id=4`
      }
    }));
    return;
  }

  // API 1.5: Cloudflare Tunnel Status & Registration
  if (parsedUrl === '/api/tunnel' && req.method === 'GET') {
    if (!activeCloudflareTunnelUrl) {
      try {
        const tFile = path.join(__dirname, 'data', 'public_tunnel.json');
        if (fs.existsSync(tFile)) {
          const tData = JSON.parse(fs.readFileSync(tFile, 'utf8'));
          if (tData.active && tData.url) activeCloudflareTunnelUrl = tData.url;
        }
      } catch (e) {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      active: Boolean(activeCloudflareTunnelUrl),
      url: activeCloudflareTunnelUrl || '',
      remoteUrl: activeCloudflareTunnelUrl ? `${activeCloudflareTunnelUrl}/remote.html` : '',
      stageUrl: activeCloudflareTunnelUrl ? `${activeCloudflareTunnelUrl}/stage.html` : '',
      tvUrl: activeCloudflareTunnelUrl ? `${activeCloudflareTunnelUrl}/tv.html?room=Cuneros&mode=service` : '',
      camUrl: activeCloudflareTunnelUrl ? `${activeCloudflareTunnelUrl}/cam.html?id=1` : ''
    }));
    return;
  }

  if (parsedUrl === '/api/tunnel/register' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        activeCloudflareTunnelUrl = payload.active ? (payload.url || '') : '';
        broadcastSSE('tunnel_update', { url: activeCloudflareTunnelUrl, active: Boolean(activeCloudflareTunnelUrl) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, active: Boolean(activeCloudflareTunnelUrl), url: activeCloudflareTunnelUrl }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
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
    while (sseClients.size >= 50) { const oldest = sseClients.values().next().value; if (!oldest) break; sseClients.delete(oldest); try { oldest.end(); } catch (e) {} }
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

  // API 4.5: Master Video Transport Control (Play, Pause, Restart, Seek, Loop, Mute across all screens)
  if (parsedUrl === '/api/video-control' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const cmd = JSON.parse(body);
        if (cmd) {
          if (studioState.currentSlidePayload) {
            studioState.currentSlidePayload.videoAction = cmd.action;
            if (typeof cmd.time === 'number') studioState.currentSlidePayload.currentTime = cmd.time;
            if (typeof cmd.loop === 'boolean') studioState.currentSlidePayload.videoLoop = cmd.loop;
            if (typeof cmd.muted === 'boolean') studioState.currentSlidePayload.videoMuted = cmd.muted;
            if (cmd.videoUrl) studioState.currentSlidePayload.videoUrl = cmd.videoUrl;
          }
          broadcastSSE('video_control', cmd);
          broadcastSSE('state', studioState);
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
        } else if (action === 'set_tv_service_live') {
          const nextActive = Boolean(data.active);
          if (nextActive) {
            startTvFfmpegBroadcast();
          } else {
            stopTvFfmpegBroadcast();
          }
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

        // De-mDNS any .local candidates so mobile devices can connect on local WiFi
        const primaryIp = getLocalIpAddresses()[0] || '127.0.0.1';
        const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').replace(/^.*:/, '');
        const targetIp = (sig.from === 'phone') ? (clientIp || primaryIp) : primaryIp;

        if (sig.candidate && typeof sig.candidate.candidate === 'string') {
          sig.candidate.candidate = sig.candidate.candidate.replace(/[a-f0-9-]+\.local/gi, targetIp);
        }
        if (sig.sdp && typeof sig.sdp.sdp === 'string') {
          sig.sdp.sdp = sig.sdp.sdp.replace(/[a-f0-9-]+\.local/gi, targetIp);
        }

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

  // Endpoint: Direct HTTPS POST Frame Ingest (zero-fail video stream from phone)
  if (parsedUrl === '/api/cam/frame' && req.method === 'POST') {
    const fullUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const camId = parseInt(fullUrl.searchParams.get('cam') || '1', 10);
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      if (buffer.length > 0) {
        mobileCamLatestFrames[camId] = buffer;
        if (mobileCamsState[camId]) {
          mobileCamsState[camId].connected = true;
          mobileCamsState[camId].lastPing = Date.now();
        }
        const recs = mobileCamReceivers[camId];
        if (recs && recs.size > 0) {
          for (const r of recs) {
            if (r.readyState === WebSocket.OPEN) {
              r.send(buffer, { binary: true });
            }
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }

  // Endpoint: Fetch Latest Frame (polling fallback for studio canvas)
  if (parsedUrl === '/api/cam/frame' && req.method === 'GET') {
    const fullUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const camId = parseInt(fullUrl.searchParams.get('cam') || '1', 10);
    const buf = mobileCamLatestFrames[camId];
    if (buf && buf.length > 0) {
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Content-Length': buf.length
      });
      res.end(buf);
    } else {
      res.writeHead(204);
      res.end();
    }
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

  // Endpoint: Request Phone to Renegotiate/Re-send Offer
  if (parsedUrl === '/api/cam/renegotiate' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const targetCams = (payload.camId === 'all' || !payload.camId) ? [1, 2, 3, 4] : [parseInt(payload.camId, 10)];
        targetCams.forEach(id => {
          if (!camSignalsForPhones[id]) camSignalsForPhones[id] = [];
          camSignalsForPhones[id].push({ type: 'renegotiate', camId: id });
        });
        broadcastSSE('cam_renegotiate', payload);
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
  // Endpoint: Local Smart TV Service Broadcast Status
  if (parsedUrl === '/api/tv/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      active: Boolean(studioState.tvServiceLive && activeTvFfmpegProcess),
      tvMode: studioState.tvMode,
      clients: tvStreamClients.size,
      hasInit: Boolean(tvFmp4InitSegment),
      mime: tvFmp4Mime,
      fragments: tvFragmentCount,
      hlsUrl: '/tv-hls/live.m3u8'
    }));
    return;
  }

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

  // Endpoint: Fetch Current Stream Frame being sent to FFmpeg (Instant Live Inspection)
  if (parsedUrl === '/api/stream/frame' && req.method === 'GET') {
    if (currentFrameJpeg && currentFrameJpeg.length > 100) {
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Content-Length': currentFrameJpeg.length
      });
      res.end(currentFrameJpeg);
    } else {
      res.writeHead(204);
      res.end();
    }
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
        if (!dest.localTest && yt.enabled && yt.key && yt.key.trim() && yt.key.trim() !== 'yt-live-9382-7712-4412-omni') {
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
      organizations: persistentDb.organizations || [],
      churches: persistentDb.churches || [],
      diskVideos,
      updatedAt: persistentDb.updatedAt
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(payload);
    return;
  }

  // Endpoint: Save / Sync Persistent Database (Songs, Lyrics, Videos, Organizations, Churches)
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
        if (Array.isArray(data.organizations)) {
          persistentDb.organizations = data.organizations;
        }
        if (Array.isArray(data.churches)) {
          persistentDb.churches = data.churches;
        }
        savePersistentDatabase();
        broadcastSSE('state', studioState);
        broadcastSSE('db_update', {
          libraryItems: persistentDb.libraryItems,
          layer3Videos: persistentDb.layer3Videos,
          organizations: persistentDb.organizations,
          churches: persistentDb.churches,
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
      const targetOrgId = fullUrl.searchParams.get('targetOrgId') || null;
      const expiresAt = fullUrl.searchParams.get('expiresAt') || null;
      const priority = fullUrl.searchParams.get('priority') || 'alta';
      const campaignType = fullUrl.searchParams.get('campaignType') || 'campaña';

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
          targetOrgId: targetOrgId,
          expiresAt: expiresAt,
          priority: priority,
          campaignType: campaignType,
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
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
        'Access-Control-Allow-Headers': 'Content-Type, Range',
        'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
        'Cache-Control': 'no-store'
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = fs.createReadStream(filePath, { start, end });
      stream.pipe(res);
      return;
    }

    const isMedia = /\.(mp4|webm|mov|mkv|mp3|wav|ogg)$/i.test(ext);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
      'Access-Control-Allow-Headers': 'Content-Type, Range',
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
      'Cache-Control': 'no-store'
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
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
let ffmpegAudioPumpTimer = null;
let pcmAudioQueue = [];
let pcmQueueBytes = 0;
let tvPcmAudioQueue = [];
let tvPcmQueueBytes = 0;
let liveAudioMutedFlag = false;
let pcmPacketCount = 0;
const PCM_SAMPLE_RATE = 44100;
const PCM_BYTES_PER_SAMPLE = 4; // 16-bit stereo (2 bytes * 2 channels)
const PCM_BYTES_PER_SEC = PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE;
const MAX_PCM_QUEUE_BYTES = Math.floor(PCM_BYTES_PER_SEC * 0.25); // Cap latency at ~250ms
const SILENCE_3528 = Buffer.alloc(3528, 0);

function pushFifoPcm(queue, currentBytes, pcmBuf) {
  queue.push(pcmBuf);
  let total = currentBytes + pcmBuf.length;
  while (total > MAX_PCM_QUEUE_BYTES && queue.length > 1) {
    const dropped = queue.shift();
    total -= dropped.length;
  }
  return total;
}

function shiftFifoPcm(queue, currentBytes, bytesNeeded) {
  if (bytesNeeded <= 0) return { chunk: Buffer.alloc(0), remaining: currentBytes };
  if (liveAudioMutedFlag || currentBytes === 0) {
    return {
      chunk: bytesNeeded === 3528 ? SILENCE_3528 : Buffer.alloc(bytesNeeded, 0),
      remaining: currentBytes
    };
  }
  const out = Buffer.alloc(bytesNeeded, 0);
  let offset = 0;
  let remaining = currentBytes;
  while (offset < bytesNeeded && queue.length > 0) {
    const head = queue[0];
    const take = Math.min(bytesNeeded - offset, head.length);
    head.copy(out, offset, 0, take);
    offset += take;
    remaining -= take;
    if (take < head.length) {
      queue[0] = head.subarray(take);
    } else {
      queue.shift();
    }
  }
  return { chunk: out, remaining };
}

function enqueuePcmAudioChunk(pcmBuf) {
  if (!pcmBuf || pcmBuf.length === 0 || liveAudioMutedFlag) return;
  if (!activeFfmpegProcess && !activeTvFfmpegProcess) return;
  pcmPacketCount++;
  if (liveStreamState && liveStreamState.stats) {
    liveStreamState.stats.pcmPackets = pcmPacketCount;
  }
  if (activeFfmpegProcess) {
    pcmQueueBytes = pushFifoPcm(pcmAudioQueue, pcmQueueBytes, pcmBuf);
  }
  if (activeTvFfmpegProcess) {
    tvPcmQueueBytes = pushFifoPcm(tvPcmAudioQueue, tvPcmQueueBytes, pcmBuf);
  }
}

function dequeuePcmBytes(bytesNeeded) {
  const res = shiftFifoPcm(pcmAudioQueue, pcmQueueBytes, bytesNeeded);
  pcmQueueBytes = res.remaining;
  return res.chunk;
}

function dequeueTvPcmBytes(bytesNeeded) {
  const res = shiftFifoPcm(tvPcmAudioQueue, tvPcmQueueBytes, bytesNeeded);
  tvPcmQueueBytes = res.remaining;
  return res.chunk;
}
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

let cachedDirectShowAudioDevice = null;

// STREAM HEALTH MONITOR (como el panel de estadísticas de OBS): cuántos cuadros REALES llegan del navegador.
// Si llegan < 20 fps, el servidor está repitiendo el último cuadro (imagen congelada en Facebook).
let lastHealthChunkCount = 0;
setInterval(() => {
  if (!activeFfmpegProcess) { lastHealthChunkCount = streamChunkCount; return; }
  const fps = (streamChunkCount - lastHealthChunkCount) / 5;
  lastHealthChunkCount = streamChunkCount;
  liveStreamState.stats.browserFps = fps;
  console.log(`[Stream Health] Cuadros reales del navegador: ${fps.toFixed(1)} fps${fps < 20 ? '  <-- CONGELAMIENTO: el navegador no está enviando cuadros' : ''}`);
  if (activeStreamWebSocket && activeStreamWebSocket.readyState === WebSocket.OPEN) {
    try { activeStreamWebSocket.send(JSON.stringify({ type: 'health', browserFps: fps })); } catch (e) {}
  }
}, 5000);
function detectDirectShowAudioDevice() {
  if (cachedDirectShowAudioDevice !== null) return cachedDirectShowAudioDevice;
  try {
    const ffmpegPath = path.join(__dirname, 'bin', 'ffmpeg', 'ffmpeg.exe');
    if (fs.existsSync(ffmpegPath)) {
      const res = spawnSync(ffmpegPath, ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { encoding: 'utf8' });
      const output = (res.stderr || '') + (res.stdout || '');
      const audioSection = output.split('DirectShow audio devices')[1] || '';
      const matches = [...audioSection.matchAll(/\"([^\"]+)\"/g)].map(m => m[1]);
      // Prefer real physical microphones (Realtek, USB, etc.), avoid virtual loopbacks
      const best = matches.find(m => /realtek|mic|microf|usb|audio/i.test(m)) || matches[0];
      if (best) {
        cachedDirectShowAudioDevice = best;
        console.log(`[FFmpeg Audio] DirectShow physical microphone detected: "${best}"`);
        return best;
      }
    }
  } catch (e) {
    console.warn('[FFmpeg Audio] Device detection warning:', e.message);
  }
  cachedDirectShowAudioDevice = '';
  return '';
}

function stopFfmpegStream(notifyClient = true) {
  if (ffmpegFramePumpTimer) {
    clearInterval(ffmpegFramePumpTimer);
    ffmpegFramePumpTimer = null;
  }
  if (ffmpegAudioPumpTimer) {
    clearInterval(ffmpegAudioPumpTimer);
    ffmpegAudioPumpTimer = null;
  }
  liveStreamState.isStreaming = false;
  liveStreamState.startTime = null;
  streamHasValidHeader = false;
  streamChunkCount = 0;
  pendingStreamChunks = [];
  pcmAudioQueue = [];
  pcmQueueBytes = 0;
  pcmPacketCount = 0;
  activeTargetNames = [];

  if (activeFfmpegProcess) {
    const proc = activeFfmpegProcess;
    activeFfmpegProcess = null;

    try {
      if (proc.stdin && proc.stdin.writable) {
        proc.stdin.end(); // Clean EOF -> triggers RTMP unpublish
      }
      if (proc.stdio && proc.stdio[3] && proc.stdio[3].writable) {
        proc.stdio[3].end();
      }
    } catch (e) {}

    const killTimer = setTimeout(() => {
      try { proc.kill(); } catch (e) {}
    }, 2500);

    proc.once('close', (code) => {
      clearTimeout(killTimer);
      console.log(`[FFmpeg RTMP] Stream finished cleanly with code ${code}`);
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

  // PRUEBA LOCAL (como la grabación de prueba de Wirecast/OBS): misma tubería exacta, pero escribe a un archivo
  // en vez de Facebook/YouTube, para verificar que el video de salida realmente se mueve.
  if (dest.localTest) {
    const recDir = path.join(__dirname, 'recordings');
    if (!fs.existsSync(recDir)) fs.mkdirSync(recDir, { recursive: true });
    const outFile = path.join(recDir, `prueba_local_${Date.now()}.flv`);
    targets.push({ name: 'Prueba Local', url: outFile });
    liveStreamState.lastLocalTestFile = outFile;
    console.log(`[FFmpeg RTMP] PRUEBA LOCAL -> ${outFile}`);
  }

  const resolvedFbKey = dest.localTest ? null : resolveLatestFacebookKey(fb.key);
  if (fb.enabled && resolvedFbKey && resolvedFbKey !== 'FB-1049284729184712-live') {
    // Use OBS Studio's exact RTMPS endpoint for Facebook Live
    let rawUrl = (fb.url || 'rtmps://rtmp-api.facebook.com:443/rtmp/').trim();
    if (rawUrl.includes('live-api-s.facebook.com')) {
      rawUrl = 'rtmps://rtmp-api.facebook.com:443/rtmp/';
    }
    const targetUrl = rawUrl.endsWith('/') ? `${rawUrl}${resolvedFbKey}` : `${rawUrl}/${resolvedFbKey}`;
    targets.push({ name: 'Facebook Live', url: targetUrl });
  }

  if (!dest.localTest && yt.enabled && yt.key && yt.key.trim() && yt.key.trim() !== 'yt-live-9382-7712-4412-omni') {
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

  // Pipeline unificado OBS-grade: Video JPEG en pipe:0 + Mezcla Real WebAudio PCM 44.1kHz Estéreo en pipe:3
  liveAudioMutedFlag = Boolean(dest && dest.audioMuted);
  pcmAudioQueue = [];
  pcmQueueBytes = 0;
  pcmPacketCount = 0;
  console.log(`[FFmpeg Audio] Ingesting live Fairlight WebAudio mix via pipe:3 (initial mute: ${liveAudioMutedFlag})`);

  const ffmpegArgs = [
    '-thread_queue_size', '4096',
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-framerate', '30',
    '-i', 'pipe:0',
    '-thread_queue_size', '4096',
    '-f', 's16le',
    '-ar', String(PCM_SAMPLE_RATE),
    '-ac', '2',
    '-i', 'pipe:3'
  ];

  ffmpegArgs.push(
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-vf', 'scale=1280:720,format=yuv420p,setpts=N/(30*TB)',
    '-af', 'aresample=async=1000:min_hard_comp=0.100000:first_pts=0',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-threads', '3',
    '-profile:v', 'main',
    '-b:v', '3500k',
    '-minrate', '3500k',
    '-maxrate', '3500k',
    '-bufsize', '3500k',
    '-x264-params', 'nal-hrd=cbr:force-cfr=1',
    '-pix_fmt', 'yuv420p',
    '-r', '30',
    '-g', '60',
    '-keyint_min', '60',
    '-sc_threshold', '0',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-ar', '44100',
    '-ac', '2',
    '-max_muxing_queue_size', '9999',
    '-flvflags', 'no_duration_filesize'
  );

  if (targets.length === 1) {
    ffmpegArgs.push('-f', 'flv', targets[0].url);
  } else {
    const teeTargets = targets.map(t => `[f=flv:onfail=ignore]${t.url}`).join('|');
    ffmpegArgs.push('-f', 'tee', teeTargets);
  }

  activeTargetNames = targets.map(t => t.name);
  console.log(`[FFmpeg RTMP] Spawning OBS-grade 30fps pipeline for: ${activeTargetNames.join(' & ')}`);
  const proc = spawn(ffmpegPath, ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  activeFfmpegProcess = proc;
  streamHasValidHeader = true;
  streamChunkCount = 0;

  liveStreamState.isStreaming = true;
  liveStreamState.startTime = Date.now();
  liveStreamState.destinations = dest;
  liveStreamState.stats = { fps: 30, bitrate: 3500, speed: '1x', totalBytes: 0, droppedFrames: 0, pcmPackets: 0, error: null };

  // Immediately pump the initial frame and start the rock-solid 30.00 FPS + 44.1kHz PCM server clocks
  if (currentFrameJpeg && proc.stdin && proc.stdin.writable && !proc.stdin.destroyed) {
    try { proc.stdin.write(currentFrameJpeg); } catch (e) {}
  }

  clearInterval(ffmpegFramePumpTimer);
  ffmpegFramePumpTimer = setInterval(() => {
    if (!activeFfmpegProcess || activeFfmpegProcess !== proc || !proc.stdin || !proc.stdin.writable || proc.stdin.destroyed) return;
    if (currentFrameJpeg) {
      try {
        proc.stdin.write(currentFrameJpeg);
      } catch (e) {}
    }
  }, 33);

  clearInterval(ffmpegAudioPumpTimer);
  const audioClockStart = Date.now();
  let audioBytesWritten = 0;
  // Pre-seed 40ms of silence on pipe:3 so FFmpeg probes audio stream header at t=0.00s immediately
  const audioPipeInit = proc.stdio && proc.stdio[3];
  if (audioPipeInit && audioPipeInit.writable && !audioPipeInit.destroyed) {
    try {
      const seed = Buffer.alloc(Math.floor(PCM_SAMPLE_RATE * 0.04) * PCM_BYTES_PER_SAMPLE, 0);
      audioPipeInit.write(seed);
      audioBytesWritten += seed.length;
    } catch (e) {}
  }
  ffmpegAudioPumpTimer = setInterval(() => {
    if (!activeFfmpegProcess || activeFfmpegProcess !== proc) return;
    const audioPipe = proc.stdio && proc.stdio[3];
    if (!audioPipe || !audioPipe.writable || audioPipe.destroyed) return;
    const targetBytes = Math.floor(((Date.now() - audioClockStart) / 1000) * PCM_SAMPLE_RATE) * PCM_BYTES_PER_SAMPLE + Math.floor(PCM_SAMPLE_RATE * 0.04) * PCM_BYTES_PER_SAMPLE;
    let due = targetBytes - audioBytesWritten;
    due = due - (due % PCM_BYTES_PER_SAMPLE);
    if (due <= 0) return;
    const maxStep = Math.floor(PCM_BYTES_PER_SEC * 0.2);
    if (due > maxStep) due = maxStep - (maxStep % PCM_BYTES_PER_SAMPLE);
    const chunk = dequeuePcmBytes(due);
    try {
      audioPipe.write(chunk);
      audioBytesWritten += chunk.length;
    } catch (e) {}
  }, 20);

  proc.stdin.on('error', (err) => {
    console.warn('[FFmpeg stdin error]:', err.message);
  });
  if (proc.stdio && proc.stdio[3]) {
    proc.stdio[3].on('error', (err) => {
      console.warn('[FFmpeg audio pipe error]:', err.message);
    });
  }

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
      if (ffmpegAudioPumpTimer) {
        clearInterval(ffmpegAudioPumpTimer);
        ffmpegAudioPumpTimer = null;
      }
      pcmAudioQueue = [];
      pcmQueueBytes = 0;
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

// =========================================================================
// OMNICAST LOCAL TV BROADCAST: SINGLE-ENCODE fMP4 (MSE) + HLS FOR SALAS/TVs
// =========================================================================
function extractAvcCodecFromMoov(moovBuf) {
  try {
    const idx = moovBuf.indexOf(Buffer.from('avcC'));
    if (idx !== -1 && idx + 8 < moovBuf.length) {
      // ISO BMFF avcC payload starts immediately after 4-byte 'avcC' tag:
      // [version=1, AVCProfileIndication, profile_compatibility, AVCLevelIndication]
      const prof = moovBuf[idx + 5].toString(16).padStart(2, '0');
      const comp = moovBuf[idx + 6].toString(16).padStart(2, '0');
      const lvl = moovBuf[idx + 7].toString(16).padStart(2, '0');
      return `video/mp4; codecs="avc1.${prof}${comp}${lvl}, mp4a.40.2"`;
    }
  } catch (e) {}
  return 'video/mp4; codecs="avc1.42E01F, mp4a.40.2"';
}

function broadcastTvControl(payloadObj) {
  const msg = JSON.stringify(payloadObj);
  for (const client of tvStreamClients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(msg); } catch (e) {}
    }
  }
}

function broadcastTvBinary(buf) {
  for (const client of tvStreamClients) {
    if (client.readyState === WebSocket.OPEN && client.bufferedAmount <= 1024 * 1024) {
      try { client.send(buf, { binary: true }); } catch (e) {}
    }
  }
}

function stopTvFfmpegBroadcast() {
  if (tvFramePumpTimer) {
    clearInterval(tvFramePumpTimer);
    tvFramePumpTimer = null;
  }
  if (tvAudioPumpTimer) {
    clearInterval(tvAudioPumpTimer);
    tvAudioPumpTimer = null;
  }
  studioState.tvServiceLive = false;
  tvPcmAudioQueue = [];
  tvPcmQueueBytes = 0;
  tvFmp4InitSegment = null;
  tvLatestFragment = null;
  tvFragmentCount = 0;

  if (activeTvFfmpegProcess) {
    const proc = activeTvFfmpegProcess;
    activeTvFfmpegProcess = null;
    try {
      if (proc.stdin && proc.stdin.writable) proc.stdin.end();
      if (proc.stdio && proc.stdio[3] && proc.stdio[3].writable) proc.stdio[3].end();
    } catch (e) {}
    const killTimer = setTimeout(() => {
      try { proc.kill(); } catch (e) {}
    }, 2000);
    proc.once('close', () => clearTimeout(killTimer));
  }

  broadcastTvControl({ type: 'tv_status', active: false });
  broadcastSSE('tv_service_live', { active: false });
  broadcastSSE('state', studioState);
}

function startTvFfmpegBroadcast() {
  if (activeTvFfmpegProcess && studioState.tvServiceLive) {
    return { success: true, alreadyRunning: true };
  }

  const ffmpegPath = path.join(__dirname, 'bin', 'ffmpeg', 'ffmpeg.exe');
  if (!fs.existsSync(ffmpegPath)) {
    return { error: `Binario FFmpeg no encontrado en ${ffmpegPath}` };
  }

  stopTvFfmpegBroadcast();
  if (!currentFrameJpeg) {
    getStandbyJpegBuffer();
  }

  try {
    if (!fs.existsSync(TV_HLS_DIR)) fs.mkdirSync(TV_HLS_DIR, { recursive: true });
    for (const f of fs.readdirSync(TV_HLS_DIR)) {
      if (/\.(m3u8|ts|m4s)$/i.test(f)) {
        try { fs.unlinkSync(path.join(TV_HLS_DIR, f)); } catch (e) {}
      }
    }
  } catch (e) {}

  const hlsManifest = path.join(TV_HLS_DIR, 'live.m3u8').replace(/\\/g, '/');
  const teeTarget = `[f=mp4:movflags=frag_keyframe+empty_moov+default_base_moof:onfail=ignore]pipe:1|[f=hls:hls_time=1:hls_list_size=5:hls_flags=delete_segments:onfail=ignore]${hlsManifest}`;

  const tvArgs = [
    '-thread_queue_size', '2048',
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-framerate', '30',
    '-i', 'pipe:0',
    '-thread_queue_size', '2048',
    '-f', 's16le',
    '-ar', String(PCM_SAMPLE_RATE),
    '-ac', '2',
    '-i', 'pipe:3',
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-vf', 'scale=960:540,format=yuv420p,setpts=N/(30*TB)',
    '-af', 'aresample=async=1000:min_hard_comp=0.100000:first_pts=0',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-threads', '2',
    '-profile:v', 'baseline',
    '-level', '3.1',
    '-b:v', '1800k',
    '-maxrate', '2000k',
    '-bufsize', '2000k',
    '-pix_fmt', 'yuv420p',
    '-r', '30',
    '-g', '30',
    '-keyint_min', '30',
    '-sc_threshold', '0',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
    '-flags', '+global_header',
    '-max_muxing_queue_size', '9999',
    '-f', 'tee',
    teeTarget
  ];

  console.log('[TV Broadcast LAN] Spawning local Salas/TVs encoder (fMP4 MSE + HLS)...');
  const proc = spawn(ffmpegPath, tvArgs, { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  activeTvFfmpegProcess = proc;
  studioState.tvServiceLive = true;
  tvPcmAudioQueue = [];
  tvPcmQueueBytes = 0;
  tvFmp4InitSegment = null;
  tvLatestFragment = null;
  tvFragmentCount = 0;

  let boxAcc = Buffer.alloc(0);
  let ftypBox = null;
  let pendingMoof = null;

  proc.stdout.on('data', (chunk) => {
    if (activeTvFfmpegProcess !== proc) return;
    boxAcc = boxAcc.length ? Buffer.concat([boxAcc, chunk]) : chunk;

    while (boxAcc.length >= 8) {
      const boxSize = boxAcc.readUInt32BE(0);
      if (boxSize < 8) {
        boxAcc = Buffer.alloc(0);
        break;
      }
      if (boxAcc.length < boxSize) break;

      const boxType = boxAcc.subarray(4, 8).toString('ascii');
      const boxBuf = Buffer.from(boxAcc.subarray(0, boxSize));
      boxAcc = boxAcc.subarray(boxSize);

      if (boxType === 'ftyp') {
        ftypBox = boxBuf;
      } else if (boxType === 'moov') {
        tvFmp4Mime = extractAvcCodecFromMoov(boxBuf);
        tvFmp4InitSegment = ftypBox ? Buffer.concat([ftypBox, boxBuf]) : boxBuf;
        ftypBox = null;
        console.log(`[TV Broadcast LAN] Init segment ready (${tvFmp4InitSegment.length} bytes, ${tvFmp4Mime})`);
        broadcastTvControl({ type: 'tv_init', mime: tvFmp4Mime });
        broadcastTvBinary(tvFmp4InitSegment);
      } else if (boxType === 'moof') {
        pendingMoof = boxBuf;
      } else if (boxType === 'mdat' && pendingMoof) {
        const frag = Buffer.concat([pendingMoof, boxBuf]);
        pendingMoof = null;
        tvLatestFragment = frag;
        tvFragmentCount++;
        broadcastTvBinary(frag);
      }
    }
  });

  if (currentFrameJpeg && proc.stdin && proc.stdin.writable && !proc.stdin.destroyed) {
    try { proc.stdin.write(currentFrameJpeg); } catch (e) {}
  }

  tvFramePumpTimer = setInterval(() => {
    if (!activeTvFfmpegProcess || activeTvFfmpegProcess !== proc || !proc.stdin || !proc.stdin.writable || proc.stdin.destroyed) return;
    if (currentFrameJpeg) {
      try { proc.stdin.write(currentFrameJpeg); } catch (e) {}
    }
  }, 33);

  const tvClockStart = Date.now();
  let tvAudioWritten = 0;
  const tvAudioPipeInit = proc.stdio && proc.stdio[3];
  if (tvAudioPipeInit && tvAudioPipeInit.writable && !tvAudioPipeInit.destroyed) {
    try {
      const seed = Buffer.alloc(Math.floor(PCM_SAMPLE_RATE * 0.04) * PCM_BYTES_PER_SAMPLE, 0);
      tvAudioPipeInit.write(seed);
      tvAudioWritten += seed.length;
    } catch (e) {}
  }
  tvAudioPumpTimer = setInterval(() => {
    if (!activeTvFfmpegProcess || activeTvFfmpegProcess !== proc) return;
    const audioPipe = proc.stdio && proc.stdio[3];
    if (!audioPipe || !audioPipe.writable || audioPipe.destroyed) return;
    const targetBytes = Math.floor(((Date.now() - tvClockStart) / 1000) * PCM_SAMPLE_RATE) * PCM_BYTES_PER_SAMPLE + Math.floor(PCM_SAMPLE_RATE * 0.04) * PCM_BYTES_PER_SAMPLE;
    let due = targetBytes - tvAudioWritten;
    due = due - (due % PCM_BYTES_PER_SAMPLE);
    if (due <= 0) return;
    const maxStep = Math.floor(PCM_BYTES_PER_SEC * 0.2);
    if (due > maxStep) due = maxStep - (maxStep % PCM_BYTES_PER_SAMPLE);
    const out = dequeueTvPcmBytes(due);
    try {
      audioPipe.write(out);
      tvAudioWritten += out.length;
    } catch (e) {}
  }, 20);

  proc.stdin.on('error', () => {});
  if (proc.stdio && proc.stdio[3]) proc.stdio[3].on('error', () => {});
  proc.stderr.on('data', (d) => {
    const txt = d.toString();
    if (/error|invalid/i.test(txt) && !txt.includes('frame=')) {
      console.warn('[TV Broadcast FFmpeg]:', txt.trim());
    }
  });
  proc.on('close', (code) => {
    console.log(`[TV Broadcast LAN] Ended with exit code ${code}`);
    if (activeTvFfmpegProcess === proc) {
      if (tvFramePumpTimer) { clearInterval(tvFramePumpTimer); tvFramePumpTimer = null; }
      if (tvAudioPumpTimer) { clearInterval(tvAudioPumpTimer); tvAudioPumpTimer = null; }
      activeTvFfmpegProcess = null;
      studioState.tvServiceLive = false;
      tvFmp4InitSegment = null;
      tvLatestFragment = null;
      broadcastTvControl({ type: 'tv_status', active: false });
      broadcastSSE('tv_service_live', { active: false });
      broadcastSSE('state', studioState);
    }
  });

  broadcastTvControl({ type: 'tv_status', active: true });
  broadcastSSE('tv_service_live', { active: true });
  broadcastSSE('state', studioState);
  return { success: true };
}

const tvStreamWss = new WebSocket.Server({ noServer: true });
tvStreamWss.on('connection', (ws) => {
  tvStreamClients.add(ws);
  if (studioState.tvServiceLive && tvFmp4InitSegment) {
    try {
      ws.send(JSON.stringify({ type: 'tv_status', active: true }));
      ws.send(JSON.stringify({ type: 'tv_init', mime: tvFmp4Mime }));
      ws.send(tvFmp4InitSegment, { binary: true });
      if (tvLatestFragment) {
        ws.send(tvLatestFragment, { binary: true });
      }
    } catch (e) {}
  } else {
    try {
      ws.send(JSON.stringify({ type: 'tv_status', active: Boolean(studioState.tvServiceLive) }));
    } catch (e) {}
  }
  ws.on('close', () => tvStreamClients.delete(ws));
  ws.on('error', () => tvStreamClients.delete(ws));
});

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
    let buf = null;
    if (Buffer.isBuffer(message)) {
      buf = message;
    } else if (message instanceof ArrayBuffer) {
      buf = Buffer.from(message);
    } else if (ArrayBuffer.isView(message)) {
      buf = Buffer.from(message.buffer, message.byteOffset, message.byteLength);
    }

    // Direct PCM Audio chunk detection: 'PCM0' magic bytes (0x50 0x43 0x4D 0x30)
    if (buf && buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x43 && buf[2] === 0x4D && buf[3] === 0x30) {
      enqueuePcmAudioChunk(buf.subarray(4));
      return;
    }

    // Direct JPEG frame detection: 0xFF 0xD8 magic bytes
    if (buf && buf.length >= 4 && buf[0] === 0xFF && buf[1] === 0xD8) {
      writeChunkToFfmpeg(buf, 'WS');
      return;
    }

    if (isBinary && buf) {
      writeChunkToFfmpeg(buf, 'WS');
      return;
    }

    if (!isBinary && message) {
      const msgStr = typeof message === 'string' ? message : message.toString();
      if (msgStr.startsWith('data:image/')) {
        const comma = msgStr.indexOf(',');
        const b64Buf = Buffer.from(msgStr.substring(comma + 1), 'base64');
        writeChunkToFfmpeg(b64Buf, 'WS-B64');
        return;
      }
    }

    // Non-binary JSON control message
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
      } else if (payload.action === 'stop_rtmp') {
        stopFfmpegStream();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'stopped' }));
        }
      } else if (payload.action === 'start_tv_feed') {
        startTvFfmpegBroadcast();
      } else if (payload.action === 'stop_tv_feed') {
        stopTvFfmpegBroadcast();
      } else if (payload.action === 'set_audio_mute') {
        liveAudioMutedFlag = Boolean(payload.muted);
        if (liveStreamState.destinations) {
          liveStreamState.destinations.audioMuted = liveAudioMutedFlag;
        }
        if (liveAudioMutedFlag) {
          pcmAudioQueue = [];
          pcmQueueBytes = 0;
          tvPcmAudioQueue = [];
          tvPcmQueueBytes = 0;
        }
        console.log(`[FFmpeg Audio] Mute en vivo -> ${liveAudioMutedFlag ? 'MUTED (Silencio digital)' : 'ON (Audio activo)'}`);
      } else if (payload.action === 'log') {
        console.log(`[Client WS Log] ${payload.event}:`, JSON.stringify(payload.details || {}));
      }
    } catch (err) {
      if (buf) {
        writeChunkToFfmpeg(buf, 'WS');
      }
    }
  });

  ws.on('close', () => {
    console.log('[WebSocket Stream] Browser client disconnected');
    if (activeStreamWebSocket === ws) {
      activeStreamWebSocket = null;
      if (activeFfmpegProcess) {
        stopFfmpegStream(false);
      }
      if (activeTvFfmpegProcess) {
        stopTvFfmpegBroadcast();
      }
    }
  });

  ws.on('error', (err) => {
    console.warn('[WebSocket Stream] Socket error:', err.message);
  });
});

// =========================================================================
// OMNICAST MOBILE CAM: HIGH-SPEED ULTRA-LOW LATENCY WEBSOCKET VIDEO RELAY
// =========================================================================
const mobileCamWss = new WebSocket.Server({ noServer: true });
const mobileCamReceivers = { 1: new Set(), 2: new Set(), 3: new Set(), 4: new Set(), 5: new Set() };

mobileCamWss.on('connection', (ws, request) => {
  const host = request.headers.host || 'localhost';
  const url = new URL(request.url, `http://${host}`);
  const role = url.searchParams.get('role') || 'receiver';
  const camId = parseInt(url.searchParams.get('cam') || '1', 10);

  if (role === 'receiver') {
    if (!mobileCamReceivers[camId]) mobileCamReceivers[camId] = new Set();
    mobileCamReceivers[camId].add(ws);
    ws.on('close', () => {
      if (mobileCamReceivers[camId]) mobileCamReceivers[camId].delete(ws);
    });
  } else if (role === 'sender') {
    ws.on('message', (data, isBinary) => {
      mobileCamLatestFrames[camId] = data;
      if (mobileCamsState[camId]) {
        mobileCamsState[camId].connected = true;
        mobileCamsState[camId].lastPing = Date.now();
      }
      const recs = mobileCamReceivers[camId];
      if (recs && recs.size > 0) {
        for (const r of recs) {
          if (r.readyState === WebSocket.OPEN) {
            r.send(data, { binary: isBinary });
          }
        }
      }
    });
  }
});

const handleUpgrade = (request, socket, head) => {
  try {
    const host = request.headers.host || 'localhost';
    const parsed = new URL(request.url, `http://${host}`);
    if (parsed.pathname === '/api/live-stream-ws') {
      liveStreamWss.handleUpgrade(request, socket, head, ws => {
        liveStreamWss.emit('connection', ws, request);
      });
    } else if (parsed.pathname === '/api/tv/ws') {
      tvStreamWss.handleUpgrade(request, socket, head, ws => {
        tvStreamWss.emit('connection', ws, request);
      });
    } else if (parsed.pathname === '/api/cam/ws') {
      mobileCamWss.handleUpgrade(request, socket, head, ws => {
        mobileCamWss.emit('connection', ws, request);
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
