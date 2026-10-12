#!/usr/bin/env node
/* =========================================================================
   P2P 实时共享聊天室 · 端到端自动化测试
   用法：node tools/e2e.js
   原理：无头 Edge/Chrome（假摄像头麦克风）+ CDP 协议驱动三个真实页面，
        通过 PeerJS 公共信令真实建连，逐项验证功能。
   依赖：Node 18+（内置 WebSocket）、本机 Edge 或 Chrome、可访问公网信令。
   ========================================================================= */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const PORT = 9223;                       // CDP 调试端口
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
];
const MIME = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- 静态服务器（P2P 页面必须在安全上下文里才能拿到摄像头） ---- */
function serve() {
  return new Promise(res => {
    const s = http.createServer((rq, rs) => {
      let p = decodeURIComponent(rq.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f)) { rs.writeHead(404); return rs.end('404'); }
      rs.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(rs);
    });
    s.listen(0, '127.0.0.1', () => res({ server: s, port: s.address().port }));
  });
}

function req(pathname, method) {
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: method || 'GET' }, resp => {
      let d = ''; resp.on('data', c => d += c); resp.on('end', () => { try { res(JSON.parse(d)); } catch (e) { res(d); } });
    });
    r.on('error', rej); r.end();
  });
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0; this.map = new Map();
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && this.map.has(m.id)) {
        const p = this.map.get(m.id); this.map.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      }
    };
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.map.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.map.has(id)) { this.map.delete(id); rej(new Error('CDP 超时: ' + method)); } }, 90000);
    });
  }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || 'eval error');
    return r.result.value;
  }
}

const results = [];
async function T(name, fn) {
  const t0 = Date.now();
  try { const extra = await fn(); results.push({ ok: true, name, ms: Date.now() - t0 }); console.log('  PASS ' + name + ' (' + (Date.now() - t0) + 'ms)' + (extra ? '  ' + extra : '')); }
  catch (e) { results.push({ ok: false, name, err: e.message }); console.log('  FAIL ' + name + '  ' + e.message); }
}
async function waitFor(cdp, expr, label, timeout) {
  const t0 = Date.now(); timeout = timeout || 25000;
  while (Date.now() - t0 < timeout) {
    const v = await cdp.ev(expr);
    if (v) return v;
    await sleep(400);
  }
  throw new Error('超时(' + timeout + 'ms)：' + label);
}

