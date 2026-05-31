#!/usr/bin/env bash
#
# Decisive-round eval — the MLM pretrained-init vs from-scratch A/B (v0.8.1).
#
# Both arms were trained at the v0.7.2-PROVEN recipe (lr 1.5e-4 constant, 100k steps,
# 1k warmup, label_smoothing 0.1, CRF off, bf16, seed 42, corpus v0.4.0, tokenizer
# v0.6.0-a0) so the comparison is at the TASK CEILING, not the under-trained basement
# that confounded the 40k round. They differ in ONE thing: the encoder init —
#   A = init_from output-v080-mlm-pretrain/checkpoints/step-020000  (MLM-pretrained)
#   B = fresh random init                                            (from scratch)
#
# Because both arms share tokenizer v0.6.0-a0 AND corpus v0.4.0, the A-vs-B F1/Acc@1
# comparison is valid (the "never compare F1 across tokenizer versions" rule is not in
# play here — same tokenizer, same corpus, single variable).
#
# Three held-out metrics, AUTO-PARSED from the runners' own JSON/MD sidecars (eval
# figures are NEVER hand-typed — see #211/#212):
#   1. resolver locality Acc@1 (PRODUCT metric, primary decision)  → oa-resolver-eval --out-md
#   2. harness v0-neural pass-rate (regression gate, secondary)    → harness-v0-neural --out-json
#   3. calibration: p90 confidence of WRONG predictions, lower=better (cal.) → probe-confidence (A vs B)
#
# Then the script AUTO-APPLIES the DeepSeek turn-4 kill-point rule and prints a VERDICT.
#
# DeepSeek kill-point rule (verbatim, 2026-05-31 consult):
#   - pretrained NOT >= scratch resolver (within +/-0.5pp) AND harness+calibration gains
#     disappear/reverse              -> DROP pretraining (v0.7.2 stays default)
#   - pretrained matches/slightly beats scratch resolver (even +0.3pp) AND retains
#     calibration/harness gains      -> SHIP with pretraining
#   - pretrained beats scratch resolver by >= 1pp -> SCALE pretrain 20k -> 100k immediately
#
# Usage:
#   scripts/eval-v081-decisive.sh                # full landing (export 100k -> download -> eval -> verdict)
#   scripts/eval-v081-decisive.sh --dry-run      # plumbing smoke: local onnx, tiny limits, NO export
#   OA_LIMIT=10000 scripts/eval-v081-decisive.sh # override resolver sample size (default 3000; dry=50)
#
# Run after `yarn compile` (the eval scripts import @mailwoman/core source via subpath).
set -uo pipefail
cd "$(dirname "$0")/.."

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

STEP=100000
STEP_PADDED=$(printf "%06d" "$STEP")
TOK=/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model
FST=/mnt/playpen/mailwoman-data/wof/fst-per-locale/fst-en-us.bin
WOF=/mnt/playpen/mailwoman-data/wof/admin-global-priority.db,/mnt/playpen/mailwoman-data/wof/postalcode-us.db
GOLDEN=data/eval/golden/v0.1.2
OA=data/eval/external/openaddresses-us-sample.jsonl
CARD=neural-weights-en-us/model-card.json   # 33-label en-us schema, shared by both arms
W=/tmp/v081-decisive
mkdir -p "$W"

# Arm definitions: NAME : modal-volume-run-dir : local-onnx-target
declare -A RUN_DIR=( [pretrained]=output-v081-ft-pretrained-s42 [scratch]=output-v081-ft-scratch-s42 )
ARMS=(pretrained scratch)

if [ "$DRY" = "1" ]; then
  OA_LIMIT="${OA_LIMIT:-50}"
  GOLDEN_LIMIT=200
  echo "########## DRY RUN (plumbing smoke) — local v0.5.3 onnx, OA_LIMIT=$OA_LIMIT, NO export ##########"
  # Point both "arms" at the locally-present onnx just to exercise the eval invocations.
  LOCAL_ONNX=$(readlink -f neural-weights-en-us/model.onnx)
  for a in "${ARMS[@]}"; do cp "$LOCAL_ONNX" "$W/$a.onnx"; done
