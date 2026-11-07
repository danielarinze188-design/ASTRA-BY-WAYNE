import { getUser, getMem, setMem, makeBrief } from "./_lib.js";

export default async function handler(req, res) {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Please log in." });
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const b = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const day = String(b.day || "").slice(0, 10);
    const now = Date.parse(b.now) || Date.now();
    const m = await getMem(user.id);

    // A briefing already prepared in the background (and pushed to the phone)
    if (m.pending && m.on !== false) {
      const text = m.pending.text;
      delete m.pending;
      await setMem(user.id, m);
      return res.json({ text });
    }
    if (m.on === false || m.lastBrief === day) return res.json({ skip: true });

    const out = await makeBrief(m, user.name, b.now, now);
    if (!out) return res.json({ skip: true });
    m.lastBrief = day;
    m.followups = (m.followups || []).filter((f) => !out.dueIds.includes(f.id));
    await setMem(user.id, m);
    return res.json({ text: out.text });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
