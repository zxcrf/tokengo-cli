import type { Hooks } from "@opencode-ai/plugin"
import { ID } from "../provider/tokengo/models"
import { TOKENGO_BASE_URL, make, requireGroup, provision, type Fetch } from "../provider/tokengo/client"

export async function TokengoAuthPlugin(): Promise<Hooks> {
  return createTokengoAuthHooks()
}

export function createTokengoAuthHooks(input: { baseURL?: string; fetch?: Fetch } = {}): Hooks {
  return {
    auth: {
      provider: ID,
      methods: [
        {
          type: "oauth",
          label: "System access token (PAT)",
          prompts: [
            { type: "text", key: "pat", message: "Paste your token-go 系统访问令牌", sensitive: true },
          ],
          async authorize(inputs) {
            return {
              url: "",
              instructions: "Validating token…",
              method: "auto",
              callback: async () => {
                // Resolved per attempt so TOKENGO_BASE_URL can point at a self-hosted or test server.
                const baseURL = input.baseURL ?? (process.env.TOKENGO_BASE_URL || TOKENGO_BASE_URL)
                const pat = inputs?.pat?.trim()
                if (!pat) throw new Error("A token-go 系统访问令牌 is required")
                const client = make({ baseURL, pat, fetch: input.fetch })
                const [user, groups] = await Promise.all([client.self(), client.groups()])
                const group = requireGroup(groups)
                const result = await provision({ client, baseURL, pat, group, user })
                return { type: "success", key: result.key, metadata: result.metadata }
              },
            }
          },
        },
      ],
    },
  }
}
