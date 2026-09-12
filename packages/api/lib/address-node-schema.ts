// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { z } from "@hono/zod-openapi"
import type { AddressNode } from "@mailwoman/core/decoder"

/**
 * OpenAPI representation of one decoded address-tree node.
 *
 * The decoder's recursive union cannot be derived by the OpenAPI generator, so the runtime wire contract is an open
 * object while the `AddressNode` type documents its recursive shape.
 */
export const AddressNodeSchema = z.custom<AddressNode>().openapi("AddressNode", {
	type: "object",
	additionalProperties: true,
	description:
		"A decoded address-tree node: a tag, its span, and its children. See `AddressNode` in `@mailwoman/core/decoder`.",
})
