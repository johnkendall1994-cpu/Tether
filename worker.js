// Tether notification server (Cloudflare Worker)
// Needs one KV namespace binding with the variable name: TETHER_KV
// No other setup: the push keys are created automatically the first time it runs.

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

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (!env.TETHER_KV) return json({ ok: false, reason: 'KV binding TETHER_KV is missing' }, 500);
    const url = new URL(req.url), path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (path === '/') return json({ ok: true, app: 'tether' });

      if (path === '/vapid') return json({ key: (await vapid(env)).pub });

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
