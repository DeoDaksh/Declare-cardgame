// =============================================================
//  client.js
//  ---------------------------------------------------------------
//  Everything the browser needs: connecting to the server, switching
//  between screens, and rendering the table. Organized top to bottom
//  as: connection -> screen helpers -> landing/lobby -> game render
//  -> interaction ("selection mode") -> event wiring.
// =============================================================

const socket = io();

const POWER_RANKS = { '10': 'peek-own', 'J': 'peek-opponent', 'Q': 'swap-blind' };
const RED_SUITS = ['♥', '♦'];

let myId = null;
let latestState = null;

// Local-only UI state that the server doesn't need to know about yet
// (e.g. "I clicked Swap, now waiting for them to pick which card").
let ui = {
  mode: null,           // null | 'awaiting-swap-slot' | 'awaiting-peek-own' | 'awaiting-peek-opponent' | 'awaiting-swap-own' | 'awaiting-swap-opponent'
  swapOwnSlotIndex: null,
  peekChoices: [],      // used only during the initial "pick 2 cards" phase
  matchSlotIndex: null, // card selected for a match attempt, awaiting confirm/cancel
};

socket.on('connect', () => { myId = socket.id; });

// -------------------------------------------------------------
// Turn-change beep (Web Audio oscillator - no asset file needed)
// -------------------------------------------------------------
let audioCtx = null;
function ensureAudioUnlocked() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (e) { audioCtx = null; }
  } else if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
}
// Browsers refuse to play audio before a user gesture - unlock on the
// first click anywhere on the page (landing screen buttons count).
document.addEventListener('click', ensureAudioUnlocked, { once: true });

function playBeep() {
  ensureAudioUnlocked();
  if (!audioCtx) return;
  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.35);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.36);
  } catch (e) { /* audio unavailable - not worth surfacing to the user */ }
}

// -------------------------------------------------------------
// Small helpers
// -------------------------------------------------------------

function show(id) { document.getElementById(id).classList.remove('hidden'); }
function hide(id) { document.getElementById(id).classList.add('hidden'); }

function switchScreen(id) {
  document.querySelectorAll('.screen').forEach(el => el.classList.add('hidden'));
  show(id);
}

let toastTimer = null;
function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

function suitClass(suit) {
  return RED_SUITS.includes(suit) ? 'suit-red' : 'suit-black';
}

// Builds a face-up card element ({rank, suit})
function cardEl(card, extraClass) {
  const div = document.createElement('div');
  div.className = `card ${suitClass(card.suit)} ${extraClass || ''}`.trim();
  div.innerHTML = `<span class="rank">${card.rank}</span><span class="suit">${card.suit}</span>`;
  return div;
}

function cardBackEl(extraClass) {
  const div = document.createElement('div');
  div.className = `card card-back ${extraClass || ''}`.trim();
  return div;
}

function cardFaceDownEl(extraClass) {
  const div = document.createElement('div');
  div.className = `card card-face-down ${extraClass || ''}`.trim();
  return div;
}

function resetUiMode() {
  ui.mode = null;
  ui.swapOwnSlotIndex = null;
  ui.matchSlotIndex = null;
}

// =============================================================
// LANDING SCREEN (create / join)
// =============================================================

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (btn.dataset.tab === 'create') { show('panel-create'); hide('panel-join'); }
    else { show('panel-join'); hide('panel-create'); }
  });
});

document.getElementById('btn-create-room').addEventListener('click', () => {
  const name = document.getElementById('create-name').value.trim() || 'Player';
  socket.emit('create-room', { name });
});

document.getElementById('btn-join-room').addEventListener('click', () => {
  const name = document.getElementById('join-name').value.trim() || 'Player';
  const roomCode = document.getElementById('join-code').value.trim().toUpperCase();
  if (!roomCode) { toast('Enter a table code first'); return; }
  socket.emit('join-room', { name, roomCode });
});

document.getElementById('btn-start-game').addEventListener('click', () => {
  socket.emit('start-game');
});

