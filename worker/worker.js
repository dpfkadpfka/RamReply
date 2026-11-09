// 학부모톡 도우미 — 중계 서버 (Cloudflare Worker + D1)
// 확장 프로그램이 올린 "답장 대기" 건을 보관하고, 휴대폰에서 누른 [보내기] 신호를 확장 프로그램에 전달한다.
// 처리가 끝난 건은 메시지 내용을 지우고, 2일이 지난 건은 통째로 지운다.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, secret TEXT NOT NULL, created INTEGER)`,
  `CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, token TEXT NOT NULL, device TEXT NOT NULL,
     room TEXT, msg TEXT, draft TEXT, final TEXT, status TEXT NOT NULL, note TEXT,
     created INTEGER, updated INTEGER)`,
  `CREATE INDEX IF NOT EXISTS items_dev ON items (device, status)`,
  `CREATE TABLE IF NOT EXISTS errlog (t INTEGER, device TEXT, msg TEXT)`,
  `CREATE TABLE IF NOT EXISTS kakao (device TEXT PRIMARY KEY, access TEXT, refresh TEXT, exp INTEGER, nonce TEXT, nonce_exp INTEGER)`,
];

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  for (const s of SCHEMA) await env.DB.prepare(s).run();
  schemaReady = true;
}

const rid = (n = 16) => {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
};
const now = () => Date.now();

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Device,X-Secret',
};
const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });

async function auth(req, env) {
  const id = req.headers.get('X-Device');
  const secret = req.headers.get('X-Secret');
  if (!id || !secret) return null;
  const row = await env.DB.prepare('SELECT id FROM devices WHERE id=? AND secret=?').bind(id, secret).first();
  return row ? id : null;
}

async function cleanup(env) {
  const t = now();
  // 끝난 건(보냄/안 보냄)은 1시간 뒤 내용 삭제, 모든 건은 2일 뒤 삭제
  await env.DB.prepare(
    `UPDATE items SET msg='', draft='', final='' WHERE status IN ('sent','rejected','failed') AND updated < ?`
  ).bind(t - 3600e3).run();
  await env.DB.prepare(`DELETE FROM items WHERE created < ?`).bind(t - 2 * 86400e3).run();
}

// ---- 카카오 (토큰은 서버에만 보관, 클라이언트 시크릿은 Worker 비밀값) ----
async function kakaoTokenReq(env, params) {
  const body = new URLSearchParams({ client_id: env.KAKAO_KEY, client_secret: env.KAKAO_SECRET, ...params });
  const r = await fetch('https://kauth.kakao.com/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' }, body,
  });
  return r.json();
}
async function kakaoAccess(env, dev) {
  const k = await env.DB.prepare('SELECT * FROM kakao WHERE device=?').bind(dev).first();
  if (!k || !k.refresh) return null;
  if (k.access && k.exp > now() + 60e3) return k.access;
  const j = await kakaoTokenReq(env, { grant_type: 'refresh_token', refresh_token: k.refresh });
  if (!j.access_token) { await env.DB.prepare('INSERT INTO errlog VALUES (?,?,?)').bind(now(), dev, 'refresh ' + JSON.stringify(j).slice(0, 300)).run(); await env.DB.prepare('UPDATE kakao SET access=NULL, refresh=NULL WHERE device=?').bind(dev).run(); return null; }
  await env.DB.prepare('UPDATE kakao SET access=?, refresh=COALESCE(?, refresh), exp=? WHERE device=?')
    .bind(j.access_token, j.refresh_token || null, now() + j.expires_in * 1000, dev).run();
  return j.access_token;
}
async function kakaoMemo(env, dev, text, link) {
  const token = await kakaoAccess(env, dev);
  if (!token) return false;
  const tpl = { object_type: 'text', text: text.length > 200 ? text.slice(0, 199) + '…' : text,
    link: { web_url: link, mobile_web_url: link } };
  if (link.includes('/a/')) {
    const go = link + '&go=send';
    tpl.buttons = [
      { title: '이대로 보내기', link: { web_url: go, mobile_web_url: go } },
      { title: '고쳐서 보내기', link: { web_url: link, mobile_web_url: link } },
    ];
  } else tpl.button_title = '열어 보기';
  const r = await fetch('https://kapi.kakao.com/v2/api/talk/memo/default/send', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: new URLSearchParams({ template_object: JSON.stringify(tpl) }),
  });
  if (!r.ok) {
    const t = (await r.text()).slice(0, 300);
    await env.DB.prepare('INSERT INTO errlog VALUES (?,?,?)').bind(now(), dev, 'memo ' + r.status + ' ' + t).run();
  }
  return r.ok;
}

