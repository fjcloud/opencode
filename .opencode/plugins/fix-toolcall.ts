import type { Plugin } from "@opencode-ai/plugin"

export const FixToolCall: Plugin = async ({ client }) => {
  let lastRetryTime = 0
  let sawToolCallXml = false
  let toolExecuted = false

  const log = (level: string, message: string) =>
    client.app.log({
      body: { service: "fix-toolcall", level, message },
    })

  await log("info", "Plugin loaded")

  return {
    "tool.execute.before": async (input, output) => {
      toolExecuted = true
      await log("info", `tool.execute.before: ${input.tool}`)
      if (!output.args) return
      for (const [key, value] of Object.entries(output.args)) {
        if (typeof value === "string" && value.includes("</tool_call>")) {
          output.args[key] = value.replace(/<\/?tool_call>/g, "").trim()
          await log("warn", `Stripped XML from arg "${key}"`)
        }
      }
    },

    event: async ({ event }) => {
      if (event.type === "message.part.updated") {
        const props = (event as any).properties ?? {}
        const allText = JSON.stringify(props).slice(0, 500)
        if (allText.includes("<tool_call>")) {
          sawToolCallXml = true
          toolExecuted = false
          await log("warn", `XML <tool_call> detected in message part`)
        }
      }

      if (event.type === "session.error") {
        await log("error", `session.error: ${JSON.stringify((event as any).properties ?? {}).slice(0, 300)}`)
        const now = Date.now()
        if (now - lastRetryTime < 15_000) return
        lastRetryTime = now
        sawToolCallXml = false
        await retry(client, log)
      }

      if (event.type === "session.idle") {
        await log("info", `session.idle: sawXml=${sawToolCallXml} toolExec=${toolExecuted}`)

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
        await retry(client, log)
      }
    },
  }
}

async function retry(client: any, log: any) {
  try {
    const sessions = await client.session.list()
    const active = sessions.body?.[0]
    if (!active?.id) {
      await log("error", "No active session found")
      return
    }

    await log("info", `Retrying on session ${active.id}`)
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
  } catch (e: any) {
    await log("error", `Retry failed: ${e?.message ?? e}`)
  }
}
