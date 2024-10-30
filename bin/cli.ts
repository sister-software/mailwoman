/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { DebugOutputBuilder, parseAddressInput } from "mailwoman"

/**
 * Initialize the CLI and parse the input command.
 */
async function initCLI(): Promise<unknown> {
	const args = process.argv.slice(2)

	const commandName = args[0]

	if (!commandName || commandName === "--help" || commandName === "-h" || commandName === "help") {
		console.log("mailwoman [command] [address]")
		console.log("Commands:")
		console.log("\tparse: Parse an address in JSON format")
		console.log("\tdebug: Parse an address and output debug information")
		console.log("\tserve: Start the parser server")
		return
	}

	if (commandName === "serve") {
		console.log("Starting the parser server...")
		const { startPeliasParserServer } = await import("mailwoman/server")

		const app = startPeliasParserServer()

		return new Promise((resolve) => {
			app.addListener("close", resolve)
		})
	}

	if (commandName === "debug") {
		const builder = new DebugOutputBuilder()

		const formattedAddress = args.slice(1).join(" ")
		builder.parse(formattedAddress)

		console.log(builder.toString())

		return
	}

	const formattedAddress = commandName === "parse" ? args.slice(1).join(" ") : args.join(" ")

	const results = parseAddressInput(formattedAddress)
	console.log(JSON.stringify(results, null, 2))
}

export default initCLI()
