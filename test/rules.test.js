'use strict';
const G = require('../server/game');
let n = 0, fail = 0;
function ok(cond, msg) { n++; if (!cond) { fail++; console.error('FAIL:', msg); } }

// Helper: partida con despliegue estándar (orden fijo de tipos sobre las zonas del SVG).
function fullGame() {
  const st = G.newGame('TEST');
  for (const color of ['red', 'blue']) {
    const placements = G.SETUP_TYPES.map((t, i) => ({ pieceType: t, cellId: G.DEPLOY[color][i] }));
    const r = G.submitSetup(st, color, placements);
    ok(!r.error, 'setup válido ' + color + (r.error ? ': ' + r.error : ''));
  }
  return st;
}
// Helper: estado artificial con fichas concretas para probar combates aislados.
function custom(pieces) {
  const st = G.newGame('T2');
  st.phase = 'attack';
  pieces.forEach((p, i) => {
    const id = p.id || `${p.owner}${i}`;
    st.pieces[id] = { id, owner: p.owner, type: p.type, cellId: p.cellId, revealed: !!p.revealed, alive: true };
  });
  st.players.red.ready = st.players.blue.ready = true;
  return st;
}
function fight(st, color, atkId, defId, choice = 'accept', fleeId) {
  st.turn = color; st.phase = 'attack';
  let r = G.declareAttack(st, color, atkId, defId);
  if (r.error || st.phase === 'gameover') return r;
  r = G.defendChoice(st, choice === 'accept' ? (color === 'red' ? 'blue' : 'red') : choice.owner, choice === 'accept' ? 'accept' : 'flee', fleeId);
  return r;
}

// --- Setup ---
{
  const st = fullGame();
  ok(st.phase === 'move' && (st.turn === 'red' || st.turn === 'blue'), 'moneda tras doble ready');
  const bad = G.submitSetup(G.newGame('X'), 'red', G.SETUP_TYPES.map((t, i) => ({ pieceType: t, cellId: G.DEPLOY.blue[i] })));
  ok(bad.error, 'rechaza colocar en zona rival');
  const dup = G.newGame('X2');
  const types = [...G.SETUP_TYPES]; types[0] = 'lobo'; // dos lobos, sin abeja
  ok(G.submitSetup(dup, 'red', types.map((t, i) => ({ pieceType: t, cellId: G.DEPLOY.red[i] }))).error, 'rechaza multiset inválido');
}

// --- Movimiento y conectividad ---
{
  const st = fullGame();
  st.turn = 'red'; st.phase = 'move';
  // (2,-2)→(3,-2): anillo exterior, sigue conectada vía (2,-1).
  const id = Object.values(st.pieces).find((p) => p.owner === 'red' && p.cellId === '2,-2').id;
  ok(!G.movePiece(st, 'red', id, '3,-2').error, 'mover a anillo exterior');
  ok(st.phase === 'attack', 'tras mover, fase attack');
  // (3,-2)→(3,-3): todos sus vecinos quedan vacíos → desconexión.
  st.phase = 'move';
  const r2 = G.movePiece(st, 'red', id, '3,-3');
  ok(r2.error, 'rechaza movimiento que desconecta: ' + (r2.error || 'NO')); 
  // swap siempre legal entre propias
  ok(!G.swapPieces(st, 'red', id, Object.values(st.pieces).find((p) => p.owner === 'red' && p.id !== id).id).error, 'swap válido');
}

// --- Tabla de combate ---
{
  const T = G.outcome;
  ok(T('abeja', 'oso') === 'attacker', 'abeja gana a oso atacando');
  ok(T('oso', 'abeja') === 'defender', 'abeja gana a oso defendiendo');
  ok(T('cepo', 'lobo') === 'attacker_self' && T('cepo', 'paloma') === 'attacker_self', 'cepo atacante se autoelimina (incluso vs paloma)');
  ok(T('rey', 'abeja') === 'attacker_self', 'rey atacante se autoelimina (→ derrota de su dueño)');
  ok(T('paloma', 'cepo') === 'attacker', 'paloma elimina cepo y sobrevive');
  ok(T('lobo', 'cepo') === 'both', 'cepo elimina al atacante consigo');
  ok(T('oso', 'rey') === 'tie', 'oso no captura al rey: empate');
  ok(T('abeja', 'rey') === 'defender' && T('paloma', 'rey') === 'defender', 'rey gana a abeja/paloma');
  ok(T('ciervo', 'rey') === 'attacker' && T('lobo', 'rey') === 'attacker', 'rango>2 captura al rey');
  ok(T('lobo', 'lobo') === 'tie' && T('jabali', 'ciervo') === 'attacker' && T('ciervo', 'jabali') === 'defender', 'ranking normal');
}

