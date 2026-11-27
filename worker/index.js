/**
 * Cloudflare Worker — MATEat 레시피 제출 페이지용 서버
 *   POST /fetch {url}       → GitHub Actions에서 fetcher/naver_blog.py(Playwright)를 실행하고 작업 id를 돌려줍니다.
 *   GET  /fetch?id=<id>     → 그 작업이 끝났으면 {status:'done', post:{text, author, likes, comments, published_date}}
 *   GET  /post?url=<글 URL> → 글 HTML(PostView)을 그냥 받아 돌려줍니다. GitHub 작업이 실패할 때 페이지가 씁니다(공감 수 없음).
 *   POST /extract {prompt}  → 레시피 추출 결과(OpenAI 호환 API, 스트리밍)
 * 모든 요청은 X-Passcode 헤더가 PASSCODE 비밀값과 같아야 합니다.
 * 비밀값: PASSCODE, ANSWER_API_BASE_URL, ANSWER_API_KEY, ANSWER_API_MODEL, GITHUB_TOKEN / 변수: ALLOWED_ORIGIN
 */

const AGENT = 'MATEatRecipeSource/1.0';
const MAX_PROMPT = 400_000;
const REPO = 'WIITYTILY0529/mateat-recipe-submit';
const WORKFLOW = 'fetch-post.yml';

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(request.url);
    if (!env.PASSCODE || request.headers.get('X-Passcode') !== env.PASSCODE) {
      return json(401, { error: '팀 암호가 맞지 않습니다.' }, cors);
    }
    try {
      if (request.method === 'POST' && url.pathname === '/fetch') return await startFetch(request, env, cors);
      if (request.method === 'GET' && url.pathname === '/fetch') return await fetchStatus(url.searchParams.get('id') || '', env, cors);
      if (request.method === 'GET' && url.pathname === '/post') return await post(url.searchParams.get('url') || '', cors);
      if (request.method === 'POST' && url.pathname === '/extract') return await extract(request, env, cors);
    } catch (e) {
      return json(502, { error: String(e && e.message || e) }, cors);
    }
    return json(404, { error: 'POST /fetch, GET /fetch?id=, GET /post?url=, POST /extract만 지원합니다.' }, cors);
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

function github(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'mateat-recipe-worker', ...(init.headers || {}),
    },
  });
}

/* 공감 수는 네이버 화면 스크립트가 나중에 채우므로, GitHub Actions에서 naver_blog.py가 브라우저(Playwright)로 글을 띄워 읽습니다. */
async function startFetch(request, env, cors) {
  const body = await request.json().catch(() => null);
  const target = postViewUrl(body && typeof body.url === 'string' ? body.url : '');
  if (!target) return json(400, { error: '글 번호가 있는 네이버 블로그 글 주소를 넣어 주세요.' }, cors);
  if (!env.GITHUB_TOKEN) return json(503, { error: 'Worker에 GITHUB_TOKEN이 설정되지 않았어요.' }, cors);
  const id = crypto.randomUUID();
  const res = await github(env, `/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'main', inputs: { url: target, request_id: id } }),
  });
  if (res.status !== 204) return json(502, { error: `GitHub 작업을 시작하지 못했습니다 (HTTP ${res.status}).` }, cors);
  return json(202, { id }, cors);
}

async function fetchStatus(id, env, cors) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return json(400, { error: '작업 id가 올바르지 않습니다.' }, cors);
  const list = await github(env, `/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=30`);
  if (!list.ok) return json(502, { error: `GitHub 작업 목록을 읽지 못했습니다 (HTTP ${list.status}).` }, cors);
  const run = (await list.json()).workflow_runs.find(r => r.display_title === `fetch ${id}`);
  if (!run || run.status !== 'completed') return json(200, { status: 'pending' }, cors);
  if (run.conclusion !== 'success') return json(200, { status: 'failed', error: `GitHub 작업이 실패했습니다 (${run.conclusion}).` }, cors);
  const artifacts = await github(env, `/actions/runs/${run.id}/artifacts`);
  const artifact = artifacts.ok && (await artifacts.json()).artifacts.find(a => a.name === 'post');
  if (!artifact) return json(200, { status: 'failed', error: 'GitHub 작업 결과 파일이 없습니다.' }, cors);
  // 결과 zip은 다른 저장소 주소로 넘겨주므로, 그 주소에는 GitHub 토큰을 보내지 않습니다.
  const link = await github(env, `/actions/artifacts/${artifact.id}/zip`, { redirect: 'manual' });
  const zip = link.headers.get('Location') ? await fetch(link.headers.get('Location')) : link;
  if (!zip.ok) return json(502, { error: `GitHub 작업 결과를 받지 못했습니다 (HTTP ${zip.status}).` }, cors);
  const result = JSON.parse(await firstFileInZip(await zip.arrayBuffer()));
  if (result.error) return json(200, { status: 'failed', error: result.error }, cors);
  return json(200, { status: 'done', post: result }, cors);
}

/* 파일 하나가 든 zip(GitHub artifact)에서 그 파일 내용을 글자로 꺼냅니다. */
async function firstFileInZip(buffer) {
  const view = new DataView(buffer);
  let end = buffer.byteLength - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error('GitHub 작업 결과 zip을 읽지 못했습니다.');
  const entry = view.getUint32(end + 16, true);
  const method = view.getUint16(entry + 10, true), size = view.getUint32(entry + 20, true), local = view.getUint32(entry + 42, true);
  const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  const data = new Uint8Array(buffer, start, size);
  if (method === 0) return new TextDecoder().decode(data);
  return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
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
    // temperature는 보내지 않습니다. gpt-luna 같은 추론 모델은 temperature=0을 거절합니다(기본값 1만 허용).
    body: JSON.stringify({ model: env.ANSWER_API_MODEL, stream: true, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok || !res.body) {
    // 원인을 알 수 있게 API가 돌려준 오류 문구(키는 들어 있지 않음)를 앞부분만 붙입니다.
    const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    return json(502, { error: `추출 API 요청이 실패했습니다 (HTTP ${res.status}). ${detail}`.trim() }, cors);
  }
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
