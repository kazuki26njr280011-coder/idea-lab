// Deno Deploy 版
// 保存は Deno KV。ファイル書き込みが使えないため（Deploy上は読み取り専用）。

import { THEMES, B_IDEA_COUNT, PAIRS_TRY, PAIRS_SURPRISE, PROMPT_B, PROMPT_C } from "./config.js";

const kv = await Deno.openKv();

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY");
const ADMIN_KEY = Deno.env.get("ADMIN_KEY") || "";
const MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-2.0-flash";

if (!GEMINI_KEY) console.warn("[警告] GEMINI_API_KEY が未設定です。条件B/CでAIが使えません。");
if (!ADMIN_KEY) console.warn("[警告] ADMIN_KEY が未設定です。管理画面が開けません。");

// ---------- ユーティリティ ----------

const rid = (p) => p + "_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);

function shuffle(a) {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const coin = () => crypto.getRandomValues(new Uint32Array(1))[0] % 2;

const json = (code, obj) =>
  new Response(JSON.stringify(obj), {
    status: code,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

// ---------- KV ----------

async function listAll(prefix) {
  const out = [];
  for await (const e of kv.list({ prefix: [prefix] })) out.push(e.value);
  return out;
}

// ---------- レート制限 ----------

const hits = new Map();
function rateLimit(ip, max = 30, windowMs = 60000) {
  const now = Date.now();
  const rec = hits.get(ip) || { t: now, n: 0 };
  if (now - rec.t > windowMs) { rec.t = now; rec.n = 0; }
  rec.n++;
  hits.set(ip, rec);
  if (hits.size > 5000) hits.clear();
  return rec.n <= max;
}

// ---------- Gemini ----------

async function gemini(prompt) {
  if (!GEMINI_KEY) throw new Error("APIキー未設定");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.9, maxOutputTokens: 800 },
    }),
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const text = j?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  if (!text) throw new Error("空の応答");
  return text.trim();
}

const toLines = (text, max = 20) =>
  text.split("\n")
    .map((s) => s.replace(/^\s*(?:\d+[.)、．]|[-*・])\s*/, "").trim())
    .filter((s) => s.length > 0 && s.length < 200)
    .slice(0, max);

// ---------- 割り当て・ペア生成 ----------

function assign() {
  const conds = shuffle(["A", "B", "C"]);
  const themes = shuffle(THEMES);
  return conds.map((cond, i) => ({ cond, theme: themes[i] }));
}

function makePairs(ideas, count) {
  const pool = [];
  for (let i = 0; i < ideas.length; i++)
    for (let j = i + 1; j < ideas.length; j++)
      if (ideas[i].cond !== ideas[j].cond && ideas[i].themeId === ideas[j].themeId)
        pool.push([ideas[i], ideas[j]]);

  const shuffled = shuffle(pool);
  const used = new Map();
  const picked = [];
  for (const p of shuffled) {
    if (picked.length >= count) break;
    const a = used.get(p[0].id) || 0, b = used.get(p[1].id) || 0;
    if (a > 3 || b > 3) continue;
    used.set(p[0].id, a + 1); used.set(p[1].id, b + 1);
    picked.push(p);
  }
  for (const p of shuffled) {
    if (picked.length >= count) break;
    if (!picked.includes(p)) picked.push(p);
  }
  return picked.slice(0, count).map((p) => (coin() ? [p[1], p[0]] : p));
}

// ---------- 静的ファイル ----------

const MIME = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8" };

