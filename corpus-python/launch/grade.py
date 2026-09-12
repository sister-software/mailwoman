"""Scoring a trained checkpoint on the GPU: per-tag readouts and feature ON/OFF contrasts.

    modal run -m launch.train_remote::eval_de --output-dir=… --step=…
    modal run -m launch.train_remote::grade_street_type_contrast --step=3000
    modal run -m launch.train_remote::grade_evidence_bundle --step=3000 --zero=both

These run in the training image because the model does. A contrast forwards the SAME checkpoint
twice — once with a channel as computed, once with it zeroed — so the difference is the channel and
not a second training run; that is the only shape in which a feature's contribution is readable
without a second GPU spend.
"""

from __future__ import annotations

from typing import Any

from .app import BUCKET, VOL_MOUNT, app, r2_secret, training_image, vol


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    gpu="A100",
    timeout=3600,
    memory=32768,
)
def diagnose_suffix_plasticity(
    learning_rate: float = 1.0e-5,
    max_steps: int = 2000,
    name: str = "ewc-off-lr1e5-2k",
) -> None:
    """Non-candidate #1569 plasticity probe: v4.3.1 with EWC disabled.

    This is diagnostic evidence only, never a third promotion attempt. It holds the corrected corpus,
    initialization, optimizer family, batch size and model geometry fixed; disables EWC, uses a constant
    learning rate so a short probe does not disappear into a cosine tail, and saves every 500 steps.
    """
    import sys

    vol.reload()
    sys.path.insert(0, f"{VOL_MOUNT}/corpus-python/src")

    from mailwoman_train.config import load_config
    from mailwoman_train.train.trainer import train as run_train

    config_path = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train/configs/v4.3.1-suffix-boundary-target-dose-8k.yaml"
    cfg = load_config(config_path)
    cfg.train.ewc_lambda = 0.0
    cfg.train.ewc_fisher_path = ""
    cfg.train.ewc_reference = ""
    cfg.train.learning_rate = float(learning_rate)
    cfg.train.max_steps = int(max_steps)
    cfg.train.lr_schedule = "constant"
    cfg.train.eval_every_steps = 500
    cfg.train.save_every_steps = 500
    cfg.train.output_dir = f"{VOL_MOUNT}/diagnostic-v431-suffix-{name}/checkpoints"
    cfg.train.csv_log_path = f"{VOL_MOUNT}/diagnostic-v431-suffix-{name}/train_log.csv"
    cfg.train.trackio_enabled = False
    cfg.train.trackio_run_name = f"diagnostic-v431-suffix-{name}"

    print("NON-CANDIDATE #1569 PLASTICITY DIAGNOSTIC")
    print(f"  EWC lambda: {cfg.train.ewc_lambda}")
    print(f"  learning rate: {cfg.train.learning_rate}")
    print(f"  schedule: {cfg.train.lr_schedule}")
    print(f"  max steps: {cfg.train.max_steps}")
    print(f"  output: {cfg.train.output_dir}")
    run_train(cfg)
    vol.commit()
    print("Diagnostic complete; artifact is NOT promotion-eligible.")


