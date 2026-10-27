export type Theme = "dark" | "light";
const KEY = "cctv.theme";

export function getTheme(): Theme {
  try { return (localStorage.getItem(KEY) as Theme) || "dark"; } catch { return "dark"; }
}
export function applyTheme(t: Theme) {
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem(KEY, t); } catch {}
}
export function toggleTheme(): Theme {
  const next: Theme = getTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  return next;
}
export function initTheme() { applyTheme(getTheme()); }
