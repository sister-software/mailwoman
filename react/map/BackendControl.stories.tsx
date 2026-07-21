/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<BackendControl>` — the backend indicator + Force-WASM toggle, in the WebGPU and forced-WASM states.
 *   No maplibre; plain DOM.
 */

import type { Meta, StoryObj } from "@storybook/react-vite"

import { BackendControl } from "./BackendControl.tsx"

const meta: Meta<typeof BackendControl> = { title: "Map/Panels/BackendControl", component: BackendControl }
export default meta
type Story = StoryObj<typeof BackendControl>

/** Resolved to WebGPU, not forcing WASM. */
export const WebGPU: Story = {
	args: { activeBackend: "webgpu (28 MB int8)", forceWASM: false, onForceWASMChange: () => {} },
}

/** Forced onto the WASM backend. */
export const WASMForced: Story = {
	args: { activeBackend: "wasm (28 MB int8)", forceWASM: true, onForceWASMChange: () => {} },
}
