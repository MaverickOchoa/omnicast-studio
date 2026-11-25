const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'database.json');
const UPLOADS_VIDEOS_DIR = path.join(PUBLIC_DIR, 'uploads', 'videos');
const UPLOADS_IMAGES_DIR = path.join(PUBLIC_DIR, 'uploads', 'images');
const TV_HLS_DIR = path.join(PUBLIC_DIR, 'tv-hls');

// Ensure persistent database & video upload directories exist
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOADS_VIDEOS_DIR)) fs.mkdirSync(UPLOADS_VIDEOS_DIR, { recursive: true });
  if (!fs.existsSync(UPLOADS_IMAGES_DIR)) fs.mkdirSync(UPLOADS_IMAGES_DIR, { recursive: true });
  if (!fs.existsSync(TV_HLS_DIR)) fs.mkdirSync(TV_HLS_DIR, { recursive: true });
} catch (dirErr) {
  console.warn('Warning creating data/uploads dirs:', dirErr.message);
}

// On Linux/Docker/Railway, expand PATH and pre-unpack standalone static FFmpeg binary at startup
if (process.platform !== 'win32') {
  const extraPaths = [
    path.join(__dirname, 'bin', 'ffmpeg'),
    '/root/.nix-profile/bin',
    '/nix/var/nix/profiles/default/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin'
  ];
  process.env.PATH = `${extraPaths.join(':')}:${process.env.PATH || ''}`;
  try {
    ensureLinuxFfmpegBinary();
  } catch (e) {
    console.warn('[OmniCast Setup] Linux FFmpeg pre-unpack warning:', e.message);
  }
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
  '.webmanifest': 'application/manifest+json',
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
  streamingConfig: {
    youtube: { enabled: false, url: 'rtmp://a.rtmp.youtube.com/live2', key: '' },
    facebook: { enabled: true, url: 'rtmps://rtmp-api.facebook.com:443/rtmp/', key: 'FB-10243400060152717-0-Ab729pizCDn_CdsWUvW9yDBZ' },
    localTest: false
  },
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
        if (parsed.streamingConfig) {
          persistentDb.streamingConfig = Object.assign({
            youtube: { enabled: false, url: 'rtmp://a.rtmp.youtube.com/live2', key: '' },
            facebook: { enabled: true, url: 'rtmps://rtmp-api.facebook.com:443/rtmp/', key: 'FB-10243400060152717-0-Ab729pizCDn_CdsWUvW9yDBZ' },
            localTest: false
          }, parsed.streamingConfig);
          if (!persistentDb.streamingConfig.facebook || !persistentDb.streamingConfig.facebook.key || persistentDb.streamingConfig.facebook.key.startsWith('fb-test-key')) {
            persistentDb.streamingConfig.facebook = {
              enabled: true,
              url: 'rtmps://rtmp-api.facebook.com:443/rtmp/',
              key: 'FB-10243400060152717-0-Ab729pizCDn_CdsWUvW9yDBZ'
            };
          }
        }
        if (Array.isArray(parsed.diskVideos)) persistentDb.diskVideos = parsed.diskVideos;
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
      },
      {
        id: 'org-imec',
        name: 'IGLESIA MEXICANA DEL EVANGELIO DE CRISTO',
        slug: 'imec',
        adminEmail: 'huttmanochoa@gmail.com',
        username: 'Huttman Ochoa',
        password: 'YoYo158087',
        headquarters: 'IMEC',
        phone: '5530746982',
        plan: 'Enterprise Multi-Sede (Sedes Ilimitadas + CDN Global)',
        createdAt: '2026-11-15'
      }
    ];
  } else {
    // Garantizar que IMEC exista permanentemente
    if (!persistentDb.organizations.some(o => o.id === 'org-imec' || o.slug === 'imec')) {
      persistentDb.organizations.push({
        id: 'org-imec',
        name: 'IGLESIA MEXICANA DEL EVANGELIO DE CRISTO',
        slug: 'imec',
        adminEmail: 'huttmanochoa@gmail.com',
        username: 'Huttman Ochoa',
        password: 'YoYo158087',
        headquarters: 'IMEC',
        phone: '5530746982',
        plan: 'Enterprise Multi-Sede (Sedes Ilimitadas + CDN Global)',
        createdAt: '2026-11-15'
      });
    }
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
        name: 'Hebron',
        type: 'branch',
        orgId: 'org-imec',
        orgName: 'IGLESIA MEXICANA DEL EVANGELIO DE CRISTO',
        city: 'Zapopan, Jalisco',
        email: 'hebron@imec.org',
        username: 'hebron',
        password: 'YoYo158087',
        operator: 'Pastor Roberto G.',
        role: 'Master de Sede Filial',
        status: 'active'
      }
    ];
  } else {
    // Asegurar que Hebrón esté vinculada a IMEC con credenciales correctas y nombre limpio
    const hebron = persistentDb.churches.find(c => c.id === 'church-hebron' || c.username === 'hebron');
    if (hebron) {
      hebron.name = 'Hebron';
      hebron.type = 'branch';
      hebron.orgId = 'org-imec';
      hebron.orgName = 'IGLESIA MEXICANA DEL EVANGELIO DE CRISTO';
      hebron.role = 'Master de Sede Filial';
      if (!hebron.password || hebron.password === '123') {
        hebron.password = 'YoYo158087';
      }
    }
  }

  if (!persistentDb.streamingConfig) {
    persistentDb.streamingConfig = {
      youtube: { enabled: true, url: 'rtmp://a.rtmp.youtube.com/live2', key: '' },
      facebook: { enabled: true, url: 'rtmps://rtmp-api.facebook.com:443/rtmp/', key: '' },
      localTest: false
    };
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

// =========================================================================
// REINA-VALERA 1960 OFFICIAL CANONICAL BIBLE ENGINE (66 BOOKS)
// =========================================================================
let bibleRvr1960 = null;
const BIBLE_FILE = path.join(DATA_DIR, 'bible_rvr1960.json');
try {
  if (fs.existsSync(BIBLE_FILE)) {
    bibleRvr1960 = JSON.parse(fs.readFileSync(BIBLE_FILE, 'utf8'));
    console.log(`  📖 Base Bíblica RVR1960 cargada: ${Object.keys(bibleRvr1960).length} libros listos`);
  }
} catch (e) {
  console.warn('[OmniCast Bible] Warning loading bible_rvr1960.json:', e.message);
}

const BIBLE_BOOK_ALIASES = {
  'gen': 'genesis', 'genesis': 'genesis', 'génesis': 'genesis',
  'exo': 'exodo', 'exodo': 'exodo', 'éxodo': 'exodo',
  'lev': 'levitico', 'levitico': 'levitico', 'levítico': 'levitico',
  'num': 'numeros', 'numeros': 'numeros', 'números': 'numeros',
  'deu': 'deuteronomio', 'deuteronomio': 'deuteronomio', 'dt': 'deuteronomio',
  'jos': 'josue', 'josue': 'josue', 'josué': 'josue',
  'jue': 'jueces', 'jueces': 'jueces',
  'rut': 'rut', 'ruth': 'rut',
  '1sam': '1samuel', '1 sam': '1samuel', '1 samuel': '1samuel', '1samuel': '1samuel',
  '2sam': '2samuel', '2 sam': '2samuel', '2 samuel': '2samuel', '2samuel': '2samuel',
  '1rey': '1reyes', '1 rey': '1reyes', '1 reyes': '1reyes', '1reyes': '1reyes',
  '2rey': '2reyes', '2 rey': '2reyes', '2 reyes': '2reyes', '2reyes': '2reyes',
  '1cro': '1cronicas', '1 cro': '1cronicas', '1 cronicas': '1cronicas', '1crónicas': '1cronicas',
  '2cro': '2cronicas', '2 cro': '2cronicas', '2 cronicas': '2cronicas', '2crónicas': '2cronicas',
  'esd': 'esdras', 'esdras': 'esdras',
  'neh': 'nehemias', 'nehemias': 'nehemias', 'nehemías': 'nehemias',
  'est': 'ester', 'ester': 'ester',
  'job': 'job',
  'sal': 'salmos', 'salmo': 'salmos', 'salmos': 'salmos', 'ps': 'salmos', 'psalm': 'salmos', 'psalms': 'salmos',
  'pro': 'proverbios', 'pr': 'proverbios', 'proverbios': 'proverbios', 'prov': 'proverbios',
  'ecl': 'eclesiastes', 'eclesiastes': 'eclesiastes', 'eclesiastés': 'eclesiastes',
  'cnt': 'cantares', 'cantar': 'cantares', 'cantares': 'cantares',
  'isa': 'isaias', 'isaias': 'isaias', 'isaías': 'isaias',
  'jer': 'jeremias', 'jeremias': 'jeremias', 'jeremías': 'jeremias',
  'lam': 'lamentaciones', 'lamentaciones': 'lamentaciones',
  'eze': 'ezequiel', 'ezequiel': 'ezequiel',
  'dan': 'daniel', 'daniel': 'daniel',
  'ose': 'oseas', 'oseas': 'oseas',
  'joe': 'joel', 'joel': 'joel',
  'amo': 'amos', 'amos': 'amos', 'amós': 'amos',
  'abd': 'abdias', 'abdias': 'abdias', 'abdías': 'abdias',
  'jon': 'jonas', 'jonas': 'jonas', 'jonás': 'jonas',
  'miq': 'miqueas', 'miqueas': 'miqueas',
  'nah': 'nahum', 'nahum': 'nahum', 'nahúm': 'nahum',
  'hab': 'habacuc', 'habacuc': 'habacuc',
  'sof': 'sofonias', 'sofonias': 'sofonias', 'sofonías': 'sofonias',
  'hag': 'hageo', 'hageo': 'hageo',
  'zac': 'zacarias', 'zacarias': 'zacarias', 'zacarías': 'zacarias',
  'mal': 'malaquias', 'malaquias': 'malaquias', 'malaquías': 'malaquias',
  'mat': 'mateo', 'mateo': 'mateo', 'mt': 'mateo',
  'mar': 'marcos', 'marcos': 'marcos', 'mc': 'marcos',
  'luc': 'lucas', 'lucas': 'lucas', 'lc': 'lucas',
  'jua': 'juan', 'juan': 'juan', 'jn': 'juan',
  'hec': 'hechos', 'hechos': 'hechos', 'hch': 'hechos',
  'rom': 'romanos', 'romanos': 'romanos', 'ro': 'romanos',
  '1cor': '1corintios', '1 cor': '1corintios', '1 corintios': '1corintios', '1 co': '1corintios', '1co': '1corintios',
  '2cor': '2corintios', '2 cor': '2corintios', '2 corintios': '2corintios', '2 co': '2corintios', '2co': '2corintios',
  'gal': 'galatas', 'galatas': 'galatas', 'gálatas': 'galatas',
  'efe': 'efesios', 'efesios': 'efesios',
  'fil': 'filipenses', 'filipenses': 'filipenses', 'flp': 'filipenses',
  'col': 'colosenses', 'colosenses': 'colosenses',
  '1tes': '1tesalonicenses', '1 tes': '1tesalonicenses', '1 tesalonicenses': '1tesalonicenses',
  '2tes': '2tesalonicenses', '2 tes': '2tesalonicenses', '2 tesalonicenses': '2tesalonicenses',
  '1tim': '1timoteo', '1 tim': '1timoteo', '1 timoteo': '1timoteo',
  '2tim': '2timoteo', '2 tim': '2timoteo', '2 timoteo': '2timoteo',
  'tit': 'tito', 'tito': 'tito',
  'flm': 'filemon', 'filemon': 'filemon', 'filemón': 'filemon',
  'heb': 'hebreos', 'hebreos': 'hebreos',
  'stg': 'santiago', 'santiago': 'santiago', 'jac': 'santiago',
  '1ped': '1pedro', '1 ped': '1pedro', '1 pedro': '1pedro', '1 pe': '1pedro', '1pe': '1pedro',
  '2ped': '2pedro', '2 ped': '2pedro', '2 pedro': '2pedro', '2 pe': '2pedro', '2pe': '2pedro',
  '1jua': '1juan', '1 jua': '1juan', '1 juan': '1juan', '1 jn': '1juan', '1jn': '1juan',
  '2jua': '2juan', '2 jua': '2juan', '2 juan': '2juan', '2 jn': '2juan', '2jn': '2juan',
  '3jua': '3juan', '3 jua': '3juan', '3 juan': '3juan', '3 jn': '3juan', '3jn': '3juan',
  'jud': 'judas', 'judas': 'judas',
  'apo': 'apocalipsis', 'apocalipsis': 'apocalipsis', 'apoc': 'apocalipsis', 'rev': 'apocalipsis'
};

const BIBLE_CANONICAL_NAMES = {
  genesis: 'Génesis', exodo: 'Éxodo', levitico: 'Levítico', numeros: 'Números', deuteronomio: 'Deuteronomio',
  josue: 'Josué', jueces: 'Jueces', rut: 'Rut', '1samuel': '1 Samuel', '2samuel': '2 Samuel',
  '1reyes': '1 Reyes', '2reyes': '2 Reyes', '1cronicas': '1 Crónicas', '2cronicas': '2 Crónicas',
  esdras: 'Esdras', nehemias: 'Nehemías', ester: 'Ester', job: 'Job', salmos: 'Salmos',
  proverbios: 'Proverbios', eclesiastes: 'Eclesiastés', cantares: 'Cantares', isaias: 'Isaías',
  jeremias: 'Jeremías', lamentaciones: 'Lamentaciones', ezequiel: 'Ezequiel', daniel: 'Daniel',
  oseas: 'Oseas', joel: 'Joel', amos: 'Amós', abdias: 'Abdías', jonas: 'Jonás', miqueas: 'Miqueas',
  nahum: 'Nahúm', habacuc: 'Habacuc', sofonias: 'Sofonías', hageo: 'Hageo', zacarias: 'Zacarías',
  malaquias: 'Malaquías', mateo: 'Mateo', marcos: 'Marcos', lucas: 'Lucas', juan: 'Juan',
  hechos: 'Hechos', romanos: 'Romanos', '1corintios': '1 Corintios', '2corintios': '2 Corintios',
  galatas: 'Gálatas', efesios: 'Efesios', filipenses: 'Filipenses', colosenses: 'Colosenses',
  '1tesalonicenses': '1 Tesalonicenses', '2tesalonicenses': '2 Tesalonicenses',
  '1timoteo': '1 Timoteo', '2timoteo': '2 Timoteo', tito: 'Tito', filemon: 'Filemón',
  hebreos: 'Hebreos', santiago: 'Santiago', '1pedro': '1 Pedro', '2pedro': '2 Pedro',
  '1juan': '1 Juan', '2juan': '2 Juan', '3juan': '3 Juan', judas: 'Judas', apocalipsis: 'Apocalipsis'
};

function parseBibleCitation(query) {
  if (!query || typeof query !== 'string') return null;
  let q = query.trim().toLowerCase().replace(/[.,;]/g, ':').replace(/::+/g, ':');
  const m = q.match(/^([1-3]?\s*[a-záéíóúñ]+)\s*(\d+)(?:\s*:\s*(\d+)(?:\s*-\s*(\d+))?)?$/i);
  if (!m) return null;
  const rawBook = m[1].replace(/\s+/g, ' ').trim();
  const chapter = parseInt(m[2], 10);
  const startVerse = m[3] ? parseInt(m[3], 10) : 1;
  const endVerse = m[4] ? parseInt(m[4], 10) : startVerse;
  
  let bookKey = BIBLE_BOOK_ALIASES[rawBook] || BIBLE_BOOK_ALIASES[rawBook.replace(/\s+/g, '')];
  if (!bookKey) {
    const clean = rawBook.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '');
    bookKey = BIBLE_BOOK_ALIASES[clean];
  }
  return { bookKey, chapter, startVerse, endVerse };
}

