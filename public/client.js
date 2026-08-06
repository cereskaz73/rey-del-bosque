'use strict';
/* Cliente de Rey del Bosque. Regla de oro replicada del servidor: tras confirmar el despliegue,
   este cliente DESCARTA los tipos de tus fichas. Solo pinta lo que el servidor le manda. */

const socket = io(window.BACKEND_URL || undefined);

// --- Geometría (idéntica al SVG de referencia: pointy-top, paso 34, hex 32) ---
const DIRS = [[1,0],[1,-1],[0,-1],[-1,0],[-1,1],[0,1]];
const hexDist = (q,r)=>Math.max(Math.abs(q),Math.abs(r),Math.abs(q+r));
const CELLS = [];
for (let q=-3;q<=3;q++) for (let r=-3;r<=3;r++) if (hexDist(q,r)<=3) CELLS.push(`${q},${r}`);
const DEPLOY = {
  red:['-2,0','-1,-1','-1,0','0,-2','0,-1','1,-2','1,-1','2,-2','2,-1'],
  blue:['-2,1','-2,2','-1,1','-1,2','0,1','0,2','1,0','1,1','2,0'],
};
const S=34, H=32, SQ3=Math.sqrt(3);
const center = (c)=>{const [q,r]=c.split(',').map(Number); return [S*SQ3*(q+r/2), S*1.5*r];};
const HEXPTS = [[H*SQ3/2,-H/2],[H*SQ3/2,H/2],[0,H],[-H*SQ3/2,H/2],[-H*SQ3/2,-H/2],[0,-H]];
const neighbors=(c)=>{const [q,r]=c.split(',').map(Number);return DIRS.map(([dq,dr])=>`${q+dq},${r+dr}`).filter(x=>{const[a,b]=x.split(',').map(Number);return hexDist(a,b)<=3;});};

const INFO = {
  abeja:{e:'🐝',n:'Abeja',rank:'0'}, paloma:{e:'🕊️',n:'Paloma',rank:'1'}, rey:{e:'🐀',n:'Rey Rata',rank:'2'},
  ciervo:{e:'🦌',n:'Ciervo',rank:'3'}, jabali:{e:'🐗',n:'Jabalí',rank:'4'}, lobo:{e:'🐺',n:'Lobo',rank:'5'},
  oso:{e:'🐻',n:'Oso',rank:'6'}, cepo:{e:'🪤',n:'Cepo',rank:'—'},
};
const SETUP_TYPES = ['abeja','paloma','rey','ciervo','jabali','lobo','oso','cepo','cepo'];

// --- Estado del cliente ---
let my = null;                 // 'red' | 'blue'
let view = null;               // último room_state filtrado por el servidor
let setup = { placements: {}, trayIdx: null, confirmed: false }; // cellId -> {trayIdx, type}
let ui = { mode: 'idle', selPiece: null, swapFirst: null, pendingDefense: null, overlayLock: false };

const $ = (id)=>document.getElementById(id);
const boardEl = $('board');
const statusEl = $('status');
function setStatus(msg, isErr){ statusEl.textContent = msg; statusEl.className = isErr ? 'err' : ''; }

// --- Lobby ---
$('btnCreate').onclick = ()=>socket.emit('create_room');
$('btnJoin').onclick = ()=>socket.emit('join_room',{ roomCode:$('inpCode').value });
socket.on('connect', ()=>setStatus('Conectado. Crea o únete a una sala.'));
socket.on('error_msg', (d)=>setStatus(d.message, true));
socket.on('room_created', (d)=>enterRoom(d));
socket.on('room_joined', (d)=>enterRoom(d));
socket.on('opponent_joined', ()=>setStatus('¡Rival conectado! Coloca tus fichas.'));
socket.on('opponent_left', ()=>{ showOverlay('<h3>Tu rival se ha desconectado 😞</h3><p>La sala se ha cerrado. Recarga la página para jugar otra.</p>', false); });

function enterRoom(d){
  my = d.color;
  $('lobby').classList.add('hidden');
  $('main').classList.remove('hidden');
  $('roomBadge').classList.remove('hidden');
  $('roomBadge').innerHTML = `Sala: <b>${d.roomCode}</b> · Eres ${my==='red'?'🔴 Rojo':'🔵 Azul'}`;
  buildTray();
  $('setupPanel').classList.remove('hidden');
  setStatus(my==='red' ? 'Comparte el código con tu rival. Ve colocando tus fichas.' : 'Coloca tus fichas.');
}

