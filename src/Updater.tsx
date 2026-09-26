import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/** Settings' "Check for updates" asks the banner, which owns the one flow. */
const ASK = "agentspace:check-update";
const EVERY = 6 * 60 * 60 * 1000;

type State =
  | { k: "idle" }
  | { k: "checking" }
  | { k: "latest"; v: string }
  | { k: "found"; u: Update }
  | { k: "loading"; u: Update; got: number; total?: number }
  | { k: "error"; msg: string };

/**
 * Update notice. Looks for a new version at launch and every 6 hours (from
 * GitHub Releases' latest.json, signature-checked by the updater plugin);
 * installing is always the user's click, because it restarts the app and the
 * terminals running in it.
 */
export function UpdateBanner() {
  const [s, setS] = useState<State>({ k: "idle" });

  useEffect(() => {
    let alive = true;
    /** `loud`: the user asked, so "up to date" and errors are worth saying. */
    const run = async (loud: boolean) => {
      if (loud) setS({ k: "checking" });
      try {
        const u = await check();
        if (!alive) return;
        if (u) setS((p) => (p.k === "loading" ? p : { k: "found", u }));
        else if (loud) setS({ k: "latest", v: await getVersion() });
      } catch (e) {
        // A 404 on latest.json: nothing has been published to GitHub yet.
        const msg = /valid release JSON/i.test(String(e)) ? "chưa tìm thấy bản phát hành nào trên GitHub." : String(e);
        if (alive && loud) setS({ k: "error", msg });
      }
    };
    run(false);
    const t = window.setInterval(() => run(false), EVERY);
    const onAsk = () => run(true);
    window.addEventListener(ASK, onAsk);
    return () => { alive = false; clearInterval(t); window.removeEventListener(ASK, onAsk); };
  }, []);

  const install = async (u: Update) => {
    setS({ k: "loading", u, got: 0 });
    try {
      await u.downloadAndInstall((ev) => {
        if (ev.event === "Started") setS({ k: "loading", u, got: 0, total: ev.data.contentLength });
        else if (ev.event === "Progress") setS((p) => (p.k === "loading" ? { ...p, got: p.got + ev.data.chunkLength } : p));
      });
      // Windows exits into the installer by itself; elsewhere, restart here.
      await relaunch();
    } catch (e) {
      setS({ k: "error", msg: String(e) });
    }
  };

  const close = () => setS({ k: "idle" });
  if (s.k === "idle") return null;
  return (
    <div className={"banner" + (s.k === "error" ? " err" : "")}>
      {s.k === "checking" && <span>Đang kiểm tra phiên bản mới…</span>}
      {s.k === "latest" && <span>Bạn đang dùng bản mới nhất ({s.v}).</span>}
      {s.k === "error" && <span>Không cập nhật được: {s.msg}</span>}
      {s.k === "found" && (
        <span>
          Có phiên bản mới <b>{s.u.version}</b> (đang dùng {s.u.currentVersion}).
          {s.u.body ? ` ${s.u.body}` : ""} Cập nhật sẽ khởi động lại app — các terminal đang chạy sẽ bị đóng.
        </span>
      )}
      {s.k === "loading" && (
        <span>
          Đang tải {s.u.version}…{" "}
          {s.total ? `${Math.round((s.got / s.total) * 100)}%` : `${(s.got / 1048576).toFixed(1)} MB`}
        </span>
      )}
      <span style={{ flex: 1 }} />
      {s.k === "found" && <button className="btn primary" onClick={() => install(s.u)}>Cập nhật và khởi động lại</button>}
      {s.k !== "loading" && s.k !== "checking" && <button className="btn" onClick={close}>{s.k === "found" ? "Để sau" : "Đóng"}</button>}
    </div>
  );
}

/** Settings card: the running version and a manual check. */
export function UpdateCard() {
  const [v, setV] = useState("");
  useEffect(() => { getVersion().then(setV).catch(() => {}); }, []);
  return (
    <div className="card">
      <h3>Cập nhật</h3>
      <div className="sub">phiên bản {v || "…"} · tự kiểm tra khi mở app và mỗi 6 giờ</div>
      <button className="btn" onClick={() => window.dispatchEvent(new Event(ASK))}>Kiểm tra cập nhật</button>
    </div>
  );
}
