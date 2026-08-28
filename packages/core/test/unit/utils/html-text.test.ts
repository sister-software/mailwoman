/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { htmlToText } from "@mailwoman/core/utils"
import { describe, expect, it } from "vitest"

describe("htmlToText", () => {
	it("extracts prose and decodes entities beyond any local table", () => {
		expect(htmlToText("<p>a&nbsp;&amp;&nbsp;b</p>")).toBe("a & b")
		expect(htmlToText("caf&eacute; &copy; 2026")).toBe("café © 2026")
	})

	it("reads a < inside an attribute value as markup, not text", () => {
		expect(htmlToText('<a title="1 < 2">link</a>')).toBe("link")
	})

	it("does not let an unclosed tag swallow the remainder", () => {
		expect(htmlToText("<p>before <b>bold")).toBe("before bold")
	})

	it("excludes script and style content", () => {
		expect(htmlToText("<style>p{color:red}</style><p>text</p><script>var a=1</script>")).toBe("text")
	})

	it("collapses whitespace and passes plain text through", () => {
		expect(htmlToText("<p>a</p>\n\n<p>  b  </p>")).toBe("a b")
		expect(htmlToText("Generalised Zoning Types")).toBe("Generalised Zoning Types")
	})
})
