// ==============================================
// خادم لعبة الدومينو - Railway Ready v2.0
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
app.use(express.json());

// خدمة ملفات APK الثابتة
app.use('/downloads', express.static(path.join(__dirname, 'public/downloads')));

// =========================================
// تخزين الغرف في الذاكرة
// =========================================
const rooms = new Map();      // roomId → DominoGame
const playerRooms = new Map(); // socketId → roomId

// =========================================
// معلومات الإصدار الحالي (للـ OTA)
// =========================================
const LATEST_VERSION = {
  versionCode: 2,
  versionName: "2.1.0",
  apkUrl: `${process.env.PUBLIC_URL || 'https://domino-server-production-e9af.up.railway.app'}/downloads/domino-v2.1.0.apk`,
  changelog: "🎉 الجديد:\n• تحسين إغلاق الغرف تلقائياً\n• إضافة مؤثرات صوتية\n• إصلاح أخطاء الاتصال\n• تحسين الأداء",
  isMandatory: false,
  releaseDate: "2026-09-13",
  minSupportedVersion: 1,
};

// =========================================
// 🔥 دالة تنظيف الغرفة (جديدة)
// =========================================
function closeRoom(roomId, reason = "انتهت اللعبة") {
  const game = rooms.get(roomId);
  if (!game) return;

  console.log(`🔒 إغلاق الغرفة ${roomId} - السبب: ${reason}`);

  // إشعار اللاعبين
  io.to(roomId).emit('room_closed', {
    roomId,
    reason,
    message: reason
  });

  // إزالة كل اللاعبين من الغرفة
  game.players.forEach(p => {
    playerRooms.delete(p.id);
  });

  // إخراج جميع Sockets من الغرفة
  io.sockets.sockets.forEach(socket => {
    if (socket.rooms.has(roomId)) {
      socket.leave(roomId);
    }
  });

  // حذف الغرفة
  rooms.delete(roomId);
  console.log(`🗑️ تم حذف الغرفة ${roomId} | الغرف المتبقية: ${rooms.size}`);
}

// =========================================
// 🧹 فحص وإغلاق الغرف المهملة كل دقيقة
// =========================================
setInterval(() => {
  const now = Date.now();
  const MAX_IDLE_TIME = 10 * 60 * 1000; // 10 دقائق بدون نشاط
  const MAX_GAME_AGE = 3 * 60 * 60 * 1000; // 3 ساعات كحد أقصى

  rooms.forEach((game, roomId) => {
    const lastActivity = game.lastActivity || game.createdAt;

    // غرفة لعبة منتهية
    if (game.gameStatus === "finished") {
      closeRoom(roomId, "🏆 انتهت اللعبة");
      return;
    }

    // غرفة بلا نشاط
    if (now - lastActivity > MAX_IDLE_TIME) {
      closeRoom(roomId, "⏱️ انتهت مدة الانتظار");
      return;
    }

    // غرفة قديمة جداً
    if (now - game.createdAt > MAX_GAME_AGE) {
      closeRoom(roomId, "⌛ الغرفة قديمة");
      return;
    }

    // غرفة فارغة من اللاعبين المتصلين
    const connectedPlayers = game.players.filter(p => p.connected);
    if (connectedPlayers.length === 0) {
      closeRoom(roomId, "👋 غادر جميع اللاعبين");
    }
  });
}, 60 * 1000); // كل دقيقة

// =========================================
// Endpoints
// =========================================

// الصفحة الرئيسية
app.get('/', (req, res) => {
  res.json({
    name: "🎲 Domino Server",
    status: "online",
    version: "2.0.0",
    activeRooms: rooms.size,
    activePlayers: playerRooms.size,
    uptime: Math.floor(process.uptime()) + "s",
    latestAppVersion: LATEST_VERSION.versionName,
  });
});

// فحص الصحة
app.get('/health', (req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    rooms: rooms.size,
    players: playerRooms.size,
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB",
    uptime: Math.floor(process.uptime()) + "s",
  });
});

// قائمة الغرف المفتوحة
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
// 🆕 OTA Update Endpoint
// =========================================
app.get('/api/check-update', (req, res) => {
  const clientVersion = parseInt(req.query.versionCode) || 0;
  const clientPlatform = req.query.platform || 'android';

  console.log(`📱 فحص تحديث: platform=${clientPlatform} version=${clientVersion}`);

  if (clientVersion < LATEST_VERSION.versionCode) {
    return res.json({
      updateAvailable: true,
      versionCode: LATEST_VERSION.versionCode,
      versionName: LATEST_VERSION.versionName,
      apkUrl: LATEST_VERSION.apkUrl,
      changelog: LATEST_VERSION.changelog,
      isMandatory: clientVersion < LATEST_VERSION.minSupportedVersion,
      releaseDate: LATEST_VERSION.releaseDate,
      minSupportedVersion: LATEST_VERSION.minSupportedVersion,
    });
  }

  res.json({
    updateAvailable: false,
    currentVersion: LATEST_VERSION.versionName,
  });
});

// =========================================
// WebSocket Events
// =========================================
io.on('connection', (socket) => {
  console.log(`✅ لاعب متصل: ${socket.id} | إجمالي: ${io.engine.clientsCount}`);

  // 1. إنشاء غرفة
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

  // 2. الانضمام
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

  // 3. لعب قطعة
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
        
        // 🔥 إذا انتهت اللعبة الكاملة → أغلق الغرفة بعد 30 ثانية
        if (game.gameStatus === "finished") {
          const winner = game.players.find(p => p.score >= game.maxScore);
          io.to(roomId).emit('game_ended', {
            winner: winner?.name,
            scores: game.players.map(p => ({ name: p.name, score: p.score })),
          });
          
          // إغلاق الغرفة بعد 30 ثانية
          setTimeout(() => closeRoom(roomId, "🏆 انتهت اللعبة الكاملة"), 30000);
        }
      }

      callback?.({ success: true });
    } catch (err) {
      console.error("خطأ اللعب:", err);
      callback?.({ error: "فشل تنفيذ الحركة" });
    }
  });

  // 4. سحب قطعة
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

  // 5. تمرير الدور
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
        
        if (game.gameStatus === "finished") {
          const winner = game.players.find(p => p.score >= game.maxScore);
          io.to(roomId).emit('game_ended', {
            winner: winner?.name,
            scores: game.players.map(p => ({ name: p.name, score: p.score })),
          });
          setTimeout(() => closeRoom(roomId, "🏆 انتهت اللعبة"), 30000);
        }
      }

      callback?.({ success: true });
    } catch (err) {
      callback?.({ error: "فشل التمرير" });
    }
  });

  // 6. جولة جديدة
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

  // 7. مغادرة يدوية
  socket.on('leave_room', ({ roomId }) => {
    handlePlayerLeave(socket, roomId);
  });

  // 8. الانقطاع
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

  // 🔥 حذف الغرفة فوراً إذا:
  // 1. فارغة تماماً
  // 2. أو كل اللاعبين غير متصلين
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
  ║   🎲 Domino Server v2.0 is Running!  ║
  ║   Port: ${PORT}                          ║
  ║   Status: ✅ Ready                    ║
  ║   OTA: ✅ Enabled                     ║
  ║   Auto-Clean: ✅ Enabled              ║
  ╚═══════════════════════════════════════╝
  `);
});

process.on('uncaughtException', (err) => {
  console.error('❌ خطأ غير متوقع:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('❌ رفض غير معالج:', err);
});
