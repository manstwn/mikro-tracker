const socket = io();

// State caching
let currentData = null;
let selectedUsername = null;
let trafficChart = null;
let currentChartMinutes = 1; // Default chart view

// Uptime bar range state (hours) — default 30m
let routerUptimeHours = 0.5;
let usersUptimeHours = 0.5;

// Helper: Format Bytes to human readable speed/size
function formatBytes(bytes, decimals = 2) {
  if (!bytes || isNaN(bytes) || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Helper: Format duration (seconds to readable string, e.g. 1h 12m 30s)
function formatDuration(sec) {
  if (!sec || isNaN(sec) || sec < 0) return '0s';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);

  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);

  return parts.join(' ');
}

// Helper: Format Date ISO String to readable time
function formatDateTime(isoString) {
  if (!isoString) return '-';
  const date = new Date(isoString);
  return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
}

// Helper: Format Date ISO to time-only
function formatTimeOnly(isoString) {
  if (!isoString) return '-';
  const date = new Date(isoString);
  return date.toLocaleTimeString();
}

// Navigation handling
const menuButtons = document.querySelectorAll('.menu-btn');
const contentSections = document.querySelectorAll('.content-section');
const sectionTitle = document.getElementById('section-title');

menuButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    // Remove active from all buttons
    menuButtons.forEach(b => b.classList.remove('active'));
    // Add active to clicked button
    btn.classList.add('active');

    // Hide all sections
    contentSections.forEach(sec => sec.classList.remove('active'));
    // Show target section
    const targetId = btn.getAttribute('data-target');
    document.getElementById(targetId).classList.add('active');

    // Update Header title
    sectionTitle.textContent = btn.textContent.trim().split('\n')[0];
  });
});

// Sidebar toggle (desktop collapse + mobile overlay)
const sidebar = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebar-overlay');
const sidebarToggleBtn = document.getElementById('sidebar-toggle');

function openSidebar() {
  sidebar.classList.remove('collapsed');
  sidebarOverlay.classList.add('visible');
}
function closeSidebar() {
  sidebar.classList.add('collapsed');
  sidebarOverlay.classList.remove('visible');
}
function toggleSidebar() {
  if (sidebar.classList.contains('collapsed')) {
    openSidebar();
  } else {
    closeSidebar();
  }
}

sidebarToggleBtn.addEventListener('click', toggleSidebar);
sidebarOverlay.addEventListener('click', closeSidebar);

// Auto-close on mobile after menu item click
menuButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    if (window.innerWidth <= 768) closeSidebar();
  });
});

// On mobile: start collapsed. On desktop: start open.
function initSidebar() {
  if (window.innerWidth <= 768) {
    sidebar.classList.add('collapsed');
  } else {
    sidebar.classList.remove('collapsed');
  }
}
initSidebar();
window.addEventListener('resize', initSidebar);
document.getElementById('goto-timeline').addEventListener('click', () => {
  const timelineBtn = Array.from(menuButtons).find(btn => btn.getAttribute('data-target') === 'timeline-section');
  if (timelineBtn) timelineBtn.click();
});

// Time range pill helper — updates active pill class and calls callback
function setupRangePills(containerId, onSelect) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.querySelectorAll('.range-pill').forEach(pill => {
    // Apply initial active style
    if (pill.dataset.active === 'true') pill.classList.add('active');
    pill.addEventListener('click', () => {
      container.querySelectorAll('.range-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      onSelect(parseFloat(pill.dataset.hours));
    });
  });
}

setupRangePills('router-uptime-range', (hours) => {
  routerUptimeHours = hours;
  if (currentData) renderUptimeBar();
});

setupRangePills('users-uptime-range', (hours) => {
  usersUptimeHours = hours;
  if (currentData) renderDashboardUsers();
});

// Search filter in PPPoE Users Table
const searchInput = document.getElementById('user-search-input');
searchInput.addEventListener('input', () => {
  renderUsersTable();
});

// System Mode switching handling (RUNNING / PAUSE)
const runningBtn = document.getElementById('mode-running-btn');
const pauseBtn = document.getElementById('mode-pause-btn');

runningBtn.addEventListener('click', () => setSystemMode('RUNNING'));
pauseBtn.addEventListener('click', () => setSystemMode('PAUSE'));

