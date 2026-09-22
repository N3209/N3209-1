'use strict';

/*
 * アプリ本体をキャッシュして、サーバーが無くても起動できるようにする。
 *
 * 法令そのものはここでは扱わない。取り込んだ法令は IndexedDB にあるので、
 * すでにオフラインで読める。ここで面倒を見るのは「アプリの殻」だけである。
 *
 * e-Gov API への通信には一切触らない。キャッシュすると、取り込んだつもりで
 * 古い条文が返る事故が起きる。法令の鮮度はアプリ側が責任を持つ。
 *
 * 更新の罠について。Service Worker は「キャッシュから返す」のが仕事なので、
 * 何もしないとアプリを直しても古いままになる。そこで
 *   ・キャッシュ名に版を持たせ、有効化のときに古い版を捨てる
 *   ・新しい版が待機に入ったらページへ知らせ、利用者が選んで切り替える
 * という形にしてある。勝手に切り替えると、書きかけのメモを抱えたまま
 * 読み込み直すことになるため、断りなしには行わない。
 */

const VERSION = 'v2';
const CACHE = 'roppo-shell-' + VERSION;

// 殻を構成するファイル。法令データは含めない。
const SHELL = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/favicon-32.png',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 1つでも失敗すると全部入らない addAll は使わない。
    // 取りこぼしがあっても、残りはキャッシュできた方がよい。
    await Promise.all(SHELL.map(async url => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res.ok) await cache.put(url, res);
      } catch (err) {
        console.warn('キャッシュできませんでした', url, err);
      }
    }));
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('roppo-shell-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => {
  // ページから「切り替えてよい」と言われたときだけ待機を解く
  if (e.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // e-Gov API には触らない

  // 画面遷移。オフラインでも殻を返す。
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        return await fetch(req);
      } catch (err) {
        const cache = await caches.open(CACHE);
        return (await cache.match('./index.html')) || (await cache.match('./'))
          || new Response('オフラインです', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  // 殻のファイル。まずキャッシュを返し、裏で新しいものを取ってくる。
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    const fresh = fetch(req).then(res => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    return hit || (await fresh) || new Response('', { status: 504 });
  })());
});
