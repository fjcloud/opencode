import type { Plugin } from "@opencode-ai/plugin"

export const FixToolCall: Plugin = async ({ client }) => {
  let lastRetryTime = 0
  let sawToolCallXml = false
  let toolExecuted = false

  return {
    "tool.execute.before": async (input, output) => {
      toolExecuted = true
      if (!output.args) return
      for (const [key, value] of Object.entries(output.args)) {
        if (typeof value === "string" && value.includes("</tool_call>")) {
          output.args[key] = value.replace(/<\/?tool_call>/g, "").trim()
        }
      }
    },

    event: async ({ event }) => {
      // track assistant messages for XML leaks
      if (event.type === "message.part.updated") {
        const props = (event as any).properties ?? {}
        const text =
          props.text ?? props.content ?? props.reasoning ?? ""
        if (typeof text === "string" && text.includes("<tool_call>")) {
          sawToolCallXml = true
          toolExecuted = false
        }
      }

      // session error: always retry
      if (event.type === "session.error") {
        const now = Date.now()
        if (now - lastRetryTime < 15_000) return
        lastRetryTime = now
        sawToolCallXml = false
        await retry(client)
      }

      // session idle: check if we saw XML but no tool execution
      if (event.type === "session.idle") {
        if (!sawToolCallXml || toolExecuted) {
          sawToolCallXml = false
          toolExecuted = false
          return
        }

        const now = Date.now()
        if (now - lastRetryTime < 15_000) return

        lastRetryTime = now
        sawToolCallXml = false
        toolExecuted = false

        await client.app.log({
          body: {
            service: "fix-toolcall",
            level: "warn",
            message:
              "Silent halt detected: saw <tool_call> XML but no tool executed. Retrying.",
          },
        })

        await retry(client)
      }
    },
  }
}

async function retry(client: any) {
  try {
    const sessions = await client.session.list()
    const active = sessions.body?.[0]
    if (!active?.id) return

    await client.session.chat({
      body: {
        sessionID: active.id,
        parts: [
          {
            type: "text",
            text: "Continue - your last tool call was not parsed correctly. Retry the same action.",
          },
        ],
      },
    })
  } catch (e) {
    await client.app.log({
      body: {
        service: "fix-toolcall",
        level: "error",
        message: `Retry failed: ${e}`,
      },
    })
  }
}
