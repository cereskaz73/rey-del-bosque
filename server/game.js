'use strict';
// Lógica pura de Rey del Bosque. Sin sockets: recibe acciones, muta el estado, devuelve eventos.

const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
const key = (q, r) => `${q},${r}`;
const parse = (c) => c.split(',').map(Number);
const hexDist = (q, r) => Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r));

const CELLS = new Set();
for (let q = -3; q <= 3; q++) for (let r = -3; r <= 3; r++) if (hexDist(q, r) <= 3) CELLS.add(key(q, r));

// Zonas de despliegue extraídas del SVG (fuente de verdad de la geometría).
const DEPLOY = {
  red: ['-2,0', '-1,-1', '-1,0', '0,-2', '0,-1', '1,-2', '1,-1', '2,-2', '2,-1'],
  blue: ['-2,1', '-2,2', '-1,1', '-1,2', '0,1', '0,2', '1,0', '1,1', '2,0'],
};

const RANK = { abeja: 0, paloma: 1, rey: 2, ciervo: 3, jabali: 4, lobo: 5, oso: 6, cepo: -1 };
const SETUP_TYPES = ['abeja', 'paloma', 'rey', 'ciervo', 'jabali', 'lobo', 'oso', 'cepo', 'cepo'];

function neighbors(cellId) {
  const [q, r] = parse(cellId);
  return DIRS.map(([dq, dr]) => key(q + dq, r + dr)).filter((c) => CELLS.has(c));
}

function newGame(roomCode) {
  return {
    roomCode,
    players: { red: { ready: false }, blue: { ready: false } },
    turn: null,
    phase: 'setup', // setup | move | attack | defend | gameover
    pieces: {},     // id -> {id, owner, type, cellId, revealed, alive}
    pending: null,  // {attackerId, defenderId}
    graveyard: { red: [], blue: [] }, // tipos de fichas eliminadas (públicos: se vieron al morir)
    winner: null,   // 'red' | 'blue' | 'draw'
    endReason: null,
  };
}

const alive = (st, color) => Object.values(st.pieces).filter((p) => p.alive && p.owner === color);
const occupancy = (st) => {
  const m = new Map();
  for (const p of Object.values(st.pieces)) if (p.alive) m.set(p.cellId, p.id);
  return m;
};

// Conectividad GLOBAL: todas las fichas vivas del tablero (rojas y azules juntas) deben formar
// un único bloque conectado. El color no importa; lo prohibido es que la masa total se parta
// o que alguna ficha quede aislada. Admite simular bajas (excludeIds) y un movimiento (moves).
function isConnected(st, excludeIds = [], moves = {}) {
  const ps = Object.values(st.pieces).filter((p) => p.alive && !excludeIds.includes(p.id));
  if (ps.length <= 1) return true;
  const cells = new Set(ps.map((p) => moves[p.id] || p.cellId));
  const start = cells.values().next().value;
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    for (const n of neighbors(stack.pop())) {
      if (cells.has(n) && !seen.has(n)) { seen.add(n); stack.push(n); }
    }
  }
  return seen.size === cells.size;
}

function err(msg) { return { error: msg }; }

// ---------- Colocación ----------
function submitSetup(st, color, placements) {
  if (st.phase !== 'setup') return err('No estamos en fase de colocación.');
  if (st.players[color].ready) return err('Ya has confirmado tu despliegue.');
  if (!Array.isArray(placements) || placements.length !== 9) return err('Debes colocar exactamente 9 fichas.');
  const cells = placements.map((p) => p.cellId);
  const types = placements.map((p) => p.pieceType);
  if (new Set(cells).size !== 9) return err('Hay celdas repetidas.');
  if (!cells.every((c) => DEPLOY[color].includes(c))) return err('Hay fichas fuera de tu zona de despliegue.');
  if ([...types].sort().join() !== [...SETUP_TYPES].sort().join()) return err('El conjunto de fichas no es válido.');

  // Ids barajados en servidor: el id no debe correlacionar con el tipo ni con el orden del cliente.
  const shuffled = [...placements];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  shuffled.forEach((p, i) => {
    const id = `${color}${i}`;
    st.pieces[id] = { id, owner: color, type: p.pieceType, cellId: p.cellId, revealed: false, alive: true };
  });
  st.players[color].ready = true;

  const events = [{ type: 'setup_ok', to: color }];
  if (st.players.red.ready && st.players.blue.ready) {
    st.turn = Math.random() < 0.5 ? 'red' : 'blue'; // tirada de moneda en servidor
    st.phase = 'move';
    events.push({ type: 'game_start', firstTurn: st.turn });
  }
  return { events };
}

