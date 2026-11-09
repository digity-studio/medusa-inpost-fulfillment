import assert from "node:assert/strict"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { after, before, describe, it } from "node:test"
import { InPostShipXClient } from "../client"
import {
  assertNoExistingShipment,
  DUPLICATE_CHECK_MAX_PAGES,
} from "../duplicate-shipments"
import type { InPostShipmentListResponse, InPostShipmentResponse } from "../types"

const shipment = (id: number, reference: string, status: string) =>
  ({ id, reference, status }) as InPostShipmentResponse

const page = (
  items: InPostShipmentResponse[],
  count = items.length,
  per_page = 25
): InPostShipmentListResponse => ({ items, count, page: 1, per_page })

/** A mocked listShipments that serves `pages` in order and records each query. */
const mockList = (pages: InPostShipmentListResponse[]) => {
  const queries: Record<string, string | number>[] = []
  const list = async (query: Record<string, string | number>) => {
    queries.push(query)
    return pages[queries.length - 1] ?? page([])
  }
  return { list, queries }
}

const params = {
  reference: "order_1",
  email: "jan@example.com",
  createdAt: "2026-11-02T12:00:00.000Z",
}

describe("assertNoExistingShipment", () => {
  it("passes when ShipX has no shipment for the order, narrowing by e-mail and a day before the order", async () => {
    const { list, queries } = mockList([page([])])

    await assertNoExistingShipment(list, params)

    assert.deepEqual(queries, [
      {
        receiver_email: "jan@example.com",
        created_at_gteq: "2026-11-01T12:00:00.000Z",
        page: 1,
      },
    ])
  })

  it("refuses when a shipment for the order exists and is not canceled, naming it", async () => {
    const { list } = mockList([page([shipment(42, "order_1", "created")])])

    await assert.rejects(assertNoExistingShipment(list, params), (error: Error & { type?: string }) => {
      assert.equal(error.type, "duplicate_error")
      assert.match(error.message, /42 \(created\)/)
      return true
    })
  })

  it("ignores a canceled shipment and shipments of other orders", async () => {
    const { list } = mockList([
      page([shipment(1, "order_1", "canceled"), shipment(2, "order_10", "confirmed")]),
    ])

    await assertNoExistingShipment(list, params)
  })

  it("looks through every page and finds a match on a later one", async () => {
    const { list, queries } = mockList([
      page([shipment(1, "order_2", "confirmed")], 2, 1),
      page([shipment(7, "order_1", "confirmed")], 2, 1),
    ])

    await assert.rejects(assertNoExistingShipment(list, params), /7 \(confirmed\)/)
    assert.deepEqual(
      queries.map((q) => q.page),
      [1, 2]
    )
  })

  it("refuses when the shipments run past the page cap, without creating anything", async () => {
    const full = page([shipment(1, "order_2", "confirmed")], 1000, 1)
    const { list, queries } = mockList(Array(DUPLICATE_CHECK_MAX_PAGES + 5).fill(full))

    await assert.rejects(assertNoExistingShipment(list, params), (error: Error & { type?: string }) => {
      assert.equal(error.type, "unexpected_state")
      assert.match(error.message, /could not check/)
      return true
    })
    assert.equal(queries.length, DUPLICATE_CHECK_MAX_PAGES)
  })

  it("refuses when the lookup itself fails", async () => {
    const list = async () => {
      throw new Error("InPost API request timed out after 30000 ms: GET /v1/organizations/1/shipments")
    }

    await assert.rejects(assertNoExistingShipment(list, params), (error: Error & { type?: string }) => {
      assert.equal(error.type, "unexpected_state")
      assert.match(error.message, /could not check .*timed out/)
      return true
    })
  })

  it("leaves out the filters it has no value for", async () => {
    const { list, queries } = mockList([page([])])

    await assertNoExistingShipment(list, { reference: "order_1" })

    assert.deepEqual(queries, [{ page: 1 }])
  })
})

describe("InPostShipXClient.listShipments", () => {
  const realFetch = globalThis.fetch
  let server: http.Server
  let baseUrl: string
  const seen: string[] = []

  before(async () => {
    server = http.createServer((req, res) => {
      seen.push(req.url ?? "")
      if (req.url?.includes("hang")) {
        return // never answers
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ items: [], count: 0, page: 1, per_page: 25 }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    globalThis.fetch = ((url: string, init?: RequestInit) =>
      realFetch(String(url).replace(/^https:\/\/[^/]+/, baseUrl), init)) as typeof fetch
  })

  after(async () => {
    globalThis.fetch = realFetch
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })

  const client = () =>
    new InPostShipXClient({
      apiToken: "token",
      organizationId: "1",
      sandbox: true,
      requestTimeoutMs: 100,
    } as never)

  it("passes the query to ShipX's list endpoint as it is", async () => {
    const result = await client().listShipments({
      receiver_email: "jan+1@example.com",
      created_at_gteq: "2026-11-01T12:00:00.000Z",
      page: 2,
    })

    assert.deepEqual(result, { items: [], count: 0, page: 1, per_page: 25 })
    const url = new URL(seen.at(-1)!, "http://x")
    assert.equal(url.pathname, "/v1/organizations/1/shipments")
    assert.equal(url.searchParams.get("receiver_email"), "jan+1@example.com")
    assert.equal(url.searchParams.get("created_at_gteq"), "2026-11-01T12:00:00.000Z")
    assert.equal(url.searchParams.get("page"), "2")
  })

  it("keeps the receiver's e-mail out of the timeout error", async () => {
    await assert.rejects(
      client().listShipments({ receiver_email: "jan@example.com", status: "hang" }),
      (error: Error) => {
        assert.match(error.message, /timed out after 100 ms: GET \/v1\/organizations\/1\/shipments$/)
        assert.doesNotMatch(error.message, /example\.com/)
        return true
      }
    )
  })
})
