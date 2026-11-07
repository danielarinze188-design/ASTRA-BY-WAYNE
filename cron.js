import webpush from "web-push";
import { redis, getMem, setMem, makeBrief, localIso } from "./_lib.js";

// Call this every minute (see README). Sends due reminders and the morning briefing as push notifications.
export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const ok = secret && (req.headers.authorization === "Bearer " + secret || req.query.key === secret);
  if (!ok) return res.status(401).json({ error: "Unauthorized" });
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return res.status(500).json({ error: "VAPID keys are not set." });
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@example.com", process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

  const uids = (await redis(["SMEMBERS", "push:users"])) || [];
  const now = Date.now();
  let sent = 0;
  for (const uid of uids) {
    try { sent += await processUser(uid, now); } catch (e) { /* keep going */ }
  }
  return res.json({ users: uids.length, sent });
}

async function processUser(uid, now) {
  const flat = (await redis(["HGETALL", "push:" + uid])) || [];
  const subs = [];
  for (let i = 0; i < flat.length; i += 2) { try { subs.push({ field: flat[i], sub: JSON.parse(flat[i + 1]) }); } catch {} }
  if (!subs.length) { await redis(["SREM", "push:users", uid]); return 0; }

  const m = await getMem(uid);
  if (m.on === false) return 0;
  const msgs = [];
  let dirty = false;
  const off = typeof m.tz === "number" ? m.tz : 0;
  const local = new Date(now - off * 60000);
  const day = local.toISOString().slice(0, 10), hr = local.getUTCHours();

  const due = (m.reminders || []).filter((r) => Date.parse(r.at) <= now);
  if (due.length) {
    due.forEach((r) => msgs.push({ title: "Reminder", body: r.text, tag: "rem-" + r.id }));
    m.reminders = m.reminders.filter((r) => !due.includes(r));
    dirty = true;
  }

  if (m.brief !== false && m.lastBrief !== day && !m.pending && hr >= 8 && hr < 22) {
    const out = await makeBrief(m, m.name || "there", localIso(now, off), now);
    m.lastBrief = day; dirty = true;
    if (out) {
      m.pending = { text: out.text };
      m.followups = (m.followups || []).filter((f) => !out.dueIds.includes(f.id));
      const line = out.text.replace(/[*#_`>]/g, "").split("\n").map((l) => l.trim()).find(Boolean) || "Tap to see today's focus.";
      msgs.push({ title: "Your morning briefing", body: line.slice(0, 140), tag: "brief" });
    }
  }
  if (dirty) await setMem(uid, m);

  let sent = 0;
  for (const msg of msgs) {
    for (const { field, sub } of subs) {
      try { await webpush.sendNotification(sub, JSON.stringify(msg)); sent++; }
      catch (e) { if (e.statusCode === 404 || e.statusCode === 410) await redis(["HDEL", "push:" + uid, field]); }
    }
  }
  return sent;
}
