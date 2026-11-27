# MATEat 레시피 제출

네이버 블로그 레시피 글 주소를 넣으면 글을 가져와 레시피(재료·분량·조리 단계)를 정리하고, DB 관리자에게 보낼 JSON·SQL 파일을 만드는 페이지입니다. DB에 직접 저장하지 않습니다.

| 경로 | 역할 |
| --- | --- |
| `index.html` | GitHub Pages로 배포하는 페이지. `hci_db/share/build_submit_page.py --site <Worker 주소>`로 만듭니다(직접 고치지 않습니다). |
| `worker/` | Cloudflare Worker. `GET /post?url=`로 네이버 글 화면을 가져오고, `POST /extract`로 추출 API를 호출합니다. |
| `.github/workflows/deploy.yml` | `main`에 푸시하면 Pages에 배포합니다. |

## Worker 배포

```powershell
cd worker
npm install
npx wrangler login
npx wrangler secret put PASSCODE            # 팀 암호
npx wrangler secret put ANSWER_API_BASE_URL # /chat/completions 앞까지의 주소
npx wrangler secret put ANSWER_API_KEY
npx wrangler secret put ANSWER_API_MODEL
npx wrangler deploy
```

두 요청 모두 `X-Passcode` 헤더가 팀 암호와 같아야 하고, 페이지 주소(`ALLOWED_ORIGIN`)에서만 호출할 수 있습니다. 공감 수는 페이지 스크립트가 채우는 값이라 가져오지 않습니다. 화면에서 직접 입력합니다.

## 페이지 갱신

재료명·등록된 글 목록은 만들 때의 Supabase 기준입니다. `hci_db`에서 다시 만든 뒤 이 저장소에 커밋·푸시합니다.

```powershell
.\.venv\Scripts\python.exe share\build_submit_page.py --site https://mateat-recipe-worker.<계정>.workers.dev
```
