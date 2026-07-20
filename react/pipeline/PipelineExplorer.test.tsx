/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Composed test: drives the whole pipeline explorer (ClientOnly boundary → useParsePipeline →
 *   presentational units) against a mock runtime — no model, no gazetteer.
 */

import { userEvent } from "@vitest/browser/context"
import { expect, test, vi } from "vitest"

import { makePipelineRuntime } from "../test/mocks.tsx"
import { renderComponent } from "../test/render.tsx"
import { PipelineExplorer } from "./PipelineExplorer.tsx"

test("parses on submit and renders components + resolved place", async () => {
	const { container } = renderComponent(
		<PipelineExplorer runtime={makePipelineRuntime()} defaultAddress="350 5th Ave" />
	)

	// ClientOnly mounts asynchronously; wait for the form.
	await vi.waitFor(() => expect(container.querySelector("#mw-pipeline-input")).toBeTruthy())

	await userEvent.click(container.querySelector('button[type="submit"]') as HTMLButtonElement)

	await vi.waitFor(() => expect(container.textContent).toContain("Parsed components"))
	expect(container.textContent).toContain("house_number")
	expect(container.textContent).toContain("Resolved place")
	expect(container.textContent).toContain("New York")
})

test("selecting an alternate candidate updates the resolved panel", async () => {
	const { container } = renderComponent(
		<PipelineExplorer runtime={makePipelineRuntime()} defaultAddress="350 5th Ave" />
	)

	await vi.waitFor(() => expect(container.querySelector("#mw-pipeline-input")).toBeTruthy())
	await userEvent.click(container.querySelector('button[type="submit"]') as HTMLButtonElement)
	await vi.waitFor(() => expect(container.querySelectorAll(".mw-candidates__btn").length).toBe(2))

	// Pick the second candidate (the region) — the resolved panel should now show "region".
	await userEvent.click(container.querySelectorAll(".mw-candidates__btn")[1] as HTMLElement)
	await vi.waitFor(() => expect(container.querySelector(".mw-resolved")?.textContent).toContain("region"))
})

test("renders host-injected extras from the parse result", async () => {
	const { container } = renderComponent(
		<PipelineExplorer
			runtime={makePipelineRuntime()}
			defaultAddress="350 5th Ave"
			panels={{ extras: (result) => <div className="mw-test-extra">extra:{result.nodes.length}</div> }}
		/>
	)

	await vi.waitFor(() => expect(container.querySelector("#mw-pipeline-input")).toBeTruthy())
	await userEvent.click(container.querySelector('button[type="submit"]') as HTMLButtonElement)
	await vi.waitFor(() => expect(container.querySelector(".mw-test-extra")?.textContent).toBe("extra:3"))
})
