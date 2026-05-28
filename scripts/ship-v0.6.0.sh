#!/usr/bin/env bash
# Pre-staged v0.6.0 release pipeline.
#
# Runs after Modal training completes. Steps:
#  1. Export ONNX from Modal volume
#  2. Quantize int8 (and fp16 optional)
#  3. Link as dev weights, run demo presets + error analysis
#  4. Upload to HF model repo + HF bucket
#  5. Update releases.json
#
# Set MAILWOMAN_V060_STEP env var to a specific step (default: 100000).
set -euo pipefail

STEP="${MAILWOMAN_V060_STEP:-100000}"
PLAYPEN_QUANT="/mnt/playpen/mailwoman-data/models/quantized"
PLAYPEN_TOKENIZER="/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model"
HF_TOKEN="$(grep '^HF_TOKEN=' "$HOME/Projects/playpen/.env.host" | cut -d= -f2-)"
export HF_TOKEN

echo "=== Ship v0.6.0 step-$STEP ==="

# 1. Export ONNX on Modal
echo "→ Exporting ONNX..."
MAILWOMAN_EXPORT_OUTPUT_DIR=/data/output-v060 \
  MAILWOMAN_EXPORT_STEP=$STEP \
  MAILWOMAN_EXPORT_TOKENIZER=/data/models/tokenizer/v0.6.0-a0/tokenizer.model \
  modal run scripts/modal/train_remote.py::export_onnx 2>&1 | tail -5

# 2. Download fp32 + quantize
echo "→ Downloading fp32..."
modal volume get mailwoman-training output-v060/model.onnx /tmp/model-v060-fp32.onnx --force 2>&1 | tail -1
ls -lh /tmp/model-v060-fp32.onnx

echo "→ Quantizing int8..."
python3 -c "
from onnxruntime.quantization import quantize_dynamic, QuantType
import os, time
src = '/tmp/model-v060-fp32.onnx'
dst = '$PLAYPEN_QUANT/model-v060-step-$STEP-int8.onnx'
t0 = time.time()
quantize_dynamic(src, dst, weight_type=QuantType.QUInt8)
print(f'Done in {time.time()-t0:.1f}s: {os.path.getsize(dst) / 1024 / 1024:.1f} MB')
"

# 3. Link as dev weights + run presets
echo "→ Linking dev weights..."
MAILWOMAN_DEV_MODEL="$PLAYPEN_QUANT/model-v060-step-$STEP-int8.onnx" \
  MAILWOMAN_DEV_TOKENIZER="$PLAYPEN_TOKENIZER" \
  bash /home/lab/Projects/mailwoman/neural-weights-en-us/scripts/link-dev-weights.sh 2>&1 | tail -3

echo "→ Running demo presets..."
cd /home/lab/Projects/mailwoman
node -e "
import { NeuralAddressClassifier } from '@mailwoman/neural'
import { decodeAsJson } from '@mailwoman/core/decoder'
const c = await NeuralAddressClassifier.loadFromWeights()
const presets = [
  '1600 Pennsylvania Avenue NW, Washington, DC 20500',
  '350 5th Ave, New York, NY 10118',
  'Pier 39, San Francisco, CA 94133',
  '1060 W Addison St, Chicago, IL 60613',
  '400 Broad St, Seattle, WA 98109',
  '90210',
  'PO Box 123, Burlington, VT 05401',
  'P.O. Box 456, Bozeman, MT 59715',
  '100 Main St PMB 200, Berkeley, CA 94704',
]
let pass = 0
for (const a of presets) {
  const t = await c.parse(a)
  const p = decodeAsJson(t)
  console.log(a)
  console.log('  ', JSON.stringify(p))
  if (Object.keys(p).length > 0) pass++
}
console.log()
console.log('PRESETS:', pass + '/' + presets.length)
"

echo "→ Running error analysis..."
node --experimental-strip-types scripts/eval-error-analysis.ts --golden data/eval/golden/v0.1.2 > /tmp/v060-error-analysis.md
head -30 /tmp/v060-error-analysis.md

echo "=== Done. Manual steps remaining: ==="
echo "  1. Create model-card.json with eval results"
echo "  2. Upload to sister-software/mailwoman-en-us"
echo "  3. Upload to HF bucket en-us/v0.6.0/"
echo "  4. Update releases.json with v0.6.0 entry"
