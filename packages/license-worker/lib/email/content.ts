/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The license message's copy, once, as sections: the text body and the html body render the same list, so neither
 *   can say something the other does not. It walks the buyer from the key to what comes after it: install it on each
 *   machine, let the subscription renew and fetch the renewed key, change the card or cancel at the portal. It also explains where
 *   to write. It never names an amount or a Stripe id.
 */

import { BILLING_PORTAL_URL, SUPPORT_EMAIL } from "#client/constants"
import type { LicenseEmail } from "#email/provider"

export type EmailBlock =
	| { kind: "paragraph"; text: string }
	| { kind: "code"; text: string }
	| { kind: "facts"; rows: Array<[label: string, value: string]> }
	| { kind: "link"; label: string; url: string }

export interface EmailSection {
	heading?: string
	blocks: EmailBlock[]
}

export function licenseEmailSubject(message: LicenseEmail): string {
	if (message.agreement == null) {
		return `Your Mailwoman license, declared ${message.intent ?? "open-source"} (${message.issued} to ${message.expires})`
	}

	return `Your Mailwoman commercial license (${message.issued} to ${message.expires})`
}

/**
 * The heading of the message: the commercial title for a purchase, a plain one for a declared token.
 */
export function licenseEmailTitle(message: LicenseEmail): string {
	return message.agreement == null ? "Your Mailwoman license" : "Your Mailwoman commercial license"
}

/**
 * The one-line preview a mail client shows beside the subject.
 */
export function licenseEmailPreview(message: LicenseEmail): string {
	return message.refreshSecret
		? `Your key and your refresh secret for ${message.licensee}`
		: `Your renewed key for ${message.licensee}, valid to ${message.expires}`
}

/**
 * The command that installs the key on a machine: with the secret on the first message,
 * so renewals can be fetched from there.
 * The token by itself after.
 */
export function adoptCommand(message: LicenseEmail): string {
	return message.refreshSecret
		? `mailwoman license adopt "${message.token}" --secret "${message.refreshSecret}"`
		: `mailwoman license adopt "${message.token}"`
}

export function licenseEmailSections(message: LicenseEmail, siteOrigin: string): EmailSection[] {
	const origin = siteOrigin.replace(/\/$/u, "")
	const agreement = message.agreement

	if (agreement == null) return declaredEmailSections(message, origin)

	const first = message.refreshSecret

	const secret: EmailSection = first
		? {
				heading: "Your refresh secret",
				blocks: [
					{
						kind: "paragraph",
						text: "Shown once, in this message and on the purchase page. Keep it with the key: it is what fetches your renewed keys.",
					},
					{ kind: "code", text: message.refreshSecret ?? "" },
				],
			}
		: {
				heading: "Your refresh secret",
				blocks: [
					{
						kind: "paragraph",
						text: "It was in your first message and on the purchase page, and a machine that adopted the key with it already holds it.",
					},
				],
			}

	return [
		{
			blocks: [
				{
					kind: "paragraph",
					text: first
						? "Thank you for licensing Mailwoman. Your key is below, with the steps that follow it."
						: "Your subscription renewed, and this is the key for the new period. Nothing changes on a machine that has adopted the key: it fetches this one on its own.",
				},
				{
					kind: "facts",
					rows: [
						["Licensee", message.licensee],
						["License id", message.lid],
						["Valid", `${message.issued} to ${message.expires} (UTC, inclusive)`],
						["Agreement", agreement],
					],
				},
			],
		},
		{
			heading: "Your key",
			blocks: [{ kind: "code", text: message.token }],
		},
		secret,
		{
			heading: "Install it",
			blocks: [
				{
					kind: "paragraph",
					text: "On each machine that runs mailwoman, adopt the key once and check it. The first command stores the key and the secret under your config directory; the second confirms the key against this service.",
				},
				{ kind: "code", text: `${adoptCommand(message)}\nmailwoman license verify --online` },
				{
					kind: "paragraph",
					text: "For a container or a CI job, set MAILWOMAN_LICENSE_KEY to the key instead; it is read before the stored one.",
				},
			],
		},
		{
			heading: "Renewals",
			blocks: [
				{
					kind: "paragraph",
					text: `The subscription renews on its own. Each renewal issues a new key, valid through the paid period plus fourteen days, and emails it here. A machine that adopted the key fetches the new one with one command: mailwoman license refresh. Nothing to do before ${message.expires}.`,
				},
			],
		},
		{
			heading: "Billing",
			blocks: [
				{
					kind: "paragraph",
					text: "Change the card, switch between monthly and yearly, download invoices, or cancel at the end of the paid period:",
				},
				BILLING_PORTAL_URL
					? { kind: "link", label: "Billing portal", url: BILLING_PORTAL_URL }
					: { kind: "link", label: "License page", url: `${origin}/license` },
			],
		},
		{
			heading: "Help",
			blocks: [
				{
					kind: "paragraph",
					text: `Write to ${SUPPORT_EMAIL} with your license id for anything this message does not answer: a key that does not verify, a machine that cannot reach this service, or a change to the licensee's name.`,
				},
				{
					kind: "link",
					label: `The agreement you accepted (${agreement})`,
					url: `${origin}/license/terms/${agreement}`,
				},
			],
		},
	]
}