function setSystemMode(mode) {
  fetch('/api/system/mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode })
  })
  .then(res => res.json())
  .then(data => {
    if (data.success) {
      updateSystemModeButtons(data.mode);
    } else {
      alert('Failed to change system mode: ' + data.error);
    }
  })
  .catch(err => console.error('Error changing system mode:', err));
}

function updateSystemModeButtons(mode) {
  if (mode === 'RUNNING') {
    runningBtn.classList.add('active');
    pauseBtn.classList.remove('active');
  } else {
    pauseBtn.classList.add('active');
    runningBtn.classList.remove('active');
  }
}

// Chart.js Setup & Toggling
const chartOptButtons = document.querySelectorAll('.chart-opt-btn');
chartOptButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    chartOptButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentChartMinutes = parseInt(btn.getAttribute('data-minutes'), 10);
    renderTrafficChart();
  });
});

function initChart() {
  const ctx = document.getElementById('trafficChart').getContext('2d');
  
  // Create gradient glows
  const rxGradient = ctx.createLinearGradient(0, 0, 0, 400);
  rxGradient.addColorStop(0, 'rgba(0, 230, 118, 0.25)');
  rxGradient.addColorStop(1, 'rgba(0, 230, 118, 0)');

  const txGradient = ctx.createLinearGradient(0, 0, 0, 400);
  txGradient.addColorStop(0, 'rgba(213, 0, 249, 0.25)');
  txGradient.addColorStop(1, 'rgba(213, 0, 249, 0)');

  trafficChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'RX (Download) Speed',
          data: [],
          borderColor: '#00e676',
          backgroundColor: rxGradient,
          fill: true,
          tension: 0.4,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 5
        },
        {
          label: 'TX (Upload) Speed',
          data: [],
          borderColor: '#d500f9',
          backgroundColor: txGradient,
          fill: true,
          tension: 0.4,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 5
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: { color: '#f1f3f9', font: { family: 'Inter' } }
        },
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: {
            label: function(context) {
              return context.dataset.label + ': ' + formatBytes(context.parsed.y) + '/s';
            }
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: '#8b9bb4', font: { family: 'Inter', size: 10 } }
        },
        y: {
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: {
            color: '#8b9bb4',
            font: { family: 'Inter', size: 10 },
            callback: function(value) {
              return formatBytes(value) + '/s';
            }
          }
        }
      }
    }
  });
}

function renderTrafficChart() {
  if (!trafficChart || !currentData || !currentData.traffic) return;

  const nowMs = Date.now();
  const timeLimitMs = currentChartMinutes * 60 * 1000;

  // Filter traffic points within the range
  const filteredTraffic = currentData.traffic.filter(pt => {
    const t = new Date(pt.time).getTime();
    return nowMs - t <= timeLimitMs;
  });

  const labels = filteredTraffic.map(pt => formatTimeOnly(pt.time));
  const rxData = filteredTraffic.map(pt => pt.rxSpeed);
  const txData = filteredTraffic.map(pt => pt.txSpeed);

  trafficChart.data.labels = labels;
  trafficChart.data.datasets[0].data = rxData;
  trafficChart.data.datasets[1].data = txData;
  trafficChart.update('none'); // Update without animation for smoother streaming
}

// Receive Socket updates
socket.on('update', (data) => {
  currentData = data;
  console.log('[Socket] Database update received:', data);

  // Initialize chart if needed
  if (!trafficChart) {
    initChart();
  }

  // Update elements
  updateSidebarStatus();
  updateSystemModeButtons(data.system.mode);
  updateDashboardWidgets();
  renderUptimeBar();
  renderMiniTimeline();
  renderDashboardUsers();
  renderUsersTable();
  renderUserDetailPanel();
  renderRouterDiagnostics();
  renderTrafficChart();
  renderFullTimeline();
  renderAlertsTable();
  populateSettingsForm();
  renderSystemLogs();
});

// Bootstrap: fetch initial data immediately via HTTP so bars show
// without waiting for a Socket.IO push event
fetch('/api/status')
  .then(r => r.json())
  .then(data => {
    if (!currentData) {
      currentData = data;
      if (!trafficChart) initChart();
      updateSidebarStatus();
      updateSystemModeButtons(data.system.mode);
      updateDashboardWidgets();
      renderUptimeBar();
      renderMiniTimeline();
      renderDashboardUsers();
      renderUsersTable();
      renderUserDetailPanel();
      renderRouterDiagnostics();
      renderTrafficChart();
      renderFullTimeline();
      renderAlertsTable();
      populateSettingsForm();
      renderSystemLogs();
    }
  })
  .catch(() => {}); // ignore if not available, socket will cover it



