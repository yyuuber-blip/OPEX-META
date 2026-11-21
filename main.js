const { app, BrowserWindow, globalShortcut, screen } = require('electron');
const http = require('http');

let mainWin;
let minimapWin;

let latestState = {
  connected: false,
  clock_time: 0,
  game_state: 'NONE',
  team: 'radiant',
  hero: null,
  hp_pct: 100,
  mana_pct: 100,
  gold: 0,
  has_observer: false,
  has_sentry: false,
  xpos: null,
  ypos: null,
  role: 'Carry'
};

function hasItem(itemsObj, targetNames) {
  if (!itemsObj) return false;
  return Object.values(itemsObj).some(slot => slot && targetNames.includes(slot.name));
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
          clock_time: data.map?.clock_time ?? 0,
          game_state: data.map?.game_state ?? 'NONE',
          team: data.player?.team_name || 'radiant',
          hero: data.hero?.name || null,
          hp_pct: data.hero?.health_percent ?? 100,
          mana_pct: data.hero?.mana_percent ?? 100,
          gold: data.player?.gold ?? 0,
          has_observer: hasItem(data.items, ['item_ward_observer', 'item_ward_dispenser']),
          has_sentry: hasItem(data.items, ['item_ward_sentry', 'item_ward_dispenser']),
          xpos: data.hero?.xpos ?? null,
          ypos: data.hero?.ypos ?? null
        };
      } catch (_) {}
      res.writeHead(200);
      res.end('ok');
    });
  } else if (req.method === 'POST' && req.url === '/role') {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        if (parsed.role) latestState.role = parsed.role;
      } catch (_) {}
      res.writeHead(200);
      res.end('ok');
    });
  } else if (req.method === 'GET' && req.url === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(latestState));
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(4000, '127.0.0.1');

function createWindows() {
  const { height } = screen.getPrimaryDisplay().workAreaSize;
  const miniSize = Math.round(height * 0.255);

  mainWin = new BrowserWindow({
    width: 440,
    height: 700,
    x: 24,
    y: 40,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  mainWin.setAlwaysOnTop(true, 'screen-saver');
  mainWin.loadFile('overlay.html');

  minimapWin = new BrowserWindow({
    width: miniSize,
    height: miniSize,
    x: 6,
    y: height - miniSize - 4,
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