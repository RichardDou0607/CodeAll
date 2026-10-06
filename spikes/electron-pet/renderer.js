const PRIORITY = { idle: 0, done: 1, thinking: 2, working: 3, error: 4, waiting: 5 };
const EMOJI = { idle: "\u{1F634}", done: "\u{2728}", thinking: "\u{1F914}", working: "\u{1F6E0}", error: "\u{1F4A5}", waiting: "\u{270B}" };
const COLOR = { idle: "#7f8c9b", done: "#3ddc84", thinking: "#3aa0ff", working: "#ffb347", error: "#ff3b30", waiting: "#ff4d6d" };
let current = "idle";
const seen = [];
window.__petStates = seen;

function mapEvent(ev) {
  const t = ev?.type, d = ev?.data ?? {};
  switch (t) {
    case "session.start": case "turn.start": return "thinking";
    case "step.start": case "tool.call": return "working";
    case "approval.request": case "user.question": return "waiting";
    case "approval.resolved": return d.decision === "allow" ? "done" : "error";
    case "tool.result": return d.status === "error" ? "error" : "working";
    case "turn.end": return d.status === "error" ? "error" : "done";
    case "session.end": return d.reason === "error" ? "error" : "done";
    case "error.raised": return "error";
    case "agent.status": return d.state ?? null;
    case "pet.heartbeat": return null;
    default: return null;
  }
}

function render(state) {
  const pet = document.getElementById("pet");
  pet.textContent = EMOJI[state]; pet.style.background = COLOR[state];
  document.getElementById("label").textContent = state;
  document.body.dataset.state = state;
}

async function apply(ev) {
  const next = mapEvent(ev);
  if (!next) return;
  if (PRIORITY[next] < PRIORITY[current] && next !== "idle") return;
  current = next; render(next); seen.push(next);
  await window.petAPI.reportState({ state: next, type: String(ev?.type ?? ""), domText: document.getElementById("pet").textContent });
}

window.petAPI.onEvent((ev) => { void apply(ev); });
document.addEventListener("DOMContentLoaded", async () => {
  render(current);
  await window.petAPI.windowDiag();
});
