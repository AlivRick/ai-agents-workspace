import { useMemo, useState } from "react";
import { shortPath, type Runtime } from "./api";

export type Slot = string;

/**
 * The agents a terminal can be launched with. One row per CLI — adding another
 * (Gemini, Droid, …) is one line here and nothing else.
 *
 * `cmd` is run verbatim in the shell, so an agent you have not installed simply
 * reports "command not found" in its own terminal rather than failing silently.
 * Only Claude Code reports progress back to the app: the status chips come from
 * Claude's hooks, which the other CLIs do not have.
 */
export const AGENTS: { id: Slot; name: string; cmd: string; note: string; live: boolean }[] = [
  { id: "claude", name: "Claude Code", cmd: "claude", note: "Runs `claude`, reports status back.", live: true },
  { id: "codex", name: "Codex", cmd: "codex", note: "Runs the `codex` CLI.", live: false },
  { id: "terminal", name: "Terminal", cmd: "", note: "Just a shell — you type.", live: false },
];
export const agentName = (id: Slot) => AGENTS.find((a) => a.id === id)?.name ?? id;

export type TaskSpec = { name: string; slots: Slot[]; runtime: string; prompt: string; continueLast: boolean };

const PRESETS: { id: string; name: string; note: string; slots: Slot[] }[] = [
  { id: "solo", name: "Solo", note: "One agent in one terminal.", slots: ["claude"] },
  { id: "pair", name: "Pair", note: "One agent working, one shell for you.", slots: ["claude", "terminal"] },
  { id: "bench", name: "Workbench", note: "An agent plus shells for git and tests.", slots: ["claude", "terminal", "terminal"] },
  { id: "swarm", name: "Swarm", note: "Four agents splitting the work.", slots: ["claude", "claude", "claude", "claude"] },
];
const same = (a: Slot[], b: Slot[]) => a.length === b.length && a.every((s, i) => s === b[i]);

/** The sheet that opens when you add a task: pick a shape, pick how many
 *  terminals, optionally say what it should work on. */
export default function TaskSheet({
  wsName, wsPath, runtimes, runtime, onCancel, onCreate,
}: {
  wsName: string; wsPath: string; runtimes: Runtime[]; runtime: string;
  onCancel: () => void; onCreate: (spec: TaskSpec) => void;
}) {
  const [slots, setSlots] = useState<Slot[]>(["claude"]);
  const [agent, setAgent] = useState<Slot>("claude");
  const [rt, setRt] = useState(runtime);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [continueLast, setContinueLast] = useState(false);

  const preset = useMemo(() => PRESETS.find((p) => same(p.slots, slots))?.id ?? "", [slots]);
  const count = slots.length;
  // "How many" only means something for a uniform task; a mixed preset keeps
  // its shape until you touch the count.
  const setCount = (n: number) => setSlots(Array.from({ length: n }, (_, i) => slots[i] ?? agent));
  const setAll = (a: Slot) => { setAgent(a); setSlots(Array.from({ length: count }, () => a)); };

  const hasAgent = slots.some((s) => s !== "terminal");
  const submit = () => onCreate({
    name: name.trim() || prompt.trim().slice(0, 40) || "New task",
    slots, runtime: rt, prompt: prompt.trim(), continueLast,
  });

  return (
    <div className="modal" onMouseDown={onCancel}>
      <div className="sheet" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <b>New task</b>
          <span className="path">{wsName} · {shortPath(wsPath)}</span>
          <span className="sp" />
          <button className="btn ghost" onClick={onCancel}>Esc</button>
        </header>

        <div className="sheet-list form">
          <label className="fld">
            <span className="lbl">Task name</span>
            <input className="txt" autoFocus value={name} placeholder="Fix the checkout bug…"
                   onChange={(e) => setName(e.target.value)}
                   onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
          </label>

          <div className="lbl">Shape</div>
          <div className="cards">
            {PRESETS.map((p) => (
              <button key={p.id} className={"pick-card" + (preset === p.id ? " on" : "")}
                      onClick={() => { setSlots(p.slots); setAgent(p.slots[0]); }}>
                <b>{p.name}<em>{p.slots.length}</em></b>
                <i>{p.note}</i>
              </button>
            ))}
          </div>

          <div className="lbl">Agent</div>
          <div className="cards">
            {AGENTS.map((a) => (
              <button key={a.id} className={"pick-card" + (slots.every((s) => s === a.id) ? " on" : "")}
                      onClick={() => setAll(a.id)}>
                <b>{a.name}{a.live && <em>live status</em>}</b>
                <i>{a.note}</i>
              </button>
            ))}
          </div>

          <div className="lbl">How many terminals</div>
          <div className="seg wide">
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <button key={n} className={count === n ? "on" : ""} onClick={() => setCount(n)}>{n}</button>
            ))}
          </div>

          {runtimes.length > 1 && (
            <>
              <div className="lbl">Where to run</div>
              <div className="seg wide">
                {runtimes.map((r) => (
                  <button key={r.id} className={rt === r.id ? "on" : ""} onClick={() => setRt(r.id)}>{r.label}</button>
                ))}
              </div>
            </>
          )}

          {hasAgent && (
            <>
              <label className="fld">
                <span className="lbl">What should it work on — optional</span>
                <textarea className="txt area" value={prompt} rows={3}
                          placeholder="The agent receives this line the moment it opens."
                          onChange={(e) => setPrompt(e.target.value)} />
              </label>
              {slots.includes("claude") && (
                <label className="opt">
                  <input type="checkbox" checked={continueLast} onChange={(e) => setContinueLast(e.target.checked)} />
                  <span><b>Continue this workspace's last session</b>
                    <i>Runs <code>claude --continue</code> instead of opening a blank session.</i></span>
                </label>
              )}
            </>
          )}

          <div className="lbl">Will launch</div>
          <ol className="launch">
            {slots.map((s, i) => (
              <li key={i}><span className="k">{i + 1}</span>{agentName(s)}
                {s === "claude" && continueLast && <em>--continue</em>}
                {s !== "terminal" && prompt.trim() && <em>with a prompt</em>}
              </li>
            ))}
          </ol>
        </div>

        <footer>
          <span className="sp" />
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn primary" onClick={submit}>Create task · {count} terminals</button>
        </footer>
      </div>
    </div>
  );
}
