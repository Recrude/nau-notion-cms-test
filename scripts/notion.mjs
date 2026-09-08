// Notion API helpers: throttling, retry, and the block whitelist.
import { Client } from "@notionhq/client";

const token = process.env.NOTION_TOKEN;
if (!token) {
  console.error("NOTION_TOKEN is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

export const notion = new Client({ auth: token });

// Notion's published limit averages 3 requests/second. The SDK does not throttle,
// so every call goes through here: at most 3 in flight, spaced 350ms apart.
let chain = Promise.resolve();
let inFlight = 0;
const MAX_IN_FLIGHT = 3;
const SPACING_MS = 350;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function call(fn, label = "notion") {
  while (inFlight >= MAX_IN_FLIGHT) await sleep(50);
  chain = chain.then(() => sleep(SPACING_MS));
  await chain;
  inFlight++;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const retryable = err?.status === 429 || (err?.status >= 500 && err?.status < 600);
        if (!retryable || attempt >= 4) throw err;
        const wait = Number(err?.headers?.["retry-after"] ?? 0) * 1000 || 2 ** attempt * 1000;
        console.warn(`  ${label}: ${err.status}, retrying in ${wait}ms`);
        await sleep(wait);
      }
    }
  } finally {
    inFlight--;
  }
}

/** Fetch every child block of a page or block, following pagination. */
export async function childBlocks(blockId) {
  const out = [];
  let cursor;
  do {
    const res = await call(
      () => notion.blocks.children.list({ block_id: blockId, start_cursor: cursor, page_size: 100 }),
      `blocks ${blockId}`
    );
    out.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

/** Query every row of a database, following pagination. */
export async function queryAll(database_id, body = {}) {
  const out = [];
  let cursor;
  do {
    const res = await call(
      () => notion.databases.query({ database_id, start_cursor: cursor, page_size: 100, ...body }),
      "query"
    );
    out.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

// --- Block whitelist -------------------------------------------------------
// An editor who uses an unsupported block must get a loud build failure, not a
// silently empty page. Adding a block type here means teaching toMarkdown about it.
export const SUPPORTED_BLOCKS = new Set([
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "bulleted_list_item",
  "numbered_list_item",
  "quote",
  "code",
  "divider",
  "image",
  "video",
  "embed",
  "bookmark",
]);
