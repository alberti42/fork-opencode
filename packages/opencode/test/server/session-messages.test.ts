import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID, type SessionID as SessionIDType } from "../../src/session/schema"
import { Log } from "../../src/util"
import { linkParam, parseLinkHeader } from "../../src/util/link-header"
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
  remove(id: SessionIDType) {
    return run(SessionNs.Service.use((svc) => svc.remove(id)))
  },
  updateMessage<T extends MessageV2.Info>(msg: T) {
    return run(SessionNs.Service.use((svc) => svc.updateMessage(msg)))
  },
  updatePart<T extends MessageV2.Part>(part: T) {
    return run(SessionNs.Service.use((svc) => svc.updatePart(part)))
  },
}

afterEach(async () => {
  await Instance.disposeAll()
})

const password = process.env.OPENCODE_SERVER_PASSWORD
const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
const auth = password ? "Basic " + Buffer.from(`${username}:${password}`).toString("base64") : undefined

const request = (app: ReturnType<typeof Server.Default>, url: string) => {
  if (!auth) return app.app.request(url)
  return app.app.request(url, { headers: { Authorization: auth } })
}

const TEST_TIMEOUT_MS = 30_000

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

async function withoutWatcher<T>(fn: () => Promise<T>) {
  if (process.platform !== "win32") return fn()
  const prev = process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
  process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = "true"
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
    else process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = prev
  }
}

async function fill(sessionID: SessionIDType, count: number, time = (i: number) => Date.now() + i) {
  const ids = [] as MessageID[]
  for (let i = 0; i < count; i++) {
    const id = MessageID.ascending()
    ids.push(id)
    await svc.updateMessage({
      id,
      sessionID,
      role: "user",
      time: { created: time(i) },
      agent: "test",
      model: { providerID: "test", modelID: "test" },
      tools: {},
      mode: "",
    } as unknown as MessageV2.Info)
    await svc.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: id,
      type: "text",
      text: `m${i}`,
    })
  }
  return ids
}

describe("session messages endpoint", () => {
  test("returns Link header with rel=prev for older pages", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await svc.create({})
          const ids = await fill(session.id, 5)
          const app = Server.Default().app

          const a = await app.request(`/session/${session.id}/message?limit=2`)
          expect(a.status).toBe(200)
          const aBody = (await a.json()) as MessageV2.WithParts[]
          expect(aBody.map((item) => item.info.id)).toEqual(ids.slice(-2))
          const links = parseLinkHeader(a.headers.get("link") ?? "")
          expect(links.prev).toBeDefined()
          const before = linkParam(links.prev, "before")
          expect(before).toBeTruthy()

          const b = await app.request(`/session/${session.id}/message?limit=2&before=${encodeURIComponent(before!)}`)
          expect(b.status).toBe(200)
          const bBody = (await b.json()) as MessageV2.WithParts[]
          expect(bBody.map((item) => item.info.id)).toEqual(ids.slice(-4, -2))

          await svc.remove(session.id)
        },
      }),
    )
  })

  test("keeps full-history responses when limit is omitted", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await svc.create({})
          const ids = await fill(session.id, 3)
          const app = Server.Default().app

          const res = await app.request(`/session/${session.id}/message`)
          expect(res.status).toBe(200)
          const body = (await res.json()) as MessageV2.WithParts[]
          expect(body.map((item) => item.info.id)).toEqual(ids)

          await svc.remove(session.id)
        },
      }),
    )
  })

  test("rejects invalid cursors and missing sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await svc.create({})
          const app = Server.Default().app

          const bad = await app.request(`/session/${session.id}/message?limit=2&before=bad`)
          expect(bad.status).toBe(400)

          const miss = await app.request(`/session/ses_missing/message?limit=2`)
          expect(miss.status).toBe(404)

          await svc.remove(session.id)
        },
      }),
    )
  })

  test("does not truncate large legacy limit requests", async () => {
    await using tmp = await tmpdir({ git: true })
    await withoutWatcher(() =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await svc.create({})
          await fill(session.id, 520)
          const app = Server.Default().app

          const res = await app.request(`/session/${session.id}/message?limit=510`)
          expect(res.status).toBe(200)
          const body = (await res.json()) as MessageV2.WithParts[]
          expect(body).toHaveLength(510)

          await svc.remove(session.id)
        },
      }),
    )
  })
})

