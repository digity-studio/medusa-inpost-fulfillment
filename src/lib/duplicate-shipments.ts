import { MedusaError } from "@medusajs/framework/utils"
import { InPostShipmentListResponse } from "./types"

/** Past this many pages the check gives up and refuses, rather than guessing. */
export const DUPLICATE_CHECK_MAX_PAGES = 10

const DAY_MS = 24 * 60 * 60 * 1000

type ListShipments = (
  query: Record<string, string | number>
) => Promise<InPostShipmentListResponse>

/**
 * Throws when ShipX already has a shipment that is not canceled for this
 * `reference`, and when that cannot be checked (the lookup fails or runs past
 * the page cap). It never reuses the shipment it finds.
 *
 * ShipX's list has no `reference` filter, so the lookup narrows by the
 * receiver's e-mail (a prefix match) and by creation time (a day before the
 * order, for time zones), and `reference` decides on the result.
 */
export async function assertNoExistingShipment(
  listShipments: ListShipments,
  {
    reference,
    email,
    createdAt,
  }: { reference: string; email?: string; createdAt?: string | Date }
): Promise<void> {
  const query: Record<string, string | number> = {}
  if (email) {
    query.receiver_email = email
  }
  if (createdAt) {
    query.created_at_gteq = new Date(new Date(createdAt).getTime() - DAY_MS).toISOString()
  }

  const existing: { id: number; status: string }[] = []

  for (let page = 1; ; page++) {
    if (page > DUPLICATE_CHECK_MAX_PAGES) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `InPost fulfillment: could not check for an existing shipment for ${reference} (more than ${DUPLICATE_CHECK_MAX_PAGES} pages of shipments to look through), so no new shipment was created`
      )
    }

    let result: InPostShipmentListResponse
    try {
      result = await listShipments({ ...query, page })
    } catch (error) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `InPost fulfillment: could not check for an existing shipment for ${reference} (${(error as Error).message}), so no new shipment was created`
      )
    }

    const items = result.items ?? []
    existing.push(
      ...items.filter((s) => s.reference === reference && s.status !== "canceled")
    )

    if (!items.length || page * (result.per_page || items.length) >= (result.count ?? 0)) {
      break
    }
  }

  if (existing.length) {
    throw new MedusaError(
      MedusaError.Types.DUPLICATE_ERROR,
      `InPost fulfillment: ShipX already has a shipment for ${reference}: ${existing
        .map((s) => `${s.id} (${s.status})`)
        .join(", ")}. Buy or cancel it in InPost Manager instead of creating another one.`
    )
  }
}
