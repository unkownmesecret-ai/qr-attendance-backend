const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());

// ============================================
// CONFIG
// ============================================

const PORT = process.env.PORT || 3000;

// ============================================
// ACTIVE QR TOKEN
// ============================================

let activeToken = {
  token: '',
  expires: 0
};

// ============================================
// TEMP DATABASE (MEMORY)
// ============================================

const attendanceLog = [];

// DEVICE -> USER
const devices = {};

// USER -> DEVICE
const users = {};

// DEVICE SCAN COUNTS
const scanCounts = {};

// ============================================
// GENERATE NEW TOKEN EVERY 10 SECONDS
// ============================================

function rotateToken() {

  activeToken = {
    token: crypto.randomUUID(),
    expires: Date.now() + 35000
  };

  console.log('--------------------------------');
  console.log('NEW TOKEN:', activeToken.token);
  console.log('EXPIRES:', new Date(activeToken.expires));
  console.log('--------------------------------');

  setTimeout(rotateToken, 35000);
}

rotateToken();

// ============================================
// GET CURRENT TOKEN
// ============================================

app.get('/api/token', (req, res) => {

  res.json({
    token: activeToken.token,
    expires: activeToken.expires,
    url:
      `https://qr-attendance-frontend2.vercel.app/?scan=1&t=${activeToken.token}`
  });

});

// ============================================
// CHECK-IN
// ============================================

app.post('/api/checkin', (req, res) => {

  const { token, deviceId, userId } = req.body;
// ============================================
// SCAN LIMIT
// ============================================

if (!scanCounts[deviceId]) {
  scanCounts[deviceId] = 0;
}

if (scanCounts[deviceId] >= 2) {

  return res.json({
    ok: false,
    reason: 'scan_limit'
  });

}
  // TOKEN VALIDATION
  if (
    token !== activeToken.token ||
    Date.now() > activeToken.expires
  ) {

    return res.json({
      ok: false,
      reason: 'expired'
    });

  }

  // EXISTING DEVICE
  const existingUser = devices[deviceId];
// ============================================
// USER ALREADY REGISTERED TO ANOTHER DEVICE
// ============================================

if (
  userId &&
  users[userId] &&
  users[userId] !== deviceId
) {

  return res.json({
    ok: false,
    reason: 'user_taken'
  });

}
  // USE EXISTING USER IF DEVICE KNOWN
  const finalUser = existingUser || userId;

  // FIRST TIME USER WITHOUT ID
  if (!finalUser) {

    return res.json({
      ok: false,
      reason: 'need_id'
    });

  }

  // REGISTER DEVICE
  if (!existingUser) {

  devices[deviceId] = userId;

  users[userId] = deviceId;

}

  // SAVE LOG
const now = new Date();

const entry = {

  userId: finalUser,

  deviceId,

  time: now,

  date:
    now.toLocaleDateString(),

  fullTime:
    now.toLocaleString(),

  type:
    existingUser
      ? 'returning'
      : 'new'

};
  attendanceLog.push(entry);
scanCounts[deviceId]++;
  console.log('CHECK-IN:', entry);

  // SUCCESS
  res.json({
    ok: true,
    userId: finalUser,
    type: existingUser ? 'returning' : 'new'
  });

});

// ============================================
// GET LOG
// ============================================

app.get('/api/log', (req, res) => {

  res.json(attendanceLog);

});
// ============================================
// FORCE RESET TOKEN
// ============================================

app.post('/api/reset-token', (req,res)=>{

  activeToken = {
    token: crypto.randomUUID(),
    expires: Date.now() + 35000
  };

  console.log('TOKEN FORCE RESET');

  res.json({
    ok:true
  });

});
// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {

  console.log('');
  console.log('====================================');
  console.log(`Server running on port ${PORT}`);
  console.log('====================================');
  console.log('');

});