// Global Studio State per Church / Branch (Multi-Sede Signal & Room Isolation)
const churchStates = new Map();

function createDefaultStudioState(churchId = 'default') {
  return {
    churchId,
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
    layer1: null,
    currentSlidePayload: null,
    libraryItems: persistentDb.libraryItems.length > 0 ? JSON.parse(JSON.stringify(persistentDb.libraryItems)) : []
  };
}

let studioState = createDefaultStudioState('default');
churchStates.set('default', studioState);

function getChurchState(churchId) {
  const cid = (churchId && String(churchId).trim()) ? String(churchId).trim() : 'default';
  if (!churchStates.has(cid)) {
    churchStates.set(cid, createDefaultStudioState(cid));
  }
  return churchStates.get(cid);
}

// Mobile Cameras & WebRTC State per Church
const churchCamStates = new Map();

function createDefaultCamState() {
  return {
    mobileCamsState: {
      1: { connected: false, name: 'Cámara 1 (Púlpito)', battery: null, fps: 30, res: '1080p', tally: 'IDLE', lastPing: 0 },
      2: { connected: false, name: 'Cámara 2 (Altar)', battery: null, fps: 30, res: '1080p', tally: 'IDLE', lastPing: 0 },
      3: { connected: false, name: 'Cámara 3 (Músicos)', battery: null, fps: 30, res: '1080p', tally: 'IDLE', lastPing: 0 },
      4: { connected: false, name: 'Cámara 4 (Móvil)', battery: null, fps: 30, res: '1080p', tally: 'IDLE', lastPing: 0 },
      5: { connected: false, name: 'Cámara 5 (Auxiliar)', battery: null, fps: 30, res: '1080p', tally: 'IDLE', lastPing: 0 }
    },
    currentTallyState: { programCam: 0, previewCam: 0 },
    camSignalsForStudio: [],
    camSignalsForPhones: { 1: [], 2: [], 3: [], 4: [], 5: [] },
    mobileCamLatestFrames: { 1: null, 2: null, 3: null, 4: null, 5: null }
  };
}

