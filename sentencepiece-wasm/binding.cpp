/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Embind wrapper for google/sentencepiece v0.2.2 — the mailwoman tokenizer's WASM core (task #26,
 * the SP 0.2.2 native-offsets lever from the 2026-07-30 Latin tokenizer survey).
 *
 * Why this exists: the previous runtime (`@sctg/sentencepiece-js`, an emscripten build of an older
 * sentencepiece) exposed pieces + ids but never bound the offset-carrying proto API, forcing
 * `neural/tokenizer.ts` to RECONSTRUCT char offsets by re-walking the input — the source of the
 * byte-fallback desync class and the documented surrogate-pair deferral. SentencePiece itself has
 * always known the answer: `Encode(text, &SentencePieceText)` yields per-piece `begin`/`end` BYTE
 * offsets with the documented invariant `text.substr(begin, end - begin) == surface` and
 * contiguity between consecutive pieces. This wrapper binds exactly that.
 *
 * API surface (deliberately minimal — one class, three methods):
 *
 * - `loadFromSerializedProto(bytes)` — load a `tokenizer.model` from bytes; returns "" on success,
 *   the status message on failure (no exceptions across the WASM boundary).
 * - `encodeWithOffsets(text)` — returns { pieces: string[], ids: Int32Array-like, begins, ends }
 *   where begins/ends are UTF-8 BYTE offsets into the input. The TS layer owns the byte→UTF-16
 *   conversion (exact, via a code-point walk — see neural/tokenizer.ts).
 * - `decodeIds(ids)` — detokenize back to a string.
 *
 * Build: `./build.sh` (fetches sentencepiece at the pinned tag, emcmake+emmake, links this file
 * with embind, emits the committed single-file ESM artifact `sentencepiece.mjs`).
 */

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <cstdint>
#include <string>
#include <vector>

#include "builtin_pb/sentencepiece.pb.h"
#include "sentencepiece_processor.h"

namespace {

class SentencePieceWASM {
public:
	/**
	 * Load a tokenizer.model from its serialized-proto bytes (a JS Uint8Array). Returns "" on
	 * success, the status message on failure — errors cross the WASM boundary as values, never
	 * exceptions. NOTE the parameter is emscripten::val, NOT std::string: embind marshals JS
	 * strings to std::string as UTF-8, which corrupts arbitrary binary — the exact trap that made
	 * the first smoke fail to parse the model proto.
	 */
	std::string loadFromSerializedProto(const emscripten::val& data) {
		const std::vector<uint8_t> bytes = emscripten::convertJSArrayToNumberVector<uint8_t>(data);
		const auto status = processor_.LoadFromSerializedProto(
			absl::string_view(reinterpret_cast<const char*>(bytes.data()), bytes.size()));
		return status.ok() ? std::string() : std::string(status.message());
	}

	/**
	 * Encode with native offsets. Returns a JS object:
	 * { pieces: string[], ids: number[], begins: number[], ends: number[] } — begins/ends are byte
	 * offsets into the UTF-8 encoding of `text` (the exact bytes embind marshalled in).
	 */
	emscripten::val encodeWithOffsets(const std::string& text) const {
		sentencepiece::SentencePieceText spt;
		const auto status = processor_.Encode(text, &spt);

		emscripten::val result = emscripten::val::object();

		if (!status.ok()) {
			result.set("error", std::string(status.message()));
			return result;
		}

		const int n = spt.pieces_size();
		emscripten::val pieces = emscripten::val::array();
		emscripten::val ids = emscripten::val::array();
		emscripten::val begins = emscripten::val::array();
		emscripten::val ends = emscripten::val::array();

		for (int i = 0; i < n; i++) {
			const auto& p = spt.pieces(i);
			pieces.set(i, p.piece());
			ids.set(i, p.id());
			begins.set(i, p.begin());
			ends.set(i, p.end());
		}

		result.set("pieces", pieces);
		result.set("ids", ids);
		result.set("begins", begins);
		result.set("ends", ends);
		return result;
	}

	/**
	 * Detokenize ids back to text. Invalid ids surface as the empty string plus the error field on
	 * the wrapper's contract being violated upstream — the TS layer validates lengths.
	 */
	std::string decodeIds(const std::vector<int>& ids) const {
		std::string out;
		const auto status = processor_.Decode(ids, &out);
		return status.ok() ? out : std::string();
	}

private:
	sentencepiece::SentencePieceProcessor processor_;
};

}  // namespace

EMSCRIPTEN_BINDINGS(sentencepiece_wasm) {
	emscripten::register_vector<int>("IntVector");

	emscripten::class_<SentencePieceWASM>("SentencePieceProcessor")
		.constructor<>()
		.function("loadFromSerializedProto", &SentencePieceWASM::loadFromSerializedProto)
		.function("encodeWithOffsets", &SentencePieceWASM::encodeWithOffsets)
		.function("decodeIds", &SentencePieceWASM::decodeIds);
}