// --- Colocación ---
function buildTray(){
  const tray = $('tray'); tray.innerHTML='';
  SETUP_TYPES.forEach((t,i)=>{
    const b=document.createElement('div');
    b.className='trayPiece'; b.dataset.idx=i;
    b.innerHTML=`<span>${INFO[t].e}</span><span>${INFO[t].n} <b>${INFO[t].rank}</b></span>`;
    b.onclick=()=>{ if(setup.confirmed) return;
      if(Object.values(setup.placements).some(p=>p.trayIdx===i)) return; // ya colocada: se recoge tocándola en el tablero
      setup.trayIdx = setup.trayIdx===i ? null : i; renderAll(); };
    tray.appendChild(b);
  });
}
$('btnConfirm').onclick = ()=>{
  const placements = Object.entries(setup.placements).map(([cellId,p])=>({ pieceType:p.type, cellId }));
  socket.emit('submit_setup', { placements });
};
socket.on('setup_ok', ()=>{
  setup.confirmed = true;
  setup.placements = {};           // ← se descartan los tipos: a partir de aquí, solo memoria
  setup.trayIdx = null;
  $('setupPanel').classList.add('hidden');
  setStatus('Despliegue confirmado. Esperando al rival…');
});
socket.on('game_start', (d)=>{
  $('playPanel').classList.remove('hidden');
  showOverlay(`<h3>🪙 Tirada de moneda</h3><p>Empieza <b>${d.firstTurn==='red'?'🔴 Rojo':'🔵 Azul'}</b>${d.firstTurn===my?' — ¡o sea, tú!':''}</p><button onclick="hideOverlay()">¡A jugar!</button>`, false);
});

