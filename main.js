const { app, BrowserWindow, globalShortcut, screen } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

let mainWin;
let minimapWin;

const CONFIG_PATH = path.join(app.getPath('userData'), 'opex-settings-v2.json');

const GSI_CFG_CONTENT = `"OPEX META Integration"
{
    "uri"           "http://127.0.0.1:4000/gsi"
    "timeout"       "5.0"
    "buffer"        "0.1"
    "throttle"      "0.2"
    "heartbeat"     "5.0"
    "data"
    {
        "map"       "1"
        "player"    "1"
        "hero"      "1"
        "abilities" "1"
        "items"     "1"
    }
}
`;

// Авторасчёт точной геометрии миникарты Dota 2 под текущее разрешение экрана
function calcAutoMinimapBounds(preset = 'normal') {
  const { width, height } = screen.getPrimaryDisplay().bounds;
  // В Dota 2 обычная миникарта ~24.2% высоты экрана, увеличенная ~27.8%
  const ratio = preset === 'large' ? 0.278 : 0.242;
  const size = Math.round(height * ratio);
  const x = preset === 'right' ? (width - size) : 0;
  const y = height - size;
  return { miniX: x, miniY: y, miniSize: size, preset };
}

function loadSavedSettings() {
  const defaults = { ...calcAutoMinimapBounds('normal'), calibrate: false };
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return { ...defaults, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
    }
  } catch (_) {}
  return defaults;
}

function saveSettings(cfg) {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8'); } catch (_) {}
}

function autoInstallGsiConfig() {
  const candidateRoots = [
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam',
    'C:\\Steam',
    'D:\\Steam',
    'D:\\SteamLibrary',
    'E:\\Steam',
    'E:\\SteamLibrary',
    'F:\\SteamLibrary'
  ];

  const vdfCandidates = [
    'C:\\Program Files (x86)\\Steam\\steamapps\\libraryfolders.vdf',
    'C:\\Program Files\\Steam\\steamapps\\libraryfolders.vdf',
    'D:\\Steam\\steamapps\\libraryfolders.vdf'
  ];
  vdfCandidates.forEach(vdfPath => {
    try {
      if (fs.existsSync(vdfPath)) {
        const text = fs.readFileSync(vdfPath, 'utf8');
        for (const m of text.matchAll(/"path"\s+"([^"]+)"/g)) {
          const libPath = m[1].replace(/\\\\/g, '\\');
          if (!candidateRoots.includes(libPath)) candidateRoots.push(libPath);
        }
      }
    } catch (_) {}
  });

  for (const root of candidateRoots) {
    const dotaCfgDir = path.join(root, 'steamapps', 'common', 'dota 2 beta', 'game', 'dota', 'cfg');
    if (fs.existsSync(dotaCfgDir)) {
      try {
        const gsiDir = path.join(dotaCfgDir, 'gamestate_integration');
        if (!fs.existsSync(gsiDir)) fs.mkdirSync(gsiDir, { recursive: true });
        const targetFile = path.join(gsiDir, 'gamestate_integration_opexmeta.cfg');
        fs.writeFileSync(targetFile, GSI_CFG_CONTENT, 'utf8');
        return { installed: true, path: targetFile };
      } catch (e) {
        return { installed: false, error: e.message };
      }
    }
  }
  return { installed: false, error: 'Папка Dota 2 не найдена автоматически' };
}

// Подсчёт всех вардов во всех слотах и рюкзаке
function countWards(itemsObj) {
  let obs = 0, sen = 0, disp = 0;
  if (!itemsObj) return { obs, sen, disp, total: 0 };
  Object.entries(itemsObj).forEach(([slotKey, slot]) => {
    if (!slot || !slot.name) return;
    // Считаем только инвентарь и рюкзак (игнорируем стэш)
    if (!slotKey.startsWith('slot') && !slotKey.startsWith('backpack')) return;
    const ch = typeof slot.charges === 'number' ? slot.charges : 1;
    if (slot.name === 'item_ward_observer') obs += ch;
    else if (slot.name === 'item_ward_sentry') sen += ch;
    else if (slot.name === 'item_ward_dispenser') disp += ch;
  });
  return { obs, sen, disp, total: obs + sen + disp };
}

function parseTeam(data, fallback) {
  const raw = (data.player?.team_name || data.hero?.team_name || '').toLowerCase();
  if (raw.includes('dire')) return 'dire';
  if (raw.includes('radiant')) return 'radiant';
  return fallback;
}

let gsiInstallInfo = { installed: false, path: '' };
let miniCfg = { miniX: 0, miniY: 800, miniSize: 260, preset: 'normal', calibrate: false };
let prevWardCounts = null;
let placedWards = []; // { id, type, xpos, ypos, placedAt, expiresAt }

let latestState = {
  connected: false,
  last_packet_ts: 0,
  clock_time: 0,
  game_state: 'NONE',
  team: 'radiant',
  team_override: null,
  hero: null,
  alive: true,
  hp_pct: 100,
  mana_pct: 100,
  gold: 0,
  last_hits: 0,
  has_observer: false,
  has_sentry: false,
  ward_counts: { obs: 0, sen: 0, disp: 0, total: 0 },
  xpos: null,
  ypos: null,
  role: 'auto',
  show_wards: true,
  show_farm: true,
  show_path: true,
  calibrate: false,
  gsi_installed: false,
  gsi_path: ''
};

