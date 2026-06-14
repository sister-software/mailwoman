/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Storybook (Vite builder) for the docs workspace. Lets the React components in `src/components/`
 *   be developed and reviewed in isolation — outside the Docusaurus/MapLibre/ONNX runtime — which
 *   is what makes the leaf components safely refactorable. Docusaurus itself stays on webpack;
 *   Storybook runs an independent Vite pipeline so the two don't interfere.
 */

import react from "@vitejs/plugin-react"

import type { StorybookConfig } from "@storybook/react-vite"

const config: StorybookConfig = {
	stories: ["../src/**/*.stories.@(ts|tsx|mdx)"],
	addons: ["@storybook/addon-docs"],
	framework: {
		name: "@storybook/react-vite",
		options: {},
	},
	core: {
		disableTelemetry: true,
	},
	typescript: {
		// react-docgen-typescript surfaces the JSDoc on each prop in the Storybook controls panel.
		reactDocgen: "react-docgen-typescript",
	},
	// Storybook's react-vite preset wires most of this, but applying the React plugin explicitly keeps
	// JSX/Fast-Refresh deterministic regardless of preset-detection order.
	viteFinal: (viteConfig) => {
		viteConfig.plugins = [...(viteConfig.plugins ?? []), react()]
		return viteConfig
	},
}

export default config
