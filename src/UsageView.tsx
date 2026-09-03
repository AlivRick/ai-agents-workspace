import { useEffect, useMemo, useState } from "react";
import { api, fmtDur, fmtInt, fmtTokens, fmtUsd, shortPath, type Named, type UsageReport } from "./api";

const RANGES: [string, string][] = [["today", "Hôm nay"], ["7d", "7 ngày"], ["30d", "30 ngày"], ["all", "Tất cả"]];
/* Slots 1–3 of the validated categorical palette; a 4th model folds into one
   neutral rather than cycling the palette. */
const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];

type Metric = "output" | "cost";
const METRIC: Record<Metric, { label: string; fmt: (n: number) => string; unit: string }> = {
  output: { label: "Token ra", fmt: fmtTokens, unit: "token ra" },
  cost: { label: "Chi phí", fmt: fmtUsd, unit: "chi phí" },
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
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    setBusy(true);
    api.usageReport(range, runtime).then(setRep).finally(() => setBusy(false));
  }, [range, runtime]);

  const days = useMemo(() => fillDays(rep?.byDay ?? []), [rep]);
  const peak = Math.max(...days.map((d) => d[metric === "cost" ? "cost" : "output"]), 1);
  const m = METRIC[metric];
  const t = rep?.total;
  const value = (b: Named) => (metric === "cost" ? b.costUsd : b.output);

  return (
    <>
      <div className="toolbar">
        <span className="title">Mức sử dụng</span>
        <span className="path">đọc từ ~/.claude/projects</span>
        <span className="sp" />
        <div className="seg">
          {RANGES.map(([k, l]) => (
            <button key={k} className={range === k ? "on" : ""} onClick={() => setRange(k)}>{l}</button>
          ))}
        </div>
      </div>

      <div className="scroll">
        <div className="usage">
          {busy && !rep ? (
            <div className="hint">Đang quét transcript…</div>
          ) : !t || t.sessions === 0 ? (
            <div className="hint">Chưa có phiên nào trong khoảng này.</div>
          ) : (
            <>
              <div className="tiles">
                <Tile k="Token ra" v={fmtTokens(t.output)} s={`${fmtInt(t.sessions)} phiên`} />
                <Tile k="Token vào" v={fmtTokens(t.input + t.cacheCreate)} s={`cache đọc ${fmtTokens(t.cacheRead)}`} />
                <Tile k="Tin nhắn" v={fmtInt(t.messages)} s={`${fmtInt(Math.round(t.messages / Math.max(t.sessions, 1)))} / phiên`} />
                <Tile k="Dòng code" v={`+${fmtInt(t.linesAdded)}`} s={`−${fmtInt(t.linesRemoved)}`} />
                <Tile k="Thời gian" v={fmtDur(t.durationMs)} s="tổng phiên" />
                <Tile
                  k="Chi phí"
                  v={fmtUsd(t.costUsd)}
                  s={
                    t.costSessions < t.sessions
                      ? `chỉ ${t.costSessions}/${t.sessions} phiên có ghi`
                      : "đủ mọi phiên"
                  }
                />
              </div>

              {t.costSessions < t.sessions && (
                <p className="note">
                  Claude Code chỉ ghi bản ghi <code>cost-state</code> cho một phần phiên, nên con số đô-la là
                  giới hạn dưới. Token được cộng từ từng message nên luôn đầy đủ — hãy đọc token trước.
                </p>
              )}

              {days.length > 1 && (
                <div className="card">
                  <div className="cardhead">
                    <div>
                      <h3>{m.label} theo ngày</h3>
                      <div className="sub">{days.length} ngày gần nhất · cao nhất {m.fmt(peak)}</div>
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
                            {dayLabel(d.key)} · {d.sessions} phiên
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
                <h3>Theo model</h3>
                <div className="sub">{m.label.toLowerCase()} của từng model</div>
                <Bars
                  rows={(rep!.byModel ?? []).filter((x) => value(x) > 0).map((x, i) => ({
                    key: x.key.replace(/^claude-/, ""),
                    value: value(x),
                    text: m.fmt(value(x)),
                    color: SERIES[i] ?? "var(--series-other)",
                    note: `${fmtTokens(x.input + x.cacheCreate)} vào · ${fmtTokens(x.output)} ra · ${fmtUsd(x.costUsd)}`,
                  }))}
                />
              </div>

              <div className="card">
                <h3>Theo workspace</h3>
                <div className="sub">10 thư mục dùng nhiều nhất</div>
                <Bars
                  rows={(rep!.byWorkspace ?? []).filter((w) => value(w) > 0).slice(0, 10).map((w) => ({
                    key: shortPath(w.key).split("/").slice(-2).join("/"),
                    value: value(w),
                    text: m.fmt(value(w)),
                    color: "var(--accent)",
                    note: `${w.sessions} phiên · ${fmtTokens(w.output)} token ra · +${fmtInt(w.linesAdded)}/−${fmtInt(w.linesRemoved)}`,
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

function Tile({ k, v, s }: { k: string; v: string; s?: string }) {
  return <div className="tile"><div className="k">{k}</div><div className="v">{v}</div>{s && <div className="s">{s}</div>}</div>;
}

function Bars({ rows }: { rows: { key: string; value: number; text: string; color: string; note: string }[] }) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  if (!rows.length) return <div className="hint">Không có dữ liệu.</div>;
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
