import crypto from "crypto";
import { getUser, redis } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method === "GET") return res.json({ key: process.env.VAPID_PUBLIC_KEY || "" });
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Please log in." });
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const b = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const hk = "push:" + user.id;
    const field = (ep) => crypto.createHash("sha1").update(String(ep)).digest("hex").slice(0, 16);
    if (b.action === "subscribe") {
      const s = b.sub;
      if (!s || !s.endpoint || !s.keys || !/^https:\/\//.test(s.endpoint)) return res.status(400).json({ error: "Bad subscription." });
      const existing = await redis(["HLEN", hk]);
      if (existing >= 5) await redis(["DEL", hk]);
      await redis(["HSET", hk, field(s.endpoint), JSON.stringify({ endpoint: s.endpoint, keys: s.keys })]);
      await redis(["SADD", "push:users", user.id]);
      return res.json({ ok: true });
    }
    if (b.action === "unsubscribe") {
      await redis(["HDEL", hk, field(b.endpoint)]);
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: "Unknown action." });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