document.getElementById('btn-back-to-landing').addEventListener('click', () => {
  window.location.reload();
});

document.getElementById('btn-challenge').addEventListener('click', () => {
  if (!confirm('Call a challenge? Every other player gets exactly one more turn, then all hands are revealed.')) return;
  socket.emit('call-challenge');
});

document.getElementById('log-toggle').addEventListener('click', () => {
  const list = document.getElementById('log-list');
  list.classList.toggle('hidden');
});

document.getElementById('btn-confirm-match').addEventListener('click', () => {
  if (ui.matchSlotIndex === null) return;
  socket.emit('attempt-match', { slotIndex: ui.matchSlotIndex });
  ui.matchSlotIndex = null;
  render(latestState);
});

document.getElementById('btn-cancel-match').addEventListener('click', () => {
  ui.matchSlotIndex = null;
  render(latestState);
});

document.getElementById('draw-pile').addEventListener('click', () => {
  if (!latestState) return;
  if (latestState.turnCooldownUntil) return;
  const iAmTurn = latestState.turnPlayerId === myId;
  const busy = latestState.pendingDraw || latestState.pendingPowerIsMine;
  if (!iAmTurn || busy) return;
  socket.emit('draw-card');
});

// =============================================================
// SOCKET EVENTS FROM SERVER
// =============================================================

socket.on('error-message', (msg) => toast(msg));

socket.on('room-update', (state) => {
  latestState = state;
  render(state);
});

socket.on('power-result', (result) => {
  if (result.type === 'peek-own') {
    toast(`That card is a ${result.rank} (${result.value})`);
  } else if (result.type === 'peek-opponent') {
    toast(`Their card is a ${result.rank} (${result.value})`);
  }
  resetUiMode();
});

socket.on('match-result', (result) => {
  toast(result.correct ? 'Nice - matched! Card gone.' : 'Wrong match - foul! Picked up a penalty card.');
});

socket.on('play-beep', playBeep);

// Countdowns (turn cooldown, peek reveal) tick down between the server
// pushes that bookend them, so we refresh their on-screen text locally.
setInterval(() => {
  if (!latestState) return;
  tickTurnCooldown(latestState);
  tickPeekCountdown(latestState);
}, 250);

function tickTurnCooldown(state) {
  if (!state.turnCooldownUntil || state.phase === 'lobby' || state.phase === 'ended') return;
  const banner = document.getElementById('turn-banner');
  if (!banner) return;
  const remaining = Math.max(0, Math.ceil((state.turnCooldownUntil - Date.now()) / 1000));
  banner.textContent = `Next turn starts in ${remaining}s...`;
}

function tickPeekCountdown(state) {
  const el = document.getElementById('peek-reveal-countdown');
  if (!el) return;
  const me = state.players && state.players.find(p => p.isMe);
  if (!me || !me.peekRevealUntil) { el.textContent = ''; return; }
  const remaining = Math.max(0, Math.ceil((me.peekRevealUntil - Date.now()) / 1000));
  el.textContent = remaining > 0 ? `(hiding in ${remaining}s)` : '';
}

// =============================================================
// MAIN RENDER
// =============================================================

function render(state) {
  if (state.phase === 'lobby') {
    switchScreen('screen-lobby');
    renderLobby(state);
    return;
  }
  if (state.phase === 'ended') {
    switchScreen('screen-gameover');
    renderGameOver(state);
    return;
  }
  switchScreen('screen-game');
  renderGame(state);
}

