/**
 * Theme = the 16 ANSI colours plus background/foreground/cursor/selection and
 * one accent. Every UI surface token (panels, borders, dim text, chip states)
 * is *derived* from those by mixing, so adding a theme is 20 hex values rather
 * than a stylesheet — and the terminal and the chrome around it can never drift
 * apart.
 */
export type Palette = {
  background: string; foreground: string; cursor: string; selectionBackground: string;
  black: string; red: string; green: string; yellow: string;
  blue: string; magenta: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string;
  brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
};
export type Theme = { id: string; name: string; group: string; dark: boolean; accent: string; term: Palette };

const p = (
  background: string, foreground: string, cursor: string, selectionBackground: string,
  n: [string, string, string, string, string, string, string, string],
  b: [string, string, string, string, string, string, string, string],
): Palette => ({
  background, foreground, cursor, selectionBackground,
  black: n[0], red: n[1], green: n[2], yellow: n[3], blue: n[4], magenta: n[5], cyan: n[6], white: n[7],
  brightBlack: b[0], brightRed: b[1], brightGreen: b[2], brightYellow: b[3],
  brightBlue: b[4], brightMagenta: b[5], brightCyan: b[6], brightWhite: b[7],
});

export const THEMES: Theme[] = [
  { id: "agentspace", name: "Agentspace Dark", group: "Agentspace", dark: true, accent: "#d95926",
    term: p("#0d0d10", "#e7e7ec", "#d95926", "#2f3d4e",
      ["#1a1a20", "#e66767", "#199e70", "#c98500", "#3987e5", "#d55181", "#3aa8a0", "#c8c8d0"],
      ["#63636f", "#ff8a8a", "#3fc793", "#eab308", "#5ba0f0", "#e87ba4", "#5fd0c8", "#ffffff"]) },

  { id: "dark-plus", name: "Dark+", group: "VS Code", dark: true, accent: "#0078d4",
    term: p("#1e1e1e", "#cccccc", "#aeafad", "#264f78",
      ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5"],
      ["#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"]) },

  { id: "light-plus", name: "Light+", group: "VS Code", dark: false, accent: "#005fb8",
    term: p("#ffffff", "#3b3b3b", "#005fb8", "#add6ff",
      ["#000000", "#cd3131", "#00bc00", "#949800", "#0451a5", "#bc05bc", "#0598bc", "#555555"],
      ["#666666", "#cd3131", "#14ce14", "#b5ba00", "#0451a5", "#bc05bc", "#0598bc", "#a5a5a5"]) },

  { id: "monokai", name: "Monokai", group: "VS Code", dark: true, accent: "#a6e22e",
    term: p("#272822", "#f8f8f2", "#f8f8f0", "#49483e",
      ["#272822", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f8f8f2"],
      ["#75715e", "#fd5ff0", "#c3e88d", "#ffd866", "#7fd5ff", "#c792ea", "#b6f8f0", "#f9f8f5"]) },

  { id: "monokai-dimmed", name: "Monokai Dimmed", group: "VS Code", dark: true, accent: "#9872a2",
    term: p("#1e1e1e", "#c5c8c6", "#c5c8c6", "#3d3d3d",
      ["#000000", "#ce5b5f", "#9bc26f", "#d9a85c", "#6c99bb", "#9872a2", "#7fb2c8", "#c5c8c6"],
      ["#666666", "#e17a7f", "#b5d68a", "#e9c07a", "#8ab5d6", "#b48cc0", "#9fcbdd", "#ffffff"]) },

  { id: "solarized-dark", name: "Solarized Dark", group: "VS Code", dark: true, accent: "#268bd2",
    term: p("#002b36", "#93a1a1", "#93a1a1", "#073642",
      ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5"],
      ["#586e75", "#cb4b16", "#a3b32b", "#d4a017", "#4aa3e0", "#6c71c4", "#3fc0b5", "#fdf6e3"]) },

  { id: "solarized-light", name: "Solarized Light", group: "VS Code", dark: false, accent: "#268bd2",
    term: p("#fdf6e3", "#586e75", "#586e75", "#eee8d5",
      ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#93a1a1"],
      ["#657b83", "#cb4b16", "#6d7a00", "#96700a", "#1c6fa8", "#6c71c4", "#1f8177", "#002b36"]) },

  { id: "quiet-light", name: "Quiet Light", group: "VS Code", dark: false, accent: "#7a3e9d",
    term: p("#f5f5f5", "#333333", "#333333", "#c9d0d9",
      ["#333333", "#ab6526", "#448c27", "#a67f59", "#7a3e9d", "#4b69c6", "#207f70", "#666666"],
      ["#7a7a7a", "#cd3131", "#2f7f1f", "#8a6a3a", "#5f2f80", "#3552a8", "#146054", "#a5a5a5"]) },

  { id: "abyss", name: "Abyss", group: "VS Code", dark: true, accent: "#ff628c",
    term: p("#000c18", "#8aa6c9", "#ddbb88", "#1f3a5f",
      ["#000000", "#ff628c", "#3ad900", "#ffd700", "#82aaff", "#ff9d00", "#80fcff", "#f8f8f8"],
      ["#465a72", "#ff879d", "#6ce34d", "#ffe066", "#a3c1ff", "#ffb84d", "#a6fdff", "#ffffff"]) },

  { id: "kimbie-dark", name: "Kimbie Dark", group: "VS Code", dark: true, accent: "#f79a32",
    term: p("#221a0f", "#d3af86", "#d3af86", "#5b4636",
      ["#221a0f", "#dc3958", "#7f9f5b", "#f06431", "#4c99c7", "#98676a", "#68a4a4", "#d3af86"],
      ["#7e602c", "#f26d78", "#a0c15d", "#f79a32", "#6bb7de", "#c98a8c", "#89c5c5", "#e9d3b1"]) },

  { id: "tomorrow-night-blue", name: "Tomorrow Night Blue", group: "VS Code", dark: true, accent: "#bbdaff",
    term: p("#002451", "#ffffff", "#ffffff", "#003f8e",
      ["#00346e", "#ff9da4", "#d1f1a9", "#ffeead", "#bbdaff", "#ebbbff", "#99ffff", "#ffffff"],
      ["#4a7bbf", "#ffb3b9", "#dcf5bd", "#fff3c4", "#cfe4ff", "#f1cdff", "#b5ffff", "#ffffff"]) },

  { id: "red", name: "Red", group: "VS Code", dark: true, accent: "#ff5f52",
    term: p("#390000", "#f8f8f8", "#970000", "#750000",
      ["#570000", "#ff6161", "#7bd88f", "#ffd479", "#8ab4f8", "#ff8ad8", "#7fdbca", "#f8f8f8"],
      ["#8c4a4a", "#ff8f8f", "#a5e5b3", "#ffe3a8", "#b0cdfb", "#ffb0e5", "#a8e8dd", "#ffffff"]) },

  { id: "hc-light", name: "High Contrast Light", group: "VS Code", dark: false, accent: "#0f4a85",
    term: p("#ffffff", "#292929", "#000000", "#b4d5fe",
      ["#292929", "#b5200d", "#007100", "#714f00", "#0f4a85", "#811f82", "#007370", "#6f6f6f"],
      ["#5f5f5f", "#a01a0a", "#005c00", "#5c4000", "#0c3c6b", "#6a1a6b", "#005c5a", "#292929"]) },

  { id: "hc-dark", name: "High Contrast Dark", group: "VS Code", dark: true, accent: "#f38518",
    term: p("#000000", "#ffffff", "#ffffff", "#0f4a85",
      ["#000000", "#c50f1f", "#16c60c", "#f9f1a5", "#0037da", "#881798", "#3a96dd", "#cccccc"],
      ["#767676", "#e74856", "#4fe04a", "#fdf7bd", "#3b78ff", "#b4009e", "#61d6d6", "#f2f2f2"]) },

  { id: "dracula", name: "Dracula", group: "Cộng đồng", dark: true, accent: "#bd93f9",
    term: p("#282a36", "#f8f8f2", "#f8f8f2", "#44475a",
      ["#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2"],
      ["#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff"]) },

  { id: "nord", name: "Nord", group: "Cộng đồng", dark: true, accent: "#88c0d0",
    term: p("#2e3440", "#d8dee9", "#d8dee9", "#434c5e",
      ["#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0"],
      ["#4c566a", "#d08770", "#b5cfa0", "#f0d9a3", "#9ab8d4", "#c5a1be", "#8fbcbb", "#eceff4"]) },

  { id: "one-dark", name: "One Dark Pro", group: "Cộng đồng", dark: true, accent: "#61afef",
    term: p("#282c34", "#abb2bf", "#528bff", "#3e4451",
      ["#282c34", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf"],
      ["#5c6370", "#ef8891", "#aed58f", "#eccf99", "#82c0f5", "#d492e6", "#75c9d3", "#ffffff"]) },

  { id: "tokyo-night", name: "Tokyo Night", group: "Cộng đồng", dark: true, accent: "#7aa2f7",
    term: p("#1a1b26", "#a9b1d6", "#c0caf5", "#33467c",
      ["#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6"],
      ["#414868", "#ff7a93", "#b9f27c", "#ff9e64", "#9db9ff", "#cdb2ff", "#a4e0ff", "#c0caf5"]) },

  { id: "github-dark", name: "GitHub Dark", group: "Cộng đồng", dark: true, accent: "#58a6ff",
    term: p("#0d1117", "#c9d1d9", "#58a6ff", "#264f78",
      ["#484f58", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4"],
      ["#6e7681", "#ffa198", "#56d364", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#f0f6fc"]) },

  { id: "github-light", name: "GitHub Light", group: "Cộng đồng", dark: false, accent: "#0969da",
    term: p("#ffffff", "#24292f", "#0969da", "#b6d9ff",
      ["#24292f", "#cf222e", "#116329", "#7d4e00", "#0969da", "#8250df", "#1b7c83", "#6e7781"],
      ["#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#8c959f"]) },

  { id: "gruvbox-dark", name: "Gruvbox Dark", group: "Cộng đồng", dark: true, accent: "#fe8019",
    term: p("#282828", "#ebdbb2", "#ebdbb2", "#504945",
      ["#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984"],
      ["#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2"]) },

  { id: "gruvbox-light", name: "Gruvbox Light", group: "Cộng đồng", dark: false, accent: "#af3a03",
    term: p("#fbf1c7", "#3c3836", "#3c3836", "#d5c4a1",
      ["#3c3836", "#9d0006", "#79740e", "#b57614", "#076678", "#8f3f71", "#427b58", "#7c6f64"],
      ["#665c54", "#af3a03", "#5f5a06", "#8f5f0a", "#054b5e", "#722f59", "#316245", "#282828"]) },
];

// ------------------------------------------------------------------- mixing

const rgb = (h: string) => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
/** `t` is how far from `a` toward `b`. */
export const mix = (a: string, b: string, t: number) => {
  const [ar, ag, ab] = rgb(a), [br, bg, bb] = rgb(b);
  const c = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
  return `#${c(ar, br)}${c(ag, bg)}${c(ab, bb)}`;
};
const luminance = (h: string) =>
  rgb(h)
    .map((v) => v / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);

export const themeById = (id: string) => THEMES.find((t) => t.id === id) ?? THEMES[0];

/**
 * Push a theme into CSS custom properties. Surfaces step away from the
 * background toward the foreground, so the same ladder works in light and dark
 * without a second set of numbers.
 */
export function applyTheme(t: Theme) {
  const { background: bg, foreground: fg } = t.term;
  const s = document.documentElement.style;
  const set = (k: string, v: string) => s.setProperty(k, v);

  const step = t.dark ? 1 : 0.85; // light surfaces need a gentler ladder
  set("--bg", bg);
  set("--panel", mix(bg, fg, 0.04 * step));
  set("--raise", mix(bg, fg, 0.08 * step));
  set("--hover", mix(bg, fg, 0.13 * step));
  set("--line", mix(bg, fg, 0.17 * step));
  set("--line-soft", mix(bg, fg, 0.09 * step));
  set("--text", fg);
  set("--dim", mix(fg, bg, 0.32));
  set("--faint", mix(fg, bg, 0.55));

  set("--accent", t.accent);
  set("--accent-ink", luminance(t.accent) > 0.5 ? "#000000" : "#ffffff");

  // Semantic + categorical roles come from the palette the terminal already
  // uses, so a chart and the shell output beside it agree on what "green" is.
  const ok = t.dark ? t.term.brightGreen : t.term.green;
  const warn = t.dark ? t.term.brightYellow : t.term.yellow;
  const danger = t.dark ? t.term.brightRed : t.term.red;
  set("--ok", ok);
  set("--warn", warn);
  set("--danger", danger);
  set("--series-1", t.dark ? t.term.brightBlue : t.term.blue);
  set("--series-2", warn);
  set("--series-3", t.dark ? t.term.brightCyan : t.term.cyan);
  set("--series-other", mix(fg, bg, 0.45));

  // Pane status chips: one hue each, tinted onto the surface.
  for (const [name, c] of [
    ["run", t.dark ? t.term.brightBlue : t.term.blue],
    ["att", warn],
    ["done", ok],
    ["err", danger],
  ] as const) {
    set(`--${name}-fg`, mix(c, fg, t.dark ? 0.3 : 0.15));
    set(`--${name}-bg`, mix(bg, c, 0.13));
    set(`--${name}-line`, mix(bg, c, 0.34));
  }

  document.documentElement.dataset.theme = t.id;
  document.documentElement.style.colorScheme = t.dark ? "dark" : "light";
}
