/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"
import { SearchModal } from "@mailwoman/react/search/SearchModal"
import type { SearchResponse } from "@mailwoman/react/search/types"
import { expect, test, vi } from "vitest"
import { userEvent } from "vitest/browser"

import { renderComponent } from "../../test/render.tsx"

function response(query: string, urls: string[], corrected: string | null = null): SearchResponse {
	return {
		query,
		corrected,
		hits: urls.map((url, index) => ({
			url,
			anchor: index === 0 ? "" : "section",
			hierarchy: [index < 2 ? "Reference" : "Guides", `Title ${url}`, null, null, null, null, null],
			snippet: `Snippet for ${url}`,
			highlights: [[0, 7]],
		})),
	}
}

function mount(search: (q: string, signal: AbortSignal) => Promise<SearchResponse>, recentKey?: string) {
	const onClose = vi.fn()
	const onNavigate = vi.fn()

	const view = renderComponent(
		<SearchModal open onClose={onClose} onNavigate={onNavigate} search={search} recentKey={recentKey} />
	)

	const dialog = view.container.querySelector("dialog") as HTMLDialogElement
	const input = view.container.querySelector('input[type="search"]') as HTMLInputElement

	return { ...view, dialog, input, onClose, onNavigate }
}

test("opens a modal dialog and focuses a search input that is a combobox", async () => {
	const { dialog, input } = mount(async (q) => response(q, []))

	await vi.waitFor(() => expect(dialog.open).toBe(true))
	expect(dialog.matches(":modal")).toBe(true)
	expect(dialog.hasAttribute("role")).toBe(false)
	expect(document.activeElement).toBe(input)
	expect(input.getAttribute("role")).toBe("combobox")
	expect(input.getAttribute("aria-autocomplete")).toBe("list")
	expect(input.getAttribute("aria-expanded")).toBe("false")
})

test("renders hits as options in labeled groups and selects the first", async () => {
	const { container, input } = mount(async (q) => response(q, ["/a", "/b", "/c"]))

	await userEvent.type(input, "decoder")
	await vi.waitFor(() => expect(container.querySelectorAll('[role="option"]')).toHaveLength(3))

	const listbox = container.querySelector('[role="listbox"]') as HTMLElement
	const groups = [...container.querySelectorAll('[role="group"]')]
	const options = [...container.querySelectorAll('[role="option"]')]

	expect(input.getAttribute("aria-controls")).toBe(listbox.id)
	expect(input.getAttribute("aria-expanded")).toBe("true")
	expect(groups).toHaveLength(2)
	expect(document.getElementById(groups[0]!.getAttribute("aria-labelledby")!)?.textContent).toBe("Reference")
	expect(input.getAttribute("aria-activedescendant")).toBe(options[0]!.id)
	expect(options[0]!.getAttribute("aria-selected")).toBe("true")
	expect(options[1]!.tagName).toBe("A")
	expect(options[1]!.getAttribute("href")).toBe("/b#section")
	expect(options[1]!.querySelector("a, button, input, [tabindex]")).toBeNull()
	expect(options[0]!.querySelector(".mw-search__snippet mark")?.textContent).toBe("Snippet")
})

test("emphasizes the query in the title and shows the heading path above a section hit", async () => {
	const { container, input } = mount(async (q) => ({
		query: q,
		corrected: null,
		hits: [
			{
				url: "/a",
				anchor: "scope",
				hierarchy: ["Reference", "Locales and tiers", "Scope", null, null, null, null],
				snippet: "",
				highlights: [],
			},
		],
	}))

	await userEvent.type(input, "scope")
	await vi.waitFor(() => expect(container.querySelectorAll('[role="option"]')).toHaveLength(1))

	const option = container.querySelector('[role="option"]')!

	expect(option.querySelector(".mw-search__path")?.textContent).toBe("Locales and tiers")
	expect(option.querySelector(".mw-search__title mark")?.textContent).toBe("Scope")
	expect(option.className).toContain("mw-search__option--section")
})

function recentHit(url: string, anchor = "") {
	return {
		url,
		anchor,
		hierarchy: ["Guides", `Title ${url}`, anchor === "" ? null : "Section", null, null, null, null],
	}
}

test("lists recent hits as options while the field is empty, opens one on Enter, and removes one on Delete", async () => {
	const key = `mw-search-test-${Date.now()}`

	localStorage.setItem(key, stringifyJSON([recentHit("/earlier", "part"), recentHit("/older"), "a query string"]))

	const { container, input, onNavigate } = mount(async (q) => response(q, ["/x"]), key)

	await vi.waitFor(() => expect(container.querySelectorAll('[role="option"]')).toHaveLength(2))

	const options = [...container.querySelectorAll('[role="option"]')]

	expect(options[0]!.getAttribute("href")).toBe("/earlier#part")
	expect(options[0]!.querySelector(".mw-search__path")?.textContent).toBe("Title /earlier")
	expect(options[0]!.querySelector(".mw-search__title")?.textContent).toBe("Section")
	expect(input.getAttribute("aria-controls")).toBe(container.querySelector('[role="listbox"]')!.id)

	await userEvent.keyboard("{ArrowDown}{Delete}")
	expect(parseJSONStrict(localStorage.getItem(key)!)).toEqual([recentHit("/earlier", "part")])
	await vi.waitFor(() => expect(container.querySelectorAll('[role="option"]')).toHaveLength(1))

	await userEvent.keyboard("{Enter}")
	expect(onNavigate).toHaveBeenCalledWith("/earlier#part")
	localStorage.removeItem(key)
})

