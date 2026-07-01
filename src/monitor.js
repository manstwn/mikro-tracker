import * as db from './db.js';

let broadcastCallback = () => {};

export function setBroadcastCallback(cb) {
  broadcastCallback = cb;
}

// Utility to format duration (seconds to readable string, e.g. 1h 15m)
export function formatDuration(sec) {
  if (!sec || isNaN(sec) || sec < 0) return '0s';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);

  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);

  return parts.join('');
}

// Process Incoming Webhook
export function handleWebhook(query) {
  const config = db.read('config.json');
  const system = db.read('system.json');

  // 1. Authentication
  if (!query.key || query.key !== config.secretKey) {
    db.addLog('Secret Invalid', `IP/Query key did not match. Webhook ignored.`);
    db.addAlert('Secret Key Invalid', `Unauthorized webhook attempt ignored.`);
    return { authorized: false, paused: false };
  }

  // 2. System Mode (PAUSE check)
  if (system.mode === 'PAUSE') {
    return { authorized: true, paused: true };
  }

  const routerName = query.router || 'Router';
  const newRx = parseInt(query.rx, 10);
  const newTx = parseInt(query.tx, 10);

  // Validate rx and tx
  if (isNaN(newRx) || newRx < 0 || isNaN(newTx) || newTx < 0) {
    db.addLog('Webhook Invalid Data', `RX: ${query.rx}, TX: ${query.tx} must be non-negative integers.`);
    return { authorized: true, paused: false, success: false, error: 'Invalid RX/TX data' };
  }

  const now = new Date().toISOString();
  const nowMs = new Date(now).getTime();

  // 3. Router Update & Traffic Speed
  const router = db.read('router.json');
  const oldStatus = router.status;
  const oldRx = router.rx || 0;
  const oldTx = router.tx || 0;
  const oldLastSeen = router.lastSeen;

  let rxSpeed = 0;
  let txSpeed = 0;

  if (oldLastSeen) {
    const elapsedSeconds = (nowMs - new Date(oldLastSeen).getTime()) / 1000;
    if (elapsedSeconds > 0) {
      let rxDelta = newRx - oldRx;
      let txDelta = newTx - oldTx;

      // Handle Counter Reset/Reboot
      if (rxDelta < 0) rxDelta = newRx;
      if (txDelta < 0) txDelta = newTx;

      rxSpeed = Math.round(rxDelta / elapsedSeconds);
      txSpeed = Math.round(txDelta / elapsedSeconds);
    }
  }

  // Update router stats
  router.name = routerName;
  router.status = 'online';
  router.lastSeen = now;
  router.rx = newRx;
  router.tx = newTx;
  router.rxSpeed = rxSpeed;
  router.txSpeed = txSpeed;
  db.write('router.json', router);

  // Save traffic point
  const traffic = db.read('traffic.json');
  traffic.push({
    time: now,
    rx: newRx,
    tx: newTx,
    rxSpeed,
    txSpeed
  });
  db.write('traffic.json', traffic);

  // Alert and history if Router went ONLINE
  if (oldStatus !== 'online') {
    db.addHistoryEvent('router_online', null, now);
    db.addAlert('Router Restored', `Router ${routerName} has restored connection.`);
    db.addLog('Router Online', `Router ${routerName} status is now ONLINE.`);
  } else {
    db.addLog('Webhook Received', `Updated router traffic. RX Speed: ${rxSpeed} B/s, TX Speed: ${txSpeed} B/s`);
  }

  // 4. Users Online/Offline parsing
  const usersParam = query.users || '';
  const onlineUsersInWebhook = usersParam.split(';')
    .map(u => u.trim())
    .filter(u => u.length > 0);

  const users = db.read('users.json');
  const sessions = db.read('sessions.json');

  // Process users reported as active in the webhook
  for (const username of onlineUsersInWebhook) {
    const user = users[username];

    if (!user) {
      // New User creation
      users[username] = {
        status: 'online',
        lastSeen: now,
        lastOnline: now,
        lastOffline: null,
        totalOnline: 0,
        loginCount: 1,
        disconnectCount: 0
      };
      
      // Start a new session
      sessions.push({
        id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 5),
        user: username,
        start: now,
        end: null,
        duration: null
      });

      db.addHistoryEvent('user_online', username, now);
      db.addAlert('User Online', `User ${username} is now online.`);
      db.addLog('User Online', `User ${username} connected.`);
    } else {
      const prevStatus = user.status;
      user.lastSeen = now;

      if (prevStatus !== 'online') {
        // Transition Offline -> Online
        user.status = 'online';
        user.lastOnline = now;
        user.loginCount = (user.loginCount || 0) + 1;

        // Start a new session
        sessions.push({
          id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 5),
          user: username,
          start: now,
          end: null,
          duration: null
        });

        db.addHistoryEvent('user_online', username, now);
        db.addAlert('User Online', `User ${username} is now online.`);
        db.addLog('User Online', `User ${username} connected.`);
      }
    }
  }

  // Write changes
  db.write('users.json', users);
  db.write('sessions.json', sessions);

  // Trigger WebSocket broadcast
  broadcastCallback();

  return { authorized: true, paused: false, success: true };
}

// Check timeouts for router and users (Heartbeat function)
export function checkHeartbeats() {
  const system = db.read('system.json');
  if (system.mode === 'PAUSE') return;

  const config = db.read('config.json');
  const now = new Date().toISOString();
  const nowMs = new Date(now).getTime();

  let stateChanged = false;

  // 1. Check Router Timeout
  const router = db.read('router.json');
  if (router.status === 'online' && router.lastSeen) {
    const lastSeenMs = new Date(router.lastSeen).getTime();
    const routerTimeoutMs = (config.offlineTimeoutRouter || 300) * 1000;

    if (nowMs - lastSeenMs > routerTimeoutMs) {
      router.status = 'offline';
      db.write('router.json', router);
      
      db.addHistoryEvent('router_offline', null, now);
      db.addAlert('Webhook Lost', `Router connection lost. Last webhook received 5 minutes ago.`);
      db.addLog('Router Offline', `Router status changed to OFFLINE (timeout).`);
      stateChanged = true;
    }
  }

  // 2. Check User Timeout
  const users = db.read('users.json');
  const sessions = db.read('sessions.json');
  const userTimeoutMs = (config.offlineTimeoutUser || 60) * 1000;

  for (const [username, user] of Object.entries(users)) {
    if (user.status === 'online' && user.lastSeen) {
      const lastSeenMs = new Date(user.lastSeen).getTime();
      if (nowMs - lastSeenMs >= userTimeoutMs) {
        // Transition Online -> Offline
        user.status = 'offline';
        user.lastOffline = now;
        user.disconnectCount = (user.disconnectCount || 0) + 1;

        // Close the active session
        const activeSession = sessions.slice().reverse().find(s => s.user === username && s.end === null);
        if (activeSession) {
          activeSession.end = now;
          const duration = Math.round((new Date(now).getTime() - new Date(activeSession.start).getTime()) / 1000);
          activeSession.duration = duration;
          user.totalOnline = (user.totalOnline || 0) + duration;
        }

        db.addHistoryEvent('user_offline', username, now);
        db.addAlert('User Offline', `User ${username} has disconnected.`);
        db.addLog('User Offline', `User ${username} disconnected.`);
        stateChanged = true;
      }
    }
  }

  if (stateChanged) {
    db.write('users.json', users);
    db.write('sessions.json', sessions);
    broadcastCallback();
  }
}

