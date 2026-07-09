import * as db from './db.js';

const cooldownTracker = new Map();

export async function dispatchEvent(eventType, details = {}) {
  const config = db.read('config.json');

  if (!config.notificationEndpoint) {
    db.addLog('Notification Failed', `No endpoint configured for "${eventType}"`);
    return { sent: false, error: 'No notification endpoint configured' };
  }

  if (!config.notificationEnabled) {
    db.addLog('Notification Failed', `Notifications disabled for "${eventType}"`);
    return { sent: false, error: 'Notifications are disabled' };
  }

  const notifConfig = {
    notifyOnUserOffline: config.notifyOnUserOffline,
    notifyOnUserOnline: config.notifyOnUserOnline,
    notifyOnRouterOffline: config.notifyOnRouterOffline,
    notifyOnRouterOnline: config.notifyOnRouterOnline,
    notifyOnWebhookLost: config.notifyOnWebhookLost
  };

  const eventFlagMap = {
    'user_offline': 'notifyOnUserOffline',
    'user_online': 'notifyOnUserOnline',
    'router_offline': 'notifyOnRouterOffline',
    'router_online': 'notifyOnRouterOnline',
    'webhook_lost': 'notifyOnWebhookLost'
  };

  const flag = eventFlagMap[eventType];
  if (flag && !notifConfig[flag]) {
    return { sent: false, error: `Event type "${eventType}" is not enabled in notification settings` };
  }

  const eventKey = `${eventType}:${details.user || details.router || 'global'}`;
  if (isOnCooldown(eventKey)) {
    return { sent: false, error: 'On cooldown' };
  }

  const url = config.notificationEndpoint;
  const headers = parseHeaders(config.notificationHeaders);

  const payload = {
    event: eventType,
    timestamp: new Date().toISOString(),
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
      markSent(eventKey);
      const body = await response.text();
      db.addLog('Notification Sent', `Event "${eventType}" sent to ${url} (${response.status})`);
      return { sent: true, status: response.status, body };
    }

    const body = await response.text();
    const errMsg = `HTTP ${response.status}`;
    db.addLog('Notification Failed', `Event "${eventType}" to ${url} - ${errMsg}`);
    return { sent: false, error: errMsg, status: response.status, body };
  } catch (err) {
    const errMsg = err.name === 'TimeoutError' ? 'timeout' : err.message;
    db.addLog('Notification Failed', `Event "${eventType}" to ${url} - ${errMsg}`);
    return { sent: false, error: errMsg };
  }
}

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

export async function checkUserOfflineNotifications() {
  const config = db.read('config.json');
  if (!config.notificationEnabled || !config.notifyOnUserOffline || !config.notificationEndpoint) return;

  const userOfflineTimeoutMs = (config.notificationUserOfflineTimeout || 2) * 60 * 1000;
  const now = Date.now();
  const users = db.read('users.json');

  for (const [username, user] of Object.entries(users)) {
    if (user.status === 'offline' && user.lastOffline) {
      const offlineSince = new Date(user.lastOffline).getTime();
      if (!isNaN(offlineSince) && (now - offlineSince >= userOfflineTimeoutMs)) {
        const eventKey = `user_offline:${username}`;
        if (!isOnCooldown(eventKey)) {
          await dispatchEvent('user_offline', { user: username, offlineSince: user.lastOffline });
        }
      }
    }
  }
}

export function resetCooldowns() {
  cooldownTracker.clear();
}
