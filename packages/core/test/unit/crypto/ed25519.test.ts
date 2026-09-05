/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The WebCrypto Ed25519 module against the `node:crypto` implementation it replaces, with the fixture token as the
 *   reference: its signature was produced under the old module over `mwl1.<payload>`, so it must verify here, and the
 *   same key and bytes must sign to the same signature, because Ed25519 is deterministic. Its key id is the first eight
 *   hex digits of SHA-256 over the SPKI DER, so the DER decoder and the digest are checked by the same fixture. No
 *   builtin is imported, which is the property under test.
 */

import { fromBase64URL, utf8Bytes } from "@mailwoman/core/crypto/base64url"
import { hexOf, sha256Bytes } from "@mailwoman/core/crypto/digest"
import { generateEd25519KeyPair, publicKeyDER, signEd25519, verifyEd25519 } from "@mailwoman/core/crypto/ed25519"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { describe, expect, it } from "vitest"

interface LegacyFixture {
	privateKeyPEM: string
	publicKeyPEM: string
	kid: string
	token: string
}

const fixture = await readLocalJSONFile<LegacyFixture>(
	resolvePackagePath("@mailwoman/core", "test", "fixtures", "license", "legacy-token.json")
)

const [prefix, payloadPart, signaturePart] = fixture.token.split(".") as [string, string, string]
const signedBytes = utf8Bytes(`${prefix}.${payloadPart}`)
const legacySignature = fromBase64URL(signaturePart)

/**
 * An Ed25519 public key in SPKI DER is a 12-byte algorithm header plus the 32-byte key.
 */
const SPKI_ED25519_DER_LENGTH = 44

describe("Ed25519 on WebCrypto", () => {
	it("verifies the signature the node:crypto signer produced over the fixture token", async () => {
		expect(legacySignature).toHaveLength(64)
		expect(await verifyEd25519(signedBytes, fixture.publicKeyPEM, legacySignature)).toBe(true)
	})

	it("produces the signature node:crypto produced for the same key and bytes", async () => {
		expect(await signEd25519(signedBytes, fixture.privateKeyPEM)).toEqual(legacySignature)
	})

	it("refuses the same signature over other bytes and a signature of the wrong length, without throwing", async () => {
		expect(await verifyEd25519(utf8Bytes(`${prefix}.x${payloadPart}`), fixture.publicKeyPEM, legacySignature)).toBe(
			false
		)

		expect(await verifyEd25519(signedBytes, fixture.publicKeyPEM, new Uint8Array(3))).toBe(false)
	})

	it("decodes the fixture's SPKI DER and digests it to the fixture's key id", async () => {
		const der = publicKeyDER(fixture.publicKeyPEM)

		expect(der).toHaveLength(SPKI_ED25519_DER_LENGTH)
		expect(hexOf(await sha256Bytes(der)).slice(0, 8)).toBe(fixture.kid.replace(/^v\d+-/u, ""))
	})

	it("generates a pair whose halves sign and verify, in PEM with 64-column lines", async () => {
		const pair = await generateEd25519KeyPair()

		expect(pair.privateKeyPEM).toMatch(
			/^-----BEGIN PRIVATE KEY-----\n(?:[A-Za-z0-9+/=]{1,64}\n)+-----END PRIVATE KEY-----\n$/u
		)

		expect(pair.publicKeyPEM).toMatch(
			/^-----BEGIN PUBLIC KEY-----\n(?:[A-Za-z0-9+/=]{1,64}\n)+-----END PUBLIC KEY-----\n$/u
		)

		expect(publicKeyDER(pair.publicKeyPEM)).toHaveLength(SPKI_ED25519_DER_LENGTH)

		const signature = await signEd25519(signedBytes, pair.privateKeyPEM)

		expect(await verifyEd25519(signedBytes, pair.publicKeyPEM, signature)).toBe(true)
		expect(await verifyEd25519(signedBytes, fixture.publicKeyPEM, signature)).toBe(false)
	})
})
