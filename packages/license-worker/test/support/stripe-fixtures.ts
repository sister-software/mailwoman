/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Minimal Stripe objects: only the fields the handlers read. A test that needs another field adds it here, so the
 *   fixtures say what the worker depends on.
 */

export interface InvoiceInit {
	id: string
	subscriptionID: string
	priceID: string
	paidAt: number
	status?: "paid" | "open" | "void" | "draft"
	chargeID?: string
	livemode?: boolean
	quantity?: number
	lines?: number
}

export function invoiceObject(init: InvoiceInit) {
	const line = {
		id: `il_${init.id}`,
		object: "line_item",
		quantity: init.quantity ?? 1,
		price: { id: init.priceID, object: "price" },
		pricing: { price_details: { price: init.priceID } },
	}

	return {
		id: init.id,
		object: "invoice",
		status: init.status ?? "paid",
		livemode: init.livemode ?? false,
		created: init.paidAt - 60,
		subscription: init.subscriptionID,
		parent: { type: "subscription_details", subscription_details: { subscription: init.subscriptionID } },
		charge: init.chargeID ?? null,
		status_transitions: { paid_at: init.paidAt },
		lines: { object: "list", data: Array.from({ length: init.lines ?? 1 }, () => line), has_more: false },
	}
}

export function invoiceList(invoices: object[]) {
	return { object: "list", data: invoices, has_more: false, url: "/v1/invoices" }
}

export interface SubscriptionInit {
	id: string
	priceID: string
	currentPeriodEnd: number
	status?: string
	livemode?: boolean
}

export function subscriptionObject(init: SubscriptionInit) {
	return {
		id: init.id,
		object: "subscription",
		status: init.status ?? "active",
		livemode: init.livemode ?? false,
		current_period_end: init.currentPeriodEnd,
		items: {
			object: "list",
			data: [
				{
					id: `si_${init.id}`,
					object: "subscription_item",
					price: { id: init.priceID, object: "price" },
					current_period_end: init.currentPeriodEnd,
					quantity: 1,
				},
			],
		},
	}
}

export interface CheckoutSessionInit {
	id: string
	subscriptionID: string
	licensee: string
	email: string
	customerID?: string
	priceID?: string
	consent?: "accepted" | null
	mode?: "subscription" | "payment"
}

export function checkoutSessionObject(init: CheckoutSessionInit) {
	return {
		id: init.id,
		object: "checkout.session",
		mode: init.mode ?? "subscription",
		livemode: false,
		subscription: init.subscriptionID,
		customer: init.customerID ?? `cus_${init.subscriptionID}`,
		customer_details: { email: init.email, name: init.licensee },
		consent: { terms_of_service: init.consent === undefined ? "accepted" : init.consent },
		custom_fields: [{ key: "licensee_legal_name", type: "text", text: { value: init.licensee } }],
		line_items: init.priceID
			? {
					object: "list",
					data: [{ id: "li_1", object: "item", quantity: 1, price: { id: init.priceID, object: "price" } }],
				}
			: undefined,
	}
}

export function checkoutSessionList(sessions: object[]) {
	return { object: "list", data: sessions, has_more: false, url: "/v1/checkout/sessions" }
}

export interface EventInit {
	id?: string
	livemode?: boolean
}

export function invoicePaidEvent(init: EventInit & { invoiceID?: string } = {}) {
	return {
		id: init.id ?? "evt_in_1",
		object: "event",
		type: "invoice.paid",
		livemode: init.livemode ?? false,
		created: Math.floor(Date.now() / 1000),
		data: { object: { id: init.invoiceID ?? "in_1", object: "invoice" } },
	}
}

export function checkoutCompletedEvent(
	init: EventInit & { sessionID?: string; subscriptionID?: string; licensee?: string } = {}
) {
	return {
		id: init.id ?? "evt_cs_1",
		object: "event",
		type: "checkout.session.completed",
		livemode: init.livemode ?? false,
		created: Math.floor(Date.now() / 1000),
		data: {
			object: checkoutSessionObject({
				id: init.sessionID ?? "cs_1",
				subscriptionID: init.subscriptionID ?? "sub_1",
				licensee: init.licensee ?? "Example Ltd",
				email: "ops@example.com",
			}),
		},
	}
}

export interface ChargeInit {
	id: string
	paymentIntentID: string
	amount: number
	refunded: number
}

export function chargeObject(init: ChargeInit) {
	return {
		id: init.id,
		object: "charge",
		payment_intent: init.paymentIntentID,
		amount: init.amount,
		amount_refunded: init.refunded,
		refunded: init.refunded >= init.amount,
	}
}

export function chargeRefundedEvent(init: EventInit & Omit<ChargeInit, "id"> & { chargeID: string }) {
	return {
		id: init.id ?? "evt_ch_1",
		object: "event",
		type: "charge.refunded",
		livemode: init.livemode ?? false,
		created: Math.floor(Date.now() / 1000),
		data: { object: chargeObject({ ...init, id: init.chargeID }) },
	}
}

/**
 * The invoice-payments list for one PaymentIntent: the one query that links a charge back to its invoice.
 */
export function invoicePaymentList(init: { invoiceID: string; paymentIntentID: string }) {
	return {
		object: "list",
		url: "/v1/invoice_payments",
		has_more: false,
		data: [
			{
				id: `inpay_${init.invoiceID}`,
				object: "invoice_payment",
				invoice: init.invoiceID,
				status: "paid",
				payment: { type: "payment_intent", payment_intent: init.paymentIntentID },
			},
		],
	}
}

/**
 * The dispute list for one PaymentIntent, as the reconciliation pass asks for it.
 */
export function disputeList(disputes: Array<{ id: string; paymentIntentID: string; status: string }>) {
	return {
		object: "list",
		url: "/v1/disputes",
		has_more: false,
		data: disputes.map((dispute) => ({
			id: dispute.id,
			object: "dispute",
			payment_intent: dispute.paymentIntentID,
			status: dispute.status,
		})),
	}
}
