import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { HeadingFont, PresetId, ThemeConfig, ThemePreset } from "./types.ts";
import { resolveStartupTheme, shouldApplyMetaTheme } from "./types.ts";
import { getPreset } from "./presets.ts";
import { applyTheme } from "./theme-engine.ts";

const launchTheme = import.meta.env.VITE_DSH_THEME;

const STORAGE_KEY = "ua-theme";

interface ThemeContextValue {
  config: ThemeConfig;
  preset: ThemePreset;
  setPreset: (presetId: PresetId) => void;
  setAccent: (accentId: string) => void;
  setHeadingFont: (font: HeadingFont) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function loadFromLocalStorage(): ThemeConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.presetId === "string" && typeof parsed.accentId === "string") {
      return parsed as ThemeConfig;
    }
    return null;
  } catch {
    return null;
  }
}

function saveToLocalStorage(config: ThemeConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Storage full or unavailable — ignore
  }
}

function resolveInitialTheme(metaTheme?: ThemeConfig | null): ThemeConfig {
  return resolveStartupTheme(launchTheme, loadFromLocalStorage(), metaTheme);
}

interface ThemeProviderProps {
  metaTheme?: ThemeConfig | null;
  children: ReactNode;
}

export function ThemeProvider({ metaTheme, children }: ThemeProviderProps) {
  const [config, setConfig] = useState<ThemeConfig>(() => resolveInitialTheme(metaTheme));
  const initialized = useRef(false);
  const userChangedTheme = useRef(false);

  // Branded startup (including StrictMode replay) must not persist the override.
  // Normal launches retain upstream persistence; branded launches save user choices.
  useEffect(() => {
    applyTheme(config);
    if (launchTheme === "deepseek" ? userChangedTheme.current : initialized.current) {
      saveToLocalStorage(config);
    }
    initialized.current = true;
  }, [config]);

  // Branded startup is also immune to metadata arriving after the first render.
  useEffect(() => {
    if (shouldApplyMetaTheme(launchTheme, loadFromLocalStorage(), metaTheme)) {
      setConfig(metaTheme!);
    }
  }, [metaTheme]);

  const setPreset = useCallback((presetId: PresetId) => {
    userChangedTheme.current = true;
    setConfig((_prev) => {
      const newPreset = getPreset(presetId);
      return { presetId, accentId: newPreset.defaultAccentId };
    });
  }, []);

  const setAccent = useCallback((accentId: string) => {
    userChangedTheme.current = true;
    setConfig((prev) => ({ ...prev, accentId }));
  }, []);

  const setHeadingFont = useCallback((font: HeadingFont) => {
    userChangedTheme.current = true;
    setConfig((prev) => ({ ...prev, headingFont: font }));
  }, []);

  const preset = getPreset(config.presetId);

  return (
    <ThemeContext.Provider value={{ config, preset, setPreset, setAccent, setHeadingFont }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
