/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Script-runner helpers (`runScript`, `runIfScript`, cleanup). The implementation lives in
 *   `@mailwoman/core/utils` so core-internal scripts can use it too (core cannot import from
 *   `mailwoman` — that direction cycles the workspace graph). This module stays as the stable
 *   `mailwoman/sdk/scripting` path for CLI/eval consumers.
 */

export { logScriptError, postScriptCleanup, runIfScript, runScript, type ScriptCallback } from "@mailwoman/core/utils"
