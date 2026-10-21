/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A postcode span a check has ruled out keeps its node and text but fills no result slot.
 */

import type { AddressNode } from "#decoder/types"

/**
 * The metadata key that marks a postcode span the postcode shape check excluded.
 */
export const POSTCODE_SHAPE_EXCLUDED_KEY = "postcode_shape_excluded"

/**
 * Whether `node` is a postcode span the postcode shape check excluded.
 *
 * The node stays in the tree with its tag and text, so a reader of the tree can see what was refused.
 * The slot projections skip it, so the address has no postcode from that span,
 * and every postcode consumer in the resolver skips it too.
 */
export function isShapeExcludedPostcode(node: AddressNode): boolean {
	return node.tag === "postcode" && node.metadata?.[POSTCODE_SHAPE_EXCLUDED_KEY] === true
}
