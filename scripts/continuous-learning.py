"""Train a NEW candidate from approved expert labels, with replay and validation gates.

Default: inspect only. --train authorizes a separate candidate, never deployment.
Use the research environment (torch/torchvision/numpy/Pillow), outside PHP/webroot.
The original locked test set is never used for model selection or training.
"""
import argparse
import csv
import hashlib
import json
import math
import random
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageOps
from torch import nn
from torch.utils.data import DataLoader, Dataset
from torchvision import transforms as T
from torchvision.transforms import functional as F, InterpolationMode
from torchvision.models import mobilenet_v3_large

LABELS = ['Cordana Leaf Spot', 'Healthy', 'Pestalotiopsis Leaf Blight', 'Sigatoka']
BASE_SHA = '4805961f21bbea5a7b92e728611791d035fd4d0bc20a9d5ea3d852f642c4f8ab'
ROOT = Path(__file__).resolve().parents[1]


def read_rgb(path):
    with Image.open(path) as image:
        image.load()
        if image.width * image.height > 16000000: raise ValueError('Image exceeds 16 megapixels')
        return ImageOps.exif_transpose(image).convert('RGB')


def pixel_hash(image):
    return hashlib.sha256(np.asarray(image.size, dtype=np.int64).tobytes() + np.asarray(image).tobytes()).hexdigest()


def visual_signature(image):
    pixels = np.asarray(image.convert('L').resize((9, 8), Image.Resampling.BILINEAR))
    bits = (pixels[:, 1:] > pixels[:, :-1]).reshape(-1)
    return sum(int(bit) << index for index, bit in enumerate(bits))


def load_approved(manifest_path, excluded, original_signatures=(), audit=None):
    manifest_path = manifest_path.resolve()
    document = json.loads(manifest_path.read_text())
    if document.get('format') != 'pisanglens-approved-v1' or document.get('labels') != LABELS:
        raise ValueError('Unsupported dataset contract')
    unique = {}
    if audit is None: audit = {}
    audit.update(received_approved=len(document['records']), excluded_known_pixels=0, excluded_similar_originals=0, duplicate_new_images=0)
    for record in document['records']:
        if not all(record.get(key) for key in ['review_id', 'reviewed_by', 'reviewed_at', 'approved_by', 'decided_at']): raise ValueError('Expert/admin audit trail missing')
        label = record.get('label_id')
        if type(label) is not int or label not in range(4) or record['corrected_label'] != LABELS[label]: raise ValueError('Invalid approved label')
        file = (manifest_path.parent / record['file']).resolve()
        if not file.is_relative_to(manifest_path.parent) or file.stat().st_size > 5 * 1024 * 1024: raise ValueError('Invalid dataset path/size')
        if hashlib.sha256(file.read_bytes()).hexdigest() != record['sha256']: raise ValueError('Dataset checksum mismatch')
        image = read_rgb(file); key = pixel_hash(image); signature = visual_signature(image)
        if key in excluded: audit['excluded_known_pixels'] += 1; continue
        if any((signature ^ original).bit_count() <= 3 for original in original_signatures):
            audit['excluded_similar_originals'] += 1; continue
        if key in unique and unique[key]['label_id'] != label: raise ValueError('Conflicting labels for identical pixels')
        similar = next((r for r in unique.values() if (signature ^ r['visual_signature']).bit_count() <= 3), None)
        if similar:
            if similar['label_id'] != label: raise ValueError('Similar photographs have conflicting labels; review the private snapshot')
            audit['duplicate_new_images'] += 1; continue
        unique.setdefault(key, {**record, 'path': str(file), 'pixel_hash': key, 'visual_signature': signature})
    return list(unique.values())


def split_new(records, seed):
    rng = random.Random(seed)
    train, validation = [], []
    for label in range(4):
        group = sorted([r for r in records if r['label_id'] == label], key=lambda r: r['pixel_hash'])
        if len(group) < 5: raise ValueError('At least five unique approved images per class are required')
        rng.shuffle(group)
        count = max(1, math.ceil(len(group) * 0.2))
        validation.extend(group[:count]); train.extend(group[count:])
    return train, validation


