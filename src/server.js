import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import * as db from './db.js';
import * as monitor from './monitor.js';
import * as auth from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_DIR = path.resolve(__dirname, '..');

// Initialize database
db.init();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

io.use(auth.socketAuthMiddleware);

const PORT = 2041;
const startTime = Date.now();

// Server internal metrics
let webhooksReceived = 0;
let webhooksIgnored = 0;
let invalidKeysReceived = 0;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Auth endpoints (public)
app.post('/api/auth/pin', (req, res) => {
  if (!auth.isPinEnabled()) {
    return res.json({ success: true });
  }

  const pin = String(req.body?.pin || '');
  if (!auth.verifyPin(pin)) {
    return res.status(401).json({ success: false, error: 'Invalid PIN' });
  }

  const token = auth.createSession();
  res.setHeader('Set-Cookie', auth.buildSessionCookie(token));
  res.json({ success: true });
});

app.get('/api/auth/check', (req, res) => {
  if (!auth.isPinEnabled()) {
    return res.json({ authenticated: true, pinRequired: false });
  }

  if (auth.isValidSession(auth.getSessionToken(req))) {
    return res.json({ authenticated: true, pinRequired: true });
  }

  res.status(401).json({ authenticated: false, pinRequired: true });
});

app.post('/api/auth/logout', (req, res) => {
  auth.destroySession(auth.getSessionToken(req));
  res.setHeader('Set-Cookie', auth.clearSessionCookie());
  res.json({ success: true });
});

// Protect dashboard, APIs, and static app assets when PIN is set
app.use(auth.authMiddleware);

// Public monitoring endpoints (no PIN — MikroTik / health checks)
app.get('/webhook/:id', (req, res) => {
  const result = monitor.handleWebhook(req.query);

  if (!result.authorized) {
    invalidKeysReceived++;
    webhooksIgnored++;
    return res.status(403).send('Forbidden: Invalid Key');
  }

  if (result.paused) {
    webhooksIgnored++;
    return res.send('System Paused');
  }

  if (result.success === false) {
    webhooksIgnored++;
    return res.status(400).send(`Bad Request: ${result.error}`);
  }

  webhooksReceived++;
  res.send('OK');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'UP',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    timestamp: new Date().toISOString()
  });
});

app.use(express.static(path.join(WORKSPACE_DIR, 'public')));

// Helpers to get all monitoring data for frontend
function getDashboardPayload() {
  const history = db.read('history.json');
  const alerts = db.read('alerts.json');
  const logs = db.read('logs.json');
  const traffic = db.read('traffic.json');
  const sessions = db.read('sessions.json');

  return {
    router: db.read('router.json'),
    system: db.read('system.json'),
    config: db.read('config.json'),
    users: db.read('users.json'),
    history: history.slice(0, 100), // Limit to 100 for performance
    alerts: alerts.slice(0, 100),
    logs: logs.slice(0, 100),
    traffic: traffic.slice(-120), // Last 120 datapoints (1 hour of 30s updates)
    sessions: sessions.slice().reverse().slice(0, 100) // 100 latest sessions
  };
}

// WebSocket broadcast callback setup
monitor.setBroadcastCallback(() => {
  io.emit('update', getDashboardPayload());
});

// 3. Metrics Endpoint
app.get('/metrics', (req, res) => {
  const history = db.read('history.json');
  res.json({
    uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
    webhooksReceived,
    webhooksIgnored,
    invalidKeysReceived,
    totalEvents: history.length,
    memoryUsage: process.memoryUsage(),
    cpuUsage: process.cpuUsage(),
    nodeVersion: process.version
  });
});

// 4. Router/System Status Endpoint
app.get('/status', (req, res) => {
  const router = db.read('router.json');
  const users = db.read('users.json');
  const system = db.read('system.json');

  const onlineUserCount = Object.values(users).filter(u => u.status === 'online').length;

  res.json({
    systemMode: system.mode,
    routerStatus: router.status,
    routerName: router.name || 'Router',
    lastSeen: router.lastSeen,
    onlineUsers: onlineUserCount
  });
});

// 4b. Full Dashboard Data Endpoint (used by frontend bootstrap)
app.get('/api/status', (req, res) => {
  res.json(getDashboardPayload());
});


