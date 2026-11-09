#!/usr/bin/env python3
"""Periksa checksum, input non-RGB/EXIF, batch, dan contoh prediksi referensi."""
from __future__ import annotations

import json
from pathlib import Path

import torch
from PIL import Image, ImageOps

if __package__:
    from .inference import Predictor, checksum
else:
    from inference import Predictor, checksum


def main():
    root = Path(__file__).resolve().parent
    hashes = json.loads((root / "checksums.json").read_text())
    for name, expected in hashes.items():
        if checksum(root / name) != expected:
            raise AssertionError(f"Checksum tidak cocok: {name}")
    predictor = Predictor(device="cpu")
    references = json.loads((root / "examples/reference_predictions.json").read_text())
    paths = [root / row["image"] for row in references]
    single = [predictor.predict(p) for p in paths]
    batch = predictor.predict_many(paths)
    max_delta = 0.0
    for expected, got, batched in zip(references, single, batch):
        ref = torch.tensor(expected["logits"], dtype=torch.float64)
        z = torch.tensor(list(got["logits"].values()), dtype=torch.float64)
        zb = torch.tensor(list(batched["logits"].values()), dtype=torch.float64)
        max_delta = max(max_delta, float((ref-z).abs().max()))
        torch.testing.assert_close(z, ref, atol=1e-4, rtol=1e-4)
        torch.testing.assert_close(zb, z, atol=1e-4, rtol=1e-4)
        assert got["predicted_label_id"] == expected["predicted_label_id"]
        assert got["policy_status"] == expected["policy_status"]
        assert abs(got["confidence"] - expected["confidence"]) < 1e-4
        assert abs(sum(got["probabilities"].values()) - 1) < 1e-12
        assert got["decision"] == (got["predicted_label"] if got["accepted"] else "uncertain")
    with Image.open(paths[0]) as image:
        original = image.convert("RGB")
    for mode in ("L", "RGBA"):
        converted = original.convert(mode)
        x = predictor.preprocess(converted)
        torch.testing.assert_close(x, predictor.preprocess(converted.convert("RGB")), atol=0, rtol=0)
        assert x.shape == (3, 224, 224) and x.dtype == torch.float32
    portrait = original.resize((113, 257))
    portrait.getexif()[274] = 6
    torch.testing.assert_close(predictor.preprocess(portrait),
                               predictor.preprocess(ImageOps.exif_transpose(portrait)), atol=0, rtol=0)
    assert predictor.predict_many([]) == []
    assert sum(p.numel() for p in predictor.model.parameters()) == 4207156
    print(json.dumps({"status": "passed", "files_verified": len(hashes), "reference_images": len(references),
                      "max_abs_logit_delta_vs_original": max_delta,
                      "checks": ["checksums", "original_predictions", "calibrated_confidence", "uncertain_policy",
                                 "batch_vs_single", "grayscale", "RGBA", "EXIF_orientation", "shape_dtype", "parameter_count"]}, indent=2))


if __name__ == "__main__":
    main()
