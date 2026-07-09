import https from 'https';
import http from 'http';
import * as db from './db.js';

const cooldownTracker = new Map();

function parseHeaders(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function sendPost(url, headers, payload) {
  return new Promise((resolve) => {
    try {
      const data = JSON.stringify(payload);
      const urlObj = new URL(url);
      const isHttps = urlObj.protocol === 'https:';
      const lib = isHttps ? https : http;

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...headers
        },
        timeout: 10000
      };

      const req = lib.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });

      req.on('error', (err) => resolve({ status: 0, error: err.message }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });

      req.write(data);
      req.end();
    } catch (err) {
      resolve({ status: 0, error: err.message });
    }
  });
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

export async function dispatchEvent(eventType, details = {}) {
  const config = db.read('config.json');
  if (!config.notificationEnabled || !config.notificationEndpoint) return;

  const eventKey = `${eventType}:${details.user || details.router || 'global'}`;
  if (isOnCooldown(eventKey)) return;

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
  if (flag && !notifConfig[flag]) return;

  const url = config.notificationEndpoint;
  const headers = parseHeaders(config.notificationHeaders);

  const payload = {
    event: eventType,
    timestamp: new Date().toISOString(),
    ...details
  };

  const result = await sendPost(url, headers, payload);

  if (result.status >= 200 && result.status < 300) {
    markSent(eventKey);
    db.addLog('Notification Sent', `Event "${eventType}" sent to ${url} (${result.status})`);
  } else {
    db.addLog('Notification Failed', `Event "${eventType}" to ${url} - ${result.error || result.status}`);
  }
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