test("remembers an opened hit, newest first, five at most", async () => {
	const key = `mw-search-test-${Date.now()}-b`
	const stored = ["/one", "/two", "/three", "/four", "/five"].map((url) => recentHit(url))

	localStorage.setItem(key, stringifyJSON(stored))

	const { container, input, onNavigate } = mount(async (q) => response(q, ["/x"]), key)

	await userEvent.type(input, "six")
	// The stored hits already expand the listbox while the field is empty,
	// so `aria-expanded` is true before the search answers.
	// Enter must wait for the search hit itself to render.
	await vi.waitFor(() => expect(container.querySelector('[role="option"][href^="/x"]')).not.toBeNull())
	await userEvent.keyboard("{Enter}")

	// The `/x` on screen can answer "si" while "six" is still debouncing, and the Enter then waits for "six".
	await vi.waitFor(() => expect(onNavigate).toHaveBeenCalledWith("/x"))

	const remembered = parseJSONStrict<{ url: string }[]>(localStorage.getItem(key)!)

	expect(remembered.map((hit) => hit.url)).toEqual(["/x", "/one", "/two", "/three", "/four"])
	expect(remembered[0]).not.toHaveProperty("snippet")
	localStorage.removeItem(key)
})

/**
 * A search whose responses the test releases by hand, so an Enter can land before a query's results.
 */
function heldSearch() {
	const held = new Map<string, () => void>()

	const search = (q: string) =>
		new Promise<SearchResponse>((resolve) => {
			held.set(q, () => resolve(response(q, [`/${q}`])))
		})

	return { search, release: (q: string) => held.get(q)?.(), has: (q: string) => held.has(q) }
}

test("an Enter pressed before the query's results arrive opens the first hit once they settle", async () => {
	const { search, release, has } = heldSearch()
	const { input, onNavigate } = mount(search)

	await userEvent.type(input, "six")
	await userEvent.keyboard("{Enter}")

	expect(onNavigate).not.toHaveBeenCalled()
	await vi.waitFor(() => expect(has("six")).toBe(true))
	release("six")
	await vi.waitFor(() => expect(onNavigate).toHaveBeenCalledWith("/six"))
	expect(onNavigate).toHaveBeenCalledTimes(1)
})

test("a keystroke after a pending Enter cancels it", async () => {
	const { search, release, has } = heldSearch()
	const { input, onNavigate } = mount(search)

	await userEvent.type(input, "six")
	await userEvent.keyboard("{Enter}")
	await userEvent.type(input, "t")
	await vi.waitFor(() => expect(has("sixt")).toBe(true))
	release("six")
	release("sixt")
	await vi.waitFor(() => expect(input.getAttribute("aria-activedescendant")).toBeTruthy())

	expect(onNavigate).not.toHaveBeenCalled()
})

test("emphasizes each word of a hyphenated query in the title", async () => {
	const { container, input } = mount(async (q) => ({
		query: q,
		corrected: null,
		hits: [
			{
				url: "/a",
				anchor: "",
				hierarchy: ["Reference", "Tier 1 locales", null, null, null, null, null],
				snippet: "",
				highlights: [],
			},
		],
	}))

	await userEvent.type(input, "tier-locales")
	await vi.waitFor(() => expect(container.querySelectorAll('[role="option"]')).toHaveLength(1))

	const marks = [...container.querySelectorAll(".mw-search__title mark")].map((mark) => mark.textContent)

	expect(marks).toEqual(["Tier", "locales"])
})

test("names no listbox while none is shown and starts empty after a close", async () => {
	const { container, dialog, input } = mount(async (q) => response(q, ["/x"]))

	await vi.waitFor(() => expect(dialog.open).toBe(true))
	expect(input.hasAttribute("aria-controls")).toBe(false)

	await userEvent.type(input, "decoder")
	await vi.waitFor(() => expect(container.querySelectorAll('[role="option"]')).toHaveLength(1))
	dialog.close()

	await vi.waitFor(() => expect(input.value).toBe(""))
})

test("shows the keyboard hints in the footer and the result count beside them", async () => {
	const { container, input } = mount(async (q) => response(q, ["/a", "/b"]))

	expect(container.querySelector('.mw-search__hints[aria-label="Keyboard shortcuts"]')?.textContent).toContain("esc")

	await userEvent.type(input, "x")

	await vi.waitFor(() =>
		expect(container.querySelector(".mw-search__footer .mw-search__status")?.textContent).toBe("2 results.")
	)
})

