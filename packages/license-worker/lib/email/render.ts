/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The license message in its two bodies, the same for every provider: the text body for a client that shows no HTML,
 *   and the HTML body from the react-email template. Both render the sections `content.ts` decides. The HTML goes
 *   through React's static renderer for the edge runtime, not react-email's `render`, whose bundle carries prettier
 *   and html-to-text for options this worker never uses.
 */

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { type EmailBlock, licenseEmailPreview, licenseEmailSections } from "#email/content"
import type { LicenseEmail } from "#email/provider"
import { LicenseEmailTemplate } from "#email/template"

export { licenseEmailSubject } from "#email/content"

const TITLE = "Your Mailwoman commercial license"

function textLines(block: EmailBlock): string[] {
	switch (block.kind) {
		case "paragraph":
			return [block.text, ""]
		case "code":
			return [`    ${block.text.replaceAll("\n", "\n    ")}`, ""]
		case "link":
			return [`${block.label}: ${block.url}`, ""]
		case "facts": {
			const width = Math.max(...block.rows.map(([label]) => label.length))

			return [...block.rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`), ""]
		}
		default:
			return []
	}
}

export function renderLicenseEmail(message: LicenseEmail, siteOrigin: string): string {
	const lines: string[] = [TITLE, "=".repeat(TITLE.length), ""]

	for (const section of licenseEmailSections(message, siteOrigin)) {
		if (section.heading) {
			lines.push(section.heading, "-".repeat(section.heading.length), "")
		}

		for (const block of section.blocks) {
			lines.push(...textLines(block))
		}
	}

	return lines.join("\n").trimEnd().concat("\n")
}

export function renderLicenseEmailHTML(message: LicenseEmail, siteOrigin: string, from: string): string {
	const markup = renderToStaticMarkup(
		createElement(LicenseEmailTemplate, {
			title: TITLE,
			preview: licenseEmailPreview(message),
			sections: licenseEmailSections(message, siteOrigin),
			from,
		})
	)

	return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">${markup}`
}
