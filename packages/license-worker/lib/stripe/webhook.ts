/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Webhook verification: the official constructor over the untouched raw body, with the SubtleCrypto provider the
 *   Workers runtime has, a five-minute timestamp tolerance, and two checks the SDK does not make — that the event is one
 *   this worker acts on, and that its Stripe mode is this environment's. The two refusals differ in kind: a signature
 *   that does not verify is a request to reject, and a verified event this worker does not act on is one to
 *   acknowledge and log, because Stripe retries every non-2xx answer for three days and a retry cannot change either.
 */

import Stripe from "stripe"

import type { LicenseWorkerEnv } from "#env"
import { stripeClient } from "#stripe/client"

/**
 * The event types the destination is subscribed to and this worker acts on. A closed dispute is not here: the
 * reconciliation pass reads Stripe's current dispute state for a disputed license instead.
 */
export const ACCEPTED_EVENT_TYPES = [
	"checkout.session.completed",
	"invoice.paid",
	"invoice.payment_failed",
	"customer.subscription.updated",
	"customer.subscription.deleted",
	"charge.refunded",
	"charge.dispute.created",
] as const

const SIGNATURE_TOLERANCE_SECONDS = 300

export type WebhookVerification =
	| { ok: true; event: Stripe.Event }
	| { ok: false; kind: "signature"; reason: string }
	| { ok: false; kind: "ignored"; reason: string }

const cryptoProvider = Stripe.createSubtleCryptoProvider()

export async function verifyStripeEvent(
	rawBody: string,
	signatureHeader: string | null,
	env: LicenseWorkerEnv
): Promise<WebhookVerification> {
	if (!signatureHeader) return { ok: false, kind: "signature", reason: "missing Stripe-Signature" }

	let event: Stripe.Event

	try {
		event = await stripeClient(env).webhooks.constructEventAsync(
			rawBody,
			signatureHeader,
			env.STRIPE_WEBHOOK_SECRET,
			SIGNATURE_TOLERANCE_SECONDS,
			cryptoProvider
		)
	} catch (error) {
		return {
			ok: false,
			kind: "signature",
			reason: error instanceof Error ? error.message : "signature verification failed",
		}
	}

	if (!(ACCEPTED_EVENT_TYPES as readonly string[]).includes(event.type)) {
		return { ok: false, kind: "ignored", reason: `event type ${event.type} is not one this worker acts on` }
	}

	if (event.livemode !== env.liveMode) {
		return { ok: false, kind: "ignored", reason: `event livemode ${event.livemode} does not match this environment` }
	}

	return { ok: true, event }
}