// Update Sidebar Status
function updateSidebarStatus() {
  const led = document.querySelector('.status-router-led');
  const txt = document.getElementById('router-sidebar-status');
  if (currentData.router.status === 'online') {
    led.className = 'pulse-indicator status-router-led active';
    txt.textContent = 'Router: Online';
  } else {
    led.className = 'pulse-indicator status-router-led offline';
    txt.textContent = 'Router: Offline';
  }
}

// Update Dashboard Page widgets
function updateDashboardWidgets() {
  const router = currentData.router;
  const users = currentData.users;

  // Router Widget
  const rDot = document.getElementById('router-dot');
  const rTxt = document.getElementById('router-status-txt');
  const rName = document.getElementById('router-name-txt');
  const rSeen = document.getElementById('router-last-seen-txt');

  if (router.status === 'online') {
    rDot.className = 'status-indicator-dot online';
    rTxt.textContent = 'ONLINE';
    rTxt.style.color = 'var(--accent-green)';
  } else {
    rDot.className = 'status-indicator-dot';
    rTxt.textContent = 'OFFLINE';
    rTxt.style.color = 'var(--accent-red)';
  }
  rName.innerHTML = `Router Name: <strong>${router.name || 'Router'}</strong>`;
  rSeen.textContent = `Last Seen: ${formatDateTime(router.lastSeen)}`;

  // Users Widget
  const userList = Object.values(users);
  const totalUsers = userList.length;
  const onlineUsers = userList.filter(u => u.status === 'online').length;
  const pct = totalUsers > 0 ? Math.round((onlineUsers / totalUsers) * 100) : 0;

  document.getElementById('stats-users-online').textContent = onlineUsers;
  document.getElementById('stats-users-pct').textContent = `${pct}% of total monitored (${totalUsers})`;

  // RX/TX Widget
  document.getElementById('stats-rx-speed').textContent = formatBytes(router.rxSpeed) + '/s';
  document.getElementById('stats-tx-speed').textContent = formatBytes(router.txSpeed) + '/s';

  // Webhook stats widget
  const lastWebhookTime = router.lastSeen;
  document.getElementById('web-last-time').textContent = lastWebhookTime ? formatDateTime(lastWebhookTime) : 'Never';
  
  let delay = 0;
  if (lastWebhookTime) {
    delay = Math.round((Date.now() - new Date(lastWebhookTime).getTime()) / 1000);
  }
  document.getElementById('web-delay').textContent = delay > 0 ? `${delay}s ago` : '0s';

  const statusBadge = document.getElementById('web-status-badge');
  const intervalTarget = currentData.config.webhookInterval || 30;
  document.getElementById('web-interval-target').textContent = `${intervalTarget}s`;

  if (delay > intervalTarget * 2) {
    statusBadge.textContent = 'Delayed';
    statusBadge.className = 'value badge badge-danger';
  } else {
    statusBadge.textContent = 'Normal';
    statusBadge.className = 'value badge badge-success';
  }
}

// Render Mini Activity Timeline on Dashboard
function renderMiniTimeline() {
  const container = document.getElementById('mini-timeline');
  const activities = currentData.history.slice(0, 5); // display 5 latest items

  if (activities.length === 0) {
    container.innerHTML = '<div class="timeline-empty">No activities logged yet.</div>';
    return;
  }

  container.innerHTML = activities.map(act => {
    let typeClass = act.type.replace('_', '-');
    let title = '';

    if (act.type === 'router_online') title = 'Router Connected';
    else if (act.type === 'router_offline') title = 'Router Offline';
    else if (act.type === 'user_online') title = `User ${act.user} Connected`;
    else if (act.type === 'user_offline') title = `User ${act.user} Offline`;

    return `
      <div class="mini-timeline-row ${typeClass}">
        <span class="mini-timeline-event">${title}</span>
        <span class="mini-timeline-time">${formatTimeOnly(act.time)}</span>
      </div>
    `;
  }).join('');
}