// ---------- Turno: movimiento ----------
function movePiece(st, color, pieceId, targetCellId) {
  if (st.phase !== 'move' || st.turn !== color) return err('No es tu momento de mover.');
  const p = st.pieces[pieceId];
  if (!p || !p.alive || p.owner !== color) return err('Ficha no válida.');
  if (!CELLS.has(targetCellId)) return err('Celda fuera del tablero.');
  if (!neighbors(p.cellId).includes(targetCellId)) return err('La celda no es adyacente.');
  if (occupancy(st).has(targetCellId)) return err('La celda está ocupada.');
  if (!isConnected(st, [], { [pieceId]: targetCellId })) return err('Ese movimiento rompería la conectividad del bloque de fichas.');
  p.cellId = targetCellId;
  st.phase = 'attack';
  return { events: [{ type: 'moved' }] };
}

function swapPieces(st, color, idA, idB) {
  if (st.phase !== 'move' || st.turn !== color) return err('No es tu momento de mover.');
  const a = st.pieces[idA], b = st.pieces[idB];
  if (!a || !b || idA === idB || !a.alive || !b.alive || a.owner !== color || b.owner !== color) return err('Intercambio no válido.');
  [a.cellId, b.cellId] = [b.cellId, a.cellId];
  st.phase = 'attack';
  // Las posiciones ocupadas son públicas: señalar qué dos casillas se intercambiaron no filtra ningún tipo.
  return { events: [{ type: 'swapped', cellA: a.cellId, cellB: b.cellId }] };
}

// ---------- Turno: ataque ----------
function declareAttack(st, color, attackerId, defenderId) {
  if (st.phase !== 'attack' || st.turn !== color) return err('No puedes atacar ahora.');
  const a = st.pieces[attackerId], d = st.pieces[defenderId];
  if (!a || !a.alive || a.owner !== color) return err('Atacante no válido.');
  if (!d || !d.alive || d.owner === color) return err('Defensor no válido.');
  if (!neighbors(a.cellId).includes(d.cellId)) return err('El objetivo no es adyacente.');
  // Nota: atacar con Rey Rata o Cepo NO se bloquea ni se resuelve aquí: el defensor decide primero.
  // Si huye, no se muestra ninguna ficha; si acepta, el atacante incapaz se revela y elimina (ver resolveCombat).
  st.pending = { attackerId, defenderId };
  st.phase = 'defend';
  return { events: [{ type: 'attack_declared', attackerId, defenderId, defender: d.owner }] };
}

function endTurn(st, color) {
  if (st.phase !== 'attack' || st.turn !== color) return err('No puedes terminar el turno ahora.');
  passTurn(st);
  return { events: [{ type: 'turn_passed' }] };
}

// ---------- Defensa ----------
function defendChoice(st, color, choice, fleeRevealPieceId) {
  if (st.phase !== 'defend' || !st.pending) return err('No hay combate pendiente.');
  const { attackerId, defenderId } = st.pending;
  const a = st.pieces[attackerId], d = st.pieces[defenderId];
  if (d.owner !== color) return err('No eres el defensor.');

  if (choice === 'flee') {
    const candidates = alive(st, color).filter((p) => !p.revealed && p.id !== defenderId);
    if (!candidates.length) return err('No tienes ninguna otra ficha oculta: debes aceptar el combate.');
    const rp = st.pieces[fleeRevealPieceId];
    if (!rp || !rp.alive || rp.owner !== color || rp.revealed || rp.id === defenderId) return err('Ficha a revelar no válida.');
    st.pending = null;
    if (rp.type === 'rey') { // revelar el Rey Rata como coste de huir = derrota instantánea
      return endGame(st, other(color), 'rey_revelado_huyendo', { revealedPieceId: rp.id });
    }
    rp.revealed = true;
    passTurn(st);
    return { events: [{ type: 'flee_result', defenderId, revealedPieceId: rp.id, revealedType: rp.type }] };
  }

  if (choice !== 'accept') return err('Opción no válida.');
  st.pending = null;
  return resolveCombat(st, a, d);
}

