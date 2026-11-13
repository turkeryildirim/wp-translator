import electron from 'electron';
const { app, BrowserWindow, Menu, Tray, shell } = electron;
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db/open.ts';
import { resolveDbPath } from '../src/db/path.ts';
import { createDatabaseBackup } from '../src/db/backup.ts';
import { startServer } from '../src/server/http.ts';

// Enforce single-instance lock: if another instance is already running,
// exit immediately so port 4173 and database are never contested.
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let server: Server | null = null;
let activeDb: Database.Database | null = null;
let activeDbPath = '';

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  }
});

function resolveAssetPath(relativePath: string): string {
  const baseDir = app.isPackaged
    ? app.getAppPath()
    : dirname(fileURLToPath(import.meta.url));

  const candidates = [
    join(baseDir, relativePath),
    join(baseDir, '..', relativePath),
    join(process.cwd(), relativePath),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
}

function initServer(): Promise<{ port: number; dbPath: string }> {
  return new Promise((resolve, reject) => {
    const dbPath = resolveDbPath({ preferLocal: false });
    const db = openDb(dbPath);
    activeDb = db;
    activeDbPath = dbPath;
    const defaultPort = Number(process.env.WPT_PORT ?? 4173);
    const panelDir = resolveAssetPath('dist/panel');

    const s = startServer({ db, port: defaultPort, panelDir });
    server = s;

    s.once('listening', () => {
      resolve({ port: defaultPort, dbPath });
    });

    s.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`[wp-translator] Port ${defaultPort} is busy, binding to dynamic port...`);
        const fallbackServer = startServer({ db, port: 0, panelDir });
        server = fallbackServer;
        fallbackServer.once('listening', () => {
          const addr = fallbackServer.address();
          const port = typeof addr === 'object' && addr ? addr.port : defaultPort;
          resolve({ port, dbPath });
        });
        fallbackServer.once('error', reject);
      } else {
        reject(err);
      }
    });
  });
}

function createMainWindow(port: number): BrowserWindow {
  const iconPath = resolveAssetPath('assets/icons/icon.png');

  const win = new BrowserWindow({
    title: 'WP Translator',
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 640,
    icon: existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
    show: false,
  });

  win.setMenuBarVisibility(false);
  win.loadURL(`http://127.0.0.1:${port}`);

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });

  return win;
}

function createTray(port: number, dbPath: string): Tray {
  const iconPath = resolveAssetPath('assets/icons/icon-16.png');
  const activeIconPath = resolveAssetPath('assets/icons/icon-16-active.png');
  const fallbackIcon = resolveAssetPath('assets/icons/icon.png');
  const defaultTrayIcon = existsSync(iconPath) ? iconPath : fallbackIcon;
  const activeTrayIcon = existsSync(activeIconPath) ? activeIconPath : defaultTrayIcon;

  const t = new Tray(defaultTrayIcon);
  t.setToolTip('WP Translator');

  // Animated tray icon when background tasks (queue worker / translation) are running
  let isBusy = false;
  let animTimer: ReturnType<typeof setInterval> | null = null;
  let animFrame = 0;

  const startAnimation = () => {
    if (animTimer) return;
    t.setToolTip('WP Translator (İşlem yapılıyor...)');
    animTimer = setInterval(() => {
      animFrame = (animFrame + 1) % 2;
      t.setImage(animFrame === 0 ? defaultTrayIcon : activeTrayIcon);
    }, 500);
  };

  const stopAnimation = () => {
    if (!animTimer) return;
    clearInterval(animTimer);
    animTimer = null;
    t.setImage(defaultTrayIcon);
    t.setToolTip('WP Translator');
  };

  const statusPoll = setInterval(async () => {
    if (isQuitting) {
      clearInterval(statusPoll);
      stopAnimation();
      return;
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/app-status`);
      if (res.ok) {
        const data = (await res.json()) as { busy: boolean };
        if (data.busy && !isBusy) {
          isBusy = true;
          startAnimation();
        } else if (!data.busy && isBusy) {
          isBusy = false;
          stopAnimation();
        }
      }
    } catch {}
  }, 1000);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'WP Translator Panelini Aç',
      click: () => {
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          if (!mainWindow.isVisible()) mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: `Tarayıcıda Aç (http://127.0.0.1:${port})`,
      click: () => {
        shell.openExternal(`http://127.0.0.1:${port}`);
      },
    },
    {
      label: 'Veritabanı Klasörünü Aç',
      click: () => {
        shell.showItemInFolder(dbPath);
      },
    },
    { type: 'separator' },
    {
      label: 'Çıkış',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  t.setContextMenu(contextMenu);

  t.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
      }
    }
  });

  return t;
}

app.whenReady().then(async () => {
  const { port, dbPath } = await initServer();
  mainWindow = createMainWindow(port);
  tray = createTray(port, dbPath);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow(port);
    } else if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

let isBackingUp = false;
let backupDone = false;

app.on('before-quit', async (event) => {
  isQuitting = true;
  if (backupDone) return;
  if (!activeDb || !activeDbPath) return;

  event.preventDefault();
  if (isBackingUp) return;
  isBackingUp = true;

  try {
    console.log('[wp-translator] Creating closing database backup (keeping last 7)...');
    await createDatabaseBackup(activeDb, activeDbPath, 7);
  } catch (err) {
    console.error('[wp-translator] Failed to create backup on exit:', err);
  } finally {
    backupDone = true;
    app.quit();
  }
});

app.on('will-quit', () => {
  try {
    server?.close();
  } catch {}
  try {
    activeDb?.close();
  } catch {}
});