async function serveStatic(pathname) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  if (rel.includes("..")) return new Response("見つかりません", { status: 404 });
  try {
    const url = new URL("./public" + rel, import.meta.url);
    const data = await Deno.readFile(url);
    const ext = rel.split(".").pop();
    return new Response(data, { headers: { "Content-Type": MIME[ext] || "application/octet-stream" } });
  } catch {
    return new Response("見つかりません", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}

// ---------- ルーティング ----------

Deno.serve(async (req, info) => {
  const url = new URL(req.url);
  const p = url.pathname;
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
             info?.remoteAddr?.hostname || "?";

  try {
    if (p === "/api/session" && req.method === "GET") {
      return json(200, { sessionId: rid("s"), plan: assign() });
    }

    // 条件B：お題ごとに1回だけ生成し、全員に同じものを見せる
    if (p === "/api/b-ideas" && req.method === "GET") {
      const themeId = url.searchParams.get("themeId");
      const theme = THEMES.find((t) => t.id === themeId);
      if (!theme) return json(400, { error: "お題が見つかりません" });

      const cached = await kv.get(["cacheB", themeId]);
      if (cached.value) return json(200, { ideas: cached.value });

      if (!rateLimit(ip)) return json(429, { error: "混み合っています。少し待ってください" });
      const list = toLines(await gemini(PROMPT_B(theme.text, B_IDEA_COUNT)), B_IDEA_COUNT);
      await kv.set(["cacheB", themeId], list);
      return json(200, { ideas: list });
    }

    // 条件C：その人の案への指摘
    if (p === "/api/critique" && req.method === "POST") {
      if (!rateLimit(ip)) return json(429, { error: "混み合っています。少し待ってください" });
      const b = await req.json().catch(() => ({}));
      const theme = THEMES.find((t) => t.id === b.themeId);
      const idea = String(b.idea || "").slice(0, 500).trim();
      if (!theme || !idea) return json(400, { error: "内容が足りません" });
      return json(200, { critique: toLines(await gemini(PROMPT_C(theme.text, idea)), 3) });
    }

    if (p === "/api/ideas" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const sessionId = String(b.sessionId || "").slice(0, 40);
      const cond = ["A", "B", "C"].includes(b.cond) ? b.cond : null;
      const theme = THEMES.find((t) => t.id === b.themeId);
      if (!sessionId || !cond || !theme) return json(400, { error: "内容が足りません" });

      const texts = (Array.isArray(b.texts) ? b.texts : [])
        .map((s) => String(s).slice(0, 200).trim()).filter(Boolean).slice(0, 30);

      for (const text of texts) {
        const id = rid("i");
        await kv.set(["idea", id], { id, cond, themeId: theme.id, text, sessionId, createdAt: new Date().toISOString() });
      }
      return json(200, { saved: texts.length });
    }

    if (p === "/api/pairs" && req.method === "GET") {
      const ideas = await listAll("idea");
      if (ideas.length < 6) return json(200, { pairs: [], notReady: true });

      const strip = (q) => (x) => ({
        question: q,
        left: { id: x[0].id, text: x[0].text },
        right: { id: x[1].id, text: x[1].text },
      });
      const pairs = [
        ...makePairs(ideas, PAIRS_TRY).map(strip("try")),
        ...makePairs(ideas, PAIRS_SURPRISE).map(strip("surprise")),
      ];
      return json(200, { sessionId: rid("v"), pairs });
    }

    if (p === "/api/vote" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const [w, l] = await Promise.all([kv.get(["idea", b.winnerId]), kv.get(["idea", b.loserId])]);
      if (!w.value || !l.value) return json(400, { error: "対象が見つかりません" });

      const id = rid("v");
      await kv.set(["vote", id], {
        id,
        sessionId: String(b.sessionId || "").slice(0, 40),
        question: b.question === "surprise" ? "surprise" : "try",
        winnerId: w.value.id, loserId: l.value.id,
        winnerCond: w.value.cond, loserCond: l.value.cond,
        createdAt: new Date().toISOString(),
      });
      return json(200, { ok: true });
    }

    if (p === "/api/stats") {
      if (!ADMIN_KEY || url.searchParams.get("key") !== ADMIN_KEY) return json(403, { error: "権限がありません" });
      const [ideas, votes] = await Promise.all([listAll("idea"), listAll("vote")]);
      const out = {};
      for (const q of ["try", "surprise"]) {
        out[q] = {};
        for (const c of ["A", "B", "C"]) {
          const win = votes.filter((v) => v.question === q && v.winnerCond === c).length;
          const lose = votes.filter((v) => v.question === q && v.loserCond === c).length;
          out[q][c] = { win, lose, rate: win + lose ? +(win / (win + lose) * 100).toFixed(1) : null };
        }
      }
      const counts = { A: 0, B: 0, C: 0 };
      for (const i of ideas) counts[i.cond]++;
      return json(200, {
        参加者数: new Set(ideas.map((i) => i.sessionId)).size,
        アイデア数: counts,
        投票数: votes.length,
        勝率: out,
      });
    }

    if (p === "/api/export.csv") {
      if (!ADMIN_KEY || url.searchParams.get("key") !== ADMIN_KEY) return json(403, { error: "権限がありません" });
      const [ideas, votes] = await Promise.all([listAll("idea"), listAll("vote")]);
      const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
      const rows = [
        ["種類", "id", "条件", "お題", "本文", "セッション", "問い", "勝者条件", "敗者条件", "日時"].join(","),
        ...ideas.map((i) => ["idea", i.id, i.cond, i.themeId, i.text, i.sessionId, "", "", "", i.createdAt].map(esc).join(",")),
        ...votes.map((v) => ["vote", v.id, "", "", "", v.sessionId, v.question, v.winnerCond, v.loserCond, v.createdAt].map(esc).join(",")),
      ];
      return new Response("﻿" + rows.join("\n"), {
        headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="idea-lab.csv"' },
      });
    }

    if (p.startsWith("/api/")) return json(404, { error: "不明なAPI" });
    return await serveStatic(p);

  } catch (e) {
    console.error("[error]", p, e.message);
    return json(500, { error: "サーバー側で問題が起きました。少し待ってもう一度お試しください" });
  }
});
