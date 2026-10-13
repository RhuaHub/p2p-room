/* =========================================================================
   斗地主（集成进 p2p-room）
   拓扑：复用房间 P2P mesh，房主为权威节点（洗牌发牌 + 回合裁判），
        其余两家与房主直连；隐藏手牌只在房主与各玩家之间点对点传输。
   规则：3 人一副牌，17/17/17 + 3 底牌；叫分（不叫/1/2/3）定地主；
        单/对/三/三带/顺子/连对/飞机/炸弹/火箭/四带二；地主先出。
   ========================================================================= */
(function () {
  'use strict';

  var P2P = window.P2P;
  var S = P2P.S;

  /* ---------------- 牌型工具 ---------------- */
  var SUITS = ['♠', '♥', '♣', '♦'];
  var RANK_LABEL = { 3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'10',11:'J',12:'Q',13:'K',14:'A',15:'2',16:'小王',17:'大王' };

  function buildDeck() {
    var deck = [], id = 0, r, s;
    for (r = 3; r <= 15; r++) {
      for (s = 0; s < 4; s++) {
        deck.push({ id: 'c' + (id++), r: r, s: s, label: RANK_LABEL[r], suit: SUITS[s], red: (s === 1 || s === 3) });
      }
    }
    deck.push({ id: 'c' + (id++), r: 16, s: -1, label: '小王', suit: '', red: true });
    deck.push({ id: 'c' + (id++), r: 17, s: -1, label: '大王', suit: '', red: true });
    return deck;
  }
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function sortHand(hand) {
    hand.sort(function (x, y) { return x.r - y.r || x.s - y.s; });
    return hand;
  }
  function cntMap(rs) {
    var m = {}; rs.forEach(function (r) { m[r] = (m[r] || 0) + 1; }); return m;
  }
  function isConsecutive(ks) {
    for (var i = 1; i < ks.length; i++) if (ks[i] !== ks[i - 1] + 1) return false;
    return true;
  }

  // 识别牌型；非法返回 null
  function analyze(cards) {
    if (!cards || !cards.length) return null;
    var rs = cards.map(function (c) { return c.r; }).sort(function (a, b) { return a - b; });
    var n = rs.length;
    var m = cntMap(rs);
    var ranks = Object.keys(m).map(Number).sort(function (a, b) { return a - b; });

    if (n === 2 && m[16] === 1 && m[17] === 1) return { type: 'rocket', rank: 200, len: 2 };
    if (n === 4 && ranks.length === 1) return { type: 'bomb', rank: ranks[0], len: 4 };
    if (n === 1) return { type: 'single', rank: rs[0], len: 1 };
    if (n === 2 && ranks.length === 1) return { type: 'pair', rank: ranks[0], len: 2 };
    if (n === 3 && ranks.length === 1) return { type: 'triple', rank: ranks[0], len: 3 };
    if (n === 4) {
      var t4 = ranks.filter(function (r) { return m[r] === 3; });
      if (t4.length === 1 && ranks.length === 2) return { type: 'triple1', rank: t4[0], len: 4 };
    }
    if (n === 5) {
      var t5 = ranks.filter(function (r) { return m[r] === 3; });
      var p5 = ranks.filter(function (r) { return m[r] === 2; });
      if (t5.length === 1 && p5.length === 1) return { type: 'triple2', rank: t5[0], len: 5 };
      if (ranks.length === 5 && isConsecutive(ranks) && ranks[4] <= 14) return { type: 'straight', rank: ranks[4], len: 5 };
    }
    if (n >= 5 && ranks.length === n && isConsecutive(ranks) && ranks[n - 1] <= 14) return { type: 'straight', rank: ranks[n - 1], len: n };
    if (n >= 6 && n % 2 === 0) {
      var allPairs = ranks.every(function (r) { return m[r] === 2; });
      if (allPairs && ranks.length === n / 2 && isConsecutive(ranks) && ranks[ranks.length - 1] <= 14)
        return { type: 'straightPair', rank: ranks[ranks.length - 1], len: n };
    }
    // 飞机（连续三张，可带单/对）
    var tripleRanks = ranks.filter(function (r) { return m[r] === 3; }).sort(function (a, b) { return a - b; });
    if (tripleRanks.length >= 2) {
      var best = [], cur = [tripleRanks[0]];
      for (var i = 1; i < tripleRanks.length; i++) {
        if (tripleRanks[i] === tripleRanks[i - 1] + 1) cur.push(tripleRanks[i]);
        else { if (cur.length > best.length) best = cur; cur = [tripleRanks[i]]; }
      }
      if (cur.length > best.length) best = cur;
      if (best.length >= 2 && best[best.length - 1] <= 14) {
        var k = best.length, used = k * 3, remain = n - used, top = best[best.length - 1];
        if (remain === 0) return { type: 'plane', rank: top, len: n };
        if (remain === k) return { type: 'plane1', rank: top, len: n };
        if (remain === 2 * k && ranks.filter(function (r) { return m[r] === 2; }).length === k) return { type: 'plane2', rank: top, len: n };
      }
    }
    // 四带二（四张 + 两张单 / 两对）
    if (n === 6) {
      var f6 = ranks.filter(function (r) { return m[r] === 4; });
      if (f6.length === 1) return { type: 'four2', rank: f6[0], len: 6 };
    }
    if (n === 8) {
      var f8 = ranks.filter(function (r) { return m[r] === 4; });
      if (f8.length === 1 && ranks.filter(function (r) { return m[r] === 2; }).length === 2) return { type: 'four2', rank: f8[0], len: 8 };
    }
    return null;
  }

  // a 是否能压过 b（b 为当前桌面牌；b 为空表示自由出牌）
  function beats(a, b) {
    if (!a) return false;
    if (!b) return true;
    if (a.type === 'rocket') return true;
    if (b.type === 'rocket') return false;
    var aBomb = (a.type === 'bomb' || a.type === 'four2');
    var bBomb = (b.type === 'bomb' || b.type === 'four2');
    if (aBomb && bBomb) return a.rank > b.rank;   // 炸弹类（含四带二）比点数
    if (aBomb && !bBomb) return true;             // 炸弹类压普通牌
    if (!aBomb && bBomb) return false;            // 普通牌压不过炸弹类
    if (a.type !== b.type) return false;
    if (a.len !== b.len) return false;
    return a.rank > b.rank;
  }

  // 提示：从手牌中找一手能压过 table 的牌；自由出牌时返回最小单张
  function findHint(hand, table) {
    hand = hand.slice().sort(function (a, b) { return a.r - b.r; });
    if (!table) return hand.length ? [hand[0]] : null;
    var byR = {};
    hand.forEach(function (c) { (byR[c.r] = byR[c.r] || []).push(c); });
    var asc = Object.keys(byR).map(Number).sort(function (a, b) { return a - b; });
    var hasRocket = byR[16] && byR[17];
    function bomb() { for (var i = 0; i < asc.length; i++) if (byR[asc[i]].length >= 4) return byR[asc[i]].slice(0, 4); return null; }
    function singleOver(r) { for (var i = 0; i < asc.length; i++) if (asc[i] > r) return [byR[asc[i]][0]]; return null; }
    function pairOver(r) { for (var i = 0; i < asc.length; i++) if (byR[asc[i]].length >= 2 && asc[i] > r) return byR[asc[i]].slice(0, 2); return null; }
    function tripleOver(r) { for (var i = 0; i < asc.length; i++) if (byR[asc[i]].length >= 3 && asc[i] > r) return byR[asc[i]].slice(0, 3); return null; }
    function straightOver(len, r) {
      var best = null;
      for (var start = 3; start <= 14 - len + 1; start++) {
        var ok = true, run = [];
        for (var k = 0; k < len; k++) { var rr = start + k; if (!byR[rr] || byR[rr].length < 1) { ok = false; break; } run.push(byR[rr][0]); }
        if (ok && start + len - 1 > r) { if (!best || start + len - 1 < best.top) best = { cards: run, top: start + len - 1 }; }
      }
      return best ? best.cards : null;
    }
    function straightPairOver(pairs, r) {
      var best = null;
      for (var start = 3; start <= 14 - pairs + 1; start++) {
        var ok = true, run = [];
        for (var k = 0; k < pairs; k++) { var rr = start + k; if (!byR[rr] || byR[rr].length < 2) { ok = false; break; } run.push(byR[rr][0], byR[rr][1]); }
        if (ok && start + pairs - 1 > r) { if (!best || start + pairs - 1 < best.top) best = { cards: run, top: start + pairs - 1 }; }
      }
      return best ? best.cards : null;
    }
    var cand = null;
    switch (table.type) {
      case 'single': cand = singleOver(table.rank); break;
      case 'pair': cand = pairOver(table.rank); break;
      case 'triple': cand = tripleOver(table.rank); break;
      case 'triple1':
        var t1 = tripleOver(table.rank);
        if (t1) { for (var i = 0; i < asc.length; i++) if (asc[i] !== t1[0].r) { cand = t1.concat([byR[asc[i]][0]]); break; } }
        break;
      case 'triple2':
        var t2 = tripleOver(table.rank);
        if (t2) { for (var j = 0; j < asc.length; j++) if (asc[j] !== t2[0].r && byR[asc[j]].length >= 2) { cand = t2.concat(byR[asc[j]].slice(0, 2)); break; } }
        break;
      case 'straight': cand = straightOver(table.len, table.rank); break;
      case 'straightPair': cand = straightPairOver(table.len / 2, table.rank); break;
      case 'plane': case 'plane1': case 'plane2': cand = null; break;
      case 'bomb': cand = (function () { var b = bomb(); if (b && b[0].r > table.rank) return b; if (hasRocket) return [byR[16][0], byR[17][0]]; return null; })(); break;
      case 'four2': cand = (function () { var b = bomb(); if (b) return b; if (hasRocket) return [byR[16][0], byR[17][0]]; return null; })(); break;
      case 'rocket': cand = null; break;
    }
    if (!cand && table.type !== 'bomb' && table.type !== 'rocket' && table.type !== 'four2') {
      cand = bomb();
      if (!cand && hasRocket) cand = [byR[16][0], byR[17][0]];
    }
    return cand;
  }

  /* ---------------- 游戏状态 ---------------- */
  var G = {
    phase: 'idle',   // idle | bid | play | over
    seats: [],       // [{id, nick, seat}]
    hand: [],        // 自己的手牌
    mySeat: 0,
    landlord: null,
    turn: null,
    table: null,     // {from, cards, type, rank, len}
    counts: {},
    bottom: null,
    bids: {},
    bidOrder: [],
    bidIdx: 0,
    lastPlayer: null,
    passCount: 0,
    merged: false,
    winner: null,
    landlordWin: false,
    sel: {},         // 选中的牌 id
    hands: {}        // 房主视角：id -> 该玩家的完整手牌（用于刷新后恢复并重发）
  };

  function myId() { return S.myId; }
  function isHost() { return S.isHost; }
  function hostId() { return G.seats.length ? G.seats[0].id : null; }
  function seatOf(id) { for (var i = 0; i < G.seats.length; i++) if (G.seats[i].id === id) return G.seats[i].seat; return -1; }
  function nickOf(id) { for (var i = 0; i < G.seats.length; i++) if (G.seats[i].id === id) return G.seats[i].nick; return '成员'; }
  function nextSeatId(id) { var s = seatOf(id); if (s < 0) return id; return G.seats[(s + 1) % 3].id; }

  /* ---------------- 房主：发牌 ---------------- */
  function hostDeal() {
    var ids = [S.myId].concat(Object.keys(S.conns));
    if (ids.length !== 3) { P2P.toast('需要 3 人才能开局', 'warn', 3000); return; }
    clearGame();
    var seats = ids.map(function (id, i) {
      return { id: id, nick: id === S.myId ? S.nick : (S.conns[id] ? S.conns[id].nick : '成员'), seat: i };
    });
    G.seats = seats; G.mySeat = 0;
    var deck = shuffle(buildDeck());
    var hands = {};
    for (var i = 0; i < 3; i++) hands[ids[i]] = deck.slice(i * 17, i * 17 + 17);
    G.hands = hands;
    G._pendingBottom = deck.slice(51, 54);
    ids.forEach(function (id, i) {
      if (id === S.myId) { G.hand = sortHand(hands[id].slice()); }
      else { P2P.sendTo(id, { k: 'ddz_deal', hand: hands[id], seat: i, seats: seats, bottom: null }); }
    });
    G.counts = {}; ids.forEach(function (id) { G.counts[id] = 17; });
    G.bottom = null; G.landlord = null; G.table = null; G.bids = {};
    G.lastPlayer = null; G.passCount = 0; G.merged = false; G.winner = null;
    G.phase = 'bid';
    G.bidOrder = seats.map(function (s) { return s.id; });
    G.bidIdx = 0;
    G.turn = G.bidOrder[0];
    G._dealAnim = true;   // 触发发牌 3D 入场动画
    broadcastState('发牌完成，开始叫地主');
  }

  /* ---------------- 房主：叫地主 ---------------- */
  function hostBid(peerId, value) {
    if (G.phase !== 'bid' || G.turn !== peerId) return;
    G.bids[peerId] = value;
    var resolved = (value === 3) || (++G.bidIdx >= 3);
    if (!resolved) { G.turn = G.bidOrder[G.bidIdx]; broadcastState(''); return; }
    // 结算地主
    var max = 0, landlord = null;
    G.bidOrder.forEach(function (id) {
      var v = G.bids[id] || 0;
      if (v > max) { max = v; landlord = id; }
    });
    if (max === 0) { // 全不叫，重新发牌
      broadcastState('无人叫地主，重新发牌');
      hostDeal();
      return;
    }
    G.landlord = landlord;
    G.phase = 'play';
    G.turn = landlord;
    G.table = null; G.lastPlayer = null; G.passCount = 0;
    G.counts[landlord] = 20;
    if (landlord === S.myId) {
      G.hand = sortHand(G.hand.concat(G._pendingBottom));
      G.hands[landlord] = G.hand.slice();
      G.merged = true;
    } else {
      if (G.hands[landlord]) G.hands[landlord] = G.hands[landlord].concat(G._pendingBottom);
      P2P.sendTo(landlord, { k: 'ddz_landlord', bottom: G._pendingBottom });
    }
    G.bottom = G._pendingBottom;
    broadcastState(nickOf(landlord) + ' 成为地主（' + max + '分）');
  }

  /* ---------------- 房主：出牌 / 过牌 ---------------- */
  function applyPlay(playerId, cards) {
    if (playerId === S.myId) {
      G.hand = G.hand.filter(function (c) { return !cards.some(function (x) { return x.id === c.id; }); });
      if (G.hands[playerId]) G.hands[playerId] = G.hand.slice();
    } else if (G.hands[playerId]) {
      G.hands[playerId] = G.hands[playerId].filter(function (c) { return !cards.some(function (x) { return x.id === c.id; }); });
    }
    G.counts[playerId] -= cards.length;
    G.table = {
      from: playerId,
      cards: cards.map(function (c) { return { id: c.id, r: c.r, s: c.s, label: c.label, suit: c.suit, red: c.red }; }),
      type: analyze(cards).type,
      rank: analyze(cards).rank,
      len: analyze(cards).len
    };
    G.lastPlayer = playerId;
    G.passCount = 0;
    G.turn = nextSeatId(playerId);
    if (G.counts[playerId] === 0) {
      G.phase = 'over';
      G.winner = playerId;
      G.landlordWin = (playerId === G.landlord);
    }
    broadcastState('');
  }
  function applyPass(playerId) {
    G.passCount++;
    if (G.passCount >= 2) { G.table = null; G.passCount = 0; G.turn = G.lastPlayer; }
    else { G.turn = nextSeatId(playerId); }
    broadcastState('');
  }
  function hostPlay(cards) {
    var a = analyze(cards);
    if (!a) { P2P.toast('牌型不合法', 'warn', 2000); return; }
    if (G.table && !beats(a, G.table)) { P2P.toast('管不上', 'warn', 2000); return; }
    applyPlay(S.myId, cards);
  }
  function hostPass() {
    if (!G.table) { P2P.toast('你是头家，必须出牌', 'warn', 2000); return; }
    applyPass(S.myId);
  }
  function hostReceivePlay(peerId, cards) {
    if (G.phase !== 'play' || G.turn !== peerId) return;
    var a = analyze(cards);
    if (!a) { P2P.sendTo(peerId, { k: 'ddz_err', msg: '牌型不合法' }); return; }
    if (G.table && !beats(a, G.table)) { P2P.sendTo(peerId, { k: 'ddz_err', msg: '管不上' }); return; }
    applyPlay(peerId, cards);
  }
  function hostReceivePass(peerId) {
    if (G.phase !== 'play' || G.turn !== peerId) return;
    if (!G.table) { P2P.sendTo(peerId, { k: 'ddz_err', msg: '你是头家，必须出牌' }); return; }
    applyPass(peerId);
  }

  /* ---------------- 公共状态广播 ---------------- */
  function buildState(msg) {
    return {
      k: 'ddz_state',
      phase: G.phase,
      seats: G.seats,
      landlord: G.landlord,
      turn: G.turn,
      table: G.table,
      counts: G.counts,
      bottom: G.phase === 'bid' ? null : G.bottom,
      msg: msg || ''
    };
  }
  function broadcastState(msg) {
    var st = buildState(msg);
    applyState(st);          // 房主自身也应用
    P2P.broadcast(st);       // 广播给其余两家
    if (isHost()) persistGame();  // 房主侧落盘，供刷新后恢复
  }

  /* ---------------- 房主状态持久化（刷新自愈） ---------------- */
  function ddzKey() {
    var room = (S.roomId || '').toString();
    return /^\d{6}$/.test(room) ? 'rhua_ddz_' + room : null;
  }
  function persistGame() {
    var key = ddzKey(); if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify({
        ts: Date.now(),
        phase: G.phase, seats: G.seats, landlord: G.landlord, turn: G.turn,
        table: G.table, counts: G.counts, bottom: G.bottom,
        bids: G.bids, bidOrder: G.bidOrder, bidIdx: G.bidIdx,
        lastPlayer: G.lastPlayer, passCount: G.passCount, merged: G.merged,
        winner: G.winner, landlordWin: G.landlordWin,
        pendingBottom: G._pendingBottom, hands: G.hands
      }));
    } catch (e) { /* noop */ }
  }
  function loadGame() {
    var key = ddzKey(); if (!key) return null;
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!s || !s.phase || s.phase === 'idle') return null;
      return s;
    } catch (e) { return null; }
  }
  function clearGame() {
    var key = ddzKey(); if (!key) return;
    try { localStorage.removeItem(key); } catch (e) { /* noop */ }
  }

  /* ---------------- 客户端：应用状态 ---------------- */
  function applyState(d) {
    G.phase = d.phase;
    if (d.seats) G.seats = d.seats;
    if (d.counts) G.counts = d.counts;
    G.landlord = d.landlord;
    G.turn = d.turn;
    G.table = d.table;
    if (d.bottom) G.bottom = d.bottom;
    if (d.landlord && !G.merged && d.landlord === myId() && d.bottom) {
      G.hand = sortHand(G.hand.concat(d.bottom));
      G.merged = true;
    }
    if (d.msg && d.msg.length) P2P.toast(d.msg, 'ok', 2600);
    if (G._pending && G.phase === 'play' && G.table && G.table.from === myId()) {
      G.hand = G.hand.filter(function (c) { return !G._pending.some(function (x) { return x.id === c.id; }); });
      G._pending = null;
    }
    renderAll();
  }

  /* ---------------- 消息入口 ---------------- */
  function handle(peerId, d) {
    if (isHost()) {
      if (d.k === 'ddz_bid') { hostBid(peerId, d.value); return; }
      if (d.k === 'ddz_play') { hostReceivePlay(peerId, d.cards); return; }
      if (d.k === 'ddz_pass') { hostReceivePass(peerId); return; }
    }
    switch (d.k) {
      case 'ddz_deal':
        G.seats = d.seats; G.mySeat = d.seat;
        G.hand = sortHand(d.hand.slice());
        G.phase = 'bid'; G.landlord = null; G.table = null; G.merged = false; G.sel = {};
        G.counts = {}; d.seats.forEach(function (s) { G.counts[s.id] = 17; });
        G._dealAnim = true;   // 触发发牌 3D 入场动画
        renderAll();
        break;
      case 'ddz_landlord':
        if (myId() === d.to) { /* 不应到达，地主由 state 合并 */ }
        break;
      case 'ddz_state':
        applyState(d);
        break;
      case 'ddz_resync':
        // 房主刷新恢复后，把该客户端自己的完整手牌重新下发
        if (d.hand && d.hand.length) { G.hand = sortHand(d.hand.slice()); G.sel = {}; renderAll(); }
        break;
      case 'ddz_err':
        P2P.toast(d.msg || '出牌无效', 'warn', 2200);
        break;
    }
  }

  /* ---------------- 房主钩子 ---------------- */
  function onHello(peerId) {
    if (!isHost()) return;
    var total = 1 + Object.keys(S.conns).length;
    if (G.phase === 'idle') {
      if (total >= 3) hostDeal();
      return;
    }
    // 进行中 / 已结束：来的是重连的客户端，把当前整局状态 + 其手牌重发回去
    if (G.hands[peerId]) {
      P2P.sendTo(peerId, buildState(nickOf(peerId) + ' 已重新连上，状态已同步'));
      P2P.sendTo(peerId, { k: 'ddz_resync', hand: G.hands[peerId] });
    } else if (total > 3) {
      P2P.sendTo(peerId, { k: 'ddz_err', msg: '房间已满（斗地主 3 人）' });
    }
  }
  function onPeerLeft(peerId) {
    if (isHost() && G.phase !== 'idle' && G.phase !== 'over') {
      broadcastState(nickOf(peerId) + ' 离开了，本局结束');
      G.phase = 'over';
    }
  }
  /* ---------------- 进入房间 ---------------- */
  function onEnter() {
    var app = document.getElementById('app');
    app.classList.add('ddz-mode');
    // 默认收起聊天浮窗，保证牌桌完整可见；点「💬 聊天」再让聊天浮现
    var ddz = document.getElementById('ddz');
    if (ddz) ddz.style.display = 'flex';
    if (isHost()) {
      // 房主刷新后：若本地有未结束的整局快照，直接恢复并等待客户端重连同步
      var snap = loadGame();
      if (snap) {
        G.phase = snap.phase; G.seats = snap.seats || []; G.landlord = snap.landlord;
        G.turn = snap.turn; G.table = snap.table; G.counts = snap.counts || {};
        G.bottom = snap.bottom; G.bids = snap.bids || {}; G.bidOrder = snap.bidOrder || [];
        G.bidIdx = snap.bidIdx || 0; G.lastPlayer = snap.lastPlayer; G.passCount = snap.passCount || 0;
        G.merged = !!snap.merged; G.winner = snap.winner; G.landlordWin = !!snap.landlordWin;
        G._pendingBottom = snap.pendingBottom; G.hands = snap.hands || {};
        G.hand = (G.hands[S.myId] ? sortHand(G.hands[S.myId].slice()) : []);
        G.sel = {}; G._pending = null;
        renderAll();
        return;
      }
    }
    G.phase = 'idle'; G.hand = []; G.merged = false; G.sel = {}; G._pending = null; G.hands = {};
    renderAll();
  }

  /* ---------------- 玩家操作 ---------------- */
  function doPlay() {
    var cards = G.hand.filter(function (c) { return G.sel[c.id]; });
    if (!cards.length) { P2P.toast('请选择要出的牌', 'warn', 1800); return; }
    var a = analyze(cards);
    if (!a) { P2P.toast('牌型不合法', 'warn', 1800); return; }
    if (G.table && !beats(a, G.table)) { P2P.toast('管不上', 'warn', 1800); return; }
    G.sel = {};
    if (isHost()) hostPlay(cards);
    else {
      G._pending = cards;
      P2P.sendTo(hostId(), { k: 'ddz_play', cards: cards });
    }
  }
  function doPass() {
    if (!G.table) { P2P.toast('你是头家，必须出牌', 'warn', 1800); return; }
    if (isHost()) hostPass();
    else { P2P.sendTo(hostId(), { k: 'ddz_pass' }); }
  }
  function doBid(v) {
    if (isHost()) hostBid(S.myId, v);
    else P2P.sendTo(hostId(), { k: 'ddz_bid', value: v });
  }
  function doHint() {
    var cand = findHint(G.hand, G.table);
    if (!cand) { P2P.toast(G.table ? '没有能管的牌' : '没有提示', 'warn', 1800); return; }
    G.sel = {};
    cand.forEach(function (c) { G.sel[c.id] = true; });
    renderHand();
  }
  function doRestart() {
    if (!isHost()) return;
    G._pendingBottom = null;
    hostDeal();
  }
  function contains(arr, c) { return arr.some(function (x) { return x.id === c.id; }); }

  /* ---------------- 渲染 ---------------- */
  function cardHTML(c, mini) {
    var cls = 'card' + (mini ? ' mini' : '') + (c.red ? ' red' : '') + (c.r >= 16 ? ' joker' : '');
    if (c.r >= 16) return '<div class="' + cls + '"><span class="jtxt">' + c.label + '</span></div>';
    return '<div class="' + cls + '"><span class="rk">' + c.label + '</span><span class="st">' + c.suit + '</span></div>';
  }
  function miniCards(cards) {
    if (!cards || !cards.length) return '';
    return cards.map(function (c) { return cardHTML(c, true); }).join('');
  }

  function renderAll() { renderSeats(); renderMid(); renderMe(); }

  function renderSeats() {
    var opps = G.seats.filter(function (s) { return s.id !== myId(); });
    [['seat1', 0], ['seat2', 1]].forEach(function (pair) {
      var el = document.getElementById(pair[0]);
      if (!el) return;
      var s = opps[pair[1]];
      if (!s) { el.querySelector('.ds-name').textContent = '—'; el.querySelector('.ds-cnt').textContent = ''; el.classList.remove('ds-landlord', 'ds-active'); el.querySelector('.ds-last').innerHTML = ''; return; }
      el.querySelector('.ds-name').textContent = s.nick;
      el.querySelector('.ds-cnt').textContent = (G.counts[s.id] != null ? G.counts[s.id] : '—') + ' 张';
      el.classList.toggle('ds-landlord', G.landlord === s.id);
      el.classList.toggle('ds-active', G.turn === s.id && (G.phase === 'bid' || G.phase === 'play'));
      var last = (G.table && G.table.from === s.id) ? miniCards(G.table.cards) : '';
      el.querySelector('.ds-last').innerHTML = last;
    });
  }

  function renderMid() {
    var bottomEl = document.getElementById('ddzBottom');
    var tableEl = document.getElementById('ddzTable');
    var turnEl = document.getElementById('ddzTurn');
    if (bottomEl) bottomEl.innerHTML = (G.bottom && G.phase !== 'bid') ? miniCards(G.bottom) : '<span class="empty">？</span>';
    if (tableEl) {
      if (G.phase === 'idle') tableEl.innerHTML = '<span class="empty">等待玩家加入（' + (1 + Object.keys(S.conns).length) + '/3）</span>';
      else if (G.phase === 'over') tableEl.innerHTML = '<span class="empty">' + (G.winner ? (nickOf(G.winner) + (G.landlordWin ? '（地主）' : '（农民）') + ' 获胜') : '本局结束') + '</span>';
      else if (G.table) tableEl.innerHTML = '<div style="margin-right:8px">' + nickOf(G.table.from) + ' 出</div>' + miniCards(G.table.cards);
      else tableEl.innerHTML = '<span class="empty">' + (G.turn === myId() ? '轮到你出牌' : '新一轮，等待 ' + nickOf(G.turn) + ' 出牌') + '</span>';
    }
    if (turnEl) {
      if (G.phase === 'bid') turnEl.textContent = (G.turn === myId() ? '轮到你叫地主' : '等待 ' + nickOf(G.turn) + ' 叫地主');
      else if (G.phase === 'play') turnEl.textContent = (G.turn === myId() ? '轮到你出牌' : '等待 ' + nickOf(G.turn) + ' 出牌');
      else turnEl.textContent = '';
    }
  }

  function renderMe() {
    var nameEl = document.getElementById('ddzMeName');
    var roleEl = document.getElementById('ddzMeRole');
    var cntEl = document.getElementById('ddzMeCnt');
    if (nameEl) nameEl.textContent = S.nick + (isHost() ? '（房主）' : '');
    if (roleEl) roleEl.textContent = G.landlord === myId() ? '地主' : (G.landlord ? '农民' : '');
    if (cntEl) cntEl.textContent = G.hand.length + ' 张';
    renderHand();
    renderActs();
  }

  function renderHand() {
    var el = document.getElementById('ddzHand');
    if (!el) return;
    if (G.phase === 'idle') { el.innerHTML = ''; el.classList.remove('dealing'); return; }
    el.innerHTML = G.hand.map(function (c) {
      var cls = 'card' + (c.red ? ' red' : '') + (c.r >= 16 ? ' joker' : '') + (G.sel[c.id] ? ' sel' : '');
      if (c.r >= 16) return '<div class="' + cls + '" data-id="' + c.id + '"><span class="jtxt">' + c.label + '</span></div>';
      return '<div class="' + cls + '" data-id="' + c.id + '"><span class="rk">' + c.label + '</span><span class="st">' + c.suit + '</span></div>';
    }).join('');
    if (G._dealAnim) {
      G._dealAnim = false;
      el.classList.add('dealing');
      setTimeout(function () { el.classList.remove('dealing'); }, 460);
    }
  }

  function renderActs() {
    var el = document.getElementById('ddzActs');
    if (!el) return;
    if (G.phase === 'bid') {
      if (G.turn === myId()) {
        el.innerHTML = '<button class="ddz-btn ghost" data-act="bid" data-v="0">不叫</button>' +
          '<button class="ddz-btn" data-act="bid" data-v="1">1 分</button>' +
          '<button class="ddz-btn" data-act="bid" data-v="2">2 分</button>' +
          '<button class="ddz-btn" data-act="bid" data-v="3">3 分</button>';
      } else el.innerHTML = '<span class="ddz-hint">等待 ' + nickOf(G.turn) + ' 叫地主…</span>';
      return;
    }
    if (G.phase === 'play') {
      if (G.turn === myId()) {
        el.innerHTML = '<button class="ddz-btn ghost" data-act="hint">提示</button>' +
          '<button class="ddz-btn ghost" data-act="pass"' + (G.table ? '' : ' disabled') + '>不出</button>' +
          '<button class="ddz-btn" data-act="play">出牌</button>';
      } else el.innerHTML = '<span class="ddz-hint">等待 ' + nickOf(G.turn) + ' 出牌…</span>';
      return;
    }
    if (G.phase === 'over') {
      if (isHost()) el.innerHTML = '<button class="ddz-btn" data-act="restart">再来一局</button>';
      else el.innerHTML = '<span class="ddz-hint">本局结束，等待房主开始下一局</span>';
      return;
    }
    el.innerHTML = '';
  }

  /* ---------------- 事件绑定 ---------------- */
  function bindUI() {
    document.getElementById('ddzHand').addEventListener('click', function (e) {
      var t = e.target.closest('.card');
      if (!t || !t.dataset.id) return;
      var id = t.dataset.id;
      if (G.sel[id]) delete G.sel[id]; else G.sel[id] = true;
      t.classList.toggle('sel');
    });
    document.getElementById('ddzActs').addEventListener('click', function (e) {
      var b = e.target.closest('.ddz-btn'); if (!b) return;
      var act = b.dataset.act;
      if (act === 'play') doPlay();
      else if (act === 'pass') doPass();
      else if (act === 'hint') doHint();
      else if (act === 'bid') doBid(parseInt(b.dataset.v, 10));
      else if (act === 'restart') doRestart();
    });
    // 聊天浮窗：牌桌上的「💬 聊天」按钮切换浮现 / 收起
    var tog = document.getElementById('ddzChatToggle');
    if (tog) tog.onclick = function () {
      var app = document.getElementById('app');
      if (app.classList.contains('chat-open')) app.classList.remove('chat-open');
      else app.classList.add('chat-open');
    };
    var cfClose = document.getElementById('cfClose');
    if (cfClose) cfClose.onclick = function () {
      document.getElementById('app').classList.remove('chat-open');
    };
  }

  // 暴露给 app.js 的钩子
  window.DDZ = { handle: handle, onHello: onHello, onPeerLeft: onPeerLeft, onEnter: onEnter, bindUI: bindUI };

  // 启动：渲染 + 绑定
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindUI);
  else bindUI();

})();
