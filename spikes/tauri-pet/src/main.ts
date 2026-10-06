import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

type PetState = "idle" | "thinking" | "working" | "waiting" | "done" | "error";
const PRIORITY: Record<PetState, number> = { idle: 0, done: 1, thinking: 2, working: 3, error: 4, waiting: 5 };
const EMOJI: Record<PetState, string> = { idle: "\u{1F634}", thinking: "\u{1F914}", working: "\u{1F6E0}", waiting: "\u{270B}", done: "\u{2728}", error: "\u{1F4A5}" };
const COLOR: Record<PetState, string> = { idle: "#7f8c9b", thinking: "#3aa0ff", working: "#ffb347", waiting: "#ff4d6d", done: "#3ddc84", error: "#ff3b30" };
const seen: string[] = [];
(window as any).__petStates = seen;

function mapEvent(ev: any): PetState | null {
  const t = ev?.type as string; const d = ev?.data ?? {};
  switch (t) {
    case "session.start": case "turn.start": return "thinking";
    case "step.start": case "tool.call": return "working";
    case "approval.request": case "user.question": return "waiting";
    case "approval.resolved": return d.decision === "allow" ? "done" : "error";
    case "tool.result": return d.status === "error" ? "error" : "working";
    case "turn.end": return d.status === "error" ? "error" : "done";
    case "session.end": return d.reason === "error" ? "error" : "done";
    case "error.raised": return "error";
    case "agent.status": return (d.state as PetState) ?? null;
    case "pet.heartbeat": return null;
    default: return null;
  }
}

let current: PetState = "idle";
function render(state: PetState) {
  const pet = document.getElementById("pet")!;
  const label = document.getElementById("label")!;
  pet.textContent = EMOJI[state]; pet.style.background = COLOR[state]; label.textContent = state;
  document.body.dataset.state = state;
}
async function apply(ev: any) {
  const next = mapEvent(ev);
  if (!next) return;
  if (PRIORITY[next] < PRIORITY[current] && next !== "idle") return;
  current = next; render(next); seen.push(next);
  const domText = document.getElementById("pet")!.textContent ?? "";
  await invoke("report_state", { state: next, eventType: String(ev?.type ?? ""), domText });
}
window.addEventListener("DOMContentLoaded", async () => {
  render(current);
  await listen("pet-event", (e) => { void apply(e.payload); });
  await invoke("frontend_ready");
  await invoke("window_diag");
  setTimeout(() => { void invoke("set_click_through", { on: false }); }, 4000);
  setTimeout(() => { void invoke("set_click_through", { on: true }); }, 8000);
});
