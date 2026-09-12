// ==============================================
// محرك قواعد لعبة الدومينو الكلاسيكية
// ==============================================

class DominoGame {
  constructor(roomId, mode, hostId, hostName) {
    this.roomId = roomId;
    this.mode = mode; // "1v1" أو "2v2" أو "classic"
    this.hostId = hostId;
    this.players = []; // [{id, name, hand, score, team, connected}]
    this.boneyard = []; // الرص
    this.board = [];    // [{left, right, playedBy}] سلسلة اللعب
    this.leftEnd = null;  // الرقم على الطرف الأيسر
    this.rightEnd = null; // الرقم على الطرف الأيمن
    this.currentTurn = 0; // فهرس اللاعب الحالي
    this.gameStatus = "waiting"; // waiting | playing | finished
    this.roundNumber = 0;
    this.maxScore = 100; // نقاط الفوز
    this.lastAction = null;
    this.createdAt = Date.now();

    // إضافة المضيف كلاعب أول
    this.addPlayer(hostId, hostName);
  }

  // =========================================
  // توليد مجموعة الدومينو الكاملة (28 قطعة)
  // =========================================
  static createFullSet() {
    const tiles = [];
    for (let i = 0; i <= 6; i++) {
      for (let j = i; j <= 6; j++) {
        tiles.push({ left: i, right: j });
      }
    }
    return tiles; // 28 قطعة
  }

