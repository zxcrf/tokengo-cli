export const Brand = {
  name: "tokengo",
  display: "TokenGo",
  envPrefix: "TOKENGO_",
  configFile: "tokengo", // tokengo.json / tokengo.jsonc
  projectDir: ".tokengo", // project-level config dir
  repo: "zxcrf/opencode",
  releaseApi: "https://api.github.com/repos/zxcrf/opencode/releases/latest",
  installScript: "https://raw.githubusercontent.com/zxcrf/opencode/dev/install",
  schemaURL: "https://raw.githubusercontent.com/zxcrf/opencode/dev/packages/opencode/config.schema.json",
} as const
