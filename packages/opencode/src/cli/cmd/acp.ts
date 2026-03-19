import * as Log from "@opencode-ai/core/util/log"
import { Effect } from "effect"
import path from "node:path"
import type { Argv } from "yargs"
import { effectCmd } from "../effect-cmd"
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"
import { ACP } from "@/acp/agent"
import { Server } from "@/server/server"
import { ServerAuth } from "@/server/auth"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { withNetworkOptions, resolveNetworkOptions } from "../network"

const log = Log.create({ service: "acp-command" })

export const AcpCommand = effectCmd({
  command: "acp",
  describe: "start ACP (Agent Client Protocol) server",
  // ACP handlers read the local InstanceContext via Instance.current (ALS) —
  // e.g. AgentModule.Service.defaultAgent() in resolveModeState. So we always
  // load a local instance, even when --attach is set; the SDK still proxies
  // workspace-scoped calls to the remote server.
  directory: (args) => (args.cwd ? path.resolve(process.cwd(), args.cwd) : process.cwd()),
  builder: (yargs: Argv) => {
    return withNetworkOptions(yargs)
      .option("attach", {
        type: "string",
        describe: "attach to a running opencode server (e.g., http://localhost:4096)",
      })
      .option("password", {
        alias: ["p"],
        type: "string",
        describe: "basic auth password (defaults to OPENCODE_SERVER_PASSWORD)",
      })
      .option("username", {
        alias: ["u"],
        type: "string",
        describe: "basic auth username (defaults to OPENCODE_SERVER_USERNAME or 'opencode')",
      })
      .option("cwd", {
        describe: "working directory, path on remote server if attaching",
        type: "string",
      })
  },
  handler: Effect.fn("Cli.acp")(function* (args) {
    process.env.OPENCODE_CLIENT = "acp"

    let sdk: ReturnType<typeof createOpencodeClient>
    if (args.attach) {
      sdk = createOpencodeClient({
        baseUrl: args.attach,
        directory: args.cwd,
        headers: ServerAuth.headers({ password: args.password, username: args.username }),
      })
    } else {
      const opts = yield* resolveNetworkOptions(args)
      const server = yield* Effect.promise(() => Server.listen(opts))
      sdk = createOpencodeClient({
        baseUrl: `http://${server.hostname}:${server.port}`,
        directory: args.cwd,
        headers: ServerAuth.headers(),
      })
    }

    const input = new WritableStream<Uint8Array>({
      write(chunk) {
        return new Promise<void>((resolve, reject) => {
          process.stdout.write(chunk, (err) => {
            if (err) {
              reject(err)
            } else {
              resolve()
            }
          })
        })
      },
    })
    const output = new ReadableStream<Uint8Array>({
      start(controller) {
        process.stdin.on("data", (chunk: Buffer) => {
          controller.enqueue(new Uint8Array(chunk))
        })
        process.stdin.on("end", () => controller.close())
        process.stdin.on("error", (err) => controller.error(err))
      },
    })

    const stream = ndJsonStream(input, output)
    const agent = ACP.init({ sdk })

    new AgentSideConnection((conn) => {
      return agent.create(conn, { sdk })
    }, stream)

    log.info("setup connection")
    process.stdin.resume()
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          process.stdin.on("end", () => resolve())
          process.stdin.on("error", reject)
        }),
    )
  }),
})
