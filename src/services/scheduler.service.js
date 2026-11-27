const {
  syncAttendance,
  startRealtimeListener,
  autoCheckoutOpenSessions,
  autoLunchReturn
} = require('./attendance.service');

let realtimeDevice = null;
let started = false;
let stopping = false;
let syncTimer = null;
let checkoutTimer = null;
let syncInProgress = false;
let checkoutInProgress = false;
let consecutiveSyncFailures = 0;
let lastAbsenceRun = 0;

const ms = (key, fallback, minimum = 10000) => {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? Math.max(minimum, value) : fallback;
};

const syncInterval = ms('SYNC_INTERVAL_MS', 300000);
const retryInterval = ms('ZK_RECONNECT_INTERVAL_MS', 30000);
const checkoutInterval = ms('AUTO_CHECKOUT_CHECK_INTERVAL_MS', 30000);

async function stopRealtimeListener() {
  const oldDevice = realtimeDevice;
  realtimeDevice = null;
  if (oldDevice) {
    try { await oldDevice.disconnect(); }
    catch (error) { console.warn('[F28] Listener disconnect:', error.message); }
  }
}

async function runDeviceCycle() {
  if (stopping || syncInProgress) return;
  syncInProgress = true;
  let nextDelay = syncInterval;

  try {
    // Import buffered punches first, so a VPN outage can be recovered.
    const result = await syncAttendance();
    console.log('[F28] Attendance sync:', result);
    consecutiveSyncFailures = 0;
    if (process.env.ABSENCE_DEDUCTION_ENABLED === "true" && result.failed === 0 && result.skipped === 0 && Date.now()-lastAbsenceRun >= 3600000) {
      lastAbsenceRun = Date.now();
      require("./absence-deduction.service").reconcile({apply:true}).then(changes=>console.log("[Absence deductions] changes:",changes.length)).catch(e=>console.error("[Absence deductions]",e.message));
    }

    if (!realtimeDevice && String(process.env.ZK_REALTIME).toLowerCase() === 'true') {
      try {
        realtimeDevice = await startRealtimeListener();
        if (realtimeDevice) console.log('[F28] Realtime listener connected');
      } catch (error) {
        console.error('[F28] Realtime listener setup failed:', error.message);
        nextDelay = retryInterval;
      }
    }
  } catch (error) {
    consecutiveSyncFailures += 1;
    console.error(`[F28] Sync failed (${consecutiveSyncFailures}):`, error?.message || error);
    nextDelay = retryInterval;

    // A VPN outage can leave the realtime socket stale. After two failed
    // polling attempts, release it. Next successful sync starts a new listener.
    if (consecutiveSyncFailures >= 2 && realtimeDevice) {
      console.warn('[F28] Releasing stale realtime listener after sync failures');
      await stopRealtimeListener();
    }
  } finally {
    syncInProgress = false;
    if (!stopping) syncTimer = setTimeout(runDeviceCycle, nextDelay);
  }
}

async function runCheckoutCycle() {
  if (stopping || checkoutInProgress) return;
  checkoutInProgress = true;
  try {
    const result = await autoCheckoutOpenSessions();
    const lunch = await autoLunchReturn();
    if (lunch?.inserted) console.log('Automatic lunch return:', lunch);
    if (result?.checkedOut) console.log('Automatic attendance checkout:', result);
  } catch (error) {
    console.error('Automatic attendance checkout failed:', error?.message || error);
  } finally {
    checkoutInProgress = false;
    if (!stopping) checkoutTimer = setTimeout(runCheckoutCycle, checkoutInterval);
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  clearTimeout(syncTimer);
  clearTimeout(checkoutTimer);
  console.log(`[F28] ${signal} received, disconnecting realtime listener`);
  await stopRealtimeListener();
  process.exit(0);
}

function startSchedulers() {
  if (started) return;
  started = true;
  syncTimer = setTimeout(runDeviceCycle, 500);
  checkoutTimer = setTimeout(runCheckoutCycle, 1000);
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
}

module.exports = { startSchedulers };
