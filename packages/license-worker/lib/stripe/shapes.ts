/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The three reads of a Stripe object this worker makes more than once, under the pinned API version. An expandable
 *   field is a string id or the object; every caller wants the id.
 */

import type Stripe from "stripe"

export function idOf(value: string | { id: string } | null | undefined): string | undefined {
	return typeof value === "string" ? value : value?.id
}

/**
 * The subscription an invoice bills.
 */
export function invoiceSubscriptionID(invoice: Stripe.Invoice): string | undefined {
	return idOf(invoice.parent?.subscription_details?.subscription)
}

/**
 * The Price a line bills.
 */
export function linePriceID(line: Stripe.InvoiceLineItem): string | undefined {
	return idOf(line.pricing?.price_details?.price)
}
