const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

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
  libraryItems: []
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
        if (Array.isArray(payload.libraryItems)) studioState.libraryItems = payload.libraryItems;

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
  // =========================================================================

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

  // Endpoint: Start Live RTMP/RTMPS Stream via FFmpeg
  if (parsedUrl === '/api/stream/start' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const dest = JSON.parse(body || '{}');
        const yt = dest.youtube || {};
        const fb = dest.facebook || {};

        const targets = [];
        if (fb.enabled && fb.key && fb.key.trim()) {
          const rawUrl = (fb.url || 'rtmps://live-api-s.facebook.com:443/rtmp/').trim();
          const cleanKey = fb.key.trim();
          const targetUrl = rawUrl.endsWith('/') ? `${rawUrl}${cleanKey}` : `${rawUrl}/${cleanKey}`;
          targets.push({ name: 'Facebook Live', url: targetUrl });
        }

        if (yt.enabled && yt.key && yt.key.trim()) {
          const rawUrl = (yt.url || 'rtmp://a.rtmp.youtube.com/live2').trim();
          const cleanKey = yt.key.trim();
          const targetUrl = rawUrl.endsWith('/') ? `${rawUrl}${cleanKey}` : `${rawUrl}/${cleanKey}`;
          targets.push({ name: 'YouTube Live', url: targetUrl });
        }

        if (targets.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'No hay destinos de transmisión con clave válida configurada. Por favor ingresa tu clave en Destinos de Transmisión.'
          }));
          return;
        }

        // Clean up any existing stream process
        if (activeFfmpegProcess) {
          try { activeFfmpegProcess.stdin.end(); } catch (e) {}
          try { activeFfmpegProcess.kill('SIGINT'); } catch (e) {}
          activeFfmpegProcess = null;
        }

        const ffmpegPath = path.join(__dirname, 'bin', 'ffmpeg', 'ffmpeg.exe');
        if (!fs.existsSync(ffmpegPath)) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Binario FFmpeg no encontrado en ${ffmpegPath}` }));
          return;
        }

        const ffmpegArgs = [
          '-re',
          '-i', 'pipe:0',
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-tune', 'zerolatency',
          '-b:v', '4000k',
          '-maxrate', '4500k',
          '-bufsize', '8000k',
          '-pix_fmt', 'yuv420p',
          '-g', '60',
          '-keyint_min', '30',
          '-c:a', 'aac',
          '-b:a', '128k',
          '-ar', '44100'
        ];

        if (targets.length === 1) {
          ffmpegArgs.push('-f', 'flv', targets[0].url);
        } else {
          const teeTargets = targets.map(t => `[f=flv:onfail=ignore]${t.url}`).join('|');
          ffmpegArgs.push('-f', 'tee', '-map', '0:v', '-map', '0:a', teeTargets);
        }

        console.log(`[FFmpeg RTMP] Spawning streaming pipeline for: ${targets.map(t => t.name).join(' & ')}`);
        activeFfmpegProcess = spawn(ffmpegPath, ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

        liveStreamState.isStreaming = true;
        liveStreamState.startTime = Date.now();
        liveStreamState.destinations = dest;
        liveStreamState.stats = { fps: 0, bitrate: 0, speed: '1x', totalBytes: 0, droppedFrames: 0, error: null };

        activeFfmpegProcess.stdin.on('error', (err) => {
          console.warn('[FFmpeg stdin error]:', err.message);
        });

        activeFfmpegProcess.stderr.on('data', (data) => {
          const text = data.toString();
          if (!text.includes('frame=')) {
            console.log('[FFmpeg]:', text.trim());
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
            broadcastSSE('stream_telemetry', liveStreamState.stats);
          }

          if (/error in the pull function|connection refused|handshake failed/i.test(text)) {
            console.warn('[FFmpeg RTMP Warning]:', text.trim());
            liveStreamState.stats.error = text.trim();
          }
        });

        activeFfmpegProcess.on('close', (code) => {
          console.log(`[FFmpeg RTMP] Stream ended with exit code ${code}`);
          activeFfmpegProcess = null;
          liveStreamState.isStreaming = false;
          broadcastSSE('stream_status', { isStreaming: false, code });
        });

        activeFfmpegProcess.on('error', (err) => {
          console.error('[FFmpeg RTMP Process Error]:', err);
          liveStreamState.stats.error = err.message;
          activeFfmpegProcess = null;
          liveStreamState.isStreaming = false;
          broadcastSSE('stream_status', { isStreaming: false, error: err.message });
        });

        broadcastSSE('stream_status', { isStreaming: true, destinations: targets.map(t => t.name) });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: `Transmisión iniciada exitosamente a ${targets.map(t => t.name).join(' y ')}`,
          destinations: targets.map(t => t.name)
        }));
      } catch (err) {
        console.error('Error starting live stream:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Endpoint: Ingest Live Binary Stream Chunks from Canvas MediaRecorder
  if (parsedUrl === '/api/stream/chunk' && req.method === 'POST') {
    if (!activeFfmpegProcess || !liveStreamState.isStreaming) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: 'Stream is not active' }));
      return;
    }

    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      if (buffer.length > 0 && activeFfmpegProcess && activeFfmpegProcess.stdin && activeFfmpegProcess.stdin.writable) {
        try {
          activeFfmpegProcess.stdin.write(buffer);
          liveStreamState.stats.totalBytes += buffer.length;
        } catch (err) {
          console.warn('Error writing chunk to FFmpeg stdin:', err.message);
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, bytes: liveStreamState.stats.totalBytes }));
    });
    return;
  }

  // Endpoint: Stop Live Stream
  if (parsedUrl === '/api/stream/stop' && req.method === 'POST') {
    liveStreamState.isStreaming = false;
    liveStreamState.startTime = null;

    if (activeFfmpegProcess) {
      const proc = activeFfmpegProcess;
      activeFfmpegProcess = null;

      try {
        proc.stdin.end(); // Triggers EOF -> FFmpeg sends RTMP unpublish/close packet cleanly
      } catch (e) {}

      // Allow FFmpeg up to 4 seconds to gracefully finalize RTMP connection
      const killTimer = setTimeout(() => {
        try {
          proc.kill();
        } catch (e) {}
      }, 4000);

      proc.once('close', () => {
        clearTimeout(killTimer);
      });
    }

    broadcastSSE('stream_status', { isStreaming: false, stopped: true });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, stopped: true }));
    return;
  }


  // Static File Serving
  let reqPath = parsedUrl;
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

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    const readStream = fs.createReadStream(filePath);
    readStream.pipe(res);
  });
};

// Start Standard HTTP Server (Port 3000)
const httpServer = http.createServer(requestHandler);
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
