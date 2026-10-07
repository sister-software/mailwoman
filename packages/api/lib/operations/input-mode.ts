/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { InputModeSchema } from "@mailwoman/core/pipeline"
import { z } from "zod"

/**
 * The `input_mode` a request may name: a register, or `"auto"` to derive it from the input's shape.
 */
export const RequestInputModeSchema = z
	.union([InputModeSchema, z.literal("auto")])
	.meta({ id: "RequestInputMode", description: 'The parse register, or `"auto"` to derive it from the input.' })

export type RequestInputMode = z.infer<typeof RequestInputModeSchema>
