import type { Plugin } from "@opencode-ai/plugin"

export const FixToolCall: Plugin = async ({ client }) => {
  let lastRetryTime = 0
  let sawToolCallXml = false
  let toolExecuted = false
  let activeSessionId = ""

  const log = (level: string, message: string) =>
    client.app.log({
      body: { service: "fix-toolcall", level, message },
    })

  await log("info", "Plugin loaded")

  return {
    "tool.execute.before": async (input, output) => {
      toolExecuted = true
      activeSessionId = input.sessionID
      if (!output.args) return
      for (const [key, value] of Object.entries(output.args)) {
        if (typeof value === "string" && value.includes("</tool_call>")) {
          output.args[key] = value.replace(/<\/?tool_call>/g, "").trim()
          await log("warn", `Stripped XML from arg "${key}"`)
        }
      }
    },

    event: async ({ event }) => {
      const sessionId =
        (event as any).properties?.sessionID ??
        (event as any).properties?.session_id ??
        (event as any).session_id ??
        (event as any).sessionID ??
        ""

      if (sessionId) activeSessionId = sessionId

      if (event.type === "message.part.updated") {
        const props = (event as any).properties ?? {}
        const keys = Object.keys(props)
        const allText = JSON.stringify(props)

        // Log structure of every message.part.updated so we can see what fields exist
        await log("debug", `msg.part keys=${keys.join(",")} len=${allText.length} snippet=${allText.slice(0, 300)}`)

        if (allText.includes("<tool_call>") || allText.includes("&lt;tool_call&gt;")) {
          sawToolCallXml = true
          toolExecuted = false
          await log("warn", `XML <tool_call> detected in message part`)
        }
      }

      if (event.type === "session.error") {
        await log("error", `session.error fired`)
        const now = Date.now()
        if (now - lastRetryTime < 15_000) return
        lastRetryTime = now
        sawToolCallXml = false
        await retry(client, activeSessionId, log)
      }

      if (event.type === "session.idle") {
        await log("info", `session.idle: sawXml=${sawToolCallXml} toolExec=${toolExecuted} sid=${activeSessionId}`)

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

        await log("warn", "Silent halt detected - retrying")
        await retry(client, activeSessionId, log)
      }
    },
  }
}

async function retry(client: any, sessionId: string, log: any) {
  if (!sessionId) {
    await log("error", "No session ID available for retry")
    return
  }

  try {
    await log("info", `Retrying on session ${sessionId}`)
    await client.session.prompt({
      path: { id: sessionId },
      body: {
        parts: [
          {
            type: "text",
            text: "Continue - your last tool call was not parsed correctly. Retry the same action.",
          },
        ],
      },
    })
  } catch (e: any) {
    await log("error", `Retry failed: ${e?.message ?? e}`)
  }
}
