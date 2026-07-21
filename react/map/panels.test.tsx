/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for the demo control units + the place-autocomplete hook — all plain DOM, no maplibre.
 *   VersionPicker / CompareToggle / BackendControl / ResultPanel are driven directly; `usePlaceAutocomplete`
 *   is exercised through a tiny harness (type → suggest → pick).
 */

import { userEvent } from "@vitest/browser/context"
import { useState } from "react"
import { expect, test, vi } from "vitest"

import { FAKE_SUGGESTIONS, makeFakeParseResult } from "../test/mocks.tsx"
import { renderComponent } from "../test/render.tsx"
import { BackendControl } from "./BackendControl.tsx"
import { CompareToggle } from "./CompareToggle.tsx"
import { PlaceAutocomplete } from "./PlaceAutocomplete.tsx"
import { ResultPanel } from "./ResultPanel.tsx"
import type { DemoVersionOption, Suggestion } from "./types.ts"
import { usePlaceAutocomplete } from "./usePlaceAutocomplete.ts"
import { VersionPicker } from "./VersionPicker.tsx"

const VERSIONS: DemoVersionOption[] = [
	{ version: "v7.2.0", label: "v7.2.0 (latest)" },
	{ version: "v7.1.0", label: "v7.1.0" },
]

// ── VersionPicker ─────────────────────────────────────────────────────────────

test("VersionPicker renders options and fires onSelect", async () => {
	const onSelect = vi.fn()
	const { container } = renderComponent(<VersionPicker versions={VERSIONS} selected="v7.2.0" onSelect={onSelect} />)

	const select = container.querySelector("#mw-demo-version") as HTMLSelectElement
	expect(select).not.toBeNull()
	expect(select.querySelectorAll("option").length).toBe(2)

	await userEvent.selectOptions(select, "v7.1.0")
	expect(onSelect).toHaveBeenCalledWith("v7.1.0")
})

test("VersionPicker renders nothing with fewer than two versions", () => {
	const { container } = renderComponent(
		<VersionPicker versions={[VERSIONS[0]!]} selected="v7.2.0" onSelect={() => {}} />
	)

	expect(container.querySelector("#mw-demo-version")).toBeNull()
})

// ── CompareToggle ─────────────────────────────────────────────────────────────

test("CompareToggle reveals the compare select (primary excluded) when turned on", async () => {
	function Harness() {
		const [mode, setMode] = useState(false)
		const [version, setVersion] = useState<string | null>(null)

		return (
			<CompareToggle
				versions={[...VERSIONS, { version: "v6.4.0", label: "v6.4.0" }]}
				primaryVersion="v7.2.0"
				compareMode={mode}
				onCompareModeChange={setMode}
				compareVersion={version}
				onCompareVersionChange={setVersion}
			/>
		)
	}

	const { container } = renderComponent(<Harness />)

	// Off: no compare select yet.
	expect(container.querySelector("#mw-demo-compare-version")).toBeNull()

	await userEvent.click(container.querySelector('input[type="checkbox"]') as HTMLInputElement)

	const select = container.querySelector("#mw-demo-compare-version") as HTMLSelectElement
	expect(select).not.toBeNull()
	// The primary version is filtered out; the "Select version…" placeholder + the two others remain.
	const values = Array.from(select.querySelectorAll("option")).map((o) => (o as HTMLOptionElement).value)
	expect(values).not.toContain("v7.2.0")
	expect(values).toContain("v7.1.0")
	expect(values).toContain("v6.4.0")
})

// ── BackendControl ────────────────────────────────────────────────────────────

test("BackendControl shows the backend and toggles forceWASM", async () => {
	const onForceWASMChange = vi.fn()
	const { container } = renderComponent(
		<BackendControl activeBackend="webgpu (28 MB int8)" forceWASM={false} onForceWASMChange={onForceWASMChange} />
	)

	expect(container.textContent).toContain("webgpu (28 MB int8)")
	await userEvent.click(container.querySelector('input[type="checkbox"]') as HTMLInputElement)
	expect(onForceWASMChange).toHaveBeenCalledWith(true)
})

