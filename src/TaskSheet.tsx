import { useEffect, useMemo, useState } from "react";
import { shortPath, type Runtime } from "./api";
import { AGENTS, agentName, agentOf, binOf, launchArgs, type Slot } from "./agents";

export type { Slot };

/** The mark that says which CLI a terminal — or a whole task — is running.
 *  Tinted with the agent's own colour so it reads at 13px without a label. */
export function AgentIcon({ agent, size = 13 }: { agent: Slot; size?: number }) {
  const a = agentOf(agent);
  if (!a) return null;
  // Not every CLI has a mark we may ship. Those get their initial instead —
  // still a glyph you can tell apart in a header at 13px.
  if (!a.icon)
    return (
      <svg className="agent-ic" width={size} height={size} viewBox="0 0 24 24" aria-label={a.name}>
        <title>{a.name}</title>
        <rect x="1.6" y="1.6" width="20.8" height="20.8" rx="6" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <text x="12" y="16.6" textAnchor="middle" fontSize="13" fontWeight="700" fill="currentColor">{a.name[0]}</text>
      </svg>
    );
  // The brand marks are solid shapes; the terminal is our own stroked glyph.
  const stroked = a.id === "terminal";
  return (
    <svg className="agent-ic" width={size} height={size} viewBox={`0 0 ${a.box} ${a.box}`}
         fill={stroked ? "none" : a.tint || "currentColor"}
         stroke={stroked ? "currentColor" : "none"}
         strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"
         aria-label={a.name}><title>{a.name}</title><path d={a.icon} /></svg>
  );
}

export type TaskSpec = { name: string; slots: Slot[]; runtime: string; prompt: string; continueLast: boolean };

/** The sheet that opens when you add a task: pick a shape, pick how many
 *  terminals, optionally say what it should work on. */
export default function TaskSheet({
  wsName, wsPath, runtimes, runtime, probe, onCancel, onCreate,
}: {
  wsName: string; wsPath: string; runtimes: Runtime[]; runtime: string;
  /** Which agent binaries a runtime actually has. Answered by the runtime's own
   *  shell, so switching "Where to run" asks again. */
  probe: (runtime: string) => Promise<string[]>;
  onCancel: () => void; onCreate: (spec: TaskSpec) => void;
}) {
  const [agent, setAgent] = useState<Slot>("claude");
  const [count, setCount] = useState(1);
  const [rt, setRt] = useState(runtime);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [continueLast, setContinueLast] = useState(false);
  const [installed, setInstalled] = useState<string[] | null>(null);

  useEffect(() => {
    let live = true;
    setInstalled(null);
    probe(rt).then((found) => live && setInstalled(found)).catch(() => live && setInstalled([]));
    return () => { live = false; };
  }, [rt, probe]);

  // A missing CLI is worth saying out loud, but not worth blocking on: the
  // probe can be wrong (a brand-new install, a shell we could not ask), and
  // the terminal itself is the honest second opinion.
  //
  // Finding *nothing* is treated as "could not ask" rather than "you have no
  // agents": a machine running this app has at least one CLI, so an empty
  // answer is a broken probe, and labelling every row "not installed" — the
  // Claude row included — is the loudest possible way to be wrong. `null` is
  // "still asking"; `[]` is "asked, learned nothing", and says so out loud
  // rather than leaving you to guess why nothing is marked.
  const missing = (id: Slot) => {
    const a = agentOf(id);
    return !!a && a.bins.length > 0 && !!installed?.length && !a.bins.some((b) => installed.includes(b));
  };
  /** One agent, N terminals of it — the only shape a task has. */
  const slots = useMemo(() => Array.from({ length: count }, () => agent), [agent, count]);
  const sel = agentOf(agent);
  const hasAgent = agent !== "terminal";
  /** Can this agent reopen its last session? */
  const canContinue = hasAgent && !!sel?.contFlag;
  /** Will it silently ignore the prompt? Say so rather than lie. */
  const deaf = hasAgent && sel?.promptFlag === null;
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

          <div className="lbl">Agent</div>
          {installed?.length === 0 && (
            <div className="hint">Could not ask {runtimes.find((r) => r.id === rt)?.label ?? rt} which CLIs
              it has, so none of these is marked as missing. They still run — the terminal will say if one
              is not there.</div>
          )}
          <div className="cards">
            {AGENTS.map((a) => (
              <button key={a.id} className={"pick-card" + (agent === a.id ? " on" : "")}
                      style={missing(a.id) ? { opacity: 0.5 } : undefined} onClick={() => setAgent(a.id)}>
                <b><AgentIcon agent={a.id} size={14} />{a.name}
                  {a.live && <em>live status</em>}
                  {missing(a.id) && <em>not installed</em>}</b>
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
              {deaf && prompt.trim() && (
                <div className="hint">{sel!.name} only takes a prompt in headless mode, which would answer
                  once and exit — it opens empty and you type the task yourself.</div>
              )}
              {canContinue && (
                <label className="opt">
                  <input type="checkbox" checked={continueLast} onChange={(e) => setContinueLast(e.target.checked)} />
                  <span><b>Continue this workspace's last session</b>
                    <i>Adds <code>{sel!.contFlag}</code> instead of opening a blank session.</i></span>
                </label>
              )}
            </>
          )}

          <div className="lbl">Will launch</div>
          <ol className="launch">
            {slots.map((s, i) => (
              <li key={i}><span className="k">{i + 1}</span><AgentIcon agent={s} />{agentName(s)}
                {s !== "terminal" && <em>{[binOf(agentOf(s)!, installed ?? []),
                  launchArgs(agentOf(s)!, prompt, continueLast)].filter(Boolean).join(" ")}</em>}
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
