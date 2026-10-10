/* =========================================================================
   P2P 实时共享聊天室
   信令：PeerJS 公共服务器（仅握手）  业务数据：RTCDataChannel 点对点直传
   拓扑：全网状 mesh（房主为发现协调者，房主 Peer ID = 房间号）
   ========================================================================= */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var pad = function (n) { return String(n).length < 2 ? '0' + n : '' + n; };
  var fmtTime = function (t) { var d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  var uid = function (p) {
    return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  };

  /* ---------------- 状态 ---------------- */
  var S = {
    peer: null,
    myId: null,
    nick: '',
    isHost: false,
    roomId: null,
    entered: false,
    conns: {},          // peerId -> { conn, nick, host, voice:{active,muted}, speaking }
    roster: {},         // 进房时已存在的成员（抑制"加入"提示）
    voiceStream: null,
    voiceMuted: false,
    shareStream: null,
    voiceCalls: {},
    shareCalls: {},
    audios: {},
    detectors: {},
    stage: { owner: null, mode: null, url: '' },
    shareUrl: null,
    selfSpeaking: false,
    syncLock: 0,
    transfers: {},      // fileId -> 传输状态
    idRetry: 0
  };

  var IMG = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'];
  var AUD = ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'weba'];
  var MOV = ['mp4', 'webm', 'ogv', 'm4v', 'mov', 'm3u8'];
  var CHUNK = 16 * 1024;
  var BIG_FILE = 50 * 1024 * 1024;

  /* ---------------- UI 工具 ---------------- */
  function toast(msg, kind, ms) {
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || 'info');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(function () {
      el.classList.add('out');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 400);
    }, ms || 3200);
  }

  function setStatus(kind, text) {
    var el = $('#status');
    el.className = 'status ' + kind;
    el.querySelector('.txt').textContent = text;
  }

  function gateErr(msg) {
    var el = $('#gateErr');
    el.textContent = msg;
    el.classList.add('show');
    $('#goBtn').classList.remove('busy');
    $('#goBtn').disabled = false;
  }

  function colorOf(str) {
    var h = 0;
    str = String(str || 'x');
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return 'linear-gradient(135deg,hsl(' + h + ' 62% 56%),hsl(' + ((h + 32) % 360) + ' 62% 48%))';
  }

  function fmtSize(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }

  function fileIcon(ext) {
    if (IMG.indexOf(ext) >= 0) return ['\uD83D\uDDBC️', '图片'];
    if (AUD.indexOf(ext) >= 0) return ['\uD83C\uDFB5', '音频'];
    if (MOV.indexOf(ext) >= 0) return ['\uD83C\uDFAC', '视频'];
    if (ext === 'doc' || ext === 'docx') return ['\uD83D\uDCDD', 'Word'];
    if (ext === 'xls' || ext === 'xlsx') return ['\uD83D\uDCCA', 'Excel'];
    if (ext === 'ppt' || ext === 'pptx') return ['\uD83D\uDCFD️', 'PPT'];
    if (ext === 'xmind') return ['\uD83E\uDDE0', 'XMind'];
    if (ext === 'pdf') return ['\uD83D\uDCD5', 'PDF'];
    return ['\uD83D\uDCCE', '文件'];
  }

  function scrollBottom(force) {
    var box = $('#msgs');
    var near = box.scrollHeight - box.scrollTop - box.clientHeight < 220;
    if (force || near) requestAnimationFrame(function () { box.scrollTop = box.scrollHeight; });
  }

  function sysMsg(text) {
    var el = document.createElement('div');
    el.className = 'sys';
    el.innerHTML = '<span>' + esc(text) + '</span>';
    $('#msgs').appendChild(el);
    scrollBottom();
  }

  /* ---------------- 依赖加载（多 CDN 兜底） ---------------- */
  var CDN = {
    peer: [
      'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js',
      'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.4/peerjs.min.js'
    ],
    hls: ['https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js',
          'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.13/hls.min.js'],
    mammoth: ['https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js'],
    xlsx: ['https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
           'https://cdn.sheetjs.com/xlsx-0.18.5/dist/xlsx.full.min.js'],
    jszip: ['https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
            'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js']
  };
  var libCache = {};
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = res;
      s.onerror = function () { rej(new Error(src)); };
      document.head.appendChild(s);
    });
  }
  function ensureLib(key, globalName) {
    if (libCache[key]) return libCache[key];
    libCache[key] = new Promise(function (res, rej) {
      var urls = CDN[key] || [];
      var i = 0;
      (function next() {
        if (i >= urls.length) return rej(new Error('依赖加载失败：' + key));
        loadScript(urls[i++]).then(function () {
          if (!globalName || typeof window[globalName] !== 'undefined') res(window[globalName]);
          else next();
        }).catch(next);
      })();
    });
    return libCache[key];
  }
  function ensurePeer() {
    if (typeof Peer !== 'undefined') return Promise.resolve(true);
    return ensureLib('peer', 'Peer').then(function () { return true; },
      function () { return false; });
  }

  /* ---------------- 入口面板 ---------------- */
  var gateMode = 'create';
  $$('.seg button').forEach(function (b) {
    b.onclick = function () {
      $$('.seg button').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      gateMode = b.dataset.mode;
      $('#joinField').style.display = gateMode === 'join' ? '' : 'none';
      $('#goBtn .tx').textContent = gateMode === 'join' ? '加入房间' : '创建房间并进入';
      $('#gateErr').classList.remove('show');
    };
  });
  $('#nick').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#goBtn').click(); });
  $('#roomIn').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#goBtn').click(); });

  $('#goBtn').onclick = function () {
    var nick = $('#nick').value.trim();
    if (!nick) { gateErr('请先输入昵称'); $('#nick').focus(); return; }
    var room = $('#roomIn').value.trim();
    if (gateMode === 'join' && !room) { gateErr('请输入要加入的房间号'); $('#roomIn').focus(); return; }
    S.nick = nick;
    $('#gateErr').classList.remove('show');
    $('#goBtn').classList.add('busy');
    $('#goBtn').disabled = true;
    ensurePeer().then(function (ok) {
      if (!ok) { gateErr('WebRTC 依赖加载失败，请检查网络或稍后重试'); return; }
      if (gateMode === 'create') startHost(); else startGuest(room);
    });
  };

  /* ---------------- Peer 初始化 ---------------- */
  var ICE = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' }
    ],
    sdpSemantics: 'unified-plan'
  };
  var newPeer = function (id) { return new Peer(id, { debug: 1, config: ICE }); };
  var genRoom = function () {
    return 'rm' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
  };

  function startHost() {
    S.isHost = true;
    S.roomId = genRoom();
    S.peer = newPeer(S.roomId);
    bindPeer();
  }
  function startGuest(room) {
    S.isHost = false;
    S.roomId = room;
    S.peer = newPeer(undefined);
    bindPeer();
  }

  function bindPeer() {
    var p = S.peer;
    p.on('open', function (id) {
      S.myId = id;
      if (S.isHost) { S.roomId = id; enterRoom(); }
      else { S.roster[S.roomId] = 1; connectTo(S.roomId); }
    });
    p.on('connection', function (conn) { setupConn(conn); });
    p.on('call', handleCall);
    p.on('error', onPeerError);
    p.on('disconnected', function () {
      setStatus('warn', '重连中');
      try { p.reconnect(); } catch (e) { /* noop */ }
    });
    p.on('close', function () { setStatus('err', '已断开'); });
  }

  function onPeerError(err) {
    var t = err && err.type || '';
    if (t === 'unavailable-id' && S.isHost && S.idRetry < 4) {
      S.idRetry++;
      S.roomId = genRoom();
      try { S.peer.destroy(); } catch (e) { /* noop */ }
      S.peer = newPeer(S.roomId);
      bindPeer();
      return;
    }
    var map = {
      'peer-unavailable': '找不到该房间，请确认房间号是否正确、房主是否仍在线',
      'network': '无法连接信令服务器，请检查网络后重试',
      'server-error': '公共信令服务器暂时不可用，请稍后重试',
      'unavailable-id': '房间号被占用，请重试',
      'browser-incompatible': '当前浏览器不支持 WebRTC，请换用 Chrome / Edge / Safari',
      'ssl-unavailable': '需在 https 或 localhost 环境下运行',
      'webrtc': 'WebRTC 连接异常，请重试'
    };
    var msg = map[t] || ('连接出错：' + ((err && err.message) || t));
    if (!S.entered) gateErr(msg);
    else {
      if (t === 'peer-unavailable') return;
      toast(msg, 'err', 5000);
      setStatus('warn', '网络异常');
    }
  }

  /* ---------------- 连接管理 ---------------- */
  function connectTo(peerId) {
    if (!peerId || peerId === S.myId || S.conns[peerId]) return;
    var conn = S.peer.connect(peerId, { reliable: true, metadata: { nick: S.nick } });
    setupConn(conn);
  }

  function setupConn(conn) {
    var opened = false;
    conn.on('open', function () {
      opened = true;
      if (!S.conns[conn.peer]) {
        S.conns[conn.peer] = {
          conn: conn,
          nick: (conn.metadata && conn.metadata.nick) || '成员',
          host: false,
          voice: { active: false, muted: false },
          speaking: false
        };
      } else {
        S.conns[conn.peer].conn = conn;
      }
      send(conn, { k: 'hello', nick: S.nick, host: S.isHost });
      if (!S.entered) enterRoom();
      setStatus('ok', '已连接');
      renderUsers();
      if (S.voiceStream) callPeer(conn.peer, 'voice');
      if (S.shareStream) callPeer(conn.peer, 'share');
      if (S.stage.owner === S.myId && S.stage.mode !== 'p2p' && S.stage.url) {
        send(conn, { k: 'stage', url: S.stage.url, mode: S.stage.mode, embed: S.stage.embed, nick: S.nick });
      }
    });
    conn.on('data', function (d) { onData(conn.peer, d); });
    conn.on('close', function () { dropPeer(conn.peer); });
    conn.on('error', function () { if (!opened) dropPeer(conn.peer, true); });
  }

  function send(conn, obj) {
    try { if (conn && conn.open) conn.send(obj); } catch (e) { /* noop */ }
  }
  function broadcast(obj) {
    Object.keys(S.conns).forEach(function (id) { send(S.conns[id].conn, obj); });
  }

  function enterRoom() {
    if (S.entered) return;
    S.entered = true;
    $('#roomId').textContent = S.roomId;
    $('#gate').classList.add('hide');
    setTimeout(function () { $('#gate').style.display = 'none'; }, 460);
    $('#app').classList.add('on');
    setStatus('ok', S.isHost ? '房间已就绪' : '已连接');
    renderUsers();
    sysMsg(S.isHost ? '房间创建成功，把房间号分享给朋友即可开始' : '已加入房间');
    if (S.isHost) toast('房间已创建，点击顶部复制房间号分享', 'ok', 4200);
    setTimeout(function () { $('#input').focus(); }, 500);
  }

  function dropPeer(peerId, silent) {
    var info = S.conns[peerId];
    if (!info) return;
    delete S.conns[peerId];
    closeCall(S.voiceCalls, peerId);
    closeCall(S.shareCalls, peerId);
    removeAudio(peerId);
    stopDetector(peerId);
    if (S.stage.owner === peerId) clearStage(true);
    if (!silent) sysMsg(info.nick + ' 离开了房间');
    renderUsers();
    if (!Object.keys(S.conns).length) setStatus('warn', '房间内仅你一人');
  }
  function closeCall(map, peerId) {
    var c = map[peerId];
    if (c) { try { c.close(); } catch (e) { /* noop */ } delete map[peerId]; }
  }

  function onData(peerId, d) {
    if (!d || typeof d !== 'object') return;
    var info = S.conns[peerId];

    if (d.k === 'hello') {
      if (info) { info.nick = d.nick || '成员'; info.host = !!d.host; }
      if (S.isHost) {
        var list = Object.keys(S.conns)
          .filter(function (id) { return id !== peerId; })
          .map(function (id) { return { id: id, nick: S.conns[id].nick }; });
        send(info && info.conn, { k: 'peers', list: list });
      }
      if (S.roster[peerId]) delete S.roster[peerId];
      else sysMsg((d.nick || '成员') + ' 加入了房间');
      renderUsers();
      return;
    }
    if (d.k === 'peers') {
      (d.list || []).forEach(function (p) { S.roster[p.id] = 1; connectTo(p.id); });
      return;
    }
    if (d.k === 'voice') {
      if (info) {
        info.voice = { active: !!d.active, muted: !!d.muted };
        if (!d.active) info.speaking = false;
      }
      renderUsers();
      return;
    }
    if (d.k === 'stage') {
      openStage(d.url, d.mode, d.embed, peerId, d.nick, false);
      return;
    }
    if (d.k === 'stageClose') {
      if (S.stage.owner === peerId) clearStage(true);
      return;
    }
    if (d.k === 'sync') { applySync(peerId, d); return; }
    if (d.k === 'bye') { dropPeer(peerId); return; }
    if (d.k === 'recall') {
      $$('.row[data-msg-id="' + d.id + '"]').forEach(function (r) { r.parentNode.removeChild(r); });
      sysMsg(((S.conns[peerId] || {}).nick || '成员') + ' 撤回了一条消息');
      return;
    }
    if (d.k === 'file') { onFileMeta(d); return; }
    if (d.k === 'chunk') { onFileChunk(d); return; }
    if (d.k === 'fdone') { onFileDone(d); return; }
    if (d.k === 'faccept') { onFileAccept(peerId, d); return; }
    if (d.k === 'msg') { renderMsg(d, false); return; }
  }

  /* ---------------- 成员列表 ---------------- */
  function renderUsers() {
    var ids = Object.keys(S.conns);
    var rows = [userRow({
      id: S.myId, nick: S.nick, me: true, host: S.isHost,
      voice: { active: !!S.voiceStream, muted: S.voiceMuted }, speaking: S.selfSpeaking
    })];
    ids.forEach(function (id) {
      var o = S.conns[id];
      rows.push(userRow({
        id: id, nick: o.nick, host: !!o.host || id === S.roomId,
        voice: o.voice, speaking: o.speaking
      }));
    });
    $('#users').innerHTML = rows.join('');
    $('#count').textContent = String(ids.length + 1);
  }

  function userRow(u) {
    var initial = esc((u.nick || '?').trim().charAt(0).toUpperCase());
    var tags = (u.me ? '<span class="tag me">我</span>' : '') + (u.host ? '<span class="tag host">房主</span>' : '');
    var v = u.voice || {};
    var sub;
    if (v.active && v.muted) {
      sub = '<svg class="mic-ico off" viewBox="0 0 24 24"><path d="M9 6a3 3 0 0 1 6 0v5M5.5 11a6.5 6.5 0 0 0 10 5.5M12 17.5V21M4 4l16 16"/></svg>已静音';
    } else if (v.active && u.speaking) {
      sub = '<span class="wave on"><i></i><i></i><i></i><i></i></span>正在说话';
    } else if (v.active) {
      sub = '<svg class="mic-ico on" viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="10" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>语音中';
    } else {
      sub = '在线';
    }
    return '<div class="user">' +
      '<div class="avatar' + (v.active && u.speaking ? ' speaking' : '') + '" style="background:' + colorOf(u.id || u.nick) + '">' + initial + '</div>' +
      '<div class="user-meta">' +
        '<div class="user-name">' + esc(u.nick) + ' ' + tags + '</div>' +
        '<div class="user-sub">' + sub + '</div>' +
      '</div>' +
    '</div>';
  }

  /* ---------------- 消息渲染 ---------------- */
  function linkify(text) {
    return esc(text).replace(/(https?:\/\/[^\s<]+)/g, function (u) {
      return '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>';
    });
  }

  function renderMsg(m, isSelf) {
    var row = document.createElement('div');
    row.className = 'row' + (isSelf ? ' me' : '');
    row.dataset.msgId = m.id || '';
    var initial = esc((m.nick || '?').charAt(0).toUpperCase());
    var body = '';
    if (m.type === 'image') {
      body = '<div class="bub plain"><img class="img-msg" src="' + m.content + '" alt="图片" loading="lazy"></div>';
    } else if (m.type === 'video') {
      body = '<div class="bub plain">' + videoCard(m.content, m.meta || {}) + '</div>';
    } else if (m.type === 'audio') {
      body = '<div class="bub plain">' + audioCard(m.content, m.meta || {}) + '</div>';
    } else {
      body = '<div class="bub">' + linkify(String(m.content || '')) + '</div>';
    }

    var age = Date.now() - (m.time || Date.now());
    var act = '';
    if (isSelf && age < 60000) act += '<button class="recall" data-act="recall">撤回</button>';
    if (m.type === 'text') {
      act += (act ? '<span class="dot">·</span>' : '') + '<button data-act="copy">复制</button>';
    } else if (m.type === 'video' || m.type === 'audio') {
      act += (act ? '<span class="dot">·</span>' : '') + '<button data-act="copyurl">复制链接</button>';
    }

    row.innerHTML =
      '<div class="avatar" style="background:' + colorOf(m.senderId || m.nick) + '">' + initial + '</div>' +
      '<div class="bd">' +
        '<div class="mhd"><span class="nm">' + esc(m.nick) + '</span><span class="tm">' + fmtTime(m.time || Date.now()) + '</span></div>' +
        body +
        (act ? '<div class="msg-act">' + act + '</div>' : '') +
      '</div>';
    $('#msgs').appendChild(row);

    var img = row.querySelector('.img-msg');
    if (img) img.onclick = function () { openLightbox(img.src); };

    $$('video[data-src],audio[data-src]', row).forEach(initMedia);

    $$('[data-act="copy"],[data-act="copyurl"]', row).forEach(function (b) {
      b.onclick = function () {
        var txt = b.dataset.act === 'copy' ? m.content : m.content;
        copyText(txt);
      };
    });
    $$('[data-act="recall"]', row).forEach(function (b) {
      b.onclick = function () {
        if (Date.now() - (m.time || 0) > 60000) { toast('已超过撤回时限', 'warn', 1600); return; }
        if (row.parentNode) row.parentNode.removeChild(row);
        broadcast({ k: 'recall', id: m.id });
        sysMsg('你撤回了一条消息');
      };
      setTimeout(function () { b.classList.add('hidden'); }, Math.max(0, 60000 - age));
    });

    var pushBtn = row.querySelector('[data-push]');
    if (pushBtn) {
      pushBtn.onclick = function () {
        pushToStage(pushBtn.dataset.push, pushBtn.dataset.mode, pushBtn.dataset.embed);
      };
    }
    scrollBottom(isSelf);
  }

  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(function () { toast('已复制', 'ok', 1600); },
        function () { toast('复制失败', 'warn'); });
    } else {
      var ta = document.createElement('textarea');
      ta.value = t; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('已复制', 'ok', 1600); }
      catch (e) { toast('复制失败', 'warn'); }
      document.body.removeChild(ta);
    }
  }

  /* ---------------- 视频链接识别 ---------------- */
  function parseVideo(url) {
    var u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) return null;
    var m;
    if ((m = u.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/i))) {
      return { mode: 'frame', src: 'YouTube', embed: 'https://www.youtube.com/embed/' + m[1] + '?rel=0' };
    }
    if ((m = u.match(/bilibili\.com\/video\/(BV[\w]+)/i))) {
      return { mode: 'frame', src: 'B站', embed: 'https://player.bilibili.com/player.html?bvid=' + m[1] + '&page=1&high_quality=1&danmaku=0&autoplay=0' };
    }
    if ((m = u.match(/bilibili\.com\/video\/av(\d+)/i))) {
      return { mode: 'frame', src: 'B站', embed: 'https://player.bilibili.com/player.html?aid=' + m[1] + '&page=1&high_quality=1&danmaku=0&autoplay=0' };
    }
    if (/(?:vimeo\.com\/)(\d+)/i.test(u)) {
      return { mode: 'frame', src: 'Vimeo', embed: 'https://player.vimeo.com/video/' + u.match(/vimeo\.com\/(\d+)/i)[1] };
    }
    if (/\.(mp3|wav|oga|ogg|m4a|aac|flac|opus|weba)(\?|#|$)/i.test(u)) {
      return { mode: 'audio', src: '音频直链', embed: u };
    }
    if (/\.(m3u8)(\?|#|$)/i.test(u)) return { mode: 'video', src: 'HLS 流', embed: u };
    if (/\.(mp4|webm|ogv|m4v|mov)(\?|#|$)/i.test(u)) return { mode: 'video', src: '直链视频', embed: u };
    return null;
  }

  function isHls(url) { return /\.m3u8(\?|#|$)/i.test(url || ''); }

  function videoCard(url, meta) {
    var mode = meta.mode || 'video';
    var player = mode === 'frame'
      ? '<iframe src="' + esc(meta.embed || url) + '" allow="autoplay; fullscreen; encrypted-media" allowfullscreen scrolling="no" referrerpolicy="no-referrer"></iframe>'
      : '<video data-src="' + esc(meta.embed || url) + '" controls playsinline preload="metadata"></video>';
    return '<div class="vcard">' + player +
      '<div class="ft"><span class="src">' + esc(meta.src || '视频') + '</span><span class="u">' + esc(url) + '</span>' +
      '<button data-push="' + esc(url) + '" data-mode="' + mode + '" data-embed="' + esc(meta.embed || url) + '">推到共享区</button></div></div>';
  }

  function audioCard(url, meta) {
    return '<div class="vcard" style="max-width:340px">' +
      '<audio data-src="' + esc(meta.embed || url) + '" controls preload="metadata"></audio>' +
      '<div class="ft"><span class="src">' + esc(meta.src || '音频') + '</span><span class="u">' + esc(url) + '</span></div></div>';
  }

  function attachHls(v, url) {
    var h = new window.Hls({ enableWorker: true });
    h.loadSource(url);
    h.attachMedia(v);
    h.on(window.Hls.Events.MANIFEST_PARSED, function () { v.play().catch(function () { /* noop */ }); });
    h.on(window.Hls.Events.ERROR, function (_, e) {
      if (e && e.fatal) { h.destroy(); v.src = url; }
    });
  }

  function initMedia(el) {
    var url = el.dataset.src;
    if (!url) return;
    if (el.tagName === 'VIDEO' && isHls(url)) {
      if (window.Hls && window.Hls.isSupported()) attachHls(el, url);
      else if (el.canPlayType('application/vnd.apple.mpegurl')) el.src = url;
      else {
        ensureLib('hls', 'Hls').then(function () {
          if (window.Hls && window.Hls.isSupported()) attachHls(el, url); else el.src = url;
        }).catch(function () { el.src = url; });
      }
    } else {
      el.src = url;
    }
  }

  /* ---------------- 发送 ---------------- */
  var input = $('#input');
  input.addEventListener('input', function () {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    $('#send').classList.toggle('off', !input.value.trim());
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendText(); }
  });
  $('#send').onclick = sendText;

  function emit(msg) {
    msg.k = 'msg';
    msg.senderId = S.myId;
    msg.nick = S.nick;
    msg.time = Date.now();
    msg.id = uid('m');
    broadcast(msg);
    renderMsg(msg, true);
  }

  function sendText() {
    var text = input.value.trim();
    if (!text) return;
    var v = parseVideo(text);
    if (v && v.mode === 'frame') emit({ type: 'video', content: text, meta: v });
    else if (v && v.mode === 'audio') emit({ type: 'audio', content: text, meta: v });
    else emit({ type: 'text', content: text });
    input.value = '';
    input.style.height = 'auto';
    $('#send').classList.add('off');
    input.focus();
  }

  /* ---------------- 图片 ---------------- */
  $('#imgBtn').onclick = function () { $('#filePick').click(); };
  $('#filePick').onchange = function (e) {
    var f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    shrinkImage(f, 1440, 0.8).then(function (dataUrl) {
      emit({ type: 'image', content: dataUrl });
    }).catch(function (err) { toast('图片处理失败：' + err.message, 'err'); });
  };

  function shrinkImage(file, maxDim, q) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onerror = function () { rej(new Error('读取失败')); };
      fr.onload = function () {
        var img = new Image();
        img.onerror = function () { rej(new Error('解析失败')); };
        img.onload = function () {
          var w = img.width, h = img.height;
          var scale = Math.min(1, maxDim / Math.max(w, h));
          if (scale === 1 && fr.result.length < 260000) return res(fr.result);
          w = Math.round(w * scale); h = Math.round(h * scale);
          var c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          res(c.toDataURL('image/jpeg', q));
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }

  document.addEventListener('paste', function (e) {
    if (!S.entered) return;
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.type && it.type.indexOf('image/') === 0) {
        var f = it.getAsFile();
        if (f) {
          e.preventDefault();
          shrinkImage(f, 1440, 0.8).then(function (d) { emit({ type: 'image', content: d }); })
            .catch(function () { /* noop */ });
        }
        return;
      }
    }
  });

  /* ---------------- 灯箱 ---------------- */
  function openLightbox(src) { $('#lbImg').src = src; $('#lightbox').classList.add('on'); }
  $('#lightbox').onclick = function () { $('#lightbox').classList.remove('on'); };
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      $('#lightbox').classList.remove('on');
      $('#previewModal').classList.remove('on');
    }
  });

  /* ---------------- 语音 ---------------- */
  $('#micBtn').onclick = function () { if (S.voiceStream) stopVoice(); else startVoice(); };
  $('#muteBtn').onclick = toggleMute;

  function startVoice() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('当前环境不支持麦克风采集', 'err'); return;
    }
    navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false
    }).then(function (stream) {
      S.voiceStream = stream;
      S.voiceMuted = false;
      Object.keys(S.conns).forEach(function (id) { callPeer(id, 'voice'); });
      broadcast({ k: 'voice', active: true, muted: false });
      $('#micBtn').classList.add('active');
      $('#micBtn').title = '关闭麦克风';
      $('#muteBtn').style.display = '';
      $('#muteBtn').classList.remove('muted');
      startDetector('self', stream, function (sp) { S.selfSpeaking = sp; renderUsers(); });
      renderUsers();
      toast('麦克风已开启，房间内成员可听到你', 'ok');
    }).catch(function (e) {
      var msg = e.name === 'NotAllowedError' ? '麦克风权限被拒绝，请在浏览器地址栏放行后重试'
        : e.name === 'NotFoundError' ? '未检测到麦克风设备'
        : '无法开启麦克风：' + (e.message || e.name);
      toast(msg, 'err', 5000);
    });
  }

  function stopVoice() {
    Object.keys(S.voiceCalls).forEach(function (id) { closeCall(S.voiceCalls, id); });
    if (S.voiceStream) { S.voiceStream.getTracks().forEach(function (t) { t.stop(); }); S.voiceStream = null; }
    S.voiceMuted = false;
    S.selfSpeaking = false;
    stopDetector('self');
    broadcast({ k: 'voice', active: false, muted: false });
    $('#micBtn').classList.remove('active');
    $('#micBtn').title = '开启麦克风';
    $('#muteBtn').style.display = 'none';
    $('#muteBtn').classList.remove('muted');
    renderUsers();
    toast('已退出语音', 'info', 2000);
  }

  function toggleMute() {
    if (!S.voiceStream) return;
    S.voiceMuted = !S.voiceMuted;
    S.voiceStream.getAudioTracks().forEach(function (t) { t.enabled = !S.voiceMuted; });
    $('#muteBtn').classList.toggle('muted', S.voiceMuted);
    $('#muteBtn').title = S.voiceMuted ? '取消静音' : '静音';
    if (S.voiceMuted) S.selfSpeaking = false;
    broadcast({ k: 'voice', active: true, muted: S.voiceMuted });
    renderUsers();
    toast(S.voiceMuted ? '已静音，对方听不到你' : '已取消静音', 'info', 1800);
  }

  function callPeer(peerId, kind) {
    var stream = kind === 'voice' ? S.voiceStream : S.shareStream;
    if (!stream) return;
    var map = kind === 'voice' ? S.voiceCalls : S.shareCalls;
    if (map[peerId]) return;
    try {
      var call = S.peer.call(peerId, stream, { metadata: { kind: kind, nick: S.nick } });
      map[peerId] = call;
      call.on('close', function () { delete map[peerId]; });
      call.on('error', function () { delete map[peerId]; });
    } catch (e) { /* noop */ }
  }

  function handleCall(call) {
    var kind = (call.metadata && call.metadata.kind) || 'voice';
    var nick = (call.metadata && call.metadata.nick) || (S.conns[call.peer] || {}).nick || '成员';
    try { call.answer(); } catch (e) { return; }
    call.on('stream', function (stream) {
      if (kind === 'voice') attachAudio(call.peer, stream);
      else showShare(call.peer, stream, nick);
    });
    call.on('close', function () {
      if (kind === 'voice') { removeAudio(call.peer); stopDetector(call.peer); }
      else if (S.stage.owner === call.peer) clearStage(true);
    });
  }

  function attachAudio(peerId, stream) {
    removeAudio(peerId);
    var a = document.createElement('audio');
    a.autoplay = true;
    a.playsInline = true;
    a.srcObject = stream;
    $('#audioSink').appendChild(a);
    a.play().catch(function () { toast('浏览器拦截了自动播放，点击页面任意处即可听到语音', 'warn', 5000); });
    S.audios[peerId] = a;
    startDetector(peerId, stream, function (sp) {
      var info = S.conns[peerId];
      if (info && info.speaking !== sp) { info.speaking = sp; renderUsers(); }
    });
  }
  function removeAudio(peerId) {
    var a = S.audios[peerId];
    if (a) {
      try { a.srcObject = null; a.parentNode.removeChild(a); } catch (e) { /* noop */ }
      delete S.audios[peerId];
    }
  }

  function startDetector(key, stream, cb) {
    stopDetector(key);
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC || !stream.getAudioTracks().length) return;
      var ctx = new AC();
      var src = ctx.createMediaStreamSource(stream);
      var an = ctx.createAnalyser();
      an.fftSize = 512;
      an.smoothingTimeConstant = 0.75;
      src.connect(an);
      var buf = new Uint8Array(an.frequencyBinCount);
      var raf, speaking = false, quiet = 0;
      var loop = function () {
        an.getByteFrequencyData(buf);
        var sum = 0;
        for (var i = 0; i < buf.length; i++) sum += buf[i];
        var avg = sum / buf.length;
        if (avg > 12) { quiet = 0; if (!speaking) { speaking = true; cb(true); } }
        else if (speaking && ++quiet > 22) { speaking = false; cb(false); }
        raf = requestAnimationFrame(loop);
      };
      loop();
      S.detectors[key] = function () {
        cancelAnimationFrame(raf);
        try { src.disconnect(); ctx.close(); } catch (e) { /* noop */ }
        if (speaking) cb(false);
      };
    } catch (e) { /* noop */ }
  }
  function stopDetector(key) {
    var f = S.detectors[key];
    if (f) { f(); delete S.detectors[key]; }
  }

  /* ---------------- 视频共享 ---------------- */
  $('#shareBtn').onclick = function () {
    if (S.shareStream) stopShare(); else $('#videoPick').click();
  };
  $('#videoPick').onchange = function (e) {
    var f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) startShare(f);
  };

  function startShare(file) {
    var v = $('#stageVideo');
    clearStage(false);
    if (S.shareUrl) { URL.revokeObjectURL(S.shareUrl); S.shareUrl = null; }
    S.shareUrl = URL.createObjectURL(file);
    $('#stage').classList.remove('frame');
    $('#stage').classList.add('on');
    v.srcObject = null;
    v.src = S.shareUrl;
    v.muted = false;
    v.controls = true;
    $('#stageWho').textContent = '你正在共享：' + file.name;
    $('#stageLive').style.display = '';
    $('#stageSync').style.display = 'none';
    S.stage = { owner: S.myId, mode: 'p2p', url: '' };

    waitMeta(v).then(function () {
      return v.play().catch(function () { /* noop */ });
    }).then(function () {
      var cap = v.captureStream || v.mozCaptureStream;
      if (!cap) throw new Error('当前浏览器不支持 captureStream，建议使用 Chrome / Edge');
      S.shareStream = cap.call(v);
      Object.keys(S.conns).forEach(function (id) { callPeer(id, 'share'); });
      $('#shareBtn').classList.add('active', 'danger');
      $('#shareBtn').title = '停止共享';
      toast('已开始共享本地视频，房间成员将实时看到画面', 'ok', 4000);
      v.onended = function () { toast('视频播放结束', 'info'); };
    }).catch(function (err) {
      toast(err.message || '共享失败', 'err', 5000);
      stopShare();
    });
  }

  function waitMeta(v) {
    return new Promise(function (res, rej) {
      var done = false;
      v.onloadedmetadata = function () { done = true; res(); };
      v.onerror = function () { rej(new Error('该视频格式浏览器无法解码，建议使用 MP4(H.264) / WebM')); };
      setTimeout(function () { if (!done) rej(new Error('视频加载超时')); }, 12000);
    });
  }

  function stopShare() {
    Object.keys(S.shareCalls).forEach(function (id) { closeCall(S.shareCalls, id); });
    if (S.shareStream) {
      S.shareStream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* noop */ } });
      S.shareStream = null;
    }
    $('#shareBtn').classList.remove('active', 'danger');
    $('#shareBtn').title = '共享本地视频（P2P 推流）';
    if (S.stage.owner === S.myId && (S.stage.mode === 'p2p' || S.stage.mode === 'url')) clearStage(true);
    if (S.shareUrl) { URL.revokeObjectURL(S.shareUrl); S.shareUrl = null; }
  }

  function showShare(peerId, stream, nick) {
    if (S.shareStream && S.stage.owner === S.myId) {
      sysMsg(nick + ' 也在共享视频，停止你的共享后即可观看');
      toast(nick + ' 正在共享视频，停止你的共享后可观看', 'warn', 4500);
      return;
    }
    var v = $('#stageVideo');
    $('#stage').classList.remove('frame');
    $('#stage').classList.add('on');
    v.src = '';
    v.srcObject = stream;
    v.muted = false;
    v.controls = true;
    v.play().catch(function () { toast('点击画面即可开始播放共享视频', 'warn', 4000); });
    $('#stageWho').textContent = nick + ' 正在共享视频';
    $('#stageLive').style.display = '';
    $('#stageSync').style.display = 'none';
    S.stage = { owner: peerId, mode: 'p2p', url: '' };
    sysMsg(nick + ' 开始共享本地视频');
  }

  /* ---------------- 共享区 ---------------- */
  function pushToStage(url, mode, embed) {
    openStage(url, mode, embed, S.myId, S.nick, true);
    broadcast({ k: 'stage', url: url, mode: mode, embed: embed, nick: S.nick });
    toast('已推送到共享区，所有成员同步打开', 'ok');
  }

  function openStage(url, mode, embed, ownerId, nick, isMine) {
    clearStage(false);
    var stage = $('#stage');
    stage.classList.add('on');
    S.stage = { owner: ownerId, mode: mode || 'video', url: url, embed: embed };
    $('#stageLive').style.display = 'none';
    if (mode === 'frame') {
      stage.classList.add('frame');
      $('#stageFrame').src = embed;
      $('#stageSync').style.display = 'none';
    } else {
      stage.classList.remove('frame');
      var v = $('#stageVideo');
      v.srcObject = null;
      if (isHls(embed)) {
        if (window.Hls && window.Hls.isSupported()) attachHls(v, embed);
        else ensureLib('hls', 'Hls').then(function () {
          if (window.Hls && window.Hls.isSupported()) attachHls(v, embed); else v.src = embed;
        }).catch(function () { v.src = embed; });
      } else {
        v.src = embed;
      }
      v.muted = false;
      v.controls = true;
      $('#stageSync').style.display = isMine ? '' : 'none';
      if (isMine) {
        var push = function (action) {
          if (S.stage.owner !== S.myId) return;
          broadcast({ k: 'sync', action: action, time: v.currentTime });
        };
        v.onplay = function () { push('play'); };
        v.onpause = function () { push('pause'); };
        v.onseeked = function () { push('seek'); };
      }
    }
    $('#stageWho').textContent = (isMine ? '你' : nick) + ' 推送到共享区';
    if (!isMine) sysMsg(nick + ' 把一个视频推送到了共享区');
  }

  function applySync(peerId, d) {
    if (S.stage.owner !== peerId || S.stage.mode === 'frame' || S.stage.mode === 'p2p') return;
    var v = $('#stageVideo');
    if (Date.now() - S.syncLock < 250) return;
    S.syncLock = Date.now();
    if (typeof d.time === 'number' && Math.abs(v.currentTime - d.time) > 0.6) v.currentTime = d.time;
    if (d.action === 'play') v.play().catch(function () { /* noop */ });
    if (d.action === 'pause') v.pause();
  }

  $('#stageSync').onclick = function () {
    var v = $('#stageVideo');
    broadcast({ k: 'sync', action: v.paused ? 'pause' : 'play', time: v.currentTime });
    toast('已同步当前播放进度给所有成员', 'ok', 2000);
  };

  $('#stageClose').onclick = function () {
    var mine = S.stage.owner === S.myId;
    if (mine && (S.stage.mode === 'p2p' || S.stage.mode === 'url')) { stopShare(); return; }
    if (mine) broadcast({ k: 'stageClose' });
    clearStage(true);
  };

  function clearStage(hide) {
    var v = $('#stageVideo');
    try { v.pause(); } catch (e) { /* noop */ }
    v.onplay = v.onpause = v.onseeked = v.onended = null;
    v.srcObject = null;
    v.removeAttribute('src');
    $('#stageFrame').src = 'about:blank';
    if (hide) {
      $('#stage').classList.remove('on', 'frame');
      S.stage = { owner: null, mode: null, url: '' };
    }
  }

  /* ---------------- 文件传输 ---------------- */
  $('#fileBtn').onclick = function () { $('#filePickAll').click(); };
  $('#filePickAll').onchange = function (e) {
    var files = Array.prototype.slice.call(e.target.files || []);
    e.target.value = '';
    files.forEach(function (f) { sendFile(f); });
  };

  function sendFile(file) {
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    var fileId = uid('f');
    var big = file.size >= BIG_FILE;
    var entry = {
      fileId: fileId, name: file.name, size: file.size, mime: file.type || '', ext: ext,
      senderId: S.myId, nick: S.nick, time: Date.now(),
      url: URL.createObjectURL(file), isSelf: true,
      chunks: {}, received: file.size, total: file.size, done: false, el: null, big: big,
      order: [], file: big ? file : null, acked: {}
    };
    S.transfers[fileId] = entry;
    mountFileCard(entry);
    scrollBottom(true);
    broadcast({ k: 'file', fileId: fileId, name: file.name, size: file.size, mime: entry.mime, ext: ext, senderId: S.myId, nick: S.nick, time: entry.time, big: big });

    var ids = Object.keys(S.conns);
    if (!ids.length) { entry.done = true; updateFileCard(entry); return; }

    if (!big) {
      toast('正在分发文件：' + file.name, 'info', 2600);
      pump(ids, file, fileId).then(function () {
        broadcast({ k: 'fdone', fileId: fileId });
        entry.done = true;
        updateFileCard(entry);
        toast('文件已送达全部成员', 'ok', 2600);
      }).catch(function (err) {
        toast('文件发送失败：' + (err.message || err), 'err', 5000);
      });
    } else {
      entry.done = true;
      updateFileCard(entry);
      toast('大文件已发出，等待接收者点击接收', 'info', 4000);
    }
  }

  function drain(conn) {
    return new Promise(function (res) {
      var dc = conn.dataChannel;
      if (dc && typeof dc.bufferedAmount === 'number' && dc.bufferedAmount > 1024 * 1024 && dc.bufferedAmountLowThreshold !== undefined) {
        dc.bufferedAmountLowThreshold = 512 * 1024;
        var h = function () { dc.removeEventListener('bufferedamountlow', h); res(); };
        dc.addEventListener('bufferedamountlow', h);
      } else res();
    });
  }

  function pump(peerIds, file, fileId) {
    var list = peerIds.slice();
    return new Promise(function (res, rej) {
      var i = 0;
      (function nextPeer() {
        if (i >= list.length) return res();
        var conn = (S.conns[list[i]] || {}).conn;
        i++;
        if (!conn) return nextPeer();
        var off = 0;
        (function nextChunk() {
          if (off >= file.size) return nextPeer();
          var end = Math.min(off + CHUNK, file.size);
          file.slice(off, end).arrayBuffer().then(function (buf) {
            return drain(conn).then(function () {
              send(conn, { k: 'chunk', fileId: fileId, i: (off / CHUNK) | 0, buf: buf });
              off = end;
              nextChunk();
            });
          }).catch(rej);
        })();
      })();
    });
  }

  function sendFileTo(peerId, entry) {
    var info = S.conns[peerId];
    if (!info || !entry.file) return;
    pump([peerId], entry.file, entry.fileId).then(function () {
      send(info.conn, { k: 'fdone', fileId: entry.fileId });
    }).catch(function (err) {
      toast('文件发送失败：' + (err.message || err), 'err');
    });
  }

  function onFileMeta(d) {
    if (S.transfers[d.fileId]) return;
    var entry = {
      fileId: d.fileId, name: d.name, size: d.size, mime: d.mime, ext: (d.ext || '').toLowerCase(),
      senderId: d.senderId, nick: d.nick || '成员', time: d.time,
      url: null, isSelf: false, chunks: {}, order: [], received: 0, total: d.size,
      done: false, el: null, big: !!d.big, file: null, acked: {}
    };
    S.transfers[d.fileId] = entry;
    if (entry.big) mountPendingCard(entry); else mountFileCard(entry);
    scrollBottom(false);
  }

  function onFileChunk(d) {
    var e = S.transfers[d.fileId];
    if (!e || e.done) return;
    if (e.big && !e.accepted) return;
    var buf = d.buf instanceof ArrayBuffer ? d.buf : (d.buf && d.buf.buffer) || d.buf;
    if (!e.chunks[d.i]) {
      e.chunks[d.i] = buf;
      e.order.push(d.i);
      e.received += (buf && buf.byteLength != null ? buf.byteLength : (buf.length || 0));
    }
    if (e.total > 0 && !e.big) updateFileCard(e);
    else if (e.big && e.el) updatePendingProgress(e);
  }

  function onFileDone(d) {
    var e = S.transfers[d.fileId];
    if (!e || e.done) return;
    try {
      var keys = Object.keys(e.chunks).map(Number).sort(function (a, b) { return a - b; });
      var parts = keys.map(function (k) { return e.chunks[k]; });
      e.url = URL.createObjectURL(new Blob(parts, { type: e.mime || '' }));
      e.chunks = {};
      e.done = true;
      if (e.big) {
        if (e.el && e.el.parentNode) e.el.parentNode.removeChild(e.el);
        mountFileCard(e);
      } else {
        updateFileCard(e);
      }
      scrollBottom(false);
    } catch (err) {
      toast('文件接收失败：' + (err.message || err), 'err', 5000);
    }
  }

  function onFileAccept(peerId, d) {
    var e = S.transfers[d.fileId];
    if (!e || !e.big || e.acked[peerId]) return;
    e.acked[peerId] = 1;
    sendFileTo(peerId, e);
  }

  function pctOf(e) { return e.total ? Math.min(100, Math.round(e.received / e.total * 100)) : (e.done ? 100 : 0); }

  function mountPendingCard(entry) {
    var row = document.createElement('div');
    row.className = 'row' + (entry.isSelf ? ' me' : '');
    row.dataset.msgId = entry.fileId;
    var ic = fileIcon(entry.ext);
    var initial = esc((entry.nick || '?').charAt(0).toUpperCase());
    row.innerHTML =
      '<div class="avatar" style="background:' + colorOf(entry.senderId || entry.nick) + '">' + initial + '</div>' +
      '<div class="bd">' +
        '<div class="mhd"><span class="nm">' + esc(entry.nick) + '</span><span class="tm">' + fmtTime(entry.time) + '</span></div>' +
        '<div class="bub plain"><div class="f-card-pending">' +
          '<div class="f-ico">' + ic[0] + '</div>' +
          '<div class="f-meta">' +
            '<div class="f-name" title="' + esc(entry.name) + '">' + esc(entry.name) + '</div>' +
            '<div class="f-sub"><span class="f-kind">' + ic[1] + '</span> · <span>' + fmtSize(entry.size) + '</span></div>' +
            '<div class="f-pending-note">大文件，点击接收后通过 P2P 传输</div>' +
            '<div class="f-prog" style="display:none"><div class="f-bar"><i style="width:0%"></i></div><span class="f-pct">0%</span></div>' +
          '</div>' +
          '<div class="f-acts"><button class="f-download">接收（' + fmtSize(entry.size) + '）</button></div>' +
        '</div></div>' +
      '</div>';
    $('#msgs').appendChild(row);
    entry.el = row;
    row.querySelector('.f-download').onclick = function () {
      var info = S.conns[entry.senderId];
      if (!info) { toast('发送方已离线', 'warn'); return; }
      var btn = row.querySelector('.f-download');
      btn.disabled = true;
      btn.textContent = '请求接收中…';
      entry.accepted = true;
      row.querySelector('.f-prog').style.display = 'block';
      info.conn.send({ k: 'faccept', fileId: entry.fileId });
    };
  }

  function updatePendingProgress(e) {
    if (!e.el) return;
    var bar = e.el.querySelector('.f-bar i');
    var p = e.el.querySelector('.f-pct');
    if (bar) bar.style.width = pctOf(e) + '%';
    if (p) p.textContent = pctOf(e) + '%';
  }

  function mountFileCard(entry) {
    var row = document.createElement('div');
    row.className = 'row' + (entry.isSelf ? ' me' : '');
    row.dataset.msgId = entry.fileId;
    var ic = fileIcon(entry.ext);
    var initial = esc((entry.nick || '?').charAt(0).toUpperCase());
    var age = Date.now() - (entry.time || Date.now());
    var recall = entry.isSelf && age < 60000
      ? '<div class="msg-act"><button class="recall" data-act="recall">撤回</button></div>' : '';
    row.innerHTML =
      '<div class="avatar" style="background:' + colorOf(entry.senderId || entry.nick) + '">' + initial + '</div>' +
      '<div class="bd">' +
        '<div class="mhd"><span class="nm">' + esc(entry.nick) + '</span><span class="tm">' + fmtTime(entry.time) + '</span></div>' +
        recall +
        '<div class="bub plain"><div class="fcard">' +
          '<div class="f-ico">' + ic[0] + '</div>' +
          '<div class="f-meta">' +
            '<div class="f-name" title="' + esc(entry.name) + '">' + esc(entry.name) + '</div>' +
            '<div class="f-sub"><span class="f-kind">' + ic[1] + '</span> · <span>' + fmtSize(entry.size) + '</span></div>' +
            '<div class="f-prog" style="display:' + (entry.done || entry.isSelf ? 'none' : 'block') + '">' +
              '<div class="f-bar"><i style="width:' + pctOf(entry) + '%"></i></div>' +
              '<span class="f-pct">' + (entry.isSelf ? '分发中…' : pctOf(entry) + '%') + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="f-acts">' +
            '<button class="f-prev"' + (entry.url ? '' : ' disabled') + '>预览</button>' +
            '<a class="f-dl" href="' + (entry.url || '') + '" download="' + esc(entry.name) + '"' +
              (entry.url ? '' : ' style="pointer-events:none;opacity:.4"') + '>下载</a>' +
          '</div>' +
        '</div></div>' +
      '</div>';
    $('#msgs').appendChild(row);
    entry.el = row;
    row.querySelector('.f-prev').onclick = function () { openPreview(entry); };
    $$('[data-act="recall"]', row).forEach(function (b) {
      b.onclick = function () {
        if (row.parentNode) row.parentNode.removeChild(row);
        broadcast({ k: 'recall', id: entry.fileId });
        sysMsg('你撤回了一条消息');
      };
      setTimeout(function () { b.classList.add('hidden'); }, Math.max(0, 60000 - age));
    });
    if (IMG.indexOf(entry.ext) >= 0 && entry.url) {
      var im = document.createElement('img');
      im.className = 'f-thumb';
      im.src = entry.url;
      im.onclick = function () { openPreview(entry); };
      row.querySelector('.fcard').appendChild(im);
    }
  }

  function updateFileCard(entry) {
    if (!entry.el) return;
    var bar = entry.el.querySelector('.f-prog');
    var prev = entry.el.querySelector('.f-prev');
    var dl = entry.el.querySelector('.f-dl');
    if (entry.done) {
      if (bar) bar.style.display = 'none';
      if (prev) prev.disabled = false;
      if (dl) { dl.href = entry.url || ''; dl.style.pointerEvents = ''; dl.style.opacity = ''; }
      if (IMG.indexOf(entry.ext) >= 0 && entry.url && !entry.el.querySelector('.f-thumb')) {
        var im = document.createElement('img');
        im.className = 'f-thumb';
        im.src = entry.url;
        im.onclick = function () { openPreview(entry); };
        entry.el.querySelector('.fcard').appendChild(im);
      }
    } else if (bar) {
      bar.style.display = 'block';
      var i = bar.querySelector('i'); if (i) i.style.width = pctOf(entry) + '%';
      var p = bar.querySelector('.f-pct'); if (p) p.textContent = entry.isSelf ? '已发送' : pctOf(entry) + '%';
    }
  }

  /* ---------------- 文件预览 ---------------- */
  $('#pmClose').onclick = function () { $('#previewModal').classList.remove('on'); };
  $('#previewModal').onclick = function (e) {
    if (e.target === $('#previewModal')) $('#previewModal').classList.remove('on');
  };

  function openPreview(entry) {
    var url = entry.url;
    if (!url) return;
    $('#pmName').textContent = entry.name;
    var dl = $('#pmDownload');
    dl.href = url;
    dl.download = entry.name;
    var body = $('#pmBody');
    body.innerHTML = '<div class="pm-loading">正在加载预览…</div>';
    $('#previewModal').classList.add('on');

    var ext = entry.ext;
    var fail = function (e) {
      body.innerHTML = '<div class="pm-note">预览失败：' + esc((e && e.message) || e) + '</div>';
    };
    try {
      if (IMG.indexOf(ext) >= 0) {
        body.innerHTML = '';
        var img = new Image();
        img.src = url;
        img.className = 'pm-img';
        body.appendChild(img);
      } else if (AUD.indexOf(ext) >= 0) {
        body.innerHTML = '';
        var a = document.createElement('audio');
        a.src = url; a.controls = true; a.className = 'pm-media';
        body.appendChild(a);
        a.play().catch(function () { /* noop */ });
      } else if (MOV.indexOf(ext) >= 0) {
        body.innerHTML = '';
        var v = document.createElement('video');
        v.src = url; v.controls = true; v.className = 'pm-media';
        body.appendChild(v);
        v.play().catch(function () { /* noop */ });
      } else if (ext === 'docx' || ext === 'doc') {
        ensureLib('mammoth', 'mammoth').then(function () {
          return fetch(url).then(function (r) { return r.arrayBuffer(); });
        }).then(function (buf) {
          return window.mammoth.convertToHtml({ arrayBuffer: buf });
        }).then(function (r) {
          body.innerHTML = '<div class="pm-doc">' + (r.value || '<p style="color:#999">文档无可提取内容</p>') + '</div>';
        }).catch(fail);
      } else if (ext === 'xlsx' || ext === 'xls') {
        ensureLib('xlsx', 'XLSX').then(function () {
          return fetch(url).then(function (r) { return r.arrayBuffer(); });
        }).then(function (buf) {
          var wb = window.XLSX.read(buf, { type: 'array' });
          var names = wb.SheetNames || [];
          if (!names.length) return '<div class="pm-note">工作簿为空</div>';
          return names.map(function (nm) {
            return '<div class="sh"><div class="sh-nm">' + esc(nm) + '</div><div class="sh-tbl">' +
              window.XLSX.utils.sheet_to_html(wb.Sheets[nm]) + '</div></div>';
          }).join('');
        }).then(function (h) { body.innerHTML = h; }).catch(fail);
      } else if (ext === 'pptx' || ext === 'ppt') {
        ensureLib('jszip', 'JSZip').then(function () {
          return fetch(url).then(function (r) { return r.arrayBuffer(); });
        }).then(function (buf) {
          return window.JSZip.loadAsync(buf);
        }).then(function (zip) {
          var names = Object.keys(zip.files).filter(function (n) { return /ppt\/slides\/slide\d+\.xml$/i.test(n); });
          names.sort(function (a, b) {
            return (+((a.match(/slide(\d+)/i) || [])[1]) || 0) - (+((b.match(/slide(\d+)/i) || [])[1]) || 0);
          });
          if (!names.length) return '<div class="pm-note">未找到可提取的幻灯片（可能为旧版 .ppt，请下载后查看）</div>';
          var chain = Promise.resolve('');
          var i = 1;
          names.forEach(function (n) {
            var idx = i++;
            chain = chain.then(function (h) {
              return zip.file(n).async('string').then(function (xml) {
                var texts = [];
                var re = /<a:t>([^<]*)<\/a:t>/g, m;
                while ((m = re.exec(xml))) { if (m[1].trim()) texts.push(esc(m[1])); }
                return h + '<div class="slide"><div class="slide-n">幻灯片 ' + idx + '</div><div class="slide-body">' +
                  (texts.map(function (t) { return '<p>' + t + '</p>'; }).join('') || '<p class="pm-note">(本页无可提取文字)</p>') +
                  '</div></div>';
              });
            });
          });
          return chain;
        }).then(function (h) { body.innerHTML = h; }).catch(fail);
      } else if (ext === 'xmind') {
        ensureLib('jszip', 'JSZip').then(function () {
          return fetch(url).then(function (r) { return r.arrayBuffer(); });
        }).then(function (buf) { return window.JSZip.loadAsync(buf); }).then(function (zip) {
          if (zip.file('content.json')) {
            return zip.file('content.json').async('string').then(function (s) {
              return xmindJson(JSON.parse(s));
            });
          }
          if (zip.file('content.xml')) {
            return zip.file('content.xml').async('string').then(function (s) { return xmindXml(s); });
          }
          return '<div class="pm-note">未识别的思维导图内容</div>';
        }).then(function (h) { body.innerHTML = h; }).catch(fail);
      } else {
        body.innerHTML = '<div class="pm-note">该格式暂不支持在线预览，请点击右上角「下载」后查看。<br>' +
          '<a href="' + url + '" download="' + esc(entry.name) + '">下载文件</a></div>';
      }
    } catch (e) { fail(e); }
  }

  function xmindJson(json) {
    var sheets = Array.isArray(json) ? json : [json];
    var html = '';
    sheets.forEach(function (sh) {
      html += '<div class="xm-sheet"><div class="xm-root">' + xmindNode(sh.rootTopic || sh) + '</div></div>';
    });
    return html || '<div class="pm-note">思维导图为空</div>';
  }
  function xmindNode(t) {
    if (!t) return '';
    var list = [];
    if (t.children) {
      if (Array.isArray(t.children)) list = t.children;
      else if (t.children.attached) list = t.children.attached;
      else if (t.children.detached) list = t.children.detached;
    }
    var inner = list.map(xmindNode).join('');
    return '<div class="xm-node"><span class="xm-t">' + esc(t.title || '') + '</span>' +
      (inner ? '<div class="xm-ch">' + inner + '</div>' : '') + '</div>';
  }
  function xmindXml(xmlStr) {
    var doc = new DOMParser().parseFromString(xmlStr, 'text/xml');
    var sheets = Array.prototype.slice.call(doc.getElementsByTagName('sheet'));
    var html = '';
    sheets.forEach(function (sh) {
      var central = sh.querySelector('topic[central="true"]') || sh.querySelector('topic');
      html += '<div class="xm-sheet"><div class="xm-root">' + xmlNode(central) + '</div></div>';
    });
    return html || '<div class="pm-note">无法解析思维导图</div>';
  }
  function xmlNode(t) {
    if (!t) return '';
    var el = null;
    for (var i = 0; i < t.children.length; i++) {
      if (t.children[i].tagName === 'title') { el = t.children[i]; break; }
    }
    var title = esc(el ? el.textContent : '');
    var inner = '';
    var kids = t.children;
    for (var j = 0; j < kids.length; j++) {
      if (kids[j].tagName === 'children') {
        var topics = kids[j].querySelector('topics[type="attached"]');
        if (topics) {
          Array.prototype.slice.call(topics.children).forEach(function (c) { inner += xmlNode(c); });
        }
      }
    }
    return '<div class="xm-node"><span class="xm-t">' + title + '</span>' +
      (inner ? '<div class="xm-ch">' + inner + '</div>' : '') + '</div>';
  }

  /* ---------------- 顶部操作 / 清理 ---------------- */
  $('#copyBtn').onclick = function () { copyText(S.roomId || ''); };
  $('#leaveBtn').onclick = function () {
    if (!confirm('确定离开房间？当前连接将全部断开。')) return;
    cleanup();
    location.reload();
  };
  function cleanup() {
    try { broadcast({ k: 'bye' }); } catch (e) { /* noop */ }
    stopShare();
    if (S.voiceStream) stopVoice();
    Object.keys(S.conns).forEach(function (id) {
      try { S.conns[id].conn.close(); } catch (e) { /* noop */ }
    });
    try { if (S.peer) S.peer.destroy(); } catch (e) { /* noop */ }
  }
  window.addEventListener('beforeunload', cleanup);

  $('#drawerBtn').onclick = function () {
    $('#aside').classList.toggle('on');
    $('#mask').classList.toggle('on');
  };
  $('#mask').onclick = function () {
    $('#aside').classList.remove('on');
    $('#mask').classList.remove('on');
  };

  /* ---------------- 启动 ---------------- */
  (function boot() {
    if (typeof Peer === 'undefined') ensurePeer();
    if (!window.isSecureContext) {
      toast('非安全上下文（建议 https 或 localhost），麦克风可能不可用', 'warn', 6500);
    }
    var q = new URLSearchParams(location.search).get('room') || location.hash.replace(/^#/, '');
    if (q) {
      $('#modeJoin').click();
      $('#roomIn').value = q.trim();
      $('#nick').focus();
    }
  })();
})();
