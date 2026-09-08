# NAU — Notion → Web 파이프라인 테스트

Notion을 **데이터 소스로만** 쓰고, 빌드 때 마크다운으로 뽑아 git에 커밋한다.
**PR merge가 곧 퍼블리시.** 디자인은 전부 코드에 있고, 권한은 branch protection 하나로 끝난다.

```
Notion DB (NAU Works)
  props: Title Slug Status Date Category Credits Summary Video Order
  body:  블록 (본문)
        │  npm run sync   (로컬 / GitHub Action)
        ▼
  src/content/works/*.md   +   src/assets/notion/*
        │  PR — diff 검토 + preview 배포
        ▼  merge (권한 = 소수)
  main → astro build → 정적 사이트
```

## 셋업

```bash
cp .env.example .env       # 값 채우기 (아래 3단계)
npm install
npm run provision          # Notion DB 생성 + 아카이브 작업 3건 시드 (최초 1회)
npm run sync               # Notion → 마크다운
npm run dev
```

1. **통합 생성** — https://www.notion.so/my-integrations → New integration → Internal.
   `ntn_`으로 시작하는 토큰을 `.env`의 `NOTION_TOKEN`에.
2. **부모 페이지** — Notion에 DB를 담을 페이지 하나 만들고, `•••` → Connections에서
   위 통합을 추가. URL 끝의 32자리를 `NOTION_PARENT_PAGE_ID`에.
3. **DB id** — `npm run provision`이 출력하는 값을 `NOTION_DB_ID`에.

이미 DB가 있으면 1·3단계만 하고 `provision`은 건너뛴다. 단, 속성 이름이
`scripts/provision.mjs`의 스키마와 일치해야 한다.

## 설계상 지켜야 하는 것

**파일 하나에 writer 하나.** `src/content/works/`와 `src/assets/notion/`은 sync가
매번 통째로 다시 만든다. 여기를 손으로 고치면 다음 sync에 조용히 사라진다.
생성된 md 첫 줄에 Notion 원본 링크가 박혀 있는 이유다.
(Sveltia 같은 git 기반 어드민을 나중에 붙인다면 `src/config/*.yml`처럼
Notion이 안 건드리는 경로에만 붙일 것.)

**조용히 터지는 것 3가지를 전부 빌드 실패로 바꿔놨다.**

| 위험 | 기본 동작 | 여기서의 처리 |
|---|---|---|
| Notion 파일 URL 약 1시간 만료 | 며칠 뒤 이미지 전부 깨짐 | sync 때 다운로드 → 재호스팅. 파일명은 **바이트 해시** (URL 서명이 매번 바뀌므로 URL 해시는 repo를 부풀린다) |
| 미지원 블록 | 본문에서 조용히 사라짐 | `SUPPORTED_BLOCKS` 화이트리스트. 벗어나면 Notion 페이지 URL과 함께 exit 1 |
| Notion에 올린 영상 | 만료 + 용량 | 감지해서 실패. YouTube/Vimeo URL을 `Video` 속성에 |

**추가로 걸리는 것들** — Slug 누락·중복·형식 위반, Title 누락. 전부 Notion 페이지
URL을 찍고 실패한다. `src/content/works/foo.md is invalid`는 편집자에게 쓸모없다.

**멱등성** — 같은 Notion 상태면 같은 바이트가 나온다. frontmatter 키 정렬,
`last_edited_time`은 frontmatter가 아니라 `content.lock.json`에.
안 그러면 sync마다 diff가 생겨 PR이 노이즈가 된다.

**삭제 전파** — sync는 생성 디렉터리를 비우고 다시 만든다. 쓰기만 하는 sync는
Notion에서 지운 글을 영원히 배포한다. Slug가 바뀌면 `public/_redirects`에 301 추가.

**Rate limit** — 초당 3회 근처. `scripts/notion.mjs`가 동시성 3 + 350ms 간격 +
429 `Retry-After` 재시도를 건다. SDK는 스로틀을 안 한다.

## 검증

```bash
node scripts/md.mjs   # frontmatter 멱등성 · 마크다운 이스케이프 · slug 규칙
npm run build         # zod 스키마 = 계약서. 위반 시 빌드 실패
```

## 아직 안 한 것

- **ko/en 이중언어.** 현행 사이트는 WPML로 돌고 있다. Notion 스키마와 Astro 라우팅이
  갈리는 지점이라 나중에 붙이면 비싸다 — 실제 구축 전에 결정할 것.
- **Artists DB.** 지금은 Works 하나. 크레딧이 `multi_select` 문자열이라 아티스트와
  릴레이션이 아니다. 현행 WordPress의 태그 운영과 같은 한계.
- **폰트 셀프호스팅.** 지금은 jsDelivr dynamic subset. 한글 웹폰트가 이 파이프라인
  최대 성능 변수다 — 이미지 최적화보다 이게 먼저다.
- **증분 sync.** 페이지 200개 미만이면 전체 재sync가 몇 분이라 불필요.
  에셋만 `content.lock.json`의 `last_edited_time`으로 재다운로드를 건너뛴다.
- **Pagefind 검색, 애널리틱스, Cloudflare Pages 연결.**