export default {
  async fetch(req, env, ctx) {
    await ensureSchema(env);
    const url = new URL(req.url);
    const p = url.pathname;
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    // ---- 확장 프로그램용 API ----
    if (p === '/api/register' && req.method === 'POST') {
      const id = rid(12), secret = rid(24);
      await env.DB.prepare('INSERT INTO devices VALUES (?,?,?)').bind(id, secret, now()).run();
      return json({ device: id, secret });
    }

    if (p === '/kakao/cb') {
      const code = url.searchParams.get('code');
      const st = url.searchParams.get('state') || '';
      const k = await env.DB.prepare('SELECT * FROM kakao WHERE nonce=? AND nonce_exp > ?').bind(st, now()).first();
      if (!code || !k) return page('연결 실패', `<div class="state"><div class="ic">⚠️</div><h2>카카오 연결에 실패했어요</h2><p class="muted">확장 프로그램 설정에서 [카카오 연결]을 다시 눌러 주세요.</p></div>`);
      const j = await kakaoTokenReq(env, { grant_type: 'authorization_code', code, redirect_uri: url.origin + '/kakao/cb' });
      if (!j.access_token) return page('연결 실패', `<div class="state"><div class="ic">⚠️</div><h2>카카오 연결에 실패했어요</h2><p class="muted">${esc(j.error_description || '')}</p></div>`);
      await env.DB.prepare('UPDATE kakao SET access=?, refresh=?, exp=?, nonce=NULL WHERE device=?')
        .bind(j.access_token, j.refresh_token, now() + j.expires_in * 1000, k.device).run();
      ctx.waitUntil(kakaoMemo(env, k.device, '✅ 학부모톡 도우미가 연결됐어요.\n하이톡에 학부모 메시지가 오면 여기로 알려 드릴게요.', url.origin));
      return page('연결 완료', `<div class="state"><div class="ic">✅</div><h2>카카오톡 연결 완료</h2><p class="muted">카카오톡 '나와의 채팅'에 연결 메시지를 보냈어요. 이 창은 닫아도 돼요.</p></div>`);
    }

    if (p.startsWith('/api/')) {
      const dev = await auth(req, env);
      if (!dev) return json({ error: 'unauthorized' }, 401);

      if (p === '/api/kakao/link' && req.method === 'POST') {
        const nonce = rid(16);
        await env.DB.prepare(`INSERT INTO kakao (device, nonce, nonce_exp) VALUES (?,?,?)
          ON CONFLICT(device) DO UPDATE SET nonce=excluded.nonce, nonce_exp=excluded.nonce_exp`).bind(dev, nonce, now() + 600e3).run();
        const u = `https://kauth.kakao.com/oauth/authorize?client_id=${env.KAKAO_KEY}&redirect_uri=${encodeURIComponent(url.origin + '/kakao/cb')}&response_type=code&scope=talk_message&state=${nonce}`;
        return json({ url: u });
      }
      if (p === '/api/kakao/unlink' && req.method === 'POST') {
        await env.DB.prepare('DELETE FROM kakao WHERE device=?').bind(dev).run();
        return json({ ok: true });
      }
      if (p === '/api/status' && req.method === 'GET') {
        const k = await env.DB.prepare('SELECT refresh FROM kakao WHERE device=?').bind(dev).first();
        return json({ kakao: !!(k && k.refresh) });
      }

      if (p === '/api/items' && req.method === 'POST') {
        const b = await req.json();
        const id = rid(8), token = rid(16);
        await env.DB.prepare(
          `INSERT INTO items (id,token,device,room,msg,draft,final,status,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).bind(id, token, dev, String(b.room || '').slice(0, 100), String(b.msg || '').slice(0, 3000),
               String(b.draft || '').slice(0, 3000), '', 'pending', now(), now()).run();
        ctx.waitUntil(cleanup(env));
        const link = `${url.origin}/a/${id}?t=${token}`;
        let kakao = false;
        if (b.notify) kakao = await kakaoMemo(env, dev, String(b.notify), link);
        return json({ id, url: link, kakao });
      }

      if (p === '/api/poll' && req.method === 'GET') {
        const { results } = await env.DB.prepare(
          `SELECT id, room, final FROM items WHERE device=? AND status='approved' ORDER BY updated`
        ).bind(dev).all();
        if (results.length) {
          await env.DB.prepare(`UPDATE items SET status='sending', updated=? WHERE device=? AND status='approved'`)
            .bind(now(), dev).run();
        }
        // 'sending'에서 3분 넘게 멈춘 건은 다시 시도하도록 되돌림
        await env.DB.prepare(`UPDATE items SET status='approved' WHERE device=? AND status='sending' AND updated < ?`)
          .bind(dev, now() - 180e3).run();
        return json({ items: results });
      }

      if (p === '/api/done' && req.method === 'POST') {
        const b = await req.json();
        await env.DB.prepare(`UPDATE items SET status=?, note=?, updated=? WHERE id=? AND device=?`)
          .bind(b.ok ? 'sent' : 'failed', String(b.note || '').slice(0, 200), now(), b.id, dev).run();
        return json({ ok: true });
      }

      // PC 알림에서 바로 처리한 경우 상태 기록
      if (p === '/api/local' && req.method === 'POST') {
        const b = await req.json();
        const st = ['approved', 'rejected', 'sent', 'failed'].includes(b.status) ? b.status : 'rejected';
        await env.DB.prepare(`UPDATE items SET status=?, final=COALESCE(?, final), updated=? WHERE id=? AND device=? AND status='pending'`)
          .bind(st, b.final ?? null, now(), b.id, dev).run();
        return json({ ok: true });
      }
      return json({ error: 'not found' }, 404);
    }

    // ---- 휴대폰에서 여는 확인 페이지 ----
    const m = p.match(/^\/a\/([0-9a-f]{16})$/);
    if (m) {
      const t = url.searchParams.get('t') || '';
      const item = await env.DB.prepare('SELECT * FROM items WHERE id=? AND token=?').bind(m[1], t).first();
      if (!item) return page('찾을 수 없어요', `<p class="muted">링크가 만료되었거나 잘못되었어요.</p>`);

      if (req.method === 'POST') {
        const f = await req.formData();
        const action = f.get('action');
        if (item.status === 'pending') {
          if (action === 'send') {
            const text = String(f.get('text') || '').trim();
            if (text) {
              await env.DB.prepare(`UPDATE items SET status='approved', final=?, updated=? WHERE id=?`)
                .bind(text.slice(0, 3000), now(), item.id).run();
            }
          } else if (action === 'reject') {
            await env.DB.prepare(`UPDATE items SET status='rejected', updated=? WHERE id=?`).bind(now(), item.id).run();
          }
        }
        return Response.redirect(`${url.origin}/a/${item.id}?t=${t}`, 303);
      }
      // 카톡의 [이대로 보내기]: 한 번 누르면 바로 승인
      if (url.searchParams.get('go') === 'send' && item.status === 'pending' && item.draft) {
        await env.DB.prepare(`UPDATE items SET status='approved', final=draft, updated=? WHERE id=? AND status='pending'`)
          .bind(now(), item.id).run();
        item.status = 'approved'; item.final = item.draft;
      }
      return renderItem(item, url);
    }

    if (p === '/') return page('학부모톡 도우미', `<p class="muted">학부모톡 도우미 중계 서버가 동작 중이에요.</p>`);
    return new Response('not found', { status: 404 });
  },
};

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderItem(it, url) {
  const states = {
    approved: ['⏳', '보내는 중이에요', '학교 컴퓨터가 30초 안에 하이톡으로 보내요. 이 창은 바로 닫아도 돼요.'],
    sending: ['⏳', '보내는 중이에요', '학교 컴퓨터가 하이톡으로 보내고 있어요.'],
    sent: ['✅', '보냈어요', '하이톡으로 답장을 보냈어요.'],
    rejected: ['🚫', '보내지 않았어요', '이 메시지에는 답장을 보내지 않기로 했어요.'],
    failed: ['⚠️', '보내지 못했어요', '학교 컴퓨터에서 하이톡 전송에 실패했어요. 하이톡 앱에서 직접 보내 주세요.'],
  };
  if (it.status !== 'pending') {
    const [ic, t, d] = states[it.status] || states.failed;
    const refresh = ['approved', 'sending'].includes(it.status) ? '<meta http-equiv="refresh" content="5">' : '';
    return page(t, `<div class="state"><div class="ic">${ic}</div><h2>${t}</h2><p class="muted">${d}</p></div>
      ${it.final ? `<div class="label">보낸 답장</div><div class="bubble me">${esc(it.final)}</div>` : ''}`, refresh);
  }
  return page('답장 확인', `
    <div class="label">${esc(it.room)}</div>
    <div class="bubble">${esc(it.msg)}</div>
    <form method="post">
      <div class="label">이렇게 답장할까요? <span class="muted">(눌러서 고칠 수 있어요)</span></div>
      <textarea name="text" rows="7">${esc(it.draft)}</textarea>
      <button class="primary" name="action" value="send">하이톡으로 보내기</button>
      <button class="ghost" name="action" value="reject" onclick="return confirm('이 메시지에는 답장하지 않을까요?')">안 보내기</button>
    </form>`);
}

function page(title, body, head = '') {
  return new Response(`<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">${head}<title>${esc(title)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css">
<style>
*{box-sizing:border-box}body{margin:0;font-family:Pretendard,-apple-system,sans-serif;background:#f3f6fa;color:#1d2433}
.wrap{max-width:520px;margin:0 auto;padding:20px 16px 40px}
header{display:flex;align-items:center;gap:8px;font-weight:700;color:#2f6fed;margin-bottom:16px;font-size:15px}
.dot{width:10px;height:10px;border-radius:50%;background:#2f6fed}
.label{font-size:14px;font-weight:700;margin:18px 0 8px}
.muted{color:#7a8496;font-weight:400}
.bubble{background:#fff;border-radius:4px 18px 18px 18px;padding:14px 16px;line-height:1.6;white-space:pre-wrap;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.bubble.me{background:#e7efff;border-radius:18px 4px 18px 18px}
textarea{width:100%;border:1.5px solid #cfd8e6;border-radius:14px;padding:14px;font:inherit;font-size:16px;line-height:1.6;resize:vertical;background:#fff}
textarea:focus{outline:none;border-color:#2f6fed}
button{width:100%;border:0;border-radius:14px;padding:16px;font:inherit;font-size:17px;font-weight:700;margin-top:10px;cursor:pointer}
.primary{background:#2f6fed;color:#fff}.ghost{background:transparent;color:#7a8496;font-weight:500}
.state{text-align:center;padding:30px 0 10px}.ic{font-size:44px}h2{margin:8px 0}
</style></head><body><div class="wrap"><header><span class="dot"></span>학부모톡 도우미</header>${body}</div></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