// --- Render ---
function renderAll(){
  boardEl.innerHTML='';
  const g = document.createElementNS('http://www.w3.org/2000/svg','g');
  if (my==='red') g.setAttribute('transform','scale(-1,-1)'); // tu zona siempre abajo
  boardEl.appendChild(g);
  const occ = {}; if (view) for (const p of Object.values(view.pieces)) occ[p.cellId]=p;

  const legalMoves = computeLegalCells();
  for (const c of CELLS){
    const [cx,cy]=center(c);
    const poly=document.createElementNS('http://www.w3.org/2000/svg','polygon');
    poly.setAttribute('points', HEXPTS.map(([x,y])=>`${cx+x},${cy+y}`).join(' '));
    poly.setAttribute('class','cell'
      + (!setup.confirmed && my && DEPLOY[my].includes(c) ? ' deployMine':'')
      + (legalMoves.move.has(c) ? ' hl':'') + (legalMoves.atk.has(c) ? ' hlAtk':''));
    poly.onclick=()=>onCellClick(c);
    g.appendChild(poly);
  }
  // Fichas en colocación (solo yo las veo, y solo ahora)
  if (!setup.confirmed){
    for (const [cellId,p] of Object.entries(setup.placements)) drawPiece(g, cellId, my, p.type, false, ()=>pickUp(cellId));
    document.querySelectorAll('.trayPiece').forEach((el)=>{
      const i=+el.dataset.idx;
      el.classList.toggle('placed', Object.values(setup.placements).some(p=>p.trayIdx===i));
      el.classList.toggle('sel', setup.trayIdx===i);
    });
    $('btnConfirm').disabled = Object.keys(setup.placements).length!==9;
  }
  // Fichas según el servidor (partida en marcha)
  if (view && setup.confirmed){
    for (const p of Object.values(view.pieces))
      drawPiece(g, p.cellId, p.owner, p.revealed ? p.type : null, ui.selPiece===p.id || ui.swapFirst===p.id, ()=>onPieceClick(p));
    // Combate pendiente: resaltar casilla atacante y defensora en ambos clientes (solo posición, nunca tipo).
    if (view.pending){
      const a=view.pieces[view.pending.attackerId], d=view.pieces[view.pending.defenderId];
      if (a && d){
        for (const [cell,cls] of [[a.cellId,'atkOutline'],[d.cellId,'defOutline']]){
          const [cx,cy]=center(cell);
          const poly=document.createElementNS('http://www.w3.org/2000/svg','polygon');
          poly.setAttribute('points', HEXPTS.map(([x,y])=>`${cx+x},${cy+y}`).join(' '));
          poly.setAttribute('class',cls);
          g.appendChild(poly);
        }
        const [ax,ay]=center(a.cellId), [dx,dy]=center(d.cellId);
        const t=document.createElementNS('http://www.w3.org/2000/svg','text');
        t.setAttribute('class','swordIcon'); t.setAttribute('dy','7');
        t.setAttribute('transform', `translate(${(ax+dx)/2},${(ay+dy)/2})${my==='red'?' scale(-1,-1)':''}`);
        t.textContent='⚔️';
        g.appendChild(t);
      }
    }
    // Aviso de intercambio reciente: resaltar ambas casillas y conectarlas durante ~3,5s.
    if (ui.swapFx && Date.now() < ui.swapFx.until){
      for (const c of [ui.swapFx.cellA, ui.swapFx.cellB]){
        const [cx,cy]=center(c);
        const poly=document.createElementNS('http://www.w3.org/2000/svg','polygon');
        poly.setAttribute('points', HEXPTS.map(([x,y])=>`${cx+x},${cy+y}`).join(' '));
        poly.setAttribute('class','swapOutline');
        g.appendChild(poly);
      }
      const [x1,y1]=center(ui.swapFx.cellA), [x2,y2]=center(ui.swapFx.cellB);
      const line=document.createElementNS('http://www.w3.org/2000/svg','line');
      line.setAttribute('x1',x1); line.setAttribute('y1',y1); line.setAttribute('x2',x2); line.setAttribute('y2',y2);
      line.setAttribute('class','swapLine');
      g.appendChild(line);
      const t=document.createElementNS('http://www.w3.org/2000/svg','text');
      t.setAttribute('class','swordIcon'); t.setAttribute('dy','7');
      t.setAttribute('transform', `translate(${(x1+x2)/2},${(y1+y2)/2})${my==='red'?' scale(-1,-1)':''}`);
      t.textContent='🔄';
      g.appendChild(t);
    }
  }
  renderGraveyard(); renderTurnUI();
}
function drawPiece(g, cellId, owner, type, sel, onClick){
  const [cx,cy]=center(cellId);
  const gp=document.createElementNS('http://www.w3.org/2000/svg','g');
  gp.setAttribute('class',`piece ${owner}${sel?' sel':''}`);
  if (my==='red') gp.setAttribute('transform',`translate(${cx},${cy}) scale(-1,-1)`); // deshacer el volteo para el contenido
  else gp.setAttribute('transform',`translate(${cx},${cy})`);
  const circ=document.createElementNS('http://www.w3.org/2000/svg','circle');
  circ.setAttribute('r', 22); gp.appendChild(circ);
  if (type){
    const t=document.createElementNS('http://www.w3.org/2000/svg','text');
    t.setAttribute('class','emoji'); t.setAttribute('dy','6'); t.setAttribute('y','-3'); t.textContent=INFO[type].e; gp.appendChild(t);
    const rk=document.createElementNS('http://www.w3.org/2000/svg','text');
    rk.setAttribute('class','rankTxt'); rk.setAttribute('y','17'); rk.textContent=INFO[type].rank; gp.appendChild(rk);
  } else {
    const t=document.createElementNS('http://www.w3.org/2000/svg','text');
    t.setAttribute('class','emoji'); t.setAttribute('dy','8'); t.textContent='🍂'; gp.appendChild(t); // dorso idéntico para todas
  }
  gp.onclick=(e)=>{ e.stopPropagation(); onClick && onClick(); };
  g.appendChild(gp);
}
function computeLegalCells(){
  const res={ move:new Set(), atk:new Set() };
  if (!view || !setup.confirmed || view.phase==='gameover' || view.turn!==my || !ui.selPiece) return res;
  const p=view.pieces[ui.selPiece]; if(!p) return res;
  const occ={}; for (const q of Object.values(view.pieces)) occ[q.cellId]=q;
  for (const n of neighbors(p.cellId)){
    if (view.phase==='move' && ui.mode!=='swap' && !occ[n]) res.move.add(n);
    if (view.phase==='attack' && occ[n] && occ[n].owner!==my) res.atk.add(n);
  }
  return res;
}
function renderGraveyard(){
  if (!view) return;
  const fmt=(c)=>view.graveyard[c].map(t=>INFO[t].e).join(' ')||'—';
  $('graveyard').innerHTML=`<b>Bajas</b> · 🔴 ${fmt('red')} · 🔵 ${fmt('blue')}`;
}
function renderTurnUI(){
  if (!view || !setup.confirmed) return;
  const mine = view.turn===my;
  $('btnSwap').classList.toggle('hidden', !(mine && view.phase==='move'));
  $('btnSwap').textContent = ui.mode==='swap' ? 'Cancelar intercambio' : 'Modo intercambio';
  $('btnEndTurn').classList.toggle('hidden', !(mine && view.phase==='attack'));
  if (view.phase==='gameover') return;
  if (view.phase==='setup') return;
  if (view.phase==='defend'){ if (!mine) return; setStatus('Esperando la decisión del defensor…'); return; }
  if (!mine) setStatus('Turno del rival…');
  else if (view.phase==='move') setStatus(ui.mode==='swap' ? 'Intercambio: toca tus DOS fichas a intercambiar.' : 'Tu turno: mueve una ficha (o usa intercambio).');
  else if (view.phase==='attack') setStatus('Opcional: toca una ficha tuya y luego una enemiga adyacente para atacar, o termina el turno.');
}

