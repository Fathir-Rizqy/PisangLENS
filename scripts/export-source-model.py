"""Transfer the selected torchvision model to a TF.js LayersModel, without training.

Run with the research Python environment; production has no Python dependency.
The second step is scripts/export-tfjs.cjs (uses pinned @tensorflow/tfjs 4.22.0).
"""
import argparse
import csv
import hashlib
import json
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageOps
from torch import nn
from torchvision.models import mobilenet_v3_large
from torchvision.models.mobilenetv3 import InvertedResidual
from torchvision.ops import SqueezeExcitation
from torchvision.transforms import functional as F

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, default=ROOT.parent / 'MobileNetV3/outputs/bananalsd_notebook_device_auto_v2')
parser.add_argument('--work', type=Path, default=Path('/tmp/pisanglens-export'))
args = parser.parse_args()
args.work.mkdir(parents=True, exist_ok=True)
source = args.source.resolve()
load_json = lambda path: json.loads((source / path).read_text())
selection = load_json('training/selection.json')
contract = load_json('training/handoff/inference_contract.json')
assert selection['selected_run'] == 'E03_large_seed42'
assert contract['label_order'] == ['cordana', 'healthy', 'pestalotiopsis', 'sigatoka']
assert contract['resize'] == 'direct_bilinear' and contract['normalization'] == 'outside_model_once'
assert not load_json('config.resolved.json')['augment']['clahe']
checkpoint = source / 'training/E03_large_seed42/checkpoints/best.pt'
assert hashlib.sha256(checkpoint.read_bytes()).hexdigest() == selection['checkpoint_sha256']
state_path = source / 'training/handoff/model_state_dict.pt'
state_sha = hashlib.sha256(state_path.read_bytes()).hexdigest()
assert state_sha == load_json('training/handoff/artifact_checksums.json')['model_state_dict.pt']
torch.set_num_threads(4)
model = mobilenet_v3_large(weights=None, num_classes=4, dropout=0.2).eval()
model.load_state_dict(torch.load(state_path, weights_only=True, map_location='cpu'), strict=True)
weights, specs = [], []


def weight(tensor):
    value = np.ascontiguousarray(tensor.detach().cpu().numpy(), dtype='<f4')
    index = len(specs)
    specs.append({'shape': list(value.shape), 'bytes': value.nbytes})
    weights.append(value.tobytes())
    return index


def describe(module, name):
    node = {'name': name.replace('.', '_')}
    if isinstance(module, InvertedResidual):
        node.update(kind='residual', residual=module.use_res_connect, block=describe(module.block, name + '.block'))
    elif isinstance(module, SqueezeExcitation):
        node.update(kind='se', fc1=describe(module.fc1, name + '.fc1'), fc2=describe(module.fc2, name + '.fc2'))
    elif isinstance(module, nn.Sequential):
        node.update(kind='sequence', children=[describe(child, name + '.' + key) for key, child in module.named_children()])
    elif isinstance(module, nn.Conv2d):
        depthwise = module.groups == module.in_channels == module.out_channels
        assert module.groups == 1 or depthwise
        kernel = module.weight.permute(2, 3, 0, 1) if depthwise else module.weight.permute(2, 3, 1, 0)
        node.update(kind='depthwise' if depthwise else 'conv', filters=module.out_channels,
                    kernel=list(module.kernel_size), strides=list(module.stride), padding=list(module.padding),
                    weights=[weight(kernel)] + ([weight(module.bias)] if module.bias is not None else []), bias=module.bias is not None)
    elif isinstance(module, nn.BatchNorm2d):
        node.update(kind='bn', epsilon=module.eps,
                    weights=[weight(x) for x in [module.weight, module.bias, module.running_mean, module.running_var]])
    elif isinstance(module, nn.Linear):
        node.update(kind='dense', units=module.out_features, weights=[weight(module.weight.T), weight(module.bias)])
    elif isinstance(module, nn.Hardswish): node.update(kind='hardSwish')
    elif isinstance(module, nn.ReLU): node.update(kind='relu')
    elif isinstance(module, nn.Dropout): node.update(kind='dropout', rate=module.p)
    else: raise TypeError(f'Unsupported original layer: {module}')
    return node


