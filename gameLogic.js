// =============================================================
//  gameLogic.js
//  ---------------------------------------------------------------
//  All the RULES of the game live in this file. It knows nothing
//  about sockets/HTTP - it's a plain JavaScript "Room" class that
//  server.js talks to. If you want to change a rule (card values,
//  power effects, foul penalty, when challenges are allowed...)
//  this is the only file you need to touch.
// =============================================================

// ---- Card values -------------------------------------------------
// A = 1, 2-10 = face value, J = 11, Q = 12, K = -1 (best card in the game)
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♠', '♥', '♦', '♣'];

function rankValue(rank) {
  if (rank === 'A') return 1;
  if (rank === 'J') return 11;
  if (rank === 'Q') return 12;
  if (rank === 'K') return -1;
  return parseInt(rank, 10); // '2'..'10'
}

// Which drawn ranks grant a special power, and what that power is.
// Edit this map to add/remove/rebalance power cards.
const POWERS = {
  '10': 'peek-own',      // look at one of your own cards
  'J': 'peek-opponent',  // look at one of another player's cards
  'Q': 'swap-blind',     // blind-swap one of your cards with an opponent's
};

// Rounds are "complete laps of the table". Challenges (the call that
// ends the game) can only be made once this many full rounds have
// finished - i.e. round 3 onward, per the house rules given.
const MIN_ROUND_TO_CHALLENGE = 3;

function freshDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ id: `${rank}${suit}`, rank, suit, value: rankValue(rank) });
    }
  }
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

let uidCounter = 1;
function nextUid() {
  return `c${uidCounter++}`;
}

class Room {
  constructor(code) {
    this.code = code;
    this.players = [];       // { id, name, connected, hand: [slot], foulCount }
    this.phase = 'lobby';    // lobby -> peeking -> playing -> final -> ended
    this.deck = [];
    this.discardPile = [];
    this.turnIndex = 0;
    this.turnsCompleted = 0;
    this.pendingDraw = null;   // { playerId, card }
    this.pendingPower = null;  // { type, playerId }
    this.challenge = null;     // { challengerId, remainingTurns }
    this.log = [];             // human readable event feed for the UI
    this.hostId = null;
  }

  // ---- helpers -----------------------------------------------------

  addLog(text) {
    this.log.push({ text, at: Date.now() });
    if (this.log.length > 200) this.log.shift();
  }

  getPlayer(id) {
    return this.players.find(p => p.id === id);
  }

  activePlayers() {
    return this.players.filter(p => p.connected);
  }

  currentPlayer() {
    return this.players[this.turnIndex];
  }

  currentRound() {
    const n = this.players.length || 1;
    return Math.floor(this.turnsCompleted / n) + 1;
  }

  handSum(player) {
    return player.hand.reduce((sum, slot) => sum + slot.card.value, 0);
  }

  // ---- lobby ---------------------------------------------------------

  addPlayer(id, name) {
    if (this.phase !== 'lobby') throw new Error('Game already started');
    if (this.players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
      throw new Error('That name is already taken in this room');
    }
    if (this.players.length >= 8) throw new Error('Room is full (8 players max)');
    if (!this.hostId) this.hostId = id;
    this.players.push({ id, name, connected: true, hand: [], foulCount: 0 });
  }

  removePlayer(id) {
    const p = this.getPlayer(id);
    if (!p) return;
    if (this.phase === 'lobby') {
      this.players = this.players.filter(pl => pl.id !== id);
      if (this.hostId === id) this.hostId = this.players[0]?.id || null;
    } else {
      p.connected = false; // keep their hand/seat, they can vanish mid-game
    }
  }