// Render PPPoE Users List Directory
function renderUsersTable() {
  const tbody = document.getElementById('users-table-body');
  const query = searchInput.value.toLowerCase().trim();
  const userList = Object.entries(currentData.users);

  // Filter matching search query
  const filteredUsers = userList.filter(([username]) => username.toLowerCase().includes(query));

  if (filteredUsers.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center">No users match search search criteria.</td></tr>`;
    return;
  }

  tbody.innerHTML = filteredUsers.map(([username, user]) => {
    const isOnline = user.status === 'online';
    const statusPill = isOnline
      ? '<span class="status-pill online"><span class="status-circle"></span>Online</span>'
      : '<span class="status-pill offline"><span class="status-circle"></span>Offline</span>';
    
    // Find current active session or last session
    const userSessions = currentData.sessions.filter(s => s.user === username);
    let sessionText = '-';
    if (isOnline) {
      const activeSession = userSessions.find(s => s.end === null);
      if (activeSession) {
        const dur = Math.round((Date.now() - new Date(activeSession.start).getTime()) / 1000);
        sessionText = formatDuration(dur);
      }
    } else if (userSessions.length > 0) {
      sessionText = formatDuration(userSessions[0].duration);
    }

    const isActive = selectedUsername === username ? 'class="active-user-row"' : '';

    return `
      <tr onclick="selectUser('${username}')" ${isActive}>
        <td>${statusPill}</td>
        <td><strong>${username}</strong></td>
        <td>${sessionText}</td>
        <td>${formatDuration(user.totalOnline)}</td>
        <td>${user.loginCount || 0}</td>
        <td>${user.disconnectCount || 0}</td>
        <td>${formatDateTime(user.lastSeen)}</td>
      </tr>
    `;
  }).join('');
}

// User selection handler
window.selectUser = function(username) {
  selectedUsername = username;
  renderUsersTable(); // Redraw selection class
  renderUserDetailPanel();
};

// Render Selected User Details Panel
function renderUserDetailPanel() {
  const emptyState = document.getElementById('user-detail-empty');
  const contentArea = document.getElementById('user-detail-content');

  if (!selectedUsername || !currentData.users[selectedUsername]) {
    emptyState.classList.remove('hidden');
    contentArea.classList.add('hidden');
    return;
  }

  emptyState.classList.add('hidden');
  contentArea.classList.remove('hidden');

  const username = selectedUsername;
  const user = currentData.users[username];
  const isOnline = user.status === 'online';
  
  // Header details
  document.getElementById('detail-avatar').textContent = username.substring(0, 2).toUpperCase();
  document.getElementById('detail-username').textContent = username;
  const statusPill = document.getElementById('detail-status');
  statusPill.textContent = isOnline ? 'Online' : 'Offline';
  statusPill.className = isOnline ? 'badge badge-success' : 'badge badge-danger';

  // Calculate session statistics
  const userSessions = currentData.sessions.filter(s => s.user === username);
  const completedSessions = userSessions.filter(s => s.duration !== null);

  let totalOnlineSec = user.totalOnline || 0;
  let loginCount = user.loginCount || 0;
  
  let avgSec = 0;
  let maxSec = 0;
  let minSec = Infinity;

  completedSessions.forEach(s => {
    avgSec += s.duration;
    if (s.duration > maxSec) maxSec = s.duration;
    if (s.duration < minSec) minSec = s.duration;
  });

  if (completedSessions.length > 0) {
    avgSec = Math.round(avgSec / completedSessions.length);
  } else {
    minSec = 0;
  }
  if (minSec === Infinity) minSec = 0;

  document.getElementById('detail-avg-session').textContent = formatDuration(avgSec);
  document.getElementById('detail-max-session').textContent = formatDuration(maxSec);
  document.getElementById('detail-min-session').textContent = formatDuration(minSec);
  document.getElementById('detail-total-time').textContent = formatDuration(totalOnlineSec);

  // Render session list
  const listContainer = document.getElementById('detail-sessions-list');
  if (userSessions.length === 0) {
    listContainer.innerHTML = '<div class="timeline-empty">No sessions recorded yet.</div>';
    return;
  }

  listContainer.innerHTML = userSessions.map(s => {
    const isSessionActive = s.end === null;
    const durStr = isSessionActive ? 'Active' : formatDuration(s.duration);
    
    return `
      <div class="session-item">
        <div class="session-times">
          <span>Start: ${formatDateTime(s.start)}</span>
          <span class="sub">End: ${s.end ? formatDateTime(s.end) : 'Current Session'}</span>
        </div>
        <span class="session-duration" style="${isSessionActive ? 'color: var(--accent-blue)' : ''}">${durStr}</span>
      </div>
    `;
  }).join('');
}

