import { afterEach, describe, expect, test } from "bun:test"
import type { AuthOAuthResult } from "@opencode-ai/plugin"
import { createTokengoAuthHooks } from "@/plugin/tokengo"
import { TOKENGO_SUBSCRIBE_URL, TOKENGO_TOKEN_NAME } from "@/provider/tokengo/client"
import { fakeTokengo } from "../lib/tokengo-server"

const servers: ReturnType<typeof fakeTokengo>[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop()
})

function setup(options?: Parameters<typeof fakeTokengo>[0]) {
  const server = fakeTokengo(options)
  servers.push(server)
  const hooks = createTokengoAuthHooks({ baseURL: server.url })
  const method = hooks.auth!.methods[0]
  if (method.type !== "oauth") throw new Error("expected oauth method")
  return { server, hooks, method }
}

async function connect(method: ReturnType<typeof setup>["method"], inputs: Record<string, string>) {
  const result = (await method.authorize(inputs)) as AuthOAuthResult
  if (result.method !== "auto") throw new Error("expected auto method")
  return result.callback()
}

describe("tokengo auth hook", () => {
  test("registers token-go with a PAT prompt only", () => {
    const { hooks, method } = setup()
    expect(hooks.auth?.provider).toBe("token-go")
    expect(method.label).toBe("System access token (PAT)")
    expect(method.prompts?.map((p) => p.key)).toEqual(["pat"])
    expect(method.prompts?.[0]).toMatchObject({ type: "text", sensitive: true })
  })

  test("provisions a key in the tokengo group, reuses it, and returns PAT metadata", async () => {
    const { server, method } = setup()
    const result = await connect(method, { pat: server.pat })
    expect(result).toEqual({
      type: "success",
      key: "sk-fake-1",
      metadata: { baseURL: server.url, group: "tokengo", username: "alice", userId: "7", pat: server.pat },
    })
    expect(server.tokens).toEqual([{ id: 1, name: TOKENGO_TOKEN_NAME, group: "tokengo", status: 1 }])
    await connect(method, { pat: server.pat })
    expect(server.tokens.length).toBe(1)
  })

  test("account without the tokengo group fails with the subscribe URL", async () => {
    const { server, method } = setup({ groups: { default: { ratio: 1 } } })
    await expect(connect(method, { pat: server.pat })).rejects.toThrow(TOKENGO_SUBSCRIBE_URL)
    expect(server.tokens).toEqual([])
  })

  test("bad PAT fails with a message that omits the PAT", async () => {
    const { method } = setup()
    const error = await connect(method, { pat: "wrong-secret" }).catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain("wrong-secret")
  })
})
