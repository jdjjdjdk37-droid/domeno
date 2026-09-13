// ==============================================
// خادم لعبة الدومينو - Railway Ready v3.1
// + رفع الصور عبر Firebase Storage
// ==============================================
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const admin = require('firebase-admin');
const { DominoGame } = require('./dominoGameLogic');

// =========================================
// إعداد التطبيق
// =========================================
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST"],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// خدمة ملفات APK الثابتة
app.use('/downloads', express.static(path.join(__dirname, 'public/downloads')));

// =========================================
// 🔥 إعداد Firebase Admin (Firestore + Storage)
// =========================================
let db = null;
let bucket = null;
let firebaseReady = false;

try {
  if (process.env.FIREBASE_PROJECT_ID && 
      process.env.FIREBASE_CLIENT_EMAIL && 
      process.env.FIREBASE_PRIVATE_KEY) {
    
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 
                     `${process.env.FIREBASE_PROJECT_ID}.appspot.com`,
    });
    
    db = admin.firestore();
    bucket = admin.storage().bucket();
    firebaseReady = true;
    console.log('✅ Firebase Admin جاهز (Firestore + Storage)');
    console.log(`🪣 Storage Bucket: ${bucket.name}`);
  } else {
    console.log('⚠️ متغيرات Firebase غير مكتملة - ستعمل اللعبة بدون حفظ النتائج أو رفع الصور');
  }
} catch (err) {
  console.error('❌ فشل تهيئة Firebase:', err.message);
}

// =========================================
// 📸 إعداد multer للرفع في الذاكرة
// =========================================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 ميجا
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('نوع الصورة غير مدعوم'));
    }
  },
});

// =========================================
// تخزين الغرف في الذاكرة
// =========================================
const rooms = new Map();
const playerRooms = new Map();

// =========================================
// ⏸️ OTA معطّل مؤقتاً
// =========================================
const OTA_ENABLED = false;

const LATEST_VERSION = {
  versionCode: 2,
  versionName: "2.1.0",
  apkUrl: `${process.env.PUBLIC_URL || 'https://domino-server-production-e9af.up.railway.app'}/downloads/domino-v2.1.0.apk`,
  changelog: "🎉 الجديد:\n• تسجيل دخول\n• أصدقاء\n• دردشة\n• إشعارات",
  isMandatory: false,
  releaseDate: "2026-09-13",
  minSupportedVersion: 1,
};

// =========================================
// 🔥 إغلاق الغرفة
// =========================================
function closeRoom(roomId, reason = "انتهت اللعبة") {
  const game = rooms.get(roomId);
  if (!game) return;

  console.log(`🔒 إغلاق الغرفة ${roomId} - السبب: ${reason}`);

  io.to(roomId).emit('room_closed', {
    roomId,
    reason,
    message: reason
  });

  game.players.forEach(p => {
    playerRooms.delete(p.id);
  });

  io.sockets.sockets.forEach(socket => {
    if (socket.rooms.has(roomId)) {
      socket.leave(roomId);
    }
  });

  rooms.delete(roomId);
  console.log(`🗑️ تم حذف الغرفة ${roomId} | الغرف المتبقية: ${rooms.size}`);
}

// =========================================
// 🧹 تنظيف الغرف المهملة
// =========================================
setInterval(() => {
  const now = Date.now();
  const MAX_IDLE_TIME = 10 * 60 * 1000;
  const MAX_GAME_AGE = 3 * 60 * 60 * 1000;

  rooms.forEach((game, roomId) => {
    const lastActivity = game.lastActivity || game.createdAt;

    if (game.gameStatus === "finished") {
      closeRoom(roomId, "🏆 انتهت اللعبة");
      return;
    }

    if (now - lastActivity > MAX_IDLE_TIME) {
      closeRoom(roomId, "⏱️ انتهت مدة الانتظار");
      return;
    }

    if (now - game.createdAt > MAX_GAME_AGE) {
      closeRoom(roomId, "⌛ الغرفة قديمة");
      return;
    }

    const connectedPlayers = game.players.filter(p => p.connected);
    if (connectedPlayers.length === 0) {
      closeRoom(roomId, "👋 غادر جميع اللاعبين");
    }
  });
}, 60 * 1000);