describe("session.messages API", () => {
  test(
    "returns 400 when both before and after specified",
    async () => {
      await withTmp(async () => {
        const app = Server.Default()
        const session = await svc.create({})
        await fill(session.id, 3)
        const first = await request(app, `/session/${session.id}/message?limit=1`)
        const cur = linkParam(parseLinkHeader(first.headers.get("Link") ?? "").prev, "before")

        const response = await request(app, `/session/${session.id}/message?before=${cur}&after=${cur}&limit=2`)

        expect(response.status).toBe(400)
        const body = (await response.json()) as { error: string }
        expect(body.error).toContain("Cannot specify both")
      })
    },
    TEST_TIMEOUT_MS,
  )

  test("includes Link header with rel=prev when more pages exist (latest page)", async () => {
    await withTmp(async () => {
      const app = Server.Default()
      const session = await svc.create({})
      await fill(session.id, 5)

      const response = await request(app, `/session/${session.id}/message?limit=2`)

      expect(response.status).toBe(200)
      const links = parseLinkHeader(response.headers.get("Link") ?? "")
      expect(links.prev).toBeDefined()
      expect(linkParam(links.prev, "before")).toBeTruthy()
      expect(links.next).toBeUndefined()
    })
  })

  test("before cursor returns older page and exposes rel=next", async () => {
    await withTmp(async () => {
      const app = Server.Default()
      const session = await svc.create({})
      const ids = await fill(session.id, 5)

      const latest = await request(app, `/session/${session.id}/message?limit=2`)
      const latestLinks = parseLinkHeader(latest.headers.get("Link") ?? "")
      const before = linkParam(latestLinks.prev, "before")

      const response = await request(app, `/session/${session.id}/message?before=${before}&limit=2`)
      expect(response.status).toBe(200)
      const body = (await response.json()) as Array<{ info: { id: string } }>
      expect(body.map((item) => item.info.id)).toEqual([ids[1], ids[2]])

      const links = parseLinkHeader(response.headers.get("Link") ?? "")
      expect(links.prev).toBeDefined()
      expect(links.next).toBeDefined()
      expect(linkParam(links.prev, "before")).toBeTruthy()
      expect(linkParam(links.next, "after")).toBeTruthy()
    })
  })

  test("oldest=true returns messages in ascending order with rel=next Link", async () => {
    await withTmp(async () => {
      const app = Server.Default()
      const session = await svc.create({})
      const ids = await fill(session.id, 5)

      const response = await request(app, `/session/${session.id}/message?oldest=true&limit=2`)

      expect(response.status).toBe(200)
      const messages = (await response.json()) as Array<{ info: { id: string } }>
      expect(messages.map((item) => item.info.id)).toEqual([ids[0], ids[1]])

      const links = parseLinkHeader(response.headers.get("Link") ?? "")
      expect(links.next).toBeDefined()
      expect(linkParam(links.next, "after")).toBeTruthy()
    })
  })

  test("after cursor returns newer page and exposes rel=prev", async () => {
    await withTmp(async () => {
      const app = Server.Default()
      const session = await svc.create({})
      const ids = await fill(session.id, 5)

      const oldest = await request(app, `/session/${session.id}/message?oldest=true&limit=2`)
      const oldestLinks = parseLinkHeader(oldest.headers.get("Link") ?? "")
      const after = linkParam(oldestLinks.next, "after")

      const response = await request(app, `/session/${session.id}/message?after=${after}&limit=2`)
      expect(response.status).toBe(200)
      const body = (await response.json()) as Array<{ info: { id: string } }>
      expect(body.map((item) => item.info.id)).toEqual([ids[2], ids[3]])

      const links = parseLinkHeader(response.headers.get("Link") ?? "")
      expect(links.prev).toBeDefined()
      expect(links.next).toBeDefined()
      expect(linkParam(links.prev, "before")).toBeTruthy()
      expect(linkParam(links.next, "after")).toBeTruthy()
    })
  })

  test("returns 400 for invalid cursor", async () => {
    await withTmp(async () => {
      const app = Server.Default()
      const session = await svc.create({})

      const response = await request(app, `/session/${session.id}/message?before=invalid&limit=2`)
      expect(response.status).toBe(400)
    })
  })

  test("returns 400 when oldest used with before or after", async () => {
    await withTmp(async () => {
      const app = Server.Default()
      const session = await svc.create({})
      await fill(session.id, 3)
      const first = await request(app, `/session/${session.id}/message?limit=1`)
      const cur = linkParam(parseLinkHeader(first.headers.get("Link") ?? "").prev, "before")

      const response1 = await request(app, `/session/${session.id}/message?oldest=true&before=${cur}&limit=2`)
      expect(response1.status).toBe(400)
      const response2 = await request(app, `/session/${session.id}/message?oldest=true&after=${cur}&limit=2`)
      expect(response2.status).toBe(400)
    })
  })

  test("limit=0 returns empty results", async () => {
    await withTmp(async () => {
      const app = Server.Default()
      const session = await svc.create({})
      await fill(session.id, 3)

      const response = await request(app, `/session/${session.id}/message?limit=0`)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual([])
      expect(response.headers.get("Link")).toBeNull()
    })
  })

  test("limit=0 still validates session existence", async () => {
    await withTmp(async () => {
      const app = Server.Default()
      const response = await request(app, `/session/${SessionID.descending()}/message?limit=0`)
      expect(response.status).toBe(404)
    })
  })
})
