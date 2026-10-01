import { describe, expect } from "bun:test"
import path from "path"
import { unlink } from "fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Effect, Layer } from "effect"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TOKENGO_SUBSCRIBE_URL } from "@/provider/tokengo/client"
import { fakeTokengo } from "../lib/tokengo-server"
import { httpApiLayer, request } from "./httpapi-layer"
import { clearCache } from "@/provider/tokengo/models"

const testStateLayer = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.promise(() => resetDatabase()),
    () => Effect.promise(() => resetDatabase()),
  ),
)

const it = testEffect(Layer.mergeAll(testStateLayer, LayerNode.compile(FSUtil.node), httpApiLayer))
const projectOptions = { config: { formatter: false, lsp: false } }

type ProviderList = { all: { id: string; name: string }[]; default: Record<string, string>; connected: string[] }

function setEnvScoped(key: string, value: string | undefined) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[key]
        else process.env[key] = previous
      }),
  )
}

// The callback writes the real auth.json under the test data dir; restore it afterwards.
const preserveAuthFile = Effect.acquireRelease(
  Effect.promise(async () => {
    const file = path.join(Global.Path.data, "auth.json")
    return {
      file,
      original: await Bun.file(file)
        .text()
        .catch(() => undefined),
    }
  }),
  ({ file, original }) =>
    Effect.promise(async () => {
      if (original !== undefined) await Bun.write(file, original)
      else await unlink(file).catch(() => undefined)
      await clearCache()
    }),
)

describe("token-go over the provider HttpApi", () => {
  it.instance(
    "lists TokenGo before login without a default model",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      yield* setEnvScoped("OPENCODE_AUTH_CONTENT", "{}")
      const response = yield* request("/provider", { headers: { "x-opencode-directory": directory } })
      expect(response.status).toBe(200)
      const body = (yield* response.json) as ProviderList
      expect(body.all.find((item) => item.id === "token-go")?.name).toBe("TokenGo")
      expect(body.connected).not.toContain("token-go")
      expect(body.default["token-go"]).toBeUndefined()

      const auth = yield* request("/provider/auth", { headers: { "x-opencode-directory": directory } })
      const methods = (yield* auth.json) as Record<
        string,
        { type: string; label: string; prompts?: { key: string; sensitive?: boolean }[] }[]
      >
      expect(methods["token-go"]).toEqual([
        expect.objectContaining({ type: "oauth", label: "System access token (PAT)" }),
      ])
      expect(methods["token-go"][0].prompts?.find((p) => p.key === "pat")?.sensitive).toBe(true)
      expect(methods["token-go"][0].prompts?.map((p) => p.key)).toEqual(["pat"])
    }),
    projectOptions,
    30000,
  )

  it.instance(
    "/connect fails with the subscribe URL when the account lacks the tokengo group",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const server = fakeTokengo({ groups: { default: { ratio: 1 } } })
      yield* Effect.addFinalizer(() => Effect.sync(() => server.stop()))
      yield* preserveAuthFile
      yield* setEnvScoped("OPENCODE_AUTH_CONTENT", undefined)
      yield* setEnvScoped("TOKENGO_BASE_URL", server.url)
      const headers = { "x-opencode-directory": directory, "content-type": "application/json" }

      const authorize = yield* request("/provider/token-go/oauth/authorize", {
        method: "POST",
        headers,
        body: JSON.stringify({ method: 0, inputs: { pat: server.pat } }),
      })
      expect(authorize.status).toBe(200)

      const callback = yield* request("/provider/token-go/oauth/callback", {
        method: "POST",
        headers,
        body: JSON.stringify({ method: 0 }),
      })
      expect(callback.status).not.toBe(200)
      expect(yield* callback.text).toContain(TOKENGO_SUBSCRIBE_URL)

      const authFile = Bun.file(path.join(Global.Path.data, "auth.json"))
      const stored = (yield* Effect.promise(() => authFile.exists())) ? yield* Effect.promise(() => authFile.json()) : {}
      expect(stored["token-go"]).toBeUndefined()
    }),
    projectOptions,
    30000,
  )

  it.instance(
    "/connect flow persists the provisioned key with PAT metadata and connects the provider",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const server = fakeTokengo()
      yield* Effect.addFinalizer(() => Effect.sync(() => server.stop()))
      yield* preserveAuthFile
      yield* setEnvScoped("OPENCODE_AUTH_CONTENT", undefined)
      yield* setEnvScoped("TOKENGO_BASE_URL", server.url)
      const headers = { "x-opencode-directory": directory, "content-type": "application/json" }

      const authorize = yield* request("/provider/token-go/oauth/authorize", {
        method: "POST",
        headers,
        body: JSON.stringify({ method: 0, inputs: { pat: server.pat } }),
      })
      expect(authorize.status).toBe(200)
      expect(yield* authorize.json).toMatchObject({ method: "auto" })

      const callback = yield* request("/provider/token-go/oauth/callback", {
        method: "POST",
        headers,
        body: JSON.stringify({ method: 0 }),
      })
      expect(callback.status).toBe(200)

      const stored = yield* Effect.promise(() => Bun.file(path.join(Global.Path.data, "auth.json")).json())
      expect(stored["token-go"]).toEqual({
        type: "api",
        key: "sk-fake-1",
        metadata: { baseURL: server.url, group: "tokengo", username: "alice", userId: "7", pat: server.pat },
      })

      // Fresh instance (the TUI disposes after connecting) picks the provider up with discovered models.
      yield* request("/instance/dispose", { method: "POST", headers })
      const list = yield* request("/provider", { headers })
      const text = yield* list.text
      // The PAT lives only in auth metadata; provider listings must never echo it.
      expect(text).not.toContain(server.pat)
      const body = JSON.parse(text) as ProviderList
      expect(body.connected).toContain("token-go")
      expect(body.default["token-go"]).toBe("claude-sonnet-4-5")
    }),
    projectOptions,
    30000,
  )
})
