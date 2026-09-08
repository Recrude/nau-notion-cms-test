// Notion -> src/content/works/*.md  +  src/assets/notion/*
//
// Three failure modes this script exists to prevent, all of which are silent by
// default: expired Notion file URLs, unsupported blocks dropped from the body,
// and deleted pages staying published. Each one is turned into a loud exit.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { childBlocks, queryAll, SUPPORTED_BLOCKS } from "./notion.mjs";
import { plain, rich, frontmatter, SLUG_RE } from "./md.mjs";

const DB = process.env.NOTION_DB_ID;
if (!DB) {
  console.error("NOTION_DB_ID is not set. Run `npm run provision` first, or copy the id into .env.");
  process.exit(1);
}

const ROOT = path.resolve(import.meta.dirname, "..");
const CONTENT = path.join(ROOT, "src/content/works");
const ASSETS = path.join(ROOT, "src/assets/notion");
const LOCK = path.join(ROOT, "content.lock.json");
const VERCEL_JSON = path.join(ROOT, "vercel.json");

const errors = [];
const fail = (pageUrl, msg) => errors.push(`${msg}\n    ${pageUrl}`);

// --- property readers ------------------------------------------------------
function prop(page, name) {
  const p = page.properties[name];
  if (!p) return undefined;
  switch (p.type) {
    case "title": return plain(p.title);
    case "rich_text": return plain(p.rich_text);
    case "select": return p.select?.name;
    case "multi_select": return p.multi_select.map((s) => s.name);
    case "date": return p.date?.start;
    case "url": return p.url || undefined;
    case "number": return p.number ?? undefined;
    case "checkbox": return p.checkbox;
    case "files": return p.files.map((f) => f.file?.url ?? f.external?.url).filter(Boolean);
    default: return undefined;
  }
}

