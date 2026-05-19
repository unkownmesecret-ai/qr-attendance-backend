const { createClient } =
require('@supabase/supabase-js');

const supabase = createClient(
  'https://ineujzimrapgjcpbtdue.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImluZXVqemltcmFwZ2pjcGJ0ZHVlIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTIwODgxNSwiZXhwIjoyMDk0Nzg0ODE1fQ.56lseaP69aWd99Bar_FBVEk4SMVePmadTng0RhE8M60'
);

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
// TOKEN ROTATION
// ============================================

function rotateToken() {

  activeToken = {
    token: crypto.randomUUID(),
    expires: Date.now() + 35000
  };

  console.log('--------------------------------');
  console.log('NEW TOKEN:', activeToken.token);
  console.log(
    'EXPIRES:',
    new Date(activeToken.expires)
  );
  console.log('--------------------------------');

  setTimeout(rotateToken, 35000);

}

rotateToken();

// ============================================
// GET TOKEN
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

app.post('/api/checkin', async (req, res) => {

  console.log(
    'CHECKIN REQUEST:',
    req.body
  );

  const {
    token,
    deviceId,
    userId
  } = req.body;

  // ============================================
  // TOKEN VALIDATION
  // ============================================

  if (
    token !== activeToken.token ||
    Date.now() > activeToken.expires
  ) {

    return res.json({
      ok:false,
      reason:'expired'
    });

  }

  // ============================================
  // FIND DEVICE
  // ============================================

  const {
    data: existingDevice,
    error: deviceError
  } = await supabase
    .from('devices')
    .select('*')
    .eq('deviceId', deviceId)
    .single();

  if (deviceError &&
      deviceError.code !== 'PGRST116') {

    console.log(
      'DEVICE LOOKUP ERROR:',
      deviceError
    );

  }

  // ============================================
  // EXISTING USER FOR DEVICE
  // ============================================

  const existingUser =
    existingDevice?.userId;

  // ============================================
  // FIRST SCAN WITHOUT USER ID
  // ============================================

  if (!existingUser && !userId) {

    return res.json({
      ok:false,
      reason:'need_id'
    });

  }

  // ============================================
  // FINAL USER
  // ============================================

  const finalUser =
    existingUser || userId;

  // ============================================
  // PREVENT USER ON ANOTHER DEVICE
  // ============================================

  const {
    data: sameUser
  } = await supabase
    .from('devices')
    .select('*')
    .eq('userId', finalUser)
    .single();

  if (
    sameUser &&
    sameUser.deviceId !== deviceId
  ) {

    return res.json({
      ok:false,
      reason:'user_taken'
    });

  }

  // ============================================
  // SCAN LIMIT
  // ============================================

  if (
    existingDevice &&
    existingDevice.scanCount >= 2
  ) {

    return res.json({
      ok:false,
      reason:'scan_limit'
    });

  }

  // ============================================
  // PREVENT DUPLICATE ATTENDANCE
  // ============================================

  const today =
    new Date().toLocaleDateString();

  const {
    data: alreadyScanned
  } = await supabase
    .from('attendance')
    .select('*')
    .eq('userId', finalUser)
    .eq('date', today)
    .limit(1);

  if (
    alreadyScanned &&
    alreadyScanned.length > 0
  ) {

    return res.json({
      ok:false,
      reason:'already_scanned'
    });

  }

  // ============================================
  // SAVE OR UPDATE DEVICE
  // ============================================

  if (!existingDevice) {

    const {
      error: insertDeviceError
    } = await supabase
      .from('devices')
      .insert([{

        deviceId,
        userId: finalUser,
        scanCount:1

      }]);

    if(insertDeviceError){

      console.log(
        'DEVICE INSERT ERROR:',
        insertDeviceError
      );

    }

  } else {

    const {
      error: updateError
    } = await supabase
      .from('devices')
      .update({

        scanCount:
          existingDevice.scanCount + 1

      })
      .eq('deviceId', deviceId);

    if(updateError){

      console.log(
        'DEVICE UPDATE ERROR:',
        updateError
      );

    }

  }

  // ============================================
  // CREATE ATTENDANCE ENTRY
  // ============================================

  const now = new Date();

  const entry = {

    userId: finalUser,

    deviceId,

    date:
      now.toLocaleDateString(),

    fullTime:
      now.toLocaleString(),

    type:
      existingUser
        ? 'returning'
        : 'new'

  };

  // ============================================
  // SAVE ATTENDANCE
  // ============================================

  const {
    data,
    error
  } = await supabase
    .from('attendance')
    .insert([entry]);

  console.log('ENTRY:', entry);

  console.log('INSERT DATA:', data);

  console.log('INSERT ERROR:', error);

  if(error){

    return res.json({
      ok:false,
      reason:'db_error'
    });

  }

  // ============================================
  // SUCCESS
  // ============================================

  res.json({

    ok:true,

    userId: finalUser,

    type:
      existingUser
        ? 'returning'
        : 'new'

  });

});

// ============================================
// GET LOG
// ============================================

app.get('/api/log', async (req, res) => {

  const {
    data,
    error
  } = await supabase
    .from('attendance')
    .select('*')
    .order('id', {
      ascending:false
    });

  if(error){

    console.log(
      'SUPABASE ERROR:',
      error
    );

    return res.json([]);

  }

  res.json(data);

});

// ============================================
// FORCE RESET TOKEN
// ============================================

app.post('/api/reset-token', (req,res)=>{

  activeToken = {

    token:
      crypto.randomUUID(),

    expires:
      Date.now() + 35000

  };

  console.log(
    'TOKEN FORCE RESET'
  );

  res.json({
    ok:true
  });

});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {

  console.log('');
  console.log(
    '===================================='
  );

  console.log(
    `Server running on port ${PORT}`
  );

  console.log(
    '===================================='
  );

  console.log('');

});
