/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assert } from "mailwoman/sdk/test/utils"

assert("Zadarska 17, Pula", [{ street: "Zadarska" }, { housenumber: "17" }, { locality: "Pula" }])