// Render Router Diagnostics Page
function renderRouterDiagnostics() {
  const router = currentData.router;
  document.getElementById('r-details-name').textContent = router.name || '-';
  document.getElementById('r-details-status').textContent = router.status.toUpperCase();
  document.getElementById('r-details-status').style.color = router.status === 'online' ? 'var(--accent-green)' : 'var(--accent-red)';
  document.getElementById('r-details-lastseen').textContent = formatDateTime(router.lastSeen);
  document.getElementById('r-details-rx').textContent = formatBytes(router.rx);
  document.getElementById('r-details-tx').textContent = formatBytes(router.tx);
  document.getElementById('r-details-rxspeed').textContent = formatBytes(router.rxSpeed) + '/s';
  document.getElementById('r-details-txspeed').textContent = formatBytes(router.txSpeed) + '/s';

  // Example integration link
  const origin = window.location.origin;
  const key = currentData.config.secretKey || 'thiskey219Kx';
  const routerName = router.name || 'Router';
  const url = `${origin}/webhook/router1?key=${key}&router=${routerName}&rx=0&tx=0&users=user1;user2;`;
  document.getElementById('webhook-example-url').textContent = url;
}

// Render Full timeline page
function renderFullTimeline() {
  const container = document.getElementById('timeline-full-list');
  const history = currentData.history;

  if (history.length === 0) {
    container.innerHTML = '<div class="timeline-empty">No historical events recorded.</div>';
    return;
  }

  container.innerHTML = history.map(item => {
    let title = '';
    let body = '';
    
    if (item.type === 'router_online') {
      title = 'Router Restored';
      body = 'The monitoring server received a valid webhook from the router.';
    } else if (item.type === 'router_offline') {
      title = 'Router Disconnected (Offline)';
      body = 'The router went offline due to lack of webhook signals for more than 5 minutes.';
    } else if (item.type === 'user_online') {
      title = `User ${item.user} Connected`;
      body = `PPPoE user ${item.user} is now authenticated as online.`;
    } else if (item.type === 'user_offline') {
      title = `User ${item.user} Offline`;
      body = `PPPoE user ${item.user} disconnected. Active connection closed.`;
    }

    return `
      <div class="timeline-item ${item.type}">
        <div class="timeline-dot"></div>
        <div class="timeline-content">
          <div class="timeline-header-row">
            <span class="timeline-title">${title}</span>
            <span class="timeline-time">${formatDateTime(item.time)}</span>
          </div>
          <div class="timeline-body">${body}</div>
        </div>
      </div>
    `;
  }).join('');
}

// Render Alerts Table
function renderAlertsTable() {
  const tbody = document.getElementById('alerts-table-body');
  const alerts = currentData.alerts;

  // Update alert badge count
  document.getElementById('alert-badge').textContent = alerts.length;

  if (alerts.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" class="text-center">No alerts logged.</td></tr>`;
    return;
  }

  tbody.innerHTML = alerts.map(alert => {
    let badgeClass = 'badge badge-success';
    if (['Webhook Lost', 'Router Offline', 'Secret Key Invalid'].includes(alert.type)) {
      badgeClass = 'badge badge-danger';
    } else if (alert.type === 'User Offline') {
      badgeClass = 'badge badge-danger'; // soft orange can be customized
    }

    return `
      <tr>
        <td style="width: 200px" class="font-mono">${formatDateTime(alert.time)}</td>
        <td style="width: 180px"><span class="${badgeClass}" style="display:inline-block">${alert.type}</span></td>
        <td>${alert.message}</td>
      </tr>
    `;
  }).join('');
}

