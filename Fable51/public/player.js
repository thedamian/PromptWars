(() => {
  const $ = (id) => document.getElementById(id);
  const screenName = $("screen-name");
  const screenPlay = $("screen-play");
  const nameForm = $("name-form");
  const nameInput = $("name-input");
  const promptForm = $("prompt-form");
  const promptInput = $("prompt-input");
  const submitBtn = $("submit-btn");
  const charCount = $("char-count");
  const errorEl = $("error");
  const progress = $("progress");
  const statusMessage = $("status-message");
  const scoreEl = $("score");
  const timerEl = $("timer");
  const ideaEl = $("idea");
  const phaseEl = $("phase");

  const STEPS = ["submitted", "processing", "built", "live"];
  let ws;
  let round = null;
  let mine = null;
  let clockOffset = 0;
  let playerId = localStorage.getItem("pw.playerId") || "";
  let playerName = localStorage.getItem("pw.name") || "";

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", role: "player", playerId: playerId || undefined, name: playerName || undefined }));
    ws.onmessage = (ev) => handle(JSON.parse(ev.data));
    ws.onclose = () => setTimeout(connect, 1500);
  }

  function handle(msg) {
    switch (msg.type) {
      case "welcome":
        playerId = msg.playerId;
        localStorage.setItem("pw.playerId", playerId);
        if (msg.name) {
          playerName = msg.name;
          localStorage.setItem("pw.name", playerName);
          showPlay();
        }
        break;
      case "state": {
        const newRound = !round || round.id !== msg.round.id;
        round = msg.round;
        clockOffset = round.serverNow - Date.now();
        if (newRound) {
          mine = null;
          renderMine();
        }
        renderRound();
        break;
      }
      case "yourSubmission":
        mine = msg.submission;
        renderMine();
        break;
      case "error":
        showError(msg.message);
        submitBtn.disabled = false;
        break;
    }
  }

  function showPlay() {
    screenName.classList.add("hidden");
    screenPlay.classList.remove("hidden");
    $("player-name").textContent = playerName;
  }

  nameForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) return;
    ws.send(JSON.stringify({ type: "join", name }));
  });

  promptInput.addEventListener("input", () => {
    charCount.textContent = `${promptInput.value.length} / 1500`;
  });

  promptForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const prompt = promptInput.value.trim();
    if (prompt.length < 10) return showError("Give the AI a little more to work with (at least 10 characters).");
    hideError();
    submitBtn.disabled = true;
    ws.send(JSON.stringify({ type: "submit", prompt }));
  });

  function renderRound() {
    if (!round) return;
    $("round-number").textContent = round.number;
    ideaEl.textContent = round.idea;
    const building = round.phase === "building";
    const canSubmit = building && !mine;
    promptForm.classList.toggle("hidden", !canSubmit);
    submitBtn.disabled = !canSubmit;
    phaseEl.textContent = building
      ? "Submit your prompt before the timer runs out!"
      : round.phase === "judging"
        ? "Time's up! The judge is looking at the arena…"
        : "Results are up on the big screen. Next round starting soon!";
    if (!building && !mine) hideError();
    tick();
  }

  function renderMine() {
    if (!mine) {
      progress.classList.add("hidden");
      scoreEl.classList.add("hidden");
      if (round) renderRound();
      return;
    }
    progress.classList.remove("hidden");
    promptForm.classList.add("hidden");
    hideError();

    const reached = mine.status === "rejected" || mine.status === "failed" ? -1 : STEPS.indexOf(mine.status);
    progress.querySelectorAll(".steps li").forEach((li, i) => {
      li.classList.remove("done", "current", "rejected");
      if (mine.status === "rejected" || mine.status === "failed") {
        if (i === 0) li.classList.add(mine.status === "rejected" ? "rejected" : "done");
        if (i === 1 && mine.status === "failed") li.classList.add("rejected");
      } else if (i < reached) li.classList.add("done");
      else if (i === reached) li.classList.add(reached === STEPS.length - 1 ? "done" : "current");
    });

    statusMessage.textContent = mine.statusMessage || "";
    statusMessage.classList.toggle("bad", mine.status === "rejected" || mine.status === "failed");

    if (mine.status === "rejected" && round && round.phase === "building") {
      // Let the player fix their prompt and try again.
      statusMessage.textContent += " You can edit your prompt and try again.";
      promptForm.classList.remove("hidden");
      submitBtn.disabled = false;
    }

    if (mine.scores) {
      const s = mine.scores;
      scoreEl.innerHTML = `<div class="big">${s.total} points</div>
        <div class="parts">Creativity ${s.creativity}/10 · Accuracy ${s.accuracy}/10 · Speed bonus +${s.orderBonus}</div>
        <div class="comment">“${esc(s.comment)}”</div>`;
      scoreEl.classList.remove("hidden");
    } else {
      scoreEl.classList.add("hidden");
    }
  }

  function tick() {
    if (!round) return;
    const remaining = Math.max(0, round.endsAt - (Date.now() + clockOffset));
    const total = Math.ceil(remaining / 1000);
    timerEl.textContent = `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
    timerEl.classList.toggle("urgent", round.phase === "building" && remaining < 30_000);
  }

  function showError(text) {
    errorEl.textContent = text;
    errorEl.classList.remove("hidden");
  }
  function hideError() {
    errorEl.classList.add("hidden");
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  setInterval(tick, 250);
  connect();
})();
