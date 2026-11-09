// 학부모 메시지 유형을 낱말로 나누고, 유형별 답장 틀에 채워 답장 초안을 만든다. (AI 없이 동작)
// 틀 안에서 쓸 수 있는 자리표시: {이름} 아이 이름(성 뺌), {이름이} 수완이/지아, {이가} 수완이가/지아가,
// {이를} 수완이를/지아를, {이에게} 수완이에게/지아에게, {호칭} 학부모님 등

export const DEFAULT_RULES = [
  {
    id: 'early', label: '조퇴',
    words: ['조퇴', '일찍 하교', '일찍 데려', '먼저 데려', '데리러 가', '급식 먹고 가', '급식먹고', '점심 먹고 가', '중간에 하교'],
    reply: '안녕하세요, {호칭}~ 알려 주셔서 감사합니다. {이가} 시간 맞춰 나갈 수 있도록 잘 챙기겠습니다. 오늘도 평안한 하루 되세요! 🌷',
  },
  {
    id: 'late', label: '지각',
    words: ['지각', '늦을', '늦게', '늦어요', '늦습니다', '늦었', '늦잠', '조금 늦'],
    reply: '안녕하세요, {호칭}~ 미리 연락 주셔서 감사합니다. {이에게} 천천히 조심히 오라고 전해 주세요. 오늘도 평안한 하루 되세요! 🌷',
  },
  {
    id: 'absent', label: '결석·아픔',
    words: ['결석', '아파', '아프', '열이', '열나', '고열', '병원', '감기', '독감', '장염', '코로나', '구토', '배탈', '수족구', '요양', '쉬게', '쉬려'],
    reply: '안녕하세요, {호칭}~ 알려 주셔서 감사합니다. {이가} 얼른 나아서 건강한 모습으로 만나면 좋겠어요. 등교할 때 진료확인서 같은 증빙 서류를 보내 주시면 잘 처리하겠습니다. 푹 쉬게 해 주세요! 🌷',
    replyIfDocs: '안녕하세요, {호칭}~ 알려 주셔서 감사합니다. 보내 주신 서류도 잘 확인하겠습니다. {이가} 얼른 나아서 건강한 모습으로 만나면 좋겠어요. 푹 쉬게 해 주세요! 🌷',
  },
  {
    id: 'trip', label: '체험학습',
    words: ['체험학습', '현장체험', '가정학습', '교외체험'],
    reply: '안녕하세요, {호칭}~ 체험학습 내용 확인했습니다. 즐겁고 안전한 시간 보내고 오길 바랍니다. 다녀와서 결과보고서도 잊지 말고 보내 주세요. 오늘도 평안한 하루 되세요! 🌷',
  },
  {
    id: 'meds', label: '약',
    words: ['약을', '약 먹', '약먹', '복용', '투약'],
    reply: '안녕하세요, {호칭}~ 말씀해 주셔서 감사합니다. {이가} 시간 맞춰 약을 먹을 수 있도록 잘 챙기겠습니다. 오늘도 평안한 하루 되세요! 🌷',
  },
  {
    id: 'consult', label: '상담·통화',
    words: ['상담', '통화', '전화', '여쭤', '여쭙', '말씀드리고 싶', '드릴 말씀', '시간 되실', '시간 괜찮'],
    reply: '안녕하세요, {호칭}~ 연락 주셔서 감사합니다. 편하신 날짜와 시간을 알려 주시면 그때 연락드리겠습니다. 오늘도 평안한 하루 되세요! 🌷',
  },
  {
    id: 'homegoing', label: '하교·방과후',
    words: ['하교', '방과후', '돌봄', '학원', '늘봄', '집에 갈', '집에 보내'],
    reply: '안녕하세요, {호칭}~ 하교 관련 내용 잘 확인했습니다. {이에게}도 잘 전달하고 챙기겠습니다. 오늘도 평안한 하루 되세요! 🌷',
  },
  {
    id: 'supplies', label: '준비물·서류',
    words: ['준비물', '챙겨', '가져가', '보내드', '보내 드', '제출', '신청서', '동의서', '안내문', '가정통신문'],
    reply: '안녕하세요, {호칭}~ 말씀 잘 확인했습니다. 학교에서도 잘 챙기겠습니다. 오늘도 평안한 하루 되세요! 🌷',
  },
  {
    id: 'thanks', label: '감사 인사',
    words: ['감사', '고맙', '수고하', '덕분'],
    reply: '{호칭}, 따뜻한 말씀 감사합니다~ 저도 {이가} 즐겁게 생활할 수 있도록 늘 잘 챙기겠습니다. 오늘도 평안한 하루 되세요! 🌷',
  },
];