// Populate settings forms
function populateSettingsForm() {
  const config = currentData.config;
  
  // Set values only if the user isn't currently editing (focus check to prevent UI jump)
  if (document.activeElement.id !== 'set-secret-key') {
    document.getElementById('set-secret-key').value = config.secretKey || '';
  }
  if (document.activeElement.id !== 'set-webhook-interval') {
    document.getElementById('set-webhook-interval').value = config.webhookInterval || 30;
  }
  if (document.activeElement.id !== 'set-offline-timeout-user') {
    document.getElementById('set-offline-timeout-user').value = config.offlineTimeoutUser || 60;
  }
  if (document.activeElement.id !== 'set-offline-timeout-router') {
    document.getElementById('set-offline-timeout-router').value = config.offlineTimeoutRouter || 300;
  }
  if (document.activeElement.id !== 'set-history-retention') {
    document.getElementById('set-history-retention').value = config.historyRetention || 365;
  }
  if (document.activeElement.id !== 'set-traffic-retention') {
    document.getElementById('set-traffic-retention').value = config.trafficRetention || 30;
  }
  if (document.activeElement.id !== 'set-log-retention') {
    document.getElementById('set-log-retention').value = config.logRetention || 90;
  }
  
  document.getElementById('set-auto-backup').checked = !!config.autoBackup;
}

// Save Settings Form
document.getElementById('settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  
  const payload = {
    secretKey: document.getElementById('set-secret-key').value,
    webhookInterval: parseInt(document.getElementById('set-webhook-interval').value, 10),
    offlineTimeoutUser: parseInt(document.getElementById('set-offline-timeout-user').value, 10),
    offlineTimeoutRouter: parseInt(document.getElementById('set-offline-timeout-router').value, 10),
    historyRetention: parseInt(document.getElementById('set-history-retention').value, 10),
    trafficRetention: parseInt(document.getElementById('set-traffic-retention').value, 10),
    logRetention: parseInt(document.getElementById('set-log-retention').value, 10),
    autoBackup: document.getElementById('set-auto-backup').checked
  };

  const saveBtn = document.getElementById('save-settings-btn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving Configurations...';

  fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  .then(res => res.json())
  .then(data => {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Configurations';
    if (data.success) {
      alert('Configurations saved successfully!');
    }
  })
  .catch(err => {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Configurations';
    console.error('Error saving settings:', err);
    alert('Failed to save settings: ' + err.message);
  });
});