// --- Combate integrado: captura del rey = victoria ---
{
  const st = custom([
    { owner: 'red', type: 'lobo', cellId: '0,0', id: 'redA' },
    { owner: 'red', type: 'rey', cellId: '-1,0', id: 'redB' },
    { owner: 'blue', type: 'rey', cellId: '0,1', id: 'blueA' },
    { owner: 'blue', type: 'ciervo', cellId: '1,0', id: 'blueB' },
  ]);
  const r = fight(st, 'red', 'redA', 'blueA');
  ok(st.winner === 'red' && st.endReason === 'captura_rey', 'lobo captura rey → victoria roja');
  ok(r.events.some((e) => e.type === 'combat_result' && e.result === 'attacker'), 'evento de combate emitido');
}

// --- Conectividad de máxima prioridad: la captura que desconecta se vuelve empate ---
{
  // blue: ciervo - REY(puente) - abeja en línea. Capturar al rey partiría a blue en dos.
  const st = custom([
    { owner: 'red', type: 'lobo', cellId: '0,-1', id: 'atk' },
    { owner: 'red', type: 'abeja', cellId: '-1,0', id: 'r2' },
    { owner: 'blue', type: 'ciervo', cellId: '-1,1', id: 'b1' },
    { owner: 'blue', type: 'rey', cellId: '0,0', id: 'brey' },
    { owner: 'blue', type: 'abeja', cellId: '1,0', id: 'b3' },
  ]);
  const r = fight(st, 'red', 'atk', 'brey');
  const ev = r.events.find((e) => e.type === 'combat_result');
  ok(ev.result === 'tie' && ev.connectivityTie && st.winner === null, 'captura del rey anulada por conectividad → empate');
  ok(st.pieces.brey.alive && st.turn === 'blue', 'rey sigue vivo y pasa el turno');
}

// --- Cepo ("bomba") que desconectaría → empate ---
{
  const st = custom([
    { owner: 'red', type: 'lobo', cellId: '0,-1', id: 'atk' },   // si muriera, red queda partido
    { owner: 'red', type: 'abeja', cellId: '1,-1', id: 'r2' },
    { owner: 'red', type: 'oso', cellId: '-1,0', id: 'r3' },     // solo conecta vía atk
    { owner: 'blue', type: 'cepo', cellId: '0,0', id: 'bcepo' },
    { owner: 'blue', type: 'rey', cellId: '0,1', id: 'brey' },
  ]);
  // vecinos de 0,-1: 1,-1 ✓, -1,0 ✓... comprobar que sin atk, r2(1,-1) y r3(-1,0) no son adyacentes → desconexión
  const r = fight(st, 'red', 'atk', 'bcepo');
  const ev = r.events.find((e) => e.type === 'combat_result');
  ok(ev.result === 'tie' && ev.connectivityTie && st.pieces.atk.alive && st.pieces.bcepo.alive, 'explosión de cepo anulada por conectividad');
}