else
  OA_LIMIT="${OA_LIMIT:-3000}"
  GOLDEN_LIMIT=100000
  echo "########## DECISIVE ROUND — export step-$STEP, OA_LIMIT=$OA_LIMIT ##########"
  for a in "${ARMS[@]}"; do
    echo "=========== export $a step-$STEP -> ONNX (Modal) ==========="
    modal run scripts/modal/train_remote.py::export_onnx \
      --output-dir="/data/${RUN_DIR[$a]}" --step="$STEP_PADDED" \
      --tokenizer-path=/data/models/tokenizer/v0.6.0-a0/tokenizer.model 2>&1 | tail -4
    echo "--- download $a model.onnx ---"
    modal volume get mailwoman-training "${RUN_DIR[$a]}/model.onnx" "$W/$a.onnx" --force 2>&1 | tail -1
    ls -la "$W/$a.onnx" || { echo "FATAL: $a onnx missing"; exit 1; }
  done
fi

# ---- metric 1: harness v0-neural (exact pass-rate from JSON) ----
for a in "${ARMS[@]}"; do
  echo "=========== [harness] $a ==========="
  node --experimental-strip-types scripts/harness-v0-neural.ts \
    --tests mailwoman/test --falsehoods data/eval/falsehoods \
    --model "$W/$a.onnx" --tokenizer "$TOK" --model-card "$CARD" \
    --admin-fst "$FST" --postcode-repair \
    --out-json "$W/harness-$a.json" > "$W/harness-$a.md" 2>"$W/harness-$a.stderr" \
    && echo "  ok -> $W/harness-$a.json" || echo "  harness $a FAILED (see $W/harness-$a.stderr)"
done

# ---- metric 2: resolver locality Acc@1 (PRODUCT metric, from --out-md) ----
for a in "${ARMS[@]}"; do
  echo "=========== [resolver Acc@1] $a (OA limit=$OA_LIMIT) ==========="
  node --experimental-strip-types scripts/eval/oa-resolver-eval.ts \
    --eval "$OA" --limit "$OA_LIMIT" \
    --model "$W/$a.onnx" --tokenizer "$TOK" --model-card "$CARD" \
    --wof "$WOF" --out-md "$W/resolver-$a.md" 2>"$W/resolver-$a.stderr" \
    && echo "  ok -> $W/resolver-$a.md" || echo "  resolver $a FAILED (see $W/resolver-$a.stderr)"
done

# ---- metric 3: calibration (wrong@>=0.9), A vs B in one probe run ----
echo "=========== [calibration] pretrained (A) vs scratch (B) ==========="
node --experimental-strip-types scripts/probe-confidence.ts \
  --model-a "$W/pretrained.onnx" --name-a v0.8.1-pretrained \
  --model-b "$W/scratch.onnx"    --name-b v0.8.1-scratch \
  --tokenizer "$TOK" --model-card "$CARD" --golden "$GOLDEN" --limit "$GOLDEN_LIMIT" \
  > "$W/calibration.md" 2>"$W/calibration.stderr" \
  && echo "  ok -> $W/calibration.md" || echo "  calibration FAILED (see $W/calibration.stderr)"

# ---- synthesis: parse sidecars, build table, auto-apply kill-point rule ----
echo "=========== VERDICT ==========="
python3 - "$W" "$DRY" <<'PY'
import json, re, sys, os
W, DRY = sys.argv[1], sys.argv[2] == "1"

def harness_pass(arm):
    p = f"{W}/harness-{arm}.json"
    if not os.path.exists(p): return None
    rows = json.load(open(p))
    if not rows: return None
    return 100.0 * sum(1 for r in rows if r.get("neural_pass")) / len(rows)

def resolver_loc(arm):
    # parse the neural row from the --out-md table: | Neural | <loc%> | <reg%> | ...
    p = f"{W}/resolver-{arm}.md"
    if not os.path.exists(p): return None
    for line in open(p):
        # md row is: | **neural** | <loc%> | <reg%> | ...  (lowercase, bold)
        if re.match(r"\s*\|\s*\*{0,2}neural\b", line, re.I):
            m = re.findall(r"([\d.]+)%", line)
            if m: return float(m[0])  # first % column = locality-match
    return None

