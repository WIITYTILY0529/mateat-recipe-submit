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
  const res = await fetch(`${env.ANSWER_API_BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.ANSWER_API_KEY}` },
    body: JSON.stringify({ model: env.ANSWER_API_MODEL, temperature: 0, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) return json(502, { error: `추출 API 요청이 실패했습니다 (HTTP ${res.status}).` }, cors);
  const data = await res.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '';
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  let result = null;
  try { result = JSON.parse(text.slice(start, end + 1)); } catch { /* 아래에서 처리 */ }
  if (!result || typeof result !== 'object') {
    const cut = data.choices && data.choices[0] && data.choices[0].finish_reason === 'length';
    return json(422, { error: cut ? 'truncated' : 'invalid_json' }, cors);
  }
  return json(200, result, cors);
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