// =========================================
// 🌐 Endpoints
// =========================================

app.get('/', (req, res) => {
  res.json({
    name: "🎲 Domino Server",
    status: "online",
    version: "3.1.0",
    activeRooms: rooms.size,
    activePlayers: playerRooms.size,
    uptime: Math.floor(process.uptime()) + "s",
    otaEnabled: OTA_ENABLED,
    firebaseReady: firebaseReady,
    storageReady: !!bucket,
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    rooms: rooms.size,
    players: playerRooms.size,
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB",
    uptime: Math.floor(process.uptime()) + "s",
    otaEnabled: OTA_ENABLED,
    firebaseReady: firebaseReady,
    storageReady: !!bucket,
  });
});

app.get('/rooms', (req, res) => {
  const list = [];
  rooms.forEach((game, roomId) => {
    if (game.gameStatus === "waiting") {
      list.push({
        roomId,
        mode: game.mode,
        players: game.players.length,
        maxPlayers: game.mode === "2v2" ? 4 : 2,
        hostName: game.players[0]?.name,
        createdAt: game.createdAt,
      });
    }
  });
  res.json({ rooms: list, count: list.length });
});

// =========================================
// 📸 رفع الصور - Endpoints جديدة
// =========================================

// رفع صورة عامة (صورة اللاعب، الخلفية، إلخ)
app.post('/api/upload', upload.single('image'), async (req, res) => {
  if (!bucket) {
    return res.status(503).json({ 
      success: false, 
      error: "خدمة تخزين الصور غير مفعّلة (Firebase Storage غير مهيأ)" 
    });
  }

  if (!req.file) {
    return res.status(400).json({ success: false, error: "لم يتم إرسال أي صورة" });
  }

  try {
    const folder = (req.body.folder || 'general').replace(/[^a-zA-Z0-9_-]/g, '');
    const ext = req.file.mimetype.split('/')[1];
    const fileName = `uploads/${folder}/${Date.now()}-${uuidv4()}.${ext}`;
    const file = bucket.file(fileName);

    await file.save(req.file.buffer, {
      metadata: {
        contentType: req.file.mimetype,
        cacheControl: 'public, max-age=31536000',
      },
      resumable: false,
      public: true,
    });

    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;

    console.log(`📸 تم رفع صورة: ${fileName} (${req.file.size} bytes)`);

    res.json({
      success: true,
      url: publicUrl,
      fileName,
      size: req.file.size,
      mimeType: req.file.mimetype,
    });
  } catch (err) {
    console.error('❌ فشل رفع الصورة:', err.message);
    res.status(500).json({ success: false, error: "فشل رفع الصورة: " + err.message });
  }
});

