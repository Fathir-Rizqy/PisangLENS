"""One repeatable continuous-learning cycle; suitable for an operator's scheduler.

Collects approved data and inspects readiness. Add --train to fit candidate models.
Never changes public artifacts, config flags, the original model or a deployed model.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import secrets
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, default=ROOT, help='Configured PHP app, outside the public webroot')
    parser.add_argument('--workdir', type=Path, required=True, help='Private snapshots and candidates parent')
    parser.add_argument('--source', type=Path, default=ROOT.parent / 'MobileNetV3/outputs/bananalsd_notebook_device_auto_v2')
    parser.add_argument('--php', default='php')
    parser.add_argument('--epochs', type=int, default=5)
    parser.add_argument('--train', action='store_true')
    args = parser.parse_args()
    work = args.workdir.resolve(); app = args.app.resolve(); source = args.source.resolve()
    if work.is_relative_to((app / 'public').resolve()) or work.is_relative_to(source): raise ValueError('Worker storage must be private and separate from original model artifacts')
    if not (app / 'config/config.php').is_file(): raise ValueError('Configure the PHP app before starting the learning worker')
    work.mkdir(parents=True, exist_ok=True, mode=0o700)
    snapshots = work / 'snapshots'; snapshots.mkdir(exist_ok=True, mode=0o700)
    snapshot = snapshots / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + secrets.token_hex(4))
    subprocess.run([args.php, str(app / 'scripts/export-training.php'), str(snapshot)], check=True)
    command = [sys.executable, str(ROOT / 'scripts/continuous-learning.py'), '--dataset', str(snapshot / 'manifest.json'),
               '--source', str(source), '--output', str(work / 'candidates'), '--epochs', str(args.epochs)]
    if args.train: command.append('--train')
    subprocess.run(command, check=True)
    print(json.dumps({'snapshot': str(snapshot), 'training_enabled': args.train, 'deployment_performed': False}))


if __name__ == '__main__': main()
