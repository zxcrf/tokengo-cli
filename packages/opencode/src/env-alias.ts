// Must have zero imports and be the first import of the entrypoint: Flag and xdg-basedir read env at module load.
// Maps TOKENGO_* -> OPENCODE_* (explicit OPENCODE_* wins). Idempotent.
//
// SECURITY: these TOKENGO_* variables carry our credentials/endpoints. Aliasing them would make e.g.
// OPENCODE_API_KEY visible to upstream opencode's free-pool provider and leak our key to opencode.ai.
const DENY = new Set(["TOKENGO_API_KEY", "TOKENGO_PAT", "TOKENGO_BASE_URL", "TOKENGO_GROUP"])

for (const key of Object.keys(process.env)) {
  if (!key.startsWith("TOKENGO_") || DENY.has(key)) continue
  const target = "OPENCODE_" + key.slice("TOKENGO_".length)
  if (process.env[target] === undefined) process.env[target] = process.env[key]
}
