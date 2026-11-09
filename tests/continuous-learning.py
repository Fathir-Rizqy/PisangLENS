"""Preflight/data-isolation tests only; never fit or publish a model."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('learning', root / 'scripts/continuous-learning.py')
learning = importlib.util.module_from_spec(spec); spec.loader.exec_module(learning)
directory = Path(tempfile.mkdtemp(prefix='pisanglens-approved-test-'))
records = []
for label in range(4):
    for index in range(5):
        name = f'{label}-{index}.png'
        image = Image.fromarray(np.random.default_rng(label * 100 + index).integers(0, 256, (33, 47, 3), dtype=np.uint8))
        image.save(directory / name)
        records.append({'file': name, 'sha256': hashlib.sha256((directory / name).read_bytes()).hexdigest(),
            'label_id': label, 'corrected_label': learning.LABELS[label], 'review_id': len(records) + 1,
            'reviewed_by': 2, 'reviewed_at': '2026-11-07T00:00:00Z', 'approved_by': 1, 'decided_at': '2026-11-07T01:00:00Z'})
manifest = {'format': 'pisanglens-approved-v1', 'labels': learning.LABELS, 'records': records}
path = directory / 'manifest.json'
path.write_text(json.dumps(manifest))
approved = learning.load_approved(path, set())
assert len(approved) == 20
train, validation = learning.split_new(approved, 42)
assert len(train) == 16 and len(validation) == 4
assert not {r['pixel_hash'] for r in train} & {r['pixel_hash'] for r in validation}
assert learning.split_new(approved, 42) == (train, validation)
assert len(learning.load_approved(path, {approved[0]['pixel_hash']})) == 19
assert len(learning.load_approved(path, set(), {approved[0]['visual_signature']})) == 19
print('PASS: exact class order, deterministic disjoint split, and existing-holdout exclusion')
for name, mutate in [
    ('missing expert approval', lambda d: d['records'][0].update(approved_by=None)),
    ('modified image hash', lambda d: d['records'][0].update(sha256='0' * 64)),
    ('wrong label index', lambda d: d['records'][0].update(label_id=3)),
    ('outside image path', lambda d: d['records'][0].update(file='../outside.png')),
    ('unconfirmed class order', lambda d: d.update(labels=list(reversed(d['labels'])))),
    ('conflicting identical pixels', lambda d: d['records'].append({**d['records'][0], 'label_id': 1, 'corrected_label': learning.LABELS[1]})),
]:
    changed = copy.deepcopy(manifest); mutate(changed); path.write_text(json.dumps(changed))
    try: learning.load_approved(path, set())
    except (ValueError, OSError): pass
    else: raise AssertionError(name + ' was accepted')
    print('PASS:', name, 'rejected')
path.write_text(json.dumps(manifest))
output = directory / 'candidates'
result = subprocess.run([sys.executable, str(root / 'scripts/continuous-learning.py'), '--dataset', str(path), '--output', str(output)], check=True, text=True, capture_output=True)
status = json.loads(result.stdout)
assert status['status'] == 'ready_to_train' and not status['active_model_changed'] and not output.exists()
print('PASS: dry-run authorizes no training or active-model writes')
(root / 'reports/continuous-learning-verification.json').write_text(json.dumps({'status': 'passed', 'approved_images': 20, 'training_split': 16, 'validation_split': 4, 'negative_cases_rejected': 6, 'training_executed': False, 'active_model_changed': False}, indent=2))