function applyMiniBounds() {
  if (!minimapWin) return;
  minimapWin.setBounds({
    x: miniCfg.miniX,
    y: miniCfg.miniY,
    width: miniCfg.miniSize,
    height: miniCfg.miniSize
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method === 'POST' && req.url === '/gsi') {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const clock = data.map?.clock_time ?? latestState.clock_time;
        const xpos = typeof data.hero?.xpos === 'number' ? data.hero.xpos : latestState.xpos;
        const ypos = typeof data.hero?.ypos === 'number' ? data.hero.ypos : latestState.ypos;
        const alive = data.hero?.alive !== false;
        const counts = countWards(data.items);

        // Если начался новый матч — сбрасываем старые поставленные варды
        if (clock < latestState.clock_time - 30) {
          placedWards = [];
          prevWardCounts = null;
        }

        // Детект установки варда: количество вардов уменьшилось, герой жив и не на фонтане
        if (prevWardCounts && alive && typeof xpos === 'number' && typeof ypos === 'number') {
          const nearFountain = (xpos < -6200 && ypos < -5800) || (xpos > 6200 && ypos > 5800);
          if (!nearFountain && counts.total < prevWardCounts.total) {
            let wardType = 'obs';
            if (counts.sen < prevWardCounts.sen && counts.obs >= prevWardCounts.obs) wardType = 'sen';
            const duration = wardType === 'obs' ? 360 : 420;
            placedWards.push({
              id: Date.now() + '_' + Math.random().toString(36).slice(2, 6),
              type: wardType,
              xpos,
              ypos,
              placedAt: clock,
              expiresAt: clock + duration
            });
          }
        }
        prevWardCounts = counts;

        // Удаляем истёкшие варды
        placedWards = placedWards.filter(w => clock < w.expiresAt);

        latestState = {
          ...latestState,
          connected: true,
          last_packet_ts: Date.now(),
          clock_time: clock,
          game_state: data.map?.game_state ?? 'NONE',
          team: parseTeam(data, latestState.team),
          hero: data.hero?.name || null,
          alive,
          hp_pct: data.hero?.health_percent ?? 100,
          mana_pct: data.hero?.mana_percent ?? 100,
          gold: data.player?.gold ?? 0,
          last_hits: data.player?.last_hits ?? 0,
          ward_counts: counts,
          has_observer: counts.obs > 0 || counts.disp > 0,
          has_sentry: counts.sen > 0 || counts.disp > 0,
          xpos,
          ypos
        };
      } catch (_) {}
      res.writeHead(200);
      res.end('ok');
    });
  } else if (req.method === 'POST' && req.url === '/control') {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        const p = JSON.parse(body);
        if (p.role) latestState.role = p.role;
        if ('team_override' in p) latestState.team_override = p.team_override;
        if ('show_wards' in p) latestState.show_wards = Boolean(p.show_wards);
        if ('show_farm' in p) latestState.show_farm = Boolean(p.show_farm);
        if ('show_path' in p) latestState.show_path = Boolean(p.show_path);
        if (p.clear_wards) placedWards = [];
        if ('calibrate' in p) {
          latestState.calibrate = Boolean(p.calibrate);
          miniCfg.calibrate = Boolean(p.calibrate);
          saveSettings(miniCfg);
        }
        if (p.autoPreset) {
          miniCfg = { ...miniCfg, ...calcAutoMinimapBounds(p.autoPreset) };
          saveSettings(miniCfg);
          applyMiniBounds();
        }
        if (typeof p.miniX === 'number' || typeof p.miniY === 'number' || typeof p.miniSize === 'number') {
          if (typeof p.miniX === 'number') miniCfg.miniX = Math.round(p.miniX);
          if (typeof p.miniY === 'number') miniCfg.miniY = Math.round(p.miniY);
          if (typeof p.miniSize === 'number') miniCfg.miniSize = Math.round(p.miniSize);
          saveSettings(miniCfg);
          applyMiniBounds();
        }
      } catch (_) {}
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, miniCfg }));
    });
  } else if (req.method === 'POST' && req.url === '/reinstall-cfg') {
    gsiInstallInfo = autoInstallGsiConfig();
    latestState.gsi_installed = gsiInstallInfo.installed;
    latestState.gsi_path = gsiInstallInfo.path || gsiInstallInfo.error || '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(gsiInstallInfo));
  } else if (req.method === 'GET' && req.url === '/state') {
    const isAlive = latestState.last_packet_ts > 0 && (Date.now() - latestState.last_packet_ts) < 12000;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ...latestState,
      connected: isAlive,
      effective_team: latestState.team_override || latestState.team,
      placed_wards: placedWards,
      miniCfg
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(4000, '127.0.0.1');

function createWindows() {
  gsiInstallInfo = autoInstallGsiConfig();
  latestState.gsi_installed = gsiInstallInfo.installed;
  latestState.gsi_path = gsiInstallInfo.path || gsiInstallInfo.error || '';

  miniCfg = loadSavedSettings();
  latestState.calibrate = Boolean(miniCfg.calibrate);

  // Большой удобный HUD
  mainWin = new BrowserWindow({
    width: 520,
    height: 760,
    x: 24,
    y: 28,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  mainWin.setAlwaysOnTop(true, 'screen-saver');
  mainWin.loadFile('overlay.html');

  minimapWin = new BrowserWindow({
    width: miniCfg.miniSize,
    height: miniCfg.miniSize,
    x: miniCfg.miniX,
    y: miniCfg.miniY,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  minimapWin.setAlwaysOnTop(true, 'screen-saver');
  minimapWin.setIgnoreMouseEvents(true, { forward: true });
  minimapWin.loadFile('minimap-hud.html');
}

app.whenReady().then(() => {
  createWindows();
  globalShortcut.register('Control+Shift+O', () => {
    if (mainWin) mainWin.isVisible() ? mainWin.hide() : mainWin.show();
  });
  globalShortcut.register('Control+Shift+M', () => {
    if (minimapWin) minimapWin.isVisible() ? minimapWin.hide() : minimapWin.show();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
