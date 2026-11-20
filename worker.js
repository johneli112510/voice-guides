// Voice Guides API: Cloudflare Pages Function handling every /api/* request.
// Storage: one R2 bucket (binding BUCKET). index.json holds piece metadata,
// uploaded scores and MP3s live under pieces/<id>/...
// Reading is public. Changing anything needs the ADMIN_PASSWORD secret.

const VOICES = ["Soprano", "Alto", "Tenor", "Bass", "Other"];
const MAX_TRACKS = 10;
const MAX_LINKS = 20;
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

// Accepts youtube.com/watch, youtu.be, /shorts, /embed, /live and playlist links.
function parseYouTube(raw) {
  raw = raw.trim();
  let u;
  try { u = new URL(raw); } catch { try { u = new URL("https://" + raw); } catch { return null; } }
  const h = u.hostname.replace(/^www\./, "").replace(/^m\./, "");
  let id = null, list = u.searchParams.get("list");
  if (h === "youtu.be") id = u.pathname.slice(1).split("/")[0];
  else if (h === "youtube.com" || h === "music.youtube.com") {
    if (u.pathname === "/watch") id = u.searchParams.get("v");
    else { const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([\w-]{11})/); if (m) id = m[2]; }
  } else return null;
  if (id && !/^[\w-]{11}$/.test(id)) id = null;
  if (list && !/^[\w-]{10,60}$/.test(list)) list = null;
  return id || list ? { id, list } : null;
}
const ytUrl = (y) =>
  y.id ? `https://www.youtube.com/watch?v=${y.id}${y.list ? "&list=" + y.list : ""}` : `https://www.youtube.com/playlist?list=${y.list}`;

function ytFrom(raw) {
  const y = parseYouTube(String(raw || ""));
  return y ? { vid: y.id, list: y.list, url: ytUrl(y) } : null;
}

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
        links: [],
        yt: null,
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
      if ("yt" in b) {
        const raw = clean(b.yt, 300);
        if (!raw) piece.yt = null;
        else {
          const y = ytFrom(raw);
          if (!y) return fail("That doesn't look like a YouTube video or playlist link");
          piece.yt = y;
        }
      }
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

    // YouTube practice guide links
    if (seg[2] === "links") {
      piece.links = piece.links || [];
      if (seg.length === 3 && method === "POST") {
        if (piece.links.length >= MAX_LINKS) return fail(`A piece can have up to ${MAX_LINKS} links`);
        const b = await request.json().catch(() => ({}));
        const yt = parseYouTube(String(b.url || ""));
        if (!yt) return fail("That doesn't look like a YouTube video or playlist link");
        piece.links.push({
          id: newId(), vid: yt.id, list: yt.list,
          voice: VOICES.includes(b.voice) ? b.voice : "Other",
          label: clean(b.label, 60), url: ytUrl(yt),
        });
        await writeIndex(env, idx);
        return json(piece);
      }
      if (seg.length === 4) {
        const l = piece.links.find((x) => x.id === seg[3]);
        if (!l) return fail("Link not found", 404);
        if (method === "PATCH") {
          const b = await request.json().catch(() => ({}));
          if (VOICES.includes(b.voice)) l.voice = b.voice;
          if ("label" in b) l.label = clean(b.label, 60);
          await writeIndex(env, idx);
          return json(piece);
        }
        if (method === "DELETE") {
          piece.links = piece.links.filter((x) => x.id !== l.id);
          await writeIndex(env, idx);
          return json(piece);
        }
      }
    }

    return fail("Not found", 404);
  } catch (e) {
    return fail(e.message || "Server error", 500);
  }
}