def augment(image, cfg):
    a = cfg['augment']; size = cfg['image_size']
    if random.random() < a['crop_p']:
        i, j, h, w = T.RandomResizedCrop.get_params(image, a['crop_scale'], a['crop_ratio'])
        image = F.resized_crop(image, i, j, h, w, [size, size], InterpolationMode.BILINEAR, antialias=True)
    if random.random() < a['flip_p']: image = F.hflip(image)
    if random.random() < a['affine_p']:
        choice = random.choice(['translation', 'shear', 'rotation_shear'])
        angle, translate, shear = 0., [0, 0], [0., 0.]
        if choice == 'translation': translate = [round(random.uniform(-a['translate'], a['translate']) * size) for _ in range(2)]
        elif choice == 'shear': shear[0] = random.uniform(-a['shear'], a['shear'])
        else: angle, shear[0] = random.uniform(-a['rotation'], a['rotation']), random.uniform(-a['rotation_shear'], a['rotation_shear'])
        image = F.pad(image, [math.ceil(size * .25)] * 4, padding_mode='reflect')
        image = F.affine(image, angle, translate, 1., shear, InterpolationMode.BILINEAR)
        image = F.center_crop(image, [size, size])
    if random.random() < a['contrast_p']: image = F.adjust_contrast(image, random.uniform(*a['contrast']))
    if random.random() < a['blur_p']: image = F.gaussian_blur(image, a['blur_kernel'], random.uniform(*a['blur_sigma']))
    return image


class Images(Dataset):
    def __init__(self, records, cfg, training=False): self.records, self.cfg, self.training = records, cfg, training
    def __len__(self): return len(self.records)
    def __getitem__(self, i):
        row = self.records[i]
        image = read_rgb(row['path']).resize((224, 224), Image.Resampling.BILINEAR)
        if self.training: image = augment(image, self.cfg)
        return F.normalize(F.to_tensor(image), self.cfg['mean'], self.cfg['std']), row['label_id']


