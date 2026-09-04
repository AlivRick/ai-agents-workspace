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
export const AGENTS: { id: Slot; name: string; cmd: string; note: string; live: boolean; icon: string; box: number; tint: string }[] = [
  { id: "claude", name: "Claude Code", cmd: "claude", note: "Runs `claude`, reports status back.", live: true,
    // Official marks, filled: Anthropic's sunburst (claude.ai/favicon.svg) and
    // OpenAI's blossom (simple-icons). Codex ships no mark of its own.
    icon: "M52.4285 162.873L98.7844 136.879L99.5485 134.602L98.7844 133.334H96.4921L88.7237 132.862L62.2346 132.153L39.3113 131.207L17.0249 130.026L11.4214 128.844L6.2 121.873L6.7094 118.447L11.4214 115.257L18.171 115.847L33.0711 116.911L55.485 118.447L71.6586 119.392L95.728 121.873H99.5485L100.058 120.337L98.7844 119.392L97.7656 118.447L74.5877 102.732L49.4995 86.1905L36.3823 76.62L29.3779 71.7757L25.8121 67.2858L24.2839 57.3608L30.6515 50.2716L39.3113 50.8623L41.4763 51.4531L50.2636 58.1879L68.9842 72.7209L93.4357 90.6804L97.0015 93.6343L98.4374 92.6652L98.6571 91.9801L97.0015 89.2625L83.757 65.2772L69.621 40.8192L63.2534 30.6579L61.5978 24.632C60.9565 22.1032 60.579 20.0111 60.579 17.4246L67.8381 7.49965L71.9133 6.19995L81.7193 7.49965L85.7946 11.0443L91.9074 24.9865L101.714 46.8451L116.996 76.62L121.453 85.4816L123.873 93.6343L124.764 96.1155H126.292V94.6976L127.566 77.9197L129.858 57.3608L132.15 30.8942L132.915 23.4505L136.608 14.4708L143.994 9.62643L149.725 12.344L154.437 19.0788L153.8 23.4505L150.998 41.6463L145.522 70.1215L141.957 89.2625H143.994L146.414 86.7813L156.093 74.0206L172.266 53.698L179.398 45.6635L187.803 36.802L193.152 32.5484H203.34L210.726 43.6549L207.415 55.1159L196.972 68.3492L188.312 79.5739L175.896 96.2095L168.191 109.585L168.882 110.689L170.738 110.53L198.755 104.504L213.91 101.787L231.994 98.7149L240.144 102.496L241.036 106.395L237.852 114.311L218.495 119.037L195.826 123.645L162.07 131.592L161.696 131.893L162.137 132.547L177.36 133.925L183.855 134.279H199.774L229.447 136.524L237.215 141.605L241.8 147.867L241.036 152.711L229.065 158.737L213.019 154.956L175.45 145.977L162.587 142.787H160.805V143.85L171.502 154.366L191.242 172.089L215.82 195.011L217.094 200.682L213.91 205.172L210.599 204.699L188.949 188.394L180.544 181.069L161.696 165.118H160.422V166.772L164.752 173.152L187.803 207.771L188.949 218.405L187.294 221.832L181.308 223.959L174.813 222.777L161.187 203.754L147.305 182.486L136.098 163.345L134.745 164.2L128.075 235.42L125.019 239.082L117.887 241.8L111.902 237.31L108.718 229.984L111.902 215.452L115.722 196.547L118.779 181.541L121.58 162.873L123.291 156.636L123.14 156.219L121.773 156.449L107.699 175.752L86.304 204.699L69.3663 222.777L65.291 224.431L58.2867 220.768L58.9235 214.27L62.8713 208.48L86.304 178.705L100.44 160.155L109.551 149.507L109.462 147.967L108.959 147.924L46.6977 188.512L35.6182 189.93L30.7788 185.44L31.4156 178.115L33.7079 175.752L52.4285 162.873Z",
    box: 248, tint: "#D97757" },
  { id: "codex", name: "Codex", cmd: "codex", note: "Runs the `codex` CLI.", live: false,
    icon: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
    box: 24, tint: "" },
  { id: "terminal", name: "Terminal", cmd: "", note: "Just a shell — you type.", live: false,
    icon: "M4 17l6-5-6-5M12.5 17.5H20", box: 24, tint: "" },
];
const agentOf = (id: Slot) => AGENTS.find((a) => a.id === id);
export const agentName = (id: Slot) => agentOf(id)?.name ?? id;

/** The mark that says which CLI a terminal — or a whole task — is running.
 *  Tinted with the agent's own colour so it reads at 13px without a label. */
export function AgentIcon({ agent, size = 13 }: { agent: Slot; size?: number }) {
  const a = agentOf(agent);
  if (!a) return null;
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
                <b><AgentIcon agent={a.id} size={14} />{a.name}{a.live && <em>live status</em>}</b>
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
              <li key={i}><span className="k">{i + 1}</span><AgentIcon agent={s} />{agentName(s)}
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
