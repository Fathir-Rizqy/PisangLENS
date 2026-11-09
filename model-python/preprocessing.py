"""Preprocessing inference yang sama dengan PisangLENS.ipynb."""
from __future__ import annotations

import json
from pathlib import Path

import torch
from PIL import Image, ImageOps
from torchvision.transforms import InterpolationMode
from torchvision.transforms import functional as TF


class Preprocessor:
    """EXIF -> RGB -> direct bilinear resize -> tensor [0,1] -> normalize."""

    def __init__(self, config_path: str | Path | None = None):
        path = Path(config_path) if config_path else Path(__file__).resolve().parent / "preprocessing.json"
        self.config = json.loads(path.read_text(encoding="utf-8"))
        cfg = self.config
        if cfg["resize_policy"] != "direct_bilinear" or cfg["augmentation_at_inference"]:
            raise ValueError("Paket ini hanya mendukung direct_bilinear tanpa augmentasi inference.")
        if cfg["color"] != "RGB" or cfg["dtype"] != "float32" or cfg["layout"] != "NCHW":
            raise ValueError("Kontrak preprocessing tidak cocok.")
        if len(cfg["mean"]) != 3 or len(cfg["std"]) != 3 or min(cfg["std"]) <= 0:
            raise ValueError("Mean/std preprocessing tidak valid.")

    def __call__(self, image: str | Path | Image.Image) -> torch.Tensor:
        """Hasil: satu tensor float32 [3,224,224], sudah dinormalisasi."""
        if isinstance(image, Image.Image):
            im = ImageOps.exif_transpose(image).convert("RGB")
        else:
            with Image.open(image) as opened:
                opened.load()
                im = ImageOps.exif_transpose(opened).convert("RGB").copy()
        size = self.config["image_size"]
        im = TF.resize(im, [size, size], interpolation=InterpolationMode.BILINEAR, antialias=True)
        tensor = TF.to_tensor(im)
        tensor = TF.normalize(tensor, self.config["mean"], self.config["std"])
        if tensor.shape != (3, size, size) or tensor.dtype != torch.float32 or not torch.isfinite(tensor).all():
            raise ValueError("Tensor preprocessing tidak valid.")
        return tensor
