import { useEffect, useMemo, useState } from "react";
import {
  api, blockTokens, clock, fmtDur, fmtInt, fmtTokens, fmtUsd, parseLimits, shortPath, until,
  type Block, type Limit, type Named, type UsageReport,
} from "./api";

const RANGES: [string, string][] = [["today", "Today"], ["7d", "7 days"], ["30d", "30 days"], ["all", "All time"]];
/* Slots 1–3 of the validated categorical palette; a 4th model folds into one
   neutral rather than cycling the palette. */
const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];

type Metric = "output" | "cost";
const METRIC: Record<Metric, { label: string; fmt: (n: number) => string; unit: string }> = {
  output: { label: "Output tokens", fmt: fmtTokens, unit: "output tokens" },
  cost: { label: "Cost", fmt: fmtUsd, unit: "cost" },
};

const dayLabel = (d: string) => d.slice(8) + "/" + d.slice(5, 7);

/** Continuous day axis: a day with no work is a zero bar, not a missing one. */
function fillDays(rows: Named[], cap = 45) {
  if (!rows.length) return [];
  const map = new Map(rows.map((r) => [r.key, r]));
  const toDate = (s: string) => new Date(s + "T00:00:00Z").getTime();
  const out: { key: string; cost: number; output: number; sessions: number }[] = [];
  for (let t = toDate(rows[0].key); t <= toDate(rows[rows.length - 1].key); t += 86_400_000) {
    const key = new Date(t).toISOString().slice(0, 10);
    const r = map.get(key);
    out.push({ key, cost: r?.costUsd ?? 0, output: r?.output ?? 0, sessions: r?.sessions ?? 0 });
  }
  return out.slice(-cap);
}