export const DEFAULT_FALLBACK = '안녕하세요, {호칭}~ 말씀 잘 확인했습니다. 학교에서도 {이를} 잘 챙기겠습니다. 오늘도 평안한 하루 되세요! 🌷';

// 받침 여부
function hasBatchim(word) {
  const c = word.charCodeAt(word.length - 1);
  if (c < 0xac00 || c > 0xd7a3) return false;
  return (c - 0xac00) % 28 !== 0;
}

// "장수완 학부모(장수완)" → 아이 이름 정보
export function parseRoom(room) {
  const m = String(room || '').match(/^(.+?)\s*(학부모|학생)/);
  const full = (m ? m[1] : String(room || '').split(/[\s(]/)[0]).trim();
  const isParent = m ? m[2] === '학부모' : true;
  let given = full;
  if (/^[가-힣]{3}$/.test(full)) given = full.slice(1); // 3글자는 성을 뺌
  else if (/^[가-힣]{2}$/.test(full)) given = full; // 2글자는 그대로
  const nick = (String(room || '').match(/\(([^)]*)\)\s*$/) || [, ''])[1];
  return { full, given, isParent, nick };
}

export function makeDraft(room, msg, opts = {}) {
  const rules = opts.rules || DEFAULT_RULES;
  const fallback = opts.fallback || DEFAULT_FALLBACK;
  const { given, isParent, nick } = parseRoom(room);
  let title = opts.title || '학부모님';
  if (opts.autoTitle === true && /아빠|아버|대디|dad|papa/i.test(nick)) title = '아버님';
  if (!isParent) title = given; // 학생이 보낸 경우 아이 이름으로 부름

  const b = hasBatchim(given);
  const nameI = b ? given + '이' : given; // 수완이 / 지아
  const fill = (t) => t
    .replaceAll('{이가}', nameI + '가')
    .replaceAll('{이를}', nameI + '를')
    .replaceAll('{이에게}', nameI + '에게')
    .replaceAll('{이름이}', nameI)
    .replaceAll('{이름}', given)
    .replaceAll('{호칭}', title);

  const text = String(msg || '').replace(/\s+/g, ' ');
  for (const r of rules) {
    if (r.words.some((w) => w && text.includes(w))) {
      if (r.replyIfDocs && /(서류|확인서|소견서|진단서).*(보냈|보내 드렸|보내드렸|제출|올렸)/.test(text)) {
        return { label: r.label, draft: fill(r.replyIfDocs) };
      }
      return { label: r.label, draft: fill(r.reply) };
    }
  }
  return { label: '일반', draft: fill(fallback) };
}

// ===== 예전 답장에서 배우기 =====
// 선생님이 하이톡에 실제로 보냈던 답장을 모아 두고, 비슷한 메시지가 오면 그 답장을 이름만 바꿔 다시 씀
function bigrams(t) {
  const c = String(t || '').replace(/[^가-힣a-zA-Z0-9]/g, '');
  const set = new Set();
  for (let i = 0; i < c.length - 1; i++) set.add(c.slice(i, i + 2));
  return set;
}
function similarity(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / Math.min(A.size, B.size);
}
export function labelOf(msg, rules = DEFAULT_RULES) {
  const text = String(msg || '').replace(/\s+/g, ' ');
  for (const r of rules) if (r.words.some((w) => w && text.includes(w))) return r.label;
  return '일반';
}
function rename(reply, fromGiven, toGiven, title) {
  let out = reply;
  if (fromGiven && toGiven && fromGiven !== toGiven) {
    const nameI = (g) => (hasBatchim(g) ? g + '이' : g);
    out = out.split(nameI(fromGiven)).join(nameI(toGiven)).split(fromGiven).join(toGiven);
  }
  if (title) out = out.replace(/어머님|아버님|어머니|아버지|학부모님/g, title);
  return out;
}
export function draftFromExamples(room, msg, examples, opts = {}) {
  if (!examples || !examples.length) return null;
  const label = labelOf(msg, opts.rules || DEFAULT_RULES);
  let best = null;
  for (const ex of examples) {
    let sc = similarity(msg, ex.msg);
    if (label !== '일반' && ex.label === label) sc += 0.25;
    else if (label !== '일반' && ex.label !== label) sc -= 0.3;
    if (!best || sc > best.sc) best = { sc, ex };
  }
  if (!best || best.sc < 0.45) return null;
  const { given } = parseRoom(room);
  return { label: label + ' · 예전 답장', draft: rename(best.ex.reply, best.ex.given, given, opts.title || '학부모님') };
}