// Factory Reset Button Click Handler
document.getElementById('factory-reset-btn').addEventListener('click', () => {
  const confirmed = confirm("Are you sure you want to perform a full factory reset? All monitoring history, users, sessions, alerts, and configurations will be permanently deleted.");
  if (!confirmed) return;

  const finalConfirm = confirm("WARNING: This is your last warning! All telemetry data will be wiped out. Do you really want to proceed?");
  if (!finalConfirm) return;

  const resetBtn = document.getElementById('factory-reset-btn');
  resetBtn.disabled = true;
  resetBtn.textContent = 'Resetting Database...';

  fetch('/api/system/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  })
  .then(res => res.json())
  .then(data => {
    resetBtn.disabled = false;
    resetBtn.textContent = 'Reset All Monitoring Data';
    if (data.success) {
      alert('The database has been fully reset successfully!');
      // Reset local selection state
      selectedUsername = null;
      // Navigate to dashboard
      const dashBtn = Array.from(document.querySelectorAll('.sidebar-menu .menu-btn'))
        .find(btn => btn.getAttribute('data-target') === 'dashboard-section');
      if (dashBtn) {
        dashBtn.click();
      }
    } else {
      alert('Failed to reset database.');
    }
  })
  .catch(err => {
    resetBtn.disabled = false;
    resetBtn.textContent = 'Reset All Monitoring Data';
    console.error('Error resetting database:', err);
    alert('Failed to reset database: ' + err.message);
  });
});


// Render System Logs in Console style window
function renderSystemLogs() {
  const container = document.getElementById('logs-terminal-container');
  const logs = currentData.logs;

  if (logs.length === 0) {
    container.innerHTML = '<div class="log-line">No system events logged.</div>';
    return;
  }

  container.innerHTML = logs.map(log => {
    let logClass = '';
    if (log.event.includes('Invalid') || log.event.includes('Offline') || log.event.includes('Error')) {
      logClass = 'log-err';
    } else if (log.event.includes('Pause') || log.event.includes('Cleanup')) {
      logClass = 'log-warn';
    }

    return `
      <div class="log-line ${logClass}">
        <span class="log-time">[${formatDateTime(log.time)}]</span>
        <span class="log-event">${log.event}:</span>
        <span class="log-details">${log.details}</span>
      </div>
    `;
  }).join('');
}

// Render Router Uptime History Timeline Bar
function renderUptimeBar() {
  const bar = document.getElementById('router-uptime-bar');
  const pctLabel = document.getElementById('router-uptime-pct');
  const labelStart = document.getElementById('router-uptime-label-start');
  const labelMid = document.getElementById('router-uptime-label-mid');
  if (!bar || !currentData || !currentData.router) return;

  const hours = routerUptimeHours;
  const now = Date.now();
  const windowMs = hours * 60 * 60 * 1000;
  const numBlocks = 40;
  const blockDuration = windowMs / numBlocks;

  // Update axis labels
  if (labelStart) labelStart.textContent = formatRangeLabel(hours);
  if (labelMid) labelMid.textContent = formatRangeLabel(hours / 2);

  // All router events, sorted oldest→newest
  const routerEvents = currentData.history
    .filter(e => e.type === 'router_online' || e.type === 'router_offline')
    .map(e => ({ time: new Date(e.time).getTime(), type: e.type }))
    .sort((a, b) => a.time - b.time);

  // Earliest known event time (start of monitoring)
  const monitoringStart = routerEvents.length > 0 ? routerEvents[0].time : now;
  const currentRouterStatus = currentData.router.status;

  let onlineCount = 0;
  let activeBlocks = 0;
  let blocksHtml = [];

  for (let i = 0; i < numBlocks; i++) {
    const blockTime = now - (numBlocks - 1 - i) * blockDuration;
    const blockDate = new Date(blockTime);

    let status;

    if (blockTime < monitoringStart) {
      // Before monitoring started — no data
      status = 'no-data';
    } else {
      activeBlocks++;
      // Find the last event at or before this block time
      const latestEvent = routerEvents.reduce((prev, curr) =>
        curr.time <= blockTime ? curr : prev, null);

      if (latestEvent) {
        // Use what the last known state was at this point in time
        status = latestEvent.type === 'router_online' ? 'online' : 'offline';
      } else {
        // blockTime is >= monitoringStart but before any known event
        // The first event transitioning TO a state tells us what it was BEFORE
        // e.g. first event = router_online means it came online then → was offline before
        status = routerEvents[0].type === 'router_online' ? 'offline' : 'online';
      }
    }

    if (status === 'online') onlineCount++;

    const timeStr = blockDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateStr = blockDate.toLocaleDateString();
    const tip = `${dateStr} ${timeStr} — Router: ${status.toUpperCase()}`;

    blocksHtml.push(`<div class="uptime-block ${status}" title="${tip}"></div>`);
  }

  bar.innerHTML = blocksHtml.join('');

  const uptimePct = activeBlocks > 0
    ? Math.round((onlineCount / activeBlocks) * 100)
    : (currentRouterStatus === 'online' ? 100 : 0);

  pctLabel.textContent = `Uptime: ${uptimePct}%`;
  pctLabel.style.color = uptimePct > 90 ? 'var(--accent-green)' : uptimePct > 50 ? 'var(--accent-orange)' : 'var(--accent-red)';
}

// Helper: human-readable range label for axis (relative + actual time)
function formatRangeLabel(hours) {
  const t = new Date(Date.now() - hours * 60 * 60 * 1000);
  const timeStr = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (hours >= 720) return `30d ago (${t.toLocaleDateString()})`;
  if (hours >= 168) return `7d ago (${t.toLocaleDateString()})`;
  if (hours >= 24) return `24h ago (${t.toLocaleDateString()})`;
  return `${hours >= 1 ? Math.round(hours) + 'h' : Math.round(hours * 60) + 'm'} ago (${timeStr})`;
}

// Render Dashboard Users Overview List
function renderDashboardUsers() {
  const listContainer = document.getElementById('dash-users-list');
  const onlineSummary = document.getElementById('dash-users-online-summary');
  const offlineSummary = document.getElementById('dash-users-offline-summary');
  if (!listContainer || !currentData || !currentData.users) return;

  const users = Object.entries(currentData.users);
  const onlineUsers = users.filter(([_, u]) => u.status === 'online');
  const offlineUsers = users.filter(([_, u]) => u.status === 'offline');

  onlineSummary.textContent = `${onlineUsers.length} Online`;
  offlineSummary.textContent = `${offlineUsers.length} Offline`;

  if (users.length === 0) {
    listContainer.innerHTML = '<div class="timeline-empty">No users logged yet. Send a webhook to monitor.</div>';
    return;
  }

  // Sort purely alphabetically (0-9 → a-z) regardless of status
  const sortedUsers = users.sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: 'base' }));

  const now = Date.now();
  const numBlocks = 30;
  const windowMs = usersUptimeHours * 60 * 60 * 1000;
  const blockDuration = windowMs / numBlocks;

  listContainer.innerHTML = sortedUsers.map(([username, user]) => {
    const isOnline = user.status === 'online';
    const userSessions = currentData.sessions.filter(s => s.user === username);
    
    // Find earliest session start time to determine "no-data" vs "offline"
    const earliestStart = userSessions.length > 0 
      ? Math.min(...userSessions.map(s => new Date(s.start).getTime())) 
      : Infinity;

    let onlineCount = 0;
    let activeBlocks = 0;
    let blocksHtml = [];

    // Calculate user timeline blocks
    for (let i = 0; i < numBlocks; i++) {
      const blockTime = now - (numBlocks - 1 - i) * blockDuration;
      const blockDate = new Date(blockTime);

      let blockStatus = 'offline';
      if (blockTime < earliestStart) {
        blockStatus = 'no-data';
      } else {
        activeBlocks++;
        const isUserOnline = userSessions.some(s => {
          const startMs = new Date(s.start).getTime();
          const endMs = s.end ? new Date(s.end).getTime() : Infinity;
          return startMs <= blockTime && endMs >= blockTime;
        });

        if (isUserOnline) {
          blockStatus = 'online';
          onlineCount++;
        }
      }

      const timeString = blockDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const dateString = blockDate.toLocaleDateString();
      const tooltipText = `${dateString} ${timeString} - ${username}: ${blockStatus.toUpperCase()}`;

      blocksHtml.push(`
        <div class="user-uptime-block ${blockStatus}" title="${tooltipText}"></div>
      `);
    }

    // Calculate Uptime percentage based on active monitoring hours
    const uptimePct = activeBlocks > 0 
      ? Math.round((onlineCount / activeBlocks) * 100) 
      : (isOnline ? 100 : 0);

    const pctColor = uptimePct > 90 
      ? 'var(--accent-green)' 
      : uptimePct > 50 ? 'var(--accent-orange)' : 'var(--accent-red)';

    const rowClass = isOnline ? 'online' : 'offline';
    const dotClass = isOnline ? 'online' : '';
    const statusTxt = isOnline ? 'Online' : 'Offline';

    // Status session duration text
    let timeText = 'Offline';
    if (isOnline) {
      const activeSession = userSessions.find(s => s.end === null);
      if (activeSession) {
        const dur = Math.round((now - new Date(activeSession.start).getTime()) / 1000);
        timeText = `Online (${formatDuration(dur)})`;
      }
    } else if (user.lastOffline) {
      const offlineSec = Math.round((now - new Date(user.lastOffline).getTime()) / 1000);
      timeText = `Offline (${formatDuration(offlineSec)} ago)`;
    }

    return `
      <div class="user-uptime-row ${rowClass}" onclick="navigateToUser('${username}')">
        <div class="user-uptime-meta">
          <span class="user-uptime-dot ${dotClass}"></span>
          <span class="user-uptime-name">${username}</span>
          <span class="user-uptime-status-txt">(${statusTxt})</span>
          <span class="user-uptime-pct" style="color: ${pctColor}">Uptime: ${uptimePct}%</span>
        </div>
        <div class="user-uptime-bar-container">
          <div class="user-uptime-bar">
            ${blocksHtml.join('')}
          </div>
          <span class="user-uptime-time ${rowClass}">${timeText}</span>
        </div>
      </div>
    `;
  }).join('');
}

// Navigation Helper from Dashboard card to Users tab with selection
window.navigateToUser = function(username) {
  const usersBtn = Array.from(document.querySelectorAll('.sidebar-menu .menu-btn'))
    .find(btn => btn.getAttribute('data-target') === 'users-section');
  if (usersBtn) {
    usersBtn.click();
  }
  selectUser(username);
};
