/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Spinner } from "@inkjs/ui"
import { NeuralAddressClassifier } from "@mailwoman/neural"
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
		.regex(/^[a-z]{2}(-[a-z]{2})?$/u, "Expected a BCP-47-ish tag like en-us or fr-fr (lowercase)")
		.optional()
		.default("en-us")
		.describe("Locale tag matching a weights package (en-us, fr-fr). Default en-us."),
	neural: zod
		.boolean()
		.optional()
		.default(false)
		.describe("Route through the neural classifier instead of the rule-based parser."),
	format: zod
		.enum(["json", "tuple", "xml"])
		.optional()
		.default("json")
		.describe("Output projection for --neural. Ignored without --neural."),
	model: zod.string().optional().describe("Explicit model.onnx path (--neural only). Overrides --locale resolution."),
	tokenizer: zod
		.string()
		.optional()
		.describe("Explicit tokenizer.model path (--neural only). Overrides --locale resolution."),
})

const ParseCommand: CommandComponent<typeof ParseConfigSchema, typeof ArgumentsSchema> = ({ options, args }) => {
	const [output, setOutput] = useState<string>()
	const [error, setError] = useState<string>()

	useEffect(() => {
		const input = args[0]!

		if (options.neural) {
			NeuralAddressClassifier.loadFromWeights({
				locale: options.locale,
				modelPath: options.model,
				tokenizerPath: options.tokenizer,
			})
				.then(async (cls) => {
					switch (options.format) {
						case "xml":
							return cls.parseXml(input)
						case "tuple":
							return JSON.stringify(await cls.parseTuples(input), null, 2)
						case "json":
						default:
							return JSON.stringify(await cls.parseJson(input), null, 2)
					}
				})
				.then(setOutput)
				.catch((err) => setError(err.message))
			return
		}

		const parser = createAddressParser()
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
	}, [args, options.debug, options.locale, options.neural, options.format, options.model, options.tokenizer])

	if (error) {
		return <Text color="red">{error}</Text>
	}

	if (!output) {
		return <Spinner />
	}

	return <Text>{output}</Text>
}

export default ParseCommand
