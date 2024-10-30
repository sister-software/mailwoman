/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { AddressParser } from "mailwoman"

declare global {
	namespace Express {
		interface Locals {
			parser: {
				address: AddressParser
			}
		}
	}
}

export {}