// ── ResultPanel ───────────────────────────────────────────────────────────────

test("ResultPanel renders components + resolved place, and switches candidate", async () => {
	function Harness() {
		const [index, setIndex] = useState(0)
		const result = makeFakeParseResult()

		return (
			<div className="mw-pipeline-explorer">
				<ResultPanel
					result={result}
					selectedCandidate={result.candidates[index] ?? null}
					selectedCandidateIndex={index}
					onSelectCandidate={setIndex}
				/>
			</div>
		)
	}

	const { container } = renderComponent(<Harness />)

	expect(container.textContent).toContain("Parsed components")
	expect(container.textContent).toContain("house_number")
	expect(container.querySelector(".mw-resolved")?.textContent).toContain("locality")

	// Pick the second candidate (the region) → resolved panel updates.
	await userEvent.click(container.querySelectorAll(".mw-candidates__btn")[1] as HTMLElement)
	await vi.waitFor(() => expect(container.querySelector(".mw-resolved")?.textContent).toContain("region"))
})

test("ResultPanel renders the injected failure slot when nothing resolved", () => {
	const result = { ...makeFakeParseResult(), resolved: null, candidates: [] }
	const { container } = renderComponent(
		<ResultPanel
			result={result}
			selectedCandidate={null}
			selectedCandidateIndex={0}
			onSelectCandidate={() => {}}
			failure={() => <p className="mw-test-failure">no resolve</p>}
		/>
	)

	expect(container.querySelector(".mw-test-failure")?.textContent).toBe("no resolve")
	expect(container.querySelector(".mw-resolved")).toBeNull()
})

// ── usePlaceAutocomplete (via a harness) ───────────────────────────────────────

function AutocompleteHarness({ autocomplete }: { autocomplete: (q: string) => Promise<Suggestion[]> }) {
	const [text, setText] = useState("")
	const ac = usePlaceAutocomplete({ text, setText, autocomplete, debounceMs: 10, minChars: 2 })

	return (
		<div>
			<input
				data-testid="ac-input"
				value={text}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={ac.onInputKeyDown}
				{...ac.inputProps}
			/>
			<PlaceAutocomplete
				suggestions={ac.suggestions}
				activeIndex={ac.activeIndex}
				onPick={ac.pick}
				onHover={ac.setActiveIndex}
				listboxId={ac.listboxId}
				optionId={ac.optionId}
			/>
		</div>
	)
}

test("usePlaceAutocomplete suggests on type and rewrites the input on pick", async () => {
	const autocomplete = async (q: string): Promise<Suggestion[]> =>
		FAKE_SUGGESTIONS.filter((s) => s.value.toLowerCase().startsWith(q.toLowerCase()))

	const { container } = renderComponent(<AutocompleteHarness autocomplete={autocomplete} />)

	const input = container.querySelector('[data-testid="ac-input"]') as HTMLInputElement
	await userEvent.type(input, "New")

	// Debounced fetch → the listbox appears with the three "New*" suggestions.
	await vi.waitFor(() => expect(container.querySelectorAll('[role="option"]').length).toBe(3))
	expect(input.getAttribute("aria-expanded")).toBe("true")

	// Pick the first (New York) → input rewritten (no comma → whole value replaced), listbox closes.
	await userEvent.click(container.querySelectorAll('[role="option"]')[0] as HTMLElement)
	await vi.waitFor(() => expect(input.value).toBe("New York"))
	expect(container.querySelectorAll('[role="option"]').length).toBe(0)
})

test("usePlaceAutocomplete stays closed for numeric input (postcode)", async () => {
	const autocomplete = vi.fn(async () => FAKE_SUGGESTIONS)
	const { container } = renderComponent(<AutocompleteHarness autocomplete={autocomplete} />)

	const input = container.querySelector('[data-testid="ac-input"]') as HTMLInputElement
	await userEvent.type(input, "90210")

	// A short wait past the debounce — a digit-leading query never fires the fetcher.
	await new Promise((resolve) => setTimeout(resolve, 60))
	expect(autocomplete).not.toHaveBeenCalled()
	expect(container.querySelectorAll('[role="option"]').length).toBe(0)
})
