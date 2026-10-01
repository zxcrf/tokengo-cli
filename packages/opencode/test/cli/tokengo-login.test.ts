import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { cliIt } from "../lib/cli-process"
import { FAKE_TOKENGO_MODELS, fakeTokengo } from "../lib/tokengo-server"

// The CLI fixture pins OPENCODE_AUTH_CONTENT="{}", which makes Auth ignore auth.json.
// Clear it so login/status/logout read and write the real file under the fixture home.
const env = { OPENCODE_AUTH_CONTENT: "" }

describe("tokengo login/status/logout (subprocess)", () => {
  cliIt.live(
    "logs in non-interactively, reports status, and logs out",
    ({ home, opencode }) => {
      const server = fakeTokengo()
      const authFile = path.join(home, ".local", "share", "tokengo", "auth.json")
      const cacheFile = path.join(home, ".cache", "tokengo", "tokengo-models.json")
      return Effect.gen(function* () {
        const login = yield* opencode.spawn(["login", "--token", server.pat, "--base-url", server.url], { env })
        opencode.expectExit(login, 0, "login")
        const output = login.stdout + login.stderr
        expect(output).toContain(`Logged in as alice · group tokengo · ${FAKE_TOKENGO_MODELS.length} models`)
        expect(output).not.toContain(server.pat)
        expect(output).toContain(`Available models (${FAKE_TOKENGO_MODELS.length})`)
        expect(output).toContain("token-go/claude-haiku-4-5")
        expect(output).toContain("token-go/claude-sonnet-4-5 (default)")

        const auth = yield* Effect.promise(() => Bun.file(authFile).json())
        expect(auth["token-go"]).toEqual({
          type: "api",
          key: "sk-fake-1",
          metadata: { baseURL: server.url, group: "tokengo", username: "alice", userId: "7", pat: server.pat },
        })
        const cache = yield* Effect.promise(() => Bun.file(cacheFile).json())
        expect(Object.keys(cache.models).sort()).toEqual([...FAKE_TOKENGO_MODELS].sort())

        const status = yield* opencode.spawn(["status"], { env })
        opencode.expectExit(status, 0, "status")
        expect(status.stdout + status.stderr).toContain("alice")
        expect(status.stdout + status.stderr).toContain("$5.00")

        const logout = yield* opencode.spawn(["logout"], { env })
        opencode.expectExit(logout, 0, "logout")
        const after = yield* Effect.promise(() => Bun.file(authFile).json())
        expect(after["token-go"]).toBeUndefined()
        expect(yield* Effect.promise(() => Bun.file(cacheFile).exists())).toBe(false)

        const loggedOut = yield* opencode.spawn(["status"], { env })
        opencode.expectExit(loggedOut, 1, "status after logout")
        expect(loggedOut.stdout + loggedOut.stderr).toContain("tokengo login")
      }).pipe(Effect.ensuring(Effect.sync(() => server.stop())))
    },
    120_000,
  )

  cliIt.live(
    "fails fast without a token when stdin is not a TTY, and omits the PAT hint for network errors",
    ({ opencode }) =>
      Effect.gen(function* () {
        const noToken = yield* opencode.spawn(["login", "--base-url", "http://127.0.0.1:9"], {
          env: { ...env, TOKENGO_PAT: "" },
        })
        expect(noToken.exitCode).toBe(1)
        expect(noToken.stdout + noToken.stderr).toContain("Not a TTY. Pass --token or set TOKENGO_PAT")

        const offline = yield* opencode.spawn(["login", "--token", "pat-x", "--base-url", "http://127.0.0.1:9"], {
          env,
        })
        expect(offline.exitCode).not.toBe(0)
        expect(offline.stdout + offline.stderr).toContain("Could not validate token")
        expect(offline.stdout + offline.stderr).not.toContain("系统访问令牌")
        expect(offline.stdout + offline.stderr).toContain("is not HTTPS")
      }),
    60_000,
  )

  cliIt.live(
    "fails with the subscribe URL when the account cannot use the tokengo group",
    ({ home, opencode }) => {
      const server = fakeTokengo({ groups: { default: { ratio: 1 } } })
      const authFile = path.join(home, ".local", "share", "tokengo", "auth.json")
      return Effect.gen(function* () {
        const result = yield* opencode.spawn(["login", "--token", server.pat, "--base-url", server.url], { env })
        opencode.expectExit(result, 1, "login without tokengo group")
        expect(result.stdout + result.stderr).toContain("https://token-go.click/wallet")
        expect(result.stdout + result.stderr).not.toContain("    at ")
        expect(result.stdout + result.stderr).not.toContain(server.pat)
        expect(server.tokens).toEqual([])
        expect(yield* Effect.promise(() => Bun.file(authFile).exists())).toBe(false)
      }).pipe(Effect.ensuring(Effect.sync(() => server.stop())))
    },
    60_000,
  )

  cliIt.live(
    "rejects a bad token without printing it",
    ({ opencode }) => {
      const server = fakeTokengo()
      return Effect.gen(function* () {
        // Base URL from the environment (no --base-url flag) must reach the fake server.
        const result = yield* opencode.spawn(["login", "--token", "wrong-secret"], {
          env: { ...env, TOKENGO_BASE_URL: server.url },
        })
        expect(server.calls.length).toBeGreaterThan(0)
        expect(result.exitCode).not.toBe(0)
        expect(result.stdout + result.stderr).toContain("系统访问令牌")
        expect(result.stdout + result.stderr).not.toContain("wrong-secret")
      }).pipe(Effect.ensuring(Effect.sync(() => server.stop())))
    },
    60_000,
  )
})
