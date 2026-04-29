import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Session } from "@/session/session"
import * as Log from "@opencode-ai/core/util/log"
import { Server } from "../../src/server/server"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const it = testEffect(Session.defaultLayer)
const password = process.env.OPENCODE_SERVER_PASSWORD
const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
const auth = password ? "Basic " + Buffer.from(`${username}:${password}`).toString("base64") : undefined

function request(input: { directory: string; sessionID: string }) {
  return Promise.resolve(
    Server.Default().app.request("/tui/select-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-opencode-directory": input.directory,
        ...(auth ? { Authorization: auth } : {}),
      },
      body: JSON.stringify({ sessionID: input.sessionID }),
    }),
  )
}

describe("tui.selectSession endpoint", () => {
  it.instance(
    "should return 200 when called with valid session",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const session = yield* Session.Service.use((svc) => svc.create({}))

        const response = yield* Effect.promise(() => request({ directory: tmp.directory, sessionID: session.id }))

        expect(response.status).toBe(200)
        expect(yield* Effect.promise(() => response.json())).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "should return 404 when session does not exist",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const response = yield* Effect.promise(() =>
          request({ directory: tmp.directory, sessionID: "ses_nonexistent123" }),
        )

        expect(response.status).toBe(404)
      }),
    { git: true },
  )

  it.instance(
    "should return 400 when session ID format is invalid",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const response = yield* Effect.promise(() =>
          request({ directory: tmp.directory, sessionID: "invalid_session_id" }),
        )

        expect(response.status).toBe(400)
      }),
    { git: true },
  )
})
