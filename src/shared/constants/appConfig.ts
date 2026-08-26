import pkg from "../../../package.json" with { type: "json" };

export const APP_CONFIG = {
  name: "HelloDigi AI Router",
  description: "Private multi-provider AI gateway for HelloDigi",
  version: pkg.version,
};

export const THEME_CONFIG = {
  storageKey: "theme",
  defaultTheme: "system",
};
