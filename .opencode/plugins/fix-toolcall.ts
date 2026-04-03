import type { Plugin } from "@opencode-ai/plugin"

export const FixToolCall: Plugin = async ({ client }) => {
  let lastErrorTime = 0

  return {
    "tool.execute.before": async (input, output) => {
      if (!output.args) return

      for (const [key, value] of Object.entries(output.args)) {
        if (typeof value === "string" && value.includes("</tool_call>")) {
          output.args[key] = value.replace(/<\/?tool_call>/g, "").trim()
        }
      }
    },

    event: async ({ event }) => {
      if (event.type === "session.error") {
        const now = Date.now()
        // debounce: don't retry more than once per 10s
        if (now - lastErrorTime < 10_000) return
        lastErrorTime = now

        const error = (event as any).properties?.error ?? ""
        const msg = typeof error === "string" ? error : JSON.stringify(error)

        const isToolCallError =
          msg.includes("function.name") ||
          msg.includes("tool_call") ||
          msg.includes("JSON Parse") ||
          msg.includes("Invalid input") ||
          msg.includes("Bad Request")

        if (isToolCallError) {
          await client.app.log({
            body: {
              service: "fix-toolcall",
              level: "warn",
              message: `Tool call error detected, continuing session: ${msg.slice(0, 200)}`,
            },
          })

          try {
            const sessions = await client.session.list()
            const active = sessions.body?.[0]
            if (active?.id) {
              await client.session.chat({
                body: {
                  sessionID: active.id,
                  parts: [
                    {
                      type: "text",
                      text: "Your last tool call failed due to a parsing error. Please retry the same action.",
                    },
                  ],
                },
              })
            }
          } catch {
            // best effort
          }
        }
      }
    },
  }
}
