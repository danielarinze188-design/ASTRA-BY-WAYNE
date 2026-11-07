import { getUser, retrieve, getMem, memText } from "./_lib.js";

// Vercel serverless function: keeps GEMINI_API_KEY on the server and streams replies.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Please log in." });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "GEMINI_API_KEY is not set in Vercel environment variables." });

  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];

  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: String(m.content || "") }],
  }));

  const mem = await getMem(user.id);
  let sys = `You are Astra, a practical assistant for small-business owners. Help with customer replies, emails, promo posts, pricing, planning, bookkeeping basics, hiring and day-to-day decisions. Be concise and concrete, and give ready-to-use drafts they can paste. Ask at most one clarifying question when you truly need it. Never invent facts about their business; rely on what they tell you, your memory of them, and their documents. You are not a lawyer or accountant, so for legal or tax specifics suggest confirming with a professional. Use Markdown.`;
  if (mem.on !== false) {
    const known = memText(mem);
    if (known) sys += "\n\nWhat you know about this user (private memory). Match their preferred tone:\n" + known;
    sys += `\n\nCurrent local time: ${body.now || new Date().toISOString()}
You may add hidden memory tags at the very end of your reply, each on its own line, and never mention them to the user:
[[remember: a short lasting fact, goal or project about their business]] only for lasting information they shared, not trivia.
[[remind: YYYY-MM-DDTHH:MM:SS+HH:MM | what to remind them]] only when they ask for a reminder; compute the time from the current local time above and keep its UTC offset.
[[followup: YYYY-MM-DDTHH:MM:SS+HH:MM | a short question to ask them later]] when they mention something upcoming (a meeting, launch, call, deadline); set it for the day after, so you can ask how it went.`;
  }
  let sources = [];
  if (body.useDocs) {
    try {
      const last = [...messages].reverse().find((m) => m.role === "user");
      const min = parseFloat(process.env.RAG_MIN_SCORE || "0.5");
      const hits = last ? (await retrieve(user.id, String(last.content).slice(0, 2000))).filter((h) => h.s >= min) : [];
      if (hits.length) {
        sys += "\n\nThe user has uploaded their own documents. The excerpts below are the passages most relevant to their latest message. Base your answer on them when relevant and name the source file in [brackets]. If the user asks about something their documents should cover but the excerpts do not contain it, say you could not find it in their documents instead of guessing. Casual conversation can be answered normally.\n\n" +
          hits.map((h, i) => `[${h.name}] excerpt ${i + 1}:\n${h.t}`).join("\n\n---\n\n");
        sources = [...new Set(hits.map((h) => h.name))];
      }
    } catch (e) { /* fall back to a normal answer */ }
  }

  try {
    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents,
          systemInstruction: { parts: [{ text: sys }] },
          tools: body.web === false ? undefined : [{ google_search: {} }],
        }),
      }
    );

    if (!upstream.ok) {
      const t = await upstream.text();
      return res.status(upstream.status).json({ error: t });
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    if (sources.length) res.write(`data: ${JSON.stringify({ sources })}\n\n`);
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: String(e) });
    else res.end();
  }
}
