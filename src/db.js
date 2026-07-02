import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WORKSPACE_DIR = path.resolve(__dirname, '..');
const STORAGE_DIR = path.join(WORKSPACE_DIR, 'storage');
const BACKUP_DIR = path.join(WORKSPACE_DIR, 'backup');

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
    autoBackup: true,
    speedCapacity: 50
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
  'logs.json': []
};

// Ensure directories exist
function ensureDirs() {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

// Find latest backup folder and try to restore corrupt files
function attemptRecovery(filename) {
  console.log(`[DB] Attempting recovery for corrupt file: ${filename}`);
  if (!fs.existsSync(BACKUP_DIR)) return false;

  const backups = fs.readdirSync(BACKUP_DIR)
    .filter(f => fs.statSync(path.join(BACKUP_DIR, f)).isDirectory())
    .sort((a, b) => b.localeCompare(a)); // Sort descending to get latest first

  for (const backupFolder of backups) {
    const backupFilePath = path.join(BACKUP_DIR, backupFolder, filename);
    if (fs.existsSync(backupFilePath)) {
      try {
        const content = fs.readFileSync(backupFilePath, 'utf8');
        JSON.parse(content); // validate JSON
        
        // Success: Copy backup file back to storage
        const destPath = path.join(STORAGE_DIR, filename);
        fs.writeFileSync(destPath, content, 'utf8');
        console.log(`[DB] Successfully recovered ${filename} from backup: ${backupFolder}`);
        
        // Log alert for recovery (we'll append it later to cache or write it)
        return true;
      } catch (err) {
        console.error(`[DB] Backup file ${backupFilePath} is also corrupt:`, err);
      }
    }
  }
  return false;
}

export function init() {
  ensureDirs();
  const recoveredFiles = [];

  for (const [filename, defaultValue] of Object.entries(DEFAULT_FILES)) {
    const filePath = path.join(STORAGE_DIR, filename);
    let loadedData = null;

    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        loadedData = JSON.parse(content);
      } catch (err) {
        console.error(`[DB] Error parsing ${filename}, file may be corrupt:`, err.message);
        const recovered = attemptRecovery(filename);
        if (recovered) {
          recoveredFiles.push(filename);
          try {
            loadedData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          } catch (e) {
            loadedData = null;
          }
        }
      }
    }

    if (loadedData === null) {
      console.log(`[DB] Initializing new ${filename} with default values.`);
      loadedData = JSON.parse(JSON.stringify(defaultValue));
      writeAtomicSync(filePath, loadedData);
    }

    cache[filename] = loadedData;
  }

  // If there are recovered files, log an alert
  if (recoveredFiles.length > 0) {
    addAlert('Storage Recovered', `Files recovered from backup: ${recoveredFiles.join(', ')}`);
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
  write('logs.json', logs);
}

// Create backup of all storage files
export function createBackup() {
  ensureDirs();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFolder = path.join(BACKUP_DIR, `backup_${timestamp}`);
  fs.mkdirSync(backupFolder, { recursive: true });

  for (const filename of Object.keys(DEFAULT_FILES)) {
    const srcPath = path.join(STORAGE_DIR, filename);
    const destPath = path.join(backupFolder, filename);
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
  console.log(`[DB] Backup created at: ${backupFolder}`);
  addLog('Backup Created', `Storage backup folder: backup_${timestamp}`);

  // Rotate backups: Keep at most 30 backup folders
  try {
    const backups = fs.readdirSync(BACKUP_DIR)
      .map(name => ({ name, path: path.join(BACKUP_DIR, name) }))
      .filter(item => fs.statSync(item.path).isDirectory() && item.name.startsWith('backup_'))
      .sort((a, b) => a.name.localeCompare(b.name)); // oldest first

    while (backups.length > 30) {
      const oldest = backups.shift();
      fs.rmSync(oldest.path, { recursive: true, force: true });
      console.log(`[DB] Removed oldest backup: ${oldest.name}`);
    }
  } catch (err) {
    console.error('[DB] Error rotating backups:', err);
  }
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


