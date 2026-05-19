const { createClient } =
require('@supabase/supabase-js');

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

// ============================================
// ACTIVE TOKEN
// ============================================

let activeToken = {
  token:'',
  expires:0
};

// ============================================
// TOKEN ROTATION
// ============================================

function rotateToken(){

  activeToken = {

    token:
      crypto.randomUUID(),

    expires:
      Date.now() + 35000

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

  setTimeout(rotateToken,35000);

}

rotateToken();

// ============================================
// GET TOKEN
// ============================================

app.get('/api/token',(req,res)=>{

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
// CHECK IN
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
  // GET DEVICE
  // ============================================

  const {
    data:device
  } = await supabase
    .from('devices')
    .select('*')
    .eq('deviceid', deviceId)
    .single();

  // ============================================
  // BLOCKED
  // ============================================

  if(device?.is_blocked){

    return res.json({
      ok:false,
      reason:'blocked'
    });

  }

  // ============================================
  // COOLDOWN
  // ============================================

  if(
    device?.cooldown_until &&
    Date.now() <
      new Date(device.cooldown_until)
  ){

    return res.json({
      ok:false,
      reason:'cooldown',
      until:device.cooldown_until
    });

  }

  // ============================================
  // EXISTING USER
  // ============================================

  const existingUser =
    device?.userid;

  // ============================================
  // NEED ID
  // ============================================

  if(!existingUser && !userId){

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
  // USER ALREADY USED
  // ============================================

  const {
    data:userCheck
  } = await supabase
    .from('devices')
    .select('*')
    .eq('userid', finalUser)
    .single();

  if(
    userCheck &&
    userCheck.deviceid !== deviceId
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
    device.scan_count >= device.max_scans
  ){

    const cooldown =
      new Date(
        Date.now() + 60*60*1000
      );

    await supabase
      .from('devices')
      .update({
        cooldown_until: cooldown
      })
      .eq('deviceid', deviceId);

    return res.json({
      ok:false,
      reason:'cooldown',
      until: cooldown
    });

  }

  // ============================================
  // TODAY
  // ============================================

  const today =
    new Date().toLocaleDateString();

  // ============================================
  // DUPLICATE CHECK
  // ============================================

  const {
    data:already
  } = await supabase
    .from('attendance')
    .select('*')
    .eq('userid', finalUser)
    .eq('date', today)
    .limit(1);

  if(already && already.length){

    return res.json({
      ok:false,
      reason:'already_scanned'
    });

  }

  // ============================================
  // SAVE DEVICE
  // ============================================

  if(!device){

    await supabase
      .from('devices')
      .insert([{

        deviceid: deviceId,

        userid: finalUser,

        scan_count:1,

        max_scans:2,

        is_blocked:false

      }]);

  }

  else{

    await supabase
      .from('devices')
      .update({

        scan_count:
          device.scan_count + 1

      })
      .eq('deviceid', deviceId);

  }

  // ============================================
  // ENTRY
  // ============================================

  const now = new Date();

  const entry = {

    userid: finalUser,

    deviceid: deviceId,

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
    error
  } = await supabase
    .from('attendance')
    .insert([entry]);

  if(error){

    console.log(error);

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
// LOG
// ============================================

app.get('/api/log', async (req,res)=>{

  const {
    data,
    error
  } = await supabase
    .from('attendance')
    .select('*')
    .order('id',{
      ascending:false
    });

  if(error){

    return res.json([]);

  }

  res.json(data);

});

// ============================================
// DEVICES
// ============================================

app.get('/api/devices', async (req,res)=>{

  const {
    data
  } = await supabase
    .from('devices')
    .select('*')
    .order('scan_count',{
      ascending:false
    });

  res.json(data);

});

// ============================================
// BLOCK DEVICE
// ============================================

app.post('/api/block-device', async (req,res)=>{

  const { deviceId } = req.body;

  await supabase
    .from('devices')
    .update({
      is_blocked:true
    })
    .eq('deviceid', deviceId);

  res.json({
    ok:true
  });

});

// ============================================
// UNBLOCK DEVICE
// ============================================

app.post('/api/unblock-device', async (req,res)=>{

  const { deviceId } = req.body;

  await supabase
    .from('devices')
    .update({
      is_blocked:false
    })
    .eq('deviceid', deviceId);

  res.json({
    ok:true
  });

});

// ============================================
// RESET COOLDOWN
// ============================================

app.post('/api/reset-cooldown', async (req,res)=>{

  const { deviceId } = req.body;

  await supabase
    .from('devices')
    .update({

      cooldown_until:null,
      scan_count:0

    })
    .eq('deviceid', deviceId);

  res.json({
    ok:true
  });

});

// ============================================
// CHANGE MAX SCANS
// ============================================

app.post('/api/set-max-scans', async (req,res)=>{

  const {
    deviceId,
    maxScans
  } = req.body;

  await supabase
    .from('devices')
    .update({
      max_scans:maxScans
    })
    .eq('deviceid', deviceId);

  res.json({
    ok:true
  });

});

// ============================================
// RESET TOKEN
// ============================================

app.post('/api/reset-token',(req,res)=>{

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
// START
// ============================================

app.listen(PORT,()=>{

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
