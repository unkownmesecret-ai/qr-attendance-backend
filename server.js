const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();

app.use(cors());
app.use(express.json());

// ============================================
// SUPABASE
// ============================================

const supabase = createClient(
  'https://ineujzimrapgjcpbtdue.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImluZXVqemltcmFwZ2pjcGJ0ZHVlIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTIwODgxNSwiZXhwIjoyMDk0Nzg0ODE1fQ.56lseaP69aWd99Bar_FBVEk4SMVePmadTng0RhE8M60'
);

// ============================================
// CONFIG
// ============================================

const PORT = process.env.PORT || 3000;
const TOKEN_TTL = 35000;
const COOLDOWN_DURATION = 60 * 60 * 1000; // 1 hour
const DEFAULT_MAX_SCANS = 2;

// ============================================
// ACTIVE TOKEN
// ============================================

let activeToken = { token: '', expires: 0 };

// ============================================
// TOKEN ROTATION
// ============================================

function rotateToken() {
  activeToken = {
    token: crypto.randomUUID(),
    expires: Date.now() + TOKEN_TTL
  };

  console.log('-----------------------------');
  console.log('NEW TOKEN :', activeToken.token);
  console.log('EXPIRES   :', new Date(activeToken.expires).toLocaleTimeString());
  console.log('-----------------------------');

  setTimeout(rotateToken, TOKEN_TTL);
}

rotateToken();

// ============================================
// GET TOKEN
// ============================================

app.get('/api/token', (req, res) => {
  res.json({
    token: activeToken.token,
    expires: activeToken.expires,
    url: `https://qr-attendance-frontend2.vercel.app/?scan=1&t=${activeToken.token}`
  });
});

// ============================================
// CHECK IN
// ============================================

app.post('/api/checkin', async (req, res) => {
  const { token, deviceId, userId } = req.body;

  console.log('[CHECKIN]', { deviceId, userId, tokenMatch: token === activeToken.token });

  // ----- TOKEN VALIDATION -----
  if (!token || token !== activeToken.token || Date.now() > activeToken.expires) {
    return res.json({ ok: false, reason: 'expired' });
  }

  // ----- GET DEVICE -----
  const { data: device, error: deviceError } = await supabase
    .from('devices')
    .select('*')
    .eq('deviceid', deviceId)
    .maybeSingle(); // FIX: use maybeSingle() so missing rows return null cleanly

  if (deviceError) {
    console.error('[DEVICE LOOKUP ERROR]', deviceError);
    return res.json({ ok: false, reason: 'db_error' });
  }

  console.log('[DEVICE]', device);

  // ----- BLOCKED -----
  // FIX: Supabase may return is_blocked as the STRING 'true'/'false' if the
  // column type is text instead of boolean. Coerce both cases safely.
  const isBlocked = device?.is_blocked === true || device?.is_blocked === 'true';
  if (device && isBlocked) {
    return res.json({ ok: false, reason: 'blocked' });
  }

  // ----- COOLDOWN -----
  if (device?.cooldown_until && Date.now() < new Date(device.cooldown_until).getTime()) {
    return res.json({ ok: false, reason: 'cooldown', until: device.cooldown_until });
  }

  // ----- EXISTING USER -----
  const existingUser = device?.userid || null;

  // ----- NEED ID -----
  if (!existingUser && !userId) {
    return res.json({ ok: false, reason: 'need_id' });
  }

  const finalUser = existingUser || userId;

  // ----- USER ALREADY BOUND TO ANOTHER DEVICE -----
  const { data: userCheck } = await supabase
    .from('devices')
    .select('*')
    .eq('userid', finalUser)
    .maybeSingle();

  if (userCheck && userCheck.deviceid !== deviceId) {
    return res.json({ ok: false, reason: 'user_taken' });
  }

  // ----- SCAN LIMIT -----
  // FIX: Only block if scan_count >= max_scans AND there's no remaining
  // scan budget. When admin raises max_scans the user should be able to scan again.
  if (device && device.scan_count >= device.max_scans) {
    // If they're not already in a cooldown, start one now
    if (!device.cooldown_until || Date.now() >= new Date(device.cooldown_until).getTime()) {
      const cooldown = new Date(Date.now() + COOLDOWN_DURATION).toISOString();
      await supabase
        .from('devices')
        .update({ cooldown_until: cooldown })
        .eq('deviceid', deviceId);
      return res.json({ ok: false, reason: 'cooldown', until: cooldown });
    }
    return res.json({ ok: false, reason: 'cooldown', until: device.cooldown_until });
  }

  // ----- DUPLICATE CHECK FOR TODAY -----
  // FIX: Don't rely on locale string matching. Use a UTC date range so the
  // comparison is timezone-safe and format-independent.
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  const { data: already } = await supabase
    .from('attendance')
    .select('id')
    .eq('userid', finalUser)
    .gte('created_at', startOfDay.toISOString())
    .lte('created_at', endOfDay.toISOString())
    .limit(1);

  if (already && already.length > 0) {
    return res.json({ ok: false, reason: 'already_scanned' });
  }

  // ----- SAVE / UPDATE DEVICE -----
  if (!device) {
    const { error: insertError } = await supabase
      .from('devices')
      .insert([{
        deviceid: deviceId,
        userid: finalUser,
        scan_count: 1,
        max_scans: DEFAULT_MAX_SCANS,
        is_blocked: 'false',     // FIX: text column in Supabase
        cooldown_until: null
      }]);

    if (insertError) {
      console.error('[DEVICE INSERT ERROR]', insertError);
      return res.json({ ok: false, reason: 'db_error' });
    }
  } else {
    await supabase
      .from('devices')
      .update({ scan_count: device.scan_count + 1 })
      .eq('deviceid', deviceId);
  }

  // ----- SAVE ATTENDANCE -----
  const now = new Date();
  const entry = {
    userid: finalUser,
    deviceid: deviceId,
    date: now.toLocaleDateString('en-US'),
    fulltime: now.toLocaleString('en-US'),
    type: existingUser ? 'returning' : 'new'
  };

  const { error: attendanceError } = await supabase
    .from('attendance')
    .insert([entry]);

  if (attendanceError) {
    console.error('[ATTENDANCE INSERT ERROR]', attendanceError);
    return res.json({ ok: false, reason: 'db_error' });
  }

  console.log('[SUCCESS]', { userId: finalUser, type: entry.type });

  res.json({ ok: true, userId: finalUser, type: entry.type });
});