// ---- The web page (embedded so no separate files or folders are needed) ----
// To change the site title, edit SITE_TITLE / SITE_SUB inside this string.
const INDEX_HTML = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<meta name=\"color-scheme\" content=\"light\">\n<meta name=\"theme-color\" content=\"#ffffff\">\n<title>Voice Guides</title>\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n<link href=\"https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Atkinson+Hyperlegible:wght@400;700&display=swap\" rel=\"stylesheet\">\n<script src=\"https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js\"></script>\n<style>\n/* Layout idea: a night-before-dawn songbook. Lineup list -> song page (tracks, study links, score). One player docked at the bottom. */\n:root {\n  --bg: #ffffff;\n  --surface: #ffffff;\n  --ink: #1b1a2e;\n  --muted: #5f5d76;\n  --line: #e2e0ea;\n  --accent: #b5172f;      /* parol red */\n  --gold: #956300;\n  --chip: #f3f2f7;\n  --night: #ffffff;       /* header and player are white too */\n  --on-night: #1b1a2e;\n  --display: \"Bricolage Grotesque\", \"Segoe UI\", system-ui, sans-serif;\n  --body: \"Atkinson Hyperlegible\", \"Segoe UI\", system-ui, sans-serif;\n  color-scheme: light;\n}\n* { box-sizing: border-box; }\nhtml, body { margin: 0; }\nbody { background: var(--bg); color: var(--ink); font-family: var(--body); font-size: 16px; line-height: 1.45; padding-bottom: 120px; }\na { color: inherit; }\nbutton { font: inherit; color: inherit; }\n:focus-visible { outline: 3px solid var(--gold); outline-offset: 2px; }\n\n.masthead { background: var(--night); color: var(--on-night); padding: 28px 18px 22px; }\n.masthead .wrap { max-width: 760px; margin: 0 auto; display: grid; gap: 6px; }\n.eyebrow { font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: var(--gold); font-weight: 700; }\n.masthead h1 { font-family: var(--display); font-weight: 800; font-size: clamp(28px, 7vw, 40px); line-height: 1.05; margin: 0; text-wrap: balance; }\n.masthead p { margin: 0; opacity: .82; font-size: 15px; }\n.star { width: 26px; height: 26px; vertical-align: -4px; margin-right: 6px; }\n\nmain { max-width: 760px; margin: 0 auto; padding: 0 16px; }\n.controls { display: grid; gap: 12px; margin: 18px 0 8px; }\n.seg { display: inline-flex; background: var(--chip); border-radius: 999px; padding: 4px; gap: 4px; }\n.seg button { border: 0; background: transparent; padding: 8px 16px; border-radius: 999px; cursor: pointer; font-weight: 700; color: var(--muted); }\n.seg button[aria-pressed=\"true\"] { background: var(--surface); color: var(--ink); box-shadow: 0 1px 3px rgba(0,0,0,.12); }\n.voice { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }\n.voice span { font-size: 13px; color: var(--muted); margin-right: 4px; }\n.voice button { border: 1px solid var(--line); background: var(--surface); border-radius: 999px; padding: 5px 12px; cursor: pointer; font-size: 14px; }\n.voice button[aria-pressed=\"true\"] { background: var(--accent); border-color: var(--accent); color: #fff; }\n\n.list { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 8px; }\n.row { display: grid; grid-template-columns: 34px 1fr auto; gap: 12px; align-items: center; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; text-decoration: none; }\n.row:hover { border-color: var(--gold); }\n.num { font-family: var(--display); font-weight: 800; font-size: 20px; color: var(--accent); font-variant-numeric: tabular-nums; }\n.row .part { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); font-weight: 700; }\n.row .title { font-family: var(--display); font-weight: 600; font-size: 18px; line-height: 1.2; }\n.row .meta { font-size: 13px; color: var(--muted); }\n.row .go { color: var(--muted); font-size: 22px; }\n\n.song-head { display: grid; gap: 4px; margin: 18px 0 14px; }\n.back { display: inline-flex; align-items: center; gap: 6px; text-decoration: none; color: var(--muted); font-weight: 700; font-size: 14px; margin-top: 16px; }\n.song-head h2 { font-family: var(--display); font-weight: 800; font-size: clamp(26px, 6vw, 34px); margin: 0; line-height: 1.1; text-wrap: balance; }\n.song-head .sub { color: var(--muted); }\n.panel { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 14px; display: grid; gap: 10px; margin-bottom: 12px; }\n.panel h3 { margin: 0; font-size: 13px; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); }\n.btns { display: flex; flex-wrap: wrap; gap: 8px; }\n.track { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--line); background: var(--chip); border-radius: 999px; padding: 8px 14px 8px 10px; cursor: pointer; font-weight: 700; font-size: 15px; }\n.track .ic { width: 22px; height: 22px; border-radius: 50%; background: var(--accent); display: grid; place-items: center; }\n.track .ic svg { width: 10px; height: 10px; fill: #fff; }\n.track.mine { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent) inset; }\n.track.playing { background: var(--accent); color: #fff; border-color: var(--accent); }\n.track.playing .ic { background: #fff; }\n.track.playing .ic svg { fill: var(--accent); }\n.yt { display: inline-flex; align-items: center; gap: 8px; text-decoration: none; border: 1px solid var(--line); border-radius: 999px; padding: 7px 14px 7px 10px; font-size: 15px; }\n.yt.mine { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent) inset; }\n.yt svg { width: 22px; height: 16px; flex: none; }\n.none { color: var(--muted); font-size: 14px; margin: 0; }\n.dl { margin-top: 18px; }\n.dlmsg { margin: 0; font-size: 14px; color: var(--muted); min-height: 1em; }\n.dlb { border: 0; cursor: pointer; text-align: left; font: inherit; display: inline-flex; align-items: center; gap: 10px; text-decoration: none; background: var(--night); color: var(--on-night); border-radius: 12px; padding: 10px 16px 10px 12px; font-weight: 700; }\n.dlb svg { width: 22px; height: 22px; color: var(--gold); flex: none; }\n.dlb span { display: grid; line-height: 1.2; }\n.dlb small { font-weight: 400; font-size: 12px; opacity: .8; }\n.score { display: grid; gap: 12px; margin-top: 4px; }\n.score figure { margin: 0; background: #fff; border-radius: 8px; border: 1px solid var(--line); overflow: hidden; }\n.score img { display: block; width: 100%; height: auto; }\n.score figcaption { font-size: 12px; color: #666; padding: 4px 10px; border-top: 1px solid #eee; background: #fafafa; }\n.pager { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 16px 0; }\n.pager a { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 12px; text-decoration: none; display: grid; gap: 2px; }\n.pager a.next { text-align: right; }\n.pager small { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }\n.pager span { font-weight: 700; }\n.hint { font-size: 13px; color: var(--muted); margin: 14px 0 0; }\n\n.player { position: fixed; left: 0; right: 0; bottom: 0; background: var(--night); color: var(--on-night); padding: 10px 14px calc(10px + env(safe-area-inset-bottom)); box-shadow: 0 -6px 20px rgba(0,0,0,.25); display: none; }\n.player.on { display: block; }\n.player .wrap { max-width: 760px; margin: 0 auto; display: grid; grid-template-columns: auto 1fr auto; gap: 10px 12px; align-items: center; }\n.pbtn { width: 46px; height: 46px; border-radius: 50%; border: 0; background: var(--gold); display: grid; place-items: center; cursor: pointer; }\n.pbtn svg { width: 18px; height: 18px; fill: #1b1a2e; }\n.pinfo { min-width: 0; }\n.pinfo .t { font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.pinfo .s { font-size: 12px; opacity: .75; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.ptools { display: flex; gap: 6px; }\n.ptools button { border: 1px solid rgba(255,255,255,.3); background: transparent; color: var(--on-night); border-radius: 8px; padding: 6px 9px; font-size: 13px; cursor: pointer; font-weight: 700; }\n.ptools button[aria-pressed=\"true\"] { background: var(--on-night); color: #1b1a2e; }\n.seek { grid-column: 1 / -1; display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: center; font-size: 12px; font-variant-numeric: tabular-nums; }\n.seek input { width: 100%; accent-color: var(--gold); }\n@media (prefers-reduced-motion: no-preference) { .row, .track { transition: border-color .15s, background .15s; } }\n/* ---- additions for uploads / viewer ---- */\n.admbtn { justify-self: start; margin-top: 8px; background: transparent; border: 1px solid rgba(255,255,255,.35); color: var(--on-night); border-radius: 999px; padding: 5px 12px; font-size: 13px; cursor: pointer; }\n.btn { border: 1px solid var(--line); background: var(--surface); border-radius: 10px; padding: 8px 14px; cursor: pointer; font-weight: 700; }\n.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }\n.btn.danger { color: var(--accent); border-color: var(--accent); }\n.btn.small { padding: 4px 10px; font-size: 13px; }\n.btn:disabled, .dlb:disabled { opacity: .5; cursor: default; }\nlabel.f { display: grid; gap: 4px; font-size: 13px; color: var(--muted); font-weight: 700; }\ninput[type=text], input[type=password], select { font: inherit; padding: 9px 10px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); color: var(--ink); width: 100%; }\ninput[type=file] { font: inherit; max-width: 100%; }\n.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }\n@media (max-width: 520px) { .grid2 { grid-template-columns: 1fr; } }\n.rowli { display: flex; gap: 8px; align-items: stretch; }\n.rowli .row { flex: 1; min-width: 0; }\n.mv { display: grid; gap: 6px; align-content: center; }\n.mv button { border: 1px solid var(--line); background: var(--surface); border-radius: 8px; width: 34px; height: 30px; cursor: pointer; }\n.vbar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }\n.vbar button, .vbar .obtn { border: 1px solid var(--line); background: var(--chip); border-radius: 8px; padding: 6px 11px; cursor: pointer; font-weight: 700; font-size: 14px; text-decoration: none; }\n.vbar .pg { font-size: 14px; min-width: 52px; text-align: center; font-variant-numeric: tabular-nums; }\n.vbar .sep { width: 8px; }\n.vwrap { overflow: auto; max-height: 82vh; background: #fff; border: 1px solid var(--line); border-radius: 8px; min-height: 120px; }\n.vwrap canvas { display: block; margin: 0 auto; }\n.vwrap .none { padding: 20px; color: #666; }\n.trrow { display: grid; grid-template-columns: 1fr 120px auto; gap: 8px; align-items: center; font-size: 14px; }\n.trrow .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.bar { height: 6px; background: var(--chip); border-radius: 3px; overflow: hidden; display: none; }\n.bar i { display: block; height: 100%; background: var(--accent); width: 0; }\n.err { color: var(--accent); }\ndialog { border: 1px solid var(--line); border-radius: 14px; background: var(--surface); color: var(--ink); padding: 18px; max-width: 340px; width: 90%; }\ndialog::backdrop { background: rgba(0,0,0,.5); }\ndialog form { display: grid; gap: 12px; }\n.ytb { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--line); background: var(--chip); border-radius: 12px; padding: 10px 14px; font: inherit; font-weight: 700; cursor: pointer; color: var(--ink); }\n.ytb.mine { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent) inset; }\n.ytb[aria-pressed=\"true\"] { background: var(--accent); border-color: var(--accent); color: #fff; }\n.yframe { position: relative; aspect-ratio: 16 / 9; width: 100%; margin-top: 12px; border-radius: 10px; overflow: hidden; background: #000; }\n.yframe iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }\n/* ---- light theme adjustments (header and player are white, not dark) ---- */\n.masthead { border-bottom: 1px solid var(--line); }\n.player { border-top: 1px solid var(--line); box-shadow: 0 -4px 16px rgba(0,0,0,.08); }\n.pbtn { background: var(--accent); }\n.pbtn svg { fill: #fff; }\n.ptools button { border: 1px solid var(--line); background: var(--surface); color: var(--ink); }\n.ptools button[aria-pressed=\"true\"] { background: var(--accent); border-color: var(--accent); color: #fff; }\n.admbtn { border: 1px solid var(--line); background: var(--surface); color: var(--ink); }\n.dlb { border: 1px solid var(--line); }\n.seek input { accent-color: var(--accent); }\n</style>\n</head>\n<body>\n<header class=\"masthead\">\n  <div class=\"wrap\">\n    <div class=\"eyebrow\">Practice page</div>\n    <h1 id=\"site-title\"></h1>\n    <p id=\"site-sub\"></p>\n    <button class=\"admbtn\" id=\"adm\"></button>\n  </div>\n</header>\n<main id=\"app\"></main>\n\n<dialog id=\"login\">\n  <form id=\"lf\">\n    <h3 style=\"margin:0\">Admin login</h3>\n    <label class=\"f\">Password<input type=\"password\" id=\"lpw\" autocomplete=\"current-password\" required></label>\n    <p class=\"none err\" id=\"lerr\"></p>\n    <div class=\"btns\"><button class=\"btn primary\" type=\"submit\">Log in</button><button class=\"btn\" type=\"button\" id=\"lcancel\">Cancel</button></div>\n  </form>\n</dialog>\n\n<div class=\"player\" id=\"player\" aria-live=\"polite\">\n  <div class=\"wrap\">\n    <button class=\"pbtn\" id=\"pp\" aria-label=\"Pause\"></button>\n    <div class=\"pinfo\"><div class=\"t\" id=\"pt\"></div><div class=\"s\" id=\"ps\"></div></div>\n    <div class=\"ptools\">\n      <button id=\"spd\" aria-label=\"Playback speed\">1×</button>\n      <button id=\"lp\" aria-pressed=\"false\" aria-label=\"Repeat track\">Repeat</button>\n      <button id=\"cl\" aria-label=\"Close player\">✕</button>\n    </div>\n    <div class=\"seek\"><span id=\"cur\">0:00</span><input type=\"range\" id=\"sk\" min=\"0\" max=\"1000\" value=\"0\" aria-label=\"Seek\"><span id=\"dur\">0:00</span></div>\n  </div>\n  <audio id=\"au\" preload=\"none\"></audio>\n</div>\n\n<script>\n/* ===== settings you can edit ===== */\nconst SITE_TITLE = \"Voice Guides\";\nconst SITE_SUB = \"Sheet music, rehearsal tracks and vocal practice guides\";\nconst MAX_TRACKS = 10;\n/* ================================= */\n\nconst VOICES = [\"Soprano\", \"Alto\", \"Tenor\", \"Bass\", \"Other\"];\nconst FILTER = [\"All\", \"Soprano\", \"Alto\", \"Tenor\", \"Bass\"];\nconst PLAY = '<svg viewBox=\"0 0 10 10\"><path d=\"M1 0l9 5-9 5z\"/></svg>';\nconst PAUSE = '<svg viewBox=\"0 0 10 10\"><path d=\"M1 0h3v10H1zM6 0h3v10H6z\"/></svg>';\nconst $ = s => document.querySelector(s);\nconst app = $(\"#app\");\nconst esc = s => String(s ?? \"\").replace(/[&<>\"]/g, c => ({\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",'\"':\"&quot;\"}[c]));\nconst store = { get(k, d) { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };\nconst fileUrl = k => \"/api/files/\" + k.split(\"/\").map(encodeURIComponent).join(\"/\");\n\ndocument.title = SITE_TITLE;\n$(\"#site-title\").textContent = SITE_TITLE;\n$(\"#site-sub\").textContent = SITE_SUB;\n\nlet pieces = [], loadError = \"\", pw = store.get(\"vg-pw\", \"\"), admin = false;\nlet voice = store.get(\"vg-voice\", \"All\"), group = null, viewer = null;\n\n/* ---------- api ---------- */\nasync function api(path, opts = {}) {\n  const h = new Headers(opts.headers || {});\n  if (pw) h.set(\"Authorization\", \"Bearer \" + pw);\n  if (opts.body && typeof opts.body === \"string\") h.set(\"Content-Type\", \"application/json\");\n  const r = await fetch(\"/api\" + path, { ...opts, headers: h });\n  let data = null; try { data = await r.json(); } catch (e) {}\n  if (!r.ok) throw new Error((data && data.error) || r.statusText || \"Request failed\");\n  return data;\n}\nconst send = (method, path, obj) => api(path, { method, body: obj ? JSON.stringify(obj) : undefined });\nfunction upload(method, path, file, onprog) {\n  return new Promise((res, rej) => {\n    const x = new XMLHttpRequest();\n    x.open(method, \"/api\" + path);\n    x.setRequestHeader(\"Authorization\", \"Bearer \" + pw);\n    x.upload.onprogress = e => { if (e.lengthComputable && onprog) onprog(e.loaded / e.total); };\n    x.onload = () => { let b = {}; try { b = JSON.parse(x.responseText); } catch (e) {} x.status >= 200 && x.status < 300 ? res(b) : rej(new Error(b.error || x.statusText || \"Upload failed\")); };\n    x.onerror = () => rej(new Error(\"Network error\"));\n    x.send(file);\n  });\n}\nasync function refresh() {\n  try { pieces = await api(\"/pieces\"); loadError = \"\"; }\n  catch (e) { pieces = []; loadError = e.message; }\n}\nasync function reload() { await refresh(); route(); }\n\n/* ---------- admin login ---------- */\nfunction updateAdminBtn() { $(\"#adm\").textContent = admin ? \"Admin mode on · Log out\" : \"Admin login\"; }\n$(\"#adm\").onclick = () => {\n  if (admin) { admin = false; pw = \"\"; store.set(\"vg-pw\", \"\"); updateAdminBtn(); route(); return; }\n  $(\"#lerr\").textContent = \"\"; $(\"#lpw\").value = \"\"; $(\"#login\").showModal(); $(\"#lpw\").focus();\n};\n$(\"#lcancel\").onclick = () => $(\"#login\").close();\n$(\"#lf\").onsubmit = async e => {\n  e.preventDefault();\n  const old = pw; pw = $(\"#lpw\").value;\n  try { await send(\"POST\", \"/login\"); admin = true; store.set(\"vg-pw\", pw); $(\"#login\").close(); updateAdminBtn(); route(); }\n  catch (err) { pw = old; $(\"#lerr\").textContent = err.message; }\n};\n\n/* ---------- voice filter (updates in place, no re-render) ---------- */\nfunction voiceBar() {\n  return `<div class=\"voice\" role=\"group\" aria-label=\"My voice part\"><span>My part</span>${FILTER.map(v => `<button data-voice=\"${v}\" aria-pressed=\"${voice === v}\">${v}</button>`).join(\"\")}</div>`;\n}\nfunction applyVoice() {\n  document.querySelectorAll(\"[data-voice]\").forEach(b => { if (b.tagName === \"BUTTON\" && b.closest(\".voice\")) b.setAttribute(\"aria-pressed\", b.dataset.voice === voice); });\n  document.querySelectorAll(\".track, .ytb\").forEach(b => b.classList.toggle(\"mine\", voice !== \"All\" && b.dataset.voice === voice));\n}\nfunction bindVoice() {\n  app.querySelectorAll(\".voice [data-voice]\").forEach(b => b.onclick = () => { voice = b.dataset.voice; store.set(\"vg-voice\", voice); applyVoice(); });\n}\n\n/* ---------- home ---------- */\nfunction home() {\n  const groups = [...new Set(pieces.map(p => p.group))];\n  if (!group || !groups.includes(group)) group = groups[0] || null;\n  const list = pieces.filter(p => p.group === group);\n  app.innerHTML = `\n    ${loadError ? `<p class=\"none err\" style=\"margin-top:16px\">Could not load songs: ${esc(loadError)}</p>` : \"\"}\n    ${pieces.length ? `<div class=\"controls\">\n      ${groups.length > 1 ? `<div class=\"seg\" role=\"group\" aria-label=\"Song list\">${groups.map(g => `<button data-g=\"${esc(g)}\" aria-pressed=\"${g === group}\">${esc(g)} · ${pieces.filter(p => p.group === g).length}</button>`).join(\"\")}</div>` : \"\"}\n      ${voiceBar()}\n    </div>` : \"\"}\n    ${list.length ? `<ol class=\"list\">${list.map((p, i) => `\n      <li class=\"rowli\"><a class=\"row\" href=\"#/p/${p.id}\">\n        <span class=\"num\">${i + 1}</span>\n        <span>${p.part ? `<span class=\"part\">${esc(p.part)}</span><br>` : \"\"}<span class=\"title\">${esc(p.title)}</span><br>\n        <span class=\"meta\">${[p.sub, p.score ? \"Score\" : \"\", p.tracks.length ? p.tracks.length + \" practice track\" + (p.tracks.length > 1 ? \"s\" : \"\") : \"\", (p.links || []).length ? p.links.length + \" YouTube guide\" + (p.links.length > 1 ? \"s\" : \"\") : (p.yt ? \"YouTube video\" : \"\")].filter(Boolean).map(esc).join(\" · \") || \"Nothing uploaded yet\"}</span></span>\n        <span class=\"go\" aria-hidden=\"true\">›</span></a>\n        ${admin ? `<div class=\"mv\"><button data-mv=\"${p.id}\" data-d=\"-1\" aria-label=\"Move up\" ${i === 0 ? \"disabled\" : \"\"}>↑</button><button data-mv=\"${p.id}\" data-d=\"1\" aria-label=\"Move down\" ${i === list.length - 1 ? \"disabled\" : \"\"}>↓</button></div>` : \"\"}\n      </li>`).join(\"\")}</ol>`\n      : !loadError ? `<p class=\"none\" style=\"margin-top:20px\">${admin ? \"No pieces yet. Add your first one below.\" : \"No songs have been added yet.\"}</p>` : \"\"}\n    ${admin ? `<section class=\"panel\" style=\"margin-top:16px\"><h3>Add a piece</h3>\n      <form id=\"addf\" style=\"display:grid;gap:10px\">\n        <div class=\"grid2\">\n          <label class=\"f\">Title<input type=\"text\" id=\"ntitle\" required maxlength=\"120\"></label>\n          <label class=\"f\">Part of the service (optional)<input type=\"text\" id=\"npart\" maxlength=\"60\" placeholder=\"e.g. Entrance, Gloria\"></label>\n          <label class=\"f\">Composer / note (optional)<input type=\"text\" id=\"nsub\" maxlength=\"120\"></label>\n          <label class=\"f\">List<input type=\"text\" id=\"ngroup\" maxlength=\"60\" list=\"glist\" value=\"${esc(group || \"Songs\")}\"><datalist id=\"glist\">${groups.map(g => `<option value=\"${esc(g)}\">`).join(\"\")}</datalist></label>\n        </div>\n        <div class=\"btns\"><button class=\"btn primary\" type=\"submit\">Add piece</button></div>\n        <p class=\"none err\" id=\"addmsg\"></p>\n      </form></section>` : \"\"}`;\n  app.querySelectorAll(\"[data-g]\").forEach(b => b.onclick = () => { group = b.dataset.g; home(); });\n  app.querySelectorAll(\"[data-mv]\").forEach(b => b.onclick = async () => {\n    const ids = pieces.map(p => p.id), a = ids.indexOf(b.dataset.mv);\n    const grp = pieces.filter(p => p.group === group).map(p => p.id), gi = grp.indexOf(b.dataset.mv);\n    const other = grp[gi + Number(b.dataset.d)]; if (!other) return;\n    const c = ids.indexOf(other); [ids[a], ids[c]] = [ids[c], ids[a]];\n    try { await send(\"POST\", \"/pieces/reorder\", { ids }); await reload(); } catch (e) { alert(e.message); }\n  });\n  const f = $(\"#addf\");\n  if (f) f.onsubmit = async e => {\n    e.preventDefault();\n    try {\n      const p = await send(\"POST\", \"/pieces\", { title: $(\"#ntitle\").value, part: $(\"#npart\").value, sub: $(\"#nsub\").value, group: $(\"#ngroup\").value });\n      group = p.group; await refresh(); location.hash = \"#/p/\" + p.id;\n    } catch (err) { $(\"#addmsg\").textContent = err.message; }\n  };\n  bindVoice();\n}\n\n/* ---------- piece page ---------- */\nconst trackLabel = (t, all) => (t.voice === \"Other\" || all.filter(x => x.voice === t.voice).length > 1) ? `${t.voice} · ${t.name}` : t.voice;\n\nconst linkLabel = l => l.label || (l.voice === \"Other\" ? \"Practice guide\" : l.voice + \" guide\");\n\nfunction piece(p) {\n  const list = pieces.filter(x => x.group === p.group), i = list.findIndex(x => x.id === p.id);\n  const prev = list[i - 1], next = list[i + 1];\n  const ylinks = [...(p.links || [])].sort((a, b) => VOICES.indexOf(a.voice) - VOICES.indexOf(b.voice));\n  const tracks = [...p.tracks].sort((a, b) => VOICES.indexOf(a.voice) - VOICES.indexOf(b.voice));\n  app.innerHTML = `\n    <a class=\"back\" href=\"#/\">‹ ${esc(p.group)}</a>\n    <div class=\"song-head\">\n      <div class=\"eyebrow\" style=\"color:var(--accent)\">${i + 1}${p.part ? \" · \" + esc(p.part) : \"\"}</div>\n      <h2>${esc(p.title)}</h2>${p.sub ? `<div class=\"sub\">${esc(p.sub)}</div>` : \"\"}\n    </div>\n    <div class=\"controls\">${voiceBar()}</div>\n    <section class=\"panel\"><h3>Listen</h3>\n      ${tracks.length ? `<div class=\"btns\">${tracks.map(t => `<button class=\"track${voice !== \"All\" && voice === t.voice ? \" mine\" : \"\"}\" data-voice=\"${t.voice}\" data-src=\"${fileUrl(t.key)}\" data-label=\"${esc(trackLabel(t, tracks))}\"><span class=\"ic\">${PLAY}</span>${esc(trackLabel(t, tracks))}</button>`).join(\"\")}</div>`\n        : `<p class=\"none\">No practice tracks for this piece yet.</p>`}\n    </section>\n    ${(ylinks.length || p.yt) ? `<section class=\"panel\"><h3>Watch on YouTube</h3>\n      <div class=\"btns\">${p.yt ? `<button class=\"ytb\" data-lid=\"piece\" aria-pressed=\"false\">▶ Whole piece</button>` : \"\"}${ylinks.map(l => `<button class=\"ytb${voice !== \"All\" && voice === l.voice ? \" mine\" : \"\"}\" data-voice=\"${l.voice}\" data-lid=\"${l.id}\" aria-pressed=\"false\">▶ ${esc(linkLabel(l))}</button>`).join(\"\")}</div>\n      <div id=\"yhost\"></div></section>` : \"\"}\n    <section class=\"panel\"><h3>Score</h3>\n      ${p.score ? `<div id=\"vhost\"></div>` : `<p class=\"none\">No score uploaded yet.</p>`}\n    </section>\n    <nav class=\"pager\">\n      ${prev ? `<a href=\"#/p/${prev.id}\"><small>‹ Previous</small><span>${esc(prev.title)}</span></a>` : \"<span></span>\"}\n      ${next ? `<a class=\"next\" href=\"#/p/${next.id}\"><small>Next ›</small><span>${esc(next.title)}</span></a>` : \"<span></span>\"}\n    </nav>\n    ${admin ? adminPanel(p, tracks) : \"\"}`;\n  bindVoice();\n  app.querySelectorAll(\".track\").forEach(b => b.onclick = () => play(b.dataset.src, b.dataset.label, p.title));\n  markPlaying();\n  app.querySelectorAll(\".ytb\").forEach(b => b.onclick = () => {\n    const l = b.dataset.lid === \"piece\" ? p.yt : ylinks.find(x => x.id === b.dataset.lid), host = $(\"#yhost\");\n    const wasOpen = b.getAttribute(\"aria-pressed\") === \"true\";\n    app.querySelectorAll(\".ytb\").forEach(x => x.setAttribute(\"aria-pressed\", \"false\"));\n    if (wasOpen) { host.innerHTML = \"\"; return; }\n    au.pause();\n    b.setAttribute(\"aria-pressed\", \"true\");\n    const src = l.vid ? `https://www.youtube-nocookie.com/embed/${l.vid}?rel=0${l.list ? \"&list=\" + l.list : \"\"}` : `https://www.youtube-nocookie.com/embed/videoseries?list=${l.list}`;\n    host.innerHTML = `<div class=\"yframe\"><iframe src=\"${src}\" title=\"${esc(l.voice ? linkLabel(l) : \"Whole piece\")}\" allow=\"accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share\" allowfullscreen referrerpolicy=\"strict-origin-when-cross-origin\"></iframe></div><p class=\"none\"><a href=\"${esc(l.url)}\" target=\"_blank\" rel=\"noopener\">Open on YouTube ↗</a> (use this if the video will not play here)</p>`;\n  });\n  if (p.score) viewer = mountViewer($(\"#vhost\"), p.score);\n  if (admin) bindAdmin(p, tracks);\n  window.scrollTo(0, 0);\n}\n\nfunction adminPanel(p, tracks) {\n  const left = MAX_TRACKS - p.tracks.length;\n  return `<section class=\"panel\"><h3>Admin · edit this piece</h3>\n    <form id=\"df\" style=\"display:grid;gap:10px\">\n      <div class=\"grid2\">\n        <label class=\"f\">Title<input type=\"text\" id=\"etitle\" value=\"${esc(p.title)}\" required maxlength=\"120\"></label>\n        <label class=\"f\">Part of the service<input type=\"text\" id=\"epart\" value=\"${esc(p.part)}\" maxlength=\"60\"></label>\n        <label class=\"f\">Composer / note<input type=\"text\" id=\"esub\" value=\"${esc(p.sub)}\" maxlength=\"120\"></label>\n        <label class=\"f\">List<input type=\"text\" id=\"egroup\" value=\"${esc(p.group)}\" maxlength=\"60\"></label>\n        <label class=\"f\">YouTube link for the whole piece<input type=\"text\" id=\"eyt\" value=\"${esc(p.yt ? p.yt.url : \"\")}\" maxlength=\"300\" placeholder=\"https://www.youtube.com/watch?v=...\"></label>\n      </div>\n      <div class=\"btns\"><button class=\"btn primary\" type=\"submit\">Save details</button><button class=\"btn danger\" type=\"button\" id=\"delp\">Delete piece</button></div>\n    </form>\n    <hr style=\"border:0;border-top:1px solid var(--line);width:100%\">\n    <label class=\"f\">${p.score ? \"Replace score\" : \"Upload score\"} (PDF, PNG, JPG or WebP)\n      <input type=\"file\" id=\"sf\" accept=\"application/pdf,image/png,image/jpeg,image/webp,.pdf,.png,.jpg,.jpeg,.webp\"></label>\n    <div class=\"btns\"><button class=\"btn primary\" id=\"ups\">Upload score</button>${p.score ? `<button class=\"btn danger\" id=\"rms\">Remove score</button>` : \"\"}</div>\n    <hr style=\"border:0;border-top:1px solid var(--line);width:100%\">\n    <h3 style=\"margin:0\">Practice tracks (${p.tracks.length} of ${MAX_TRACKS})</h3>\n    ${tracks.map(t => `<div class=\"trrow\"><span class=\"nm\" title=\"${esc(t.name)}\">${esc(t.name)}</span>\n      <select data-tv=\"${t.id}\" aria-label=\"Voice for ${esc(t.name)}\">${VOICES.map(v => `<option${v === t.voice ? \" selected\" : \"\"}>${v}</option>`).join(\"\")}</select>\n      <button class=\"btn small danger\" data-td=\"${t.id}\">Delete</button></div>`).join(\"\")}\n    ${left > 0 ? `<div class=\"grid2\">\n      <label class=\"f\">Voice for new tracks<select id=\"tv\">${VOICES.map(v => `<option>${v}</option>`).join(\"\")}</select></label>\n      <label class=\"f\">MP3 files (up to ${left} more)<input type=\"file\" id=\"tf\" accept=\"audio/mpeg,.mp3\" multiple></label></div>\n      <div class=\"btns\"><button class=\"btn primary\" id=\"upt\">Upload tracks</button></div>` : `<p class=\"none\">Track limit reached. Delete one to add another.</p>`}\n    <hr style=\"border:0;border-top:1px solid var(--line);width:100%\">\n    <h3 style=\"margin:0\">YouTube practice guides (${(p.links || []).length})</h3>\n    ${(p.links || []).map(l => `<div class=\"trrow\"><span class=\"nm\" title=\"${esc(l.url)}\">${esc(linkLabel(l))}</span>\n      <select data-lv=\"${l.id}\" aria-label=\"Voice for ${esc(linkLabel(l))}\">${VOICES.map(v => `<option${v === l.voice ? \" selected\" : \"\"}>${v}</option>`).join(\"\")}</select>\n      <button class=\"btn small danger\" data-ld=\"${l.id}\">Delete</button></div>`).join(\"\")}\n    <label class=\"f\">YouTube link (video or playlist)<input type=\"text\" id=\"yurl\" maxlength=\"300\" placeholder=\"https://www.youtube.com/watch?v=...\"></label>\n    <div class=\"grid2\">\n      <label class=\"f\">Voice<select id=\"yv\">${VOICES.map(v => `<option>${v}</option>`).join(\"\")}</select></label>\n      <label class=\"f\">Label (optional)<input type=\"text\" id=\"yl\" maxlength=\"60\" placeholder=\"e.g. Soprano, slow tempo\"></label></div>\n    <div class=\"btns\"><button class=\"btn primary\" id=\"yadd\">Add YouTube link</button></div>\n    <div class=\"bar\" id=\"bar\"><i></i></div>\n    <p class=\"none\" id=\"amsg\"></p>\n  </section>`;\n}\n\nfunction bindAdmin(p, tracks) {\n  const msg = (t, bad) => { const m = $(\"#amsg\"); m.textContent = t; m.className = \"none\" + (bad ? \" err\" : \"\"); };\n  const bar = $(\"#bar\"), fill = bar.querySelector(\"i\");\n  const prog = f => { bar.style.display = \"block\"; fill.style.width = Math.round(f * 100) + \"%\"; };\n  const lock = on => app.querySelectorAll(\"button, input, select\").forEach(el => { if (el.closest(\"#df, #ups, .panel:last-of-type\") || true) el.disabled = on; });\n  const run = async fn => { lock(true); try { await fn(); await reload(); } catch (e) { lock(false); msg(e.message, true); } };\n\n  $(\"#df\").onsubmit = e => { e.preventDefault(); run(() => send(\"PATCH\", \"/pieces/\" + p.id, { title: $(\"#etitle\").value, part: $(\"#epart\").value, sub: $(\"#esub\").value, group: $(\"#egroup\").value, yt: $(\"#eyt\").value })); };\n  $(\"#delp\").onclick = () => { if (confirm(`Delete \"${p.title}\" with its score and all tracks?`)) run(async () => { await send(\"DELETE\", \"/pieces/\" + p.id); location.hash = \"#/\"; }); };\n  $(\"#ups\").onclick = () => {\n    const f = $(\"#sf\").files[0]; if (!f) return msg(\"Choose a score file first.\", true);\n    msg(\"Uploading score…\"); run(() => upload(\"PUT\", `/pieces/${p.id}/score?name=${encodeURIComponent(f.name)}`, f, prog));\n  };\n  const rms = $(\"#rms\"); if (rms) rms.onclick = () => { if (confirm(\"Remove the score?\")) run(() => send(\"DELETE\", `/pieces/${p.id}/score`)); };\n  const upt = $(\"#upt\");\n  if (upt) upt.onclick = () => {\n    const files = [...$(\"#tf\").files]; if (!files.length) return msg(\"Choose one or more MP3 files first.\", true);\n    if (files.length > MAX_TRACKS - p.tracks.length) return msg(`Only ${MAX_TRACKS - p.tracks.length} more track(s) fit.`, true);\n    const v = $(\"#tv\").value;\n    run(async () => {\n      for (let n = 0; n < files.length; n++) {\n        msg(`Uploading ${n + 1} of ${files.length}: ${files[n].name}`);\n        await upload(\"POST\", `/pieces/${p.id}/tracks?voice=${encodeURIComponent(v)}&name=${encodeURIComponent(files[n].name.replace(/\\.mp3$/i, \"\"))}`, files[n], prog);\n      }\n    });\n  };\n  app.querySelectorAll(\"[data-tv]\").forEach(s => s.onchange = () => run(() => send(\"PATCH\", `/pieces/${p.id}/tracks/${s.dataset.tv}`, { voice: s.value })));\n  app.querySelectorAll(\"[data-td]\").forEach(b => b.onclick = () => { if (confirm(\"Delete this track?\")) run(() => send(\"DELETE\", `/pieces/${p.id}/tracks/${b.dataset.td}`)); });\n  $(\"#yadd\").onclick = () => { const u = $(\"#yurl\").value.trim(); if (!u) return msg(\"Paste a YouTube link first.\", true); run(() => send(\"POST\", `/pieces/${p.id}/links`, { url: u, voice: $(\"#yv\").value, label: $(\"#yl\").value })); };\n  app.querySelectorAll(\"[data-lv]\").forEach(s => s.onchange = () => run(() => send(\"PATCH\", `/pieces/${p.id}/links/${s.dataset.lv}`, { voice: s.value })));\n  app.querySelectorAll(\"[data-ld]\").forEach(b => b.onclick = () => { if (confirm(\"Delete this link?\")) run(() => send(\"DELETE\", `/pieces/${p.id}/links/${b.dataset.ld}`)); });\n}\n\n/* ---------- score viewer: PDF page by page, or image; zoom, fit width, rotate, open original ---------- */\nfunction mountViewer(host, score) {\n  const isPdf = score.type === \"pdf\";\n  const st = { page: 1, pages: 1, zoom: 1, rot: 0 };\n  let doc = null, img = null, task = null, tok = 0, dead = false;\n  host.innerHTML = `<div class=\"vbar\">\n    ${isPdf ? `<button data-a=\"prev\" aria-label=\"Previous page\">‹</button><span class=\"pg\" id=\"pgl\">1 / 1</span><button data-a=\"next\" aria-label=\"Next page\">›</button><span class=\"sep\"></span>` : \"\"}\n    <button data-a=\"out\" aria-label=\"Zoom out\">−</button><span class=\"pg\" id=\"zl\">100%</span><button data-a=\"in\" aria-label=\"Zoom in\">+</button>\n    <button data-a=\"fit\">Fit width</button><button data-a=\"rot\" aria-label=\"Rotate\">↻ Rotate</button>\n    <a class=\"obtn\" href=\"${fileUrl(score.key)}\" target=\"_blank\" rel=\"noopener\">Open original</a></div>\n    <div class=\"vwrap\" id=\"vw\" style=\"margin-top:10px\"><canvas id=\"cv\" hidden></canvas><p class=\"none\" id=\"vmsg\">Loading score…</p></div>`;\n  const vw = host.querySelector(\"#vw\"), cv = host.querySelector(\"#cv\"), vmsg = host.querySelector(\"#vmsg\");\n\n  async function render() {\n    if (dead || (isPdf ? !doc : !img)) return;\n    const my = ++tok, dpr = Math.min(window.devicePixelRatio || 1, 2), avail = Math.max(200, vw.clientWidth - 2);\n    host.querySelector(\"#zl\").textContent = Math.round(st.zoom * 100) + \"%\";\n    if (isPdf) {\n      host.querySelector(\"#pgl\").textContent = `${st.page} / ${st.pages}`;\n      const page = await doc.getPage(st.page); if (my !== tok) return;\n      const rotation = (page.rotate + st.rot) % 360;\n      const base = page.getViewport({ scale: 1, rotation });\n      const scale = avail / base.width * st.zoom;\n      const vp = page.getViewport({ scale: scale * dpr, rotation });\n      if (task) { try { task.cancel(); } catch (e) {} }\n      cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);\n      cv.style.width = Math.floor(vp.width / dpr) + \"px\"; cv.style.height = Math.floor(vp.height / dpr) + \"px\";\n      task = page.render({ canvasContext: cv.getContext(\"2d\"), viewport: vp });\n      try { await task.promise; } catch (e) { return; }\n    } else {\n      const w = img.naturalWidth, h = img.naturalHeight, sw = st.rot % 180 !== 0;\n      const rw = sw ? h : w, rh = sw ? w : h, s = avail / rw * st.zoom, cw = rw * s, ch = rh * s;\n      cv.width = Math.floor(cw * dpr); cv.height = Math.floor(ch * dpr);\n      cv.style.width = Math.floor(cw) + \"px\"; cv.style.height = Math.floor(ch) + \"px\";\n      const c = cv.getContext(\"2d\");\n      c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, cw, ch);\n      c.translate(cw / 2, ch / 2); c.rotate(st.rot * Math.PI / 180);\n      c.drawImage(img, -w * s / 2, -h * s / 2, w * s, h * s);\n    }\n    cv.hidden = false; vmsg.hidden = true;\n  }\n  host.querySelector(\".vbar\").onclick = e => {\n    const a = e.target.closest(\"[data-a]\")?.dataset.a; if (!a) return;\n    if (a === \"prev\" && st.page > 1) st.page--;\n    else if (a === \"next\" && st.page < st.pages) st.page++;\n    else if (a === \"in\") st.zoom = Math.min(4, st.zoom * 1.25);\n    else if (a === \"out\") st.zoom = Math.max(0.5, st.zoom / 1.25);\n    else if (a === \"fit\") st.zoom = 1;\n    else if (a === \"rot\") st.rot = (st.rot + 90) % 360;\n    render();\n  };\n  let rt; const onResize = () => { clearTimeout(rt); rt = setTimeout(render, 150); };\n  window.addEventListener(\"resize\", onResize);\n\n  if (isPdf) {\n    if (!window.pdfjsLib) vmsg.textContent = \"The PDF viewer could not load. Use Open original instead.\";\n    else {\n      pdfjsLib.GlobalWorkerOptions.workerSrc = \"https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js\";\n      pdfjsLib.getDocument(fileUrl(score.key)).promise.then(d => { doc = d; st.pages = d.numPages; render(); })\n        .catch(() => { vmsg.textContent = \"Could not display this PDF. Use Open original instead.\"; });\n    }\n  } else {\n    img = new Image(); img.onload = render; img.onerror = () => { vmsg.textContent = \"Could not load this image.\"; };\n    img.src = fileUrl(score.key);\n  }\n  return { destroy() { dead = true; window.removeEventListener(\"resize\", onResize); if (task) { try { task.cancel(); } catch (e) {} } if (doc) doc.destroy(); } };\n}\n\n/* ---------- router ---------- */\nfunction route() {\n  if (viewer) { viewer.destroy(); viewer = null; }\n  const m = decodeURIComponent(location.hash).match(/^#\\/p\\/(.+)$/);\n  const p = m && pieces.find(x => x.id === m[1]);\n  if (p) piece(p); else home();\n}\nwindow.addEventListener(\"hashchange\", route);\n\n/* ---------- player ---------- */\nconst au = $(\"#au\"), pl = $(\"#player\"), pp = $(\"#pp\"), sk = $(\"#sk\"), cur = $(\"#cur\"), dur = $(\"#dur\"), spd = $(\"#spd\"), lp = $(\"#lp\");\nconst fmt = t => isFinite(t) ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, \"0\")}` : \"0:00\";\nlet curSrc = \"\";\nfunction play(src, label, title) {\n  if (src === curSrc) { au.paused ? au.play().catch(() => {}) : au.pause(); return; }\n  curSrc = src; au.src = src; au.playbackRate = parseFloat(spd.dataset.r || \"1\");\n  $(\"#pt\").textContent = label; $(\"#ps\").textContent = title;\n  pl.classList.add(\"on\"); au.play().catch(() => {}); markPlaying();\n}\nfunction markPlaying() {\n  document.querySelectorAll(\".track\").forEach(b => {\n    const on = b.dataset.src === curSrc && !au.paused;\n    b.classList.toggle(\"playing\", on);\n    b.querySelector(\".ic\").innerHTML = on ? PAUSE : PLAY;\n  });\n  pp.innerHTML = au.paused ? PLAY : PAUSE;\n  pp.setAttribute(\"aria-label\", au.paused ? \"Play\" : \"Pause\");\n}\npp.onclick = () => { au.paused ? au.play().catch(() => {}) : au.pause(); };\n[\"play\", \"pause\", \"ended\"].forEach(ev => au.addEventListener(ev, markPlaying));\nau.addEventListener(\"timeupdate\", () => { cur.textContent = fmt(au.currentTime); if (au.duration) sk.value = au.currentTime / au.duration * 1000; });\nau.addEventListener(\"loadedmetadata\", () => { dur.textContent = fmt(au.duration); });\nsk.oninput = () => { if (au.duration) au.currentTime = sk.value / 1000 * au.duration; };\nconst RATES = [1, 0.85, 0.7];\nspd.onclick = () => { const r = RATES[(RATES.indexOf(parseFloat(spd.dataset.r || \"1\")) + 1) % RATES.length]; spd.dataset.r = r; au.playbackRate = r; spd.textContent = r + \"×\"; };\nlp.onclick = () => { au.loop = !au.loop; lp.setAttribute(\"aria-pressed\", au.loop); };\n$(\"#cl\").onclick = () => { au.pause(); pl.classList.remove(\"on\"); curSrc = \"\"; markPlaying(); };\n\n/* ---------- start ---------- */\n(async function init() {\n  if (pw) { try { await send(\"POST\", \"/login\"); admin = true; } catch (e) { pw = \"\"; store.set(\"vg-pw\", \"\"); } }\n  updateAdminBtn();\n  await refresh();\n  route();\n})();\n</script>\n</body>\n</html>\n";

// ---- Worker entry point (used by `wrangler deploy`) ----
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/")) return onRequest({ request, env });
    if (pathname === "/" || pathname === "/index.html") {
      return new Response(INDEX_HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
      });
    }
    if (pathname === "/favicon.ico") return new Response(null, { status: 204 });
    return new Response("Not found", { status: 404 });
  },
};
