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

const QR_LIFETIME = 35000;

const COOLDOWN_HOURS = 1;

// ============================================
// ACTIVE TOKEN
// ============================================

let activeToken = {
  token: '',
  expires: 0
};

// ============================================
// TOKEN ROTATION
// ============================================

function rotateToken(){

  activeToken = {

    token:
      crypto.randomUUID(),

    expires:
      Date.now() + QR_LIFETIME

  };

  console.log('--------------------------------');

  console.log(
    'NEW TOKEN:',
    activeToken.token
  );

  console.log(
    'EXPIRES:',
    new Date(activeToken.expires)
  );

  console.log('--------------------------------');

  setTimeout(
    rotateToken,
    QR_LIFETIME
  );

}

rotateToken();

// ============================================
// GET TOKEN
// ============================================

app.get('/api/token', (req,res)=>{

  res.json({

    token:
      activeToken.token,

    expires:
      activeToken.expires,

    url:
`https://qr-attendance-frontend2.vercel.app/?scan=1&t=${activeToken.token}`

  });

});

// ============================================
// CHECKIN
// ============================================

app.post('/api/checkin', async (req,res)=>{

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

  if(
    token !== activeToken.token ||
    Date.now() > activeToken.expires
  ){

    return res.json({

      ok:false,
      reason:'expired'

    });

  }

  // ============================================
  // FIND DEVICE
  // ============================================

  const {
    data: device,
    error: deviceError
  } = await supabase

    .from('devices')

    .select('*')

    .eq('deviceid', deviceId)

    .single();

  if(
    deviceError &&
    deviceError.code !== 'PGRST116'
  ){

    console.log(
      'DEVICE LOOKUP ERROR:',
      deviceError
    );

  }

  // ============================================
  // BLOCKED DEVICE
  // ============================================

  if(device?.is_blocked){

    return res.json({

      ok:false,
      reason:'blocked'

    });

  }

  // ============================================
  // COOLDOWN CHECK
  // ============================================

  if(
    device?.cooldown_until &&
    Date.now() <
      new Date(device.cooldown_until)
  ){

    return res.json({

      ok:false,

      reason:'cooldown',

      until:
        device.cooldown_until

    });

  }

  // ============================================
  // EXISTING USER
  // ============================================

  const existingUser =
    device?.userid;

  // ============================================
  // NEED USER ID
  // ============================================

  if(
    !existingUser &&
    !userId
  ){

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
  // PREVENT SAME USER
  // ON DIFFERENT DEVICE
  // ============================================

  const {
    data: sameUser
  } = await supabase

    .from('devices')

    .select('*')

    .eq('userid', finalUser)

    .single();

  if(
    sameUser &&
    sameUser.deviceid !== deviceId
  ){

    return res.json({

      ok:false,
      reason:'user_taken'

    });

  }

  // ============================================
  // SCAN LIMIT
  // ============================================

  if(
    device &&
    device.scan_count >=
    device.max_scans
  ){

    const cooldown =
      new Date(
        Date.now() +
        COOLDOWN_HOURS *
        60 *
        60 *
        1000
      );

    await supabase

      .from('devices')

      .update({

        cooldown_until:
          cooldown

      })

      .eq(
        'deviceid',
        deviceId
      );

    return res.json({

      ok:false,

      reason:'cooldown',

      until: cooldown

    });

  }

  // ============================================
  // PREVENT DUPLICATE
  // SAME DAY
  // ============================================

  const today =
    new Date()
      .toLocaleDateString();

  const {
    data: alreadyScanned
  } = await supabase

    .from('attendance')

    .select('*')

    .eq('userid', finalUser)

    .eq('date', today)

    .limit(1);

  if(
    alreadyScanned &&
    alreadyScanned.length > 0
  ){

    return res.json({

      ok:false,
      reason:'already_scanned'

    });

  }

  // ============================================
  // CREATE DEVICE
  // ============================================

  if(!device){

    const {
      error: insertError
    } = await supabase

      .from('devices')

      .insert([{

        deviceid:
          deviceId,

        userid:
          finalUser,

        scan_count: 1,

        max_scans: 2,

        is_blocked:false

      }]);

    if(insertError){

      console.log(
        'DEVICE INSERT ERROR:',
        insertError
      );

    }

  }

  // ============================================
  // UPDATE DEVICE
  // ============================================

  else{

    const {
      error: updateError
    } = await supabase

      .from('devices')

      .update({

        scan_count:
          device.scan_count + 1

      })

      .eq(
        'deviceid',
        deviceId
      );

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

    userid:
      finalUser,

    deviceid:
      deviceId,

    date:
      now.toLocaleDateString(),

    fulltime:
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

  console.log(
    'ATTENDANCE ENTRY:',
    entry
  );

  console.log(
    'INSERT ERROR:',
    error
  );

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

    userId:
      finalUser,

    type:
      existingUser
        ? 'returning'
        : 'new'

  });

});

// ============================================
// GET LOG
// ============================================

app.get('/api/log', async (req,res)=>{

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
      'LOG ERROR:',
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
      Date.now() + QR_LIFETIME

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

app.listen(PORT, ()=>{

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
