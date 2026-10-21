/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Global Storybook preview config. Loads what the Docusaurus theme loads on the site — the Go faces, the Sister
 *   Software tokens and the generated Infima bridge — so the docs components' `var(--ifm-…)` and `var(--ss-…)` lookups
 *   resolve to the same values in isolation. The backgrounds toggle sets `data-theme` on the root as well, because that
 *   attribute is what the dark tokens are keyed to.
 */

import type { Preview } from "@storybook/react-vite"

import "@sister.software/fonts/apply.css"
import "@sister.software/theme/tokens.css"
import "@sister.software/docusaurus-theme/css/infima/index.css"

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
				{ name: "light", value: "#f6f2f1" },
				{ name: "dark", value: "#1b1e20" },
			],
		},
	},
	decorators: [
		(Story, context) => {
			const background = context.globals["backgrounds"] as { value?: string } | undefined

			document.documentElement.dataset["theme"] = background?.value === "#1b1e20" ? "dark" : "light"

			return Story()
		},
	],
}

export default preview
