/** 主题偏好：跟随浏览器、强制浅色或强制深色。 */
export type ThemeMode = "system" | "light" | "dark";
/** 实际生效的主题；「跟随系统」会被解析成浅色或深色。 */
export type ResolvedTheme = "light" | "dark";

/** localStorage 中保存主题偏好的键名。 */
const themePreferenceKey = "corvex-ops-theme";

/** 把持久化字符串收敛到合法偏好；未知值一律回退到跟随系统。 */
export function resolveThemeMode(saved: string): ThemeMode {
  return saved === "light" || saved === "dark" ? saved : "system";
}

/** 根据偏好与系统设置解析出实际主题。 */
export function resolveTheme(mode: ThemeMode, systemDark: boolean): ResolvedTheme {
  return mode === "system" ? (systemDark ? "dark" : "light") : mode;
}

/** 读取当前浏览器是否偏好深色；非浏览器环境（如单测）按浅色处理。 */
export function prefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** 读取已保存的主题偏好；localStorage 不可用时回退到跟随系统。 */
export function readThemeMode(): ThemeMode {
  try {
    return resolveThemeMode(window.localStorage.getItem(themePreferenceKey) ?? "");
  } catch (error) {
    window.console.warn("read agent console theme preference failed", error);
    return "system";
  }
}

/** 保存主题偏好；隐私模式等场景下写入失败只记录告警。 */
export function saveThemeMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(themePreferenceKey, mode);
  } catch (error) {
    window.console.warn("save agent console theme preference failed", error);
  }
}
