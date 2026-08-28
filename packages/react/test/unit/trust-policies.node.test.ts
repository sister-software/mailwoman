/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	escapeHTML,
	escapeTrustPolicy,
	sanitizeTrustPolicy,
	stripHTMLTrustPolicy,
} from "@mailwoman/react/trust-policies"
import { describe, expect, it } from "vitest"

describe("escapeHTML", () => {
	it("renders markup as literal text", () => {
		expect(escapeHTML('<img src=x onerror="alert(1)">')).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;")
		expect(escapeHTML("a & b")).toBe("a &amp; b")
	})
})

describe("the sanitizer-backed policies outside a DOM", () => {
	it("refuse with a named error rather than minting a passthrough", () => {
		expect(() => sanitizeTrustPolicy()).toThrow(/DOMPurify is unsupported/)
		expect(() => stripHTMLTrustPolicy()).toThrow(/DOMPurify is unsupported/)
	})

	it("the escape policy needs no DOM and produces escaped output", () => {
		const html = escapeTrustPolicy().createHTML("<b>x</b>")

		expect(String(html)).toBe("&lt;b&gt;x&lt;/b&gt;")
	})
})
