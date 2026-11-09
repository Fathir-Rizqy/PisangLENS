#!/usr/bin/env python3
"""Inference portabel E03 MobileNetV3-Large seed 42. Lihat README.txt."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import torch
from PIL import Image
from torchvision.models import mobilenet_v3_large

if __package__:
    from .preprocessing import Preprocessor
else:
    from preprocessing import Preprocessor

ASSET_FILES = ("model_state_dict.pt", "model_config.json", "label_mapping.json",
               "preprocessing.json", "calibration.json", "decision_policy.json", "inference_contract.json")


def checksum(path: str | Path) -> str:
    with open(path, "rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


class Predictor:
    """Muat sekali; pakai predict() atau predict_many() berulang kali."""

    def __init__(self, model_dir: str | Path | None = None, device: str = "cpu", threads: int = 4):
        if threads < 1:
            raise ValueError("threads minimal 1.")
        self.model_dir = Path(model_dir).resolve() if model_dir else Path(__file__).resolve().parent
        if device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"
        if device not in {"cpu", "cuda"}:
            raise ValueError("device harus cpu, cuda, atau auto.")
        if device == "cuda" and not torch.cuda.is_available():
            raise ValueError("CUDA tidak tersedia; gunakan --device cpu.")
        self.device = torch.device(device)
        if device == "cpu":
            torch.set_num_threads(threads)
        hashes = self.read_json("checksums.json")
        self.checksums = hashes
        for name in ASSET_FILES:
            if name not in hashes or checksum(self.model_dir / name) != hashes[name]:
                raise ValueError(f"Checksum aset tidak cocok: {name}")
        cfg = self.read_json("model_config.json")
        mapping = self.read_json("label_mapping.json")
        if cfg["variant"] != "large" or cfg["num_classes"] != 4:
            raise ValueError("Konfigurasi model bukan MobileNetV3-Large empat kelas.")
        if sorted(mapping.values()) != list(range(cfg["num_classes"])) or "healthy" not in mapping:
            raise ValueError("label_mapping.json tidak valid.")
        self.labels = [label for label, _ in sorted(mapping.items(), key=lambda item: item[1])]
        contract = self.read_json("inference_contract.json")
        if contract["label_order"] != self.labels:
            raise ValueError("Urutan label tidak cocok dengan kontrak inference.")
        self.healthy_id = mapping["healthy"]
        self.preprocess = Preprocessor(self.model_dir / "preprocessing.json")
        for key in ("mean", "std"):
            if self.preprocess.config[key] != contract[key]:
                raise ValueError(f"Kontrak normalisasi {key} tidak cocok.")
        calibration = self.read_json("calibration.json")
        self.temperature = float(calibration["temperature"])
        if not math.isfinite(self.temperature) or self.temperature <= 0:
            raise ValueError("Temperature harus positif dan finite.")
        self.policy = self.read_json("decision_policy.json")
        if self.policy["status"] != "feasible":
            raise ValueError("Decision policy yang didukung harus feasible.")
        for key in ("tau_healthy", "tau_disease"):
            if not 0 <= self.policy[key] <= 1:
                raise ValueError(f"Threshold tidak valid: {key}")
        # weights=None: tidak mengunduh bobot ImageNet saat inference.
        self.model = mobilenet_v3_large(weights=None, dropout=cfg["dropout"])
        self.model.classifier[-1] = torch.nn.Linear(self.model.classifier[-1].in_features, cfg["num_classes"])
        state = torch.load(self.model_dir / "model_state_dict.pt", map_location="cpu", weights_only=True)
        self.model.load_state_dict(state, strict=True)
        self.model.float().eval().to(self.device)

    def read_json(self, name):
        return json.loads((self.model_dir / name).read_text(encoding="utf-8"))

    def predict(self, image: str | Path | Image.Image) -> dict:
        return self.predict_many([image])[0]

    @torch.inference_mode()
    def predict_many(self, images: list[str | Path | Image.Image]) -> list[dict]:
        """Satu batch; caller membatasi ukuran batch agar sesuai memori perangkat."""
        if not images:
            return []
        batch = torch.stack([self.preprocess(im) for im in images]).to(self.device)
        logits = self.model(batch).float().cpu()
        if logits.shape != (len(images), len(self.labels)) or not torch.isfinite(logits).all():
            raise ValueError("Output model tidak valid.")
        # Float64 untuk menyamai kalkulasi softmax pada laporan evaluasi NumPy/SciPy.
        probabilities = torch.softmax(logits.double() / self.temperature, dim=1)
        probabilities_raw = torch.softmax(logits.double(), dim=1)
        results = []
        for image, z, p, p_raw in zip(images, logits, probabilities, probabilities_raw):
            label_id = int(p.argmax())
            confidence = float(p[label_id])
            threshold = float(self.policy["tau_healthy"] if label_id == self.healthy_id else self.policy["tau_disease"])
            accepted = confidence >= threshold
            results.append({
                "image": str(Path(image)) if not isinstance(image, Image.Image) else "<PIL.Image>",
                "predicted_label_id": label_id,
                "predicted_label": self.labels[label_id],
                "confidence": confidence,
                "policy_status": "supported_prediction" if accepted else "uncertain",
                "policy_reason": "confidence_pass" if accepted else "below_threshold",
                "decision": self.labels[label_id] if accepted else "uncertain",
                "accepted": accepted,
                "threshold": threshold,
                "probabilities": dict(zip(self.labels, p.tolist())),
                "probabilities_raw": dict(zip(self.labels, p_raw.tolist())),
                "logits": dict(zip(self.labels, z.tolist())),
            })
        return results


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Prediksi penyakit daun pisang dengan E03 Large seed 42.")
    parser.add_argument("images", nargs="+", type=Path, help="Satu atau beberapa path gambar.")
    parser.add_argument("--device", choices=["cpu", "cuda", "auto"], default="cpu")
    parser.add_argument("--threads", type=int, default=4, help="Threads CPU (default 4).")
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--output", type=Path, help="Simpan hasil sebagai JSON; path relatif terhadap folder kerja.")
    args = parser.parse_args(argv)
    if args.batch_size < 1 or args.threads < 1:
        parser.error("--batch-size dan --threads minimal 1.")
    missing = [str(p) for p in args.images if not p.is_file()]
    if missing:
        parser.error("Gambar tidak ditemukan: " + ", ".join(missing))
    try:
        predictor = Predictor(device=args.device, threads=args.threads)
        results = []
        for start in range(0, len(args.images), args.batch_size):
            results.extend(predictor.predict_many(args.images[start:start + args.batch_size]))
        payload = {"model": "E03_large_seed42", "device": str(predictor.device),
                   "temperature": predictor.temperature, "results": results}
        encoded = json.dumps(payload, indent=2, ensure_ascii=False, allow_nan=False) + "\n"
        if args.output:
            # Jangan menimpa aset paket atau gambar input saat menyimpan hasil.
            target = args.output.resolve()
            protected = {(predictor.model_dir / name).resolve() for name in predictor.checksums}
            protected.add((predictor.model_dir / "checksums.json").resolve())
            protected.update(p.resolve() for p in args.images)
            if target in protected:
                raise ValueError("Output tidak boleh menimpa aset paket atau gambar input yang sudah ada.")
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(encoded, encoding="utf-8")
        print(encoded, end="")
        return 0
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"Inference gagal: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