// --- Rey atacando: el defensor decide primero ---
{
  const st = custom([
    { owner: 'red', type: 'rey', cellId: '0,0', id: 'rrey' },
    { owner: 'red', type: 'lobo', cellId: '-1,0', id: 'rl' },
    { owner: 'blue', type: 'abeja', cellId: '0,1', id: 'b1' },
    { owner: 'blue', type: 'ciervo', cellId: '1,1', id: 'b2' },
  ]);
  st.turn = 'red';
  G.declareAttack(st, 'red', 'rrey', 'b1');
  ok(st.phase === 'defend' && st.winner === null, 'atacar con rey NO termina la partida al declarar');
  // si el defensor huye: no se muestra ninguna ficha del combate y el rey sobrevive impune
  let r = G.defendChoice(st, 'blue', 'flee', 'b2');
  ok(!r.error && st.winner === null && st.pieces.rrey.alive && !st.pieces.rrey.revealed, 'huida ante rey atacante: nada se muestra, sigue la partida');
  ok(r.events.every((e) => e.type !== 'combat_result'), 'huir no emite combat_result');
  // si el defensor acepta: el rey se revela, se elimina y su dueño pierde; el defensor no se muestra
  st.turn = 'red'; st.phase = 'attack';
  G.declareAttack(st, 'red', 'rrey', 'b1');
  r = G.defendChoice(st, 'blue', 'accept');
  const ev = r.events.find((e) => e.type === 'combat_result');
  ok(st.winner === 'blue' && st.endReason === 'rey_ataca', 'rey ataca y le aceptan → pierde su dueño');
  ok(ev.attackerType === 'rey' && ev.defenderType === null && ev.removed.includes('rrey'), 'rey revelado y eliminado; defensor oculto (type null)');
}

// --- Cepo atacando: se autoelimina sin revelar al defensor ---
{
  const st = custom([
    { owner: 'red', type: 'cepo', cellId: '0,0', id: 'rc' },
    { owner: 'red', type: 'rey', cellId: '-1,0', id: 'rr' },
    { owner: 'blue', type: 'lobo', cellId: '0,1', id: 'bl' },
    { owner: 'blue', type: 'rey', cellId: '1,1', id: 'br' },
  ]);
  const r = fight(st, 'red', 'rc', 'bl');
  const ev = r.events.find((e) => e.type === 'combat_result');
  ok(ev.result === 'attacker_self' && ev.defenderType === null, 'cepo atacante: evento sin type del defensor');
  ok(!st.pieces.rc.alive && st.graveyard.red.includes('cepo') && st.pieces.bl.alive && !st.pieces.bl.revealed, 'cepo eliminado, defensor intacto y oculto');
  ok(st.winner === null && st.turn === 'blue', 'la partida sigue y pasa el turno');
}

// --- Cepo atacante cuya baja desconectaría su propio grupo → empate por conectividad ---
{
  const st = custom([
    { owner: 'red', type: 'cepo', cellId: '0,-1', id: 'rc' },   // puente entre r2 y r3
    { owner: 'red', type: 'abeja', cellId: '1,-1', id: 'r2' },
    { owner: 'red', type: 'oso', cellId: '-1,0', id: 'r3' },
    { owner: 'blue', type: 'lobo', cellId: '0,0', id: 'bl' },
    { owner: 'blue', type: 'rey', cellId: '0,1', id: 'br' },
  ]);
  const r = fight(st, 'red', 'rc', 'bl');
  const ev = r.events.find((e) => e.type === 'combat_result');
  ok(ev.result === 'tie' && ev.connectivityTie && ev.defenderType === null && st.pieces.rc.alive, 'autoeliminación de cepo anulada por conectividad; defensor sigue oculto');
}

// --- Huir: coste, validación y rey revelado ---
{
  const st = custom([
    { owner: 'red', type: 'lobo', cellId: '0,0', id: 'atk' },
    { owner: 'blue', type: 'ciervo', cellId: '0,1', id: 'def' },
    { owner: 'blue', type: 'jabali', cellId: '1,0', id: 'bh', revealed: false },
    { owner: 'blue', type: 'rey', cellId: '1,1', id: 'brey' },
  ]);
  st.turn = 'red';
  G.declareAttack(st, 'red', 'atk', 'def');
  ok(G.defendChoice(st, 'blue', 'flee', 'def').error, 'no puede revelarse a sí misma');
  const r = G.defendChoice(st, 'blue', 'flee', 'bh');
  ok(!r.error && st.pieces.bh.revealed && st.pieces.def.alive && st.turn === 'blue', 'huir revela otra ficha y pasa turno');
  // rey como coste de huir → derrota
  const st2 = custom([
    { owner: 'red', type: 'lobo', cellId: '0,0', id: 'atk' },
    { owner: 'blue', type: 'ciervo', cellId: '0,1', id: 'def' },
    { owner: 'blue', type: 'rey', cellId: '1,0', id: 'brey' },
  ]);
  st2.turn = 'red';
  G.declareAttack(st2, 'red', 'atk', 'def');
  G.defendChoice(st2, 'blue', 'flee', 'brey');
  ok(st2.winner === 'red' && st2.endReason === 'rey_revelado_huyendo', 'revelar rey al huir → derrota');
  // sin fichas ocultas disponibles → flee rechazado
  const st3 = custom([
    { owner: 'red', type: 'lobo', cellId: '0,0', id: 'atk' },
    { owner: 'blue', type: 'rey', cellId: '0,1', id: 'def' },
  ]);
  st3.turn = 'red';
  G.declareAttack(st3, 'red', 'atk', 'def');
  ok(G.defendChoice(st3, 'blue', 'flee').error, 'huir imposible sin otra ficha oculta');
}

