(() => {
  const $ = (id) => document.getElementById(id);
  const timerEl = $("timer");
  const phaseEl = $("phase-label");
  const ideaEl = $("idea");
  const roundLabel = $("round-label");
  const grid = $("grid");
  const empty = $("empty");
  const results = $("results");
  const toast = $("toast");

  let round = null;
  let clockOffset = 0; // serverNow - Date.now()
  const tiles = new Map(); // submission id -> element

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", role: "arena" }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "state") applyState(msg.round);
      else if (msg.type === "submission") applySubmission(msg.submission);
    };
    ws.onclose = () => setTimeout(connect, 1500);
  }

  function applyState(r) {
    const newRound = !round || round.id !== r.id;
    round = r;
    clockOffset = r.serverNow - Date.now();
    roundLabel.textContent = `Round ${r.number}`;
    ideaEl.textContent = r.idea;
    if (newRound) {
      grid.innerHTML = "";
      tiles.clear();
      results.classList.add("hidden");
    }
    for (const s of r.submissions) applySubmission(s, true);
    renderPhase();
    tick();
  }

  function isVisible(s) {
    return s.status !== "rejected" && s.status !== "failed";
  }

  function applySubmission(s, silent) {
    if (!round) return;
    const idx = round.submissions.findIndex((x) => x.id === s.id);
    if (idx === -1) round.submissions.push(s);
    else round.submissions[idx] = s;

    if (!isVisible(s)) {
      const t = tiles.get(s.id);
      if (t) { t.remove(); tiles.delete(s.id); }
      layout();
      return;
    }

    let tile = tiles.get(s.id);
    if (!tile) {
      tile = document.createElement("div");
      tile.className = "tile building";
      tile.innerHTML = `<div class="placeholder"><div><div class="spinner"></div><div class="who"></div><div class="msg">Building…</div></div></div>
        <div class="label"><span class="order"></span><span class="name"></span></div>`;
      grid.appendChild(tile);
      tiles.set(s.id, tile);
      if (!silent) showToast(`${s.playerName} joined the battle!`);
    }
    const who = tile.querySelector(".who");
    const msg = tile.querySelector(".msg");
    if (who) who.textContent = s.playerName;
    if (msg) msg.textContent = s.status === "submitted" ? "Prompt received…" : "The AI is building…";
    tile.querySelector(".order").textContent = s.order;
    tile.querySelector(".name").textContent = s.playerName;

    if ((s.status === "built" || s.status === "live") && s.siteUrl && !tile.querySelector("iframe")) {
      const frame = document.createElement("iframe");
      frame.sandbox = "allow-scripts";
      frame.loading = "eager";
      frame.referrerPolicy = "no-referrer";
      frame.src = s.siteUrl;
      tile.querySelector(".placeholder")?.remove();
      tile.prepend(frame);
      tile.classList.remove("building");
      if (!silent) showToast(`${s.playerName}'s site is live!`);
    }
    layout();
  }

  function layout() {
    // Keep at most 6 tiles, in submission order.
    const ordered = [...tiles.entries()]
      .map(([id, el]) => ({ el, s: round.submissions.find((x) => x.id === id) }))
      .filter((x) => x.s)
      .sort((a, b) => a.s.order - b.s.order);
    ordered.forEach(({ el }, i) => {
      el.classList.toggle("hidden", i >= 6);
      grid.appendChild(el);
    });
    const count = Math.min(6, ordered.length);
    grid.dataset.count = String(count);
    empty.classList.toggle("hidden", count > 0 || round.phase === "results");
  }

  function renderPhase() {
    if (!round) return;
    if (round.phase === "building") {
      phaseEl.textContent = "Build your site!";
      results.classList.add("hidden");
    } else if (round.phase === "judging") {
      phaseEl.textContent = "Time's up – judging…";
    } else if (round.phase === "results") {
      phaseEl.textContent = "Results – next round in";
      renderResults();
    }
    layout();
  }

  function renderResults() {
    const judged = round.submissions.filter((s) => s.scores).sort((a, b) => b.scores.total - a.scores.total);
    let html = `<h2>🏆 Round ${round.number} Results</h2><div class="idea-recap">${esc(round.idea)}</div>`;
    if (judged.length === 0) {
      html += `<div class="none">No sites made it to the judge this round. Scan the QR code and join the next one!</div>`;
    } else {
      html += `<div class="podium">` + judged.map((s, i) => `
        <div class="card rank-${i + 1}">
          <div class="rank">${medal(i)} ${esc(s.playerName)} <small>#${s.order} to submit</small></div>
          ${s.screenshotUrl ? `<img src="${s.screenshotUrl}" alt="">` : ""}
          <div class="scores">
            <span>Creativity <b>${s.scores.creativity}</b>/10</span>
            <span>Accuracy <b>${s.scores.accuracy}</b>/10</span>
            <span>Speed bonus <b>+${s.scores.orderBonus}</b></span>
            <span class="total">${s.scores.total}</span>
          </div>
          <div class="comment">“${esc(s.scores.comment)}”</div>
        </div>`).join("") + `</div>`;
    }
    results.innerHTML = html;
    results.classList.remove("hidden");
    empty.classList.add("hidden");
  }

  function medal(i) {
    return ["🥇", "🥈", "🥉"][i] || `${i + 1}.`;
  }

  function tick() {
    if (!round) return;
    const remaining = Math.max(0, round.endsAt - (Date.now() + clockOffset));
    const total = Math.ceil(remaining / 1000);
    const m = String(Math.floor(total / 60)).padStart(2, "0");
    const s = String(total % 60).padStart(2, "0");
    timerEl.textContent = `${m}:${s}`;
    timerEl.classList.toggle("urgent", round.phase === "building" && remaining < 30_000);
  }

  let toastTimer;
  function showToast(text) {
    toast.textContent = text;
    toast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add("hidden"), 3500);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  setInterval(tick, 250);
  connect();
})();
