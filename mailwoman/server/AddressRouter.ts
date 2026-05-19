/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { RequestHandler, Router } from "express"
import { createAddressParser, createDiagnosticReport, SerializedSolution } from "mailwoman"

/**
 * Response from the address parser endpoint.
 */
export interface ParseAddressResponse {
	input: {
		body: string
		start: number
		end: number
	}
	solutions: SerializedSolution[]
	debug?: string
}

const parser = createAddressParser()

const handler: RequestHandler = async (req, res) => {
	if (!parser) {
		console.error("Address parser not available")
		res.status(500).json({ error: "Address parser not available" })
		return
	}

	const address = req.body?.address || req.query?.address
	const debug = req.body?.debug || req.query?.debug

	if (!address) {
		res.status(400).json({ error: "Missing address parameter" })
		return
	}

	const result = await parser.parse(address, { verbose: true })
	const { solutions, context } = result

	res.status(200).json({
		input: {
			body: context.span.body,
			start: context.span.start,
			end: context.span.end,
		},
		solutions: solutions.map((solution) => solution.toJSON()),
		debug: debug ? createDiagnosticReport(result) : undefined,
	})
}

export const AddressRouter = Router()

AddressRouter.post("/parse", handler)
AddressRouter.search("/parse", handler)
AddressRouter.get("/parse", handler)
