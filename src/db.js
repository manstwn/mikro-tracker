import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WORKSPACE_DIR = path.resolve(__dirname, '..');
const STORAGE_DIR = path.join(WORKSPACE_DIR, 'storage');

// Hard caps to prevent unbounded storage growth
const MAX_LOGS    = 500;
const MAX_ALERTS  = 200;
const MAX_TRAFFIC = 2880; // 24h at 30s intervals

// In-memory cache for fast reads and changed-only writes
const cache = {};

const DEFAULT_FILES = {
  'config.json': {
    secretKey: "thiskey219Kx",
    webhookInterval: 30,
    offlineTimeoutUser: 60,
    offlineTimeoutRouter: 300,
    historyRetention: 365,
    trafficRetention: 30,
    logRetention: 90,
    autoSave: true,
    autoBackup: false,
    speedCapacity: 50,
    notificationEnabled: false,
    notificationEndpoint: '',
    notificationHeaders: '{}',
    notificationUserOfflineTimeout: 2,
    notificationCooldown: 300,
    notifyOnUserOffline: true,
    notifyOnUserOnline: false,
    notifyOnRouterOffline: true,
    notifyOnRouterOnline: false,
    notifyOnWebhookLost: true,
    notificationMessageTemplate: 'User {username} offline since {day}, {date} {time} - please check connection'
  },
  'system.json': {
    mode: "RUNNING"
  },
  'router.json': {
    status: "offline",
    lastSeen: null,
    rx: 0,
    tx: 0,
    rxSpeed: 0,
    txSpeed: 0,
    name: "Router"
  },
  'users.json': {},
  'sessions.json': [],
  'traffic.json': [],
  'history.json': [],
  'alerts.json': [],
  'logs.json': [],
  'notifications.json': []
};

// Ensure storage directory exists
function ensureDirs() {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
}



export function init() {
  ensureDirs();

  for (const [filename, defaultValue] of Object.entries(DEFAULT_FILES)) {
    const filePath = path.join(STORAGE_DIR, filename);
    let loadedData = null;

    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        loadedData = JSON.parse(content);
      } catch (err) {
        console.error(`[DB] Error parsing ${filename}, resetting to default:`, err.message);
      }
    }

    if (loadedData === null) {
      console.log(`[DB] Initializing new ${filename} with default values.`);
      loadedData = JSON.parse(JSON.stringify(defaultValue));
      writeAtomicSync(filePath, loadedData);
    }

    cache[filename] = loadedData;
  }

  console.log('[DB] JSON database initialized and cached successfully.');
}

function writeAtomicSync(filePath, data) {
  const tempPath = filePath + '.tmp';
  const dataStr = JSON.stringify(data, null, 2);
  fs.writeFileSync(tempPath, dataStr, 'utf8');
  fs.renameSync(tempPath, filePath);
}

export function read(filename) {
  if (cache[filename] !== undefined) {
    return JSON.parse(JSON.stringify(cache[filename]));
  }
  const filePath = path.join(STORAGE_DIR, filename);
  if (fs.existsSync(filePath)) {
    try {
      cache[filename] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return JSON.parse(JSON.stringify(cache[filename]));
    } catch (err) {
      console.error(`[DB] Read error for ${filename}, returning default.`, err);
    }
  }
  // Fallback to default if somehow not in cache/storage
  cache[filename] = JSON.parse(JSON.stringify(DEFAULT_FILES[filename] || {}));
  return JSON.parse(JSON.stringify(cache[filename]));
}

export function write(filename, data) {
  const cachedStr = JSON.stringify(cache[filename]);
  const newStr = JSON.stringify(data);

  // Debounce: Only write if content actually changed
  if (cachedStr === newStr) {
    return;
  }

  cache[filename] = JSON.parse(newStr); // update deep-copy in cache
  const filePath = path.join(STORAGE_DIR, filename);

  try {
    writeAtomicSync(filePath, cache[filename]);
  } catch (err) {
    console.error(`[DB] Error writing ${filename} atomically:`, err);
  }
}

// Add alert helper
export function addAlert(type, message) {
  const alerts = read('alerts.json');
  const newAlert = {
    id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 5),
    time: new Date().toISOString(),
    type,
    message
  };
  alerts.unshift(newAlert); // Newest first
  // Cap alerts array to prevent unbounded growth
  if (alerts.length > MAX_ALERTS) alerts.length = MAX_ALERTS;
  write('alerts.json', alerts);
  addLog(type, message);
}

// Add log helper
export function addLog(event, details = '') {
  const logs = read('logs.json');
  const newLog = {
    time: new Date().toISOString(),
    event,
    details
  };
  logs.unshift(newLog);
  // Cap logs array to prevent unbounded growth
  if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
  write('logs.json', logs);
}



// Auto Cleanup retention data
export function runCleanup() {
  console.log('[DB] Running database retention cleanup...');
  const config = read('config.json');

  const historyRetentionMs = (config.historyRetention || 365) * 24 * 60 * 60 * 1000;
  const trafficRetentionMs = (config.trafficRetention || 30) * 24 * 60 * 60 * 1000;
  const logRetentionMs = (config.logRetention || 90) * 24 * 60 * 60 * 1000;

  const now = Date.now();

  // Cleanup history
  const history = read('history.json');
  const cleanHistory = history.filter(item => {
    const t = new Date(item.time).getTime();
    return now - t <= historyRetentionMs;
  });
  write('history.json', cleanHistory);

  // Cleanup traffic
  const traffic = read('traffic.json');
  const cleanTraffic = traffic.filter(item => {
    const t = new Date(item.time).getTime();
    return now - t <= trafficRetentionMs;
  });
  write('traffic.json', cleanTraffic);

  // Cleanup logs
  const logs = read('logs.json');
  const cleanLogs = logs.filter(item => {
    const t = new Date(item.time).getTime();
    return now - t <= logRetentionMs;
  });
  write('logs.json', cleanLogs);

  // Cleanup old completed sessions (keep last 5000, remove ones older than historyRetention)
  const sessions = read('sessions.json');
  const cleanSessions = sessions
    .filter(s => {
      if (!s.end) return true; // keep open sessions
      const t = new Date(s.end).getTime();
      return now - t <= historyRetentionMs;
    })
    .slice(-5000); // hard cap at 5000 entries
  write('sessions.json', cleanSessions);

  console.log('[DB] Cleanup complete.');
  addLog('Auto Cleanup', 'Completed retention database cleanup.');
}

// Add history event helper
export function addHistoryEvent(type, user = null, time = null) {
  const history = read('history.json');
  const newEvent = {
    time: time || new Date().toISOString(),
    type,
    ...(user ? { user } : {})
  };
  history.unshift(newEvent);
  write('history.json', history);
}

// Full Database Reset
export function resetDatabase() {
  console.log('[DB] Resetting all database tables to default...');
  for (const [filename, defaultValue] of Object.entries(DEFAULT_FILES)) {
    const filePath = path.join(STORAGE_DIR, filename);
    cache[filename] = JSON.parse(JSON.stringify(defaultValue));
    writeAtomicSync(filePath, cache[filename]);
  }
  addLog('Database Reset', 'All system settings and monitoring history were reset.');
  addAlert('Database Reset', 'The database has been fully reset to initial state.');
}


