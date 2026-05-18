#!/usr/bin/env python3
"""Mailwoman web demo backend.

Loads the v0.1.0 int8 ONNX + SentencePiece tokenizer once on startup, serves /parse + index.html.
Drop-in compatible with v0.2.0 once weights ship — just swap MODEL_PATH.
"""

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import numpy as np
import onnxruntime as ort
import sentencepiece as spm

HERE = Path(__file__).parent
MODEL_PATH = os.environ.get("MAILWOMAN_MODEL", "/data/models/quantized/model-v0.1.0-int8.onnx")
TOKENIZER_PATH = os.environ.get("MAILWOMAN_TOKENIZER", "/data/models/tokenizer/v0.1.0/tokenizer.model")
INDEX_HTML = HERE / "index.html"

LABELS = [
	"O",
	"B-country", "I-country",
	"B-region", "I-region",
	"B-locality", "I-locality",
	"B-dependent_locality", "I-dependent_locality",
	"B-postcode", "I-postcode",
	"B-subregion", "I-subregion",
	"B-cedex", "I-cedex",
]
MAX_LENGTH = 128

print(f"loading model:     {MODEL_PATH}")
session = ort.InferenceSession(MODEL_PATH, providers=["CPUExecutionProvider"])
input_names = [i.name for i in session.get_inputs()]
print(f"  inputs:          {input_names}")

print(f"loading tokenizer: {TOKENIZER_PATH}")
sp = spm.SentencePieceProcessor()
sp.Load(TOKENIZER_PATH)
PAD_ID = sp.pad_id() if sp.pad_id() >= 0 else 0
print(f"  vocab_size:      {sp.vocab_size()}, pad_id={PAD_ID}")


def softmax(x: np.ndarray) -> np.ndarray:
	e_x = np.exp(x - np.max(x, axis=-1, keepdims=True))
	return e_x / e_x.sum(axis=-1, keepdims=True)


def build_piece_spans(raw: str, pieces: list[str]) -> list[tuple[int, int]]:
	"""Reconstruct char offsets per piece by replaying the encoding against raw."""
	cursor = 0
	spans: list[tuple[int, int]] = []
	for p in pieces:
		text = p.lstrip("▁")  # SentencePiece word-boundary marker
		if not text:
			spans.append((cursor, cursor))
			continue
		idx = raw.find(text, cursor)
		if idx == -1:
			idx = cursor
		spans.append((idx, idx + len(text)))
		cursor = idx + len(text)
	return spans


def parse_address(raw: str) -> dict:
	pieces = sp.encode_as_pieces(raw)[:MAX_LENGTH]
	piece_ids = [sp.piece_to_id(p) for p in pieces]
	spans = build_piece_spans(raw, pieces)

	attn = [1] * len(piece_ids)
	while len(piece_ids) < MAX_LENGTH:
		piece_ids.append(PAD_ID)
		attn.append(0)

	ids_np = np.array([piece_ids], dtype=np.int64)
	attn_np = np.array([attn], dtype=np.int64)
	outputs = session.run(None, {input_names[0]: ids_np, input_names[1]: attn_np})
	logits = outputs[0][0]  # (max_length, num_labels)

	real_len = len(pieces)
	probs = softmax(logits[:real_len])
	pred_ids = probs.argmax(axis=-1).tolist()
	confidences = probs.max(axis=-1).tolist()

	tokens = []
	for i, (p, lid, conf) in enumerate(zip(pieces, pred_ids, confidences)):
		tokens.append({
			"piece": p,
			"char_begin": spans[i][0],
			"char_end": spans[i][1],
			"label": LABELS[lid] if 0 <= lid < len(LABELS) else "?",
			"confidence": round(float(conf), 4),
		})

	# First-occurrence-wins decoder (mirrors mailwoman_train.eval.decode_components)
	components: dict[str, str] = {}
	cur_tag: str | None = None
	cur_begin = cur_end = -1
	for tok in tokens:
		label = tok["label"]
		if label == "O":
			if cur_tag and cur_tag not in components:
				components[cur_tag] = raw[cur_begin:cur_end].strip()
			cur_tag = None
			continue
		prefix, tag = label.split("-", 1)
		if prefix == "B" or cur_tag != tag:
			if cur_tag and cur_tag not in components:
				components[cur_tag] = raw[cur_begin:cur_end].strip()
			cur_tag = tag
			cur_begin = tok["char_begin"]
			cur_end = tok["char_end"]
		else:
			cur_end = tok["char_end"]
	if cur_tag and cur_tag not in components:
		components[cur_tag] = raw[cur_begin:cur_end].strip()

	return {
		"raw": raw,
		"tokens": tokens,
		"components": components,
		"mean_confidence": round(float(np.mean(confidences)), 4),
		"model": Path(MODEL_PATH).name,
	}


class Handler(BaseHTTPRequestHandler):
	def log_message(self, format, *args):
		pass

	def _send_json(self, status: int, payload: dict):
		body = json.dumps(payload).encode("utf-8")
		self.send_response(status)
		self.send_header("Content-Type", "application/json")
		self.send_header("Content-Length", str(len(body)))
		self.end_headers()
		self.wfile.write(body)

	def do_GET(self):
		parsed = urlparse(self.path)
		if parsed.path in ("/", "/index.html"):
			try:
				body = INDEX_HTML.read_bytes()
				self.send_response(200)
				self.send_header("Content-Type", "text/html; charset=utf-8")
				self.send_header("Content-Length", str(len(body)))
				self.end_headers()
				self.wfile.write(body)
			except FileNotFoundError:
				self.send_error(500, f"missing {INDEX_HTML}")
			return
		self.send_error(404)

	def do_POST(self):
		if self.path != "/parse":
			self.send_error(404)
			return
		length = int(self.headers.get("Content-Length", 0))
		body = self.rfile.read(length).decode("utf-8")
		try:
			payload = json.loads(body)
			raw = (payload.get("text") or "").strip()
			if not raw:
				self._send_json(400, {"error": "empty text"})
				return
			self._send_json(200, parse_address(raw))
		except Exception as e:
			self._send_json(500, {"error": str(e), "type": type(e).__name__})


if __name__ == "__main__":
	port = int(os.environ.get("PORT", 8888))
	server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
	print(f"\nserving on 0.0.0.0:{port}")
	print(f"  open: http://<container-ip>:{port}/")
	server.serve_forever()
