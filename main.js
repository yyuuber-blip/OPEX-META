const { app, BrowserWindow, globalShortcut, screen } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

let mainWin;
let minimapWin;

const CONFIG_PATH = path.join(app.getPath('userData'), 'opex-settings.json');

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

function loadSavedSettings() {
  const { height } = screen.getPrimaryDisplay().bounds;
  const defaultSize = Math.round(height * 0.255);
  const defaults = {
    miniX: 0,
    miniY: height - defaultSize,
    miniSize: defaultSize,
    calibrate: false
  };
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return { ...defaults, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
    }
  } catch (_) {}
  return defaults;
}

function saveSettings(cfg) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (_) {}
}

// Автопоиск всех библиотек Steam и установка GSI-конфига в Dota 2
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

  // Парсим libraryfolders.vdf, чтобы найти нестандартные диски Steam
  const vdfCandidates = [
    'C:\\Program Files (x86)\\Steam\\steamapps\\libraryfolders.vdf',
    'C:\\Program Files\\Steam\\steamapps\\libraryfolders.vdf',
    'D:\\Steam\\steamapps\\libraryfolders.vdf'
  ];
  vdfCandidates.forEach(vdfPath => {
    try {
      if (fs.existsSync(vdfPath)) {
        const text = fs.readFileSync(vdfPath, 'utf8');
        const matches = text.matchAll(/"path"\s+"([^"]+)"/g);
        for (const m of matches) {
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

let gsiInstallInfo = { installed: false, path: '' };
let miniCfg = { miniX: 0, miniY: 800, miniSize: 275, calibrate: false };

let latestState = {
  connected: false,
  last_packet_ts: 0,
  clock_time: 0,
  game_state: 'NONE',
  team: 'radiant',
  team_override: null,
  hero: null,
  hp_pct: 100,
  mana_pct: 100,
  gold: 0,
  last_hits: 0,
  has_observer: false,
  has_sentry: false,
  xpos: null,
  ypos: null,
  role: 'Carry',
  show_wards: true,
  show_farm: true,
  show_path: true,
  calibrate: false,
  gsi_installed: false,
  gsi_path: ''
};

function hasItem(itemsObj, targetNames) {
  if (!itemsObj) return false;
  return Object.values(itemsObj).some(slot => slot && targetNames.includes(slot.name));
}

function parseTeam(data) {
  const raw = (data.player?.team_name || data.hero?.team_name || '').toLowerCase();
  if (raw.includes('dire')) return 'dire';
  if (raw.includes('radiant')) return 'radiant';
  return latestState.team;
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'POST' && req.url === '/gsi') {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        latestState = {
          ...latestState,
          connected: true,
          last_packet_ts: Date.now(),
          clock_time: data.map?.clock_time ?? latestState.clock_time,
          game_state: data.map?.game_state ?? 'NONE',
          team: parseTeam(data),
          hero: data.hero?.name || null,
          hp_pct: data.hero?.health_percent ?? 100,
          mana_pct: data.hero?.mana_percent ?? 100,
          gold: data.player?.gold ?? 0,
          last_hits: data.player?.last_hits ?? 0,
          has_observer: hasItem(data.items, ['item_ward_observer', 'item_ward_dispenser']),
          has_sentry: hasItem(data.items, ['item_ward_sentry', 'item_ward_dispenser']),
          xpos: typeof data.hero?.xpos === 'number' ? data.hero.xpos : null,
          ypos: typeof data.hero?.ypos === 'number' ? data.hero.ypos : null
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
        if ('calibrate' in p) {
          latestState.calibrate = Boolean(p.calibrate);
          miniCfg.calibrate = Boolean(p.calibrate);
          saveSettings(miniCfg);
        }
        if (typeof p.miniX === 'number' || typeof p.miniY === 'number' || typeof p.miniSize === 'number') {
          if (typeof p.miniX === 'number') miniCfg.miniX = Math.round(p.miniX);
          if (typeof p.miniY === 'number') miniCfg.miniY = Math.round(p.miniY);
          if (typeof p.miniSize === 'number') miniCfg.miniSize = Math.round(p.miniSize);
          saveSettings(miniCfg);
          if (minimapWin) {
            minimapWin.setBounds({
              x: miniCfg.miniX,
              y: miniCfg.miniY,
              width: miniCfg.miniSize,
              height: miniCfg.miniSize
            });
          }
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

  mainWin = new BrowserWindow({
    width: 410,
    height: 670,
    x: 20,
    y: 36,
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
    if (!mainWin) return;
    mainWin.isVisible() ? mainWin.hide() : mainWin.show();
  });

  globalShortcut.register('Control+Shift+M', () => {
    if (!minimapWin) return;
    minimapWin.isVisible() ? minimapWin.hide() : minimapWin.show();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