// رفع صورة شخصية للاعب (avatar)
app.post('/api/upload-avatar', upload.single('image'), async (req, res) => {
  if (!bucket) {
    return res.status(503).json({ 
      success: false, 
      error: "خدمة تخزين الصور غير مفعّلة" 
    });
  }

  if (!req.file) {
    return res.status(400).json({ success: false, error: "لم يتم إرسال صورة" });
  }

  const playerName = (req.body.playerName || 'guest').replace(/[^a-zA-Z0-9_\u0600-\u06FF]/g, '');

  try {
    const ext = req.file.mimetype.split('/')[1];
    const fileName = `avatars/${playerName}-${Date.now()}.${ext}`;
    const file = bucket.file(fileName);

    await file.save(req.file.buffer, {
      metadata: {
        contentType: req.file.mimetype,
        cacheControl: 'public, max-age=31536000',
      },
      resumable: false,
      public: true,
    });

    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;

    // حفظ الرابط في Firestore إذا كان متاحاً
    if (db) {
      try {
        const snapshot = await db.collection('users_stats')
          .where('name', '==', playerName)
          .limit(1)
          .get();

        if (!snapshot.empty) {
          await snapshot.docs[0].ref.update({ 
            avatarUrl: publicUrl,
            avatarUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        } else {
          await db.collection('users_stats').add({
            name: playerName,
            avatarUrl: publicUrl,
            wins: 0,
            losses: 0,
            totalScore: 0,
            longestStreak: 0,
            currentStreak: 0,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      } catch (dbErr) {
        console.error('⚠️ فشل تحديث Firestore:', dbErr.message);
      }
    }

    console.log(`🖼️ تم رفع صورة شخصية: ${playerName} → ${publicUrl}`);

    res.json({
      success: true,
      url: publicUrl,
      playerName,
    });
  } catch (err) {
    console.error('❌ فشل رفع الصورة الشخصية:', err.message);
    res.status(500).json({ success: false, error: "فشل رفع الصورة" });
  }
});

// حذف صورة (اختياري - للحماية)
app.delete('/api/delete-image', async (req, res) => {
  if (!bucket) return res.status(503).json({ error: "غير مفعّل" });
  
  const { fileName } = req.body;
  if (!fileName || !fileName.startsWith('uploads/') && !fileName.startsWith('avatars/')) {
    return res.status(400).json({ error: "اسم ملف غير صالح" });
  }

  try {
    await bucket.file(fileName).delete();
    res.json({ success: true, message: "تم حذف الصورة" });
  } catch (err) {
    res.status(500).json({ error: "فشل الحذف: " + err.message });
  }
});

// =========================================
// 🎯 OTA Endpoint (معطّل حالياً)
// =========================================
app.get('/api/check-update', (req, res) => {
  if (!OTA_ENABLED) {
    return res.json({ 
      updateAvailable: false,
      message: "لا يوجد تحديث حالياً"
    });
  }

  const clientVersion = parseInt(req.query.versionCode) || 0;
  const apkPath = path.join(__dirname, 'public/downloads/domino-v2.1.0.apk');
  const apkExists = fs.existsSync(apkPath);

  if (!apkExists) {
    return res.json({ 
      updateAvailable: false,
      message: "لا يوجد ملف تحديث متاح حالياً"
    });
  }

  if (clientVersion >= LATEST_VERSION.versionCode) {
    return res.json({
      updateAvailable: false,
      currentVersion: LATEST_VERSION.versionName,
    });
  }

  console.log(`📱 فحص تحديث: version=${clientVersion}`);
  res.json({
    updateAvailable: true,
    versionCode: LATEST_VERSION.versionCode,
    versionName: LATEST_VERSION.versionName,
    apkUrl: LATEST_VERSION.apkUrl,
    changelog: LATEST_VERSION.changelog,
    isMandatory: clientVersion < LATEST_VERSION.minSupportedVersion,
    releaseDate: LATEST_VERSION.releaseDate,
    minSupportedVersion: LATEST_VERSION.minSupportedVersion,
    apkSize: fs.statSync(apkPath).size,
  });
});

// =========================================
// 💾 دوال Firebase
// =========================================
async function saveMatch(matchData) {
  if (!firebaseReady) return;
  try {
    await db.collection('matches').add({
      ...matchData,
      finishedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log('✅ تم حفظ المباراة في Firestore');
  } catch (err) {
    console.error('❌ فشل حفظ المباراة:', err.message);
  }
}

async function updateUserStats(playerName, won, score) {
  if (!firebaseReady) return;
  try {
    const snapshot = await db.collection('users_stats')
      .where('name', '==', playerName)
      .limit(1)
      .get();

    if (snapshot.empty) {
      await db.collection('users_stats').add({
        name: playerName,
        wins: won ? 1 : 0,
        losses: won ? 0 : 1,
        totalScore: score,
        longestStreak: won ? 1 : 0,
        currentStreak: won ? 1 : 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      const doc = snapshot.docs[0];
      const data = doc.data();
      const newStreak = won ? (data.currentStreak || 0) + 1 : 0;
      
      await doc.ref.update({
        wins: (data.wins || 0) + (won ? 1 : 0),
        losses: (data.losses || 0) + (won ? 0 : 1),
        totalScore: (data.totalScore || 0) + score,
        currentStreak: newStreak,
        longestStreak: Math.max(data.longestStreak || 0, newStreak),
        lastPlayed: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  } catch (err) {
    console.error('❌ فشل تحديث الإحصائيات:', err.message);
  }
}

async function updateLeaderboard() {
  if (!firebaseReady) return;
  try {
    const snapshot = await db.collection('users_stats')
      .orderBy('totalScore', 'desc')
      .limit(100)
      .get();

    const batch = db.batch();
    const leaderboardRef = db.collection('leaderboard');
    
    const oldSnapshot = await leaderboardRef.get();
    oldSnapshot.docs.forEach(doc => batch.delete(doc.ref));
    
    snapshot.docs.forEach((doc, index) => {
      const newRef = leaderboardRef.doc();
      batch.set(newRef, {
        rank: index + 1,
        ...doc.data(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    await batch.commit();
    console.log('✅ تم تحديث Leaderboard');
  } catch (err) {
    console.error('❌ فشل تحديث Leaderboard:', err.message);
  }
}

// =========================================
// 🔌 WebSocket Events
// =========================================
io.on('connection', (socket) => {
  console.log(`✅ لاعب متصل: ${socket.id} | إجمالي: ${io.engine.clientsCount}`);

  socket.on('create_room', ({ playerName, mode = "1v1" }, callback) => {
    try {
      const roomId = uuidv4().slice(0, 6).toUpperCase();
      const game = new DominoGame(roomId, mode, socket.id, playerName);
      game.lastActivity = Date.now();
      
      rooms.set(roomId, game);
      playerRooms.set(socket.id, roomId);
      socket.join(roomId);

      console.log(`🏠 غرفة جديدة: ${roomId} بواسطة ${playerName}`);

      callback({
        success: true,
        roomId,
        game: game.getPublicState(socket.id),
      });
    } catch (err) {
      console.error("خطأ إنشاء غرفة:", err);
      callback({ error: "فشل إنشاء الغرفة" });
    }
  });

  socket.on('join_room', ({ roomId, playerName }, callback) => {
    try {
      const game = rooms.get(roomId.toUpperCase());
      if (!game) return callback({ error: "الغرفة غير موجودة أو مُغلقة" });
      if (game.isFull()) return callback({ error: "الغرفة ممتلئة" });
      if (game.hasPlayer(socket.id)) {
        return callback({ error: "أنت بالفعل في الغرفة" });
      }

      game.addPlayer(socket.id, playerName);
      game.lastActivity = Date.now();
      playerRooms.set(socket.id, roomId);
      socket.join(roomId);

      console.log(`👤 ${playerName} انضم إلى ${roomId}`);

      io.to(roomId).emit('player_joined', {
        playerId: socket.id,
        playerName,
        game: game.getPublicState(),
      });

      if (game.isFull() && game.gameStatus === "waiting") {
        game.startRound();
        io.to(roomId).emit('game_started', { message: "🎲 بدأت اللعبة!" });
        game.players.forEach(p => {
          io.to(p.id).emit('game_state', game.getPublicState(p.id));
        });
      }

      callback({
        success: true,
        roomId,
        game: game.getPublicState(socket.id),
      });
    } catch (err) {
      console.error("خطأ الانضمام:", err);
      callback({ error: "فشل الانضمام للغرفة" });
    }
  });

  socket.on('play_tile', ({ roomId, tile, side }, callback) => {
    try {
      const game = rooms.get(roomId);
      if (!game) return callback?.({ error: "الغرفة غير موجودة" });

      game.lastActivity = Date.now();
      const result = game.playTile(socket.id, tile, side);
      if (result.error) return callback?.({ error: result.error });

      game.players.forEach(p => {
        io.to(p.id).emit('game_state', game.getPublicState(p.id));
      });

      if (result.gameEnded) {
        io.to(roomId).emit('round_ended', game.lastAction);
        
        if (game.gameStatus === "finished") {
          const winner = game.players.find(p => p.score >= game.maxScore);
          io.to(roomId).emit('game_ended', {
            winner: winner?.name,
            scores: game.players.map(p => ({ name: p.name, score: p.score })),
          });
          
          if (firebaseReady) {
            saveMatch({
              roomId,
              mode: game.mode,
              players: game.players.map(p => ({ name: p.name, score: p.score })),
              winner: winner?.name,
              duration: Date.now() - game.createdAt,
              createdAt: new Date(game.createdAt).toISOString(),
            });
            
            game.players.forEach(p => {
              updateUserStats(p.name, p.id === winner?.id, p.score);
            });
            
            updateLeaderboard();
          }
          
          setTimeout(() => closeRoom(roomId, "🏆 انتهت اللعبة"), 30000);
        }
      }

      callback?.({ success: true });
    } catch (err) {
      console.error("خطأ اللعب:", err);
      callback?.({ error: "فشل تنفيذ الحركة" });
    }
  });

  socket.on('draw_tile', ({ roomId }, callback) => {
    try {
      const game = rooms.get(roomId);
      if (!game) return callback?.({ error: "الغرفة غير موجودة" });

      game.lastActivity = Date.now();
      const result = game.drawTile(socket.id);
      if (result.error) return callback?.({ error: result.error });

      game.players.forEach(p => {
        io.to(p.id).emit('game_state', game.getPublicState(p.id));
      });

      callback?.({ success: true, tile: result.tile });
    } catch (err) {
      callback?.({ error: "فشل السحب" });
    }
  });

  socket.on('pass_turn', ({ roomId }, callback) => {
    try {
      const game = rooms.get(roomId);
      if (!game) return callback?.({ error: "الغرفة غير موجودة" });

      game.lastActivity = Date.now();
      const result = game.passTurn(socket.id);
      if (result.error) return callback?.({ error: result.error });

      game.players.forEach(p => {
        io.to(p.id).emit('game_state', game.getPublicState(p.id));
      });

      if (result.gameEnded) {
        io.to(roomId).emit('round_ended', game.lastAction);
      }

      callback?.({ success: true });
    } catch (err) {
      callback?.({ error: "فشل التمرير" });
    }
  });

  socket.on('new_round', ({ roomId }, callback) => {
    try {
      const game = rooms.get(roomId);
      if (!game) return callback?.({ error: "الغرفة غير موجودة" });

      game.lastActivity = Date.now();
      const result = game.newRound();
      if (result.error) return callback?.({ error: result.error });

      game.players.forEach(p => {
        io.to(p.id).emit('game_state', game.getPublicState(p.id));
      });

      callback?.({ success: true });
    } catch (err) {
      callback?.({ error: "فشل بدء جولة جديدة" });
    }
  });

  socket.on('send_message', ({ roomId, text, type = "text" }) => {
    const game = rooms.get(roomId);
    if (!game) return;

    const player = game.players.find(p => p.id === socket.id);
    if (!player) return;

    io.to(roomId).emit('chat_message', {
      playerId: socket.id,
      playerName: player.name,
      text: text.substring(0, 100),
      type,
      timestamp: Date.now(),
    });
  });

  socket.on('leave_room', ({ roomId }) => {
    handlePlayerLeave(socket, roomId);
  });

  socket.on('disconnect', () => {
    console.log(`❌ قطع اتصال: ${socket.id}`);
    const roomId = playerRooms.get(socket.id);
    if (roomId) handlePlayerLeave(socket, roomId);
  });
});

// =========================================
// معالجة مغادرة اللاعب
// =========================================
function handlePlayerLeave(socket, roomId) {
  const game = rooms.get(roomId);
  if (!game) return;

  game.markDisconnected(socket.id);
  game.lastActivity = Date.now();
  socket.leave(roomId);
  playerRooms.delete(socket.id);

  io.to(roomId).emit('player_left', {
    playerId: socket.id,
    message: "أحد اللاعبين غادر الغرفة",
  });

  const connectedPlayers = game.players.filter(p => p.connected);
  
  if (game.isEmpty() || connectedPlayers.length === 0) {
    closeRoom(roomId, "👋 غادر جميع اللاعبين");
  }
}

// =========================================
// تشغيل الخادم
// =========================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║   🎲 Domino Server v3.1              ║
  ║   Port: ${PORT}                          ║
  ║   Status: ✅ Ready                    ║
  ║   Firebase: ${firebaseReady ? '✅' : '⚠️'}                      ║
  ║   Storage: ${bucket ? '✅' : '⚠️'}                       ║
  ║   OTA: ${OTA_ENABLED ? '✅ مفعّل' : '⏸️ معطّل'}                    ║
  ║   Auto-Clean: ✅ مفعّل                ║
  ╚═══════════════════════════════════════╝
  `);
});

process.on('uncaughtException', (err) => {
  console.error('❌ خطأ غير متوقع:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('❌ رفض غير معالج:', err);
});
