import { afterEach, describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import { readBalance } from "@/plugin/tui/tokengo-balance"
import { fakeTokengo } from "../lib/tokengo-server"

const servers: ReturnType<typeof fakeTokengo>[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop()
})

async function authFile(content: unknown) {
  const file = path.join(os.tmpdir(), `tokengo-auth-${crypto.randomUUID()}.json`)
  await Bun.write(file, JSON.stringify(content))
  return file
}

describe("tokengo sidebar balance", () => {
  // The sidebar must show the wallet balance in USD, converted from NewAPI quota units (500000 = $1).
  test("reads the PAT from auth.json and converts quota to USD", async () => {
    const server = fakeTokengo()
    servers.push(server)
    const file = await authFile({
      "token-go": { type: "api", key: "sk-fake-1", metadata: { pat: server.pat, baseURL: server.url } },
    })
    expect(await readBalance({ file })).toBe(5)
    expect(server.calls).toEqual(["GET /api/user/self"])
  })

  // Logged-out users must not see a balance row or trigger relay calls.
  test("returns undefined without a TokenGo login", async () => {
    expect(await readBalance({ file: await authFile({}) })).toBeUndefined()
    expect(await readBalance({ file: path.join(os.tmpdir(), "missing-auth.json") })).toBeUndefined()
  })

  // A malformed entry for another provider must not hide the TokenGo balance.
  test("ignores malformed entries for other providers", async () => {
    const server = fakeTokengo()
    servers.push(server)
    const file = await authFile({
      other: { type: "bogus" },
      "token-go": { type: "api", key: "sk-fake-1", metadata: { pat: server.pat, baseURL: server.url } },
    })
    expect(await readBalance({ file })).toBe(5)
  })
})
