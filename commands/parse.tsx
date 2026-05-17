/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Spinner } from "@inkjs/ui"
import { Text } from "ink"
import { createAddressParser, createDiagnosticReport } from "mailwoman"
import { useEffect, useState } from "react"
import zod from "zod"
import { CommandComponent } from "../sdk/cli.js"

const ArgumentsSchema = zod.array(zod.string().describe("A formatted postal address"))
export { ArgumentsSchema as args, ParseConfigSchema as options }

const ParseConfigSchema = zod.object({
	debug: zod.boolean().optional().default(false).describe("Enable verbose debugging output"),
	locale: zod
		.string()
		.regex(/^[a-z]{2}(-[A-Z]{2})?$/u, "Expected a BCP-47 tag like en-US or fr-FR")
		.optional()
		.describe("BCP-47 locale tag (e.g. en-US, fr-FR). Reserved for the upcoming neural pipeline."),
})

const ParseCommand: CommandComponent<typeof ParseConfigSchema, typeof ArgumentsSchema> = ({ options, args }) => {
	const [output, setOutput] = useState<string>()
	const [error, setError] = useState<string>()

	useEffect(() => {
		const parser = createAddressParser()
		const input = args[0]!

		const parseOpts = options.locale ? { locale: options.locale } : {}

		if (options.debug) {
			parser
				.parse(input, { verbose: true, ...parseOpts })
				.then(createDiagnosticReport)
				.then(setOutput)
				.catch((err) => setError(err.message))
		} else {
			parser
				.parse(input, parseOpts)
				.then((results) => setOutput(JSON.stringify(results, null, 2)))
				.catch((err) => setError(err.message))
		}
	}, [args, options.debug, options.locale])

	if (error) {
		return <Text color="red">{error}</Text>
	}

	if (!output) {
		return <Spinner />
	}

	return <Text>{output}</Text>
}

export default ParseCommand