def cal_wrong_p90(name):
    # probe prints a 'wrong (...)' line per model; capture the p90 confidence of that bucket
    # under the named model's section (see anchoring note below).
    p = f"{W}/calibration.md"
    if not os.path.exists(p): return None
    txt = open(p).read()
    # anchor on the '### <name>' PER-BUCKET section heading (not the bare name, which
    # also appears in the '**Model B:**' header above the sections), then the next
    # 'wrong (...) ... p90=<v>' line. This is the 90th-PERCENTILE confidence of the WRONG-
    # prediction bucket (lower = better calibrated) — NOT a "fraction at >=0.9".
    idx = txt.find("### " + name)
    seg = txt[idx:] if idx >= 0 else txt
    m = re.search(r"wrong[^\n]*p90=([\d.]+)", seg)
    return float(m.group(1)) if m else None

A = {"resolver": resolver_loc("pretrained"), "harness": harness_pass("pretrained"),
     "cal": cal_wrong_p90("v0.8.1-pretrained")}
B = {"resolver": resolver_loc("scratch"),    "harness": harness_pass("scratch"),
     "cal": cal_wrong_p90("v0.8.1-scratch")}

def f(x): return "  n/a " if x is None else f"{x:6.2f}"
print()
print("| metric                       | A pretrained | B scratch | A-B delta | v0.7.2 ref |")
print("|------------------------------|--------------|-----------|-----------|------------|")
def row(lbl, key, ref, better_high):
    a, b = A[key], B[key]
    d = "  n/a " if (a is None or b is None) else f"{a-b:+6.2f}"
    print(f"| {lbl:28} | {f(a)}      | {f(b)}    | {d}    | {ref:>10} |")
row("resolver locality Acc@1 (%)", "resolver", "96.1", True)
row("harness pass-rate (%)",       "harness",  "19.5", True)
row("wrong-pred conf p90 (cal.)",  "cal",      "—",    False)  # p90 conf of WRONG preds, lower=better
print()
# v0.7.2 reference numbers cited from docs/articles/evals/2026-05-30-v0.7.2-eval.md
print("ref column = shipped v0.7.2 (cited from docs/articles/evals/2026-05-30-v0.7.2-eval.md)")

if DRY:
    print("\n[DRY RUN] plumbing only — numbers above are the local v0.5.3 onnx on tiny limits, NOT a verdict.")
    sys.exit(0)

# --- kill-point rule (DeepSeek turn-4) ---
ar, br = A["resolver"], B["resolver"]
ah, bh = A["harness"], B["harness"]
ac, bc = A["cal"], B["cal"]
if None in (ar, br):
    print("\nVERDICT: INCONCLUSIVE — resolver metric missing for an arm; inspect sidecars in", W)
    sys.exit(0)
gap = ar - br
# do secondary (harness+calibration) gains persist for pretrained vs scratch?
harness_gain = (ah is not None and bh is not None and ah >= bh)
cal_gain     = (ac is not None and bc is not None and ac <= bc)  # lower wrong-pred-conf p90 is better-calibrated
gains_hold   = harness_gain and cal_gain
print()
if gap >= 1.0:
    print(f"VERDICT: SCALE PRETRAIN — pretrained beats scratch resolver by {gap:+.2f}pp (>= +1.0pp).")
    print("         Action: scale MLM pretrain 20k -> 100k and re-run this A/B.")
elif gap >= -0.5:
    if gains_hold:
        print(f"VERDICT: SHIP WITH PRETRAINING — resolver within band ({gap:+.2f}pp) AND "
              f"harness/calibration gains hold (harness A>=B={harness_gain}, cal A<=B={cal_gain}).")
    else:
        print(f"VERDICT: MARGINAL — resolver within band ({gap:+.2f}pp) but secondary gains do NOT "
              f"both hold (harness A>=B={harness_gain}, cal A<=B={cal_gain}). Escalate to DeepSeek turn-5.")
else:
    if not gains_hold:
        print(f"VERDICT: DROP PRETRAINING — pretrained trails scratch resolver by {gap:+.2f}pp (< -0.5pp) "
              f"AND secondary gains don't hold. v0.7.2 stays default.")
    else:
        print(f"VERDICT: CONFLICTED — resolver worse ({gap:+.2f}pp) but secondary gains hold. "
              f"Escalate to DeepSeek turn-5 with full table.")
print(f"\nAll sidecars + full markdown reports in {W}/")
PY
echo "=========== DONE — artifacts in $W ==========="
