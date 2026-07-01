// debug-webhook.mjs
// Hits the webhook endpoint every 10s to simulate MikroTik router data.
// Usage: node debug-webhook.mjs

const BASE_URL = 'http://localhost:2041';
const KEY = 'thiskey219Kx';
const ROUTER_ID = 'router1';
const ROUTER_NAME = 'Router';
const USERS = 'user1;user3;user4;user5;user6;user7';
const INTERVAL_MS = 10_000;

// Simulate growing byte counters (like a real router)
let rx = 0;
let tx = 0;

async function sendWebhook() {
  rx += Math.floor(Math.random() * 500_000) + 50_000;  // +50KB~550KB per tick
  tx += Math.floor(Math.random() * 200_000) + 20_000;  // +20KB~220KB per tick

  const url = `${BASE_URL}/webhook/${ROUTER_ID}?key=${KEY}&router=${encodeURIComponent(ROUTER_NAME)}&rx=${rx}&tx=${tx}&users=${encodeURIComponent(USERS)}`;

  try {
    const res = await fetch(url);
    const text = await res.text();
    const time = new Date().toLocaleTimeString();
    if (res.ok) {
      console.log(`[${time}] ✅ ${text.trim()}  rx=${rx}  tx=${tx}`);
    } else {
      console.log(`[${time}] ⚠️  HTTP ${res.status}: ${text.trim()}`);
    }
  } catch (err) {
    const time = new Date().toLocaleTimeString();
    console.error(`[${time}] ❌ Error: ${err.message}`);
  }
}

console.log(`🚀 Debug webhook started — hitting ${BASE_URL}/webhook/${ROUTER_ID} every ${INTERVAL_MS / 1000}s`);
console.log(`   Users: ${USERS}`);
console.log('   Press Ctrl+C to stop.\n');

// Fire immediately, then on interval
sendWebhook();
setInterval(sendWebhook, INTERVAL_MS);
