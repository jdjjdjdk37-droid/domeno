// ==============================================
// خادم لعبة الدومينو - Railway Ready
// ==============================================
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const { v4: uuidv4 } = require('uuid');
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

// =========================================
// تخزين الغرف في الذاكرة
// =========================================
const rooms = new Map();      // roomId → DominoGame
const playerRooms = new Map(); // socketId → roomId

// =========================================
// نقاط النهاية (Endpoints)
// =========================================

// الصفحة الرئيسية
app.get('/', (req, res) => {
  res.json({
    name: "🎲 Domino Server",
    status: "online",
    version: "1.0.0",
    activeRooms: rooms.size,
    activePlayers: playerRooms.size,
    uptime: Math.floor(process.uptime()) + "s",
  });
});

// فحص الصحة (مهم لـ Railway)
app.get('/health', (req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    rooms: rooms.size,
    players: playerRooms.size,
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB",
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
      });
    }
  });
  res.json({ rooms: list });
});

// =========================================
// WebSocket Events
// =========================================
io.on('connection', (socket) => {
  console.log(`✅ لاعب متصل: ${socket.id} | إجمالي: ${io.engine.clientsCount}`);

  // -----------------------------------------
  // 1. إنشاء غرفة جديدة
  // -----------------------------------------
  socket.on('create_room', ({ playerName, mode = "1v1" }, callback) => {
    try {
      const roomId = uuidv4().slice(0, 6).toUpperCase();
      const game = new DominoGame(roomId, mode, socket.id, playerName);
      
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

  // -----------------------------------------
  // 2. الانضمام إلى غرفة
  // -----------------------------------------
  socket.on('join_room', ({ roomId, playerName }, callback) => {
    try {
      const game = rooms.get(roomId.toUpperCase());
      if (!game) return callback({ error: "الغرفة غير موجودة" });
      if (game.isFull()) return callback({ error: "الغرفة ممتلئة" });
      if (game.hasPlayer(socket.id)) {
        return callback({ error: "أنت بالفعل في الغرفة" });
      }

      game.addPlayer(socket.id, playerName);
      playerRooms.set(socket.id, roomId);
      socket.join(roomId);

      console.log(`👤 ${playerName} انضم إلى ${roomId}`);

      // إشعار الجميع
      io.to(roomId).emit('player_joined', {
        playerId: socket.id,
        playerName,
        game: game.getPublicState(),
      });

      // لو الغرفة امتلأت، ابدأ اللعبة
      if (game.isFull() && game.gameStatus === "waiting") {
        game.startRound();
        io.to(roomId).emit('game_started', {
          message: "🎲 بدأت اللعبة!",
        });
        // إرسال حالة لكل لاعب مع يده الخاصة
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

  // -----------------------------------------
  // 3. لعب قطعة
  // -----------------------------------------
  socket.on('play_tile', ({ roomId, tile, side }, callback) => {
    try {
      const game = rooms.get(roomId);
      if (!game) return callback?.({ error: "الغرفة غير موجودة" });

      const result = game.playTile(socket.id, tile, side);
      if (result.error) return callback?.({ error: result.error });

      // إرسال الحالة لكل لاعب مع يده
      game.players.forEach(p => {
        io.to(p.id).emit('game_state', game.getPublicState(p.id));
      });

      if (result.gameEnded) {
        io.to(roomId).emit('round_ended', game.lastAction);
        if (game.gameStatus === "finished") {
          io.to(roomId).emit('game_ended', {
            winner: game.players.find(p => p.score >= game.maxScore)?.name,
            scores: game.players.map(p => ({ name: p.name, score: p.score })),
          });
        }
      }

      callback?.({ success: true });
    } catch (err) {
      console.error("خطأ اللعب:", err);
      callback?.({ error: "فشل تنفيذ الحركة" });
    }
  });

  // -----------------------------------------
  // 4. سحب قطعة
  // -----------------------------------------
  socket.on('draw_tile', ({ roomId }, callback) => {
    try {
      const game = rooms.get(roomId);
      if (!game) return callback?.({ error: "الغرفة غير موجودة" });

      const result = game.drawTile(socket.id);
      if (result.error) return callback?.({ error: result.error });

      // إرسال الحالة لكل لاعب
      game.players.forEach(p => {
        io.to(p.id).emit('game_state', game.getPublicState(p.id));
      });

      callback?.({ success: true, tile: result.tile });
    } catch (err) {
      console.error("خطأ السحب:", err);
      callback?.({ error: "فشل السحب" });
    }
  });

  // -----------------------------------------
  // 5. تمرير الدور
  // -----------------------------------------
  socket.on('pass_turn', ({ roomId }, callback) => {
    try {
      const game = rooms.get(roomId);
      if (!game) return callback?.({ error: "الغرفة غير موجودة" });

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
      console.error("خطأ التمرير:", err);
      callback?.({ error: "فشل التمرير" });
    }
  });

  // -----------------------------------------
  // 6. جولة جديدة
  // -----------------------------------------
  socket.on('new_round', ({ roomId }, callback) => {
    try {
      const game = rooms.get(roomId);
      if (!game) return callback?.({ error: "الغرفة غير موجودة" });

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

  // -----------------------------------------
  // 7. مغادرة الغرفة
  // -----------------------------------------
  socket.on('leave_room', ({ roomId }) => {
    handlePlayerLeave(socket, roomId);
  });

  // -----------------------------------------
  // 8. الانقطاع
  // -----------------------------------------
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
  socket.leave(roomId);
  playerRooms.delete(socket.id);

  // إشعار الباقين
  io.to(roomId).emit('player_left', {
    playerId: socket.id,
    message: "أحد اللاعبين غادر الغرفة",
  });

  // حذف الغرفة لو فارغة
  if (game.isEmpty()) {
    rooms.delete(roomId);
    console.log(`🗑️ حذف الغرفة الفارغة: ${roomId}`);
  }
}

// =========================================
// تنظيف الغرف القديمة (كل ساعة)
// =========================================
setInterval(() => {
  const now = Date.now();
  const MAX_AGE = 3 * 60 * 60 * 1000; // 3 ساعات
  rooms.forEach((game, roomId) => {
    if (now - game.createdAt > MAX_AGE && game.gameStatus === "waiting") {
      rooms.delete(roomId);
      console.log(`🧹 حذف غرفة قديمة: ${roomId}`);
    }
  });
}, 60 * 60 * 1000);

// =========================================
// تشغيل الخادم
// =========================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║   🎲 Domino Server is Running!       ║
  ║   Port: ${PORT}                          ║
  ║   Status: ✅ Ready                    ║
  ╚═══════════════════════════════════════╝
  `);
});

// التعامل مع الأخطاء
process.on('uncaughtException', (err) => {
  console.error('❌ خطأ غير متوقع:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('❌ رفض غير معالج:', err);
});
