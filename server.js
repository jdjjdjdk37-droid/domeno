// ==============================================
// خادم لعبة الدومينو - Railway Ready v5.0
// مع Agora (مكالمات صوتية) + Firebase + AI Fallback
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
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');

// استيراد Firebase
let admin = null;
let db = null;
let firebaseReady = false;

try {
  admin = require('firebase-admin');
  if (process.env.FIREBASE_PROJECT_ID && 
      process.env.FIREBASE_CLIENT_EMAIL && 
      process.env.FIREBASE_PRIVATE_KEY) {
    
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
    
    db = admin.firestore();
    firebaseReady = true;
    console.log('✅ Firebase Admin جاهز');
  }
} catch (err) {
  console.error('⚠️ Firebase معطّل:', err.message);
}

// استيراد منطق اللعبة
const { DominoGame } = require('./dominoGameLogic');

// =========================================
// Agora Configuration
// =========================================
const AGORA_APP_ID = process.env.AGORA_APP_ID || "d25d8dee0f8b487fb15bb4151a54057d";
const AGORA_APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE || "f245fe7746ff4591b303bf9799bb7968";

console.log(`🎤 Agora App ID: ${AGORA_APP_ID.substring(0, 8)}...`);

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

// خدمة ملفات APK
app.use('/downloads', express.static(path.join(__dirname, 'public/downloads')));

// =========================================
// تخزين الغرف
// =========================================
const rooms = new Map();
const playerRooms = new Map();

// إعدادات
const AI_TAKEOVER_DELAY = 30000;
const TURN_TIMEOUT = 30000;

// OTA
const OTA_ENABLED = false;

const LATEST_VERSION = {
  versionCode: 3,
  versionName: "2.3.0",
  apkUrl: `${process.env.PUBLIC_URL || 'https://domino-server-production-e9af.up.railway.app'}/downloads/domino-v2.3.0.apk`,
  changelog: "🎉 جديد:\n• مكالمات صوتية (Agora)\n• إصلاح عرض القطع\n• تحسين الثيم",
  isMandatory: false,
  releaseDate: "2026-09-14",
  minSupportedVersion: 1,
};

// =========================================
// 🎤 Agora Token Generator
// =========================================
app.post('/api/agora/token', (req, res) => {
  try {
    const { roomId, uid } = req.body;
    
    if (!roomId || !uid) {
      return res.status(400).json({ error: "roomId و uid مطلوبان" });
    }

    const channelName = roomId;
    const role = RtcRole.PUBLISHER;
    const expirationTimeInSeconds = 3600;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

    const token = RtcTokenBuilder.buildTokenWithUid(
      AGORA_APP_ID,
      AGORA_APP_CERTIFICATE,
      channelName,
      parseInt(uid),
      role,
      privilegeExpiredTs
    );

    console.log(`🎤 Token Agora → Room: ${roomId}, UID: ${uid}`);

    res.json({
      token,
      channel: channelName,
      uid: parseInt(uid),
      appId: AGORA_APP_ID,
      expiresAt: privilegeExpiredTs,
    });
  } catch (err) {
    console.error('❌ فشل توليد Token:', err.message);
    res.status(500).json({ error: "فشل توليد Token" });
  }
});

// =========================================
// 🔥 إغلاق الغرفة
// =========================================
function closeRoom(roomId, reason = "انتهت اللعبة") {
  const game = rooms.get(roomId);
  if (!game) return;

  console.log(`🔒 إغلاق الغرفة ${roomId} - السبب: ${reason}`);

  game.players.forEach(p => {
    if (p.turnTimer) clearTimeout(p.turnTimer);
    if (p.aiTakeoverTimer) clearTimeout(p.aiTakeoverTimer);
  });

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
  console.log(`🗑️ تم حذف الغرفة ${roomId}`);
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
    if (connectedPlayers.length === 0 && game.players.length > 0) {
      closeRoom(roomId, "👋 غادر جميع اللاعبين");
    }
  });
}, 60 * 1000);

// =========================================
// 🎯 Endpoints
// =========================================

