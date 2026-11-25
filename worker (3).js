// Tether notification server (Cloudflare Worker)
// Needs one KV namespace binding with the variable name: TETHER_KV
// For calls on mobile data (Cloudflare TURN relay), add two variables in Settings:
//   TURN_KEY_ID     (your TURN key's ID)
//   TURN_KEY_TOKEN  (your TURN key's API token, add it as a Secret)
// For cloud voice/video on mobile data, add a Durable Object binding:
//   variable name ROOMS, class Room (from this Worker)
// The push keys are created automatically the first time it runs.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};
const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'content-type': 'application/json' } });
const okCode = c => typeof c === 'string' && /^[a-z0-9]{6}$/.test(c);
const enc = new TextEncoder();
const b64u = buf => {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function vapid(env) {
  let v = await env.TETHER_KV.get('vapid', { type: 'json' });
  if (v) return v;
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = b64u(await crypto.subtle.exportKey('raw', kp.publicKey));
  v = { jwk, pub };
  await env.TETHER_KV.put('vapid', JSON.stringify(v));
  return v;
}

async function sendPush(env, sub) {
  const v = await vapid(env);
  const key = await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const aud = new URL(sub.endpoint).origin;
  const h = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const p = b64u(enc.encode(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:tether-app@example.com',
  })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(h + '.' + p));
  const jwt = h + '.' + p + '.' + b64u(sig);
  // Empty push: the phone then asks this server what the notification says.
  return fetch(sub.endpoint, {
    method: 'POST',
    headers: { TTL: '86400', Urgency: 'high', Authorization: `vapid t=${jwt}, k=${v.pub}` },
    body: '',
  });
}

// Short-lived relay logins from Cloudflare TURN, cached for an hour
async function turnServers(env) {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_TOKEN) return { iceServers: [], relay: false };
  const cached = await env.TETHER_KV.get('turn', { type: 'json' });
  if (cached && cached.exp > Date.now()) return { iceServers: cached.iceServers, relay: true };
  const r = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_KEY_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 86400 }),
    },
  );
  if (!r.ok) return { iceServers: [], relay: false, reason: 'turn-' + r.status };
  const d = await r.json();
  let list = Array.isArray(d.iceServers) ? d.iceServers : d.iceServers ? [d.iceServers] : [];
  // Browsers block port 53, so drop those addresses
  list = list.map(sv => {
    const urls = (Array.isArray(sv.urls) ? sv.urls : [sv.urls]).filter(u => typeof u === 'string' && !/:53(\?|$)/.test(u));
    return { ...sv, urls };
  }).filter(sv => sv.urls.length);
  await env.TETHER_KV.put('turn', JSON.stringify({ iceServers: list, exp: Date.now() + 3600e3 }), { expirationTtl: 3600 });
  return { iceServers: list, relay: true };
}