  startGame() {
    if (this.phase !== 'lobby') throw new Error('Game already started');
    if (this.players.length < 2) throw new Error('Need at least 2 players');

    this.deck = shuffle(freshDeck());
    this.discardPile = [];
    this.turnIndex = 0;
    this.turnsCompleted = 0;
    this.challenge = null;
    this.pendingDraw = null;
    this.pendingPower = null;

    for (const player of this.players) {
      player.foulCount = 0;
      player.hand = [];
      for (let i = 0; i < 4; i++) {
        player.hand.push({ uid: nextUid(), card: this.deck.pop(), knownBy: [] });
      }
      player.peeked = false;
    }

    // Flip one card to start the discard pile.
    this.discardPile.push(this.deck.pop());

    this.phase = 'peeking';
    this.addLog('Game started. Everyone: peek at 2 of your 4 cards.');
  }

  // ---- initial peek phase --------------------------------------------

  peekInitial(playerId, slotIndices) {
    if (this.phase !== 'peeking') throw new Error('Not in the peeking phase');
    const player = this.getPlayer(playerId);
    if (!player) throw new Error('Unknown player');
    if (player.peeked) throw new Error('You already peeked');
    if (!Array.isArray(slotIndices) || slotIndices.length !== 2) {
      throw new Error('Pick exactly 2 cards to peek at');
    }
    const unique = new Set(slotIndices);
    if (unique.size !== 2 || [...unique].some(i => i < 0 || i > 3)) {
      throw new Error('Invalid card selection');
    }
    for (const i of slotIndices) {
      player.hand[i].knownBy.push(playerId);
    }
    player.peeked = true;
    this.addLog(`${player.name} peeked at their cards.`);

    if (this.players.every(p => p.peeked)) {
      this.phase = 'playing';
      this.addLog(`All set. ${this.currentPlayer().name} goes first.`);
    }
  }

  // ---- turn actions ----------------------------------------------------

  drawCard(playerId) {
    if (this.phase !== 'playing' && this.phase !== 'final') {
      throw new Error('Not currently playing');
    }
    if (this.currentPlayer().id !== playerId) throw new Error('Not your turn');
    if (this.pendingDraw) throw new Error('You already drew a card this turn');

    if (this.deck.length === 0) this.reshuffleDiscardIntoDeck();
    if (this.deck.length === 0) throw new Error('No cards left to draw');

    const card = this.deck.pop();
    this.pendingDraw = { playerId, card };
    return card;
  }

  reshuffleDiscardIntoDeck() {
    if (this.discardPile.length <= 1) return; // nothing to reshuffle
    const top = this.discardPile.pop();
    this.deck = shuffle(this.discardPile);
    this.discardPile = [top];
    this.addLog('Draw pile was empty - reshuffled the discard pile.');
  }

  // Player decides what to do with the card they just drew.
  // action: 'swap' (put it in hand, discard the old card)
  //       | 'discard' (just discard it, no power - or forfeiting a power)
  //       | 'use-power' (only legal if the drawn card grants one)
  resolveDraw(playerId, action, slotIndex) {
    if (!this.pendingDraw || this.pendingDraw.playerId !== playerId) {
      throw new Error('You have no pending drawn card');
    }
    const player = this.getPlayer(playerId);
    const drawn = this.pendingDraw.card;

    if (action === 'swap') {
      if (typeof slotIndex !== 'number' || !player.hand[slotIndex]) {
        throw new Error('Pick a valid card slot to replace');
      }
      const oldSlot = player.hand[slotIndex];
      this.discardPile.push(oldSlot.card);
      player.hand[slotIndex] = { uid: nextUid(), card: drawn, knownBy: [playerId] };
      this.addLog(`${player.name} swapped in the drawn card.`);
      this.pendingDraw = null;
      this.endTurn();
      return;
    }

    if (action === 'discard') {
      this.discardPile.push(drawn);
      this.addLog(`${player.name} discarded the drawn card.`);
      this.pendingDraw = null;
      this.endTurn();
      return;
    }

    if (action === 'use-power') {
      const power = POWERS[drawn.rank];
      if (!power) throw new Error('That card has no power');
      this.pendingPower = { type: power, playerId };
      // The drawn card itself gets discarded once the power is resolved.
      return;
    }

    throw new Error('Unknown action');
  }

