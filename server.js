// =============================================================
//  server.js
//  ---------------------------------------------------------------
//  Thin networking layer. Creates/looks up Room objects (see
//  gameLogic.js for all the actual rules) and translates socket
//  events <-> Room method calls. Broadcasts a redacted view of
//  the room to every connected player after each change.
// =============================================================

const path = require('path');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { Room } = require('./gameLogic');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(path.join(__dirname, 'public')));

// roomCode -> Room instance
const rooms = new Map();

// socket.id -> { roomCode, playerId }
const socketInfo = new Map();

function randomRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusing chars
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function broadcastRoom(room) {
  for (const player of room.players) {
    io.to(player.id).emit('room-update', room.viewFor(player.id));
  }
}

function safeHandler(socket, fn) {
  try {
    fn();
  } catch (err) {
    socket.emit('error-message', err.message || String(err));
  }
}

io.on('connection', (socket) => {
  socket.on('create-room', ({ name }) => safeHandler(socket, () => {
    const code = randomRoomCode();
    const room = new Room(code);
    room.addPlayer(socket.id, (name || 'Player').trim().slice(0, 20));
    rooms.set(code, room);
    socketInfo.set(socket.id, { roomCode: code, playerId: socket.id });
    socket.join(code);
    broadcastRoom(room);
  }));

  socket.on('join-room', ({ roomCode, name }) => safeHandler(socket, () => {
    const code = (roomCode || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) throw new Error('Room not found');
    room.addPlayer(socket.id, (name || 'Player').trim().slice(0, 20));
    socketInfo.set(socket.id, { roomCode: code, playerId: socket.id });
    socket.join(code);
    broadcastRoom(room);
  }));

  socket.on('start-game', () => withRoom(socket, (room) => {
    if (room.hostId !== socket.id) throw new Error('Only the host can start the game');
    room.startGame();
    broadcastRoom(room);
  }));

  socket.on('peek-select', ({ slotIndices }) => withRoom(socket, (room) => {
    room.peekInitial(socket.id, slotIndices);
    broadcastRoom(room);
  }));

  socket.on('draw-card', () => withRoom(socket, (room) => {
    const card = room.drawCard(socket.id);
    socket.emit('your-draw', card);
    broadcastRoom(room); // so others see the deck count drop / turn state
  }));

  socket.on('resolve-draw', ({ action, slotIndex }) => withRoom(socket, (room) => {
    room.resolveDraw(socket.id, action, slotIndex);
    broadcastRoom(room);
  }));

  socket.on('power-peek-own', ({ slotIndex }) => withRoom(socket, (room) => {
    const result = room.powerPeekOwn(socket.id, slotIndex);
    socket.emit('power-result', { type: 'peek-own', ...result });
    broadcastRoom(room);
  }));

  socket.on('power-peek-opponent', ({ opponentId, slotIndex }) => withRoom(socket, (room) => {
    const result = room.powerPeekOpponent(socket.id, opponentId, slotIndex);
    socket.emit('power-result', { type: 'peek-opponent', ...result });
    broadcastRoom(room);
  }));

  socket.on('power-swap', ({ ownSlotIndex, opponentId, opponentSlotIndex }) => withRoom(socket, (room) => {
    room.powerSwapBlind(socket.id, ownSlotIndex, opponentId, opponentSlotIndex);
    broadcastRoom(room);
  }));

  socket.on('attempt-match', ({ slotIndex }) => withRoom(socket, (room) => {
    const result = room.attemptMatch(socket.id, slotIndex);
    socket.emit('match-result', result);
    broadcastRoom(room);
  }));

  socket.on('call-challenge', () => withRoom(socket, (room) => {
    room.callChallenge(socket.id);
    broadcastRoom(room);
  }));

  socket.on('disconnect', () => {
    const info = socketInfo.get(socket.id);
    if (!info) return;
    const room = rooms.get(info.roomCode);
    if (room) {
      room.removePlayer(socket.id);
      if (room.players.length === 0 || room.activePlayers().length === 0) {
        rooms.delete(info.roomCode);
      } else {
        broadcastRoom(room);
      }
    }
    socketInfo.delete(socket.id);
  });

  function withRoom(socket, fn) {
    safeHandler(socket, () => {
      const info = socketInfo.get(socket.id);
      if (!info) throw new Error('You are not in a room');
      const room = rooms.get(info.roomCode);
      if (!room) throw new Error('Room no longer exists');
      fn(room);
    });
  }
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Card game server running at http://localhost:${PORT}`);
});
