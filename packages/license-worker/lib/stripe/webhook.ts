/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Webhook verification uses the official constructor with the untouched raw body and Workers' SubtleCrypto provider.
 *   It allows a five-minute timestamp tolerance and checks two conditions the SDK does not check.
 *   The event must be one this worker handles. Its Stripe mode must match this environment.
 *   The refusals have different outcomes. Reject an invalid signature.
 *   Acknowledge and log a verified event this worker does not handle. Stripe retries each non-2xx answer for three days.
 *   A retry cannot change either refusal.
 */

import Stripe from "stripe"

import type { LicenseWorkerEnv } from "#env"
import { stripeClient } from "#stripe/client"

/**
 * The event types the destination is subscribed to and this worker acts on.
 *
 * A closed dispute is not here: the reconciliation pass reads Stripe's current
 * dispute state for a disputed license instead.
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
