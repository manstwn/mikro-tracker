import * as db from './db.js';

// ─── Cooldown tracker (per event type, not per user) ──────────────────────────
const cooldownTracker = new Map();
const prolongedOfflineSent = new Map(); // username -> lastOffline timestamp

// ─── Batch queue for coalescing rapid events into one notification ─────────────
// Structure: Map<eventType, { users: Set<string>, timer: Timeout }>
const batchQueue = new Map();
const BATCH_WINDOW_MS = 3000; // collect events for 3 s then send one combined notification

// ─── Message builder ──────────────────────────────────────────────────────────
function buildMessage(template, eventType, details, now) {
  if (!template) return '';

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  const vars = {
    '{username}': details.user || '',
    '{router}': details.router || '',
    '{time}': now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    '{date}': now.toLocaleDateString(),
    '{day}': dayNames[now.getDay()],
    '{dayNumber}': String(now.getDate()),
    '{month}': monthNames[now.getMonth()],
    '{monthNumber}': String(now.getMonth() + 1),
    '{year}': String(now.getFullYear()),
    '{iso}': now.toISOString(),
    '{event}': eventType
  };

  let result = template;
  for (const [key, val] of Object.entries(vars)) {
    result = result.replaceAll(key, val);
  }
  return result;
}

// ─── Core send function (single HTTP POST) ────────────────────────────────────
async function sendNotification(eventType, details, config) {
  const url = config.notificationEndpoint;
  const headers = parseHeaders(config.notificationHeaders);
  const now = new Date();
  const message = buildMessage(config.notificationMessageTemplate, eventType, details, now);

  const payload = {
    event: eventType,
    timestamp: now.toISOString(),
    message,
    ...details
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'MicroMonitor/2.0',
        ...headers
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000)
    });

    if (response.ok) {
      const body = await response.text();
      db.addLog('Notification Sent', `Event "${eventType}" sent to ${url} (${response.status})`);
      saveHistory({ eventType, url, payload, status: response.status, success: true, responseBody: body });
      return { sent: true, status: response.status, body };
    }

    const body = await response.text();
    const errMsg = `HTTP ${response.status}`;
    db.addLog('Notification Failed', `Event "${eventType}" to ${url} - ${errMsg}`);
    saveHistory({ eventType, url, payload, status: response.status, success: false, responseBody: body });
    return { sent: false, error: errMsg, status: response.status, body };
  } catch (err) {
    const errMsg = err.name === 'TimeoutError' ? 'timeout' : err.message;
    db.addLog('Notification Failed', `Event "${eventType}" to ${url} - ${errMsg}`);
    saveHistory({ eventType, url, payload, status: 0, success: false, error: errMsg });
    return { sent: false, error: errMsg };
  }
}

// ─── Flush a batched event (called after BATCH_WINDOW_MS) ─────────────────────
async function flushBatch(eventType) {
  const batch = batchQueue.get(eventType);
  if (!batch) return;
  batchQueue.delete(eventType);

  const config = db.read('config.json');
  if (!config.notificationEnabled || !config.notificationEndpoint) return;

  // Check global cooldown for this event type
  const cooldownKey = eventType;
  if (isOnCooldown(cooldownKey)) return;

  const users = [...batch.users];
  const router = batch.router || '';

  // Build combined details — multiple users joined as "user1,user2"
  const details = {
    user: users.join(','),
    users,
    router,
    count: users.length
  };

  const result = await sendNotification(eventType, details, config);
  if (result.sent) {
    markSent(cooldownKey);
  }
}