export default function UsageView({ runtime }: { runtime: string }) {
  const [range, setRange] = useState("7d");
  const [metric, setMetric] = useState<Metric>("output");
  const [rep, setRep] = useState<UsageReport | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [busy, setBusy] = useState(true);
  const [at, setAt] = useState(0);
  // Bấm "Làm mới" tăng số này: vừa quét lại transcript, vừa bỏ qua cache /usage.
  const [force, setForce] = useState(0);

  // Transcript được ghi liên tục trong lúc bạn làm việc, nên tab tự đọc lại mỗi
  // phút — không thì số token đứng im cho tới khi rời tab rồi quay lại.
  useEffect(() => {
    let live = true;
    const load = (first: boolean) => {
      if (first) setBusy(true);
      Promise.all([api.usageReport(range, runtime), api.usageBlocks(runtime).catch(() => [] as Block[])])
        .then(([r, b]) => {
          if (!live) return;
          setRep(r);
          setBlocks(b);
          setAt(Date.now());
        })
        .finally(() => live && setBusy(false));
    };
    load(true);
    const t = setInterval(() => load(false), 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [range, runtime, force]);

  const days = useMemo(() => fillDays(rep?.byDay ?? []), [rep]);
  const peak = Math.max(...days.map((d) => d[metric === "cost" ? "cost" : "output"]), 1);
  const m = METRIC[metric];
  const t = rep?.total;
  const value = (b: Named) => (metric === "cost" ? b.costUsd : b.output);

  return (
    <>
      <div className="toolbar">
        <span className="title">Usage</span>
        <span className="path">read from ~/.claude/projects{at ? ` · updated ${clock(at)}` : ""}</span>
        <span className="sp" />
        <button className="btn" onClick={() => setForce((n) => n + 1)} disabled={busy}>
          {busy ? "Reading…" : "Refresh"}
        </button>
        <div className="seg">
          {RANGES.map(([k, l]) => (
            <button key={k} className={range === k ? "on" : ""} onClick={() => setRange(k)}>{l}</button>
          ))}
        </div>
      </div>

      <div className="scroll">
        <div className="usage">
          {busy && !rep ? (
            <div className="hint">Scanning transcripts…</div>
          ) : !t || t.sessions === 0 ? (
            <div className="hint">No sessions in this range.</div>
          ) : (
            <>
              <BlockCard blocks={blocks} runtime={runtime} force={force} />

              <div className="tiles">
                <Tile k="Output tokens" v={fmtTokens(t.output)} s={`${fmtInt(t.sessions)} sessions`} />
                <Tile k="Input tokens" v={fmtTokens(t.input + t.cacheCreate)} s={`${fmtTokens(t.cacheRead)} cache read`} />
                <Tile k="Messages" v={fmtInt(t.messages)} s={`${fmtInt(Math.round(t.messages / Math.max(t.sessions, 1)))} / session`} />
                <Tile k="Lines of code" v={`+${fmtInt(t.linesAdded)}`} s={`−${fmtInt(t.linesRemoved)}`} />
                <Tile k="Time" v={fmtDur(t.durationMs)} s="across all sessions" />
                <Tile
                  k="Cost"
                  v={fmtUsd(t.costUsd)}
                  s={
                    t.costSessions < t.sessions
                      ? `only ${t.costSessions}/${t.sessions} sessions recorded`
                      : "every session recorded"
                  }
                />
              </div>

              {t.costSessions < t.sessions && (
                <p className="note">
                  Claude Code only writes a <code>cost-state</code> record for some sessions, so the
                  dollar figure is a lower bound. Tokens are summed per message and are always complete —
                  read the token numbers first.
                </p>
              )}

              {days.length > 1 && (
                <div className="card">
                  <div className="cardhead">
                    <div>
                      <h3>{m.label} per day</h3>
                      <div className="sub">last {days.length} days · peak {m.fmt(peak)}</div>
                    </div>
                    <div className="seg">
                      {(["output", "cost"] as Metric[]).map((k) => (
                        <button key={k} className={metric === k ? "on" : ""} onClick={() => setMetric(k)}>
                          {METRIC[k].label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="chart">
                    <div className="gridline" style={{ top: 18 }} />
                    {days.map((d) => {
                      const v = metric === "cost" ? d.cost : d.output;
                      return (
                        <div className="bar" key={d.key}>
                          {v === peak && <span className="lab">{m.fmt(peak)}</span>}
                          <i style={{ height: `${Math.max((v / peak) * 100, v > 0 ? 2 : 0)}%` }} />
                          <span className="tip">
                            <b>{m.fmt(v)}</b>
                            {dayLabel(d.key)} · {d.sessions} sessions
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="axis">
                    <span>{dayLabel(days[0].key)}</span>
                    <span>{dayLabel(days[days.length - 1].key)}</span>
                  </div>
                </div>
              )}

              <div className="card">
                <h3>By model</h3>
                <div className="sub">{m.label.toLowerCase()} per model</div>
                <Bars
                  rows={(rep!.byModel ?? []).filter((x) => value(x) > 0).map((x, i) => ({
                    key: x.key.replace(/^claude-/, ""),
                    value: value(x),
                    text: m.fmt(value(x)),
                    color: SERIES[i] ?? "var(--series-other)",
                    note: `${fmtTokens(x.input + x.cacheCreate)} in · ${fmtTokens(x.output)} out · ${fmtUsd(x.costUsd)}`,
                  }))}
                />
              </div>

              <div className="card">
                <h3>By workspace</h3>
                <div className="sub">10 busiest folders</div>
                <Bars
                  rows={(rep!.byWorkspace ?? []).filter((w) => value(w) > 0).slice(0, 10).map((w) => ({
                    key: shortPath(w.key).split("/").slice(-2).join("/"),
                    value: value(w),
                    text: m.fmt(value(w)),
                    color: "var(--accent)",
                    note: `${w.sessions} sessions · ${fmtTokens(w.output)} out · +${fmtInt(w.linesAdded)}/−${fmtInt(w.linesRemoved)}`,
                  }))}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/** The five-hour window Claude Code meters a subscription in.
 *
 *  Cửa sổ mở đúng phút của tin nhắn đầu tiên sau khi cửa sổ trước đóng — cùng
 *  quy tắc mà `/usage` reset. Nó vẫn có thể lệch với `/usage` khi tài khoản còn
 *  dùng ở claude.ai hay máy khác: ở đây chỉ đọc được transcript của máy này.
 *
 *  There is no API that says what your limit is, so the gauge is drawn against
 *  *your own* busiest window instead of an invented ceiling — "gấp rưỡi lần
 *  nặng nhất từ trước tới nay" is a real warning; "83% of 200k" would be a
 *  number we made up. */
/** `/usage` labels, shortened. The per-model row ("Current week (Fable)")
 *  keeps the model name — Anthropic meters each model separately. */
const limitLabel = (s: string) =>
  s === "Current session"
    ? "5-hour session"
    : s.replace("Current week (all models)", "Week · all models").replace(/^Current week \((.+)\)$/, "Week · $1");

/** Giờ trong ngày; mốc sang ngày khác thì kèm ngày, không thì đọc nhầm. */
const when = (ms: number) =>
  new Date(ms).toDateString() === new Date().toDateString()
    ? clock(ms)
    : `${new Date(ms).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit" })} ${clock(ms)}`;

function LimitRow({ l }: { l: Limit }) {
  return (
    <div className="lim">
      <span className="k">{limitLabel(l.label)}</span>
      <span className="gauge">
        {/* 0% là 0% — vạch tối thiểu chỉ để một phần trăm lẻ vẫn nhìn thấy. */}
        <i style={{ width: l.pct ? `${Math.max(l.pct, 1.5)}%` : 0 }} className={l.pct >= 90 ? "over" : ""} />
      </span>
      <span className="v">{l.pct}%</span>
      <span className="s">{l.resetMs ? `resets ${when(l.resetMs)} · ${until(l.resetMs)} left` : ""}</span>
    </div>
  );
}

/** `/usage` sống lâu hơn một lần mở tab. Không có chỗ này thì mỗi lần bấm sang
 *  tab Mức sử dụng, thẻ lại nhấp nháy: vẽ số ước lượng trước, ba giây sau số
 *  thật về thì nhảy sang số khác. */
let cachedLimits: { runtime: string; at: number; limits: Limit[] } | null = null;
const LIMITS_TTL = 300_000;

function BlockCard({ blocks, runtime, force }: { blocks: Block[]; runtime: string; force: number }) {
  // Re-render so the countdown moves; a minute is finer than anyone needs.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  // Số thật, hỏi thẳng CLI (`claude -p /usage`). `null` = chưa có câu trả lời,
  // `[]` = hỏi rồi mà CLI không nói được (chưa đăng nhập, bản cũ).
  const fresh = cachedLimits?.runtime === runtime && Date.now() - cachedLimits.at < LIMITS_TTL;
  const [limits, setLimits] = useState<Limit[] | null>(fresh ? cachedLimits!.limits : null);
  useEffect(() => {
    let live = true;
    const ask = () =>
      api
        .usageLimits(runtime)
        .then(parseLimits)
        .catch(() => [] as Limit[])
        .then((ls) => {
          cachedLimits = { runtime, at: Date.now(), limits: ls };
          if (live) setLimits(ls);
        });
    // Bấm "Làm mới" thì hỏi lại ngay, không đợi cache hết hạn.
    if (force > 0 || !(cachedLimits?.runtime === runtime && Date.now() - cachedLimits.at < LIMITS_TTL)) ask();
    const t = setInterval(ask, LIMITS_TTL);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [runtime, force]);

  if (!blocks.length) return null;
  const waiting = limits === null;
  const session = limits?.[0];
  const last = blocks[blocks.length - 1];
  const live = last.active ? last : null;
  const past = blocks.slice(0, blocks.length - (last.active ? 1 : 0));
  const peak = Math.max(...past.map(blockTokens), 1);
  const used = blockTokens(last);
  const elapsedMin = Math.max((Date.now() - last.startMs) / 60_000, 1);
  const burn = live ? used / elapsedMin : 0;
  const projected = live ? used + burn * Math.max((last.endMs - Date.now()) / 60_000, 0) : 0;
  const pct = Math.min((used / peak) * 100, 100);
  // Cửa sổ dài đúng 5 giờ, nên mốc reset thật cho luôn giờ mở thật.
  const endMs = session?.resetMs || last.endMs;
  const startMs = session?.resetMs ? session.resetMs - 5 * 3_600_000 : last.startMs;
  const open = Date.now() < endMs;

  return (
    <div className="card">
      <div className="cardhead">
        <div>
          <h3>{open ? "Current 5-hour window" : "Last 5-hour window"}</h3>
          <div className="sub">
            {waiting ? (
              "asking /usage for your real limits…"
            ) : (
              <>
                opened {clock(startMs)} · closes {clock(endMs)}
                {open ? ` · ${until(endMs)} left` : " · closed"}
                {session
                  ? " · from /usage"
                  : " · estimated from transcripts — /usage unavailable"}
              </>
            )}
          </div>
        </div>
        <div className="blk-now">
          <b>{fmtTokens(used)}</b> tokens (cache reads included)
          {last.costUsd > 0 && <span> · ~{fmtUsd(last.costUsd)}</span>}
        </div>
      </div>

      {waiting ? (
        // Khung chờ đúng ba dòng `/usage` sẽ trả về, để thẻ không đổi chiều cao.
        <div className="limits wait">
          {[0, 1, 2].map((i) => (
            <div className="lim skel" key={i}>
              <span className="k" />
              <span className="gauge" />
              <span className="v" />
              <span className="s" />
            </div>
          ))}
        </div>
      ) : limits!.length ? (
        <div className="limits">
          {limits!.map((l) => (
            <LimitRow l={l} key={l.label} />
          ))}
        </div>
      ) : (
        // CLI không trả lời được: quay về thước đo tương đối, và nói rõ là ước.
        <>
          <div className="gauge" title={`${fmtInt(used)} tokens — your all-time peak: ${fmtInt(peak)}`}>
            <i style={{ width: `${Math.max(pct, 1.5)}%` }} className={used > peak ? "over" : ""} />
          </div>
          <div className="sub">
            {used >= peak
              ? "your heaviest window so far"
              : `${Math.round(pct)}% of your heaviest window (${fmtTokens(peak)})`}
          </div>
        </>
      )}

      <div className="sub">
        {live && `${fmtInt(Math.round(burn))} tokens/min · ${fmtTokens(Math.round(projected))} projected by close · `}
        {`${fmtInt(last.messages)} messages · ${fmtTokens(last.output)} output tokens`}
      </div>

      {blocks.length > 1 && (
        <>
          <div className="chart blk">
            {blocks.slice(-16).map((b) => {
              const v = blockTokens(b);
              return (
                <div className={"bar" + (b.active ? " on" : "")} key={b.startMs}>
                  <i style={{ height: `${Math.max((v / Math.max(peak, used)) * 100, 2)}%` }} />
                  <span className="tip">
                    <b>{fmtTokens(v)}</b>
                    {new Date(b.startMs).toLocaleString("en-GB", { day: "2-digit", month: "2-digit" })} {clock(b.startMs)}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="axis"><span>last 16 windows</span><span>one bar = one 5-hour window</span></div>
        </>
      )}
    </div>
  );
}

function Tile({ k, v, s }: { k: string; v: string; s?: string }) {
  return <div className="tile"><div className="k">{k}</div><div className="v">{v}</div>{s && <div className="s">{s}</div>}</div>;
}

function Bars({ rows }: { rows: { key: string; value: number; text: string; color: string; note: string }[] }) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  if (!rows.length) return <div className="hint">No data.</div>;
  return (
    <div className="hbars">
      {rows.map((r) => (
        <div className="hbar" key={r.key} title={r.note}>
          <span className="k"><span className="sw" style={{ background: r.color }} />{r.key}</span>
          <span className="track"><i style={{ width: `${Math.max((r.value / max) * 100, 1.5)}%`, background: r.color }} /></span>
          <span className="v">{r.text}</span>
        </div>
      ))}
    </div>
  );
}