// ============================================
// LOG
// ============================================

app.get('/api/log', async (req, res) => {
  const { data, error } = await supabase
    .from('attendance')
    .select('*')
    .order('id', { ascending: false });

  if (error) {
    console.error('[LOG ERROR]', error);
    return res.json([]);
  }

  res.json(data);
});

// ============================================
// DEVICES
// ============================================

app.get('/api/devices', async (req, res) => {
  const { data, error } = await supabase
    .from('devices')
    .select('*')
    .order('scan_count', { ascending: false });

  if (error) {
    console.error('[DEVICES ERROR]', error);
    return res.json([]);
  }

  res.json(data);
});

// ============================================
// BLOCK DEVICE
// ============================================

app.post('/api/block-device', async (req, res) => {
  const { deviceId } = req.body;

  if (!deviceId) return res.json({ ok: false, reason: 'missing_deviceId' });

  const { error } = await supabase
    .from('devices')
    .update({ is_blocked: 'true' })   // FIX: column is text type in Supabase
    .eq('deviceid', deviceId);

  if (error) {
    console.error('[BLOCK ERROR]', error);
    return res.json({ ok: false, reason: 'db_error' });
  }

  console.log('[BLOCKED]', deviceId);
  res.json({ ok: true });
});

// ============================================
// UNBLOCK DEVICE
// ============================================

app.post('/api/unblock-device', async (req, res) => {
  const { deviceId } = req.body;

  if (!deviceId) return res.json({ ok: false, reason: 'missing_deviceId' });

  const { error } = await supabase
    .from('devices')
    .update({ is_blocked: 'false' })  // FIX: column is text type in Supabase
    .eq('deviceid', deviceId);

  if (error) {
    console.error('[UNBLOCK ERROR]', error);
    return res.json({ ok: false, reason: 'db_error' });
  }

  console.log('[UNBLOCKED]', deviceId);
  res.json({ ok: true });
});

// ============================================
// RESET COOLDOWN
// ============================================

app.post('/api/reset-cooldown', async (req, res) => {
  const { deviceId } = req.body;

  if (!deviceId) return res.json({ ok: false, reason: 'missing_deviceId' });

  const { error } = await supabase
    .from('devices')
    .update({ cooldown_until: null, scan_count: 0 })
    .eq('deviceid', deviceId);

  if (error) {
    console.error('[RESET COOLDOWN ERROR]', error);
    return res.json({ ok: false, reason: 'db_error' });
  }

  res.json({ ok: true });
});

// ============================================
// SET MAX SCANS
// ============================================

app.post('/api/set-max-scans', async (req, res) => {
  const { deviceId, maxScans } = req.body;

  if (!deviceId || maxScans == null) {
    return res.json({ ok: false, reason: 'missing_params' });
  }

  const { error } = await supabase
    .from('devices')
    .update({
      max_scans: Number(maxScans),
      cooldown_until: null   // FIX: clear any active cooldown when limit is raised
    })
    .eq('deviceid', deviceId);

  if (error) {
    console.error('[SET MAX SCANS ERROR]', error);
    return res.json({ ok: false, reason: 'db_error' });
  }

  res.json({ ok: true });
});

// ============================================
// RESET TOKEN
// ============================================

app.post('/api/reset-token', (req, res) => {
  activeToken = {
    token: crypto.randomUUID(),
    expires: Date.now() + TOKEN_TTL
  };

  console.log('[TOKEN FORCE RESET]', activeToken.token);
  res.json({ ok: true, token: activeToken.token, expires: activeToken.expires });
});

// ============================================
// HEALTH CHECK
// ============================================

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    tokenExpires: new Date(activeToken.expires).toISOString()
  });
});

// ============================================
// START
// ============================================

app.listen(PORT, () => {
  console.log('');
  console.log('=====================================');
  console.log(`  Server running on port ${PORT}`);
  console.log('=====================================');
  console.log('');
});