// --- Tablas ---
{
  const st = custom([
    { owner: 'red', type: 'lobo', cellId: '0,0', id: 'rl' },
    { owner: 'red', type: 'rey', cellId: '-1,0', id: 'rr' },
    { owner: 'blue', type: 'lobo', cellId: '0,1', id: 'bl' },
    { owner: 'blue', type: 'rey', cellId: '1,1', id: 'br' },
  ]);
  st.graveyard.red = ['ciervo', 'jabali'];
  st.graveyard.blue = ['ciervo', 'jabali'];
  const r = fight(st, 'red', 'rl', 'bl'); // lobo vs lobo... empate, no muere nadie → sin tablas aún
  ok(st.winner === null, 'empate de lobos no dispara tablas');
  // matamos los lobos a mano y forzamos un combate cualquiera que dispare el check
  st.pieces.rl.alive = false; st.graveyard.red.push('lobo');
  st.pieces.bl.alive = false; st.graveyard.blue.push('lobo');
  const st2 = custom([
    { owner: 'red', type: 'oso', cellId: '0,0', id: 'ro' },
    { owner: 'red', type: 'rey', cellId: '-1,0', id: 'rr' },
    { owner: 'blue', type: 'abeja', cellId: '0,1', id: 'ba' },
    { owner: 'blue', type: 'rey', cellId: '1,1', id: 'br' },
  ]);
  st2.graveyard.red = ['ciervo', 'jabali', 'lobo'];
  st2.graveyard.blue = ['ciervo', 'jabali'];
  fight(st2, 'blue', 'ba', 'ro'); // abeja mata oso; luego graveyard blue completa lobo? no... red pierde oso.
  ok(st2.winner === null, 'aún no tablas (a blue le falta perder el lobo)');
  st2.phase = 'attack';
  const st3 = custom([
    { owner: 'red', type: 'oso', cellId: '0,0', id: 'ro' },
    { owner: 'red', type: 'rey', cellId: '-1,0', id: 'rr' },
    { owner: 'blue', type: 'lobo', cellId: '0,1', id: 'bl' },
    { owner: 'blue', type: 'rey', cellId: '1,1', id: 'br' },
  ]);
  st3.graveyard.red = ['ciervo', 'jabali', 'lobo'];
  st3.graveyard.blue = ['ciervo', 'jabali'];
  fight(st3, 'red', 'ro', 'bl'); // oso mata al último lobo azul → ambos sin 3/4/5 → tablas
  ok(st3.winner === 'draw' && st3.endReason === 'tablas', 'tablas al perder ambos ciervo+jabalí+lobo');
}

// --- Filtrado de información ---
{
  const st = fullGame();
  const view = G.serializeFor(st, 'red');
  const leaked = Object.values(view.pieces).filter((p) => p.type !== undefined);
  ok(leaked.length === 0, 'ninguna ficha oculta expone type, ni las propias');
  const someRed = Object.values(st.pieces).find((p) => p.owner === 'red');
  someRed.revealed = true;
  const v2 = G.serializeFor(st, 'blue');
  ok(v2.pieces[someRed.id].type === someRed.type, 'ficha revelada expone type a ambos');
  ok(JSON.stringify(v2).indexOf('"type"') === JSON.stringify(v2).lastIndexOf('"type"'), 'solo la revelada lleva type');
}

console.log(`\n${n - fail}/${n} tests OK${fail ? ' — HAY FALLOS' : ''}`);
process.exit(fail ? 1 : 0);
