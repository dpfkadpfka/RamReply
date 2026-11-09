// 숨은 하이톡 창 안에서 실행되는 코드 (main.js가 executeJavaScript로 넣음)
// window.__ht.scan() / send(room, text) / learn(max) 를 제공한다.
(() => {
  if (window.__ht) return;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let busy = false;
  const btnByText = (t) => [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === t);

  function roomItems() {
    return [...document.querySelectorAll('li')].map((li) => {
      const nameEl = li.querySelector('span.block, span.text-ellipsis');
      const prevEl = li.querySelector('p');
      if (!nameEl || !prevEl) return null;
      const badge = li.querySelector(':scope > span.absolute');
      const badgeText = badge ? badge.textContent.trim() : '';
      const unread = !!badge && (badgeText !== '' || badge.children.length > 0 || badge.getBoundingClientRect().width > 0);
      return { li, room: nameEl.textContent.trim(), preview: prevEl.textContent.trim(), unread, count: parseInt(badgeText, 10) || (unread ? 1 : 0) };
    }).filter((x) => x && x.room);
  }
  async function showList() {
    const b = btnByText('대화목록');
    if (b) b.click();
    await sleep(1500);
  }
  function loggedOut() {
    return /login|signin/i.test(location.href) || (!btnByText('대화목록') && /로그인/.test(document.body.innerText));
  }

  async function scan() {
    if (busy) return { busy: true };
    if (loggedOut()) return { login: true };
    if (!btnByText('대화목록') && !btnByText('대화상대')) return { notReady: true };
    busy = true;
    try {
      const c = btnByText('대화상대');
      if (c) { c.click(); await sleep(800); }
      await showList();
      const items = roomItems();
      return { rooms: items.map(({ room, preview, unread, count }) => ({ room, preview, unread, count })) };
    } finally { busy = false; }
  }

  async function send(room, text) {
    while (busy) await sleep(300);
    busy = true;
    try {
      await showList();
      const it = roomItems().find((x) => x.room === room);
      if (!it) return { ok: false, note: '대화방을 찾지 못함' };
      it.li.click();
      let ed = null;
      for (let i = 0; i < 20 && !ed; i++) { await sleep(300); ed = document.querySelector('[contenteditable="true"]'); }
      if (!ed) return { ok: false, note: '입력창을 찾지 못함' };
      ed.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      text.split('\n').forEach((ln, i) => {
        if (i) document.execCommand('insertLineBreak');
        if (ln) document.execCommand('insertText', false, ln);
      });
      ed.dispatchEvent(new InputEvent('input', { bubbles: true }));
      let b = null;
      for (let i = 0; i < 15; i++) { await sleep(200); b = btnByText('보내기'); if (b && !b.disabled) break; }
      if (!b || b.disabled) return { ok: false, note: '보내기 버튼이 눌리지 않음' };
      b.click();
      for (let i = 0; i < 15; i++) {
        await sleep(300);
        if (!ed.textContent.trim()) { await sleep(500); await showList(); return { ok: true }; }
      }
      return { ok: false, note: '전송 확인 실패' };
    } catch (e) { return { ok: false, note: String(e) }; }
    finally { busy = false; }
  }

  function readBubbles() {
    return [...document.querySelectorAll('div.whitespace-pre-wrap')]
      .map((b) => ({ me: !!b.closest('.justify-end'), text: b.innerText.trim() }))
      .filter((x) => x.text && x.text !== '삭제된 메시지입니다.');
  }
  function pairsFrom(bs) {
    const out = []; let i = 0;
    while (i < bs.length) {
      const q = []; while (i < bs.length && !bs[i].me) q.push(bs[i++].text);
      const a = []; while (i < bs.length && bs[i].me) a.push(bs[i++].text);
      if (q.length && a.length) out.push({ msg: q.join('\n'), reply: a.join('\n') });
    }
    return out;
  }
  async function learn(max = 60) {
    while (busy) await sleep(300);
    busy = true;
    const result = [];
    try {
      await showList();
      const rooms = roomItems().filter((x) => !x.unread && /학부모/.test(x.room)).slice(0, max);
      for (const r of rooms) {
        const it = roomItems().find((x) => x.room === r.room);
        if (!it) continue;
        it.li.click();
        await sleep(1800);
        const pairs = pairsFrom(readBubbles());
        if (pairs.length) result.push({ room: r.room, pairs });
        await showList();
      }
    } finally { busy = false; }
    return result;
  }

  window.__ht = { scan, send, learn };
})();
true;