/**
 * The message for a declared token.
 *
 * It states the declaration and its term, the key, the secret on the first message,
 * how to install the key, and how a re-issue arrives.
 * It has no billing section and links no agreement.
 */
function declaredEmailSections(message: LicenseEmail, origin: string): EmailSection[] {
	const intent = message.intent ?? "open-source"
	const first = message.refreshSecret

	const secret: EmailSection = first
		? {
				heading: "Your refresh secret",
				blocks: [
					{
						kind: "paragraph",
						text: "Shown once, in this message. Keep it with the key: it is what fetches your re-issued keys.",
					},
					{ kind: "code", text: message.refreshSecret ?? "" },
				],
			}
		: {
				heading: "Your refresh secret",
				blocks: [
					{
						kind: "paragraph",
						text: "It was in your first message, and a machine that adopted the key with it already holds it.",
					},
				],
			}

	return [
		{
			blocks: [
				{
					kind: "paragraph",
					text: first
						? `Your ${intent} declaration is recorded. Your key is below, with the steps that follow it.`
						: `Your ${intent} declaration was re-issued, and this is the key for the new period. A machine that adopted the key fetches this one on its own.`,
				},
				{
					kind: "facts",
					rows: [
						["Licensee", message.licensee],
						["License id", message.lid],
						["Declared", intent],
						["Valid", `${message.issued} to ${message.expires} (UTC, inclusive)`],
						["Terms", "AGPL-3.0-only"],
					],
				},
			],
		},
		{
			heading: "Your key",
			blocks: [{ kind: "code", text: message.token }],
		},
		secret,
		{
			heading: "Install it",
			blocks: [
				{
					kind: "paragraph",
					text: "On each machine that runs mailwoman, adopt the key once and check it. The first command stores the key and the secret under your config directory; the second confirms the key against this service.",
				},
				{ kind: "code", text: `${adoptCommand(message)}\nmailwoman license verify --online` },
				{
					kind: "paragraph",
					text: "For a container or a CI job, set MAILWOMAN_LICENSE_KEY to the key instead; it is read before the stored one.",
				},
			],
		},
		{
			heading: "Re-issue",
			blocks: [
				{
					kind: "paragraph",
					text: `This key runs to ${message.expires}. From 28 days before that date, one command on a machine that adopted the key fetches the next one: mailwoman license refresh. The AGPL's obligations apply throughout, and the key changes what mailwoman reports about its license, never what it runs.`,
				},
			],
		},
		{
			heading: "Help",
			blocks: [
				{
					kind: "paragraph",
					text: `Write to ${SUPPORT_EMAIL} with your license id for anything this message does not answer.`,
				},
				{ kind: "link", label: "The license page", url: `${origin}/license` },
			],
		},
	]
}
