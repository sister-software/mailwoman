/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	escapeHTML,
	escapeTrustPolicy,
	sanitizeHTML,
	sanitizeTrustPolicy,
	stripHTML,
	stripHTMLToText,
	stripHTMLTrustPolicy,
} from "@mailwoman/core/trust-policies"
import { describe, expect, it } from "vitest"

describe("escapeHTML", () => {
	it("renders markup as literal text", () => {
		expect(escapeHTML('<img src=x onerror="alert(1)">')).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;")
		expect(escapeHTML("a & b")).toBe("a &amp; b")
	})
})

describe("the sanitizer in Node", () => {
	it("sanitizeHTML removes scripts and event handlers, keeps safe markup", () => {
		expect(sanitizeHTML('<b>ok</b><img src=x onerror="alert(1)"><script>bad()</script>')).toBe('<b>ok</b><img src="x">')
	})

	it("stripHTML leaves only text content, entity-encoded for a sink", () => {
		expect(stripHTML("<p>a &amp; b</p><script>bad()</script>")).toBe("a &amp; b")
	})

	it("stripHTMLToText decodes to plain text and survives hostile markup shapes", () => {
		expect(stripHTMLToText("<p>a &amp; b</p>")).toBe("a & b")
		expect(stripHTMLToText('<a title="1 < 2">link</a>')).toBe("link")
		expect(stripHTMLToText("<p>before <b>bold")).toBe("before bold")
		expect(stripHTMLToText("<style>p{color:red}</style>text<script>var a=1</script>")).toBe("text")
	})
})

describe("the policies mint real trust in Node", () => {
	it("mw-sanitize sanitizes rather than passing through", () => {
		expect(String(sanitizeTrustPolicy().createHTML('<img src=x onerror="alert(1)">'))).toBe('<img src="x">')
	})

	it("mw-strip-html strips to text", () => {
		expect(String(stripHTMLTrustPolicy().createHTML("<b>a</b> & <i>b</i>"))).toBe("a &amp; b")
	})

	it("mw-escape needs no DOM and produces escaped output", () => {
		expect(String(escapeTrustPolicy().createHTML("<b>x</b>"))).toBe("&lt;b&gt;x&lt;/b&gt;")
	})
})