let defaultCamState = createDefaultCamState();
churchCamStates.set('default', defaultCamState);

function getChurchCamState(churchId) {
  const cid = (churchId && String(churchId).trim()) ? String(churchId).trim() : 'default';
  if (!churchCamStates.has(cid)) {
    churchCamStates.set(cid, createDefaultCamState());
  }
  return churchCamStates.get(cid);
}

let mobileCamsState = defaultCamState.mobileCamsState;
let currentTallyState = defaultCamState.currentTallyState;
const camSignalsForStudio = defaultCamState.camSignalsForStudio;
const camSignalsForPhones = defaultCamState.camSignalsForPhones;
const mobileCamLatestFrames = defaultCamState.mobileCamLatestFrames;

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

// Connected SSE clients segmented by church (churchId -> Set of res)
const sseClientsByChurch = new Map();

function getChurchClients(churchId) {
  const cid = (churchId && String(churchId).trim()) ? String(churchId).trim() : 'default';
  if (!sseClientsByChurch.has(cid)) {
    sseClientsByChurch.set(cid, new Set());
  }
  return sseClientsByChurch.get(cid);
}

function broadcastSSE(event, data, targetChurchId = null) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  if (targetChurchId && targetChurchId !== '*') {
    const clients = sseClientsByChurch.get(targetChurchId);
    if (clients) {
      for (const client of clients) {
        try {
          client.write(payload);
        } catch (e) {
          clients.delete(client);
        }
      }
    }
  } else {
    // Broadcast to all churches
    for (const [, clients] of sseClientsByChurch.entries()) {
      for (const client of clients) {
        try {
          client.write(payload);
        } catch (e) {
          clients.delete(client);
        }
      }
    }
  }
}

// Background timer ticker per church
setInterval(() => {
  for (const [cid, st] of churchStates.entries()) {
    if (st.timerRunning && st.timerSeconds > 0) {
      st.timerSeconds--;
      broadcastSSE('timer', { seconds: st.timerSeconds, running: true }, cid);
    } else if (st.timerRunning && st.timerSeconds === 0) {
      st.timerRunning = false;
      broadcastSSE('timer', { seconds: 0, running: false }, cid);
    }
  }
}, 1000);

