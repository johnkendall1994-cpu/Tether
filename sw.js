// Tether background helper: shows notifications when Tether is closed.
const P = new URL(self.location).searchParams;
const W = (P.get('w') || '').replace(/\/+$/, '');
const C = P.get('c') || '';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  e.waitUntil((async () => {
    let items = [];
    try {
      const r = await fetch(W + '/pending?code=' + encodeURIComponent(C), { cache: 'no-store' });
      items = (await r.json()).items || [];
    } catch (x) {}
    if (!items.length) items = [{ type: 'buzz', name: 'Someone', from: '' }];
    for (const it of items.slice(-5)) {
      const n = it.name || 'Someone';
      let title, body;
      if (it.type === 'msg') { title = n; body = it.text || 'Sent you a message'; }
      else if (it.type === 'missed') { title = 'Missed video call'; body = n + ' tried to video call you'; }
      else { title = n + ' wants to talk'; body = 'Tap to open Tether and connect'; }
      await self.registration.showNotification(title, {
        body,
        tag: 'tether-' + (it.from || 'x') + '-' + it.type + (it.type === 'msg' ? '-' + it.t : ''),
        renotify: true,
        vibrate: [200, 100, 200],
        data: { from: it.from || '' },
      });
    }
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const from = (e.notification.data && e.notification.data.from) || '';
  const url = new URL(self.registration.scope);
  if (from) url.searchParams.set('join', from);
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if (c.url.startsWith(self.registration.scope)) {
        await c.focus();
        if (from) c.postMessage({ join: from });
        return;
      }
    }
    await self.clients.openWindow(url.href);
  })());
});