  // -- power: peek at your own card --
  powerPeekOwn(playerId, slotIndex) {
    this.assertPower(playerId, 'peek-own');
    const player = this.getPlayer(playerId);
    const slot = player.hand[slotIndex];
    if (!slot) throw new Error('Invalid card slot');
    if (!slot.knownBy.includes(playerId)) slot.knownBy.push(playerId);
    this.addLog(`${player.name} peeked at one of their own cards.`);
    const result = { rank: slot.card.rank, value: slot.card.value };
    this.finishPower(playerId);
    return result;
  }

  // -- power: peek at an opponent's card --
  powerPeekOpponent(playerId, opponentId, slotIndex) {
    this.assertPower(playerId, 'peek-opponent');
    const player = this.getPlayer(playerId);
    const opponent = this.getPlayer(opponentId);
    if (!opponent || opponent.id === playerId) throw new Error('Pick a different player');
    const slot = opponent.hand[slotIndex];
    if (!slot) throw new Error('Invalid card slot');
    if (!slot.knownBy.includes(playerId)) slot.knownBy.push(playerId);
    this.addLog(`${player.name} peeked at one of ${opponent.name}'s cards.`);
    const result = { rank: slot.card.rank, value: slot.card.value };
    this.finishPower(playerId);
    return result;
  }

  // -- power: blind-swap one of your cards with an opponent's --
  powerSwapBlind(playerId, ownSlotIndex, opponentId, opponentSlotIndex) {
    this.assertPower(playerId, 'swap-blind');
    const player = this.getPlayer(playerId);
    const opponent = this.getPlayer(opponentId);
    if (!opponent || opponent.id === playerId) throw new Error('Pick a different player');
    const mySlot = player.hand[ownSlotIndex];
    const theirSlot = opponent.hand[opponentSlotIndex];
    if (!mySlot || !theirSlot) throw new Error('Invalid card slot');

    // Blind swap: neither player learns what the new card is.
    const myCard = mySlot.card;
    const theirCard = theirSlot.card;
    player.hand[ownSlotIndex] = { uid: nextUid(), card: theirCard, knownBy: [] };
    opponent.hand[opponentSlotIndex] = { uid: nextUid(), card: myCard, knownBy: [] };

    this.addLog(`${player.name} swapped a card with ${opponent.name}, blind.`);
    this.finishPower(playerId);
  }

  assertPower(playerId, expectedType) {
    if (this.phase !== 'playing' && this.phase !== 'final') throw new Error('Not currently playing');
    if (!this.pendingPower || this.pendingPower.playerId !== playerId) {
      throw new Error('No power pending for you');
    }
    if (this.pendingPower.type !== expectedType) throw new Error('Wrong power type');
  }

  finishPower(playerId) {
    const drawn = this.pendingDraw.card;
    this.discardPile.push(drawn);
    this.pendingPower = null;
    this.pendingDraw = null;
    this.endTurn();
  }

  // ---- matching (can happen any time, by anyone) ------------------------
  //
  // Whenever a card sits on top of the discard pile, any player - on
  // anyone's turn - may try to throw a same-rank card from their own
  // hand onto it. Guess right: their hand shrinks by one (good for
  // them). Guess wrong: a foul - they get a random face-down card
  // added to their hand (bad for them).

  attemptMatch(playerId, slotIndex) {
    if (this.phase !== 'playing' && this.phase !== 'final') throw new Error('Not currently playing');
    const player = this.getPlayer(playerId);
    if (!player) throw new Error('Unknown player');
    const slot = player.hand[slotIndex];
    if (!slot) throw new Error('Invalid card slot');
    if (this.discardPile.length === 0) throw new Error('Nothing to match');

    const top = this.discardPile[this.discardPile.length - 1];

    if (slot.card.rank === top.rank) {
      player.hand.splice(slotIndex, 1);
      this.discardPile.push(slot.card);
      this.addLog(`${player.name} matched a ${slot.card.rank} - hand size down to ${player.hand.length}.`);
      return { correct: true };
    }

    // Wrong guess -> foul: add one random face-down card, unknown to everyone.
    player.foulCount += 1;
    if (this.deck.length === 0) this.reshuffleDiscardIntoDeck();
    if (this.deck.length > 0) {
      player.hand.push({ uid: nextUid(), card: this.deck.pop(), knownBy: [] });
    }
    this.addLog(`${player.name} fouled trying to match - picked up a penalty card.`);
    return { correct: false };
  }

