"""Compare the browser's pure resize algorithm to the training Pillow version."""
import base64
import hashlib
import json
from pathlib import Path
import subprocess

import numpy as np
from PIL import Image, __version__ as pillow_version

root = Path(__file__).resolve().parents[1]
shapes = [(224, 224), (224, 347), (347, 224), (513, 347), (113, 287), (49, 31), (1, 31), (1, 513), (513, 1), (31, 1),
          (65, 113), (640, 480), (480, 640), (225, 225), (227, 223), (1920, 1080), (1080, 1920)]
requests, expected = [], []
for index, (width, height) in enumerate(shapes):
    rgb = np.random.default_rng(index).integers(0, 256, (height, width, 3), dtype=np.uint8)
    rgba = np.concatenate([rgb, np.full((height, width, 1), 255, dtype=np.uint8)], axis=2)
    requests.append({'width': width, 'height': height, 'data': base64.b64encode(rgba.tobytes()).decode()})
    expected.append(hashlib.sha256(np.asarray(Image.fromarray(rgb).resize((224, 224), Image.Resampling.BILINEAR)).tobytes()).hexdigest())
code = """
import{readFileSync}from'node:fs';import{createHash}from'node:crypto';
import{resizeRgb}from'./public/js/model-preprocess.js';
const requests=JSON.parse(readFileSync(0,'utf8'));
console.log(JSON.stringify(requests.map(r=>createHash('sha256').update(resizeRgb({...r,data:Buffer.from(r.data,'base64')})).digest('hex'))));
"""
result = subprocess.run(['node', '--input-type=module', '-e', code], input=json.dumps(requests), text=True, capture_output=True, check=True, cwd=root)
actual = json.loads(result.stdout)
for shape, a, e in zip(shapes, actual, expected): assert a == e, f'Pillow mismatch for {shape}'
report = {'status': 'passed', 'pillow_version': pillow_version, 'byte_identical_shapes': shapes, 'tests': len(shapes)}
(root / 'reports/preprocessing-verification.json').write_text(json.dumps(report, indent=2))
print(f'PASS: {len(shapes)} image dimensions match Pillow {pillow_version} byte for byte')