// Resultado bruto según tipos (sin conectividad). 'attacker' | 'defender' | 'both' | 'tie' | 'attacker_self'
function outcome(aType, dType) {
  // Cepo y Rey Rata no tienen capacidad de atacar: el atacante se revela y se elimina,
  // ANTES de revelar al defensor (que no se muestra en ningún momento).
  if (aType === 'cepo' || aType === 'rey') return 'attacker_self';
  if (dType === 'rey') {
    if (aType === 'oso') return 'tie';                 // el Oso no puede capturar al Rey Rata
    if (RANK[aType] > RANK.rey) return 'attacker';     // ciervo/jabalí/lobo capturan
    return 'defender';                                  // abeja/paloma pierden contra rango 2
  }
  if (dType === 'cepo') return aType === 'paloma' ? 'attacker' : 'both';
  if (aType === 'abeja' && dType === 'oso') return 'attacker';
  if (aType === 'oso' && dType === 'abeja') return 'defender';
  if (RANK[aType] > RANK[dType]) return 'attacker';
  if (RANK[aType] < RANK[dType]) return 'defender';
  return 'tie';
}

function resolveCombat(st, a, d) {
  const raw = outcome(a.type, d.type);
  let result = raw;
  let removed =
    raw === 'attacker' ? [d.id] :
    raw === 'defender' ? [a.id] :
    raw === 'both' ? [a.id, d.id] :
    raw === 'attacker_self' ? [a.id] : [];

  // Regla de máxima prioridad: si las bajas parten el bloque total de fichas, el combate se calcula como empate.
  let connectivityTie = false;
  if (removed.length && !isConnected(st, removed)) {
    result = 'tie'; removed = []; connectivityTie = true;
  }

  const hideDefender = raw === 'attacker_self'; // el defensor jamás se muestra ante un atacante incapaz
  const capture = result === 'attacker' && d.type === 'rey';
  for (const id of removed) {
    const p = st.pieces[id];
    p.alive = false;
    st.graveyard[p.owner].push(p.type);
  }
  // Revelación breve; los flags 'revealed' no cambian (la ganadora vuelve a ocultarse).
  const combatEvent = {
    type: 'combat_result',
    attackerId: a.id, defenderId: d.id,
    attackerType: a.type, defenderType: hideDefender ? null : d.type,
    result, removed, connectivityTie,
  };

  // Rey Rata usado como atacante y eliminado → derrota instantánea de su dueño.
  if (raw === 'attacker_self' && !connectivityTie && a.type === 'rey')
    return endGame(st, other(a.owner), 'rey_ataca', combatEvent);
  if (capture) return endGame(st, a.owner, 'captura_rey', combatEvent);

  // Tablas: ambos bandos sin Ciervo, Jabalí ni Lobo.
  const noCaptors = (c) => ['ciervo', 'jabali', 'lobo'].every((t) => st.graveyard[c].includes(t));
  if (noCaptors('red') && noCaptors('blue')) {
    st.phase = 'gameover'; st.winner = 'draw'; st.endReason = 'tablas';
    return { events: [combatEvent, { type: 'game_over', winner: 'draw', reason: 'tablas' }] };
  }
  passTurn(st);
  return { events: [combatEvent] };
}

function endGame(st, winner, reason, extraEvent) {
  st.phase = 'gameover'; st.winner = winner; st.endReason = reason; st.pending = null;
  const events = [];
  if (extraEvent) events.push(extraEvent.type ? extraEvent : { type: 'combat_result', ...extraEvent });
  events.push({ type: 'game_over', winner, reason });
  return { events };
}

const other = (c) => (c === 'red' ? 'blue' : 'red');
function passTurn(st) { st.turn = other(st.turn); st.phase = 'move'; }

// ---------- Filtrado por jugador (núcleo de la mecánica de memoria) ----------
// 'type' SOLO viaja si revealed === true. Ni siquiera al dueño de la ficha.
function serializeFor(st, color) {
  const pieces = {};
  for (const p of Object.values(st.pieces)) {
    if (!p.alive) continue;
    pieces[p.id] = { id: p.id, owner: p.owner, cellId: p.cellId, revealed: p.revealed };
    if (p.revealed) pieces[p.id].type = p.type;
  }
  return {
    roomCode: st.roomCode,
    you: color,
    phase: st.phase,
    turn: st.turn,
    winner: st.winner,
    endReason: st.endReason,
    ready: { red: st.players.red.ready, blue: st.players.blue.ready },
    graveyard: st.graveyard,
    pending: st.pending ? { ...st.pending } : null,
    pieces,
  };
}

module.exports = {
  CELLS, DEPLOY, RANK, SETUP_TYPES, neighbors,
  newGame, submitSetup, movePiece, swapPieces, declareAttack, endTurn, defendChoice,
  serializeFor, outcome, isConnected,
};