  // ---- turn / round / challenge flow -------------------------------------

  endTurn() {
    this.turnsCompleted += 1;

    if (this.challenge) {
      this.challenge.remainingTurns -= 1;
      if (this.challenge.remainingTurns <= 0) {
        this.endGame();
        return;
      }
    }

    this.advanceToNextConnectedPlayer();
  }

  advanceToNextConnectedPlayer() {
    const n = this.players.length;
    for (let step = 1; step <= n; step++) {
      const idx = (this.turnIndex + step) % n;
      if (this.players[idx].connected) {
        this.turnIndex = idx;
        return;
      }
    }
    // Nobody connected - nothing to do, game will idle until someone returns.
  }

  callChallenge(playerId) {
    if (this.phase !== 'playing') throw new Error('Not currently playing');
    if (this.currentPlayer().id !== playerId) throw new Error('Not your turn');
    if (this.pendingDraw) throw new Error('Resolve your draw first');
    if (this.currentRound() < MIN_ROUND_TO_CHALLENGE) {
      throw new Error(`Can't challenge before round ${MIN_ROUND_TO_CHALLENGE}`);
    }

    const player = this.getPlayer(playerId);
    this.phase = 'final';
    this.challenge = {
      challengerId: playerId,
      remainingTurns: this.activePlayers().length - 1,
    };
    this.addLog(`${player.name} called a challenge! One more turn each, then reveal.`);

    if (this.challenge.remainingTurns <= 0) {
      // Only one player left connected - end immediately.
      this.endGame();
      return;
    }
    this.advanceToNextConnectedPlayer();
  }

  endGame() {
    this.phase = 'ended';
    const results = this.players.map(p => ({
      id: p.id,
      name: p.name,
      hand: p.hand.map(s => s.card),
      sum: this.handSum(p),
      foulCount: p.foulCount,
    }));
    const lowest = Math.min(...results.map(r => r.sum));
    const winners = results.filter(r => r.sum === lowest).map(r => r.name);
    this.addLog(`Game over! Lowest sum: ${lowest} - winner(s): ${winners.join(', ')}`);
    this.finalResults = { results, winners, lowest };
  }

  // ---- state serialization (redacted per-viewer) --------------------------

  // Builds the view of the room a specific player is allowed to see:
  // their own known cards show real values, everything else is hidden.
  viewFor(viewerId) {
    return {
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      turnPlayerId: this.players[this.turnIndex]?.id || null,
      round: this.currentRound(),
      minRoundToChallenge: MIN_ROUND_TO_CHALLENGE,
      deckCount: this.deck.length,
      discardTop: this.discardPile[this.discardPile.length - 1] || null,
      pendingDraw: this.pendingDraw && this.pendingDraw.playerId === viewerId ? this.pendingDraw.card : null,
      pendingPowerType: this.pendingPower ? this.pendingPower.type : null,
      pendingPowerIsMine: this.pendingPower ? this.pendingPower.playerId === viewerId : false,
      challenge: this.challenge,
      log: this.log.slice(-30),
      finalResults: this.phase === 'ended' ? this.finalResults : null,
      players: this.players.map(p => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        cardCount: p.hand.length,
        foulCount: p.foulCount,
        isMe: p.id === viewerId,
        hand: p.hand.map(slot => ({
          uid: slot.uid,
          known: slot.knownBy.includes(viewerId),
          rank: slot.knownBy.includes(viewerId) ? slot.card.rank : null,
          suit: slot.knownBy.includes(viewerId) ? slot.card.suit : null,
          value: slot.knownBy.includes(viewerId) ? slot.card.value : null,
        })),
      })),
    };
  }
}

module.exports = { Room, POWERS, MIN_ROUND_TO_CHALLENGE, rankValue };
