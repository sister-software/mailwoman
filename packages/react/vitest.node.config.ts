/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { defineConfig } from "vitest/config"

/**
 * Configures Vitest to run the package's `*.node.test.ts` files under plain Node,
 * outside the browser-mode config, to show those modules need no DOM or WebGL.
 */
export default defineConfig({
	test: {
		environment: "node",
		include: ["**/*.node.test.ts"],
	},
})
