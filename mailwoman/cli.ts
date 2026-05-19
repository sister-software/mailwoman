#!/usr/bin/env node

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import Pastel from "pastel"

const app = new Pastel({
	importMeta: import.meta,
	description: "A CLI tool for managing mailwoman projects",
	name: "Mailwoman CLI",
	version: "0.1.0",
})

await app.run()
