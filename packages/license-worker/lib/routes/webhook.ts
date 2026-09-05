/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `POST /v1/webhooks/stripe`. The body is read once as text and verified untouched. Stripe retries any non-2xx answer
 *   for three days, so the only 400 is a signature that does not verify, where a retry is the right outcome; an event
 *   that verifies but is not one this worker acts on, or is from the other Stripe mode, answers 200 and is logged, so
 *   a destination configured with a stray event type does not retry for three days. An event id already in the ledger
 *   answers 200 without running anything, so Stripe's redelivery is inert. Otherwise the handler runs FIRST and the
 *   event id is recorded AFTER it succeeds: a crash between the two leaves no record, Stripe retries, and the handler's
 *   own writes are idempotent by primary key, so the retry finds its work done. Recording first would turn one crash
 *   into a payment nobody minted for.
 */

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi"

import type { LicenseWorkerEnv } from "#env"
import type { FulfilDependencies } from "#fulfil"
import { eventRecorded, recordEventOnce } from "#ledger/licenses"
import { handleStripeEvent } from "#stripe/handlers"
import { verifyStripeEvent } from "#stripe/webhook"

const ReceivedSchema = z.object({
	received: z.literal(true),
	duplicate: z.boolean().optional(),
	handled: z.string().optional(),
	ignored: z.string().optional(),
})

const ErrorSchema = z.object({ error: z.string() })

const webhookRoute = createRoute({
	method: "post",
	path: "/v1/webhooks/stripe",
	request: {
		headers: z.object({ "stripe-signature": z.string().optional() }),
	},
	responses: {
		200: {
			description:
				"The event was verified and acted on, was one this worker had already acted on, or verified but is not one this worker acts on.",
			content: { "application/json": { schema: ReceivedSchema } },
		},
		400: {
			description: "The signature did not verify. Stripe retries.",
			content: { "application/json": { schema: ErrorSchema } },
		},
	},
})

export function registerWebhookRoute(app: OpenAPIHono, env: LicenseWorkerEnv, deps: FulfilDependencies): void {
	app.openapi(webhookRoute, async (c) => {
		const rawBody = await c.req.text()
		const verified = await verifyStripeEvent(rawBody, c.req.header("stripe-signature") ?? null, env)

		if (!verified.ok) {
			if (verified.kind === "signature") return c.json({ error: verified.reason }, 400)

			console.warn(`webhook ignored: ${verified.reason}`)

			return c.json({ received: true, ignored: verified.reason }, 200)
		}

		const { event } = verified

		if (await eventRecorded(deps.ledger, event.id)) return c.json({ received: true, duplicate: true }, 200)

		const { handled } = await handleStripeEvent(env, deps, event)
		const objectID = (event.data.object as { id?: string }).id ?? ""

		await recordEventOnce(deps.ledger, { id: event.id, type: event.type, objectID })

		return c.json({ received: true, handled }, 200)
	})
}
