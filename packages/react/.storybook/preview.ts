/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Global Storybook preview. `styles.css` pulls `tokens.css` in itself, so the isolated components read the same
 *   vocabulary the apps and the docs site read — there is no separate shim to drift from it. The backgrounds toggle
 *   sets `data-theme` on the root as well, because that attribute is what the dark tokens are keyed to.
 */

import type { Preview } from "@storybook/react-vite"

import "../fonts.css"
import "../styles.css"

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
	decorators: [
		(Story, context) => {
			const background = context.globals["backgrounds"] as { value?: string } | undefined

			document.documentElement.dataset["theme"] = background?.value === "#1b1b1d" ? "dark" : "light"

			return Story()
		},
	],
}

export default preview