// --- Interacción ---
function onCellClick(c){
  if (!setup.confirmed){
    if (setup.trayIdx===null || !DEPLOY[my].includes(c) || setup.placements[c]) return;
    setup.placements[c]={ trayIdx:setup.trayIdx, type:SETUP_TYPES[setup.trayIdx] };
    setup.trayIdx=null; renderAll(); return;
  }
  if (!view || view.turn!==my) return;
  if (view.phase==='move' && ui.selPiece && ui.mode!=='swap'){
    socket.emit('move_piece',{ pieceId:ui.selPiece, targetCellId:c });
    ui.selPiece=null;
  }
}
function pickUp(cellId){ if(!setup.confirmed){ const p=setup.placements[cellId]; delete setup.placements[cellId]; setup.trayIdx=p.trayIdx; renderAll(); } }
function onPieceClick(p){
  if (!view || view.phase==='gameover') return;
  if (ui.pendingDefense && ui.pendingDefense.picking){ // eligiendo qué revelar para huir
    if (p.owner===my && !p.revealed && p.id!==ui.pendingDefense.defenderId){
      socket.emit('defend_choice',{ choice:'flee', fleeRevealPieceId:p.id });
      ui.pendingDefense=null; hideOverlay();
    }
    return;
  }
  if (view.turn!==my) return;
  if (view.phase==='move'){
    if (p.owner!==my) return;
    if (ui.mode==='swap'){
      if (!ui.swapFirst) ui.swapFirst=p.id;
      else if (ui.swapFirst!==p.id){ socket.emit('swap_pieces',{ pieceIdA:ui.swapFirst, pieceIdB:p.id }); ui.swapFirst=null; ui.mode='idle'; }
      renderAll(); return;
    }
    ui.selPiece = ui.selPiece===p.id ? null : p.id; renderAll();
  } else if (view.phase==='attack'){
    if (p.owner===my){ ui.selPiece = ui.selPiece===p.id ? null : p.id; renderAll(); }
    else if (ui.selPiece){
      const a=view.pieces[ui.selPiece];
      if (a && neighbors(a.cellId).includes(p.cellId)) socket.emit('declare_attack',{ attackerId:ui.selPiece, defenderId:p.id });
      ui.selPiece=null;
    }
  }
}
$('btnSwap').onclick=()=>{ ui.mode = ui.mode==='swap' ? 'idle' : 'swap'; ui.selPiece=null; ui.swapFirst=null; renderAll(); };
$('btnEndTurn').onclick=()=>{ ui.selPiece=null; socket.emit('end_turn'); };

