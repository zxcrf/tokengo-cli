import type { Argv } from "yargs"
import { Effect, Option } from "effect"
import { mapValues } from "remeda"
import { Auth } from "@/auth"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Provider } from "@/provider/provider"
import { Tokengo } from "@/provider/tokengo/models"
import {
  TOKENGO_BASE_URL,
  make,
  requireGroup,
  provision,
  quotaToUSD,
} from "@/provider/tokengo/client"
import { errorMessage } from "@/util/error"
import { CliError, effectCmd, fail } from "../effect-cmd"
import * as Prompt from "../effect/prompt"
import { UI } from "../ui"

const MODEL_LIST_LIMIT = 30

const HINT = "Generate a 系统访问令牌 (system access token) in the token-go web console (个人设置) and try again."

const promptValue = <Value>(value: Option.Option<Value>) => {
  if (Option.isNone(value)) return Effect.die(new UI.CancelledError())
  return Effect.succeed(value.value)
}

// Auth rejections from NewAPI arrive as HTTP 401/403 or as a localized message.
const AUTH_ERROR = /\b40[13]\b|unauthori[sz]ed|forbidden|invalid access token|access token|无权/i

// Never interpolate the PAT here; client errors already omit it.
const request = <A>(message: string, fn: () => Promise<A>) =>
  Effect.tryPromise({
    try: fn,
    catch: (error) => {
      const detail = errorMessage(error)
      return new CliError({ message: `${message}: ${detail}${AUTH_ERROR.test(detail) ? `\n${HINT}` : ""}` })
    },
  })

const catalog = Effect.fnUntraced(function* () {
  const modelsDev = yield* ModelsDev.Service
  const data = yield* modelsDev.get().pipe(Effect.orElseSucceed(() => ({}) as Record<string, ModelsDev.Provider>))
  return mapValues(data, (item) => Provider.fromModelsDevProvider(item))
})

export const LoginCommand = effectCmd({
  command: "login",
  describe: "log in to TokenGo with a system access token",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .option("token", {
        describe: "system access token (系统访问令牌); defaults to $TOKENGO_PAT",
        type: "string",
      })
      .option("base-url", {
        describe: "TokenGo server URL",
        type: "string",
        // Static so help output does not depend on the environment; $TOKENGO_BASE_URL is applied in the handler.
        default: TOKENGO_BASE_URL,
      }),
  handler: Effect.fn("Cli.tokengo.login")(function* (args) {
    const authSvc = yield* Auth.Service

    UI.empty()
    yield* Prompt.intro("Log in to TokenGo")
    const baseURL = (
      args["base-url"] && args["base-url"] !== TOKENGO_BASE_URL
        ? args["base-url"]
        : process.env.TOKENGO_BASE_URL || TOKENGO_BASE_URL
    ).replace(/\/+$/, "")
    if (!baseURL.startsWith("https://"))
      yield* Prompt.log.warn(`${baseURL} is not HTTPS; your token will be sent unencrypted.`)
    const given = args.token?.trim() || process.env.TOKENGO_PAT?.trim()
    if (!given && !process.stdin.isTTY) return yield* fail("Not a TTY. Pass --token or set TOKENGO_PAT")
    const pat =
      given ||
      (yield* promptValue(
        yield* Prompt.password({
          message: "Paste your token-go 系统访问令牌",
          validate: (x) => (x && x.trim().length > 0 ? undefined : "Required"),
        }),
      )).trim()

    const client = make({ baseURL, pat })
    const spinner = Prompt.spinner()
    yield* spinner.start("Validating token")
    const [user, groups] = yield* request("Could not validate token", () =>
      Promise.all([client.self(), client.groups()]),
    ).pipe(Effect.tapError(() => spinner.stop("Token rejected", 1)))
    yield* spinner.stop(`Token valid for ${user.username}`)

    const group = yield* Effect.try({
      try: () => requireGroup(groups),
      catch: (error) => new CliError({ message: errorMessage(error) }),
    })

    yield* spinner.start("Provisioning API key")
    const result = yield* request("Could not provision an API key", () =>
      provision({ client, baseURL, pat, group, user }),
    ).pipe(Effect.tapError(() => spinner.stop("Provisioning failed", 1)))
    yield* Effect.orDie(authSvc.set(Tokengo.ID, { type: "api", key: result.key, metadata: result.metadata }))
    yield* spinner.stop("API key saved")

    // Warm the model cache with catalog metadata so the next start needs no network round trip.
    const known = yield* catalog()
    const discovered = yield* Effect.promise(() =>
      Tokengo.discover({ baseURL, pat, group, userId: result.metadata.userId, catalog: known, force: true }),
    )
    const models = Object.keys(discovered).sort()
    if (models.length === 0) yield* Prompt.log.warn(`No models are enabled for the ${group} group yet`)
    else {
      const fallback = Tokengo.defaultModelID(discovered)
      const shown = models.slice(0, MODEL_LIST_LIMIT).map((id) => `token-go/${id}${id === fallback ? " (default)" : ""}`)
      if (models.length > MODEL_LIST_LIMIT)
        shown.push(`… and ${models.length - MODEL_LIST_LIMIT} more (run \`tokengo models token-go\`)`)
      yield* Prompt.log.info([`Available models (${models.length})`, ...shown].join("\n"))
    }
    yield* Prompt.outro(`Logged in as ${user.username} · group ${group} · ${models.length} models`)
  }),
})

export const LogoutCommand = effectCmd({
  command: "logout",
  describe: "log out of TokenGo (the server-side sk- API key is kept, not revoked)",
  instance: false,
  handler: Effect.fn("Cli.tokengo.logout")(function* () {
    const authSvc = yield* Auth.Service
    UI.empty()
    yield* Prompt.intro("Log out of TokenGo")
    const existing = yield* Effect.orDie(authSvc.get(Tokengo.ID))
    yield* Effect.orDie(authSvc.remove(Tokengo.ID))
    yield* Effect.promise(() => Tokengo.clearCache())
    yield* Prompt.outro(existing ? "Logged out" : "Not logged in")
  }),
})

export const StatusCommand = effectCmd({
  command: "status",
  describe: "show TokenGo login status and balance",
  instance: false,
  handler: Effect.fn("Cli.tokengo.status")(function* () {
    const authSvc = yield* Auth.Service
    UI.empty()
    yield* Prompt.intro("TokenGo status")
    const info = yield* Effect.orDie(authSvc.get(Tokengo.ID))
    const meta = info?.type === "api" ? info.metadata : undefined
    if (!meta?.pat) return yield* fail("Not logged in. Run `tokengo login` first.")

    const baseURL = meta.baseURL || TOKENGO_BASE_URL
    const user = yield* request("Could not reach TokenGo", () => make({ baseURL, pat: meta.pat }).self())
    const cache = yield* Effect.promise(() => Tokengo.readCache())
    const usable =
      cache && cache.baseURL === baseURL && cache.group === meta.group && cache.userId === meta.userId
        ? cache
        : undefined
    const age = usable ? Math.round((Date.now() - usable.fetchedAt) / 60_000) : undefined

    yield* Prompt.log.info(`User     ${user.username}`)
    yield* Prompt.log.info(`Group    ${meta.group ?? user.group ?? "default"}`)
    yield* Prompt.log.info(`Balance  $${quotaToUSD(user.quota ?? 0).toFixed(2)}`)
    yield* Prompt.log.info(
      usable
        ? `Models   ${Object.keys(usable.models).length} (cached ${age} min ago)`
        : "Models   not cached yet (loaded on next start)",
    )
    yield* Prompt.outro(baseURL)
  }),
})