// SSE Keepalive Heartbeat: prevents Cloudflare tunnels, NAT routers, and Chrome from dropping idle connections
setInterval(() => {
  for (const [, clients] of sseClientsByChurch.entries()) {
    for (const client of clients) {
      try {
        client.write(': keepalive\n\n');
      } catch (e) {
        clients.delete(client);
      }
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

  // API 2: Server-Sent Events (Live WiFi Push to phones/iPads/Studio per church)
  if (parsedUrl === '/api/events') {
    const fullUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const churchId = fullUrl.searchParams.get('church') || 'default';
    const clients = getChurchClients(churchId);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    while (clients.size >= 50) {
      const oldest = clients.values().next().value;
      if (!oldest) break;
      clients.delete(oldest);
      try { oldest.end(); } catch (e) {}
    }
    clients.add(res);

    // Send immediate current state for this church
    const st = getChurchState(churchId);
    const camSt = getChurchCamState(churchId);
    res.write(`event: state\ndata: ${JSON.stringify(st)}\n\n`);
    res.write(`event: cam_tally\ndata: ${JSON.stringify(camSt.currentTallyState)}\n\n`);
    if (st.layer1) {
      res.write(`event: layer1_update\ndata: ${JSON.stringify(st.layer1)}\n\n`);
    }
    if (st.currentSlidePayload) {
      res.write(`event: slide_payload\ndata: ${JSON.stringify(st.currentSlidePayload)}\n\n`);
    }

    req.on('close', () => {
      clients.delete(res);
    });
    return;
  }

  // API 3: Get Current State
  if (parsedUrl === '/api/state' && req.method === 'GET') {
    const fullUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const churchId = fullUrl.searchParams.get('church') || 'default';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getChurchState(churchId)));
    return;
  }

  // API 4: Sync Studio State from main index.html
  if (parsedUrl === '/api/sync' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const churchId = payload.churchId || 'default';
        const st = getChurchState(churchId);

        if (typeof payload.itemIndex === 'number') st.itemIndex = payload.itemIndex;
        if (typeof payload.slideIndex === 'number') st.slideIndex = payload.slideIndex;
        if (typeof payload.isBlackout === 'boolean') st.isBlackout = payload.isBlackout;
        if (typeof payload.theme === 'string') st.theme = payload.theme;
        if (Array.isArray(payload.libraryItems)) {
          st.libraryItems = payload.libraryItems;
          if (payload.persistDb) {
            persistentDb.libraryItems = payload.libraryItems;
            savePersistentDatabase();
          }
        }
        if (payload.currentSlidePayload) {
          st.currentSlidePayload = payload.currentSlidePayload;
          broadcastSSE('slide_payload', payload.currentSlidePayload, churchId);
        }

        broadcastSSE('state', st, churchId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // API 4.2: Capa 1 State Sync (Logos & Portadas for network projectors & stage screens)
  if (parsedUrl === '/api/layer1' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const churchId = payload.churchId || 'default';
        const st = getChurchState(churchId);
        st.layer1 = payload;
        broadcastSSE('layer1_update', payload, churchId);
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
          const churchId = cmd.churchId || 'default';
          const st = getChurchState(churchId);
          if (st.currentSlidePayload) {
            st.currentSlidePayload.videoAction = cmd.action;
            if (typeof cmd.time === 'number') st.currentSlidePayload.currentTime = cmd.time;
            if (typeof cmd.loop === 'boolean') st.currentSlidePayload.videoLoop = cmd.loop;
            if (typeof cmd.muted === 'boolean') st.currentSlidePayload.videoMuted = cmd.muted;
            if (cmd.videoUrl) st.currentSlidePayload.videoUrl = cmd.videoUrl;
          }
          broadcastSSE('video_control', cmd, churchId);
          broadcastSSE('state', st, churchId);
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
        const churchId = data.churchId || 'default';
        const st = getChurchState(churchId);
        const action = data.action;

        if (action === 'next_slide') {
          st.isBlackout = false;
          const currentItem = st.libraryItems[st.itemIndex];
          if (currentItem && currentItem.slides) {
            if (st.slideIndex < currentItem.slides.length - 1) {
              st.slideIndex++;
            } else if (st.itemIndex < st.libraryItems.length - 1) {
              st.itemIndex++;
              st.slideIndex = 0;
            }
          }
        } else if (action === 'prev_slide') {
          st.isBlackout = false;
          if (st.slideIndex > 0) {
            st.slideIndex--;
          } else if (st.itemIndex > 0) {
            st.itemIndex--;
            const prevItem = st.libraryItems[st.itemIndex];
            st.slideIndex = (prevItem && prevItem.slides) ? prevItem.slides.length - 1 : 0;
          }
        } else if (action === 'set_slide') {
          st.isBlackout = false;
          if (typeof data.itemIndex === 'number') st.itemIndex = data.itemIndex;
          if (typeof data.slideIndex === 'number') st.slideIndex = data.slideIndex;
        } else if (action === 'blackout') {
          st.isBlackout = (typeof data.isBlackout === 'boolean') ? data.isBlackout : !st.isBlackout;
        } else if (action === 'timer_start') {
          st.timerRunning = true;
        } else if (action === 'timer_pause') {
          st.timerRunning = false;
        } else if (action === 'timer_reset') {
          st.timerSeconds = typeof data.seconds === 'number' ? data.seconds : 2100;
          st.timerRunning = false;
        } else if (action === 'timer_adjust') {
          const delta = typeof data.delta === 'number' ? data.delta : 0;
          st.timerSeconds = Math.max(0, st.timerSeconds + delta);
        } else if (action === 'stage_message') {
          st.stageMessage = data.message || '';
        } else if (action === 'set_tv_mode') {
          st.tvMode = data.mode || 'LOBBY';
        } else if (action === 'set_tv_alert') {
          st.tvAlert = data.alert || '';
        } else if (action === 'set_tv_service_live') {
          const nextActive = Boolean(data.active);
          st.tvServiceLive = nextActive;
          if (nextActive) {
            startTvFfmpegBroadcast();
          } else {
            stopTvFfmpegBroadcast();
          }
        }

        broadcastSSE('state', st, churchId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, state: st }));
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
        const churchId = sig.churchId || 'default';
        const camSt = getChurchCamState(churchId);
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
          camSt.camSignalsForStudio.push(sig);
          broadcastSSE('cam_signal', sig, churchId);
        } else if (sig.from === 'studio') {
          if (!camSt.camSignalsForPhones[camId]) camSt.camSignalsForPhones[camId] = [];
          camSt.camSignalsForPhones[camId].push(sig);
          broadcastSSE('cam_signal', sig, churchId);
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
    const churchId = fullUrl.searchParams.get('church') || 'default';
    const camSt = getChurchCamState(churchId);
    const camId = parseInt(fullUrl.searchParams.get('cam') || '1', 10);
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      if (buffer.length > 0) {
        camSt.mobileCamLatestFrames[camId] = buffer;
        if (camSt.mobileCamsState[camId]) {
          camSt.mobileCamsState[camId].connected = true;
          camSt.mobileCamsState[camId].lastPing = Date.now();
        }
        const recKey = `${churchId}_${camId}`;
        const recs = mobileCamReceiversMap.get(recKey);
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
    const churchId = fullUrl.searchParams.get('church') || 'default';
    const camSt = getChurchCamState(churchId);
    const camId = parseInt(fullUrl.searchParams.get('cam') || '1', 10);
    const buf = camSt.mobileCamLatestFrames[camId];
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
    const churchId = fullUrl.searchParams.get('church') || 'default';
    const camSt = getChurchCamState(churchId);
    const camId = parseInt(fullUrl.searchParams.get('id') || '1', 10);
    const from = fullUrl.searchParams.get('from') || 'phone';

    let signals = [];
    if (from === 'phone') {
      // Phone is asking for signals from studio
      signals = camSt.camSignalsForPhones[camId] || [];
      camSt.camSignalsForPhones[camId] = [];
    } else {
      // Studio is asking for signals from phones
      signals = camSt.camSignalsForStudio.splice(0, camSt.camSignalsForStudio.length);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      signals,
      tally: camSt.currentTallyState,
      cams: camSt.mobileCamsState
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
        const churchId = status.churchId || 'default';
        const camSt = getChurchCamState(churchId);
        const camId = parseInt(status.camId || 1, 10);
        if (camSt.mobileCamsState[camId]) {
          camSt.mobileCamsState[camId].connected = true;
          camSt.mobileCamsState[camId].lastPing = Date.now();
          if (status.battery !== undefined) camSt.mobileCamsState[camId].battery = status.battery;
          if (status.facingMode) camSt.mobileCamsState[camId].facingMode = status.facingMode;
          if (status.userAgent) camSt.mobileCamsState[camId].userAgent = status.userAgent;
        }
        broadcastSSE('cam_status', { camId, status: camSt.mobileCamsState[camId] }, churchId);
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
        const churchId = payload.churchId || 'default';
        const camSt = getChurchCamState(churchId);
        const targetCams = (payload.camId === 'all' || !payload.camId) ? [1, 2, 3, 4] : [parseInt(payload.camId, 10)];
        targetCams.forEach(id => {
          if (!camSt.camSignalsForPhones[id]) camSt.camSignalsForPhones[id] = [];
          camSt.camSignalsForPhones[id].push({ type: 'renegotiate', camId: id });
        });
        broadcastSSE('cam_renegotiate', payload, churchId);
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
        const churchId = tally.churchId || 'default';
        const camSt = getChurchCamState(churchId);
        camSt.currentTallyState.programCam = parseInt(tally.programCam || 0, 10);
        camSt.currentTallyState.previewCam = parseInt(tally.previewCam || 0, 10);
        broadcastSSE('cam_tally', camSt.currentTallyState, churchId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, tally: camSt.currentTallyState }));
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
      destinations: liveStreamState.destinations,
      hasFfmpeg: hasFfmpeg(),
      ffmpegPath: getFfmpegPath(),
      platform: process.platform
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
        const resolvedFb = resolveLatestFacebookKey(fb.key);
        if (fb.enabled && resolvedFb) {
          targetNames.push('Facebook Live');
          if (!fb.key) fb.key = resolvedFb;
        }
        const resolvedYt = resolveLatestYouTubeKey(yt.key);
        if (!dest.localTest && yt.enabled && resolvedYt) {
          targetNames.push('YouTube Live');
          if (!yt.key) yt.key = resolvedYt;
        }
        if (dest.localTest) {
          targetNames.push('Prueba Local');
        }
        if (targetNames.length === 0) {
          const errPayload = JSON.stringify({ error: 'No hay destinos de transmisión con clave válida configurada. Ingresa tu clave en Ajustes > Destinos.' });
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

  // Endpoint: Verify RTMP Targets Health (Diagnostic Tool for Facebook & YouTube)
  if (parsedUrl === '/api/stream/verify-targets' && req.method === 'GET') {
    loadPersistentDatabase();
    const cfg = persistentDb.streamingConfig || {};
    const fb = cfg.facebook || {};
    const yt = cfg.youtube || {};
    const resolvedFb = resolveLatestFacebookKey(fb.key);
    const resolvedYt = resolveLatestYouTubeKey(yt.key);

    const report = {
      success: true,
      ffmpeg: {
        available: hasFfmpeg(),
        path: getFfmpegPath(),
        platform: process.platform
      },
      facebook: {
        enabled: Boolean(fb.enabled),
        configured: Boolean(resolvedFb),
        keyMasked: resolvedFb ? `${resolvedFb.substring(0, 7)}...${resolvedFb.substring(resolvedFb.length - 4)}` : null,
        url: (fb.url || 'rtmps://rtmp-api.facebook.com:443/rtmp/').trim(),
        status: resolvedFb ? 'Listo para transmitir' : 'Falta ingresar la clave de Facebook Live'
      },
      youtube: {
        enabled: Boolean(yt.enabled),
        configured: Boolean(resolvedYt),
        keyMasked: resolvedYt ? `${resolvedYt.substring(0, 4)}...${resolvedYt.substring(resolvedYt.length - 4)}` : null,
        url: (yt.url || 'rtmp://a.rtmp.youtube.com/live2').trim(),
        status: resolvedYt ? 'Listo para transmitir' : 'Falta ingresar la clave de YouTube Live en Ajustes > Destinos'
      }
    };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(report));
    return;
  }

  // Endpoint: Get Recent FFmpeg Streaming Logs
  if (parsedUrl === '/api/stream/logs' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({
      success: true,
      isStreaming: liveStreamState.isStreaming,
      stats: liveStreamState.stats,
      logs: recentFfmpegLogs
    }));
    return;
  }

  // Endpoint: Test FFmpeg Live Pipeline (Diagnostic test to verify RTMP handshake or null encoding)
  if (parsedUrl === '/api/stream/test-pipeline' && req.method === 'GET') {
    (async () => {
      loadPersistentDatabase();
      const fullUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const mode = fullUrl.searchParams.get('mode') || 'live';
      const cfg = persistentDb.streamingConfig || {};
      const fb = cfg.facebook || {};
      const yt = cfg.youtube || {};
      const resolvedFb = resolveLatestFacebookKey(fb.key);
      const resolvedYt = resolveLatestYouTubeKey(yt.key);
      const ffmpegPath = getFfmpegPath();

      if (!hasFfmpeg()) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'FFmpeg no disponible en este servidor', logs: [] }));
        return;
      }

      let outFormat = ['-f', 'flv'];
      let targetUrl = '';
      let targetName = 'Facebook Live';

      if (mode === 'null') {
        outFormat = ['-f', 'null', '-'];
        targetUrl = '';
        targetName = 'Codificador x264/AAC Local (Sin red)';
      } else {
        const testTarget = (resolvedFb && !resolvedFb.startsWith('fb-test-key') && resolvedFb !== 'FB-1049284729184712-live')
          ? {
              name: 'Facebook Live',
              url: (fb.url || 'rtmps://rtmp-api.facebook.com:443/rtmp/').endsWith('/')
                ? `${fb.url || 'rtmps://rtmp-api.facebook.com:443/rtmp/'}${resolvedFb}`
                : `${fb.url || 'rtmps://rtmp-api.facebook.com:443/rtmp/'}/${resolvedFb}`
            }
          : (resolvedYt && !resolvedYt.startsWith('yt-test-key') && resolvedYt !== 'yt-live-9382-7712-4412-omni')
            ? {
                name: 'YouTube Live',
                url: (yt.url || 'rtmp://a.rtmp.youtube.com/live2').endsWith('/')
                  ? `${yt.url || 'rtmp://a.rtmp.youtube.com/live2'}${resolvedYt}`
                  : `${yt.url || 'rtmp://a.rtmp.youtube.com/live2'}/${resolvedYt}`
              }
            : null;

        if (!testTarget) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'No hay ninguna clave válida configurada para Facebook ni YouTube.', logs: [] }));
          return;
        }
        targetName = testTarget.name;
        targetUrl = testTarget.url;
      }

      let testRelay = null;
      if (targetUrl && targetUrl.startsWith('rtmps://')) {
        testRelay = await createLocalTlsRtmpRelay(targetUrl);
        targetUrl = testRelay.url;
      }

      const testArgs = [
        '-thread_queue_size', '1024',
        '-f', 'lavfi',
        '-i', 'color=c=blue:s=1280x720:r=30',
        '-f', 'lavfi',
        '-i', 'anullsrc=r=44100:cl=stereo',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-threads', '2',
        '-b:v', '2000k',
        '-pix_fmt', 'yuv420p',
        '-g', '60',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '44100',
        '-t', '3',
        ...outFormat
      ];
      if (targetUrl) testArgs.push(targetUrl);

      const testLogs = [];
      console.log(`[Diagnostic Pipeline] Testing 3s live stream (${targetName})...`);
      const proc = spawn(ffmpegPath, testArgs);
      proc.stderr.on('data', d => {
        const lines = d.toString().split(/\r?\n/).filter(Boolean);
        for (const l of lines) {
          testLogs.push(l.trim());
          addFfmpegLog(`[Test] ${l.trim()}`);
        }
      });
      proc.on('close', (code, signal) => {
        if (testRelay) {
          try { testRelay.close(); } catch (e) {}
        }
        const connected = code === 0 || testLogs.some(l => l.includes('Output #0') || l.includes('frame='));
        console.log(`[Diagnostic Pipeline] Test ended: code=${code}, signal=${signal}, connected=${connected}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: connected,
          code,
          signal,
          target: targetName,
          logs: testLogs
        }));
      });
      proc.on('error', err => {
        if (testRelay) {
          try { testRelay.close(); } catch (e) {}
        }
        console.error('[Diagnostic Pipeline Error]:', err.message);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message, logs: testLogs }));
      });
    })().catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    });
    return;
  }

  // Endpoint: Get Persistent Streaming Config (Shared across all connected devices)
  if (parsedUrl === '/api/stream/config' && req.method === 'GET') {
    loadPersistentDatabase();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({ success: true, config: persistentDb.streamingConfig }));
    return;
  }

  // Endpoint: Save Persistent Streaming Config (Shared across all connected devices)
  if (parsedUrl === '/api/stream/config' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        persistentDb.streamingConfig = payload;
        savePersistentDatabase();
        broadcastSSE('streaming_config_update', persistentDb.streamingConfig);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, config: persistentDb.streamingConfig }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // =========================================================================
  // CANONICAL BIBLE RVR1960 API ENDPOINTS
  // =========================================================================

  // Endpoint: Raw Bible JSON dataset
  if ((parsedUrl === '/data/bible_rvr1960.json' || parsedUrl === '/bible_rvr1960.json') && req.method === 'GET') {
    if (fs.existsSync(BIBLE_FILE)) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' });
      fs.createReadStream(BIBLE_FILE).pipe(res);
      return;
    }
  }

  // Endpoint: Get Complete Bible Chapter
  if (parsedUrl === '/api/bible/chapter' && req.method === 'GET') {
    const fullUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const rawBook = (fullUrl.searchParams.get('book') || 'juan').toLowerCase().trim();
    const chapterNum = parseInt(fullUrl.searchParams.get('chapter') || '1', 10);
    
    let bookKey = BIBLE_BOOK_ALIASES[rawBook] || BIBLE_BOOK_ALIASES[rawBook.replace(/\s+/g, '')];
    if (!bookKey) {
      const clean = rawBook.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '');
      bookKey = BIBLE_BOOK_ALIASES[clean] || 'juan';
    }

    const bookName = BIBLE_CANONICAL_NAMES[bookKey] || bookKey;
    let verses = [];
    if (bibleRvr1960 && bibleRvr1960[bookKey]) {
      const chapIdx = Math.max(0, Math.min(bibleRvr1960[bookKey].length - 1, chapterNum - 1));
      verses = bibleRvr1960[bookKey][chapIdx] || [];
    }

    const payload = JSON.stringify({
      success: true,
      bookKey,
      bookName,
      chapter: chapterNum,
      totalChapters: (bibleRvr1960 && bibleRvr1960[bookKey]) ? bibleRvr1960[bookKey].length : 0,
      verses: verses.map((text, idx) => ({ num: idx + 1, text }))
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' });
    res.end(payload);
    return;
  }

  // Endpoint: Search / Parse Bible Verse by Citation (e.g., "Juan 3:16", "Salmos 23:1-3")
  if (parsedUrl === '/api/bible/verse' && req.method === 'GET') {
    const fullUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const query = fullUrl.searchParams.get('query') || fullUrl.searchParams.get('q') || 'Juan 3:16';
    
    const parsed = parseBibleCitation(query);
    if (!parsed || !bibleRvr1960 || !bibleRvr1960[parsed.bookKey]) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Pasaje no encontrado', query }));
      return;
    }

    const chapArr = bibleRvr1960[parsed.bookKey][parsed.chapter - 1];
    if (!chapArr) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: `El capítulo ${parsed.chapter} no existe en ${parsed.bookKey}`, query }));
      return;
    }

    const start = Math.max(1, parsed.startVerse);
    const end = Math.min(chapArr.length, parsed.endVerse);
    const selectedVerses = chapArr.slice(start - 1, end);
    const bookName = BIBLE_CANONICAL_NAMES[parsed.bookKey] || parsed.bookKey;
    const refStr = start === end ? `${bookName} ${parsed.chapter}:${start}` : `${bookName} ${parsed.chapter}:${start}-${end}`;

    const text = selectedVerses.join(' ');
    const payload = JSON.stringify({
      success: true,
      citation: refStr,
      title: refStr.toUpperCase(),
      text,
      subText: `${refStr} (Reina-Valera 1960)`,
      badge: refStr.toUpperCase(),
      bookKey: parsed.bookKey,
      chapter: parsed.chapter,
      startVerse: start,
      endVerse: end,
      verses: selectedVerses.map((t, i) => ({ num: start + i, text: t }))
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' });
    res.end(payload);
    return;
  }

  // Endpoint: Get All 66 Bible Books Metadata
  if (parsedUrl === '/api/bible/books' && req.method === 'GET') {
    const books = Object.keys(BIBLE_CANONICAL_NAMES).map(key => {
      const chaps = (bibleRvr1960 && bibleRvr1960[key]) ? bibleRvr1960[key].length : 0;
      return {
        id: key,
        name: BIBLE_CANONICAL_NAMES[key],
        chapters: chaps
      };
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' });
    res.end(JSON.stringify({ success: true, books }));
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
      const targetOrgId = fullUrl.searchParams.get('targetOrgId') || fullUrl.searchParams.get('orgId') || req.headers['x-org-id'] || null;
      const targetChurchId = fullUrl.searchParams.get('targetChurchId') || fullUrl.searchParams.get('churchId') || req.headers['x-church-id'] || null;
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
          targetChurchId: targetChurchId,
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
          sizeMb: sizeMb,
          targetOrgId: targetOrgId,
          targetChurchId: targetChurchId
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

  // Endpoint: Stream Upload of Binary Image File (.png, .jpg, .jpeg, .webp, .svg) for Logos, Portadas & Loops Multimedia
  if (parsedUrl === '/api/upload/image' && req.method === 'POST') {
    try {
      const fullUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const rawFilename = fullUrl.searchParams.get('filename') || 'image.png';
      const title = (fullUrl.searchParams.get('title') || 'Fondo / Imagen HD').trim();
      const author = (fullUrl.searchParams.get('author') || 'Imagen Local HD').trim();
      const scope = (fullUrl.searchParams.get('scope') || '📍 SEDE LOCAL').trim();
      const targetOrgId = fullUrl.searchParams.get('targetOrgId') || fullUrl.searchParams.get('orgId') || req.headers['x-org-id'] || null;
      const targetChurchId = fullUrl.searchParams.get('targetChurchId') || fullUrl.searchParams.get('churchId') || req.headers['x-church-id'] || null;
      const addToLibrary = fullUrl.searchParams.get('addToLibrary') === 'true' || fullUrl.searchParams.has('title');

      const ext = path.extname(rawFilename).toLowerCase() || '.png';
      const baseSafe = path.basename(rawFilename, ext).replace(/[^a-zA-Z0-9_\-\.]/g, '_').slice(0, 60) || 'image';
      const finalFilename = `${Date.now()}_${baseSafe}${ext}`;
      const destPath = path.join(UPLOADS_IMAGES_DIR, finalFilename);

      const writeStream = fs.createWriteStream(destPath);
      req.pipe(writeStream);

      writeStream.on('finish', () => {
        const imageUrl = `/uploads/images/${finalFilename}`;
        let newImageItem = null;

        if (addToLibrary) {
          newImageItem = {
            id: `media-${Date.now()}`,
            category: 'medios',
            isImage: true,
            imageUrl: imageUrl,
            filename: finalFilename,
            title: title,
            author: `${author} • Imagen HD`,
            scope: scope,
            targetOrgId: targetOrgId,
            targetChurchId: targetChurchId,
            slides: [
              {
                text: title,
                subText: 'Fondo / Imagen HD • Listo para Proyectar',
                badge: '🖼️ IMAGEN HD'
              }
            ]
          };

          loadPersistentDatabase();
          persistentDb.libraryItems.unshift(newImageItem);
          studioState.libraryItems = persistentDb.libraryItems;
          savePersistentDatabase();

          broadcastSSE('state', studioState);
          broadcastSSE('db_update', {
            libraryItems: persistentDb.libraryItems,
            updatedAt: persistentDb.updatedAt
          });
        }

        const payload = JSON.stringify({
          success: true,
          url: imageUrl,
          filename: finalFilename,
          item: newImageItem,
          libraryItems: persistentDb.libraryItems
        });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'Access-Control-Allow-Origin': '*'
        });
        res.end(payload);
        console.log(`[OmniCast Image Upload] Saved ${finalFilename} -> ${imageUrl} (multimedia: ${Boolean(addToLibrary)})`);
      });

      writeStream.on('error', (err) => {
        const payload = JSON.stringify({ success: false, error: err.message });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(payload);
      });
    } catch (err) {
      const payload = JSON.stringify({ success: false, error: err.message });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(payload);
    }
    return;
  }

  // Static File Serving (with HTTP 206 Range support for smooth MP4/WebM HTML5 Video playback)
  let reqPath = decodeURIComponent(parsedUrl);
  if (reqPath === '/' || reqPath === '') {
    reqPath = '/index.html';
  } else if (reqPath === '/app' || reqPath === '/studio') {
    reqPath = '/app.html';
  } else if (reqPath === '/login') {
    reqPath = '/app.html';
  } else if (reqPath === '/pad' || reqPath === '/pizarra' || reqPath === '/tablet') {
    reqPath = '/pad.html';
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
    const headers = {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
      'Access-Control-Allow-Headers': 'Content-Type, Range',
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
      'Cache-Control': reqPath === '/sw.js' ? 'no-cache, no-store, must-revalidate' : 'no-store'
    };
    if (reqPath === '/sw.js') {
      headers['Service-Worker-Allowed'] = '/';
    }
    res.writeHead(200, headers);
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

// Live Stream FFmpeg Diagnostic Circular Log Buffer
const recentFfmpegLogs = [];
function addFfmpegLog(line) {
  if (!line) return;
  const ts = new Date().toISOString().substring(11, 19);
  const clean = String(line).trim();
  if (!clean) return;
  recentFfmpegLogs.push(`[${ts}] ${clean}`);
  if (recentFfmpegLogs.length > 120) recentFfmpegLogs.shift();
}

let standbyJpegBuffer = null;
let currentFrameJpeg = null;

function ensureLinuxFfmpegBinary() {
  const linuxPath = path.join(__dirname, 'bin', 'ffmpeg', 'ffmpeg');
  if (fs.existsSync(linuxPath)) {
    try {
      fs.chmodSync(linuxPath, 0o755);
      return linuxPath;
    } catch (e) {}
  }

  const isArm64 = process.arch === 'arm64';
  const gzName = isArm64 ? 'ffmpeg-linux-arm64.gz' : 'ffmpeg-linux-x64.gz';
  const gzPath = path.join(__dirname, 'bin', 'ffmpeg', gzName);

  if (fs.existsSync(gzPath)) {
    try {
      console.log(`[OmniCast Stream] Desempaquetando binario estático de FFmpeg para Linux (${isArm64 ? 'arm64' : 'x64'})...`);
      const gzBuffer = fs.readFileSync(gzPath);
      const elfBuffer = zlib.gunzipSync(gzBuffer);
      fs.writeFileSync(linuxPath, elfBuffer);
      fs.chmodSync(linuxPath, 0o755);
      console.log('[OmniCast Stream] Binario FFmpeg para Linux listo y ejecutable.');
      return linuxPath;
    } catch (err) {
      console.warn('[OmniCast Stream] Error desempaquetando binario Linux FFmpeg:', err.message);
    }
  }
  return null;
}

function getFfmpegPath() {
  if (process.platform === 'win32') {
    const winPath = path.join(__dirname, 'bin', 'ffmpeg', 'ffmpeg.exe');
    if (fs.existsSync(winPath)) return winPath;
    try {
      const check = spawnSync('where', ['ffmpeg']);
      if (check.status === 0) return 'ffmpeg';
    } catch (e) {}
    return 'ffmpeg';
  }

  // Non-Windows: Linux, Docker, Railway, Render, VPS, macOS
  // NEVER execute a Windows .exe binary on Linux (which triggers spawn EACCES error)

  // 1. Check system PATH first via 'which ffmpeg'
  try {
    const check = spawnSync('which', ['ffmpeg']);
    if (check.status === 0) {
      const detected = (check.stdout ? check.stdout.toString().trim() : '') || 'ffmpeg';
      return detected;
    }
  } catch (e) {}

  // 2. Check standard Linux/Unix installation locations
  const commonLinuxPaths = [
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/bin/ffmpeg',
    '/root/.nix-profile/bin/ffmpeg',
    '/nix/var/nix/profiles/default/bin/ffmpeg'
  ];
  for (const p of commonLinuxPaths) {
    if (fs.existsSync(p)) {
      try {
        const testRes = spawnSync(p, ['-version']);
        if (testRes.status === 0) return p;
      } catch (e) {}
    }
  }

  // 3. Auto-unpack and use bundled standalone static Linux binary
  const bundledLinux = ensureLinuxFfmpegBinary();
  if (bundledLinux) {
    return bundledLinux;
  }

  return 'ffmpeg';
}

let cachedHasFfmpeg = null;
function hasFfmpeg() {
  if (cachedHasFfmpeg === true) return true;
  const p = getFfmpegPath();
  try {
    const res = spawnSync(p, ['-version']);
    if (res && res.status === 0) {
      cachedHasFfmpeg = true;
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

function getStandbyJpegBuffer() {
  if (standbyJpegBuffer && standbyJpegBuffer.length > 100) return standbyJpegBuffer;
  try {
    const ffmpegPath = getFfmpegPath();
    if (hasFfmpeg()) {
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
        let buf = res.stdout;
        if (buf[buf.length - 2] !== 0xFF || buf[buf.length - 1] !== 0xD9) {
          buf = Buffer.concat([buf, Buffer.from([0xFF, 0xD9])]);
        }
        standbyJpegBuffer = buf;
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
  if (process.platform !== 'win32') return null;
  try {
    const ffmpegPath = getFfmpegPath();
    if (hasFfmpeg()) {
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

let activeTlsRelays = [];

function createLocalTlsRtmpRelay(targetUrl) {
  return new Promise((resolve) => {
    try {
      if (!targetUrl || !targetUrl.startsWith('rtmps://')) {
        return resolve({ url: targetUrl, close: () => {} });
      }

      // Parse rtmps://hostname:port/app/key
      const raw = targetUrl.replace(/^rtmps:\/\//, '');
      const slashIdx = raw.indexOf('/');
      const hostPart = slashIdx !== -1 ? raw.substring(0, slashIdx) : raw;
      const pathPart = slashIdx !== -1 ? raw.substring(slashIdx) : '';

      const colonIdx = hostPart.indexOf(':');
      const remoteHost = colonIdx !== -1 ? hostPart.substring(0, colonIdx) : hostPart;
      const remotePort = colonIdx !== -1 ? parseInt(hostPart.substring(colonIdx + 1), 10) : 443;

      const activeSockets = new Set();
      let currentClient = null;
      let tlsSocket = null;
      let tlsReady = false;
      const earlyChunks = [];

      function getOrConnectTls() {
        if (tlsSocket && !tlsSocket.destroyed && tlsReady) return tlsSocket;
        tlsReady = false;
        tlsSocket = tls.connect({
          host: remoteHost,
          port: remotePort,
          servername: remoteHost,
          rejectUnauthorized: false
        }, () => {
          tlsReady = true;
          addFfmpegLog(`[TLS Relay ${remoteHost}] Connected securely`);
          if (currentClient && !currentClient.destroyed) {
            for (const c of earlyChunks) {
              tlsSocket.write(c);
            }
            earlyChunks.length = 0;
            currentClient.pipe(tlsSocket);
            tlsSocket.pipe(currentClient);
          }
        });

        activeSockets.add(tlsSocket);

        tlsSocket.on('error', (err) => {
          addFfmpegLog(`[TLS Relay ${remoteHost}] Socket error: ${err.message}`);
          tlsReady = false;
          if (currentClient && !currentClient.destroyed) {
            try { currentClient.destroy(); } catch (e) {}
          }
        });

        tlsSocket.on('close', () => {
          activeSockets.delete(tlsSocket);
          tlsReady = false;
          if (currentClient && !currentClient.destroyed) {
            try { currentClient.destroy(); } catch (e) {}
          }
        });

        return tlsSocket;
      }

      // Pre-connect immediately so DNS and TLS handshake are completed before FFmpeg spawns
      getOrConnectTls();

      const server = net.createServer((clientSocket) => {
        currentClient = clientSocket;
        activeSockets.add(clientSocket);

        clientSocket.on('data', (chunk) => {
          if (!tlsReady) {
            earlyChunks.push(chunk);
          }
        });

        if (tlsReady && tlsSocket && !tlsSocket.destroyed) {
          clientSocket.pipe(tlsSocket);
          tlsSocket.pipe(clientSocket);
        } else {
          getOrConnectTls();
        }

        clientSocket.on('error', (err) => {
          addFfmpegLog(`[TLS Relay ${remoteHost}] Client error: ${err.message}`);
          if (tlsSocket && !tlsSocket.destroyed) {
            try { tlsSocket.destroy(); } catch (e) {}
          }
        });

        clientSocket.on('close', () => {
          activeSockets.delete(clientSocket);
          if (tlsSocket && !tlsSocket.destroyed) {
            try { tlsSocket.destroy(); } catch (e) {}
          }
        });
      });

      server.on('error', (err) => {
        addFfmpegLog(`[TLS Relay Server Error]: ${err.message}`);
        resolve({ url: targetUrl, close: () => {} });
      });

      server.listen(0, '127.0.0.1', () => {
        const localPort = server.address().port;
        const localUrl = `rtmp://127.0.0.1:${localPort}${pathPart}`;
        console.log(`[OmniCast Stream] Local TLS Bridge active: 127.0.0.1:${localPort} -> ${remoteHost}:${remotePort}`);
        addFfmpegLog(`[TLS Bridge] Active on 127.0.0.1:${localPort} -> ${remoteHost}:${remotePort}`);
        resolve({
          url: localUrl,
          close: () => {
            for (const s of activeSockets) {
              try { s.destroy(); } catch (e) {}
            }
            try { server.close(); } catch (e) {}
          }
        });
      });
    } catch (err) {
      resolve({ url: targetUrl, close: () => {} });
    }
  });
}

