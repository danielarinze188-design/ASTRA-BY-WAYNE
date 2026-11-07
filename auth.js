import { signSession, getUser, setCookie, redis, hashPw, checkPw } from "./_lib.js";
import crypto from "crypto";

export default async function handler(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID || "";

  if (req.method === "GET") return res.json({ user: getUser(req), googleClientId: clientId, upgradeUrl: process.env.UPGRADE_URL || "" });
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
  const fail = (code, error) => res.status(code).json({ error });

  try {
    if (body.action === "logout") { setCookie(res, ""); return res.json({ ok: true }); }

    if (body.action === "google") {
      if (!clientId) return fail(500, "GOOGLE_CLIENT_ID is not set.");
      const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(body.credential || ""));
      const g = await r.json();
      if (!r.ok || g.aud !== clientId) return fail(401, "Google sign-in could not be verified.");
      const user = { id: "g:" + g.sub, name: g.name || g.email.split("@")[0] };
      setCookie(res, signSession(user));
      return res.json({ user });
    }

    const name = String(body.name || "").trim();
    const pw = String(body.password || "");
    if (!/^[\w .-]{3,24}$/.test(name)) return fail(400, "Name must be 3–24 letters, numbers, spaces, dots or dashes.");
    if (pw.length < 6) return fail(400, "Password must be at least 6 characters.");
    const key = "user:" + name.toLowerCase();

    if (body.action === "register") {
      const stored = await hashPw(pw);
      const created = await redis(["SETNX", key, JSON.stringify({ name, pw: stored, id: "u:" + crypto.randomUUID() })]);
      if (!created) return fail(409, "That name is taken. Choose another or log in.");
      const rec = JSON.parse(await redis(["GET", key]));
      const user = { id: rec.id, name: rec.name };
      setCookie(res, signSession(user));
      return res.json({ user });
    }

    if (body.action === "login") {
      const raw = await redis(["GET", key]);
      const rec = raw && JSON.parse(raw);
      if (!rec || !(await checkPw(pw, rec.pw))) return fail(401, "Name or password is incorrect.");
      const user = { id: rec.id, name: rec.name };
      setCookie(res, signSession(user));
      return res.json({ user });
    }

    return fail(400, "Unknown action.");
  } catch (e) {
    return fail(500, String(e.message || e));
  }
}