(async function main() {
  const bin = BROWSERS.find(p => fs.existsSync(p));
  if (!bin) { console.log('未找到 Edge / Chrome，无法运行端到端测试'); process.exit(2); }

  const { server, port } = await serve();
  const APP = 'http://127.0.0.1:' + port + '/';
  const PROFILE = path.join(os.tmpdir(), 'p2p-e2e-profile');
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* noop */ }
  console.log('静态服务: ' + APP + '\n浏览器: ' + bin);

  const proc = spawn(bin, [
    '--headless=new', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-capture',
    '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--mute-audio', '--window-size=1200,800', '--user-data-dir=' + PROFILE, 'about:blank'
  ], { stdio: 'ignore' });

  let ver = null;
  for (let i = 0; i < 60 && !ver; i++) { try { ver = await req('/json/version'); } catch (e) { await sleep(500); } }
  if (!ver) { console.log('浏览器启动失败'); proc.kill(); server.close(); process.exit(1); }

  const mk = async () => { const t = await req('/json/new?' + encodeURIComponent(APP), 'PUT'); const c = new CDP(t.webSocketDebuggerUrl); await c.ready; await c.send('Runtime.enable'); return c; };
  const A = await mk(), B = await mk();
  await sleep(1200);

  let room = '';
  await T('A 创建房间并进入', async () => {
    await A.ev(`window.confirm=()=>true;document.querySelector('#nick').value='A房主';document.querySelector('#goBtn').click();'ok'`);
    await waitFor(A, `document.querySelector('#app').classList.contains('on')`, 'A 进入主界面', 30000);
    room = await waitFor(A, `(function(){var t=document.querySelector('#roomId').textContent.trim();return /^\\d{4}$/.test(t)?t:null})()`, '房间号生成', 30000);
    return '房间号=' + room;
  });
  await T('B 用房间号加入', async () => {
    await B.ev(`window.confirm=()=>true;document.querySelector('#nick').value='B成员';document.querySelector('#modeJoin').click();document.querySelector('#roomIn').value=` + JSON.stringify(room) + `;document.querySelector('#goBtn').click();'ok'`);
    await waitFor(B, `document.querySelector('#app').classList.contains('on')`, 'B 进入主界面', 30000);
  });
  await T('双方成员列表各显示 2 人', async () => {
    await waitFor(A, `document.querySelectorAll('#users .user').length===2`, 'A 看到 2 人', 30000);
    await waitFor(B, `document.querySelectorAll('#users .user').length===2`, 'B 看到 2 人', 30000);
  });
  await T('B 发文本，A 收到', async () => {
    await B.ev(`(function(){var i=document.querySelector('#input');i.value='B的文本消息-'+Date.now();i.dispatchEvent(new Event('input'));document.querySelector('#send').click();return 'ok'})()`);
    return await waitFor(A, `(function(){var b=[...document.querySelectorAll('#msgs .bub')].filter(x=>x.textContent.indexOf('B的文本消息')===0);return b.length?b[b.length-1].textContent:null})()`, 'A 收到 B 文本', 20000);
  });
  await T('A 发文本并撤回，B 侧同步移除', async () => {
    await A.ev(`(function(){var i=document.querySelector('#input');i.value='待撤回消息ABC';i.dispatchEvent(new Event('input'));document.querySelector('#send').click();return 'ok'})()`);
    await waitFor(B, `[...document.querySelectorAll('#msgs .bub')].some(b=>b.textContent.includes('待撤回消息ABC'))`, 'B 收到待撤回消息', 20000);
    await A.ev(`(function(){var r=[...document.querySelectorAll('#msgs .row.me')].filter(x=>x.textContent.includes('待撤回消息ABC'));r[r.length-1].querySelector('.recall').click();return 'ok'})()`);
    await waitFor(B, `![...document.querySelectorAll('#msgs .bub')].some(b=>b.textContent.includes('待撤回消息ABC'))`, 'B 侧消息消失', 20000);
  });
  await T('A 开启摄像头视频通话，B 收到画面', async () => {
    await A.ev(`document.querySelector('#camBtn').click();'ok'`);
    await waitFor(A, `document.querySelectorAll('#videos .vt').length===1`, 'A 出现本地画面', 20000);
    await waitFor(B, `document.querySelectorAll('#videos .vt').length===1`, 'B 出现 A 的瓦片', 35000);
    const w = await waitFor(B, `(function(){var v=document.querySelector('#videos .vt video');return (v&&v.videoWidth>0)?(v.videoWidth+'x'+v.videoHeight):null})()`, 'B 侧收到真实分辨率', 35000);
    return '分辨率=' + w;
  });
  await T('B 侧成员列表显示 A 视频中', async () => {
    await waitFor(B, `[...document.querySelectorAll('#users .user-sub')].some(e=>e.textContent.includes('视频通话中')||e.textContent.includes('正在说话'))`, '成员状态为视频中', 15000);
  });
  await T('A 关闭画面，B 侧切到头像占位', async () => {
    await A.ev(`document.querySelector('#videos .vt.me [data-c=\\'cam\\']').click();'ok'`);
    await waitFor(B, `document.querySelector('#videos .vt').classList.contains('novid')`, 'B 侧显示头像占位', 15000);
  });
  await T('A 静音，B 侧图标变红', async () => {
    await A.ev(`document.querySelector('#videos .vt.me [data-c=\\'mic\\']').click();'ok'`);
    await waitFor(B, `!!document.querySelector('#videos .vt .st-mic.off')`, 'B 侧静音图标', 15000);
  });
  await T('A 结束视频通话，B 侧瓦片移除', async () => {
    await A.ev(`document.querySelector('#camBtn').click();'ok'`);
    await waitFor(B, `document.querySelectorAll('#videos .vt').length===0`, 'B 侧瓦片清空', 20000);
    await waitFor(B, `document.querySelector('#videos').classList.contains('on')===false`, '网格收起', 10000);
  });
  await T('A 开麦语音，B 收到音频流', async () => {
    await A.ev(`document.querySelector('#micBtn').click();'ok'`);
    await waitFor(B, `document.querySelectorAll('#audioSink audio').length===1`, 'B 收到音频元素', 25000);
    await waitFor(B, `[...document.querySelectorAll('#users .mic-ico.on')].length>0`, 'B 侧显示语音中', 15000);
  });
  await T('A 静音后取消，状态同步', async () => {
    await A.ev(`document.querySelector('#muteBtn').click();'ok'`);
    await waitFor(B, `[...document.querySelectorAll('#users .mic-ico.off')].length>0`, 'B 侧显示静音', 15000);
    await A.ev(`document.querySelector('#muteBtn').click();'ok'`);
    await waitFor(B, `[...document.querySelectorAll('#users .mic-ico.on')].length>0`, 'B 侧恢复语音中', 15000);
  });
  await T('A 关闭麦克风，B 侧音频清理', async () => {
    await A.ev(`document.querySelector('#micBtn').click();'ok'`);
    await waitFor(B, `document.querySelectorAll('#audioSink audio').length===0`, 'B 侧音频清理', 20000);
  });
  await T('A 发 300KB 文件，B 收到并完成传输', async () => {
    await A.ev(`(function(){var dt=new DataTransfer();dt.items.add(new File([new Uint8Array(300000)],'e2e-test.bin',{type:'application/octet-stream'}));var el=document.querySelector('#filePickAll');el.files=dt.files;el.dispatchEvent(new Event('change'));return 'ok'})()`);
    await waitFor(B, `[...document.querySelectorAll('#msgs .f-name')].some(e=>e.textContent.includes('e2e-test.bin'))`, 'B 收到文件卡片', 25000);
    return '进度=' + await waitFor(B, `(function(){var p=[...document.querySelectorAll('#msgs .f-pct')];return p.length&&p[p.length-1].textContent.trim()==='100%'?'100%':null})()`, '传输完成', 60000);
  });
  await T('B 能拿到文件 Blob 并下载', async () => {
    return 'href=' + await waitFor(B, `(function(){var a=[...document.querySelectorAll('#msgs .f-acts a')];return a.length?a[a.length-1].getAttribute('href').slice(0,5):null})()`, '下载链接生成', 20000);
  });
  await T('A 发图片，B 收到（压缩通道）', async () => {
    await A.ev(`(async function(){var c=document.createElement('canvas');c.width=900;c.height=600;var x=c.getContext('2d');x.fillStyle='#c08b2c';x.fillRect(0,0,900,600);var blob=await new Promise(r=>c.toBlob(r,'image/png'));var dt=new DataTransfer();dt.items.add(new File([blob],'shot.png',{type:'image/png'}));var el=document.querySelector('#filePick');el.files=dt.files;el.dispatchEvent(new Event('change'));return 'ok'})()`);
    await waitFor(B, `document.querySelectorAll('#msgs .img-msg').length>0`, 'B 收到图片', 30000);
  });
  await T('A 发 B站链接，B 生成视频卡片', async () => {
    await A.ev(`(function(){var i=document.querySelector('#input');i.value='https://www.bilibili.com/video/BV1GJ411x7h7';i.dispatchEvent(new Event('input'));document.querySelector('#send').click();return 'ok'})()`);
    await waitFor(B, `document.querySelectorAll('#msgs .vcard').length>0`, 'B 收到视频卡片', 25000);
  });
  await T('B 点击图片可打开 / 关闭灯箱', async () => {
    await B.ev(`document.querySelector('#msgs .img-msg').click();'ok'`);
    await waitFor(B, `document.querySelector('#lightbox').classList.contains('on')`, '灯箱打开', 10000);
    await B.ev(`document.querySelector('#lbClose').click();'ok'`);
    await waitFor(B, `!document.querySelector('#lightbox').classList.contains('on')`, '灯箱关闭', 10000);
  });
  await T('A 共享本地视频，B 侧共享区出画面', async () => {
    await A.ev(`(async function(){var c=document.createElement('canvas');c.width=320;c.height=240;var x=c.getContext('2d');var iv=setInterval(function(){x.fillStyle='hsl('+(Date.now()%360)+' 60% 50%)';x.fillRect(0,0,320,240);},80);var st=c.captureStream(15);var rec=new MediaRecorder(st,{mimeType:'video/webm'});var ch=[];rec.ondataavailable=function(e){ch.push(e.data)};rec.start();await new Promise(r=>setTimeout(r,2200));await new Promise(r=>{rec.onstop=r;rec.stop()});clearInterval(iv);var blob=new Blob(ch,{type:'video/webm'});var dt=new DataTransfer();dt.items.add(new File([blob],'clip.webm',{type:'video/webm'}));var el=document.querySelector('#videoPick');el.files=dt.files;el.dispatchEvent(new Event('change'));return 'ok'})()`);
    await waitFor(B, `document.querySelector('#stage').classList.contains('on')`, 'B 共享区打开', 30000);
    const w = await waitFor(B, `(function(){var v=document.querySelector('#stageVideo');return (v&&v.videoWidth>0)?(v.videoWidth+'x'+v.videoHeight):null})()`, 'B 共享区出画面', 30000);
    await A.ev(`document.querySelector('#stageClose').click();'ok'`);
    await waitFor(B, `!document.querySelector('#stage').classList.contains('on')`, 'B 共享区关闭', 15000);
    return 'B 分辨率=' + w;
  });
  await T('B 把视频链接推到共享区，A 侧同步打开', async () => {
    await B.ev(`document.querySelector('#msgs .vcard .ft button').click();'ok'`);
    await waitFor(B, `document.querySelector('#stage').classList.contains('on')&&document.querySelector('#stage').classList.contains('frame')`, 'B 共享区为网页模式', 20000);
    await waitFor(A, `document.querySelector('#stage').classList.contains('on')`, 'A 侧同步打开共享区', 20000);
    await B.ev(`document.querySelector('#stageClose').click();'ok'`);
  });

  const C = await mk();
  await T('C 加入后三方成员列表各 3 人', async () => {
    await C.ev(`window.confirm=()=>true;document.querySelector('#nick').value='C成员';document.querySelector('#modeJoin').click();document.querySelector('#roomIn').value=` + JSON.stringify(room) + `;document.querySelector('#goBtn').click();'ok'`);
    await waitFor(C, `document.querySelector('#app').classList.contains('on')`, 'C 进入主界面', 30000);
    await waitFor(A, `document.querySelectorAll('#users .user').length===3`, 'A 看到 3 人', 30000);
    await waitFor(B, `document.querySelectorAll('#users .user').length===3`, 'B 看到 3 人', 30000);
    await waitFor(C, `document.querySelectorAll('#users .user').length===3`, 'C 看到 3 人', 30000);
  });
  await T('C 发消息，A 与 B 同时收到', async () => {
    await C.ev(`(function(){var i=document.querySelector('#input');i.value='来自C的广播消息';i.dispatchEvent(new Event('input'));document.querySelector('#send').click();return 'ok'})()`);
    await waitFor(A, `[...document.querySelectorAll('#msgs .bub')].some(b=>b.textContent.includes('来自C的广播消息'))`, 'A 收到 C 消息', 20000);
    await waitFor(B, `[...document.querySelectorAll('#msgs .bub')].some(b=>b.textContent.includes('来自C的广播消息'))`, 'B 收到 C 消息', 20000);
  });
  await T('60MB 大文件：B 需点接收，再完成传输', async () => {
    await A.ev(`(function(){var big=new Uint8Array(60*1024*1024);for(var i=0;i<big.length;i+=4096)big[i]=i&255;var dt=new DataTransfer();dt.items.add(new File([big],'big-file.bin',{type:'application/octet-stream'}));var el=document.querySelector('#filePickAll');el.files=dt.files;el.dispatchEvent(new Event('change'));return 'ok'})()`);
    await waitFor(B, `[...document.querySelectorAll('#msgs .f-name')].some(e=>e.textContent.includes('big-file.bin'))`, 'B 收到大文件卡片', 40000);
    await waitFor(B, `!!document.querySelector('#msgs .f-download')`, 'B 出现接收按钮', 20000);
    await B.ev(`document.querySelector('#msgs .f-download').click();'ok'`);
    return '进度=' + await waitFor(B, `(function(){var p=[...document.querySelectorAll('#msgs .f-pct')];return p.length&&p[p.length-1].textContent.trim()==='100%'?'100%':null})()`, '大文件传输完成', 120000);
  });
  await T('C 离开后 A / B 各剩 2 人', async () => {
    await C.ev(`document.querySelector('#leaveBtn').click();'ok'`);
    await waitFor(A, `document.querySelectorAll('#users .user').length===2`, 'A 剩 2 人', 25000);
    await waitFor(B, `document.querySelectorAll('#users .user').length===2`, 'B 剩 2 人', 25000);
  });
  await T('B 离开房间，A 侧成员减 1', async () => {
    await B.ev(`document.querySelector('#leaveBtn').click();'ok'`);
    await waitFor(A, `document.querySelectorAll('#users .user').length===1`, 'A 侧剩 1 人', 25000);
  });
  await T('离开后 A 仍可正常使用', async () => {
    return '状态=' + await A.ev(`document.querySelector('#status .txt').textContent`);
  });

  proc.kill(); server.close();
  const fail = results.filter(r => !r.ok);
  console.log('\n==== ' + (results.length - fail.length) + '/' + results.length + ' 通过 ====');
  fail.forEach(f => console.log('  FAIL ' + f.name + ' — ' + f.err));
  process.exit(fail.length ? 1 : 0);
})().catch(e => { console.log('运行异常: ' + e.message); process.exit(2); });
