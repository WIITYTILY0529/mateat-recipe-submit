"""Extract a public Naver Blog post as JSON.

Install: python -m pip install requests beautifulsoup4 protego playwright
Browser: python -m playwright install chromium
Usage:   python naver_blog.py "https://blog.naver.com/blogid/123"
"""

import argparse
import json
import os
import re
import sys
from time import monotonic, sleep
from urllib.parse import parse_qs, urljoin, urlsplit, urlunsplit

import requests
from bs4 import BeautifulSoup, NavigableString

HOSTS = {"blog.naver.com", "m.blog.naver.com"}
AGENT = "MATEatRecipeSource/1.0"
BODY = ".se-main-container, .se_component_wrap, .post-view"
LIKES = (
    "span.u_likeit_text._count.num, "  # 공감 수 (화면 스크립트가 채움)
    ".blog_mobile_like_area .u_likeit_button .u_likeit_text, "
    "#_post_area .u_likeit_button .u_likeit_text, "
    "#postViewArea .u_likeit_button .u_likeit_text, "
    ".u_likeit_list_module .u_likeit_button .u_likeit_text"
)
COMMENTS = (
    ".blog_comment_count, #commentCount, #commentCountView, "
    "._commentCount, .btn_comment .num, .btn_comment .count"
)
REDIRECTS = {301, 302, 303, 307, 308}


def post_key(url):
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.hostname not in HOSTS or parts.netloc.lower() != parts.hostname:
        raise ValueError("네이버 블로그 게시글 URL을 입력해 주세요.")
    direct = re.fullmatch(r"/([\w.-]+)/([0-9]+)/?", parts.path, re.ASCII)
    if direct:
        author, number = direct.groups()
    elif parts.path.lower() == "/postview.naver":
        params = parse_qs(parts.query)
        author = params.get("blogId", [""])[0]
        number = params.get("logNo", [""])[0]
    else:
        raise ValueError("게시글 번호가 포함된 URL을 입력해 주세요.")
    if not re.fullmatch(r"[a-z0-9_][a-z0-9_.-]{0,79}", author, re.I | re.ASCII) or not re.fullmatch(r"[0-9]{1,20}", number):
        raise ValueError("블로그 아이디나 게시글 번호가 올바르지 않습니다.")
    return author.lower(), str(int(number))


class PostClient:
    def __init__(self, session):
        self.session = session
        self.policies = {}
        self.last_request = {}

    def request(self, url, delay=0.7):
        host = urlsplit(url).hostname
        sleep(max(0, delay - (monotonic() - self.last_request.get(host, 0))))
        self.last_request[host] = monotonic()
        return self.session.get(
            url, headers={"User-Agent": AGENT}, timeout=(5, 12),
            allow_redirects=False, stream=True,
        )

    @staticmethod
    def read(response, limit):
        data = bytearray()
        for chunk in response.iter_content(65536):
            data.extend(chunk)
            if len(data) > limit:
                raise ValueError("응답 크기 한도를 초과했습니다.")
        return bytes(data)

    def fetch_post(self, url, key):
        from protego import Protego

        for _ in range(4):
            if post_key(url) != key:
                raise ValueError("이동한 주소의 게시글 번호가 원본과 다릅니다.")
            host = urlsplit(url).hostname
            if host not in self.policies:
                with self.request(f"https://{host}/robots.txt") as response:
                    if response.status_code != 200:
                        raise ValueError(f"robots.txt를 확인할 수 없습니다 (HTTP {response.status_code}).")
                    rules = self.read(response, 512_000).decode("utf-8-sig", errors="replace")
                    if rules.lstrip().startswith("<"):
                        raise ValueError("robots.txt 응답이 HTML입니다.")
                    self.policies[host] = Protego.parse(rules)
            policy = self.policies[host]
            if not policy.can_fetch(url, AGENT):
                raise ValueError("robots.txt에서 이 게시글의 자동 접근을 허용하지 않습니다.")
            with self.request(url, max(0.7, policy.crawl_delay(AGENT) or 0)) as response:
                if response.status_code in REDIRECTS:
                    location = response.headers.get("Location")
                    if not location:
                        break
                    url = urljoin(url, location)
                    continue
                response.raise_for_status()
                content_type = response.headers.get("Content-Type", "")
                if not re.match(r"(?:text/html|application/xhtml\+xml)(?:\s*;|$)", content_type, re.I):
                    raise ValueError("게시글 HTML을 받지 못했습니다.")
                return url, self.read(response, 5_000_000), content_type
        raise ValueError("게시글의 이동 주소를 확인할 수 없습니다.")