app.get('/', (req, res) => {
  res.json({
    name: "🎲 Domino Server",
    status: "online",
    version: "5.0.0",
    activeRooms: rooms.size,
    activePlayers: playerRooms.size,
    uptime: Math.floor(process.uptime()) + "s",
    otaEnabled: OTA_ENABLED,
    firebaseReady: firebaseReady,
    aiFallbackEnabled: true,
    agoraEnabled: true,
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
    agoraEnabled: true,
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
      });
    }
  });
  res.json({ rooms: list, count: list.length });
});

// =========================================
// 📡 Config
// =========================================
app.get('/api/config', (req, res) => {
  res.json({
    theme: {
      primaryColor: "#0D2818",
      accentColor: "#D4AF37",
      surfaceColor: "#1A3A2A",
      textColor: "#F5F0E1",
    },
    features: {
      voiceChat: true,
      aiTakeover: true,
      avatars: true,
      chat: true,
      leaderboard: true,
    },
    agora: {
      appId: AGORA_APP_ID,
      enabled: true,
    },
    timings: {
      turnTimeout: 30,
      aiTakeoverDelay: 30,
      roomIdleTimeout: 600,
    },
    version: {
      latest: LATEST_VERSION.versionName,
      code: LATEST_VERSION.versionCode,
    },
  });
});

// =========================================
// 🔄 OTA
// =========================================
app.get('/api/check-update', (req, res) => {
  if (!OTA_ENABLED) {
    return res.json({ 
      updateAvailable: false,
      message: "لا يوجد تحديث حالياً"
    });
  }

  const clientVersion = parseInt(req.query.versionCode) || 0;
  const apkPath = path.join(__dirname, 'public/downloads/domino-v2.3.0.apk');

  if (!fs.existsSync(apkPath)) {
    return res.json({ updateAvailable: false });
  }

  if (clientVersion >= LATEST_VERSION.versionCode) {
    return res.json({ updateAvailable: false });
  }

  res.json({
    updateAvailable: true,
    ...LATEST_VERSION,
    apkSize: fs.statSync(apkPath).size,
  });
});

