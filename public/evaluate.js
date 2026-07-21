// 評価フェーズ（一対比較）
// どのアイデアがどの条件から来たかは、画面にも通信内容にも出さない

const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove("hidden");
const hide = (el) => el.classList.add("hidden");

const QUESTION_TEXT = {
  try: "あなたが やってみたい と思うのはどっち？",
  surprise: "自分では 思いつかなそう だと思うのはどっち？",
};

let sessionId = null;
let pairs = [];
let i = 0;

$("start").onclick = async () => {
  $("start").disabled = true;
  try {
    const r = await fetch("/api/pairs").then((x) => x.json());
    if (r.notReady || !r.pairs?.length) {
      hide($("intro")); show($("notReady")); return;
    }
    sessionId = r.sessionId;
    pairs = r.pairs;
    hide($("intro")); show($("quiz"));
    render();
  } catch (e) {
    $("start").disabled = false;
    alert("開始できませんでした。通信環境を確認してもう一度お試しください。");
  }
};

function render() {
  const p = pairs[i];
  $("question").textContent = QUESTION_TEXT[p.question];
  $("left").textContent = p.left.text;
  $("right").textContent = p.right.text;
  $("progress").textContent = `${i + 1} / ${pairs.length}`;
  $("barFill").style.width = (i / pairs.length * 100) + "%";
}

async function choose(side) {
  const p = pairs[i];
  const winner = side === "left" ? p.left : p.right;
  const loser = side === "left" ? p.right : p.left;

  $("left").disabled = true;
  $("right").disabled = true;

  // 記録の完了は待たない（回答者を待たせないため）
  fetch("/api/vote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, question: p.question, winnerId: winner.id, loserId: loser.id }),
  }).catch(console.error);

  const prevQ = p.question;
  i++;

  $("left").disabled = false;
  $("right").disabled = false;

  if (i >= pairs.length) {
    hide($("quiz")); show($("done")); window.scrollTo(0, 0); return;
  }

  // 問いが切り替わるところで区切りを挟む
  if (pairs[i].question !== prevQ) {
    hide($("quiz"));
    $("switchText").textContent = QUESTION_TEXT[pairs[i].question];
    show($("switch"));
    window.scrollTo(0, 0);
    return;
  }
  render();
}

$("left").onclick = () => choose("left");
$("right").onclick = () => choose("right");
$("cont").onclick = () => { hide($("switch")); show($("quiz")); render(); window.scrollTo(0, 0); };