description = {'features': describe(model.features, 'features'), 'classifier': describe(model.classifier, 'classifier')}
temperature = load_json('evaluation/calibration/temperature.json')['temperature']
metadata = {
    'model_version': 'e03-large-seed42-fd0e0c2b-v1', 'selected_run': selection['selected_run'],
    'original_format': 'PyTorch torchvision MobileNetV3-Large state_dict',
    'checkpoint_sha256': selection['checkpoint_sha256'], 'state_dict_sha256': state_sha,
    'loader': 'tf.loadLayersModel', 'runtime': '4.22.0', 'dtype': 'float32',
    'input_shape': [None, 224, 224, 3], 'layout': 'NHWC', 'color': 'RGB',
    'resize': 'direct_bilinear_antialias_pillow', 'mean': contract['mean'], 'std': contract['std'],
    'output': 'logits', 'output_shape': [None, 4], 'temperature': temperature,
    'labels': ['Cordana Leaf Spot', 'Healthy', 'Pestalotiopsis Leaf Blight', 'Sigatoka'],
    'source_labels': contract['label_order'], 'confidence_threshold': 0.8,
    'normalization': 'outside_model_once', 'precision_conversion': 'none',
    'parameter_count': sum(p.numel() for p in model.parameters()),
}
(args.work / 'architecture.json').write_text(json.dumps({'architecture': description, 'weights': specs, 'metadata': metadata}))
(args.work / 'source-weights.bin').write_bytes(b''.join(weights))
fixtures = ROOT / 'tests/fixtures/real-model'
fixtures.mkdir(parents=True, exist_ok=True)
rows = list(csv.DictReader((source / 'manifests/test.csv').open()))
picked = []
for label in range(4): picked.extend([r for r in rows if int(r['label_id']) == label][:5])
for row in rows:
    if row['image_id'] in ['raw_e9abdeb7f9b0_00341', 'raw_e9abdeb7f9b0_00748'] and row not in picked: picked.append(row)
refs = []


def reference(image, filename, info, preserve_source=False):
    rgb = ImageOps.exif_transpose(image).convert('RGB')
    if not preserve_source: rgb.save(fixtures / filename)
    resized = rgb.resize((224, 224), Image.Resampling.BILINEAR)
    tensor = F.normalize(F.to_tensor(resized), contract['mean'], contract['std']).unsqueeze(0)
    with torch.inference_mode(): logits = model(tensor)[0]
    probs = (logits / temperature).softmax(0)
    reference_pixels = filename + '.rgb' if info['split'] == 'decode_probe' else None
    if reference_pixels: (fixtures / reference_pixels).write_bytes(np.asarray(resized).tobytes())
    refs.append({'file': filename, **info, 'logits': logits.tolist(), 'probabilities': probs.tolist(),
                 'resized_rgb_sha256': hashlib.sha256(np.asarray(resized).tobytes()).hexdigest(),
                 'resized_rgb_file': reference_pixels,
                 'predicted_index': int(probs.argmax()), 'width': rgb.width, 'height': rgb.height})


for row in picked:
    reference(Image.open(source / 'cache/rgb' / (row['content_hash'] + '.png')), row['image_id'] + '.png',
              {'image_id': row['image_id'], 'split': 'test', 'true_index': int(row['label_id'])})
# Non-square/high-frequency probes verify resizing; these have no accuracy labels.
for width, height in [(513, 347), (113, 287), (49, 31)]:
    rng = np.random.default_rng(width)
    image = Image.fromarray(rng.integers(0, 256, (height, width, 3), dtype=np.uint8))
    reference(image, f'resize-{width}x{height}.png', {'split': 'preprocessing_probe'})
# Exercise the browser's real JPEG/EXIF/grayscale decode, then the same RGB resize.
probe = Image.open(source / 'cache/rgb' / (picked[0]['content_hash'] + '.png')).convert('RGB')
for name, image, orientation in [('jpeg-test.jpg', probe, 1),
        ('jpeg-exif-rotate.jpg', probe.resize((321, 517), Image.Resampling.BILINEAR), 6),
        ('jpeg-grayscale.jpg', probe.convert('L'), 1)]:
    exif = Image.Exif(); exif[274] = orientation
    image.save(fixtures / name, quality=95, subsampling=0, exif=exif)
    with Image.open(fixtures / name) as decoded:
        reference(decoded, name, {'split': 'decode_probe'}, preserve_source=True)
(fixtures / 'reference.json').write_text(json.dumps({'metadata': metadata, 'fixtures': refs}, indent=2))
print(json.dumps({'weights': len(specs), 'bytes': sum(s['bytes'] for s in specs), 'fixtures': len(refs), 'work': str(args.work)}))
