/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { SearchModal } from "@mailwoman/react/search/SearchModal"
import type { SearchResponse } from "@mailwoman/react/search/types"
import { expect, test, vi } from "vitest"
import { userEvent } from "vitest/browser"

import { renderComponent } from "../../test/render.tsx"

function response(query: string, urls: string[], corrected?: string): SearchResponse {
	return {
		query,
		...(corrected ? { corrected } : {}),
		hits: urls.map((url, index) => ({
			url,
			anchor: index === 0 ? "" : "section",
			hierarchy: [index < 2 ? "Reference" : "Guides", `Title ${url}`, null, null, null, null, null],
			snippet: `Snippet for ${url}`,
			highlights: [[0, 7]],
		})),
	}
}

function mount(search: (q: string, signal: AbortSignal) => Promise<SearchResponse>) {
	const onClose = vi.fn()
	const onNavigate = vi.fn()
	const view = renderComponent(<SearchModal open onClose={onClose} onNavigate={onNavigate} search={search} />)
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
	expect(options[0]!.querySelector("mark")?.textContent).toBe("Snippet")
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