@app.function(
    volumes={VOL_MOUNT: vol},
    image=training_image,
    timeout=900,
)
def eval_de(
    output_dir: str,
    step: str,
    anchor_lookup: str = "",
    anchor_off: bool = False,
    val_path: str = "/data/corpus/versioned/v0.4.1-de/corpus-v0.4.1-de/val/part-german-val.parquet",
    tokenizer_path: str = "/data/models/tokenizer/v0.6.0-a0/tokenizer.model",
    max_rows: int = 4000,
) -> None:
    """DE-locality readout for the anchor pilot (#239/#240): per-tag PARSER F1 on the German val for
    one checkpoint. The German collapse shows as a low locality/postcode F1 (with street/house# up);
    the anchor fix as a recovered locality. ``anchor_lookup`` set → feed the real anchor;
    ``anchor_off=True`` → feed the features but force confidence 0 (the anchor-free degradation check).
    Forwards + argmax (CRF weight is 0, so the trained signal is in the emissions)."""
    import sys
    from pathlib import Path

    vol.reload()
    sys.path.insert(0, f"{VOL_MOUNT}/corpus-python/src")
    import pyarrow.parquet as pq
    import torch

    from mailwoman_train.data.loader import load_anchor_lookup
    from mailwoman_train.evaluation.metrics import token_f1
    from mailwoman_train.labels import ACTIVE_BIO_LABELS
    from mailwoman_train.nn.encoder import MailwomanCoarseEncoder
    from mailwoman_train.tokenizer import Tokenizer, encode_row

    ck = Path(f"{output_dir}/checkpoints/step-{step}")
    tok = Tokenizer(Path(tokenizer_path))
    _orig = torch.load
    torch.load = lambda *a, **kw: _orig(*a, **{**kw, "map_location": "cpu"})
    model = MailwomanCoarseEncoder.from_pretrained(ck).eval()
    torch.load = _orig
    lookup = load_anchor_lookup(anchor_lookup) if anchor_lookup else None

    rows = pq.read_table(val_path).to_pylist()[:max_rows]
    all_preds, all_labels = [], []
    B = 128
    for i in range(0, len(rows), B):
        chunk = rows[i : i + B]
        ids, masks, labs, afeats, aconfs = [], [], [], [], []
        for r in chunk:
            enc = encode_row(tok, r["raw"], r["tokens"], r["labels"], 128, anchor_lookup=lookup)
            ids.append(enc["input_ids"])
            masks.append(enc["attention_mask"])
            labs.append(enc["labels"])
            if lookup:
                afeats.append(enc["anchor_features"])
                aconfs.append([0.0] * 128 if anchor_off else enc["anchor_confidence"])
        kw = {}
        if lookup:
            kw = {
                "anchor_features": torch.tensor(afeats, dtype=torch.float32),
                "anchor_confidence": torch.tensor(aconfs, dtype=torch.float32),
            }
        with torch.no_grad():
            out = model(torch.tensor(ids), attention_mask=torch.tensor(masks), **kw)
        all_preds.append(out.logits.argmax(-1))
        all_labels.append(torch.tensor(labs))

    preds = torch.cat(all_preds)
    labels = torch.cat(all_labels)
    m = token_f1(preds, labels, num_labels=len(ACTIVE_BIO_LABELS))

    def g(t: str) -> float:
        return m.get(f"f1_tag.{t}", float("nan"))

    mode = "anchor-OFF" if (anchor_off or not lookup) else "anchor-ON "
    print(
        f"[DE eval] {ck.name} {mode}: locality={g('locality'):.3f}  postcode={g('postcode'):.3f}  "
        f"region={g('region'):.3f}  street={g('street'):.3f}  house_number={g('house_number'):.3f}  "
        f"macro_f1={m.get('macro_f1', float('nan')):.3f}  (n={len(rows)})"
    )


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    secrets=[r2_secret],
    timeout=1800,
)
def grade_street_type_contrast(step: int = 3000, show_flips: str = "", heal: bool = False, case: str = "asis") -> None:
    """P-A VERDICT (ROAD_TO_MAILWOMAN_V8_1_0 §4 — Option A). The street_type feature ON/OFF contrast on
    the SAME retrained checkpoint — the clean, fully-controlled read of "does street-type INPUT evidence
    improve street<->locality discrimination." For each ban-fragments-fr row we build the FULL feature
    set (anchor + gazetteer + country + street_type, faithful to training) via encode_row, run forward
    TWICE (street_type_features as-computed, then zeroed), argmax-decode the street span, and compare to
    the gold street. The ON-OFF street-match delta per class is the verdict; the P-C classes (admin-
    street-homonym / bare-street / street-particle) are where the evidence hypothesis lives."""
    import json
    import subprocess
    import sys
    from pathlib import Path

    import torch

    sys.path.insert(0, f"{VOL_MOUNT}/corpus-python/src")
    from mailwoman_train.data.loader import load_anchor_lookup
    from mailwoman_train.features.country_lexicon import load_country_lexicon
    from mailwoman_train.features.gazetteer_anchor import load_gazetteer_lexicon
    from mailwoman_train.labels import ID_TO_LABEL
    from mailwoman_train.nn.encoder import MailwomanCoarseEncoder
    from mailwoman_train.tokenizer import Tokenizer, encode_row

    vol.reload()
    # Pull the fixture from R2 (self-contained + re-runnable).
    R = "--low-level-retries 30 --retries 8"
    subprocess.run(  # noqa: S602
        f"rclone copy :s3:{BUCKET}/eval/fixtures/ban-fragments-fr.jsonl {VOL_MOUNT}/eval/fixtures/ {R}",
        shell=True,
        check=True,
        capture_output=True,
    )
    fixture = f"{VOL_MOUNT}/eval/fixtures/ban-fragments-fr.jsonl"

    ck = Path(f"{VOL_MOUNT}/output-v3150-street-type-s42/checkpoints/step-{step:06d}")
    tok = Tokenizer(Path(f"{VOL_MOUNT}/models/tokenizer/v0.9.0-multisplice/tokenizer.model"))
    model = MailwomanCoarseEncoder.from_pretrained(ck).eval()
    print(f"loaded checkpoint step-{step}; use_street_type_anchor={model.use_street_type_anchor}")

    gaz = load_gazetteer_lexicon(f"{VOL_MOUNT}/gazetteer/anchor-lexicon-v1.json")
    ctry = load_country_lexicon(f"{VOL_MOUNT}/gazetteer/country-surface-lexicon-v1.json")
    street = load_gazetteer_lexicon(f"{VOL_MOUNT}/gazetteer/street-type-lexicon-v1.json")
    anchor = load_anchor_lookup(f"{VOL_MOUNT}/anchor/pilot-anchor-lookup.json")

    STREET_TAGS = {"street", "street_prefix", "street_suffix", "street_prefix_particle"}

    def norm(s: str) -> str:
        return " ".join(s.lower().split())

    def predicted_street(raw: str, feats: dict[str, Any], zero_street: bool) -> str:
        pieces = tok.encode_with_spans(raw)
        n = len(pieces)
        kw = dict(
            input_ids=torch.tensor([feats["input_ids"][:n]]),
            attention_mask=torch.tensor([feats["attention_mask"][:n]]),
        )
        for ch in ("anchor", "gazetteer", "country", "street_type"):
            fk, ck_ = f"{ch}_features", f"{ch}_confidence"
            if fk in feats:
                fv = [[0.0] * len(feats[fk][0])] * n if (ch == "street_type" and zero_street) else feats[fk][:n]
                cv = [0.0] * n if (ch == "street_type" and zero_street) else feats[ck_][:n]
                kw[fk] = torch.tensor([fv], dtype=torch.float32)
                kw[ck_] = torch.tensor([cv], dtype=torch.float32)
        with torch.no_grad():
            logits = model(**kw).logits[0]
        ids = logits.argmax(-1).tolist()
        # group contiguous street-family pieces -> surface via char spans
        chars = [False] * len(raw)
        for i, pid in enumerate(ids):
            if i >= n:
                break
            tag = ID_TO_LABEL[pid]
            fam = tag[2:] if tag[:2] in ("B-", "I-") else tag
            if fam in STREET_TAGS:
                for c in range(pieces[i].char_begin, pieces[i].char_end):
                    if c < len(raw):
                        chars[c] = True
        if heal:
            # heal-approx (production enforceWordConsistency's core): per whitespace word, majority
            # char vote on street-membership — arbitrates the mid-word piece truncations the raw
            # argmax leaves behind. NOT the full TS heal (no punctuation-separator/byte checks);
            # labeled heal-approx in every report.
            import re as _re

            for m in _re.finditer(r"\S+", raw):
                seg = chars[m.start() : m.end()]
                vote = sum(seg) * 2 >= len(seg)
                for c in range(m.start(), m.end()):
                    chars[c] = vote
        out, run = [], []
        for c in range(len(raw)):
            if chars[c]:
                run.append(raw[c])
            elif run:
                out.append("".join(run))
                run = []
        if run:
            out.append("".join(run))
        return norm(" ".join(out))

    rows = [json.loads(ln) for ln in open(fixture, encoding="utf-8") if ln.strip()]
    by: dict[str, list[int]] = {}  # klass -> [on_correct, off_correct, n]
    for r in rows:
        raw = r["input"]
        gs = r.get("expect", {}).get("street")
        gold = norm(" ".join(gs)) if isinstance(gs, list) else norm(gs or "")
        expect_no_street = not gold
        feats = encode_row(
            tok,
            raw,
            raw.split(),
            ["O"] * len(raw.split()),
            max_length=128,
            anchor_lookup=anchor,
            anchor_paint_mode="shaped",
            gazetteer_lexicon=gaz,
            gazetteer_choreography=True,
            country_lexicon=ctry,
            street_type_lexicon=street,
        )
        on = predicted_street(raw, feats, zero_street=False)
        off = predicted_street(raw, feats, zero_street=True)
        ok_on = (on == "") if expect_no_street else (on == gold)
        ok_off = (off == "") if expect_no_street else (off == gold)
        k = r.get("klass", "?")
        agg = by.setdefault(k, [0, 0, 0])
        agg[0] += int(ok_on)
        agg[1] += int(ok_off)
        agg[2] += 1
        if show_flips and k == show_flips and ok_on != ok_off:
            print(f"FLIP[{'ON-wins' if ok_on else 'OFF-wins'}] {raw!r} gold={gold!r} on={on!r} off={off!r}")

    print(f"\n=== P-A VERDICT: street_type ON vs OFF — ban-fragments-fr (step-{step}) ===")
    print(f"{'klass':<24} {'ON':>7} {'OFF':>7} {'delta':>11}")
    tot_on = tot_off = tot_n = 0
    for k in sorted(by):
        on_c, off_c, n = by[k]
        tot_on += on_c
        tot_off += off_c
        tot_n += n
        print(f"{k:<24} {on_c / n:>7.3f} {off_c / n:>7.3f} {(on_c - off_c) / n:>+11.3f}")
    print(f"{'ALL':<24} {tot_on / tot_n:>7.3f} {tot_off / tot_n:>7.3f} {(tot_on - tot_off) / tot_n:>+11.3f}")
    print("\ndelta > 0 => street_type input evidence improves street<->locality discrimination (Option A live).")


