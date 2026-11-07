import crypto from "crypto";
import { getUser, redis, redisPipe, embed, chunkText, parseDocs } from "./_lib.js";

const MAX_DOCS = 20, MAX_CHUNKS = 800, MAX_CHARS = 300000;

async function extractFile(f) {
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [
        { inline_data: { mime_type: f.mime, data: f.b64 } },
        { text: "Transcribe all the text in this document exactly as written, including tables as plain text. Output only the text, nothing else." },
      ] }],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || "Could not read that file.");
  return ((j.candidates && j.candidates[0] && j.candidates[0].content.parts) || []).map((p) => p.text || "").join("");
}

export default async function handler(req, res) {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Please log in." });
  const dk = "docs:" + user.id;
  const fail = (c, e) => res.status(c).json({ error: e });

  try {
    if (req.method === "GET") return res.json({ docs: parseDocs(await redis(["HGETALL", dk])) });
    if (req.method !== "POST") return fail(405, "POST only");
    if (!process.env.GEMINI_API_KEY) return fail(500, "GEMINI_API_KEY is not set.");
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    if (body.action === "delete") {
      const id = String(body.id || "");
      if (!/^[\w-]{6,40}$/.test(id)) return fail(400, "Bad id.");
      await redisPipe([["HDEL", dk, id], ["DEL", `chunks:${user.id}:${id}`]]);
      return res.json({ ok: true });
    }

    if (body.action === "add") {
      let text = String(body.text || "");
      if (body.file && body.file.b64) text = await extractFile(body.file);
      text = text.trim().slice(0, MAX_CHARS);
      if (text.length < 20) return fail(400, "No readable text was found in that file.");

      const docs = parseDocs(await redis(["HGETALL", dk]));
      if (docs.length >= MAX_DOCS) return fail(400, `Limit of ${MAX_DOCS} documents. Remove one first.`);
      const chunks = chunkText(text);
      if (docs.reduce((n, d) => n + d.chunks, 0) + chunks.length > MAX_CHUNKS) return fail(400, "Your library is full. Remove a document first.");

      const vecs = [];
      for (let i = 0; i < chunks.length; i += 100) vecs.push(...(await embed(chunks.slice(i, i + 100), "RETRIEVAL_DOCUMENT")));

      const id = crypto.randomUUID();
      for (let i = 0; i < chunks.length; i += 40) {
        const args = [];
        for (let j = i; j < Math.min(i + 40, chunks.length); j++) args.push(String(j), JSON.stringify({ t: chunks[j], e: vecs[j] }));
        await redisPipe([["HSET", `chunks:${user.id}:${id}`, ...args]]);
      }
      const meta = { id, name: String(body.name || "Untitled").slice(0, 120), chunks: chunks.length, chars: text.length, added: Date.now() };
      await redisPipe([["HSET", dk, id, JSON.stringify(meta)]]);
      return res.json({ doc: meta });
    }
    return fail(400, "Unknown action.");
  } catch (e) {
    return fail(500, String(e.message || e));
  }
}
