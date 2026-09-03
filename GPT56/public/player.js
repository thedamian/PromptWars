const statuses = ["Prompt Submitted", "Processing", "Website Built", "Display it live"];
const state = { socket: null, name: "", roundId: "", submissionId: null, endsAt: 0, phase: "playing" };
const $ = (id) => document.getElementById(id);
const welcome = $("welcome");
const contest = $("contest");
const nameForm = $("name-form");
const promptForm = $("prompt-form");
const promptInput = $("prompt");
const submitButton = $("submit-button");
const idea = $("idea");
const timer = $("timer");
const statusList = $("status-list");
const count = $("character-count");
const connectionDot = $("connection-dot");

function renderStatuses(current) {
  statusList.innerHTML = statuses.map((status) => `<li class="${statuses.indexOf(status) <= statuses.indexOf(current) ? "active" : ""}">${status}</li>`).join("");
}
function showError(message) { $("contest-error").textContent = message; $("welcome-error").textContent = message; }
function clearErrors() { $("contest-error").textContent = ""; $("welcome-error").textContent = ""; }
function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  state.socket = new WebSocket(`${protocol}//${location.host}`);
  state.socket.addEventListener("open", () => {
    connectionDot.classList.add("connected");
    connectionDot.title = "Connected";
    state.socket.send(JSON.stringify({ type: "hello", role: "player" }));
  });
  state.socket.addEventListener("close", () => {
    connectionDot.classList.remove("connected");
    connectionDot.title = "Disconnected";
    setTimeout(connect, 1500);
  });
  state.socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "error") {
      if (state.submissionId === "pending") {
        state.submissionId = null;
        promptInput.disabled = false;
        submitButton.disabled = false;
      }
      showError(message.message);
      return;
    }
    if (message.type === "submission") { state.submissionId = message.submissionId; return; }
    if (message.type === "state") renderState(message);
  });
}
function renderState(next) {
  if (state.roundId && state.roundId !== next.roundId) {
    state.submissionId = null;
    promptInput.value = "";
    promptInput.disabled = false;
    submitButton.disabled = false;
    renderStatuses("");
    clearErrors();
  }
  state.roundId = next.roundId;
  state.endsAt = next.endsAt;
  state.phase = next.phase;
  idea.textContent = next.idea;
  if (state.name) $("player-greeting").textContent = `Playing as ${state.name}`;
  const mine = next.submissions.find((submission) => submission.id === state.submissionId);
  if (mine) {
    renderStatuses(mine.status);
    if (mine.error) showError(mine.error);
  }
  if (next.phase !== "playing") {
    promptInput.disabled = true;
    submitButton.disabled = true;
    if (next.phase === "judging") showError("Time is up. The arena is being judged…");
    if (next.phase === "results") showError("Round complete. The next mission is loading…");
  }
}
function updateTimer() {
  if (!state.endsAt) return;
  const remaining = Math.max(0, state.endsAt - Date.now());
  const totalSeconds = Math.ceil(remaining / 1000);
  timer.textContent = `${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${String(totalSeconds % 60).padStart(2, "0")}`;
  requestAnimationFrame(updateTimer);
}
nameForm.addEventListener("submit", (event) => {
  event.preventDefault();
  clearErrors();
  state.name = $("name").value.trim();
  if (!state.name || !state.socket || state.socket.readyState !== WebSocket.OPEN) { showError("Still connecting to the arena. Try again in a moment."); return; }
  state.socket.send(JSON.stringify({ type: "register", name: state.name }));
  welcome.classList.add("hidden");
  contest.classList.remove("hidden");
});
promptInput.addEventListener("input", () => { count.textContent = `${promptInput.value.length} / 2000`; });
promptForm.addEventListener("submit", (event) => {
  event.preventDefault();
  clearErrors();
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) { showError("Connection lost. Reconnecting…"); return; }
  state.socket.send(JSON.stringify({ type: "submit", prompt: promptInput.value }));
  state.submissionId = "pending";
  promptInput.disabled = true;
  submitButton.disabled = true;
  renderStatuses("Prompt Submitted");
});
renderStatuses("");
connect();
updateTimer();
