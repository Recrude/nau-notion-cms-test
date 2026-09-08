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

## 배포 & 버튼

`npm run build`은 **git에 커밋된** 콘텐츠로 빌드하고, `npm run build:notion`은
빌드 직전에 Notion에서 다시 당겨온다. 같은 repo를 두 개의 Vercel 프로젝트로
붙이면 두 성질을 동시에 갖는다.

| | 빌드 커맨드 | 트리거 | 성격 |
|---|---|---|---|
| **staging** | `npm run build:notion` | Notion 버튼 → Deploy Hook | 누르면 즉시 반영. 편집자 확인용 |
| **production** | `npm run build` | main에 merge | PR 게이트. 실제 게시 |

두 프로젝트 모두 환경변수에 `NOTION_TOKEN`, `NOTION_DB_ID`가 필요하다
(production은 sync를 안 돌리므로 없어도 되지만, 넣어두면 커맨드를 바꿔 쓸 수 있다).

### Notion 버튼으로 배포 트리거

Notion의 **Send webhook** 액션은 버튼·데이터베이스 버튼·데이터베이스 자동화에서
쓸 수 있다. **유료 플랜 한정, POST만, 커스텀 헤더 지원.**

가장 단순한 경로 — 인증이 필요 없다:

1. Vercel → staging 프로젝트 → Settings → Git → Deploy Hooks → 생성 → URL 복사
2. Notion DB 상단에 버튼 블록 추가 → Add action → **Send webhook** → URL 붙여넣기
3. 편집자가 버튼을 누르면 Vercel이 `sync + build`를 돌리고 staging URL이 갱신된다

Deploy Hook URL 자체가 곧 권한이다. 아는 사람은 누구나 재배포를 걸 수 있다.
재배포만 가능하고 콘텐츠를 바꾸지는 못하므로 감수할 만하지만, 공개 페이지에
버튼을 두지는 말 것.

### production까지 버튼으로 하려면 (릴레이 필요)

GitHub Actions를 직접 부르려면 `Authorization: Bearer <PAT>` 헤더가 필요한데,
**그 PAT를 Notion 버튼 설정에 넣으면 Notion 편집 권한자 전원이 볼 수 있다.**
repo 쓰기 권한이 그대로 새는 셈이라 하면 안 된다.

대신 토큰을 서버에 두는 릴레이를 한 단계 끼운다:

```
Notion 버튼  →  /api/publish (Vercel function, 공유 시크릿 헤더 검증)
             →  GitHub workflow_dispatch  →  Sync from Notion  →  PR
```

릴레이는 20줄 남짓이고 GitHub 토큰은 Vercel 환경변수에만 존재한다.
Notion 쪽에는 이 릴레이용 시크릿만 들어가고, 그게 유출돼도 할 수 있는 건
"PR을 하나 더 만드는 것"뿐이다.

## 아직 안 한 것

- **ko/en 이중언어.** 현행 사이트는 WPML로 돌고 있다. Notion 스키마와 Astro 라우팅이
  갈리는 지점이라 나중에 붙이면 비싸다 — 실제 구축 전에 결정할 것.
- **Artists DB.** 지금은 Works 하나. 크레딧이 `multi_select` 문자열이라 아티스트와
  릴레이션이 아니다. 현행 WordPress의 태그 운영과 같은 한계.
- **폰트 셀프호스팅.** 지금은 jsDelivr dynamic subset. 한글 웹폰트가 이 파이프라인
  최대 성능 변수다 — 이미지 최적화보다 이게 먼저다.
- **증분 sync.** 페이지 200개 미만이면 전체 재sync가 몇 분이라 불필요.
  에셋만 `content.lock.json`의 `last_edited_time`으로 재다운로드를 건너뛴다.
- **Pagefind 검색, 애널리틱스.**
- **디자인.** 지금 화면은 의도적으로 스타일이 없다 — 배관 테스트지 디자인 시안이 아니다.
  폰트·크기·두께 전부 1종, 인덱스는 DB 뷰 그대로의 표.
