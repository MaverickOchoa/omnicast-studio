/**
 * OMNICAST STUDIO — CLOUDFLARE PUBLIC TUNNEL ENGINE
 * Conecta tu servidor local a la nube global de Cloudflare con HTTPS y WebSockets gratuitos.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT_DIR = __dirname;
const BIN_DIR = path.join(ROOT_DIR, 'bin');
const CLOUDFLARED_EXE = path.join(BIN_DIR, 'cloudflared.exe');
const TUNNEL_DATA_FILE = path.join(ROOT_DIR, 'data', 'public_tunnel.json');
const LOCAL_PORT = process.env.PORT || 3000;

if (!fs.existsSync(CLOUDFLARED_EXE)) {
  console.error('[Cloudflare Tunnel] Error: no se encontró cloudflared.exe en ' + CLOUDFLARED_EXE);
  process.exit(1);
}

console.log('========================================================');
console.log('   ☁️ OMNICAST STUDIO — INICIANDO TÚNEL CLOUDFLARE      ');
console.log('========================================================\n');
console.log('  ► Conectando localhost:' + LOCAL_PORT + ' a la red global de Cloudflare...');

// Ensure previous tunnel file is cleared
try {
  if (fs.existsSync(TUNNEL_DATA_FILE)) {
    fs.unlinkSync(TUNNEL_DATA_FILE);
  }
} catch (e) {}

const tunnelProc = spawn(CLOUDFLARED_EXE, [
  'tunnel',
  '--url', `http://localhost:${LOCAL_PORT}`,
  '--protocol', 'quic',
  '--no-autoupdate'
], {
  windowsHide: true
});

let publicTunnelUrl = null;
let urlFound = false;

function saveTunnelState(url, active) {
  try {
    const payload = {
      url: url || '',
      active: Boolean(active),
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(TUNNEL_DATA_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {}
}

function printDashboard(url) {
  console.log('\n========================================================');
  console.log('   🎉 ¡TÚNEL PÚBLICO CLOUDFLARE ACTIVO Y SEGURO!        ');
  console.log('========================================================\n');
  console.log(`  🌐 ENLACE PRINCIPAL (Cualquier Computadora o Celular):`);
  console.log(`     ${url}\n`);
  console.log(`  📱 CONTROL REMOTO (Pastores / Diáconos / Celular):`);
  console.log(`     ${url}/remote.html\n`);
  console.log(`  🎵 MONITOR DE ESCENARIO (Músicos y Vocalistas):`);
  console.log(`     ${url}/stage.html\n`);
  console.log(`  📺 SMART TV SALAS (Cuneros, Lobby, Cartelera):`);
  console.log(`     ${url}/tv.html?room=Cuneros&mode=service\n`);
  console.log(`  📹 CÁMARAS MÓVILES (Conexión WebRTC con HTTPS Oficial):`);
  console.log(`     ${url}/cam.html?id=1\n`);
  console.log('========================================================');
  console.log('  Presiona Ctrl + C en esta ventana para cerrar el túnel.\n');
}

function notifyLocalServer(url) {
  try {
    const req = http.request({
      hostname: 'localhost',
      port: LOCAL_PORT,
      path: '/api/tunnel/register',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    req.on('error', () => {});
    req.write(JSON.stringify({ url: url, active: true }));
    req.end();
  } catch (e) {}
}

function handleOutput(data) {
  const text = data.toString();
  // Match standard trycloudflare.com regex
  const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/i);
  if (match && !urlFound) {
    urlFound = true;
    publicTunnelUrl = match[0].trim();
    saveTunnelState(publicTunnelUrl, true);
    notifyLocalServer(publicTunnelUrl);
    printDashboard(publicTunnelUrl);
  }
}

tunnelProc.stdout.on('data', handleOutput);
tunnelProc.stderr.on('data', handleOutput);

tunnelProc.on('error', (err) => {
  console.error('[Cloudflare Tunnel] Error en el proceso:', err.message);
  saveTunnelState('', false);
});

tunnelProc.on('exit', (code) => {
  console.log(`\n[Cloudflare Tunnel] Túnel finalizado (código ${code})`);
  saveTunnelState('', false);
  try {
    const req = http.request({
      hostname: 'localhost',
      port: LOCAL_PORT,
      path: '/api/tunnel/register',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    req.on('error', () => {});
    req.write(JSON.stringify({ url: '', active: false }));
    req.end();
  } catch (e) {}
});

function cleanup() {
  saveTunnelState('', false);
  try { tunnelProc.kill(); } catch (e) {}
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', () => saveTunnelState('', false));
