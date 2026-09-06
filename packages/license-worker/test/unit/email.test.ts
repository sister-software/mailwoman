/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Cloudflare provider over a scripted binding: the message goes out from the configured sender to the buyer with
 *   the shared subject and text, the invoice id rides as a header, and the binding's message id is the one recorded.
 */

import { cloudflareEmailProvider } from "@mailwoman/license-worker/email/cloudflare"
import { licenseEmailSubject, renderLicenseEmail } from "@mailwoman/license-worker/email/render"
import { readEnv } from "@mailwoman/license-worker/env"
import { env } from "cloudflare:workers"
import { expect, test } from "vitest"

test("the Cloudflare provider sends the shared message through the binding and answers its id", async () => {
	const worker = readEnv(env)
	const sent: EmailMessageBuilder[] = []

	const sender: SendEmail = {
		send: async (message: EmailMessage | EmailMessageBuilder) => {
			sent.push(message as EmailMessageBuilder)

			return { messageId: "cf_msg_1" }
		},
	}

	const message = {
		to: "buyer@example.com",
		licensee: "Buyer Ltd",
		token: "mwl1.a.b",
		lid: "lic_x",
		issued: "2026-10-01",
		expires: "2026-11-15",
		refreshSecret: "s".repeat(43),
	}

	const answer = await cloudflareEmailProvider(worker, sender).send(message, "in_1")

	expect(answer).toEqual({ messageID: "cf_msg_1" })
	expect(sent).toHaveLength(1)

	expect(sent[0]).toEqual({
		from: worker.EMAIL_FROM,
		to: "buyer@example.com",
		subject: licenseEmailSubject(message),
		text: renderLicenseEmail(message, worker.SITE_ORIGIN),
		headers: { "x-mailwoman-invoice": "in_1" },
	})

	expect(sent[0]!.text).toContain("mwl1.a.b")
	expect(sent[0]!.text).toContain("s".repeat(43))
})