test("words the empty result and shows the search icon in the field", async () => {
	const { container, input } = mount(async (q) => response(q, []))

	expect(container.querySelector(".mw-search__field .mw-search__icon")).not.toBeNull()

	await userEvent.type(input, "zzz")

	await vi.waitFor(() =>
		expect(container.querySelector(".mw-search__empty")?.textContent).toBe(
			"No results for “zzz”. Try a different spelling or a shorter query."
		)
	)
})

test("moves the selection with the arrow keys, wraps, and navigates on Enter", async () => {
	const { container, input, onNavigate, onClose } = mount(async (q) => response(q, ["/a", "/b"]))

	await userEvent.type(input, "x")
	await vi.waitFor(() => expect(container.querySelectorAll('[role="option"]')).toHaveLength(2))

	const options = [...container.querySelectorAll('[role="option"]')]

	await userEvent.keyboard("{ArrowDown}")
	expect(input.getAttribute("aria-activedescendant")).toBe(options[1]!.id)
	await userEvent.keyboard("{ArrowDown}")
	expect(input.getAttribute("aria-activedescendant")).toBe(options[0]!.id)
	await userEvent.keyboard("{ArrowUp}")
	expect(input.getAttribute("aria-activedescendant")).toBe(options[1]!.id)
	expect(document.activeElement).toBe(input)

	await userEvent.keyboard("{Enter}")
	expect(onNavigate).toHaveBeenCalledWith("/b#section")
	expect(onClose).toHaveBeenCalled()
})

test("ignores Enter until the results answer the typed query", async () => {
	const { container, input, onNavigate } = mount(async (q) => response(q, [`/${q}`]))

	await userEvent.type(input, "a")
	await vi.waitFor(() => expect(container.querySelector('[role="option"]')?.getAttribute("href")).toBe("/a"))

	await userEvent.type(input, "b")
	await userEvent.keyboard("{Enter}")
	expect(onNavigate).not.toHaveBeenCalled()

	await vi.waitFor(() => expect(container.querySelector('[role="option"]')?.getAttribute("href")).toBe("/ab"))
	await userEvent.keyboard("{Enter}")
	expect(onNavigate).toHaveBeenCalledWith("/ab")
})

test("announces a slow request as loading, then the results", async () => {
	const { container, input } = mount(
		(q) =>
			new Promise<SearchResponse>((resolve) => {
				setTimeout(() => resolve(response(q, ["/slow"])), 500)
			})
	)

	const status = container.querySelector('[aria-live="polite"]') as HTMLElement

	await userEvent.type(input, "slow")
	await vi.waitFor(() => expect(status.textContent).toBe("Loading the search index…"))
	await vi.waitFor(() => expect(status.textContent).toBe("1 result."))
	expect(container.querySelector('[role="option"]')?.getAttribute("href")).toBe("/slow")
})

test("calls onClose when the dialog closes on Escape", async () => {
	const { dialog, onClose } = mount(async (q) => response(q, []))

	await vi.waitFor(() => expect(dialog.open).toBe(true))
	await userEvent.keyboard("{Escape}")
	await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
})

test("keeps the results of the latest query when an earlier response arrives later", async () => {
	const pending = new Map<string, (value: SearchResponse) => void>()

	const { container, input } = mount(
		(q) =>
			new Promise<SearchResponse>((resolve) => {
				pending.set(q, resolve)
			})
	)

	await userEvent.type(input, "a")
	await vi.waitFor(() => expect(pending.has("a")).toBe(true))
	await userEvent.type(input, "b")
	await vi.waitFor(() => expect(pending.has("ab")).toBe(true))

	pending.get("ab")!(response("ab", ["/latest"]))
	await vi.waitFor(() => expect(container.querySelector('[role="option"]')?.getAttribute("href")).toBe("/latest"))

	pending.get("a")!(response("a", ["/stale"]))

	await new Promise<void>((resolve) => {
		setTimeout(resolve, 50)
	})

	expect(container.querySelector('[role="option"]')?.getAttribute("href")).toBe("/latest")
})

test("shows the corrected query, and announces zero hits and a failure in the live region", async () => {
	let fail = false

	const { container, input } = mount(async (q) => {
		if (fail) throw new Error("network")

		return q === "vitrebi" ? response(q, ["/v"], "viterbi") : response(q, [])
	})

	const status = container.querySelector('[aria-live="polite"]') as HTMLElement

	expect(getComputedStyle(status).display).not.toBe("none")

	await userEvent.type(input, "vitrebi")
	await vi.waitFor(() => expect(container.textContent).toContain("Showing results for “viterbi”"))

	await userEvent.clear(input)
	await userEvent.type(input, "zzz")
	await vi.waitFor(() => expect(status.textContent).toBe("No results for “zzz”."))

	fail = true
	await userEvent.type(input, "z")
	await vi.waitFor(() => expect(status.textContent).toBe("Search is unavailable. Try again in a moment."))
})