function renderLobby(state) {
  document.getElementById('lobby-room-code').textContent = state.code;
  const list = document.getElementById('lobby-player-list');
  list.innerHTML = '';
  state.players.forEach(p => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${p.name}${p.isMe ? ' (you)' : ''}</span>` +
      (p.id === state.hostId ? '<span class="host-tag">HOST</span>' : '');
    list.appendChild(li);
  });

  const isHost = state.hostId === myId;
  const startBtn = document.getElementById('btn-start-game');
  const hint = document.getElementById('lobby-hint');
  if (isHost) {
    show('btn-start-game');
    startBtn.disabled = state.players.length < 2;
    hint.textContent = state.players.length < 2
      ? 'Need at least 2 players to start.'
      : 'When everyone is in, start the game.';
  } else {
    hide('btn-start-game');
    hint.textContent = "Waiting for the host to start...";
  }
}

function renderGameOver(state) {
  const r = state.finalResults;
  document.getElementById('gameover-winner').textContent =
    r.winners.length > 1 ? `Tie: ${r.winners.join(' & ')} (${r.lowest})` : `${r.winners[0]} wins with ${r.lowest}!`;
  const list = document.getElementById('gameover-results');
  list.innerHTML = '';
  [...r.results].sort((a, b) => a.sum - b.sum).forEach(res => {
    const li = document.createElement('li');
    li.className = r.winners.includes(res.name) ? 'winner' : '';
    const handStr = res.hand.map(c => `${c.rank}${c.suit}`).join(' ');
    li.innerHTML = `<span class="result-name">${res.name}</span>` +
      `<span>${handStr}</span>` +
      `<span class="result-sum">${res.sum} ${res.foulCount ? `(${res.foulCount} foul${res.foulCount > 1 ? 's' : ''})` : ''}</span>`;
    list.appendChild(li);
  });
}

function renderGame(state) {
  const me = state.players.find(p => p.isMe);
  document.getElementById('game-room-code').textContent = state.code;

  const roundLabel = state.phase === 'final'
    ? `Final lap! (${state.challenge ? state.challenge.remainingTurns : 0} turn(s) left)`
    : `Round ${state.round}`;
  document.getElementById('game-round').textContent = roundLabel;

  // Reset selection-mode-driven state if the server says nothing is pending for me.
  if (!state.pendingDraw && !state.pendingPowerIsMine) resetUiMode();

  renderOpponents(state, me);
  renderPiles(state);
  renderTurnBanner(state, me);
  renderPendingPanel(state);
  renderMyHand(state, me);
  renderChallengeButton(state);
  renderLog(state);
}

function renderOpponents(state, me) {
  const ring = document.getElementById('opponents-ring');
  ring.innerHTML = '';
  state.players.filter(p => !p.isMe).forEach(p => {
    const box = document.createElement('div');
    box.className = 'opponent' + (p.id === state.turnPlayerId ? ' is-turn' : '') + (!p.connected ? ' disconnected' : '');

    const nameLine = document.createElement('div');
    nameLine.className = 'opponent-name';
    nameLine.innerHTML = (p.id === state.turnPlayerId ? '<span class="turn-dot"></span>' : '') + p.name;
    box.appendChild(nameLine);

    const cardsRow = document.createElement('div');
    cardsRow.className = 'opponent-cards';
    p.hand.forEach((slot, idx) => {
      const canClickForPeek = ui.mode === 'awaiting-peek-opponent';
      const canClickForSwap = ui.mode === 'awaiting-swap-opponent';
      const el = cardFaceDownEl(canClickForPeek || canClickForSwap ? 'selectable' : '');
      if (canClickForPeek) {
        el.addEventListener('click', () => {
          socket.emit('power-peek-opponent', { opponentId: p.id, slotIndex: idx });
        });
      } else if (canClickForSwap) {
        el.addEventListener('click', () => {
          socket.emit('power-swap', {
            ownSlotIndex: ui.swapOwnSlotIndex,
            opponentId: p.id,
            opponentSlotIndex: idx,
          });
          resetUiMode();
        });
      }
      cardsRow.appendChild(el);
    });
    box.appendChild(cardsRow);

    if (p.foulCount > 0) {
      const foul = document.createElement('div');
      foul.className = 'opponent-foul';
      foul.textContent = `${p.foulCount} foul${p.foulCount > 1 ? 's' : ''}`;
      box.appendChild(foul);
    }

    ring.appendChild(box);
  });
}

function renderPiles(state) {
  document.getElementById('deck-count').textContent = state.deckCount;
  const discardEl = document.getElementById('discard-pile');
  discardEl.innerHTML = '';
  if (state.discardTop) {
    const el = cardEl(state.discardTop);
    el.title = 'Click one of your cards below to try to match this rank';
    discardEl.appendChild(el);
  } else {
    discardEl.appendChild((() => { const d = document.createElement('div'); d.className = 'card empty-slot'; return d; })());
  }
}

function renderTurnBanner(state, me) {
  const banner = document.getElementById('turn-banner');
  if (state.turnCooldownUntil) {
    const remaining = Math.max(0, Math.ceil((state.turnCooldownUntil - Date.now()) / 1000));
    banner.textContent = `Next turn starts in ${remaining}s...`;
    return;
  }
  if (state.pendingPowerIsMine) {
    const label = { 'peek-own': 'Pick one of your own cards to peek at.',
                    'peek-opponent': "Pick one of an opponent's cards to peek at.",
                    'swap-blind': 'Pick one of your cards, then one of an opponent\'s, to blind-swap.' }[state.pendingPowerType];
    banner.textContent = label;
    return;
  }
  if (state.pendingDraw) {
    banner.textContent = 'Decide what to do with your drawn card.';
    return;
  }
  if (state.turnPlayerId === me.id) {
    banner.textContent = 'Your turn - draw a card from the pile.';
  } else {
    const p = state.players.find(pl => pl.id === state.turnPlayerId);
    banner.textContent = p ? `${p.name}'s turn...` : 'Waiting...';
  }
}