@app.function(
    image=training_image,
    volumes={VOL_MOUNT: vol},
    secrets=[r2_secret],
    timeout=1800,
)
def grade_evidence_bundle(
    step: int = 3000,
    zero: str = "both",
    run: str = "v3160-evidence-bundle",
    lexicon: str = "locality-surface-lexicon-v1.json",
    street_lexicon: str = "street-type-lexicon-v1.json",
    show_flips: str = "",
    case: str = "asis",
    heal: bool = False,
    fixture: str = "ban-fragments-fr.jsonl",
) -> None:
    """v3.16.0 VERDICT — the bundle ON/OFF contrast on the SAME checkpoint. ON = all channels as
    computed (anchor/gazetteer/country/street_type/locality_surface); OFF = the two BUNDLE channels
    zeroed (the ablation column — pre-registered leg 3 compares it to v385's P0 fixture numbers).
    Same scoring as grade_street_type_contrast."""
    import json
    import subprocess
    import sys
    from pathlib import Path

    import torch

    sys.path.insert(0, f"{VOL_MOUNT}/corpus-python/src")
    from mailwoman_train.data.loader import load_anchor_lookup
    from mailwoman_train.features.country_lexicon import load_country_lexicon
    from mailwoman_train.features.gazetteer_anchor import load_gazetteer_lexicon
    from mailwoman_train.labels import ID_TO_LABEL
    from mailwoman_train.nn.encoder import MailwomanCoarseEncoder
    from mailwoman_train.tokenizer import Tokenizer, encode_row

    vol.reload()
    R = "--low-level-retries 30 --retries 8"
    subprocess.run(  # noqa: S602
        f"rclone copy :s3:{BUCKET}/eval/fixtures/ban-fragments-fr.jsonl {VOL_MOUNT}/eval/fixtures/ {R}",
        shell=True,
        check=True,
        capture_output=True,
    )
    # G8 (run-2 ladder): --fixture points the same instrument at overture-fragments-de.jsonl.
    fixture = f"{VOL_MOUNT}/eval/fixtures/{fixture}"

    ck = Path(f"{VOL_MOUNT}/output-{run}-s42/checkpoints/step-{step:06d}")
    tok = Tokenizer(Path(f"{VOL_MOUNT}/models/tokenizer/v0.9.0-multisplice/tokenizer.model"))
    model = MailwomanCoarseEncoder.from_pretrained(ck).eval()
    print(
        f"loaded step-{step}; street_type={model.use_street_type_anchor} locality_surface={model.use_locality_surface_anchor}"
    )

    gaz = load_gazetteer_lexicon(f"{VOL_MOUNT}/gazetteer/anchor-lexicon-v1.json")
    ctry = load_country_lexicon(f"{VOL_MOUNT}/gazetteer/country-surface-lexicon-v1.json")
    street = load_gazetteer_lexicon(f"{VOL_MOUNT}/gazetteer/{street_lexicon}")
    locality = load_gazetteer_lexicon(f"{VOL_MOUNT}/gazetteer/{lexicon}")
    anchor = load_anchor_lookup(f"{VOL_MOUNT}/anchor/pilot-anchor-lookup.json")

    STREET_TAGS = {"street", "street_prefix", "street_suffix", "street_prefix_particle"}
    # Channel attribution (`zero`): which channels the OFF column zeroes — both | street | locality | none.
    BUNDLE = {
        "both": ("street_type", "locality_surface"),
        "street": ("street_type",),
        "locality": ("locality_surface",),
        "none": (),
    }[zero]

    def norm(s: str) -> str:
        return " ".join(s.lower().split())

    def predicted_street(raw: str, feats: dict[str, Any], zero_bundle: bool) -> str:
        pieces = tok.encode_with_spans(raw)
        n = len(pieces)
        kw = dict(
            input_ids=torch.tensor([feats["input_ids"][:n]]),
            attention_mask=torch.tensor([feats["attention_mask"][:n]]),
        )
        # Model-capability-aware feeding: a channel is fed only when THIS model carries it — the
        # v385 reference row (no bundle channels) grades through the SAME instrument without raising.
        has = {
            "anchor": getattr(model, "use_postcode_anchor", False),
            "gazetteer": getattr(model, "use_gazetteer_anchor", False),
            "country": getattr(model, "use_country_anchor", False),
            "street_type": getattr(model, "use_street_type_anchor", False),
            "locality_surface": getattr(model, "use_locality_surface_anchor", False),
        }
        for ch in ("anchor", "gazetteer", "country", "street_type", "locality_surface"):
            fk, ckk = f"{ch}_features", f"{ch}_confidence"
            if fk in feats and has[ch]:
                zero = zero_bundle and ch in BUNDLE
                fv = [[0.0] * len(feats[fk][0])] * n if zero else feats[fk][:n]
                cv = [0.0] * n if zero else feats[ckk][:n]
                kw[fk] = torch.tensor([fv], dtype=torch.float32)
                kw[ckk] = torch.tensor([cv], dtype=torch.float32)
        with torch.no_grad():
            logits = model(**kw).logits[0]
        ids = logits.argmax(-1).tolist()
        chars = [False] * len(raw)
        for i, pid in enumerate(ids):
            if i >= n:
                break
            tag = ID_TO_LABEL[pid]
            fam = tag[2:] if tag[:2] in ("B-", "I-") else tag
            if fam in STREET_TAGS:
                for c in range(pieces[i].char_begin, pieces[i].char_end):
                    if c < len(raw):
                        chars[c] = True
        if heal:
            # heal-approx (production enforceWordConsistency's core): per whitespace word, majority
            # char vote on street-membership — arbitrates the mid-word piece truncations the raw
            # argmax leaves behind. NOT the full TS heal (no punctuation-separator/byte checks);
            # labeled heal-approx in every report.
            import re as _re

            for m in _re.finditer(r"\S+", raw):
                seg = chars[m.start() : m.end()]
                vote = sum(seg) * 2 >= len(seg)
                for c in range(m.start(), m.end()):
                    chars[c] = vote
        out, run = [], []
        for c in range(len(raw)):
            if chars[c]:
                run.append(raw[c])
            elif run:
                out.append("".join(run))
                run = []
        if run:
            out.append("".join(run))
        return norm(" ".join(out))

    rows = [json.loads(ln) for ln in open(fixture, encoding="utf-8") if ln.strip()]
    by: dict[str, list[int]] = {}
    for r in rows:
        raw = r["input"]
        # Case variant (`case`): lower = production passthrough for uncapitalized users; upper = raw
        # all-caps (production would title-case via normalizeCase first — this is the worst case).
        if case == "lower":
            raw = raw.lower()
        elif case == "upper":
            raw = raw.upper()
        gs = r.get("expect", {}).get("street")
        gold = norm(" ".join(gs)) if isinstance(gs, list) else norm(gs or "")
        expect_no_street = not gold
        feats = encode_row(
            tok,
            raw,
            raw.split(),
            ["O"] * len(raw.split()),
            max_length=128,
            anchor_lookup=anchor,
            anchor_paint_mode="shaped",
            gazetteer_lexicon=gaz,
            gazetteer_choreography=True,
            country_lexicon=ctry,
            street_type_lexicon=street,
            locality_surface_lexicon=locality,
        )
        on = predicted_street(raw, feats, zero_bundle=False)
        off = predicted_street(raw, feats, zero_bundle=True)
        ok_on = (on == "") if expect_no_street else (on == gold)
        ok_off = (off == "") if expect_no_street else (off == gold)
        k = r.get("klass", "?")
        agg = by.setdefault(k, [0, 0, 0])
        agg[0] += int(ok_on)
        agg[1] += int(ok_off)
        agg[2] += 1
        if show_flips and k == show_flips and ok_on != ok_off:
            print(f"FLIP[{'ON-wins' if ok_on else 'OFF-wins'}] {raw!r} gold={gold!r} on={on!r} off={off!r}")

    print(
        f"\n=== v3.16.0 BUNDLE: ON vs OFF(zero={zero}, case={case}, heal={heal}) — ban-fragments-fr (step-{step}) ==="
    )
    print(f"{'klass':<24} {'ON':>7} {'OFF':>7} {'delta':>11}")
    tot_on = tot_off = tot_n = 0
    for k in sorted(by):
        on_c, off_c, n = by[k]
        tot_on += on_c
        tot_off += off_c
        tot_n += n
        print(f"{k:<24} {on_c / n:>7.3f} {off_c / n:>7.3f} {(on_c - off_c) / n:>+11.3f}")
    print(f"{'ALL':<24} {tot_on / tot_n:>7.3f} {tot_off / tot_n:>7.3f} {(tot_on - tot_off) / tot_n:>+11.3f}")
    print(
        "\nP0 fixture refs for the ablation leg (v385): homonym 159/400, bare-street 241/400, particle 301/400, alnum-hn 373/400, street-hn 373/400, bare-locality 393/400, date-name 53/400."
    )
