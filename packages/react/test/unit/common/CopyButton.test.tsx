/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { CopyButton } from "@mailwoman/react/common/CopyButton"
import { expect, test, vi } from "vitest"
import { userEvent } from "vitest/browser"

import { renderComponent } from "../../render.tsx"

test("CopyButton flips to the copied label after a click", async () => {
	const { container } = renderComponent(<CopyButton value="payload" />)
	const button = container.querySelector("button") as HTMLButtonElement

	expect(button.textContent).toContain("Copy")
	expect(button.textContent).not.toContain("Copied")

	await userEvent.click(button)

	await vi.waitFor(() => expect(button.textContent).toContain("Copied"))
})

test("CopyButton evaluates a thunk value at click time", async () => {
	let calls = 0

	const { container } = renderComponent(
		<CopyButton
			value={() => {
				calls++

				return "lazy"
			}}
		/>
	)

	expect(calls).toBe(0)
	await userEvent.click(container.querySelector("button") as HTMLButtonElement)
	expect(calls).toBe(1)
})