// =========================================
// 💾 Firebase دوال
// =========================================
async function saveMatch(matchData) {
  if (!firebaseReady) return;
  try {
    await db.collection('matches').add({
      ...matchData,
      finishedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('❌ حفظ المباراة:', err.message);
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
    console.error('❌ تحديث الإحصائيات:', err.message);
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
  } catch (err) {
    console.error('❌ Leaderboard:', err.message);
  }
}

// =========================================
// 🤖 AI
// =========================================
function getAIMove(game, player) {
  if (!game || !player) return null;

  const validMoves = [];
  
  player.hand.forEach(tile => {
    if (game.canPlayTile(tile, "left")) {
      validMoves.push({ tile, side: "left" });
    }
    if (game.canPlayTile(tile, "right")) {
      validMoves.push({ tile, side: "right" });
    }
  });

  if (validMoves.length === 0) return null;

  validMoves.sort((a, b) => {
    const aDouble = a.tile.left === a.tile.right ? 1 : 0;
    const bDouble = b.tile.left === b.tile.right ? 1 : 0;
    if (aDouble !== bDouble) return bDouble - aDouble;
    return (b.tile.left + b.tile.right) - (a.tile.left + a.tile.right);
  });

  return validMoves[0];
}

function startAIFallback(roomId, playerId) {
  const game = rooms.get(roomId);
  if (!game) return;

  const player = game.players.find(p => p.id === playerId);
  if (!player) return;

  console.log(`🤖 AI يبدأ لعب ${player.name}`);
  player.aiControlled = true;
  
  io.to(roomId).emit('ai_took_over', {
    playerId,
    playerName: player.name,
    message: `🤖 AI يلعب مكان ${player.name}`,
  });

  if (game.players[game.currentTurn]?.id === playerId) {
    makeAIMove(roomId, playerId);
  }
}

function stopAIFallback(roomId, playerId) {
  const game = rooms.get(roomId);
  if (!game) return;

  const player = game.players.find(p => p.id === playerId);
  if (!player) return;

  if (player.aiControlled) {
    player.aiControlled = false;
    io.to(roomId).emit('ai_stopped', {
      playerId,
      playerName: player.name,
    });
  }

  if (player.aiTakeoverTimer) {
    clearTimeout(player.aiTakeoverTimer);
    player.aiTakeoverTimer = null;
  }
}

function makeAIMove(roomId, playerId) {
  const game = rooms.get(roomId);
  if (!game || game.gameStatus !== "playing") return;

  const player = game.players.find(p => p.id === playerId);
  if (!player || !player.aiControlled) return;

  if (game.players[game.currentTurn]?.id !== playerId) return;

  const move = getAIMove(game, player);
  
  if (move) {
    const result = game.playTile(playerId, move.tile, move.side);
    
    if (!result.error) {
      game.players.forEach(p => {
        io.to(p.id).emit('game_state', game.getPublicState(p.id));
      });

      if (result.gameEnded) {
        io.to(roomId).emit('round_ended', game.lastAction);
        if (game.gameStatus === "finished") {
          handleGameEnd(roomId);
        }
      }
    }
  } else {
    if (game.boneyard.length > 0) {
      game.drawTile(playerId);
      const newMove = getAIMove(game, player);
      if (newMove) {
        setTimeout(() => makeAIMove(roomId, playerId), 500);
        return;
      }
    }
    
    const passResult = game.passTurn(playerId);
    if (!passResult.error) {
      game.players.forEach(p => {
        io.to(p.id).emit('game_state', game.getPublicState(p.id));
      });
    }
  }

  setTimeout(() => {
    const g = rooms.get(roomId);
    if (g && g.players[g.currentTurn]?.id === playerId && player.aiControlled) {
      makeAIMove(roomId, playerId);
    }
  }, 1500);
}

// =========================================
// 🏆 نهاية اللعبة
// =========================================
function handleGameEnd(roomId) {
  const game = rooms.get(roomId);
  if (!game) return;

  const winner = game.players.find(p => p.score >= game.maxScore);
  
  io.to(roomId).emit('game_ended', {
    winner: winner?.name,
    scores: game.players.map(p => ({ 
      name: p.name, 
      score: p.score 
    })),
  });

  if (firebaseReady) {
    saveMatch({
      roomId,
      mode: game.mode,
      players: game.players.map(p => ({ 
        name: p.name, 
        score: p.score 
      })),
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

// =========================================
// 🔌 WebSocket
// =========================================
io.on('connection', (socket) => {
  console.log(`✅ لاعب متصل: ${socket.id}`);

  socket.on('create_room', ({ playerName, mode = "1v1" }, callback) => {
    try {
      const roomId = uuidv4().slice(0, 6).toUpperCase();
      const game = new DominoGame(roomId, mode, socket.id, playerName);
      game.lastActivity = Date.now();
      
      rooms.set(roomId, game);
      playerRooms.set(socket.id, roomId);
      socket.join(roomId);

      console.log(`🏠 غرفة: ${roomId}`);

      callback({
        success: true,
        roomId,
        game: game.getPublicState(socket.id),
      });
    } catch (err) {
      callback({ error: "فشل إنشاء الغرفة" });
    }
  });

  socket.on('join_room', ({ roomId, playerName }, callback) => {
    try {
      const game = rooms.get(roomId.toUpperCase());
      if (!game) return callback({ error: "الغرفة غير موجودة" });
      if (game.isFull()) return callback({ error: "الغرفة ممتلئة" });

      game.addPlayer(socket.id, playerName);
      game.lastActivity = Date.now();
      playerRooms.set(socket.id, roomId);
      socket.join(roomId);

      io.to(roomId).emit('player_joined', {
        playerId: socket.id,
        playerName,
        game: game.getPublicState(),
      });

      if (game.isFull() && game.gameStatus === "waiting") {
        game.startRound();
        io.to(roomId).emit('game_started', { 
          message: "🎲 بدأت اللعبة!",
          voiceChannel: roomId,
        });
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
      callback({ error: "فشل الانضمام" });
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
          handleGameEnd(roomId);
        }
      } else {
        const nextPlayer = game.players[game.currentTurn];
        if (nextPlayer?.aiControlled) {
          setTimeout(() => makeAIMove(roomId, nextPlayer.id), 1000);
        }
      }

      callback?.({ success: true });
    } catch (err) {
      callback?.({ error: "فشل الحركة" });
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
        if (game.gameStatus === "finished") {
          handleGameEnd(roomId);
        }
      } else {
        const nextPlayer = game.players[game.currentTurn];
        if (nextPlayer?.aiControlled) {
          setTimeout(() => makeAIMove(roomId, nextPlayer.id), 1000);
        }
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

      const result = game.newRound();
      if (result.error) return callback?.({ error: result.error });

      game.players.forEach(p => {
        io.to(p.id).emit('game_state', game.getPublicState(p.id));
      });

      callback?.({ success: true });
    } catch (err) {
      callback?.({ error: "فشل الجولة" });
    }
  });

  // الدردشة
  socket.on('send_message', ({ roomId, text, type = "text" }) => {
    const game = rooms.get(roomId);
    if (!game) return;

    const player = game.players.find(p => p.id === socket.id);
    if (!player) return;

    io.to(roomId).emit('chat_message', {
      playerId: socket.id,
      playerName: player.name,
      text: (text || "").substring(0, 100),
      type,
      timestamp: Date.now(),
    });
  });

  // 🎤 إشعارات الصوت
  socket.on('voice_joined', ({ roomId }) => {
    const game = rooms.get(roomId);
    if (!game) return;

    const player = game.players.find(p => p.id === socket.id);
    if (!player) return;

    socket.to(roomId).emit('voice_user_joined', {
      playerId: socket.id,
      playerName: player.name,
      channel: roomId,
    });
  });

  socket.on('voice_left', ({ roomId }) => {
    socket.to(roomId).emit('voice_user_left', {
      playerId: socket.id,
    });
  });

  socket.on('voice_muted', ({ roomId, muted }) => {
    const game = rooms.get(roomId);
    if (!game) return;

    const player = game.players.find(p => p.id === socket.id);
    if (!player) return;

    socket.to(roomId).emit('voice_user_muted', {
      playerId: socket.id,
      playerName: player.name,
      muted,
    });
  });

  // إعادة اتصال
  socket.on('reconnect_player', ({ roomId, playerName }, callback) => {
    const game = rooms.get(roomId);
    if (!game) return callback?.({ error: "الغرفة غير موجودة" });

    const oldPlayer = game.players.find(p => 
      p.name === playerName && !p.connected
    );

    if (!oldPlayer) return callback?.({ error: "لا يمكن إعادة الاتصال" });

    const oldId = oldPlayer.id;
    playerRooms.delete(oldId);
    
    oldPlayer.id = socket.id;
    oldPlayer.connected = true;
    playerRooms.set(socket.id, roomId);
    socket.join(roomId);

    stopAIFallback(roomId, oldId);
    stopAIFallback(roomId, socket.id);

    io.to(roomId).emit('player_reconnected', {
      playerId: socket.id,
      playerName,
    });

    callback?.({
      success: true,
      game: game.getPublicState(socket.id),
    });
  });

  socket.on('leave_room', ({ roomId }) => {
    handlePlayerLeave(socket, roomId);
  });

  socket.on('disconnect', () => {
    console.log(`❌ قطع: ${socket.id}`);
    const roomId = playerRooms.get(socket.id);
    if (roomId) handlePlayerLeave(socket, roomId);
  });
});

// =========================================
// مغادرة اللاعب
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
    message: "أحد اللاعبين غادر",
  });

  // إشعار الصوت
  socket.to(roomId).emit('voice_user_left', {
    playerId: socket.id,
  });

  const player = game.players.find(p => p.id === socket.id);
  
  if (player && game.players.filter(p => p.connected).length > 0) {
    console.log(`⏱️ جدولة AI Fallback لـ ${player.name}`);
    
    player.aiTakeoverTimer = setTimeout(() => {
      const currentGame = rooms.get(roomId);
      if (!currentGame) return;
      
      const currentPlayer = currentGame.players.find(p => p.id === socket.id);
      if (!currentPlayer || currentPlayer.connected) return;
      
      startAIFallback(roomId, socket.id);
    }, AI_TAKEOVER_DELAY);
  }

  const connectedPlayers = game.players.filter(p => p.connected);
  if (connectedPlayers.length === 0) {
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
  ║   🎲 Domino Server v5.0              ║
  ║   Port: ${PORT}                          ║
  ║   Firebase: ${firebaseReady ? '✅' : '⚠️'}                      ║
  ║   OTA: ${OTA_ENABLED ? '✅' : '⏸️'}                        ║
  ║   AI Fallback: ✅                     ║
  ║   Agora Voice: ✅                     ║
  ╚═══════════════════════════════════════╝
  `);
});

process.on('uncaughtException', (err) => {
  console.error('❌ خطأ:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('❌ رفض:', err);
});