// ─── Public: queue an event (batches same-type events within BATCH_WINDOW_MS) ──
export async function dispatchEvent(eventType, details = {}) {
  const config = db.read('config.json');

  if (!config.notificationEndpoint) {
    return { sent: false, error: 'No notification endpoint configured' };
  }

  if (!config.notificationEnabled) {
    return { sent: false, error: 'Notifications are disabled' };
  }

  const eventFlagMap = {
    'user_offline': 'notifyOnUserOffline',
    'user_online': 'notifyOnUserOnline',
    'router_offline': 'notifyOnRouterOffline',
    'router_online': 'notifyOnRouterOnline',
    'webhook_lost': 'notifyOnWebhookLost'
  };

  const flag = eventFlagMap[eventType];
  if (flag && !config[flag]) {
    return { sent: false, error: `Event type "${eventType}" is not enabled` };
  }

  // Router/webhook events are not user-level — send immediately (no batching needed)
  // but still respect cooldown per event type
  const isUserEvent = eventType === 'user_offline' || eventType === 'user_online';

  if (!isUserEvent) {
    const cooldownKey = eventType;
    if (isOnCooldown(cooldownKey)) return { sent: false, error: 'On cooldown' };

    // Special case: test_notification fires immediately always
    const result = await sendNotification(eventType, details, config);
    if (result.sent) markSent(cooldownKey);
    return result;
  }

  // ── User events: add to batch queue and (re)start the flush timer ──
  if (!batchQueue.has(eventType)) {
    batchQueue.set(eventType, { users: new Set(), router: details.router || '' });
  }

  const batch = batchQueue.get(eventType);
  if (details.user) batch.users.add(details.user);
  if (details.router) batch.router = details.router;

  // Clear previous timer and restart — keeps collecting until quiet for BATCH_WINDOW_MS
  if (batch.timer) clearTimeout(batch.timer);
  batch.timer = setTimeout(() => flushBatch(eventType), BATCH_WINDOW_MS);

  return { sent: false, queued: true, batchWindow: BATCH_WINDOW_MS };
}

// ─── Prolonged offline check — runs every heartbeat minute ───────────────────
// Collects ALL users that have been offline long enough and sends ONE notification
export async function checkUserOfflineNotifications() {
  const config = db.read('config.json');
  if (!config.notificationEnabled || !config.notifyOnUserOffline || !config.notificationEndpoint) return;

  const userOfflineTimeoutMs = (config.notificationUserOfflineTimeout || 2) * 60 * 1000;
  const now = Date.now();
  const users = db.read('users.json');

  // Clean up entries for users who came back online
  for (const [username, user] of Object.entries(users)) {
    if (user.status === 'online' && prolongedOfflineSent.has(username)) {
      prolongedOfflineSent.delete(username);
    }
  }

  // Collect all users that need a prolonged-offline notification
  const dueUsers = [];
  for (const [username, user] of Object.entries(users)) {
    if (user.status !== 'offline' || !user.lastOffline) continue;
    const offlineSince = new Date(user.lastOffline).getTime();
    if (isNaN(offlineSince)) continue;
    if (now - offlineSince < userOfflineTimeoutMs) continue;

    // Check if we already sent for THIS offline session
    if (prolongedOfflineSent.get(username) === user.lastOffline) continue;

    dueUsers.push({ username, lastOffline: user.lastOffline });
  }

  if (dueUsers.length === 0) return;

  // Check cooldown for the prolonged-offline batch key
  const cooldownKey = 'user_offline_prolonged';
  if (isOnCooldown(cooldownKey)) return;

  // Send ONE notification for all due users combined
  const userList = dueUsers.map(u => u.username);
  const now2 = new Date();
  const message = buildMessage(
    config.notificationMessageTemplate,
    'user_offline',
    { user: userList.join(',') },
    now2
  );

  const result = await sendNotification(
    'user_offline',
    {
      user: userList.join(','),
      users: userList,
      count: userList.length,
      offlineSince: dueUsers[0].lastOffline
    },
    config
  );

  if (result.sent) {
    markSent(cooldownKey);
    // Mark all users as notified for this session
    for (const { username, lastOffline } of dueUsers) {
      prolongedOfflineSent.set(username, lastOffline);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function parseHeaders(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function isOnCooldown(eventKey) {
  const config = db.read('config.json');
  const cooldownMs = (config.notificationCooldown || 300) * 1000;
  const lastSent = cooldownTracker.get(eventKey);
  if (lastSent && (Date.now() - lastSent < cooldownMs)) return true;
  return false;
}

function markSent(eventKey) {
  cooldownTracker.set(eventKey, Date.now());
}

export function resetCooldowns() {
  cooldownTracker.clear();
  prolongedOfflineSent.clear();
  for (const [, batch] of batchQueue) {
    if (batch.timer) clearTimeout(batch.timer);
  }
  batchQueue.clear();
}

function saveHistory(entry) {
  const notifications = db.read('notifications.json');
  notifications.unshift({
    id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 5),
    time: new Date().toISOString(),
    ...entry
  });
  // Cap notification history at 200 entries
  if (notifications.length > 200) notifications.length = 200;
  db.write('notifications.json', notifications);
}

export function getHistory() {
  return db.read('notifications.json');
}

export function clearHistory() {
  db.write('notifications.json', []);
  db.addLog('Notification History Cleared', 'All notification send history has been wiped.');
}
