// Voice Guides API: Cloudflare Pages Function handling every /api/* request.
// Storage: one R2 bucket (binding BUCKET). index.json holds piece metadata,
// uploaded scores and MP3s live under pieces/<id>/...
// Reading is public. Changing anything needs the ADMIN_PASSWORD secret.

const VOICES = ["Soprano", "Alto", "Tenor", "Bass", "Other"];
const MAX_TRACKS = 10;
const MAX_BYTES = 90 * 1024 * 1024; // Pages Functions request limit is 100 MB
const CACHE = "public, max-age=31536000, immutable";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const fail = (msg, status = 400) => json({ error: msg }, status);
const clean = (v, max) => String(v ?? "").trim().slice(0, max);
const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const sortPieces = (list) => [...list].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}
function authed(request, env) {
  const pw = env.ADMIN_PASSWORD || "";
  if (!pw) return false;
  const h = request.headers.get("Authorization") || "";
  return safeEqual(h.startsWith("Bearer ") ? h.slice(7) : "", pw);
}

async function readIndex(env) {
  const o = await env.BUCKET.get("index.json");
  return o ? JSON.parse(await o.text()) : { pieces: [] };
}
const writeIndex = (env, idx) =>
  env.BUCKET.put("index.json", JSON.stringify(idx), { httpMetadata: { contentType: "application/json" } });

async function readBody(request) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_BYTES) return { error: fail("File is too large (limit 90 MB)", 413) };
  const buf = await request.arrayBuffer();
  if (!buf.byteLength) return { error: fail("Empty file") };
  if (buf.byteLength > MAX_BYTES) return { error: fail("File is too large (limit 90 MB)", 413) };
  return { buf };
}

const starts = (u, ...bytes) => bytes.every((v, i) => u[i] === v);
function sniffScore(u) {
  if (starts(u, 0x25, 0x50, 0x44, 0x46)) return { type: "pdf", mime: "application/pdf" };
  if (starts(u, 0x89, 0x50, 0x4e, 0x47)) return { type: "png", mime: "image/png" };
  if (starts(u, 0xff, 0xd8, 0xff)) return { type: "jpg", mime: "image/jpeg" };
  if (starts(u, 0x52, 0x49, 0x46, 0x46) && u[8] === 0x57 && u[9] === 0x45 && u[10] === 0x42 && u[11] === 0x50)
    return { type: "webp", mime: "image/webp" };
  return null;
}
const isMp3 = (u) => starts(u, 0x49, 0x44, 0x33) || (u[0] === 0xff && (u[1] & 0xe0) === 0xe0);
const head = (buf) => new Uint8Array(buf, 0, Math.min(12, buf.byteLength));

async function serveFile(request, env, key) {
  if (!key.startsWith("pieces/") || key.split("/").includes("..")) return fail("Not found", 404);
  const obj = await env.BUCKET.get(key, { range: request.headers });
  if (!obj) return fail("Not found", 404);
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set("etag", obj.httpEtag);
  h.set("accept-ranges", "bytes");
  h.set("x-content-type-options", "nosniff");
  let status = 200;
  if (obj.range && request.headers.has("range")) {
    let o = obj.range.offset ?? 0, l = obj.range.length ?? obj.size - o;
    if (obj.range.suffix !== undefined) { l = Math.min(obj.range.suffix, obj.size); o = obj.size - l; }
    h.set("content-range", `bytes ${o}-${o + l - 1}/${obj.size}`);
    h.set("content-length", String(l));
    status = 206;
  } else {
    h.set("content-length", String(obj.size));
  }
  return new Response(request.method === "HEAD" ? null : obj.body, { status, headers: h });
}

