const state = { socket: null, endsAt: 0, submissions: [] };
const $ = (id) => document.getElementById(id);
const grid = $("grid");
const empty = $("empty");
const results = $("results");
const leaderboard = $("leaderboard");
function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  state.socket = new WebSocket(`${protocol}//${location.host}`);
  state.socket.addEventListener("open", () => state.socket.send(JSON.stringify({ type: "hello", role: "arena" })));
  state.socket.addEventListener("close", () => setTimeout(connect, 1500));
  state.socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "state") render(message);
  });
}
function render(next) {
  state.endsAt = next.endsAt;
  $("idea").textContent = next.idea;
  $("phase").textContent = next.phase === "playing" ? "LIVE" : next.phase.toUpperCase();
  state.submissions = next.submissions;
  if (next.phase === "results" && next.results.length) {
    renderResults(next);
    results.classList.remove("hidden");
  } else {
    results.classList.add("hidden");
  }
  grid.innerHTML = next.submissions.filter((item) => item.websitePath).slice(0, 6).map((submission) => `
    <article class="site-card">
      <div class="site-label"><i></i>${escapeHtml(submission.name)} <span>#${submission.order}</span></div>
      <iframe title="${escapeHtml(submission.name)}'s website" src="${submission.websitePath}" sandbox="allow-scripts"></iframe>
    </article>`).join("");
  empty.classList.toggle("hidden", grid.children.length > 0);
}
function renderResults(next) {
  const byId = new Map(next.submissions.map((submission) => [submission.id, submission]));
  leaderboard.innerHTML = next.results.map((result, index) => {
    const submission = byId.get(result.submissionId);
    return `<div class="result-row"><div class="rank">0${index + 1}</div><div><div class="result-name">${escapeHtml(submission?.name ?? "Builder")}</div><div class="result-meta">CREATIVITY ${result.creativity}/10 · IDEA MATCH ${result.ideaMatch}/10 · ORDER +${result.orderBonus}</div></div><div class="result-score">${result.total}</div><div class="result-feedback">${escapeHtml(result.feedback)}</div></div>`;
  }).join("");
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;" }[character])); }
function updateTimer() {
  const seconds = Math.max(0, Math.ceil((state.endsAt - Date.now()) / 1000));
  $("timer").textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  requestAnimationFrame(updateTimer);
}
connect();
updateTimer();
