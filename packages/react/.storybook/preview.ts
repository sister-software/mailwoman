/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Global Storybook preview: loads the component stylesheet + the Infima token shim so the isolated
 *   components look like they do in the docs, and a light/dark backgrounds toggle mirroring the site.
 */

import type { Preview } from "@storybook/react-vite"

import "../styles.css"
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
