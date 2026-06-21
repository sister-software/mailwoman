import { expect, test } from "#e2e"

test.describe("Demo — place autocomplete typeahead (#587)", () => {
	test("a partial last token surfaces a char-level FST suggestion that fills the box", async ({ demo }) => {
		// "New Yor" is a PARTIAL last token — the night-15 char-level FST completion (continuation-edge
		// prefix filtering) must suggest "New York" (not Denver / New London), dedup'd. The useEffect
		// re-runs when the FST finishes loading, so the suggestion appears even if typed during cold-load.
		await demo.goto()
		const suggestions = await demo.readSuggestions("New Yor")
		expect(suggestions.join(" | "), `suggestions for "New Yor": ${suggestions.join(", ")}`).toContain("New York")
		await demo.pickSuggestion("New York")
		expect(await demo.addressValue()).toBe("New York")
		demo.console.assertNoFailEvents()
	})

	test("autocompletes only the locality segment after the last comma", async ({ demo }) => {
		// The typeahead walks the segment after the last comma; picking replaces just that segment.
		await demo.goto()
		const suggestions = await demo.readSuggestions("123 Main St, Chic")
		expect(suggestions.join(" | "), `suggestions for "Chic": ${suggestions.join(", ")}`).toContain("Chicago")
		await demo.pickSuggestion("Chicago")
		expect(await demo.addressValue()).toBe("123 Main St, Chicago")
		demo.console.assertNoFailEvents()
	})
})
