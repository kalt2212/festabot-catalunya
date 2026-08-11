import { Hono } from "hono";
import { handleUpdate, sendDueReminders } from "./handlers";
import { claimUpdate, markUpdateDone, releaseUpdate } from "./repositories/updates";
import type { Env, TelegramUpdate } from "./types";
import { LANDING_HTML } from "./landing";

const app = new Hono<{ Bindings: Env }>();

function isSafeId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

interface ProgramSyncRequest {
  eventCode: string;
  sourceUrl: string;
  sourceUpdatedAt?: string;
  text: string;
}

function secretsMatch(supplied: string, expected: string): boolean {
  const suppliedBytes = new TextEncoder().encode(supplied);
  const expectedBytes = new TextEncoder().encode(expected);
  let difference = suppliedBytes.byteLength ^ expectedBytes.byteLength;
  const length = Math.max(suppliedBytes.byteLength, expectedBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    difference |= (suppliedBytes[index] ?? 0) ^ (expectedBytes[index] ?? 0);
  }
  return difference === 0;
}

export function isValidProgramSync(value: unknown): value is ProgramSyncRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ProgramSyncRequest>;
  if (typeof candidate.eventCode !== "string" || !/^\d{5,20}$/.test(candidate.eventCode)) return false;
  if (typeof candidate.text !== "string" || candidate.text.length < 200 || candidate.text.length > 180_000) return false;
  if (candidate.sourceUpdatedAt !== undefined
    && (typeof candidate.sourceUpdatedAt !== "string" || candidate.sourceUpdatedAt.length > 80)) return false;
  if (typeof candidate.sourceUrl !== "string" || candidate.sourceUrl.length > 2_000) return false;
  try {
    const source = new URL(candidate.sourceUrl);
    const hostname = source.hostname.toLowerCase();
    const path = decodeURIComponent(source.pathname).toLowerCase();
    return (source.protocol === "https:" || source.protocol === "http:")
      && !source.username
      && !source.password
      && hostname !== "localhost"
      && !hostname.endsWith(".local")
      && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)
      && (path.endsWith(".pdf") || path.includes(".pdf/"));
  } catch {
    return false;
  }
}

export function isValidUpdate(update: TelegramUpdate): boolean {
  if (!update || typeof update !== "object" || Array.isArray(update)) return false;
  if (!isSafeId(update.update_id) || update.update_id < 0) return false;
  if (update.message) {
    if (!isSafeId(update.message.message_id) || !isSafeId(update.message.chat?.id)) return false;
    if (update.message.from && !isSafeId(update.message.from.id)) return false;
    if (update.message.text !== undefined && (typeof update.message.text !== "string" || update.message.text.length > 8192)) return false;
    if (update.message.location) {
      const { latitude, longitude } = update.message.location;
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
        || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return false;
    }
  }
  if (update.callback_query) {
    if (typeof update.callback_query.id !== "string" || update.callback_query.id.length > 256
      || !isSafeId(update.callback_query.from?.id)
      || (update.callback_query.data !== undefined && (typeof update.callback_query.data !== "string"
        || new TextEncoder().encode(update.callback_query.data).byteLength > 64))) return false;
  }
  if (update.inline_query) {
    if (typeof update.inline_query.id !== "string" || update.inline_query.id.length > 256
      || !isSafeId(update.inline_query.from?.id)
      || typeof update.inline_query.query !== "string" || update.inline_query.query.length > 256
      || typeof update.inline_query.offset !== "string" || update.inline_query.offset.length > 64) return false;
  }
  return true;
}

function updateActorId(update: TelegramUpdate): number | undefined {
  return update.callback_query?.from.id ?? update.inline_query?.from.id ?? update.message?.from?.id;
}

app.get("/", (context) =>
  context.html(LANDING_HTML, 200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=3600"
  })
);

