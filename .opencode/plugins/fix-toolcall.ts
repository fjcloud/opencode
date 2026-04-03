import type { Plugin } from "@opencode-ai/plugin"

export const FixToolCall: Plugin = async ({ client }) => {
  let lastRetryTime = 0
  let lastAssistantTime = 0
  let pendingIdleCheck: ReturnType<typeof setTimeout> | null = null

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
      if (event.type === "message.updated") {
        const msg = (event as any).properties
        if (msg?.role === "assistant") {
          lastAssistantTime = Date.now()
        }
      }

      if (event.type === "session.error") {
        const now = Date.now()
        if (now - lastRetryTime < 15_000) return
        lastRetryTime = now

        await retry(client, "Tool call error detected")
      }

      if (event.type === "session.idle") {
        // wait 2s then check if the last assistant message had XML tool call artifacts
        if (pendingIdleCheck) clearTimeout(pendingIdleCheck)
        pendingIdleCheck = setTimeout(async () => {
          try {
            const now = Date.now()
            if (now - lastRetryTime < 15_000) return
            // only act if the assistant was active recently (within 30s)
            if (now - lastAssistantTime > 30_000) return

            const sessions = await client.session.list()
            const active = sessions.body?.[0]
            if (!active?.id) return

            const messages = await client.session.messages({
              params: { sessionID: active.id },
            })
            const lastMsg = messages.body
              ?.filter((m: any) => m.role === "assistant")
              ?.pop()

            if (!lastMsg) return

            const parts = lastMsg.parts ?? []
            const hasXmlLeak = parts.some((p: any) => {
              const text = p.text ?? p.reasoning ?? ""
              return (
                typeof text === "string" &&
                text.includes("<tool_call>") &&
                text.includes("</tool_call>")
              )
            })

            if (hasXmlLeak) {
              lastRetryTime = Date.now()
              await retry(client, "Silent halt with XML tool call in reasoning")
            }
          } catch {
            // best effort
          }
        }, 2000)
      }
    },
  }
}

async function retry(client: any, reason: string) {
  await client.app.log({
    body: {
      service: "fix-toolcall",
      level: "warn",
      message: reason,
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
              text: "Your last action was interrupted by a tool call parsing error. Please retry the exact same action you were about to perform.",
            },
          ],
        },
      })
    }
  } catch {
    // best effort
  }
}
