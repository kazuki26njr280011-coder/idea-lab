// アイデア収集フェーズ
// 参加者には条件A/B/Cを一切見せない（目隠しのため）

const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove("hidden");
const hide = (el) => el.classList.add("hidden");

let sessionId = null;
let plan = [];      // [{cond, theme}] 人によって順番とお題の組み合わせが変わる
let step = 0;
let timerId = null;

function error(msg) {
  $("err").textContent = msg;
  show($("err"));
}
function clearError() { hide($("err")); }

async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "通信に失敗しました");
  return j;
}

// ---------- 開始 ----------

$("start").onclick = async () => {
  $("start").disabled = true;
  try {
    const s = await api("/api/session");
    sessionId = s.sessionId;
    plan = s.plan;
    hide($("intro"));
    show($("task"));
    await renderStep();
  } catch (e) {
    $("start").disabled = false;
    alert("開始できませんでした。通信環境を確認してもう一度お試しください。");
  }
};

// ---------- 各ステップの表示 ----------

async function renderStep() {
  clearError();
  const { cond, theme } = plan[step];

  $("progress").textContent = `${step + 1} / ${plan.length}`;
  $("theme").textContent = theme.text;
  $("answer").value = "";

  hide($("bBox")); hide($("cBox")); hide($("cStep1")); hide($("writeBox")); hide($("loading"));

  if (cond === "A") {
    show($("writeBox"));
    startTimer();
    return;
  }

  if (cond === "B") {
    show($("loading"));
    try {
      const r = await api(`/api/b-ideas?themeId=${encodeURIComponent(theme.id)}`);
      $("bList").innerHTML = "";
      for (const t of r.ideas) {
        const li = document.createElement("li");
        li.textContent = t;
        $("bList").appendChild(li);
      }
      hide($("loading"));
      show($("bBox"));
      show($("writeBox"));
      startTimer();
    } catch (e) {
      hide($("loading"));
      error("AIの読み込みに失敗しました。そのままご自身で考えて書いてください。");
      show($("writeBox"));
      startTimer();
    }
    return;
  }

  // 条件C：自分の案 → AIの指摘 → 考え直す
  show($("cStep1"));
  $("cIdea").value = "";
  $("cSend").disabled = false;
}

$("cSend").onclick = async () => {
  const idea = $("cIdea").value.trim();
  if (!idea) { error("まず1つ書いてください。"); return; }
  clearError();
  $("cSend").disabled = true;
  hide($("cStep1"));
  show($("loading"));

  try {
    const r = await api("/api/critique", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ themeId: plan[step].theme.id, idea }),
    });
    $("cList").innerHTML = "";
    for (const t of r.critique) {
      const li = document.createElement("li");
      li.textContent = t;
      $("cList").appendChild(li);
    }
    hide($("loading"));
    show($("cBox"));
  } catch (e) {
    hide($("loading"));
    error("AIの読み込みに失敗しました。ご自身の考えで続けてください。");
  }
  // 最初に書いた案も残しておく（あとで比較できるように）
  $("answer").value = idea + "\n";
  show($("writeBox"));
  startTimer();
};

// ---------- タイマー ----------

function startTimer() {
  clearInterval(timerId);
  let left = 180;
  const el = $("timer");
  el.classList.remove("over");
  const tick = () => {
    const m = Math.floor(Math.abs(left) / 60);
    const s = String(Math.abs(left) % 60).padStart(2, "0");
    el.textContent = (left < 0 ? "+" : "") + m + ":" + s;
    if (left <= 0) el.classList.add("over");
    left--;
  };
  tick();
  timerId = setInterval(tick, 1000);
}

// ---------- 次へ ----------

$("next").onclick = async () => {
  const texts = $("answer").value.split("\n").map((s) => s.trim()).filter(Boolean);
  if (texts.length === 0) {
    if (!confirm("何も書かずに次へ進みますか？")) return;
  }
  $("next").disabled = true;
  clearInterval(timerId);

  try {
    await api("/api/ideas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, cond: plan[step].cond, themeId: plan[step].theme.id, texts }),
    });
  } catch (e) {
    // 保存に失敗しても進行は止めない（回答者を待たせない）
    console.error(e);
  }

  step++;
  $("next").disabled = false;

  if (step >= plan.length) {
    hide($("task"));
    show($("done"));
    window.scrollTo(0, 0);
    return;
  }
  window.scrollTo(0, 0);
  await renderStep();
};
