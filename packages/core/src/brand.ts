export const Brand = {
  name: "tokengo",
  display: "TokenGo",
  envPrefix: "TOKENGO_",
  configFile: "tokengo", // tokengo.json / tokengo.jsonc
  projectDir: ".tokengo", // project-level config dir
  repo: "zxcrf/tokengo-cli",
  releaseApi: "https://api.github.com/repos/zxcrf/tokengo-cli/releases/latest",
  installScript: "https://raw.githubusercontent.com/zxcrf/tokengo-cli/main/install",
  installScriptWindows: "https://raw.githubusercontent.com/zxcrf/tokengo-cli/main/install.ps1",
  schemaURL: "https://raw.githubusercontent.com/zxcrf/tokengo-cli/main/packages/opencode/config.schema.json",
} as const