def metrics(model, loader):
    model.eval(); confusion = np.zeros((4, 4), dtype=np.int64)
    with torch.inference_mode():
        for images, labels in loader:
            predicted = model(images).argmax(1).numpy()
            np.add.at(confusion, (labels.numpy(), predicted), 1)
    true, guessed, correct = confusion.sum(1), confusion.sum(0), confusion.diagonal()
    recall = np.divide(correct, true, out=np.zeros(4), where=true != 0)
    f1 = np.divide(2 * correct, true + guessed, out=np.zeros(4), where=(true + guessed) != 0)
    return {'macro_f1': float(f1.mean()), 'recall': recall.tolist(), 'n': int(true.sum()), 'confusion_matrix': confusion.tolist()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', required=True, type=Path, help='Private manifest from export-training.php')
    parser.add_argument('--source', type=Path, default=ROOT.parent / 'MobileNetV3/outputs/bananalsd_notebook_device_auto_v2')
    parser.add_argument('--output', required=True, type=Path, help='Private parent directory for immutable candidate runs')
    parser.add_argument('--train', action='store_true')
    parser.add_argument('--epochs', type=int, default=5)
    parser.add_argument('--min-new', type=int, default=20)
    args = parser.parse_args()
    if not 1 <= args.epochs <= 20 or args.min_new < 20: raise ValueError('Use 1–20 epochs and at least 20 approved images')
    source = args.source.resolve(); output = args.output.resolve()
    if output.is_relative_to((ROOT / 'public').resolve()) or output.is_relative_to(source): raise ValueError('Candidate output must be private and separate from original artifacts')
    base = source / 'training/handoff/model_state_dict.pt'
    if hashlib.sha256(base.read_bytes()).hexdigest() != BASE_SHA: raise ValueError('Original seed42 state_dict changed')
    cfg = json.loads((source / 'config.resolved.json').read_text())
    if cfg['resize_policy'] != 'direct_bilinear' or cfg['image_size'] != 224 or any(cfg['augment'][k] for k in ['clahe', 'brightness', 'noise']): raise ValueError('Unsupported E03 training recipe')
    frames = {split: list(csv.DictReader((source / f'manifests/{split}.csv').open())) for split in ['train', 'validation', 'test']}
    excluded = {row['content_hash'] for rows in frames.values() for row in rows}
    original_signatures = {visual_signature(read_rgb(source / 'cache/rgb' / (r['content_hash'] + '.png'))) for rows in frames.values() for r in rows}
    audit = {}
    records = load_approved(args.dataset, excluded, original_signatures, audit)
    counts = [sum(r['label_id'] == i for r in records) for i in range(4)]
    identity = hashlib.sha256(json.dumps({'records': sorted((r['pixel_hash'], r['label_id'], str(r['review_id'])) for r in records),
        'base_sha256': BASE_SHA, 'epochs': args.epochs, 'seed': 42, 'recipe': 'E03-replay-v1'}, sort_keys=True).encode()).hexdigest()
    run = output / ('candidate-' + identity[:16])
    status = {'approved_unique_new': len(records), 'class_counts': dict(zip(LABELS, counts)), 'data_audit': audit, 'dataset_fingerprint': identity, 'base_sha256': BASE_SHA, 'output': str(run), 'active_model_changed': False}
    if len(records) < args.min_new or min(counts) < 5:
        print(json.dumps({**status, 'status': 'waiting_for_verified_data', 'minimum_total': args.min_new, 'minimum_per_class': 5})); return
    new_train, new_validation = split_new(records, 42)
    if not args.train: print(json.dumps({**status, 'status': 'ready_to_train', 'new_train': len(new_train), 'new_validation': len(new_validation)})); return
    if (run / 'candidate-report.json').exists(): print(json.dumps({**status, 'status': 'already_trained'})); return
    if run.exists(): raise ValueError('Incomplete run exists; inspect it before retrying in a new output directory')
    run.mkdir(parents=True, mode=0o700)
    torch.manual_seed(42); np.random.seed(42); random.seed(42); torch.set_num_threads(4)
    torch.use_deterministic_algorithms(True)
    model = mobilenet_v3_large(weights=None, num_classes=4, dropout=cfg['dropout'])
    model.load_state_dict(torch.load(base, weights_only=True, map_location='cpu'))
    for p in model.features.parameters(): p.requires_grad = False
    for block in list(model.features.children())[-cfg['unfreeze_last']:]:
        for p in block.parameters(): p.requires_grad = True
    def original(rows): return [{'path': str(source / 'cache/rgb' / (r['content_hash'] + '.png')), 'label_id': int(r['label_id'])} for r in rows]
    train = original(frames['train']) + new_train  # Replay retains all original training classes.
    old_validation = DataLoader(Images(original(frames['validation']), cfg), batch_size=16)
    fresh_validation = DataLoader(Images(new_validation, cfg), batch_size=16)
    baseline = {'original_validation': metrics(model, old_validation), 'new_validation': metrics(model, fresh_validation)}
    loader = DataLoader(Images(train, cfg, True), batch_size=16, shuffle=True, generator=torch.Generator().manual_seed(42))
    counts_train = np.bincount([r['label_id'] for r in train], minlength=4)
    loss_fn = nn.CrossEntropyLoss(weight=torch.tensor(len(train) / (4 * counts_train), dtype=torch.float32))
    optimizer = torch.optim.AdamW([
        {'params': [p for p in model.features.parameters() if p.requires_grad], 'lr': cfg['backbone_lr']},
        {'params': model.classifier.parameters(), 'lr': cfg['classifier_lr']},
    ], weight_decay=cfg['weight_decay'])
    history, best_score, best = [], -1., None
    for epoch in range(1, args.epochs + 1):
        model.train()
        for module in model.features.modules():
            if isinstance(module, nn.BatchNorm2d): module.eval()
        for images, labels in loader:
            optimizer.zero_grad(set_to_none=True); loss = loss_fn(model(images), labels)
            if not torch.isfinite(loss): raise ValueError('Nonfinite training loss')
            loss.backward(); torch.nn.utils.clip_grad_norm_(model.parameters(), cfg['clip_norm']); optimizer.step()
        validation = {'original_validation': metrics(model, old_validation), 'new_validation': metrics(model, fresh_validation)}
        score = sum(v['macro_f1'] for v in validation.values()) / 2
        history.append({'epoch': epoch, **validation})
        if score > best_score:
            best_score, best = score, {'epoch': epoch, **validation}
            torch.save(model.state_dict(), run / 'candidate_state_dict.pt')
    old_ok = best['original_validation']['macro_f1'] >= baseline['original_validation']['macro_f1'] - .005
    recall_ok = all(a >= b - .02 for a, b in zip(best['original_validation']['recall'], baseline['original_validation']['recall']))
    fresh_ok = best['new_validation']['macro_f1'] >= baseline['new_validation']['macro_f1']
    report = {**status, 'status': 'candidate_requires_review' if old_ok and recall_ok and fresh_ok else 'candidate_rejected_by_gate',
        'seed': 42, 'epochs': args.epochs, 'labels': LABELS, 'baseline': baseline, 'best': best, 'history': history,
        'gates': {'original_macro_f1': old_ok, 'original_per_class_recall': recall_ok, 'new_macro_f1': fresh_ok},
        'new_train_review_ids': [r['review_id'] for r in new_train], 'new_validation_review_ids': [r['review_id'] for r in new_validation],
        'original_test_used': False, 'deployment': 'not_performed',
        'limitations': 'New validation images are image-split; farm/plant independence and external field validation still require review.'}
    (run / 'candidate-report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps({**status, 'status': report['status'], 'gates': report['gates']}))


if __name__ == '__main__': main()