function renderPendingPanel(state) {
  const panel = document.getElementById('pending-panel');
  const slot = document.getElementById('pending-card-slot');
  const actions = document.getElementById('pending-actions');
  slot.innerHTML = '';
  actions.innerHTML = '';

  if (!state.pendingDraw) { hide('pending-panel'); return; }
  show('pending-panel');

  const drawn = state.pendingDraw;
  slot.appendChild(cardEl(drawn, 'flip'));

  if (ui.mode === 'awaiting-swap-slot') {
    document.getElementById('pending-title').textContent = 'Pick a card in your hand below to swap it in';
    return;
  }

  document.getElementById('pending-title').textContent = 'You drew this card - what now?';

  const swapBtn = document.createElement('button');
  swapBtn.className = 'btn btn-ghost btn-small';
  swapBtn.textContent = 'Swap into my hand';
  swapBtn.addEventListener('click', () => { ui.mode = 'awaiting-swap-slot'; render(latestState); });
  actions.appendChild(swapBtn);

  const discardBtn = document.createElement('button');
  discardBtn.className = 'btn btn-ghost btn-small';
  discardBtn.textContent = 'Discard it';
  discardBtn.addEventListener('click', () => socket.emit('resolve-draw', { action: 'discard' }));
  actions.appendChild(discardBtn);

  const power = POWER_RANKS[drawn.rank];
  if (power) {
    const powerBtn = document.createElement('button');
    powerBtn.className = 'btn btn-primary btn-small';
    const label = { 'peek-own': 'Use power: peek own card',
                    'peek-opponent': "Use power: peek opponent's card",
                    'swap-blind': 'Use power: blind swap' }[power];
    powerBtn.textContent = label;
    powerBtn.addEventListener('click', () => {
      socket.emit('resolve-draw', { action: 'use-power' });
    });
    actions.appendChild(powerBtn);
  }
}

