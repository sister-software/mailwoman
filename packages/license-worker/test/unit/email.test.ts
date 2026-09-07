/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Cloudflare provider over a scripted binding: the message goes out from the configured sender to the buyer with
 *   the shared subject, text and HTML, the invoice id rides as a header, and the binding's message id is the one
 *   recorded. The two bodies render the same sections, so each is held to what the buyer needs from it.
 */

import { cloudflareEmailProvider } from "@mailwoman/license-worker/email/cloudflare"
import { licenseEmailSubject, renderLicenseEmail, renderLicenseEmailHTML } from "@mailwoman/license-worker/email/render"
import { readEnv } from "@mailwoman/license-worker/env"
import { env } from "cloudflare:workers"
import { describe, expect, it, test } from "vitest"

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
		agreement: "commercial-2026-10",
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
		html: renderLicenseEmailHTML(message, worker.SITE_ORIGIN, worker.EMAIL_FROM),
		headers: { "x-mailwoman-invoice": "in_1" },
	})

	expect(sent[0]!.text).toContain("mwl1.a.b")
	expect(sent[0]!.text).toContain("s".repeat(43))
})

describe("the license message", () => {
	const first = {
		to: "buyer@example.com",
		licensee: "Buyer Ltd",
		token: "mwl1.a.b",
		lid: "lic_x",
		issued: "2026-10-01",
		expires: "2026-11-15",
		agreement: "commercial-2026-10",
		refreshSecret: "s".repeat(43),
	}

	const renewal = { ...first, refreshSecret: undefined, issued: "2026-11-01", expires: "2026-12-15" }
	const site = "https://mailwoman.ai"

	it("walks the buyer from the key to what comes after it, in text and in HTML alike", () => {
		const text = renderLicenseEmail(first, site)
		const html = renderLicenseEmailHTML(first, site, "licenses@mailwoman.ai")

		// React escapes quotes in text nodes; the command is read back as a person copies it.
		const unescaped = html.replaceAll("&quot;", '"').replaceAll("&#x27;", "'")

		for (const body of [text, unescaped]) {
			expect(body).toContain("mwl1.a.b")
			expect(body.split("s".repeat(43))).toHaveLength(3)
			expect(body).toContain(`mailwoman license adopt "mwl1.a.b" --secret "${"s".repeat(43)}"`)
			expect(body).toContain("mailwoman license verify --online")
			expect(body).toContain("MAILWOMAN_LICENSE_KEY")
			expect(body).toContain("mailwoman license refresh")
			expect(body).toContain("Buyer Ltd")
			expect(body).toContain("lic_x")
			expect(body).toContain(`${site}/license/terms/commercial-2026-10`)
			expect(body).not.toMatch(/\$|in_|cus_|sub_/u)
		}

		expect(html.startsWith("<!DOCTYPE html")).toBe(true)
		expect(html).toContain("<html")
		expect(html).toContain("licenses@mailwoman.ai")
	})

	it("a renewal carries the new key, names the stored secret rather than repeating it, and adopts without one", () => {
		const text = renderLicenseEmail(renewal, site)

		expect(text).toContain("renewed")
		expect(text).not.toContain("s".repeat(43))
		expect(text).toContain('mailwoman license adopt "mwl1.a.b"\n')
		expect(text).toContain("2026-12-15")
		expect(licenseEmailSubject(renewal)).toBe("Your Mailwoman commercial license (2026-11-01 to 2026-12-15)")
	})
})