// Cloud room: relays voice, video and signals between the two phones in a chat
export class Room {
  constructor(ctx, env) { this.ctx = ctx; }
  async fetch(req) {
    const code = new URL(req.url).searchParams.get('code') || '';
    for (const old of this.ctx.getWebSockets(code)) { try { old.close(4000, 'replaced'); } catch (e) {} }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [code]);
    this.presence(null);
    return new Response(null, { status: 101, webSocket: client });
  }
  presence(skip) {
    const all = this.ctx.getWebSockets().filter(w => w !== skip);
    const codes = new Set(all.map(w => this.ctx.getTags(w)[0]));
    const msg = JSON.stringify({ t: 'presence', n: codes.size });
    for (const w of all) { try { w.send(msg); } catch (e) {} }
  }
  async webSocketMessage(ws, msg) {
    const me = this.ctx.getTags(ws)[0];
    for (const w of this.ctx.getWebSockets()) {
      if (w !== ws && this.ctx.getTags(w)[0] !== me) { try { w.send(msg); } catch (e) {} }
    }
  }
  async webSocketClose(ws, code, reason) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch (e) {}
    this.presence(ws);
  }
  async webSocketError(ws) { this.presence(ws); }
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (!env.TETHER_KV) return json({ ok: false, reason: 'KV binding TETHER_KV is missing' }, 500);
    const url = new URL(req.url), path = url.pathname.replace(/\/+$/, '') || '/';

    // Cloud room for a pair of phones (WebSocket)
    if (path === '/room') {
      const code = url.searchParams.get('code'), peer = url.searchParams.get('peer');
      if (!okCode(code) || !okCode(peer) || code === peer) return json({ ok: false, reason: 'bad' }, 400);
      if (req.headers.get('Upgrade') !== 'websocket') return json({ ok: false, reason: 'websocket only' }, 426);
      if (!env.ROOMS) return json({ ok: false, reason: 'Durable Object binding ROOMS is missing' }, 500);
      const key = [code, peer].sort().join(':');
      return env.ROOMS.get(env.ROOMS.idFromName(key)).fetch(req);
    }
    if (path === '/rooms-ready') return json({ ok: !!env.ROOMS });
    try {
      if (path === '/') return json({ ok: true, app: 'tether' });

      if (path === '/vapid') return json({ key: (await vapid(env)).pub });

      if (path === '/turn') return json(await turnServers(env));

      // Chat inbox: read only (no writes), the phone remembers what it has seen
      if (path === '/inbox') {
        const c = url.searchParams.get('code');
        if (!okCode(c)) return json({ items: [] });
        const items = (await env.TETHER_KV.get('inbox:' + c, { type: 'json', cacheTtl: 30 })) || [];
        return json({ items, now: Date.now() });
      }

      if (path === '/pending') {
        const c = url.searchParams.get('code');
        if (!okCode(c)) return json({ items: [] });
        const k = 'pend:' + c;
        const items = (await env.TETHER_KV.get(k, { type: 'json' })) || [];
        if (items.length) await env.TETHER_KV.delete(k);
        return json({ items });
      }

      if (req.method !== 'POST') return json({ ok: false }, 405);

      const b = await req.json().catch(() => ({}));

      // Chat: drop a text, delivery receipt or hello into someone's inbox. One save per item.
      if (path === '/send') {
        const { from, to } = b;
        const type = ['ack', 'hello', 'join'].includes(b.type) ? b.type : 'msg';
        if (!okCode(from) || !okCode(to) || from === to || typeof b.id !== 'string') return json({ ok: false, reason: 'bad' }, 400);
        const item = {
          type, id: b.id.slice(0, 32), from, t: Date.now(),
          name: String(b.name || '').slice(0, 20), color: /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '',
          text: type === 'msg' ? String(b.text || '').slice(0, 1000) : '',
          ref: type !== 'msg' ? String(b.ref || '').slice(0, 32) : '',
        };
        const k = 'inbox:' + to;
        const items = (await env.TETHER_KV.get(k, { type: 'json' })) || [];
        items.push(item);
        await env.TETHER_KV.put(k, JSON.stringify(items.slice(-60)), { expirationTtl: 3 * 86400 });
        return json({ ok: true, t: item.t });
      }

      if (path === '/subscribe') {
        if (!okCode(b.code) || !b.sub || typeof b.sub.endpoint !== 'string' || !b.sub.endpoint.startsWith('https://'))
          return json({ ok: false, reason: 'bad' }, 400);
        await env.TETHER_KV.put('sub:' + b.code, JSON.stringify({ endpoint: b.sub.endpoint }));
        return json({ ok: true });
      }

      if (path === '/unsubscribe') {
        if (okCode(b.code)) await env.TETHER_KV.delete('sub:' + b.code);
        return json({ ok: true });
      }

      if (path === '/notify') {
        const { from, to } = b;
        const type = ['buzz', 'missed', 'msg'].includes(b.type) ? b.type : 'buzz';
        if (!okCode(from) || !okCode(to) || from === to) return json({ ok: false, reason: 'bad' }, 400);
        const sub = await env.TETHER_KV.get('sub:' + to, { type: 'json' });
        if (!sub) return json({ ok: false, reason: 'no-sub' });

        // Anti-spam: at most 8 notifications per minute from one person to another
        const rk = 'rl:' + from + ':' + to;
        const n = parseInt((await env.TETHER_KV.get(rk)) || '0', 10);
        if (n >= 8) return json({ ok: false, reason: 'rate' });
        await env.TETHER_KV.put(rk, String(n + 1), { expirationTtl: 60 });

        const item = {
          type, from, name: String(b.name || 'Someone').slice(0, 20),
          text: type === 'msg' ? String(b.text || '').slice(0, 300) : '', t: Date.now(),
        };
        const pk = 'pend:' + to;
        const items = (await env.TETHER_KV.get(pk, { type: 'json' })) || [];
        items.push(item);
        await env.TETHER_KV.put(pk, JSON.stringify(items.slice(-20)), { expirationTtl: 86400 });

        const r = await sendPush(env, sub);
        if (r.status === 404 || r.status === 410) {
          await env.TETHER_KV.delete('sub:' + to);
          return json({ ok: false, reason: 'no-sub' });
        }
        return json({ ok: r.ok, reason: r.ok ? '' : 'push-' + r.status });
      }

      return json({ ok: false }, 404);
    } catch (e) {
      return json({ ok: false, reason: String((e && e.message) || e) }, 500);
    }
  },
};