function renderMyHand(state, me) {
  const handEl = document.getElementById('my-hand');
  handEl.innerHTML = '';
  document.getElementById('my-foul-count').textContent = me.foulCount ? `- ${me.foulCount} foul${me.foulCount > 1 ? 's' : ''}` : '';

  if (state.phase === 'peeking' && !hasPeeked(me)) {
    ui.matchSlotIndex = null;
    renderMatchActions();
    renderPeekSelection(handEl, me);
    return;
  }

  const canAttemptMatchNow = ui.mode === null && (state.phase === 'playing' || state.phase === 'final') && !state.pendingDraw && !state.pendingPowerIsMine;
  if (!canAttemptMatchNow) ui.matchSlotIndex = null;

  me.hand.forEach((slot, idx) => {
    let el;
    if (slot.known) {
      el = cardEl({ rank: slot.rank, suit: slot.suit });
    } else {
      el = cardFaceDownEl();
    }

    const clickableForSwap = ui.mode === 'awaiting-swap-slot';
    const clickableForPeekOwn = ui.mode === 'awaiting-peek-own';
    const clickableForSwapOwn = ui.mode === 'awaiting-swap-own';
    const clickableForMatch = canAttemptMatchNow;

    if (clickableForMatch && ui.matchSlotIndex === idx) el.classList.add('selected');

    if (clickableForSwap || clickableForPeekOwn || clickableForSwapOwn || clickableForMatch) {
      el.classList.add('selectable');
      el.addEventListener('click', () => {
        if (clickableForSwap) {
          socket.emit('resolve-draw', { action: 'swap', slotIndex: idx });
          resetUiMode();
        } else if (clickableForPeekOwn) {
          socket.emit('power-peek-own', { slotIndex: idx });
        } else if (clickableForSwapOwn) {
          ui.swapOwnSlotIndex = idx;
          ui.mode = 'awaiting-swap-opponent';
          render(latestState);
        } else if (clickableForMatch) {
          // Select or deselect - the actual attempt is sent from the
          // confirm button in the action bar, not on click here.
          ui.matchSlotIndex = ui.matchSlotIndex === idx ? null : idx;
          render(latestState);
        }
      });
    }

    handEl.appendChild(el);
  });

  renderMatchActions();

  // If a swap-blind power is active and we're waiting for the own-card pick,
  // set the mode automatically the first time we see it.
  if (state.pendingPowerIsMine && state.pendingPowerType === 'swap-blind' && ui.mode === null) {
    ui.mode = 'awaiting-swap-own';
    render(latestState);
  }
  if (state.pendingPowerIsMine && state.pendingPowerType === 'peek-own' && ui.mode === null) {
    ui.mode = 'awaiting-peek-own';
    render(latestState);
  }
  if (state.pendingPowerIsMine && state.pendingPowerType === 'peek-opponent' && ui.mode === null) {
    ui.mode = 'awaiting-peek-opponent';
    render(latestState);
  }
}

function renderMatchActions() {
  const bar = document.getElementById('match-actions');
  bar.classList.toggle('hidden', ui.matchSlotIndex === null);
}

function hasPeeked(me) {
  return !!me.peeked;
}

function renderPeekSelection(handEl, me) {
  document.getElementById('turn-banner').textContent = 'Pick 2 of your 4 cards to peek at (once only).';
  me.hand.forEach((slot, idx) => {
    const el = cardFaceDownEl('selectable');
    if (ui.peekChoices.includes(idx)) el.classList.add('selected');
    el.addEventListener('click', () => {
      if (ui.peekChoices.includes(idx)) {
        ui.peekChoices = ui.peekChoices.filter(i => i !== idx);
      } else if (ui.peekChoices.length < 2) {
        ui.peekChoices.push(idx);
      }
      if (ui.peekChoices.length === 2) {
        socket.emit('peek-select', { slotIndices: ui.peekChoices });
        ui.peekChoices = [];
      } else {
        render(latestState);
      }
    });
    handEl.appendChild(el);
  });
}

function renderChallengeButton(state) {
  const btn = document.getElementById('btn-challenge');
  const eligible = state.phase === 'playing' &&
    !state.turnCooldownUntil &&
    state.turnPlayerId === myId &&
    !state.pendingDraw &&
    !state.pendingPowerIsMine &&
    state.round >= state.minRoundToChallenge;
  btn.classList.toggle('hidden', !eligible);
}

function renderLog(state) {
  const list = document.getElementById('log-list');
  list.innerHTML = '';
  state.log.slice().reverse().forEach(entry => {
    const li = document.createElement('li');
    li.textContent = entry.text;
    list.appendChild(li);
  });
}