// --- Defensa ---
socket.on('combat_prompt', (d)=>{
  ui.pendingDefense={ defenderId:d.defenderId, picking:false };
  const canFlee = Object.values(view?.pieces||{}).some(p=>p.owner===my && !p.revealed && p.id!==d.defenderId);
  showOverlay(`<h3>⚔️ ¡Te atacan!</h3><p>Una ficha enemiga ataca a tu ficha. ¿Qué haces?</p>
    <button id="ovAccept">Aceptar combate</button>
    <button id="ovFlee" class="sec" ${canFlee?'':'disabled'}>Huir (revelar otra ficha)</button>
    ${canFlee?'':'<p style="font-size:.8rem">No te quedan otras fichas ocultas: debes aceptar.</p>'}`, false, 'defend');
  $('ovAccept').onclick=()=>{ socket.emit('defend_choice',{ choice:'accept' }); ui.pendingDefense=null; hideOverlay(); };
  if (canFlee) $('ovFlee').onclick=()=>{ ui.pendingDefense.picking=true; hideOverlay(); setStatus('HUIR: toca la ficha oculta tuya que quieres revelar como coste. ⚠️ Si es tu Rey Rata, pierdes.'); };
});
socket.on('combat_waiting', ()=>setStatus('Ataque declarado. El defensor está decidiendo…'));
socket.on('swapped', (d)=>{
  ui.swapFx={ cellA:d.cellA, cellB:d.cellB, until:Date.now()+3500 };
  renderAll();
  setTimeout(()=>{ ui.swapFx=null; renderAll(); }, 3600);
});

// --- Resultados ---
socket.on('combat_result', (d)=>{
  const A=INFO[d.attackerType];
  const D=d.defenderType ? INFO[d.defenderType] : { e:'🍂', n:'¿?', rank:'?' }; // atacante incapaz: el defensor no se muestra
  let msg;
  if (d.connectivityTie) msg='🔗 ¡El resultado rompería la conectividad! Se resuelve como <b>empate</b>: todo vuelve a su sitio.';
  else if (d.result==='attacker_self') msg = d.attackerType==='rey'
    ? '👑 ¡El Rey Rata no puede atacar! Se revela y se elimina… <b>derrota instantánea de su dueño.</b>'
    : '🪤 ¡El Cepo no puede atacar! Se revela y se elimina. El defensor no llega a mostrarse.';
  else if (d.result==='tie') msg='🤝 <b>Empate.</b> Ambas fichas vuelven a ocultarse en su sitio.';
  else if (d.result==='both') msg='💥 ¡El Cepo se lleva al atacante por delante! Ambas fichas eliminadas.';
  else if (d.result==='attacker') msg='⚔️ <b>Gana el atacante.</b> La defensora se retira.';
  else msg='🛡️ <b>Gana la defensora.</b> El atacante se retira.';
  showOverlay(`<h3>Combate</h3>
    <div class="combatShow">
      <div><div class="big">${A.e}</div>${A.n} (${A.rank})<div style="font-size:.75rem">ataca</div></div>
      <div class="vs">VS</div>
      <div><div class="big">${D.e}</div>${D.n} (${D.rank})<div style="font-size:.75rem">defiende</div></div>
    </div><p>${msg}</p><p style="font-size:.8rem">Memoriza lo que acabas de ver…</p>`, 3800);
});
socket.on('flee_result', (d)=>{
  const R=INFO[d.revealedType];
  showOverlay(`<h3>🏃 El defensor huye</h3><p>El combate no se resuelve. Como coste, revela permanentemente: <span style="font-size:2rem">${R.e}</span> <b>${R.n} (${R.rank})</b></p>`, 3000);
});
socket.on('game_over', (d)=>{
  const reasons={ captura_rey:'¡Rey Rata capturado!', rey_ataca:'Un Rey Rata ha atacado: derrota instantánea.', rey_revelado_huyendo:'Un Rey Rata ha sido revelado como coste de huir: derrota instantánea.', tablas:'Ambos bandos han perdido Ciervo, Jabalí y Lobo: nadie puede capturar ya.' };
  let head = d.winner==='draw' ? '🤝 Tablas' : (d.winner===my ? '🏆 ¡Has ganado!' : '💀 Has perdido');
  setTimeout(()=>showOverlay(`<h3>${head}</h3><p>${reasons[d.reason]||''}</p><p>Recarga la página para jugar otra partida.</p>`, false), ui.overlayLock?4000:200);
});

// --- Estado sincronizado ---
socket.on('room_state', (v)=>{ view=v; renderAll(); });

// --- Overlay ---
let overlayTimer=null;
function showOverlay(html, autoMs, mode){
  clearTimeout(overlayTimer);
  $('overlayCard').innerHTML=html;
  $('overlay').className = mode || '';
  ui.overlayLock = !!autoMs;
  if (autoMs) overlayTimer=setTimeout(hideOverlay, autoMs);
}
function hideOverlay(){ $('overlay').className='hidden'; ui.overlayLock=false; renderAll(); }
window.hideOverlay=hideOverlay;

renderAll();
