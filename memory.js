import crypto from "crypto";
import { getUser, getMem, setMem, redis, redisPipe, parseDocs } from "./_lib.js";

const rid = () => crypto.randomUUID().slice(0, 8);
const clip = (s, n) => String(s || "").trim().slice(0, n);

export default async function handler(req, res) {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Please log in." });
  try {
    let m = await getMem(user.id);
    if (req.method === "GET") return res.json({ mem: m });
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
    const b = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    if (b.action === "profile") {
      const p = b.profile || {};
      m.profile = { biz: clip(p.biz, 80), offer: clip(p.offer, 200), goal: clip(p.goal, 200), tone: clip(p.tone, 20), skipped: !!p.skipped };
    } else if (b.action === "items") {
      m.facts = m.facts || []; m.reminders = m.reminders || []; m.followups = m.followups || [];
      (b.facts || []).slice(0, 5).forEach((t) => {
        t = clip(t, 200);
        if (t && !m.facts.some((f) => f.t.toLowerCase() === t.toLowerCase())) m.facts.push({ id: rid(), t, added: Date.now() });
      });
      (b.reminders || []).slice(0, 5).forEach((r) => {
        const at = Date.parse(r.at), text = clip(r.text, 200);
        if (!isNaN(at) && text) m.reminders.push({ id: rid(), at: new Date(at).toISOString(), text });
      });
      (b.followups || []).slice(0, 5).forEach((r) => {
        const at = Date.parse(r.at), q = clip(r.q, 200);
        if (!isNaN(at) && q) m.followups.push({ id: rid(), at: new Date(at).toISOString(), q });
      });
      m.facts = m.facts.slice(-60); m.reminders = m.reminders.slice(-50); m.followups = m.followups.slice(-50);
    } else if (b.action === "del") {
      const k = ["facts", "reminders", "followups"].includes(b.kind) ? b.kind : null;
      const ids = Array.isArray(b.ids) ? b.ids : [b.id];
      if (k) m[k] = (m[k] || []).filter((x) => !ids.includes(x.id));
    } else if (b.action === "prefs") {
      if (typeof b.tz === "number" && Math.abs(b.tz) <= 840) m.tz = Math.round(b.tz);
      if (b.name) m.name = clip(b.name, 60);
      if (typeof b.brief === "boolean") m.brief = b.brief;
    } else if (b.action === "toggle") {
      m.on = !!b.on;
    } else if (b.action === "clear") {
      m = { on: m.on, tz: m.tz, name: m.name, brief: m.brief };
    } else if (b.action === "wipe") {
      const docs = parseDocs(await redis(["HGETALL", "docs:" + user.id]));
      const cmds = docs.map((d) => ["DEL", `chunks:${user.id}:${d.id}`]);
      cmds.push(["DEL", "docs:" + user.id], ["DEL", "mem:" + user.id], ["DEL", "push:" + user.id], ["SREM", "push:users", user.id]);
      await redisPipe(cmds);
      return res.json({ mem: {} });
    } else return res.status(400).json({ error: "Unknown action." });

    await setMem(user.id, m);
    return res.json({ mem: m });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
