import { describe, expect, test } from "bun:test"
import path from "path"

const entry = path.join(import.meta.dir, "../../src/env-alias.ts")

function run(env: Record<string, string>, expr: string) {
  const proc = Bun.spawnSync(["bun", "-e", `await import(${JSON.stringify(entry)}); console.log(${expr})`], {
    env: { PATH: process.env.PATH ?? "", ...env },
  })
  return proc.stdout.toString().trim()
}

describe("env-alias", () => {
  test("maps TOKENGO_* to OPENCODE_*", () => {
    expect(run({ TOKENGO_FOO: "bar" }, "process.env.OPENCODE_FOO")).toBe("bar")
  })

  test("maps TOKENGO_BIN_PATH to OPENCODE_BIN_PATH", () => {
    expect(run({ TOKENGO_BIN_PATH: "/x/tokengo" }, "process.env.OPENCODE_BIN_PATH")).toBe("/x/tokengo")
  })

  test("explicit OPENCODE_* wins", () => {
    expect(run({ TOKENGO_FOO: "a", OPENCODE_FOO: "b" }, "process.env.OPENCODE_FOO")).toBe("b")
  })

  test("never aliases credential variables", () => {
    for (const key of ["API_KEY", "PAT", "BASE_URL", "GROUP"]) {
      expect(run({ [`TOKENGO_${key}`]: "secret" }, `String(process.env.OPENCODE_${key})`)).toBe("undefined")
    }
  })
})