async function onRequest({ request, env }) {
  if (!env.BUCKET) return fail("R2 binding BUCKET is missing. See README.", 500);
  const url = new URL(request.url);
  const seg = url.pathname.split("/").filter(Boolean).slice(1).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
  const method = request.method;

  try {
    // ---- public reads
    if (seg[0] === "files" && (method === "GET" || method === "HEAD"))
      return serveFile(request, env, seg.slice(1).join("/"));
    if (seg[0] === "pieces" && seg.length === 1 && method === "GET") {
      const idx = await readIndex(env);
      return json(sortPieces(idx.pieces));
    }

    // ---- everything below needs the admin password
    if (!authed(request, env))
      return fail(env.ADMIN_PASSWORD ? "Wrong or missing password" : "ADMIN_PASSWORD is not set", 401);
    if (seg[0] === "login" && method === "POST") return json({ ok: true });
    if (seg[0] !== "pieces") return fail("Not found", 404);

    const idx = await readIndex(env);

    // create piece
    if (seg.length === 1 && method === "POST") {
      const b = await request.json().catch(() => ({}));
      const title = clean(b.title, 120);
      if (!title) return fail("Title is required");
      const piece = {
        id: newId(),
        group: clean(b.group, 60) || "Songs",
        part: clean(b.part, 60),
        title,
        sub: clean(b.sub, 120),
        order: idx.pieces.reduce((m, p) => Math.max(m, p.order), 0) + 1,
        score: null,
        tracks: [],
        createdAt: Date.now(),
      };
      idx.pieces.push(piece);
      await writeIndex(env, idx);
      return json(piece, 201);
    }

    // reorder
    if (seg[1] === "reorder" && seg.length === 2 && method === "POST") {
      const b = await request.json().catch(() => ({}));
      const ids = Array.isArray(b.ids) ? b.ids : [];
      const rank = new Map(ids.map((id, i) => [id, i]));
      sortPieces(idx.pieces).forEach((p, i) => (p.order = rank.has(p.id) ? rank.get(p.id) : ids.length + i));
      await writeIndex(env, idx);
      return json({ ok: true });
    }

    const piece = idx.pieces.find((p) => p.id === seg[1]);
    if (!piece) return fail("Piece not found", 404);

    // edit / delete piece
    if (seg.length === 2 && method === "PATCH") {
      const b = await request.json().catch(() => ({}));
      if ("title" in b) { const t = clean(b.title, 120); if (!t) return fail("Title is required"); piece.title = t; }
      if ("part" in b) piece.part = clean(b.part, 60);
      if ("sub" in b) piece.sub = clean(b.sub, 120);
      if ("group" in b) piece.group = clean(b.group, 60) || "Songs";
      await writeIndex(env, idx);
      return json(piece);
    }
    if (seg.length === 2 && method === "DELETE") {
      const keys = [piece.score?.key, ...piece.tracks.map((t) => t.key)].filter(Boolean);
      idx.pieces = idx.pieces.filter((p) => p.id !== piece.id);
      await writeIndex(env, idx);
      if (keys.length) await env.BUCKET.delete(keys);
      return json({ ok: true });
    }

    // score (PDF / PNG / JPG / WebP)
    if (seg[2] === "score" && seg.length === 3) {
      if (method === "PUT") {
        const r = await readBody(request);
        if (r.error) return r.error;
        const kind = sniffScore(head(r.buf));
        if (!kind) return fail("Score must be a PDF, PNG, JPG or WebP file");
        const key = `pieces/${piece.id}/score-${Date.now()}.${kind.type}`;
        await env.BUCKET.put(key, r.buf, { httpMetadata: { contentType: kind.mime, cacheControl: CACHE } });
        const old = piece.score?.key;
        piece.score = { key, type: kind.type, name: clean(url.searchParams.get("name"), 120) || `score.${kind.type}`, size: r.buf.byteLength };
        await writeIndex(env, idx);
        if (old) await env.BUCKET.delete(old);
        return json(piece);
      }
      if (method === "DELETE") {
        const old = piece.score?.key;
        piece.score = null;
        await writeIndex(env, idx);
        if (old) await env.BUCKET.delete(old);
        return json(piece);
      }
    }

    // MP3 practice tracks
    if (seg[2] === "tracks") {
      if (seg.length === 3 && method === "POST") {
        if (piece.tracks.length >= MAX_TRACKS) return fail(`A piece can have up to ${MAX_TRACKS} tracks`);
        const r = await readBody(request);
        if (r.error) return r.error;
        if (!isMp3(head(r.buf))) return fail("Tracks must be MP3 files");
        const v = url.searchParams.get("voice");
        const tid = newId();
        const key = `pieces/${piece.id}/tracks/${tid}.mp3`;
        await env.BUCKET.put(key, r.buf, { httpMetadata: { contentType: "audio/mpeg", cacheControl: CACHE } });
        piece.tracks.push({
          id: tid, key, voice: VOICES.includes(v) ? v : "Other",
          name: clean(url.searchParams.get("name"), 60) || "Track", size: r.buf.byteLength,
        });
        await writeIndex(env, idx);
        return json(piece);
      }
      if (seg.length === 4) {
        const t = piece.tracks.find((x) => x.id === seg[3]);
        if (!t) return fail("Track not found", 404);
        if (method === "PATCH") {
          const b = await request.json().catch(() => ({}));
          if (VOICES.includes(b.voice)) t.voice = b.voice;
          if ("name" in b) t.name = clean(b.name, 60) || t.name;
          await writeIndex(env, idx);
          return json(piece);
        }
        if (method === "DELETE") {
          piece.tracks = piece.tracks.filter((x) => x.id !== t.id);
          await writeIndex(env, idx);
          await env.BUCKET.delete(t.key);
          return json(piece);
        }
      }
    }

    return fail("Not found", 404);
  } catch (e) {
    return fail(e.message || "Server error", 500);
  }
}

// ---- Worker entry point (used by `wrangler deploy`) ----
// /api/* goes to the API above; everything else is served from ./public.
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/")) return onRequest({ request, env });
    return env.ASSETS.fetch(request);
  },
};
