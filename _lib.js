import crypto from "crypto";

const b64 = (b) => Buffer.from(b).toString("base64url");

export function signSession(user) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  const payload = b64(JSON.stringify({ id: user.id, name: user.name, exp: Date.now() + 30 * 864e5 }));
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function getUser(req) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)astra=([^;]+)/);
  if (!m) return null;
  const [payload, sig] = m[1].split(".");
  if (!payload || !sig) return null;
  const good = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString());
    return p.exp > Date.now() ? { id: p.id, name: p.name } : null;
  } catch { return null; }
}

export function setCookie(res, token) {
  res.setHeader("Set-Cookie",
    `astra=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${token ? 2592000 : 0}`);
}

// Upstash Redis (REST) — add the "Upstash Redis" integration in Vercel Marketplace.
export async function redis(cmd) {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const tok = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !tok) throw new Error("Redis is not configured (UPSTASH_REDIS_REST_URL / TOKEN).");
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

export const hashPw = (pw, salt = crypto.randomBytes(16).toString("hex")) =>
  new Promise((ok, no) =>
    crypto.scrypt(pw, salt, 64, (e, k) => (e ? no(e) : ok(`${salt}:${k.toString("hex")}`))));

export async function checkPw(pw, stored) {
  const [salt, hex] = stored.split(":");
  const [, h2] = (await hashPw(pw, salt)).split(":");
  return crypto.timingSafeEqual(Buffer.from(hex), Buffer.from(h2));
}

// ---------- Documents / retrieval ----------
export async function redisPipe(cmds) {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const tok = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !tok) throw new Error("Redis is not configured (UPSTASH_REDIS_REST_URL / TOKEN).");
  const r = await fetch(url.replace(/\/$/, "") + "/pipeline", {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
  });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(j.error || "Redis error");
  return j.map((x) => { if (x.error) throw new Error(x.error); return x.result; });
}

// Gemini embeddings, 256 dims, L2-normalised so cosine similarity = dot product.
export async function embed(texts, taskType) {
  const model = process.env.EMBED_MODEL || "gemini-embedding-001";
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      requests: texts.map((t) => ({
        model: "models/" + model,
        content: { parts: [{ text: t }] },
        taskType,
        outputDimensionality: 256,
      })),
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || "Embedding request failed");
  return j.embeddings.map((e) => {
    const n = Math.sqrt(e.values.reduce((s, x) => s + x * x, 0)) || 1;
    return e.values.map((x) => Math.round((x / n) * 1e4) / 1e4);
  });
}

export function chunkText(t, size = 1000, ov = 150) {
  t = t.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const out = [];
  let i = 0;
  while (i < t.length) {
    let end = Math.min(i + size, t.length);
    if (end < t.length) {
      const w = t.slice(i, end);
      const cut = Math.max(w.lastIndexOf("\n\n"), w.lastIndexOf(". "), w.lastIndexOf("\n"));
      if (cut > size * 0.5) end = i + cut + 1;
    }
    const c = t.slice(i, end).trim();
    if (c) out.push(c);
    if (end >= t.length) break;
    i = Math.max(end - ov, i + 1);
  }
  return out;
}

export function parseDocs(flat) {
  const docs = [];
  for (let i = 0; i < (flat || []).length; i += 2) {
    try { docs.push(JSON.parse(flat[i + 1])); } catch {}
  }
  return docs.sort((a, b) => b.added - a.added);
}

export async function retrieve(uid, q, k = 6) {
  const docs = parseDocs(await redis(["HGETALL", "docs:" + uid]));
  if (!docs.length) return [];
  const [qv] = await embed([q], "RETRIEVAL_QUERY");
  const rows = await redisPipe(docs.map((d) => ["HGETALL", `chunks:${uid}:${d.id}`]));
  const scored = [];
  rows.forEach((flat, ix) => {
    for (let i = 0; i < flat.length; i += 2) {
      try {
        const c = JSON.parse(flat[i + 1]);
        let s = 0;
        for (let d = 0; d < qv.length; d++) s += qv[d] * c.e[d];
        scored.push({ s, t: c.t, name: docs[ix].name });
      } catch {}
    }
  });
  return scored.sort((a, b) => b.s - a.s).slice(0, k);
}

// ---------- Memory ----------
export async function getMem(uid) {
  try { const r = await redis(["GET", "mem:" + uid]); return r ? JSON.parse(r) : {}; } catch { return {}; }
}
export async function setMem(uid, m) { await redis(["SET", "mem:" + uid, JSON.stringify(m)]); }
export function memText(m) {
  const p = m.profile || {}, L = [];
  if (p.biz) L.push("Business: " + p.biz);
  if (p.offer) L.push("What they do or sell: " + p.offer);
  if (p.goal) L.push("Main goal right now: " + p.goal);
  if (p.tone) L.push("Preferred tone: " + p.tone);
  (m.facts || []).forEach((f) => L.push("- " + f.t));
  return L.join("\n");
}

// ---------- Briefing + time helpers ----------
const BRIEF_SYS = `You are Astra, a warm, practical assistant for a small-business owner. Write their morning briefing in under 160 words, in Markdown:
**Today's focus** - 1 to 3 items drawn from their goals, projects and reminders.
**Reminders** - any reminders due in the next 24 hours (omit if none).
**Follow-ups** - for each follow-up question provided, ask it warmly, like "How did the call with the supplier go?" (omit if none).
Greet them briefly first and end with one short question inviting them to start. Use only the information provided; never invent facts.`;

// off = Date.getTimezoneOffset() of the user (minutes, positive when behind UTC)
export function localIso(now, off) {
  const p = (n) => String(n).padStart(2, "0"), a = Math.abs(off);
  return new Date(now - off * 60000).toISOString().slice(0, 19) + (off <= 0 ? "+" : "-") + p(Math.floor(a / 60)) + ":" + p(a % 60);
}

export async function makeBrief(m, name, nowISO, nowMs) {
  const ctx = memText(m);
  const due = (m.followups || []).filter((f) => Date.parse(f.at) <= nowMs);
  const rem = (m.reminders || []).filter((r) => Date.parse(r.at) <= nowMs + 864e5);
  if (!ctx && !due.length && !rem.length) return null;
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const prompt = `Now: ${nowISO}\nOwner name: ${name}\n\nMemory:\n${ctx || "(none)"}\n\nReminders in the next 24 hours:\n${rem.map((r) => `- ${r.at}: ${r.text}`).join("\n") || "(none)"}\n\nFollow-up questions to ask:\n${due.map((f) => "- " + f.q).join("\n") || "(none)"}`;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: BRIEF_SYS }] }, contents: [{ role: "user", parts: [{ text: prompt }] }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || "Briefing failed");
  const text = ((j.candidates && j.candidates[0] && j.candidates[0].content.parts) || []).map((p) => p.text || "").join("").trim();
  return text ? { text, dueIds: due.map((f) => f.id) } : null;
}