function stopFfmpegStream(notifyClient = true) {
  if (activeTlsRelays && activeTlsRelays.length > 0) {
    for (const r of activeTlsRelays) {
      try { r.close(); } catch (e) {}
    }
    activeTlsRelays = [];
  }
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
  // If key is empty or matches dummy test keys or expired session keys, check OBS profile or persistentDb for real key
  const isDummyOrExpired = !trimmed || 
    trimmed === 'FB-10243398655477601-0-Ab7vOtOaRuRCvYfxN4R6KnuS' ||
    trimmed === 'FB-1049284729184712-live' ||
    trimmed.startsWith('fb-test-key');
  if (isDummyOrExpired) {
    try {
      const obsProfilePath = path.join(process.env.APPDATA || '', 'obs-studio', 'basic', 'profiles', 'OPEN', 'service.json');
      if (fs.existsSync(obsProfilePath)) {
        const obsSvc = JSON.parse(fs.readFileSync(obsProfilePath, 'utf8'));
        if (obsSvc && obsSvc.settings && obsSvc.settings.key && obsSvc.settings.key.trim().startsWith('FB-')) {
          return obsSvc.settings.key.trim();
        }
      }
    } catch (e) {}
    try {
      if (persistentDb && persistentDb.streamingConfig && persistentDb.streamingConfig.facebook && persistentDb.streamingConfig.facebook.key) {
        const dbKey = persistentDb.streamingConfig.facebook.key.trim();
        if (dbKey && dbKey.startsWith('FB-') && !dbKey.startsWith('fb-test-key')) {
          return dbKey;
        }
      }
    } catch (e) {}
    return 'FB-10243400060152717-0-Ab729pizCDn_CdsWUvW9yDBZ';
  }
  return trimmed;
}

