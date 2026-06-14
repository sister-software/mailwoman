/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Global Storybook preview config. Loads a small token shim (`preview-tokens.css`) that defines the
 *   handful of Infima (`--ifm-*`) CSS variables the components reference — Docusaurus's theme isn't
 *   present in Storybook, so without these the CSS-module `var(--ifm-…)` lookups would fall back to
 *   the browser default. A light/dark backgrounds toggle mirrors the docs site's two themes.
 */

import type { Preview } from "@storybook/react-vite"

import "./preview-tokens.css"

const preview: Preview = {
	parameters: {
		controls: {
			matchers: {
				color: /(background|color)$/i,
				date: /Date$/i,
			},
		},
		backgrounds: {
			default: "light",
			values: [
				{ name: "light", value: "#ffffff" },
				{ name: "dark", value: "#1b1b1d" },
			],
		},
	},
}

export default preview
