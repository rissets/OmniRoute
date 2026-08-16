import pkg from "../../../package.json" with { type: "json" };

export const APP_CONFIG = {
  name: "BP Batam AI Router",
  description: "AI Gateway for BP Batam Multi-Provider LLMs",
  version: pkg.version,
};

export const THEME_CONFIG = {
  storageKey: "theme",
  defaultTheme: "system",
};
