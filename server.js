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
const devices = {};

// ============================================
// GENERATE NEW TOKEN EVERY 10 SECONDS
// ============================================

function rotateToken() {

  activeToken = {
    token: crypto.randomUUID(),
    expires: Date.now() + 10000
  };

  console.log('--------------------------------');
  console.log('NEW TOKEN:', activeToken.token);
  console.log('EXPIRES:', new Date(activeToken.expires));
  console.log('--------------------------------');

  setTimeout(rotateToken, 10000);
}

rotateToken();

// ============================================
// GET CURRENT TOKEN
// ============================================

app.get('/api/token', (req, res) => {

  res.json({
    token: activeToken.token,
    expires: activeToken.expires,

    // CHANGE THIS TO YOUR LOCAL IP
    url:
      `https://qr-attendance-frontend2.vercel.app/${activeToken.token}`
  });

});

// ============================================
// CHECK-IN
// ============================================

app.post('/api/checkin', (req, res) => {

  const { token, deviceId, userId } = req.body;

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
  }

  // SAVE LOG
  const entry = {
    userId: finalUser,
    deviceId,
    time: new Date(),
    type: existingUser ? 'returning' : 'new'
  };

  attendanceLog.push(entry);

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
// START SERVER
// ============================================

app.listen(PORT, () => {

  console.log('');
  console.log('====================================');
  console.log(`Server running on port ${PORT}`);
  console.log('====================================');
  console.log('');

});