app.get("/sitemap.xml", (context) =>
  context.text(
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://festabot-catalunya.adrimg3196.workers.dev/</loc>
    <changefreq>weekly</changefreq><priority>1.0</priority></url>
</urlset>`,
    200,
    { "Content-Type": "application/xml; charset=utf-8" }
  )
);

app.get("/health", (context) => context.json({ ok: true }));

app.post("/internal/programs/sync", async (context) => {
  const expectedSecret = context.env.PROGRAM_SYNC_SECRET;
  if (!expectedSecret) return context.json({ ok: false }, 404);
  const authorization = context.req.header("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")
    || !secretsMatch(authorization.slice("Bearer ".length), expectedSecret)) {
    return context.json({ ok: false }, 403);
  }
  if (!context.req.header("Content-Type")?.toLowerCase().includes("application/json")) {
    return context.json({ ok: false }, 415);
  }
  const declaredLength = Number(context.req.header("Content-Length") ?? "0");
  if (declaredLength > 250_000) return context.json({ ok: false }, 413);

  let payload: unknown;
  try {
    const body = await context.req.raw.arrayBuffer();
    if (body.byteLength > 250_000) return context.json({ ok: false }, 413);
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return context.json({ ok: false }, 400);
  }
  if (!isValidProgramSync(payload)) return context.json({ ok: false }, 400);

  await context.env.DB.prepare(`
    INSERT INTO program_documents (event_code, source_url, source_updated_at, text, extracted_at)
    VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT(event_code) DO UPDATE SET
      source_url = excluded.source_url,
      source_updated_at = excluded.source_updated_at,
      text = excluded.text,
      extracted_at = excluded.extracted_at
  `).bind(
    payload.eventCode,
    payload.sourceUrl,
    payload.sourceUpdatedAt ?? "",
    payload.text,
    new Date().toISOString()
  ).run();
  return context.json({ ok: true });
});

app.post("/telegram/webhook", async (context) => {
  const suppliedSecret = context.req.header("X-Telegram-Bot-Api-Secret-Token");
  if (!suppliedSecret || !secretsMatch(suppliedSecret, context.env.TELEGRAM_WEBHOOK_SECRET)) {
    return context.json({ ok: false }, 403);
  }

  if (!context.req.header("Content-Type")?.toLowerCase().includes("application/json")) {
    return context.json({ ok: false }, 415);
  }

  const contentLength = Number(context.req.header("Content-Length") ?? "0");
  if (contentLength > 256_000) {
    return context.json({ ok: false }, 413);
  }

  let update: TelegramUpdate;
  let updateClaimToken: string | null = null;
  try {
    const body = await context.req.raw.arrayBuffer();
    if (body.byteLength > 256_000) return context.json({ ok: false }, 413);
    update = JSON.parse(new TextDecoder().decode(body)) as TelegramUpdate;
  } catch {
    return context.json({ ok: false }, 400);
  }
  if (!isValidUpdate(update)) {
    return context.json({ ok: false }, 400);
  }

  try {
    const actorId = updateActorId(update);
    if (actorId !== undefined) {
      const rateLimit = await context.env.USER_RATE_LIMITER.limit({ key: String(actorId) });
      if (!rateLimit.success) {
        return context.json({ ok: true, limited: true });
      }
    }

    updateClaimToken = await claimUpdate(context.env, update.update_id);
    if (!updateClaimToken) return context.json({ ok: true, duplicate: true });

    await handleUpdate(context.env, update);
    await markUpdateDone(context.env, update.update_id, updateClaimToken);
    return context.json({ ok: true });
  } catch (error) {
    console.error("Telegram update failed", { updateId: update.update_id, error: String(error) });
    if (updateClaimToken) {
      try {
        await releaseUpdate(context.env, update.update_id, updateClaimToken);
      } catch (releaseError) {
        console.error("Telegram update lease release failed", { updateId: update.update_id, error: String(releaseError) });
      }
    }
    return context.json({ ok: false }, 500);
  }
});

app.onError((error, context) => {
  console.error("Unhandled request error", { error: String(error) });
  return context.json({ ok: false }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext): Promise<void> {
    context.waitUntil(sendDueReminders(env));
  }
};
