'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const log = (...a) => console.log(new Date().toISOString(), ...a);

// Firebase
const FB = {
  apiKey: "AIzaSyAxHXvESxlx4dZHeMqREnzhURxQ2cginIU",
  authDomain: "wanzhi-f1aa8.firebaseapp.com",
  projectId: "wanzhi-f1aa8",
  storageBucket: "wanzhi-f1aa8.firebasestorage.app",
  messagingSenderId: "413457827254",
  appId: "1:413457827254:web:fd8222de89ba8bbf34ed17"
};
let db = null;

async function initFB() {
  try {
    const { initializeApp } = require('firebase/app');
    const { getFirestore } = require('firebase/firestore');
    initializeApp(FB);
    db = getFirestore();
    log('Firebase ready');
  } catch (e) { log('Firebase fail', e.message); }
}
initFB();

function hash(s) { return crypto.createHash('sha256').update(s || '').digest('hex'); }

async function readBody(req) {
  let b = '';
  for await (const c of req) b += c;
  try { return JSON.parse(b || '{}'); } catch (e) { return {}; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.end();

  // API
  if (url.pathname.startsWith('/api/') && db) {
    res.setHeader('Content-Type', 'application/json');
    const { doc, getDoc, setDoc } = require('firebase/firestore');
    const body = await readBody(req);

    if (url.pathname === '/api/register') {
      if (!body.acc || !body.pw) return res.end(JSON.stringify({ ok: 0, msg: '缺少資料' }));
      const ref = doc(db, 'accounts', body.acc);
      if ((await getDoc(ref)).exists()) return res.end(JSON.stringify({ ok: 0, msg: '帳號已存在' }));
      await setDoc(ref, { pw: hash(body.pw), created: Date.now() });
      return res.end(JSON.stringify({ ok: 1 }));
    }

    if (url.pathname === '/api/login') {
      if (!body.acc || !body.pw) return res.end(JSON.stringify({ ok: 0, msg: '缺少資料' }));
      const ref = doc(db, 'accounts', body.acc);
      const snap = await getDoc(ref);
      if (!snap.exists() || snap.data().pw !== hash(body.pw)) {
        return res.end(JSON.stringify({ ok: 0, msg: '帳號或密碼錯誤' }));
      }
      return res.end(JSON.stringify({ ok: 1, acc: body.acc }));
    }

    if (url.pathname === '/api/save') {
      if (!body.acc) return res.end(JSON.stringify({ ok: 0 }));
      await setDoc(doc(db, 'saves', body.acc), { data: body.data || {}, t: Date.now() });
      return res.end(JSON.stringify({ ok: 1 }));
    }

    if (url.pathname === '/api/load') {
      if (!body.acc) return res.end(JSON.stringify({ ok: 0 }));
      const snap = await getDoc(doc(db, 'saves', body.acc));
      return res.end(JSON.stringify({ ok: 1, data: snap.exists() ? snap.data().data : null }));
    }

    return res.end(JSON.stringify({ ok: 0, msg: 'unknown' }));
  }

  // Static files
  let fp = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.join(__dirname, fp);
  if (fs.existsSync(full) && fs.statSync(full).isFile()) {
    const ext = path.extname(full);
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' }[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(full).pipe(res);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => log('Server on', PORT));
