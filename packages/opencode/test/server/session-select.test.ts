import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Session as SessionNs } from "../../src/session"
import type { SessionID } from "../../src/session/schema"
import { Log } from "../../src/util"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

function run<A, E>(fx: Effect.Effect<A, E, SessionNs.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(SessionNs.defaultLayer)))
}

const svc = {
  ...SessionNs,
  create(input?: SessionNs.CreateInput) {
    return run(SessionNs.Service.use((svc) => svc.create(input)))
  },
  remove(id: SessionID) {
    return run(SessionNs.Service.use((svc) => svc.remove(id)))
  },
}

afterEach(async () => {
  await Instance.disposeAll()
})

const password = process.env.OPENCODE_SERVER_PASSWORD
const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
const auth = password ? "Basic " + Buffer.from(`${username}:${password}`).toString("base64") : undefined

const request = (app: ReturnType<typeof Server.Default>, url: string, body: Record<string, unknown>) => {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (auth) headers.Authorization = auth
  return app.app.request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

async function withTmp(fn: () => Promise<void>) {
  await using tmp = await tmpdir({ git: true })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn,
    })
  } finally {
    await Instance.disposeAll()
  }
}

describe("tui.selectSession endpoint", () => {
  test("should return 200 when called with valid session", async () => {
    await withTmp(async () => {
      // #given
      const session = await svc.create({})

      // #when
      const app = Server.Default()
      const response = await request(app, "/tui/select-session", { sessionID: session.id })

      // #then
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toBe(true)

      await svc.remove(session.id)
    })
  })

  test("should return 404 when session does not exist", async () => {
    await withTmp(async () => {
      // #given
      const nonExistentSessionID = "ses_nonexistent123"

      // #when
      const app = Server.Default()
      const response = await request(app, "/tui/select-session", { sessionID: nonExistentSessionID })

      // #then
      expect(response.status).toBe(404)
    })
  })

  test("should return 400 when session ID format is invalid", async () => {
    await withTmp(async () => {
      // #given
      const invalidSessionID = "invalid_session_id"

      // #when
      const app = Server.Default()
      const response = await request(app, "/tui/select-session", { sessionID: invalidSessionID })

      // #then
      expect(response.status).toBe(400)
    })
  })
})