// 5. Update settings configuration API
app.post('/api/settings', (req, res) => {
  const currentConfig = db.read('config.json');
  
  // Merge and validate new configs
  const updated = {
    ...currentConfig,
    ...req.body
  };

  // Type checks
  updated.webhookInterval = parseInt(updated.webhookInterval, 10) || 30;
  updated.offlineTimeoutUser = parseInt(updated.offlineTimeoutUser, 10) || 60;
  updated.offlineTimeoutRouter = parseInt(updated.offlineTimeoutRouter, 10) || 300;
  updated.historyRetention = parseInt(updated.historyRetention, 10) || 365;
  updated.trafficRetention = parseInt(updated.trafficRetention, 10) || 30;
  updated.logRetention = parseInt(updated.logRetention, 10) || 90;
  updated.autoSave = req.body.autoSave !== undefined ? !!req.body.autoSave : currentConfig.autoSave;
  updated.autoBackup = req.body.autoBackup !== undefined ? !!req.body.autoBackup : currentConfig.autoBackup;
  
  if (req.body.secretKey && typeof req.body.secretKey === 'string') {
    updated.secretKey = req.body.secretKey;
  }

  db.write('config.json', updated);
  db.addLog('Settings Updated', 'System configurations updated by user.');
  db.addAlert('System Configured', 'System configuration settings updated.');
  
  io.emit('update', getDashboardPayload());
  res.json({ success: true, config: updated });
});

// 6. Toggle system mode (RUNNING/PAUSE)
app.post('/api/system/mode', (req, res) => {
  const { mode } = req.body;
  if (mode !== 'RUNNING' && mode !== 'PAUSE') {
    return res.status(400).json({ success: false, error: 'Invalid mode' });
  }

  const system = db.read('system.json');
  const prevMode = system.mode;
  
  if (prevMode !== mode) {
    system.mode = mode;
    db.write('system.json', system);

    const alertType = mode === 'RUNNING' ? 'System Running' : 'System Pause';
    const logText = mode === 'RUNNING' ? 'System is RUNNING' : 'System is PAUSED';

    db.addAlert(alertType, `System execution status changed to ${mode}.`);
    db.addLog(logText, `System changed from ${prevMode} to ${mode}.`);

    io.emit('update', getDashboardPayload());
  }

  res.json({ success: true, mode });
});

// 7. Full reset all data
app.post('/api/system/reset', (req, res) => {
  db.resetDatabase();
  io.emit('update', getDashboardPayload());
  res.json({ success: true });
});


// Socket.IO Connections
io.on('connection', (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);
  socket.emit('update', getDashboardPayload());

  socket.on('disconnect', () => {
    console.log(`[Socket] Client disconnected: ${socket.id}`);
  });
});

// Scheduled Heartbeat: check for user and router timeout every 1 minute
const heartbeatInterval = setInterval(() => {
  try {
    monitor.checkHeartbeats();
  } catch (err) {
    console.error('[Cron] Error during heartbeat checks:', err);
  }
}, 60000);

// Scheduled Daily Operations: Backup & Cleanup every 24 hours
let lastDailyOps = Date.now();
const dailyInterval = setInterval(() => {
  const config = db.read('config.json');
  try {
    db.runCleanup();
    if (config.autoBackup) {
      db.createBackup();
    }
  } catch (err) {
    console.error('[Cron] Error during daily operations:', err);
  }
}, 3600000); // Check/Run checks hourly, but perform backups daily or just perform cleanup & backup hourly/daily

// Perform an initial backup and cleanup at startup
setTimeout(() => {
  const config = db.read('config.json');
  db.runCleanup();
  if (config.autoBackup) {
    db.createBackup();
  }
}, 5000);

// Graceful Shutdown
process.on('SIGINT', () => {
  clearInterval(heartbeatInterval);
  clearInterval(dailyInterval);
  httpServer.close(() => {
    console.log('[Server] Shutting down gracefully.');
    process.exit(0);
  });
});

httpServer.listen(PORT, () => {
  console.log('===============================================');
  console.log(` Heartbeat Cron scheduled successfully (every minute).`);
  console.log('===============================================');
  console.log(` MikroTik Ultra Monitoring Platform is running`);
  console.log(` Port: ${PORT}`);
  console.log(` PIN Auth: ${auth.isPinEnabled() ? 'enabled' : 'disabled (set PIN in .env)'}`);
  console.log('===============================================');
});
