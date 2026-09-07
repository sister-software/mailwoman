/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The license message's copy, once, as sections: the text body and the HTML body render the same list, so neither
 *   can say something the other does not. It walks the buyer from the key to what comes after it: install it on each
 *   machine, let the subscription renew and fetch the renewed key, change the card or cancel at the portal, and where
 *   to write. It never names an amount or a Stripe id.
 */

import type { LicenseEmail } from "#email/provider"
import { BILLING_PORTAL_URL, SUPPORT_EMAIL } from "#sdk/constants"

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
	return `Your Mailwoman commercial license (${message.issued} to ${message.expires})`
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
 * The command that installs the key on a machine: with the secret on the first message, so renewals can be fetched from
 * there; the token alone after.
 */
export function adoptCommand(message: LicenseEmail): string {
	return message.refreshSecret
		? `mailwoman license adopt "${message.token}" --secret "${message.refreshSecret}"`
		: `mailwoman license adopt "${message.token}"`
}

export function licenseEmailSections(message: LicenseEmail, siteOrigin: string): EmailSection[] {
	const origin = siteOrigin.replace(/\/$/u, "")
	const first = message.refreshSecret !== undefined

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
						["Agreement", message.agreement],
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
					label: `The agreement you accepted (${message.agreement})`,
					url: `${origin}/license/terms/${message.agreement}`,
				},
			],
		},
	]
}