def parse_count(value):
    value = (value or "").strip()
    if not re.fullmatch(r"[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+", value):
        return None
    digits = value.replace(",", "").lstrip("0") or "0"
    return int(digits) if len(digits) <= 10 and int(digits) <= 2_147_483_647 else None


def unique_count(values):
    counts = {count for value in values if (count := parse_count(value)) is not None}
    return next(iter(counts)) if len(counts) == 1 else None


# 스마트에디터 ONE 본문에서 레시피와 상관없는 구성 요소(사진, 링크 미리보기, 지도, 스티커, 동영상 등)는 건너뜁니다.
SKIP_COMPONENTS = {
    "se-image", "se-imageStrip", "se-imageGroup", "se-oglink", "se-placesMap", "se-map",
    "se-sticker", "se-video", "se-oembed", "se-file", "se-material", "se-horizontalLine",
}


def editor_text(body):
    """문단(.se-text-paragraph, 안의 <span id="SE-...">)과 표만 순서대로 모읍니다. 문단 사이 빈 줄은 하나로 줄입니다."""
    def clean(tag):
        return re.sub(r"\s+", " ", tag.get_text("").replace("​", "")).strip()

    lines = []
    for component in body.select(":scope > .se-component"):
        kinds = set(component.get("class", []))
        if kinds & SKIP_COMPONENTS:
            continue
        if "se-table" in kinds:
            for row in component.select("tr"):
                cells = [clean(cell) for cell in row.select("td, th")]
                lines.append(" | ".join(cell for cell in cells if cell))
        else:
            lines += [clean(paragraph) for paragraph in component.select(".se-text-paragraph")]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def parse_post(data, content_type):
    charset = re.search(r"""charset\s*=\s*["']?([\w.-]+)""", content_type, re.I)
    declared = charset.group(1) if charset else None
    soup = BeautifulSoup(data, "html.parser", from_encoding=declared)
    meta = {
        (tag.get("property") or tag.get("name") or "").lower(): tag.get("content", "").strip()
        for tag in soup.find_all("meta")
    }
    properties = soup.select_one("#_post_property")

    def visible_text(selector, attribute=None):
        for item in selector.split(","):
            tag = soup.select_one(item.strip())
            if tag is not None:
                value = tag.get(attribute) if attribute else tag.get_text(" ", strip=True)
                if value:
                    return value
        return None

    # 작성자: 글 상단의 <a class="link pcol2">닉네임</a>을 먼저 봅니다.
    author = visible_text("a.link.pcol2") or meta.get("author") or meta.get("article:author:name") or visible_text(
        ".blog_author .name, .blog_author, .se_author .name, .se_author, "
        ".blog2_series .nick, .blog2_series .nickname, .blog2_series .name, "
        ".blog2_post .nick, .writer_info .nick, .blogger, .nick"
    )
    published = meta.get("article:published_time") or visible_text(
        "time[datetime]", "datetime"
    ) or visible_text(".se_publishDate, .blog_date, .blog2_series .date, ._postAddDate, .post_date")
    # 댓글 수: <em id="commentCount" class="_commentCount">(없으면 하단 #floating_bottom_commentCount).
    # 댓글이 없으면 이 칸이 비어 있으므로 0으로 봅니다.
    box = soup.select_one("em#commentCount") or soup.select_one("#floating_bottom_commentCount")
    comments = parse_count(box.get_text(strip=True) or "0") if box is not None else None
    if comments is None:
        comments = parse_count(meta.get("mateat:comments"))
    if comments is None and properties is not None:
        comments = parse_count(properties.get("commentcount"))
    if comments is None:
        comments = unique_count(tag.get_text(strip=True) for tag in soup.select(COMMENTS))
    likes = parse_count(meta.get("mateat:likes"))
    if likes is None:
        # 정적 HTML의 공감 수는 스크립트가 실제 값을 채우기 전의 자리 표시 0이므로 0은 모르는 값으로 둡니다.
        likes = unique_count(tag.get_text(strip=True) for tag in soup.select(LIKES)) or None

    body = soup.select_one(BODY) or soup.select_one("#postViewArea")
    text = editor_text(body) if body is not None else ""
    if body is not None and not text:  # 스마트에디터 ONE이 아닌 옛 글은 본문 전체 글자를 씁니다.
        for tag in reversed(body.select(
            "script, style, template, noscript, iframe, nav, footer, aside, button, svg, [hidden], [aria-hidden=true]"
        )):
            tag.decompose()
        for node in list(body.find_all(string=True)):
            if type(node) is NavigableString:
                node.replace_with(re.sub(r"\s+", " ", str(node)))
        for tag in body.select("br, hr, div, p, li, h1, h2, h3, h4, h5, h6, tr, blockquote, figcaption"):
            tag.insert_before("\n")
            tag.insert_after("\n")
        for tag in body.select("td, th"):
            tag.insert_after(" ")
        text = re.sub(r"\n{3,}", "\n\n", "\n".join(
            re.sub(r"[^\S\n]+", " ", line).strip()
            for line in body.get_text().splitlines()
        )).strip()
    frame = soup.select_one("iframe#mainFrame, iframe[name=mainFrame]")
    return {
        "text": text, "likes": likes, "comments": comments,
        "author": author, "published_date": published,
    }, frame.get("src") if frame else None, body is not None


