/**
 * Cloudflare Worker — MATEat 레시피 제출 페이지용 서버
 *   GET  /post?url=<네이버 블로그 글 URL>  → 글 HTML (PostView 화면)
 *   POST /extract {prompt}                 → 레시피 추출 결과 JSON (OpenAI 호환 API 사용)
 * 두 요청 모두 X-Passcode 헤더가 PASSCODE 비밀값과 같아야 합니다.
 * 비밀값: PASSCODE, ANSWER_API_BASE_URL, ANSWER_API_KEY, ANSWER_API_MODEL / 변수: ALLOWED_ORIGIN
 */

const AGENT = 'MATEatRecipeSource/1.0';
const MAX_PROMPT = 400_000;

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(request.url);
    if (!env.PASSCODE || request.headers.get('X-Passcode') !== env.PASSCODE) {
      return json(401, { error: '팀 암호가 맞지 않습니다.' }, cors);
    }
    try {
      if (request.method === 'GET' && url.pathname === '/post') return await post(url.searchParams.get('url') || '', cors);
      if (request.method === 'POST' && url.pathname === '/extract') return await extract(request, env, cors);
    } catch (e) {
      return json(502, { error: String(e && e.message || e) }, cors);
    }
    return json(404, { error: 'GET /post?url= 또는 POST /extract만 지원합니다.' }, cors);
  },
};

/* 네이버 블로그 글 주소를 본문이 들어 있는 PostView 주소로 바꿉니다. */
function postViewUrl(raw) {
  let u;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (!['blog.naver.com', 'm.blog.naver.com'].includes(u.hostname)) return null;
  let id, no;
  const direct = u.pathname.match(/^\/([A-Za-z0-9_.-]+)\/(\d+)\/?$/);
  if (direct) [, id, no] = direct;
  else if (u.pathname.toLowerCase() === '/postview.naver') { id = u.searchParams.get('blogId'); no = u.searchParams.get('logNo'); }
  if (!id || !no || !/^[A-Za-z0-9_.-]{1,80}$/.test(id) || !/^\d{1,20}$/.test(no)) return null;
  return `https://blog.naver.com/PostView.naver?blogId=${id}&logNo=${no}`;
}

async function post(raw, cors) {
  const target = postViewUrl(raw);
  if (!target) return json(400, { error: '글 번호가 있는 네이버 블로그 글 주소를 넣어 주세요.' }, cors);
  const res = await fetch(target, { headers: { 'User-Agent': AGENT, Accept: 'text/html' }, redirect: 'follow' });
  if (!res.ok) return json(502, { error: `네이버가 글을 돌려주지 않았습니다 (HTTP ${res.status}).` }, cors);
  const html = await res.text();
  if (html.length > 5_000_000) return json(502, { error: '글 화면이 너무 큽니다.' }, cors);
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...cors } });
}

async function extract(request, env, cors) {
  const body = await request.json().catch(() => null);
  const prompt = body && typeof body.prompt === 'string' ? body.prompt : '';
  if (!prompt || prompt.length > MAX_PROMPT) return json(400, { error: '추출할 내용이 비었거나 너무 깁니다.' }, cors);
  // 레시피 하나를 쓰는 데 100초가 넘게 걸려, 한 번에 받으면 API 앞단(Cloudflare)이 HTTP 524로 끊습니다.
  // 그래서 stream으로 받아 글자가 나오는 대로 페이지에 흘려보냅니다. 끝에는 \u0000 뒤에 finish_reason을 붙입니다.
  const res = await fetch(`${env.ANSWER_API_BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.ANSWER_API_KEY}` },
    body: JSON.stringify({ model: env.ANSWER_API_MODEL, temperature: 0, stream: true, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok || !res.body) return json(502, { error: `추출 API 요청이 실패했습니다 (HTTP ${res.status}).` }, cors);
  const { readable, writable } = new TransformStream();
  relay(res.body, writable.getWriter());
  return new Response(readable, { headers: { 'Content-Type': 'text/plain; charset=utf-8', ...cors } });
}

async function relay(body, writer) {
  const reader = body.getReader(), dec = new TextDecoder(), enc = new TextEncoder();
  let buf = '', finish = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:') || line === 'data: [DONE]') continue;
        let choice;
        try { choice = JSON.parse(line.slice(5)).choices[0]; } catch { continue; }
        if (choice && choice.delta && choice.delta.content) await writer.write(enc.encode(choice.delta.content));
        if (choice && choice.finish_reason) finish = choice.finish_reason;
      }
    }
  } catch {
    finish = 'error';
  }
  await writer.write(enc.encode('\u0000' + (finish || 'stop')));
  await writer.close();
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Passcode',
    Vary: 'Origin',
  };
}

function json(status, value, cors) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors } });
}