// --- assets ----------------------------------------------------------------
// Notion file URLs are presigned and expire in about an hour, so every asset is
// downloaded at sync time and rehosted. The filename is a hash of the BYTES, not
// of the URL: the URL carries a fresh signature on every sync and would produce a
// new filename each run, inflating the repo and churning the diff.
async function download(url, pageUrl) {
  const res = await fetch(url);
  if (!res.ok) {
    fail(pageUrl, `asset download failed (${res.status}): ${url.split("?")[0]}`);
    return null;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const hash = createHash("sha256").update(buf).digest("hex").slice(0, 16);
  const type = res.headers.get("content-type") ?? "";
  const ext =
    { "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
      "image/webp": ".webp", "image/svg+xml": ".svg" }[type.split(";")[0]] ??
    (path.extname(new URL(url).pathname) || ".bin");
  const name = `${hash}${ext}`;
  await fs.writeFile(path.join(ASSETS, name), buf);
  return name;
}

// --- blocks -> markdown ----------------------------------------------------
async function toMarkdown(blocks, ctx, depth = 0) {
  const lines = [];
  for (const b of blocks) {
    if (!SUPPORTED_BLOCKS.has(b.type)) {
      // An unsupported block silently vanishing is the second silent killer: the
      // editor sees a filled page in Notion and an empty one on the site.
      fail(ctx.pageUrl, `unsupported block "${b.type}" — add it to SUPPORTED_BLOCKS and toMarkdown, or remove it in Notion`);
      continue;
    }
    const pad = "  ".repeat(depth);
    switch (b.type) {
      case "paragraph": lines.push(pad + rich(b.paragraph.rich_text)); break;
      case "heading_1": lines.push(`${pad}## ${rich(b.heading_1.rich_text)}`); break;
      case "heading_2": lines.push(`${pad}### ${rich(b.heading_2.rich_text)}`); break;
      case "heading_3": lines.push(`${pad}#### ${rich(b.heading_3.rich_text)}`); break;
      case "bulleted_list_item": lines.push(`${pad}- ${rich(b.bulleted_list_item.rich_text)}`); break;
      case "numbered_list_item": lines.push(`${pad}1. ${rich(b.numbered_list_item.rich_text)}`); break;
      case "quote": lines.push(`${pad}> ${rich(b.quote.rich_text)}`); break;
      case "divider": lines.push(`${pad}---`); break;
      case "code":
        lines.push(`${pad}\`\`\`${b.code.language ?? ""}`, plain(b.code.rich_text), `${pad}\`\`\``);
        break;
      case "image": {
        const src = b.image.file?.url ?? b.image.external?.url;
        const name = ctx.assets[b.id] ?? (await download(src, ctx.pageUrl));
        if (name) {
          ctx.assets[b.id] = name;
          ctx.used.add(name);
          const caption = rich(b.image.caption).replace(/"/g, "&quot;");
          lines.push(`${pad}![${caption}](../../assets/notion/${name})`);
        }
        break;
      }
      case "video":
      case "embed":
      case "bookmark": {
        // Notion-hosted video expires like any other file, so only external URLs
        // are accepted here; the site embeds them as an iframe at render time.
        const src =
          b[b.type].external?.url ?? b[b.type].url ?? b[b.type].file?.url ?? "";
        if (b[b.type].file) {
          fail(ctx.pageUrl, `video uploaded to Notion — these expire. Paste a YouTube/Vimeo URL instead.`);
          break;
        }
        // The hero video lives in the Video property and is embedded by the page
        // template. A link keeps any extra body embed visible rather than dropped.
        lines.push(`${pad}[${b[b.type].caption ? rich(b[b.type].caption) || src : src}](${src})`);
        break;
      }
    }
    if (b.has_children && b.type !== "code") {
      lines.push(...(await toMarkdown(await childBlocks(b.id), ctx, depth + 1)));
    }
    lines.push("");
  }
  return lines;
}

// --- main ------------------------------------------------------------------
const lock = await fs.readFile(LOCK, "utf8").then(JSON.parse).catch(() => ({}));
const nextLock = {};

// Full reconciliation: the generated directory is rebuilt from scratch every run.
// A sync that only writes would keep serving pages that were deleted in Notion.
await fs.rm(CONTENT, { recursive: true, force: true });
await fs.mkdir(CONTENT, { recursive: true });
await fs.mkdir(ASSETS, { recursive: true });

const pages = await queryAll(DB, { filter: { property: "Status", select: { equals: "Published" } } });
console.log(`${pages.length} published page(s)`);

const used = new Set();
const slugs = new Map();

for (const page of pages) {
  const pageUrl = page.url;
  const title = prop(page, "Title");
  const slug = prop(page, "Slug");

  // Notion cannot enforce a required property, so validation lives here — and the
  // message carries the page URL, because "works/foo.md is invalid" is useless to
  // whoever is editing in Notion.
  if (!title) { fail(pageUrl, "missing Title"); continue; }
  if (!slug) { fail(pageUrl, `missing Slug (title: ${title})`); continue; }
  if (!SLUG_RE.test(slug)) { fail(pageUrl, `Slug "${slug}" must be lowercase letters, digits and hyphens only`); continue; }
  if (slugs.has(slug)) { fail(pageUrl, `duplicate Slug "${slug}" — also used by ${slugs.get(slug)}`); continue; }
  slugs.set(slug, title);

  const cached = lock[page.id]?.last_edited_time === page.last_edited_time ? lock[page.id] : null;
  const ctx = { pageUrl, assets: { ...(cached?.assets ?? {}) }, used };

  // Reuse of a cached asset is only safe if the file is still on disk.
  for (const [k, name] of Object.entries(ctx.assets)) {
    if (!(await fs.stat(path.join(ASSETS, name)).then(() => true).catch(() => false))) delete ctx.assets[k];
  }

  let cover;
  const coverUrl = page.cover?.file?.url ?? page.cover?.external?.url;
  if (coverUrl) {
    const name = ctx.assets.__cover ?? (await download(coverUrl, pageUrl));
    if (name) { ctx.assets.__cover = name; used.add(name); cover = `../../assets/notion/${name}`; }
  }
  Object.values(ctx.assets).forEach((n) => used.add(n));

  const body = (await toMarkdown(await childBlocks(page.id), ctx)).join("\n").replace(/\n{3,}/g, "\n\n").trim();

  const fm = frontmatter(
    {
      title,
      date: prop(page, "Date"),
      category: prop(page, "Category"),
      credits: prop(page, "Credits"),
      summary: prop(page, "Summary"),
      video: prop(page, "Video"),
      cover,
      order: prop(page, "Order"),
    },
    pageUrl
  );
  await fs.writeFile(path.join(CONTENT, `${slug}.md`), `${fm}${body}\n`);
  nextLock[page.id] = { slug, last_edited_time: page.last_edited_time, assets: ctx.assets };
}

// Garbage-collect assets no page references any more.
for (const f of await fs.readdir(ASSETS).catch(() => [])) {
  if (!used.has(f) && f !== ".gitkeep") await fs.rm(path.join(ASSETS, f));
}

// A slug that changed leaves a live URL pointing at nothing, so emit a redirect.
// These go in vercel.json: the `_redirects` file is Netlify/Cloudflare syntax and
// Vercel ignores it silently, which would make the rules look present but dead.
const redirects = [];
for (const [id, prev] of Object.entries(lock)) {
  const now = nextLock[id];
  if (now && now.slug !== prev.slug) redirects.push({ source: `/works/${prev.slug}`, destination: `/works/${now.slug}`, permanent: true });
  if (!now) console.warn(`  unpublished: /works/${prev.slug} (no redirect target — add one by hand if it was public)`);
}

// Only the `redirects` key is owned by sync; everything else in vercel.json is
// hand-maintained and must survive.
const vercel = await fs.readFile(VERCEL_JSON, "utf8").then(JSON.parse).catch(() => ({}));
const live = new Set([...slugs.keys()].map((s) => `/works/${s}`));
const byPath = new Map();
for (const r of [...(vercel.redirects ?? []), ...redirects]) byPath.set(r.source, r);
vercel.redirects = [...byPath.values()]
  // Drop rules whose destination no longer exists: a 301 into a 404 is worse than
  // the 404 alone, and stale rules accumulate every time a slug changes.
  .filter((r) => live.has(r.destination))
  .sort((a, b) => a.source.localeCompare(b.source));
if (!vercel.redirects.length) delete vercel.redirects;
await fs.writeFile(VERCEL_JSON, `${JSON.stringify(vercel, null, 2)}\n`);

if (errors.length) {
  console.error(`\n${errors.length} content error(s):\n`);
  errors.forEach((e, i) => console.error(`  ${i + 1}. ${e}\n`));
  process.exit(1);
}

await fs.writeFile(LOCK, `${JSON.stringify(nextLock, null, 2)}\n`);
console.log(`wrote ${Object.keys(nextLock).length} file(s), ${used.size} asset(s)${redirects.length ? `, ${redirects.length} redirect(s)` : ""}`);