def rendered_counts(url, data, content_type, fields):
    from playwright.sync_api import TimeoutError as BrowserTimeout
    from playwright.sync_api import sync_playwright

    selectors = {"likes": LIKES, "comments": COMMENTS}
    with sync_playwright() as playwright:
        # PLAYWRIGHT_CHANNEL=chrome이면 설치된 Chrome을 씁니다(GitHub Actions 실행 서버에는 Chrome이 이미 있음).
        browser = playwright.chromium.launch(channel=os.environ.get("PLAYWRIGHT_CHANNEL") or None)
        try:
            context = browser.new_context(service_workers="block", accept_downloads=False)
            page = context.new_page()

            def route_request(route):
                request = route.request
                destination = urlsplit(request.url)
                if request.is_navigation_request():
                    if request.url.split("#", 1)[0] == url.split("#", 1)[0] and request.frame == page.main_frame:
                        route.fulfill(body=data, content_type=content_type)
                    else:
                        route.abort()
                    return
                host = destination.hostname or ""
                allowed_host = any(host == domain or host.endswith("." + domain)
                                   for domain in ("naver.com", "naver.net", "pstatic.net"))
                if (destination.scheme == "https" and destination.netloc == host
                        and allowed_host and request.method == "GET"
                        and request.resource_type not in {"image", "media", "font"}):
                    route.continue_()
                else:
                    route.abort()

            context.route("**/*", route_request)
            page.goto(url, wait_until="domcontentloaded", timeout=10_000)
            try:
                # 자리 표시 0이 실제 값으로 바뀔 때까지 기다립니다. 실제로 0이면 시간 초과 후 0을 읽습니다.
                page.wait_for_function(
                    """selectors => selectors.every(selector => [...document.querySelectorAll(selector)]
                        .some(node => node.getClientRects().length && /^[\\d,]*[1-9][\\d,]*$/.test(node.textContent.trim())))""",
                    arg=[selectors[field] for field in fields], timeout=8_000,
                )
            except BrowserTimeout:
                pass
            return {
                field: unique_count(
                    node.text_content(timeout=1_000) for node in page.locator(selectors[field]).all()
                    if node.is_visible()
                )
                for field in fields
            }
        finally:
            browser.close()


def extract_post(url):
    parts = urlsplit(url.strip())
    if parts.scheme == "http":
        parts = parts._replace(scheme="https")
    url = urlunsplit(parts._replace(fragment=""))
    key = post_key(url)
    with requests.Session() as session:
        client = PostClient(session)
        url, data, content_type = client.fetch_post(url, key)
        result, frame, has_body = parse_post(data, content_type)
        if not has_body and frame:
            url, data, content_type = client.fetch_post(urljoin(url, frame), key)
            inner, _, has_body = parse_post(data, content_type)
            result.update({field: value for field, value in inner.items() if value is not None})
        if not has_body:
            raise ValueError("네이버 블로그 본문 영역을 찾지 못했습니다.")
    missing = [field for field in ("likes", "comments") if result[field] is None]
    if missing:
        try:
            result.update(rendered_counts(url, data, content_type, missing))
        except ImportError:
            print("Playwright가 없어 페이지에서 동적으로 표시되는 수치를 읽을 수 없습니다.", file=sys.stderr)
        except Exception as error:
            from playwright.sync_api import Error as BrowserError
            if not isinstance(error, BrowserError):
                raise
            print("브라우저에서 공감·댓글 수를 확인하지 못했습니다.", file=sys.stderr)
    return result


def main():
    parser = argparse.ArgumentParser(description="네이버 블로그 공개 게시글 추출")
    parser.add_argument("url", help="네이버 블로그 게시글 URL")
    args = parser.parse_args()
    try:
        result = extract_post(args.url)
    except (ValueError, ImportError, requests.RequestException) as error:
        parser.exit(1, f"추출 실패: {error}\n")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