  // خلط عشوائي (Fisher-Yates)
  static shuffle(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // =========================================
  // إدارة اللاعبين
  // =========================================
  addPlayer(playerId, playerName) {
    const maxPlayers = this.mode === "2v2" ? 4 : 2;
    if (this.players.length >= maxPlayers) return false;

    const team = this.mode === "2v2" ? (this.players.length % 2) : null;
    this.players.push({
      id: playerId,
      name: playerName || `لاعب ${this.players.length + 1}`,
      hand: [],
      score: 0,
      team: team,
      connected: true,
    });
    return true;
  }

  hasPlayer(id) {
    return this.players.some(p => p.id === id);
  }

  isFull() {
    const maxPlayers = this.mode === "2v2" ? 4 : 2;
    return this.players.length >= maxPlayers;
  }

  isEmpty() {
    return this.players.length === 0;
  }

  markDisconnected(id) {
    const player = this.players.find(p => p.id === id);
    if (player) player.connected = false;
  }

  // =========================================
  // بدء جولة جديدة
  // =========================================
  startRound() {
    this.roundNumber++;
    const fullSet = DominoGame.shuffle(DominoGame.createFullSet());

    // توزيع 7 قطع لكل لاعب
    const tilesPerPlayer = 7;
    this.players.forEach((player, idx) => {
      const start = idx * tilesPerPlayer;
      player.hand = fullSet.slice(start, start + tilesPerPlayer);
    });

    // الباقي في الرص
    const usedCount = this.players.length * tilesPerPlayer;
    this.boneyard = fullSet.slice(usedCount);

    // إعادة تعيين الطاولة
    this.board = [];
    this.leftEnd = null;
    this.rightEnd = null;

    // تحديد من يبدأ: صاحب أعلى Double
    let startingPlayer = 0;
    let highestDouble = -1;

    this.players.forEach((player, pIdx) => {
      player.hand.forEach(tile => {
        if (tile.left === tile.right && tile.left > highestDouble) {
          highestDouble = tile.left;
          startingPlayer = pIdx;
        }
      });
    });

    this.currentTurn = startingPlayer;
    this.gameStatus = "playing";
    this.lastAction = {
      type: "round_start",
      player: this.players[startingPlayer].name,
      message: highestDouble >= 0
        ? `${this.players[startingPlayer].name} يبدأ بـ [${highestDouble}|${highestDouble}]`
        : `${this.players[startingPlayer].name} يبدأ الجولة`,
    };
  }

  // =========================================
  // التحقق من إمكانية لعب قطعة
  // =========================================
  canPlayTile(tile, side = null) {
    // لو الطاولة فارغة، أي قطعة ممكنة
    if (this.board.length === 0) return true;

    // لو محدد الجهة
    if (side === "left") {
      return tile.left === this.leftEnd || tile.right === this.leftEnd;
    }
    if (side === "right") {
      return tile.left === this.rightEnd || tile.right === this.rightEnd;
    }

    // لو ما حدد، تحقق من الجهتين
    return (
      tile.left === this.leftEnd || tile.right === this.leftEnd ||
      tile.left === this.rightEnd || tile.right === this.rightEnd
    );
  }

  // هل لدى اللاعب أي حركة ممكنة؟
  hasValidMove(playerId) {
    const player = this.players.find(p => p.id === playerId);
    if (!player) return false;
    return player.hand.some(tile => this.canPlayTile(tile));
  }

  // =========================================
  // لعب قطعة
  // =========================================
  playTile(playerId, tile, side) {
    const playerIndex = this.players.findIndex(p => p.id === playerId);
    if (playerIndex === -1) return { error: "لاعب غير موجود" };
    if (playerIndex !== this.currentTurn) return { error: "ليس دورك" };
    if (this.gameStatus !== "playing") return { error: "اللعبة غير نشطة" };

    const player = this.players[playerIndex];
    const tileIndex = player.hand.findIndex(
      t => t.left === tile.left && t.right === tile.right
    );
    if (tileIndex === -1) return { error: "لا تملك هذه القطعة" };

    // التحقق من صحة اللعب
    if (this.board.length > 0 && !this.canPlayTile(tile, side)) {
      return { error: "القطعة لا تتوافق مع أطراف الطاولة" };
    }

    // إزالة القطعة من يد اللاعب
    player.hand.splice(tileIndex, 1);

    // وضع القطعة على الطاولة
    if (this.board.length === 0) {
      // أول قطعة - تفتح اللعبة
      this.board.push({ ...tile, side: "first" });
      this.leftEnd = tile.left;
      this.rightEnd = tile.right;
    } else if (side === "left") {
      // لعب على اليسار
      let newTile;
      if (tile.right === this.leftEnd) {
        newTile = { ...tile, side: "left" };
        this.leftEnd = tile.left;
      } else {
        newTile = { left: tile.right, right: tile.left, side: "left" };
        this.leftEnd = tile.right;
      }
      this.board.unshift(newTile);
    } else {
      // لعب على اليمين
      let newTile;
      if (tile.left === this.rightEnd) {
        newTile = { ...tile, side: "right" };
        this.rightEnd = tile.right;
      } else {
        newTile = { left: tile.right, right: tile.left, side: "right" };
        this.rightEnd = tile.left;
      }
      this.board.push(newTile);
    }

    this.lastAction = {
      type: "play",
      player: player.name,
      message: `${player.name} لعب [${tile.left}|${tile.right}]`,
    };

    // فحص الفوز
    if (player.hand.length === 0) {
      this.endRound(playerIndex);
      return { success: true, gameEnded: true };
    }

    // الانتقال للدور التالي
    this.nextTurn();
    return { success: true };
  }

  // =========================================
  // سحب قطعة من الرص
  // =========================================
  drawTile(playerId) {
    const playerIndex = this.players.findIndex(p => p.id === playerId);
    if (playerIndex === -1) return { error: "لاعب غير موجود" };
    if (playerIndex !== this.currentTurn) return { error: "ليس دورك" };
    if (this.boneyard.length === 0) return { error: "الرص فارغ" };

    const player = this.players[playerIndex];
    const tile = this.boneyard.pop();
    player.hand.push(tile);

    this.lastAction = {
      type: "draw",
      player: player.name,
      message: `${player.name} سحب قطعة من الرص (${this.boneyard.length} متبقية)`,
    };

    return { success: true, tile };
  }

  // =========================================
  // تمرير الدور
  // =========================================
  passTurn(playerId) {
    const playerIndex = this.players.findIndex(p => p.id === playerId);
    if (playerIndex === -1) return { error: "لاعب غير موجود" };
    if (playerIndex !== this.currentTurn) return { error: "ليس دورك" };
    if (this.hasValidMove(playerId)) {
      return { error: "لديك حركة صحيحة، لا يمكنك التمرير" };
    }
    if (this.boneyard.length > 0) {
      return { error: "يجب السحب من الرص أولاً" };
    }

    const player = this.players[playerIndex];
    this.lastAction = {
      type: "pass",
      player: player.name,
      message: `${player.name} مرر الدور`,
    };

    // فحص إذا اللعبة كلها مقفلة (Block)
    if (this.isFullyBlocked()) {
      this.endRoundByBlock();
      return { success: true, gameEnded: true };
    }

    this.nextTurn();
    return { success: true };
  }

  // =========================================
  // الدور التالي
  // =========================================
  nextTurn() {
    this.currentTurn = (this.currentTurn + 1) % this.players.length;
  }

  // فحص إذا كل اللاعبين عاجزين (Blocked)
  isFullyBlocked() {
    return this.players.every(p => !this.hasValidMove(p.id));
  }

  // =========================================
  // إنهاء الجولة (لاعب أنهى يده)
  // =========================================
  endRound(winnerIndex) {
    const winner = this.players[winnerIndex];
    let totalPoints = 0;

    this.players.forEach((player, idx) => {
      if (idx !== winnerIndex) {
        const playerPoints = player.hand.reduce(
          (sum, tile) => sum + tile.left + tile.right,
          0
        );
        totalPoints += playerPoints;
      }
    });

    winner.score += totalPoints;

    this.lastAction = {
      type: "round_end",
      player: winner.name,
      message: `🎉 ${winner.name} فاز بالجولة بـ ${totalPoints} نقطة!`,
      points: totalPoints,
    };

    this.gameStatus = "round_finished";

    // فحص إذا وصل لـ 100 نقطة (فوز اللعبة)
    if (winner.score >= this.maxScore) {
      this.gameStatus = "finished";
      this.lastAction.message = `🏆 ${winner.name} فاز باللعبة الكاملة بـ ${winner.score} نقطة!`;
    }
  }

  // =========================================
  // إنهاء الجولة بسبب Block
  // =========================================
  endRoundByBlock() {
    // احسب مجموع نقاط كل لاعب
    let minPoints = Infinity;
    let winnerIndex = 0;
    const points = [];

    this.players.forEach((player, idx) => {
      const playerPoints = player.hand.reduce(
        (sum, tile) => sum + tile.left + tile.right,
        0
      );
      points.push(playerPoints);
      if (playerPoints < minPoints) {
        minPoints = playerPoints;
        winnerIndex = idx;
      }
    });

    // الفائز يأخذ مجموع نقاط الخصوم
    let totalPoints = 0;
    points.forEach((p, idx) => {
      if (idx !== winnerIndex) totalPoints += p;
    });

    this.players[winnerIndex].score += totalPoints;

    this.lastAction = {
      type: "block_end",
      player: this.players[winnerIndex].name,
      message: `🔒 الجولة انتهت بـ Block! ${this.players[winnerIndex].name} يفوز بـ ${totalPoints} نقطة`,
      points: totalPoints,
    };

    this.gameStatus = "round_finished";

    if (this.players[winnerIndex].score >= this.maxScore) {
      this.gameStatus = "finished";
      this.lastAction.message = `🏆 ${this.players[winnerIndex].name} فاز باللعبة الكاملة بـ ${this.players[winnerIndex].score} نقطة!`;
    }
  }

  // =========================================
  // جولة جديدة (بعد انتهاء جولة)
  // =========================================
  newRound() {
    if (this.gameStatus !== "round_finished") {
      return { error: "لا يمكن بدء جولة جديدة الآن" };
    }
    this.startRound();
    return { success: true };
  }

  // =========================================
  // الحالة العامة (تُرسل للاعبين)
  // =========================================
  getPublicState(forPlayerId = null) {
    return {
      roomId: this.roomId,
      mode: this.mode,
      gameStatus: this.gameStatus,
      roundNumber: this.roundNumber,
      board: this.board,
      leftEnd: this.leftEnd,
      rightEnd: this.rightEnd,
      boneyardCount: this.boneyard.length,
      currentTurn: this.currentTurn,
      currentPlayerId: this.players[this.currentTurn]?.id,
      lastAction: this.lastAction,
      players: this.players.map((p, idx) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        team: p.team,
        connected: p.connected,
        tileCount: p.hand.length,
        // إظهار يد اللاعب نفسه فقط
        hand: p.id === forPlayerId ? p.hand : null,
        isCurrentTurn: idx === this.currentTurn,
      })),
    };
  }
}

module.exports = { DominoGame };