function resolveLatestYouTubeKey(rawKey) {
  const trimmed = (rawKey || '').trim();
  const isDummy = !trimmed || trimmed.startsWith('yt-test-key') || trimmed === 'yt-live-9382-7712-4412-omni';
  if (isDummy) {
    try {
      if (persistentDb && persistentDb.streamingConfig && persistentDb.streamingConfig.youtube && persistentDb.streamingConfig.youtube.key) {
        const dbKey = persistentDb.streamingConfig.youtube.key.trim();
        if (dbKey && !dbKey.startsWith('yt-test-key') && dbKey !== 'yt-live-9382-7712-4412-omni') {
          return dbKey;
        }
      }
    } catch (e) {}
    return '';
  }
  return trimmed;
}

let isStartingFfmpegStream = false;

async function startFfmpegStream(dest, activeWs) {
  if (isStartingFfmpegStream) {
    console.log('[FFmpeg RTMP] Stream start already in progress, ignoring duplicate start call');
    return { success: true, pending: true };
  }
  isStartingFfmpegStream = true;
  try {
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
  if (fb.enabled && resolvedFbKey && resolvedFbKey !== 'FB-1049284729184712-live' && !resolvedFbKey.startsWith('fb-test-key')) {
    // Use OBS Studio's exact RTMPS endpoint for Facebook Live
    let rawUrl = (fb.url || 'rtmps://rtmp-api.facebook.com:443/rtmp/').trim();
    if (rawUrl.includes('live-api-s.facebook.com')) {
      rawUrl = 'rtmps://rtmp-api.facebook.com:443/rtmp/';
    }
    const targetUrl = rawUrl.endsWith('/') ? `${rawUrl}${resolvedFbKey}` : `${rawUrl}/${resolvedFbKey}`;
    targets.push({ name: 'Facebook Live', url: targetUrl });
  }

  const resolvedYtKey = dest.localTest ? null : resolveLatestYouTubeKey(yt.key);
  if (!dest.localTest && yt.enabled && resolvedYtKey) {
    const rawUrl = (yt.url || 'rtmp://a.rtmp.youtube.com/live2').trim();
    const targetUrl = rawUrl.endsWith('/') ? `${rawUrl}${resolvedYtKey}` : `${rawUrl}/${resolvedYtKey}`;
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

  // Wrap any RTMPS targets in native Node.js TLS bridges to guarantee 100% stable connection on any OS/container
  const preparedTargets = [];
  for (const t of targets) {
    if (t.url.startsWith('rtmps://')) {
      const relay = await createLocalTlsRtmpRelay(t.url);
      activeTlsRelays.push(relay);
      preparedTargets.push({ name: t.name, url: relay.url });
    } else {
      preparedTargets.push(t);
    }
  }

  const ffmpegPath = getFfmpegPath();
  if (!hasFfmpeg()) {
    const err = 'Binario FFmpeg no disponible en este servidor.';
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
    '-probesize', '262144',
    '-analyzeduration', '200000',
    '-thread_queue_size', '4096',
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-framerate', '30',
    '-i', 'pipe:0',
    '-probesize', '65536',
    '-analyzeduration', '200000',
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
    '-threads', '2',
    '-profile:v', 'main',
    '-b:v', '3000k',
    '-minrate', '3000k',
    '-maxrate', '3000k',
    '-bufsize', '3000k',
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

  if (preparedTargets.length === 1) {
    ffmpegArgs.push('-f', 'flv', preparedTargets[0].url);
  } else {
    const teeTargets = preparedTargets.map(t => `[f=flv:onfail=ignore]${t.url}`).join('|');
    ffmpegArgs.push('-f', 'tee', teeTargets);
  }

  activeTargetNames = preparedTargets.map(t => t.name);
  console.log(`[FFmpeg RTMP] Spawning OBS-grade 30fps pipeline for: ${activeTargetNames.join(' & ')}`);
  addFfmpegLog(`[FFmpeg RTMP] Spawning pipeline for targets: ${activeTargetNames.join(', ')}`);
  const proc = spawn(ffmpegPath, ffmpegArgs, { stdio: ['pipe', 'ignore', 'pipe', 'pipe'] });
  activeFfmpegProcess = proc;
  streamHasValidHeader = true;
  streamChunkCount = 0;

  liveStreamState.isStreaming = true;
  liveStreamState.startTime = Date.now();
  liveStreamState.destinations = dest;
  liveStreamState.stats = { fps: 30, bitrate: 3000, speed: '1x', totalBytes: 0, droppedFrames: 0, pcmPackets: 0, error: null };

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
    if (err.code !== 'EPIPE') {
      console.warn('[FFmpeg stdin error]:', err.message);
      addFfmpegLog(`[FFmpeg stdin error]: ${err.message}`);
    }
  });
  if (proc.stdio && proc.stdio[3]) {
    proc.stdio[3].on('error', (err) => {
      if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
        console.warn('[FFmpeg audio pipe error]:', err.message);
        addFfmpegLog(`[FFmpeg audio pipe error]: ${err.message}`);
      }
    });
  }

  proc.stderr.on('data', (data) => {
    const text = data.toString();
    const rawLines = text.split(/\r?\n/).filter(Boolean);
    for (const l of rawLines) {
      addFfmpegLog(l);
    }
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

    if (/all tee outputs failed/i.test(text)) {
      console.error('[FFmpeg RTMP Fatal]:', text.trim());
      const errMsg = 'Todos los destinos RTMP fallaron. Verifica tus claves en Ajustes > Destinos.';
      liveStreamState.stats.error = errMsg;
      if (activeWs && activeWs.readyState === WebSocket.OPEN) {
        activeWs.send(JSON.stringify({ type: 'error', message: errMsg }));
      }
      broadcastSSE('stream_error', { error: errMsg });
    } else if (/slave muxer #\d+ failed|error opening: i\/o error|handshake failed|connection refused|session has been invalidated/i.test(text)) {
      console.warn('[FFmpeg RTMP Warning]:', text.trim());
      let failedTarget = 'la plataforma';
      if (/youtube/i.test(text)) failedTarget = 'YouTube Live';
      else if (/facebook|rtmp-api\.facebook|fb/i.test(text)) failedTarget = 'Facebook Live';

      if (targets.length === 1) {
        const errMsg = `La plataforma (${failedTarget}) rechazó la conexión RTMP (clave caducada o no válida). Verifica tu clave en Ajustes > Destinos.`;
        liveStreamState.stats.error = errMsg;
        if (activeWs && activeWs.readyState === WebSocket.OPEN) {
          activeWs.send(JSON.stringify({ type: 'error', message: errMsg }));
        }
        broadcastSSE('stream_error', { error: errMsg });
      } else {
        const warnMsg = `⚠️ Advertencia: ${failedTarget} rechazó la clave RTMP, pero la transmisión continúa en el otro destino activo.`;
        if (activeWs && activeWs.readyState === WebSocket.OPEN) {
          activeWs.send(JSON.stringify({ type: 'warning', message: warnMsg }));
        }
        broadcastSSE('stream_warning', { warning: warnMsg });
      }
    }
  });

  proc.on('close', (code, signal) => {
    console.log(`[FFmpeg RTMP] Stream ended with exit code ${code}, signal: ${signal}`);
    addFfmpegLog(`[FFmpeg RTMP] Stream ended with exit code ${code}, signal: ${signal}`);
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

      if (activeTlsRelays && activeTlsRelays.length > 0) {
        for (const r of activeTlsRelays) {
          try { r.close(); } catch (e) {}
        }
        activeTlsRelays = [];
      }

      let detectedError = liveStreamState.stats.error;
      if (!detectedError && (code !== 0 || signal)) {
        const meaningfulLogs = recentFfmpegLogs
          .map(l => l.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, ''))
          .filter(l => !l.startsWith('[FFmpeg Frame]') && !l.includes('frame=') && !l.includes('speed=') && !l.includes('Stream ended') && !l.includes('EPIPE') && !l.includes('ECONNRESET'));
        const lastErr = meaningfulLogs.slice(-2).join(' | ');
        detectedError = lastErr || (signal ? `Proceso terminado por señal ${signal}` : `Servidor RTMP cerró la transmisión (código ${code})`);
      }

      const stopPayload = {
        type: 'stopped',
        code,
        signal,
        error: detectedError || null
      };
      if (activeWs && activeWs.readyState === WebSocket.OPEN) {
        activeWs.send(JSON.stringify(stopPayload));
      }
      broadcastSSE('stream_status', { isStreaming: false, code, signal, error: stopPayload.error });
    }
  });

  proc.on('error', (err) => {
    console.error('[FFmpeg RTMP Process Error]:', err);
    addFfmpegLog(`[FFmpeg RTMP Process Error]: ${err.message}`);
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
    let readyMsg = `Pipeline RTMP listo para ${activeTargetNames.join(' y ')}`;
    if (yt.enabled && !resolvedYtKey && activeTargetNames.includes('Facebook Live')) {
      readyMsg = 'Transmitiendo a Facebook Live (YouTube en espera de clave en Ajustes > Destinos)';
    }
    activeWs.send(JSON.stringify({
      type: 'ready',
      message: readyMsg,
      destinations: activeTargetNames
    }));
  }
  broadcastSSE('stream_status', { isStreaming: true, destinations: activeTargetNames });

  return { success: true, destinations: activeTargetNames };
  } finally {
    isStartingFfmpegStream = false;
  }
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

  const ffmpegPath = getFfmpegPath();
  if (!hasFfmpeg()) {
    return { error: 'Binario FFmpeg no disponible en este servidor.' };
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
const mobileCamReceiversMap = new Map(); // key: `${churchId}_${camId}` -> Set of ws

mobileCamWss.on('connection', (ws, request) => {
  const host = request.headers.host || 'localhost';
  const url = new URL(request.url, `http://${host}`);
  const role = url.searchParams.get('role') || 'receiver';
  const churchId = url.searchParams.get('church') || 'default';
  const camId = parseInt(url.searchParams.get('cam') || '1', 10);
  const camKey = `${churchId}_${camId}`;
  const camSt = getChurchCamState(churchId);

  if (role === 'receiver') {
    if (!mobileCamReceiversMap.has(camKey)) mobileCamReceiversMap.set(camKey, new Set());
    mobileCamReceiversMap.get(camKey).add(ws);
    ws.on('close', () => {
      const set = mobileCamReceiversMap.get(camKey);
      if (set) set.delete(ws);
    });
  } else if (role === 'sender') {
    ws.on('message', (data, isBinary) => {
      camSt.mobileCamLatestFrames[camId] = data;
      if (camSt.mobileCamsState[camId]) {
        camSt.mobileCamsState[camId].connected = true;
        camSt.mobileCamsState[camId].lastPing = Date.now();
      }
      const recs = mobileCamReceiversMap.get(camKey);
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

// =========================================================================
// OMNICAST TELESTRATOR & PREACHER TABLET: REAL-TIME VECTOR DRAWING RELAY (WS)
// =========================================================================
const padWss = new WebSocket.Server({ noServer: true });
const padRoomsMap = new Map(); // key: churchId -> Set of ws clients
const padStateMap = new Map(); // key: churchId -> { strokes: [], mode: 'telestrator', liveProjector: false, liveStream: false }

function getPadState(churchId) {
  if (!padStateMap.has(churchId)) {
    padStateMap.set(churchId, {
      strokes: [],
      mode: 'telestrator',
      liveProjector: false,
      liveStream: false
    });
  }
  return padStateMap.get(churchId);
}

padWss.on('connection', (ws, request) => {
  const host = request.headers.host || 'localhost';
  const url = new URL(request.url, `http://${host}`);
  const churchId = url.searchParams.get('church') || 'church-hebron';

  if (!padRoomsMap.has(churchId)) {
    padRoomsMap.set(churchId, new Set());
  }
  padRoomsMap.get(churchId).add(ws);

  const state = getPadState(churchId);
  try {
    ws.send(JSON.stringify({
      type: 'init',
      strokes: state.strokes,
      mode: state.mode,
      liveProjector: state.liveProjector,
      liveStream: state.liveStream,
      lastSlide: state.lastSlide || null
    }));
  } catch (e) {}

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      const cId = data.churchId || churchId;
      const room = padRoomsMap.get(cId);
      const cState = getPadState(cId);

      if (data.type === 'stroke_start') {
        if (data.stroke) {
          cState.strokes.push(data.stroke);
        }
      } else if (data.type === 'stroke_move') {
        const s = cState.strokes.find(st => st.id === data.strokeId);
        if (s && data.point) {
          s.points.push(data.point);
        }
      } else if (data.type === 'clear') {
        cState.strokes = [];
      } else if (data.type === 'undo') {
        cState.strokes.pop();
      } else if (data.type === 'mode') {
        cState.mode = data.mode || 'telestrator';
      } else if (data.type === 'toggle_projector') {
        cState.liveProjector = Boolean(data.enabled);
      } else if (data.type === 'toggle_stream') {
        cState.liveStream = Boolean(data.enabled);
      } else if (data.type === 'slide_sync') {
        cState.lastSlide = data;
      }

      if (room) {
        const jsonStr = JSON.stringify(data);
        for (const client of room) {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            try { client.send(jsonStr); } catch (e) {}
          }
        }
      }
    } catch (err) {
      console.error('[Pad WS] Error handling message:', err);
    }
  });

  ws.on('close', () => {
    const room = padRoomsMap.get(churchId);
    if (room) {
      room.delete(ws);
      if (room.size === 0) padRoomsMap.delete(churchId);
    }
  });

  ws.on('error', () => {
    const room = padRoomsMap.get(churchId);
    if (room) room.delete(ws);
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
    } else if (parsed.pathname === '/api/tv/ws') {
      tvStreamWss.handleUpgrade(request, socket, head, ws => {
        tvStreamWss.emit('connection', ws, request);
      });
    } else if (parsed.pathname === '/api/cam/ws') {
      mobileCamWss.handleUpgrade(request, socket, head, ws => {
        mobileCamWss.emit('connection', ws, request);
      });
    } else if (parsed.pathname === '/api/pad-ws') {
      padWss.handleUpgrade(request, socket, head, ws => {
        padWss.emit('connection', ws, request);
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
    console.log(`  🎬 Motor FFmpeg: ${hasFfmpeg() ? 'DISPONIBLE (' + getFfmpegPath() + ')' : 'NO DISPONIBLE'}`);
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
