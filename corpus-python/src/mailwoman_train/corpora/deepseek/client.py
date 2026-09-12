"""Talking to the API, and checking what comes back.

Every generated row passes `validate_components` before it is written: the surface-form invariant
(each component value is an exact substring of the raw address) is the ONE guarantee a synthetic
row carries, and a model that violates it produces a row that trains a span pointing at nothing.
"""

from __future__ import annotations

import hashlib
import json
import time
import urllib.error
import urllib.request
from typing import Any

from ...env import private

API_URL = "https://api.deepseek.com/v1/chat/completions"
DEFAULT_MODEL = "deepseek-v4-flash"
LICENSE_LABEL = "Synthetic (DeepSeek-v4-flash, AGPL-compatible)"


def require_api_key() -> str:
    """The DeepSeek key, or a refusal naming the variable.

    Every generation call needs it, so failing at the first prompt rather than after the seeds are
    loaded keeps the message next to the cause.
    """
    api_key = private().deepseek_api_key
    if not api_key:
        raise RuntimeError("DEEPSEEK_API_KEY is not set; generation needs it")
    return api_key


def deepseek_call(body: dict[str, Any], api_key: str, max_retries: int = 5) -> dict[str, Any]:
    """POST one chat-completion. Retries 429/5xx with exponential backoff."""
    backoff = 2.0
    last_exc: Exception | None = None
    for _attempt in range(max_retries):
        req = urllib.request.Request(
            API_URL,
            data=json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:  # nosec B310 — the API base is a constant https URL
                payload: dict[str, Any] = json.loads(resp.read())
                return payload
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504):
                last_exc = e
                time.sleep(backoff)
                backoff *= 1.5
                continue
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last_exc = e
            time.sleep(backoff)
            backoff *= 1.5
    raise RuntimeError(f"DeepSeek call failed after {max_retries} retries: {last_exc}")


def parse_jsonl_response(content: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for ln in (content or "").splitlines():
        ln = ln.strip()
        if not ln:
            continue
        if ln.startswith("```"):
            continue
        if not ln.startswith("{"):
            continue
        try:
            out.append(json.loads(ln))
        except json.JSONDecodeError:
            continue
    return out


def validate_components(raw: str, comps: dict[str, str]) -> tuple[bool, str | None]:
    """Substring-match validation. Returns (ok, reason_if_not_ok)."""
    if not isinstance(comps, dict) or not comps:
        return False, "no-components"
    for tag, val in comps.items():
        if not isinstance(val, str) or not val:
            return False, f"empty-component:{tag}"
        if val not in raw:
            return False, f"not-in-raw:{tag}"
    if not raw or len(raw) > 250:
        return False, "raw-length"
    return True, None


def deterministic_id(prefix: str, payload: str) -> str:
    h = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]
    return f"{prefix}-{h}"
