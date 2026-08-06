'use strict';
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const G = require('./game');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } }); // frontend puede vivir en otro dominio (GitHub Pages, etc.)

const rooms = new Map();   // roomCode -> { state, sockets: { red: socketId|null, blue: socketId|null } }
const bySocket = new Map(); // socketId -> { roomCode, color }

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode() {
  let c;
  do { c = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join(''); }
  while (rooms.has(c));
  return c;
}

// Envía a cada jugador SU vista filtrada. Nunca se emite el estado crudo.
function syncRoom(room) {
  for (const color of ['red', 'blue']) {
    const sid = room.sockets[color];
    if (sid) io.to(sid).emit('room_state', G.serializeFor(room.state, color));
  }
}
function broadcastEvents(room, events) {
  for (const ev of events || []) {
    const { to, defender, ...payload } = ev;
    if (ev.type === 'attack_declared') {
      // el prompt de defensa va solo al defensor; el atacante recibe una versión "esperando"
      io.to(room.sockets[defender]).emit('combat_prompt', payload);
      const atk = defender === 'red' ? 'blue' : 'red';
      if (room.sockets[atk]) io.to(room.sockets[atk]).emit('combat_waiting', payload);
    } else if (to) {
      if (room.sockets[to]) io.to(room.sockets[to]).emit(ev.type, payload);
    } else {
      for (const c of ['red', 'blue']) if (room.sockets[c]) io.to(room.sockets[c]).emit(ev.type, payload);
    }
  }
}
function handle(socket, fn) {
  const info = bySocket.get(socket.id);
  if (!info) return socket.emit('error_msg', { message: 'No estás en ninguna sala.' });
  const room = rooms.get(info.roomCode);
  if (!room) return socket.emit('error_msg', { message: 'La sala ya no existe.' });
  const res = fn(room.state, info.color);
  if (res && res.error) return socket.emit('error_msg', { message: res.error });
  broadcastEvents(room, res && res.events);
  syncRoom(room);
}

io.on('connection', (socket) => {
  socket.on('create_room', () => {
    const code = newCode();
    rooms.set(code, { state: G.newGame(code), sockets: { red: socket.id, blue: null } });
    bySocket.set(socket.id, { roomCode: code, color: 'red' });
    socket.emit('room_created', { roomCode: code, color: 'red' });
    syncRoom(rooms.get(code));
  });

  socket.on('join_room', ({ roomCode } = {}) => {
    const room = rooms.get(String(roomCode || '').toUpperCase().trim());
    if (!room) return socket.emit('error_msg', { message: 'Sala no encontrada.' });
    if (room.sockets.blue) return socket.emit('error_msg', { message: 'La sala está llena.' });
    room.sockets.blue = socket.id;
    bySocket.set(socket.id, { roomCode: room.state.roomCode, color: 'blue' });
    socket.emit('room_joined', { roomCode: room.state.roomCode, color: 'blue' });
    if (room.sockets.red) io.to(room.sockets.red).emit('opponent_joined', {});
    syncRoom(room);
  });

  socket.on('submit_setup', ({ placements } = {}) => handle(socket, (st, c) => G.submitSetup(st, c, placements)));
  socket.on('move_piece', ({ pieceId, targetCellId } = {}) => handle(socket, (st, c) => G.movePiece(st, c, pieceId, targetCellId)));
  socket.on('swap_pieces', ({ pieceIdA, pieceIdB } = {}) => handle(socket, (st, c) => G.swapPieces(st, c, pieceIdA, pieceIdB)));
  socket.on('declare_attack', ({ attackerId, defenderId } = {}) => handle(socket, (st, c) => G.declareAttack(st, c, attackerId, defenderId)));
  socket.on('end_turn', () => handle(socket, (st, c) => G.endTurn(st, c)));
  socket.on('defend_choice', ({ choice, fleeRevealPieceId } = {}) => handle(socket, (st, c) => G.defendChoice(st, c, choice, fleeRevealPieceId)));

  socket.on('disconnect', () => {
    const info = bySocket.get(socket.id);
    bySocket.delete(socket.id);
    if (!info) return;
    const room = rooms.get(info.roomCode);
    if (!room) return;
    room.sockets[info.color] = null;
    const otherSid = room.sockets[info.color === 'red' ? 'blue' : 'red'];
    if (otherSid) io.to(otherSid).emit('opponent_left', {}); // v1: sin reconexión, sala perdida
    rooms.delete(info.roomCode);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Rey del Bosque escuchando en :${PORT}`));
