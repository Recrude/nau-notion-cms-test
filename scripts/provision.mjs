// One-time setup: create the Works database in Notion with the schema the sync
// script expects, and seed it with three real works from the archive so there is
// something to publish on the first run.
import fs from "node:fs/promises";
import path from "node:path";
import { notion, call, queryAll } from "./notion.mjs";

const parent = process.env.NOTION_PARENT_PAGE_ID;
if (!parent && !process.env.NOTION_DB_ID) {
  console.error(
    "NOTION_PARENT_PAGE_ID is not set.\n" +
      "  1. Make a page in Notion to hold the database.\n" +
      "  2. Open ••• > Connections > add your integration.\n" +
      "  3. Copy the 32-character id out of the page URL into .env"
  );
  process.exit(1);
}

const CATEGORIES = ["Experience", "Commercial / Design", "The Nerdiest", "Beyond Canvas"];

let db;
if (process.env.NOTION_DB_ID) {
  // Re-seeding: keep the database (and its id in .env) and replace its rows.
  db = await call(() => notion.databases.retrieve({ database_id: process.env.NOTION_DB_ID }), "retrieve db");
  const rows = await queryAll(db.id);
  for (const r of rows) await call(() => notion.pages.update({ page_id: r.id, archived: true }), "archive");
  console.log(`reusing database, archived ${rows.length} existing row(s)`);
} else {
  db = await call(
    () =>
      notion.databases.create({
        parent: { type: "page_id", page_id: parent },
        title: [{ type: "text", text: { content: "NAU Works" } }],
        properties: {
          Title: { title: {} },
          Slug: { rich_text: {} },
          Status: {
            select: {
              options: [
                { name: "Draft", color: "gray" },
                { name: "Published", color: "green" },
              ],
            },
          },
          Date: { date: {} },
          Category: { select: { options: CATEGORIES.map((name) => ({ name })) } },
          Credits: { multi_select: {} },
          Summary: { rich_text: {} },
          Video: { url: {} },
          // Notion view sort order is not exposed through the API, so ordering has
          // to live in a property the sync script can actually read.
          Order: { number: {} },
        },
      }),
    "create db"
  );
}

console.log(`database: ${db.url}`);

// --- seed ------------------------------------------------------------------
const archive = path.resolve(import.meta.dirname, "../../_archive");
const model = JSON.parse(await fs.readFile(path.join(archive, "data/content-model.json"), "utf8"));

// Media-art work only. The archive files installations under Beyond Canvas and
// The Nerdiest, exhibition/space work under Experience, and commercial video
// under Commercial / Design — so rank by those categories and drop the films.
const CATEGORY_WEIGHT = { "Beyond Canvas": 2, "The Nerdiest": 2, Experience: 1 };
const IS_FILM = /필름|film|티저|teaser|온스크린|쇼케이스/i;
const IS_MEDIA_ART = /media art|미디어파사드|미디어월|미디어 아트/i;

const score = (w) =>
  w.categories.reduce((s, c) => s + (CATEGORY_WEIGHT[c] ?? 0), 0) + (IS_MEDIA_ART.test(w.title) ? 2 : 0);

const picks = model.works
  .filter((w) => w.hero && w.youtube.length && w.excerpt && !IS_FILM.test(w.title) && score(w) > 0)
  .sort((a, b) => score(b) - score(a) || b.date.localeCompare(a.date))
  .slice(0, 6);

const text = (content) => [{ type: "text", text: { content } }];

// Archive slugs are percent-encoded Korean, which yields unreadable ASCII. The
// editor renames these in Notion; the seed only needs a slug that validates.
function seedSlug(w, i) {
  const s = decodeURIComponent(w.slug).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return s.length >= 3 ? s : `work-${i + 1}`;
}

for (const [i, w] of picks.entries()) {
  const images = w.images
    // Notion strips zero-width characters from an external URL, which turns some
    // archive filenames into a 404 the sync then reports as a dead asset.
    .filter((im) => /\.(jpe?g|png)$/i.test(im.url) && /^[\x20-\x7e]*$/.test(im.url))
    .slice(0, 2)
    .map((im) => ({
      object: "block",
      type: "image",
      image: { type: "external", external: { url: im.url } },
    }));

  await call(
    () =>
      notion.pages.create({
        parent: { database_id: db.id },
        cover: { type: "external", external: { url: w.hero.url } },
        properties: {
          Title: { title: text(w.title) },
          Slug: { rich_text: text(seedSlug(w, i)) },
          Status: { select: { name: "Published" } },
          Date: { date: { start: w.date } },
          Category: { select: { name: w.categories[0] ?? "Commercial / Design" } },
          Credits: { multi_select: w.credits.slice(0, 6).map((name) => ({ name })) },
          Summary: { rich_text: text(w.excerpt.slice(0, 300)) },
          Video: { url: `https://youtu.be/${w.youtube[0]}` },
          Order: { number: i + 1 },
        },
        children: [
          { object: "block", type: "paragraph", paragraph: { rich_text: text(w.excerpt) } },
          ...images,
        ],
      }),
    `seed ${w.slug}`
  );
  console.log(`  seeded: ${w.title}`);
}

console.log(`\nAdd this to .env:\n\nNOTION_DB_ID=${db.id}\n`);
