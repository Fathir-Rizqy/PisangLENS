#!/usr/bin/env python3
"""Analisis ulang artefak tersimpan; tidak melatih model atau mengubah sumber.

Jalankan dari root workspace:
  .venv/bin/python MobileNetV3/hasil_analisis/generate_analysis.py
Dependensi: numpy, pandas, matplotlib, scikit-learn, Pillow.
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import shutil
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

os.environ.setdefault("MPLCONFIGDIR", "/tmp/matplotlib-pisanglens-analysis")
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from matplotlib.ticker import MaxNLocator, PercentFormatter
from PIL import Image
from sklearn.metrics import (accuracy_score, average_precision_score,
                             balanced_accuracy_score, confusion_matrix,
                             f1_score, log_loss, precision_recall_curve, roc_curve,
                             roc_auc_score)

NAVY, TEAL, BLUE, GOLD, RED = "#20384D", "#00877F", "#497BA8", "#CB842C", "#B45168"
COLORS = [TEAL, BLUE, GOLD, RED]
plt.rcParams.update({
    "font.family": "DejaVu Sans", "font.size": 10, "axes.titlesize": 11,
    "axes.titleweight": "bold", "axes.labelcolor": NAVY, "text.color": NAVY,
    "axes.edgecolor": "#C9D3DA", "xtick.color": NAVY, "ytick.color": NAVY,
    "axes.spines.top": False, "axes.spines.right": False,
    "axes.grid": True, "grid.color": "#E4E9ED", "grid.alpha": .85,
    "axes.axisbelow": True, "legend.frameon": False, "figure.facecolor": "white",
    "savefig.facecolor": "white", "svg.fonttype": "none",
})


def sha(path):
    with open(path, "rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


class Analysis:
    def __init__(self, source: Path, output: Path):
        self.source, self.output = source.resolve(), output.resolve()
        if self.output == self.source or self.source in self.output.parents:
            raise ValueError("Output harus terpisah dari folder sumber outputs.")
        self.output.mkdir(parents=True, exist_ok=True)
        self.sources, self.figures, self.checks = {}, [], []
        self.mapping = self.jread("label_mapping.json")
        self.labels = [k for k, v in sorted(self.mapping.items(), key=lambda x: x[1])]
        self.names = [x.capitalize() for x in self.labels]
        self.sel = self.jread("training/selection.json")
        self.cfg = self.jread("config.resolved.json")
        self.runs = {}
        for path in sorted((self.source / "training").glob("E*/summary.json")):
            s = self.jread(path.relative_to(self.source))
            root = path.parent.relative_to(self.source)
            s["history"] = self.cread(root / "metrics.csv")
            s["predictions"] = self.cread(root / "validation/logits.csv")
            self.runs[s["run_id"]] = s
        self.test = self.cread("evaluation/internal/predictions.csv")
        self.metrics = self.jread("evaluation/internal/metrics.json")
        self.ci = self.jread("evaluation/internal/confidence_intervals.json")
        self.split = self.jread("reports/split_summary.json")
        self.quality = self.jread("reports/data_quality_report.json")
        self.stress = self.cread("evaluation/stress/metrics.csv")
        self.bench = self.jread("evaluation/efficiency/host_benchmark.json")
        self.temp = self.jread("evaluation/calibration/temperature.json")
        self.policy = self.jread("evaluation/policy/decision_policy.json")
        self.manifests = {s: self.cread(f"manifests/{s}.csv") for s in ("train", "validation", "test")}
        self.selected = self.sel["selected_run"]

    def read_path(self, sub):
        p = self.source / sub
        self.sources[str(sub)] = sha(p)
        return p

    def jread(self, sub):
        return json.loads(self.read_path(sub).read_text())

    def cread(self, sub):
        return pd.read_csv(self.read_path(sub))

    def write_json(self, name, data):
        p = self.output / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(data, indent=2, ensure_ascii=False, allow_nan=False) + "\n")

    def csv(self, name, df):
        p = self.output / "data" / name
        p.parent.mkdir(exist_ok=True)
        df.to_csv(p, index=False)

    def check(self, name, condition):
        if not bool(condition):
            raise ValueError(f"Verifikasi gagal: {name}")
        self.checks.append({"check": name, "status": "passed"})

    def fig(self, rows, cols, title, subtitle="", size=None):
        f, a = plt.subplots(rows, cols, figsize=size or (7 * cols, 4.2 * rows), squeeze=False)
        f.suptitle(title, x=.06, y=.985, ha="left", fontsize=17, fontweight="bold")
        f.text(.06, .945, subtitle, fontsize=10, color="#5D7080", va="top")
        return f, a

    def save(self, f, rel, caption, note=""):
        base = self.output / "plots" / rel
        base.parent.mkdir(parents=True, exist_ok=True)
        f.text(.06, .02, note or "Sumber: artefak MobileNetV3 tersimpan • Skor dalam persen kecuali dinyatakan lain.",
               fontsize=8, color="#5D7080", va="bottom")
        f.tight_layout(rect=(.015, .065, .99, .90), h_pad=2.8, w_pad=2.5)
        f.savefig(base.with_suffix(".png"), dpi=300, bbox_inches="tight")
        f.savefig(base.with_suffix(".svg"), bbox_inches="tight")
        self.figures.append({"path": str(base.with_suffix(".png").relative_to(self.output)),
                             "svg": str(base.with_suffix(".svg").relative_to(self.output)),
                             "caption": caption})
        plt.close(f)

    def pct(self, ax, low=0, high=100, which="y"):
        getattr(ax, f"set_{which}lim")(low, high)
        getattr(ax, f"{which}axis").set_major_formatter(PercentFormatter(100))

    def heatmap(self, ax, data, rows, cols, fmt=".1f", vmin=0, vmax=100):
        im = ax.imshow(data, cmap="Blues", vmin=vmin, vmax=vmax, aspect="auto")
        ax.grid(False)
        ax.set_xticks(range(len(cols)), cols, rotation=15, ha="right")
        ax.set_yticks(range(len(rows)), rows)
        for (r, c), val in np.ndenumerate(np.asarray(data)):
            ax.text(c, r, format(val, fmt), ha="center", va="center", fontsize=10,
                    color="white" if val > vmin + (vmax - vmin) * .57 else NAVY)
        return im

    def confusion(self, df, title, rel, subtitle):
        cm = confusion_matrix(df.true_label_id, df.predicted_label_id, labels=range(4))
        f, aa = self.fig(1, 2, title, subtitle, (13.5, 5.8))
        self.heatmap(aa[0, 0], cm, self.names, self.names, "d", vmax=max(cm.max(), 1))
        self.heatmap(aa[0, 1], 100 * cm / cm.sum(axis=1, keepdims=True), self.names, self.names)
        for ax, label in zip(aa.flat, ["Jumlah gambar", "Normalisasi per kelas aktual (%)"]):
            ax.set_title(label, pad=13)
            ax.set_xlabel("Prediksi")
            ax.set_ylabel("Kelas aktual")
        self.save(f, rel, title,
                  "Setiap baris adalah kelas aktual; normalisasi memakai jumlah gambar pada kelas tersebut.")

    def verify(self):
        self.check("Delapan run penuh, semuanya completed", len(self.runs) == 8 and all(
            s["status"] == "completed" and not s["diagnostic"] for s in self.runs.values()))
        val = self.manifests["validation"].sort_values("image_id")
        rows = []
        for run, s in self.runs.items():
            p = s["predictions"].sort_values("image_id")
            y, pred = p.true_label_id, p.predicted_label_id
            probs = p[[f"probability_{i}" for i in range(4)]].to_numpy()
            logits = p[[f"logit_{i}" for i in range(4)]].to_numpy()
            soft = np.exp(logits - logits.max(axis=1, keepdims=True))
            soft /= soft.sum(axis=1, keepdims=True)
            scores = {"macro_f1": f1_score(y, pred, average="macro"), "accuracy": accuracy_score(y, pred),
                      "balanced_accuracy": balanced_accuracy_score(y, pred),
                      "val_ce": log_loss(y, probs, labels=range(4))}
            self.check(f"{run}: identitas dan label validation", p.image_id.tolist() == val.image_id.tolist()
                       and p.true_label_id.tolist() == val.label_id.tolist() and p.image_id.is_unique)
            self.check(f"{run}: argmax logit dan probabilitas", np.array_equal(pred, logits.argmax(1))
                       and np.allclose(soft, probs, atol=1e-6))
            self.check(f"{run}: metrik hitung ulang", all(np.isclose(v, s["best"][k], atol=1e-6)
                       for k, v in scores.items()))
            h = s["history"]
            best = h.loc[h.epoch == s["best"]["epoch"]].iloc[0]
            self.check(f"{run}: epoch checkpoint cocok history", np.isclose(best.val_macro_f1, scores["macro_f1"])
                       and np.isclose(best.val_ce, scores["val_ce"]))
            spec = s["spec"]
            rows.append({"run_id": run, "recipe": spec["recipe"], "variant": spec["variant"],
                         "seed": spec["seed"], "augmentation": spec["profile"], "loss": spec["loss"],
                         **{f"validation_{k}": float(v) for k, v in scores.items()},
                         "best_epoch": s["best"]["epoch"], "best_stage": s["best"]["stage"],
                         "epochs_run": len(h), "training_seconds": s["elapsed_seconds"],
                         "parameters": s["parameters"]["A"]["total"],
                         "test_status": "evaluated" if run == self.selected else "not_evaluated"})
        self.table = pd.DataFrame(rows).sort_values(["validation_macro_f1", "validation_val_ce"], ascending=[False, True])
        self.csv("perbandingan_semua_run.csv", self.table)
        aggregates = []
        for variant, recipe in [("small", "E02"), ("large", "E03")]:
            sub = self.table[(self.table.variant == variant) & (self.table.recipe == recipe)]
            self.check(f"Finalis {variant}: tiga seed yang sama", set(sub.seed) == {42, 17, 2026})
            aggregates.append({"variant": variant, "recipe": recipe, "n_seeds": len(sub),
                               "macro_f1_mean": sub.validation_macro_f1.mean(),
                               "macro_f1_sample_std": sub.validation_macro_f1.std(ddof=1),
                               "balanced_accuracy_mean": sub.validation_balanced_accuracy.mean(),
                               "balanced_accuracy_sample_std": sub.validation_balanced_accuracy.std(ddof=1),
                               "parameters": int(sub.parameters.iloc[0]),
                               "training_seconds_mean": sub.training_seconds.mean()})
        self.agg = pd.DataFrame(aggregates)
        self.csv("agregat_finalis_tiga_seed.csv", self.agg)
        self.delta = float(self.agg.iloc[1].macro_f1_mean - self.agg.iloc[0].macro_f1_mean)
        self.check("Seleksi sesuai margin Small yang sudah ditetapkan", self.selected == "E03_large_seed42"
                   and self.delta > self.cfg["small_margin"])
        for i, j in [("train", "validation"), ("train", "test"), ("validation", "test")]:
            a, b = self.manifests[i], self.manifests[j]
            self.check(f"Split {i}/{j}: tidak ada image_id atau exact content hash overlap",
                       not (set(a.image_id) & set(b.image_id)) and not (set(a.content_hash) & set(b.content_hash)))
        for split, df in self.manifests.items():
            self.check(f"Manifest {split}: checksum dan ukuran", sha(self.source / f"manifests/{split}.csv") ==
                       self.split["manifest_checksums"][split] and len(df) == self.split["sizes"][split])
        test = self.test.sort_values("image_id")
        manifest = self.manifests["test"].sort_values("image_id")
        self.check("Test: image_id dan label cocok manifest", test.image_id.tolist() == manifest.image_id.tolist()
                   and test.true_label_id.tolist() == manifest.label_id.tolist() and test.image_id.is_unique)
        m = self.metrics["four_class"]
        self.check("Test: accuracy, macro-F1, balanced accuracy, confusion matrix",
                   np.isclose(accuracy_score(test.true_label_id, test.predicted_label_id), m["accuracy"])
                   and np.isclose(f1_score(test.true_label_id, test.predicted_label_id, average="macro"), m["macro_f1"])
                   and np.isclose(balanced_accuracy_score(test.true_label_id, test.predicted_label_id), m["balanced_accuracy"])
                   and np.array_equal(confusion_matrix(test.true_label_id, test.predicted_label_id), m["confusion_matrix"]))
        self.check("Checkpoint terpilih: checksum dan identitas prediksi", sha(self.source / "training" / self.selected /
                   "checkpoints/best.pt") == self.sel["checkpoint_sha256"]
                   and set(test.checkpoint_sha256) == {self.sel["checkpoint_sha256"]})
        handoff = self.jread("training/handoff/artifact_checksums.json")
        for name, digest in handoff.items():
            self.check(f"Handoff: checksum {name}", sha(self.source / "training/handoff" / name) == digest)
        accepted = test.policy_status.eq("supported_prediction")
        self.check("Policy: coverage dan selective risk", np.isclose(accepted.mean(), self.metrics["selective"]["coverage"]["value"])
                   and np.isclose((test.loc[accepted].true_label_id != test.loc[accepted].predicted_label_id).mean(),
                                  self.metrics["selective"]["selective_risk"]["value"]))
        for row in self.stress.itertuples():
            rel = f"evaluation/stress/predictions/{row.transform}_{row.level:g}.csv"
            if not (self.source / rel).exists():
                rel = f"evaluation/stress/predictions/{row.transform}_{float(row.level)}.csv"
            pred = self.cread(rel)
            self.check(f"Stress {row.transform}_{row.level:g}: macro-F1 dan pasangan gambar",
                       set(pred.image_id) == set(test.image_id) and np.isclose(
                           f1_score(pred.true_label_id, pred.predicted_label_id, average="macro"), row.macro_f1))
        self.csv("metrik_per_kelas_test.csv", pd.DataFrame([
            {"class": self.labels[c], **m["per_class"][str(c)]} for c in range(4)]))
        errors = test[test.true_label_id != test.predicted_label_id].copy()
        errors["predicted_class"] = errors.predicted_label_id.map(dict(enumerate(self.labels)))
        self.csv("kesalahan_test.csv", errors[["image_id", "label_name", "predicted_class", "confidence", "policy_status"]])
        self.csv("stress_test.csv", self.stress)
        self.csv("distribusi_split.csv", pd.DataFrame([
            {"split": s, "class": self.labels[c], "n": int((d.label_id == c).sum())}
            for s, d in self.manifests.items() for c in range(4)]))
        self.bootstrap()
        print(f"Verifikasi data selesai: {len(self.checks)} pemeriksaan.", flush=True)

    def bootstrap(self):
        """CI deskriptif pasangan seed42; mempertahankan jumlah tiap kelas validasi."""
        a = self.runs["E02_small_seed42"]["predictions"].sort_values("image_id")
        b = self.runs["E03_large_seed42"]["predictions"].sort_values("image_id")
        y, pa, pb = a.true_label_id.to_numpy(), a.predicted_label_id.to_numpy(), b.predicted_label_id.to_numpy()
        rng = np.random.default_rng(42)
        def score(y, p):
            cm = np.bincount(4 * y + p, minlength=16).reshape(4, 4)
            den = cm.sum(0) + cm.sum(1)
            return np.divide(2 * cm.diagonal(), den, out=np.zeros(4), where=den != 0).mean()
        deltas = []
        for _ in range(2000):
            idx = np.concatenate([rng.choice(np.where(y == c)[0], (y == c).sum(), replace=True) for c in range(4)])
            deltas.append(score(y[idx], pb[idx]) - score(y[idx], pa[idx]))
        self.paired = {"comparison": "Large seed42 minus Small E02 seed42", "source_split": "validation",
                       "delta_macro_f1": score(y, pb) - score(y, pa),
                       "ci_95": np.quantile(deltas, [.025, .975]).tolist(), "replicates": 2000, "seed": 42,
                       "method": "paired_stratified_image_bootstrap",
                       "limitation": "Eksploratif sesudah seleksi pada validation yang sama; bukan CI selisih mean tiga seed atau bukti independen.",
                       "prediction_disagreements": int((pa != pb).sum()),
                       "sampling_unit": "image_assuming_independence_unverified"}
        self.write_json("data/perbandingan_berpasangan_validation.json", self.paired)

    def comparisons(self):
        f, aa = self.fig(1, 2, "Perbandingan delapan eksperimen", "Pemilihan memakai validation • Metrik test hanya tersedia untuk E03 Large seed 42", (14, 6.8))
        d = self.table
        color = [TEAL if v == "large" else BLUE for v in d.variant]
        for ax, col, title, limit in [(aa[0, 0], "validation_macro_f1", "Macro-F1 validation ↑", (0, 106)),
                                      (aa[0, 1], "validation_val_ce", "Cross-entropy validation ↓", (0, .14))]:
            vals = d[col].to_numpy() * (100 if "macro" in col else 1)
            ax.barh(d.run_id, vals, color=color, height=.58)
            ax.invert_yaxis(); ax.set_xlim(*limit); ax.set_title(title, pad=12); ax.grid(axis="y", visible=False)
            for i, v in enumerate(vals): ax.text(v + (0.6 if "macro" in col else .002), i,
                                                 f"{v:.2f}%" if "macro" in col else f"{v:.4f}", va="center", fontsize=9)
            if "macro" in col: ax.xaxis.set_major_formatter(PercentFormatter(100))
        self.save(f, "01_perbandingan/peringkat_semua_run", "Peringkat semua run berdasarkan macro-F1 validation, lalu CE.",
                  "Urutan seri dipisahkan dengan CE. Seed 17 Large memiliki CE terendah; handoff tetap seed 42 sesuai protokol.")
        f, aa = self.fig(1, 2, "Large unggul tipis pada tiga seed", "Finalis: E02 Small vs E03 Large • seed 17, 42, dan 2026", (12.8, 5.7))
        for ax, metric, std, title in [(aa[0, 0], "macro_f1_mean", "macro_f1_sample_std", "Macro-F1 validation"),
                                      (aa[0, 1], "balanced_accuracy_mean", "balanced_accuracy_sample_std", "Balanced accuracy validation")]:
            for i, variant in enumerate(["small", "large"]):
                g = self.agg.iloc[i]
                raw_col = "validation_macro_f1" if "macro" in metric else "validation_balanced_accuracy"
                sub = self.table[(self.table.variant == variant) & self.table.recipe.isin(["E02", "E03"])].sort_values("seed")
                ax.errorbar(100 * g[metric], i, xerr=100 * g[std], color=[BLUE, TEAL][i], capsize=6, lw=3, marker="D", ms=8)
                for off, row in zip([-.15, 0, .15], sub.itertuples()):
                    ax.scatter(100 * getattr(row, raw_col), i + off, s=26, color=[BLUE, TEAL][i], alpha=.6)
                ax.text(95.0, i + .30, f"{100*g[metric]:.2f}% ± {100*g[std]:.2f} pp", fontsize=10)
            ax.set_yticks([0, 1], ["E02 Small", "E03 Large"]); ax.set_ylim(-.4, 1.6)
            self.pct(ax, 94.8, 100, "x"); ax.set_title(title, pad=12); ax.set_xlabel("Skala diperbesar: 94,8–100%")
        self.save(f, "01_perbandingan/ringkasan_model", "Rata-rata dan simpangan baku antarseed untuk finalis.",
                  f"Titik kecil = satu seed; wajik = mean; garis = ±1 SD sampel, bukan CI. Selisih macro-F1 = {100*self.delta:.3f} pp.")
        f, aa = self.fig(1, 2, "Ablasi pada seed 42", "E00: dasar • E01: augmentasi • E02: augmentasi + weighted CE • E03: resep E02 pada Large", (13, 5.7))
        runs = [f"{r}_{'large' if r == 'E03' else 'small'}_seed42" for r in ["E00", "E01", "E02", "E03"]]
        vals = [self.runs[r]["best"]["macro_f1"] * 100 for r in runs]
        aa[0, 0].bar([r[:3] for r in runs], vals, color=[BLUE, BLUE, BLUE, TEAL], width=.55)
        for i, v in enumerate(vals): aa[0, 0].text(i, v + .8, f"{v:.2f}%", ha="center")
        self.pct(aa[0, 0], 0, 106); aa[0, 0].set_title("Macro-F1 validation")
        ces = [self.runs[r]["best"]["val_ce"] for r in runs]
        aa[0, 1].bar([r[:3] for r in runs], ces, color=[BLUE, BLUE, BLUE, TEAL], width=.55)
        for i, v in enumerate(ces): aa[0, 1].text(i, v + .002, f"{v:.4f}", ha="center")
        aa[0, 1].set_ylim(0, .13); aa[0, 1].set_title("Cross-entropy validation")
        self.save(f, "01_perbandingan/ablasi_seed42", "Ablasi resep pada seed 42.",
                  "Ablasi satu seed bersifat deskriptif. Perubahan ke Large juga mengganti bobot pretrained; bukan isolasi arsitektur murni.")
        f, aa = self.fig(1, 1, "Recall validation per kelas", "Checkpoint terbaik masing-masing run • Skala warna bersama 0–100%", (12, 7.2))
        ids = self.table.run_id.tolist()
        data = [[100 * self.runs[r]["best"]["per_class"][str(c)]["recall"] for c in range(4)] for r in ids]
        self.heatmap(aa[0, 0], data, ids, self.names)
        self.save(f, "01_perbandingan/recall_semua_run", "Recall per kelas dari delapan model pada validation.")
        f, aa = self.fig(1, 2, "Biaya parameter dan waktu training", "Perbandingan finalis tiga seed • Pengukuran training berasal dari sesi eksperimen tersimpan", (12.5, 5.7))
        params = self.agg.parameters.to_numpy() / 1e6
        aa[0, 0].bar(["E02 Small", "E03 Large"], params, color=[BLUE, TEAL], width=.5)
        for i, v in enumerate(params): aa[0, 0].text(i, v + .08, f"{v:.3f} juta", ha="center")
        aa[0, 0].set_ylabel("Jumlah parameter (juta)"); aa[0, 0].set_ylim(0, 5); aa[0, 0].set_title("Parameter model inferensi")
        for i, v in enumerate(["small", "large"]):
            sub = self.table[(self.table.variant == v) & self.table.recipe.isin(["E02", "E03"])]
            aa[0, 1].scatter(np.repeat(i, len(sub)), sub.training_seconds, color=[BLUE, TEAL][i], s=55)
            aa[0, 1].plot([i - .15, i + .15], [sub.training_seconds.mean()] * 2, color=NAVY, lw=2)
        aa[0, 1].set_xticks([0, 1], ["E02 Small", "E03 Large"]); aa[0, 1].set_xlim(-.5, 1.5)
        aa[0, 1].set_ylabel("Waktu training (detik)"); aa[0, 1].set_ylim(0, 135); aa[0, 1].set_title("Titik = seed; garis = rata-rata")
        self.save(f, "01_perbandingan/parameter_dan_training", "Tradeoff parameter dan waktu training yang teramati.",
                  "Small memakai 63,8% lebih sedikit parameter. Waktu training dipengaruhi jumlah epoch; latency inferensi Small belum diukur.")
        print("Plot perbandingan selesai.", flush=True)

    def stage_lines(self, ax, h, best):
        ax.axvline(best, color=GOLD, ls=":", lw=1.4, label=f"Checkpoint epoch {best}")
        changes = h.loc[h.stage.ne(h.stage.shift())].iloc[1:]
        for row in changes.itertuples(): ax.axvline(row.epoch - .5, color="#8796A4", ls="--", lw=1)
        ax.xaxis.set_major_locator(MaxNLocator(integer=True, nbins=8)); ax.set_xlabel("Epoch")

    def training_plots(self):
        fgrid, grid = self.fig(2, 4, "Kurva macro-F1 seluruh eksperimen", "Setiap panel memakai skala yang sama • Garis emas: checkpoint terpilih", (17.5, 9.8))
        for idx, (run, s) in enumerate(self.runs.items()):
            h, best = s["history"], s["best"]["epoch"]
            color = TEAL if s["spec"]["variant"] == "large" else BLUE
            ag = grid.flat[idx]; ag.plot(h.epoch, h.val_macro_f1 * 100, color=color, lw=2)
            self.stage_lines(ag, h, best); self.pct(ag, 50, 101); ag.set_title(run, fontsize=10)
            f, aa = self.fig(2, 2, f"Riwayat training · {run}", f"Checkpoint epoch {best} (stage {s['best']['stage']}) • {len(h)} epoch tercatat", (13.2, 9.6))
            ax = aa[0, 0]; ax.plot(h.epoch, h.train_objective_loss, color=BLUE, label="Objective train")
            ax.plot(h.epoch, h.val_ce, color=RED, label="CE validation"); ax.set_ylabel("Loss"); ax.set_title("Loss (objective dapat berbeda)")
            ax = aa[0, 1]; ax.plot(h.epoch, h.train_accuracy * 100, color=BLUE, label="Akurasi train")
            ax.plot(h.epoch, h.val_accuracy * 100, color=TEAL, label="Akurasi validation"); self.pct(ax); ax.set_title("Akurasi")
            ax = aa[1, 0]; ax.plot(h.epoch, h.val_macro_f1 * 100, color=TEAL, label="Macro-F1 validation")
            ax.plot(h.epoch, h.val_balanced_accuracy * 100, color=BLUE, label="Balanced accuracy validation")
            self.pct(ax, 40, 102); ax.set_title("Macro-F1 dan balanced accuracy")
            ax = aa[1, 1]
            for c in range(4): ax.plot(h.epoch, h[f"val_recall_{c}"] * 100, color=COLORS[c], label=self.names[c])
            self.pct(ax); ax.set_title("Recall validation per kelas")
            for ax in aa.flat:
                self.stage_lines(ax, h, best); ax.legend(fontsize=8, loc="best"); ax.margins(x=.02)
            self.save(f, f"02_training/{run}/kurva_training", f"Learning curves {run}.",
                      "A: classifier; B: buka 4 blok akhir. Putus abu: pergantian stage; emas: checkpoint. Weighted objective ≠ CE biasa.")
            f, aa = self.fig(1, 2, f"Learning rate · {run}", "Nilai learning rate yang tercatat per epoch • Backbone stage A dibekukan", (12, 5.3))
            for ax, col, title in [(aa[0, 0], "lr_classifier", "Classifier"), (aa[0, 1], "lr_backbone", "Backbone")]:
                if col in h and h[col].notna().any():
                    ax.step(h.epoch, h[col], where="mid", color=color, lw=2); ax.set_yscale("log")
                else: ax.text(.5, .5, "Tidak tercatat", ha="center", transform=ax.transAxes)
                self.stage_lines(ax, h, best); ax.set_title(title); ax.set_ylabel("Learning rate (log)")
            self.save(f, f"02_training/{run}/learning_rate", f"Learning rate {run}.")
            self.confusion(s["predictions"], f"Confusion matrix validation · {run}",
                           f"02_training/{run}/confusion_matrix_validation", "135 gambar validation • Checkpoint terbaik")
        self.save(fgrid, "02_training/ikhtisar_macro_f1", "Perkembangan macro-F1 validation semua eksperimen.",
                  "Skala y diperbesar 50–101% dan sama di semua panel. Putus abu: pergantian stage; emas: checkpoint.")
        print("Plot training delapan run selesai.", flush=True)

    def evaluation_plots(self):
        self.confusion(self.test, "Confusion matrix test · E03 Large seed 42",
                       "03_evaluasi/confusion_matrix_test", "135 gambar test • 133 benar, 2 salah • Hasil argmax empat kelas")
        f, aa = self.fig(1, 2, "Performa test dan ketidakpastian", "Checkpoint final E03 Large seed 42 • Interval 95% dari evaluasi tersimpan", (13, 6.4))
        x = np.arange(4)
        for offset, metric, color in [(-.23, "precision", BLUE), (0, "recall", TEAL), (.23, "f1", GOLD)]:
            vals = [100 * self.metrics["four_class"]["per_class"][str(c)][metric] for c in range(4)]
            aa[0, 0].bar(x + offset, vals, width=.22, color=color, label=metric.capitalize())
        aa[0, 0].set_xticks(x, [f"{n}\n(n={self.metrics['four_class']['per_class'][str(c)]['support']})" for c, n in enumerate(self.names)])
        self.pct(aa[0, 0], 0, 108); aa[0, 0].legend(loc="lower center", ncol=3); aa[0, 0].set_title("Precision, recall, dan F1 per kelas")
        keys = ["accuracy", "macro_f1"] + [f"recall_{c}" for c in range(4)]
        labels = ["Accuracy", "Macro-F1"] + [f"Recall {n}" for n in self.names]
        for i, k in enumerate(keys):
            m = self.ci["metrics"][k]; v = m["value"] * 100; lo, hi = np.array(m["ci"]) * 100
            aa[0, 1].errorbar(v, i, xerr=[[max(0, v - lo)], [max(0, hi - v)]], color=TEAL, marker="o", capsize=4)
        aa[0, 1].set_yticks(range(len(labels)), labels); aa[0, 1].invert_yaxis()
        self.pct(aa[0, 1], 70, 101, "x"); aa[0, 1].set_title("Interval 95% (skala 70–101%)")
        self.save(f, "03_evaluasi/performa_dan_interval", "Performa test per kelas dan interval ketidakpastian.",
                  "Macro-F1: stratified image bootstrap; accuracy/recall: Wilson. Asumsi gambar independen belum terverifikasi.")
        f, aa = self.fig(1, 2, "ROC dan precision–recall pada test", "One-vs-rest • Probabilitas setelah temperature scaling dari validation", (12.5, 6.3))
        y = self.test.true_label_id.to_numpy()
        for c in range(4):
            prob = self.test[f"probability_calibrated_{c}"]
            binary = y == c
            fpr, tpr, _ = roc_curve(binary, prob)
            precision, recall, _ = precision_recall_curve(binary, prob)
            aa[0, 0].plot(fpr, tpr, color=COLORS[c], label=f"{self.names[c]} · AUC {roc_auc_score(binary, prob):.4f}")
            aa[0, 1].step(recall, precision, where="post", color=COLORS[c], label=f"{self.names[c]} · AP {average_precision_score(binary, prob):.4f}")
        aa[0, 0].plot([0, 1], [0, 1], color="#AAB6BF", ls="--", lw=1)
        aa[0, 0].set(xlabel="False positive rate", ylabel="True positive rate", title="ROC")
        aa[0, 1].set(xlabel="Recall", ylabel="Precision", title="Precision–recall")
        for ax in aa.flat: ax.set_xlim(0, 1.02); ax.set_ylim(0, 1.03); ax.legend(loc="lower left", fontsize=8)
        self.save(f, "03_evaluasi/roc_dan_precision_recall", "ROC dan precision–recall dari prediksi test tersimpan.",
                  "AUC/AP menilai peringkat probabilitas; nilai 1,0 tidak berarti semua prediksi argmax atau keputusan policy benar.")
        f, aa = self.fig(1, 2, "Kalibrasi confidence pada test", f"Temperature T = {self.temp['temperature']:.4f} dipasang pada validation • Tidak ada fitting ulang", (12.5, 6))
        for key, name, color in [("calibration_raw", "Sebelum", BLUE), ("calibration_scaled", "Sesudah", TEAL)]:
            bins = [b for b in self.metrics[key]["bins"] if b["n"] > 0]
            aa[0, 0].plot([b["mean_confidence"] for b in bins], [b["accuracy"] for b in bins], marker="o", color=color, label=name)
            for b in bins: aa[0, 0].annotate(f"n={b['n']}", (b["mean_confidence"], b["accuracy"]), xytext=(0, 7 if key.endswith("raw") else -13),
                                          textcoords="offset points", fontsize=8, color=color, ha="center")
        aa[0, 0].plot([0, 1], [0, 1], color="#AAB6BF", ls="--")
        aa[0, 0].set(xlim=(0, 1.04), ylim=(-.08, 1.13), xlabel="Rata-rata confidence (bin terisi)", ylabel="Akurasi dalam bin", title="Reliability diagram")
        aa[0, 0].legend(loc="upper left")
        keys = ["nll", "brier_multiclass_sum", "ece_top_label"]
        for off, key, label, color in [(-.18, "calibration_raw", "Sebelum", BLUE), (.18, "calibration_scaled", "Sesudah", TEAL)]:
            vals = [self.metrics[key][k] for k in keys]
            aa[0, 1].bar(np.arange(3) + off, vals, width=.34, color=color, label=label)
            for i, v in enumerate(vals): aa[0, 1].text(i + off, v + .0008, f"{v:.4f}", fontsize=8, ha="center")
        aa[0, 1].set_xticks(range(3), ["NLL", "Brier (sum)", "ECE"]); aa[0, 1].set_ylim(0, .048)
        aa[0, 1].set_title("Semua metrik: lebih rendah lebih baik"); aa[0, 1].legend()
        self.save(f, "03_evaluasi/kalibrasi", "Kalibrasi confidence sebelum dan sesudah temperature scaling.",
                  "NLL dan Brier membaik; ECE test justru naik. Bin kosong tidak digambar; bin kecil memiliki ketidakpastian tinggi.")
        f, aa = self.fig(1, 2, "Keputusan dengan aturan confidence", "Policy tersimpan: healthy ≥ 0,80; disease ≥ 0,50 • Kalibrasi dipasang pada validation", (12.5, 5.7))
        counts = self.metrics["selective"]["decision_counts"]
        vals = [counts["correct_accepted"], counts["wrong_disease_name"], counts["uncertain"]]
        aa[0, 0].barh(["Diterima, benar", "Diterima, salah nama penyakit", "Uncertain"], vals, color=[TEAL, RED, GOLD], height=.5)
        aa[0, 0].invert_yaxis(); aa[0, 0].set_xlim(0, 150); aa[0, 0].set_xlabel("Jumlah gambar"); aa[0, 0].set_title("135 keputusan pada test")
        for i, v in enumerate(vals): aa[0, 0].text(v + 2, i, str(v), va="center")
        correct = self.test.true_label_id == self.test.predicted_label_id
        aa[0, 1].hist(self.test.loc[correct, "confidence"], bins=np.linspace(0, 1, 21), color=TEAL, alpha=.8, label="Argmax benar")
        aa[0, 1].hist(self.test.loc[~correct, "confidence"], bins=np.linspace(0, 1, 21), color=RED, alpha=.8, label="Argmax salah")
        aa[0, 1].axvline(.8, color=BLUE, ls="--", label="Threshold healthy")
        aa[0, 1].axvline(.5, color=GOLD, ls="--", label="Threshold disease")
        aa[0, 1].set(xlabel="Confidence terkalibrasi", ylabel="Jumlah gambar", title="Distribusi confidence"); aa[0, 1].legend(fontsize=8)
        self.save(f, "03_evaluasi/keputusan_dan_confidence", "Hasil policy confidence dan distribusi confidence test.",
                  "Coverage 134/135; risiko pada prediksi diterima 1/134. Nol sakit→healthy yang diterima bukan bukti risiko nol di lapangan.")
        errors = self.test[self.test.true_label_id != self.test.predicted_label_id]
        f, aa = self.fig(1, len(errors), "Dua kesalahan pada test", "Kasus diambil dari prediksi tersimpan; label aktual mengikuti dataset", (11, 6))
        for ax, row in zip(aa.flat, errors.itertuples()):
            ax.imshow(self.image(row.content_hash)); ax.axis("off")
            ax.set_title(f"Aktual: {self.names[row.true_label_id]} → {self.names[row.predicted_label_id]}\n"
                         f"Confidence {100*row.confidence:.1f}% · {row.policy_status}\n{row.image_id}", fontsize=10, pad=12)
        self.save(f, "03_evaluasi/galeri_kesalahan", "Kedua kesalahan argmax pada test.",
                  "Pestalotiopsis→healthy ditandai uncertain. Sigatoka→pestalotiopsis tetap diterima oleh policy.")
        print("Plot evaluasi test selesai.", flush=True)

    def robustness_plots(self):
        base = self.metrics["four_class"]["macro_f1"] * 100
        titles = {"brightness": "Kecerahan (faktor)", "blur": "Gaussian blur (radius)", "jpeg": "Kualitas JPEG", "rotation": "Rotasi (derajat)"}
        f, aa = self.fig(2, 2, "Ketahanan terhadap gangguan gambar", "Model dan policy tetap • Turunan dari 135 gambar test yang sama", (12.7, 9.3))
        for ax, name in zip(aa.flat, titles):
            d = self.stress[self.stress["transform"] == name].sort_values("level")
            ax.plot(d.level, d.macro_f1 * 100, "o-", color=TEAL, label="Macro-F1")
            ax.plot(d.level, d.coverage * 100, "s--", color=BLUE, label="Coverage policy")
            ax.axhline(base, color=GOLD, ls=":", label=f"Macro-F1 bersih {base:.2f}%")
            for row in d.itertuples(): ax.annotate(f"{100*row.macro_f1:.2f}", (row.level, 100*row.macro_f1), xytext=(0, -15), textcoords="offset points", ha="center", fontsize=8)
            ax.set_xticks(d.level); ax.set_xlabel(titles[name]); self.pct(ax, 85, 101); ax.set_title(titles[name])
            ax.legend(fontsize=8, loc="lower left")
        self.save(f, "04_robustness/gangguan_gambar", "Macro-F1 dan coverage pada 12 kondisi stress.",
                  "Skala y diperbesar 85–101%. Perbaikan pada beberapa gangguan hanya hasil sampel ini; bukan bukti augmentasi selalu membantu.")
        d = self.stress.copy(); labels = [f"{r.transform} {r.level:g}" for r in d.itertuples()]
        f, aa = self.fig(1, 1, "Recall per kelas pada stress test", "Skala warna 0–100% • Kelas aktual tetap sama dengan test bersih", (11, 9))
        data = np.vstack([[100 * self.metrics["four_class"]["per_class"][str(c)]["recall"] for c in range(4)],
                          d[[f"recall_{c}" for c in range(4)]].to_numpy() * 100])
        self.heatmap(aa[0, 0], data, ["Test bersih"] + labels, self.names)
        self.save(f, "04_robustness/recall_per_kelas", "Recall setiap kelas pada seluruh kondisi gangguan.",
                  "Blur 1,5: macro-F1 91,70%. JPEG 40: recall Cordana 84%. Rotasi 10°: 1 keputusan sakit→healthy diterima.")

    def image(self, content_hash):
        p = self.source / "cache/rgb" / f"{content_hash}.png"
        with Image.open(p) as im:
            return np.array(im.convert("RGB"))

    def dataset_plots(self):
        f, aa = self.fig(1, 2, "Komposisi dataset dan pembagian data", "937 gambar sumber → 897 gambar bersih • 2 baris karantina + 38 duplikasi tambahan dikeluarkan", (13.5, 6.3))
        x = np.arange(4)
        original = [self.quality["counts_original_valid"][c] for c in self.labels]
        clean = [self.quality["counts_clean"][c] for c in self.labels]
        for off, vals, label, color in [(-.19, original, "Sumber (937)", BLUE), (.19, clean, "Bersih (897)", TEAL)]:
            aa[0, 0].bar(x + off, vals, width=.36, color=color, label=label)
            for i, v in enumerate(vals): aa[0, 0].text(i + off, v + 7, str(v), fontsize=9, ha="center")
        aa[0, 0].set_xticks(x, self.names, rotation=15); aa[0, 0].set_ylim(0, 550); aa[0, 0].legend(); aa[0, 0].set_ylabel("Jumlah gambar"); aa[0, 0].set_title("Sebelum dan sesudah cleaning")
        bottom = np.zeros(4)
        for split, color in [("train", TEAL), ("validation", BLUE), ("test", GOLD)]:
            vals = np.array([(self.manifests[split].label_id == c).sum() for c in range(4)])
            aa[0, 1].bar(x, vals, bottom=bottom, color=color, width=.6, label=f"{split} ({len(self.manifests[split])})")
            for i, v in enumerate(vals): aa[0, 1].text(i, bottom[i] + v / 2, str(v), color="white", ha="center", va="center", fontsize=9)
            bottom += vals
        aa[0, 1].set_xticks(x, self.names, rotation=15); aa[0, 1].set_ylim(0, 550); aa[0, 1].legend(); aa[0, 1].set_title("Split bersih tanpa augmentasi")
        self.save(f, "05_dataset/distribusi_kelas_dan_split", "Distribusi kelas sebelum/sesudah cleaning dan per split.",
                  "Sigatoka = 52,73% data bersih; macro-F1 dipakai agar kelas kecil tetap memiliki bobot penilaian yang sama.")
        df = pd.concat(self.manifests.values(), ignore_index=True)
        f, aa = self.fig(1, 3, "Kualitas gambar pada data bersih", "897 gambar unik yang benar-benar masuk train, validation, atau test", (15, 5.8))
        for ax, col, label in zip(aa.flat, ["brightness", "contrast", "sharpness"], ["Kecerahan", "Kontras", "Ketajaman (Laplacian variance)"]):
            groups = [df.loc[df.label_id == c, col].to_numpy() for c in range(4)]
            bp = ax.boxplot(groups, patch_artist=True, tick_labels=self.names, flierprops={"marker": ".", "markersize": 3})
            for patch, color in zip(bp["boxes"], COLORS): patch.set_facecolor(color); patch.set_alpha(.6)
            ax.tick_params(axis="x", rotation=25); ax.set_title(label)
            if col == "sharpness": ax.set_yscale("log"); ax.set_ylabel("Skala log")
        self.save(f, "05_dataset/kualitas_gambar", "Distribusi kualitas gambar pada dataset bersih.",
                  "Garis tengah = median; kotak = Q1–Q3; whisker = 1,5×IQR; titik = nilai di luar whisker. Bukan threshold kualitas.")
        f, aa = self.fig(1, 1, "Histogram kanal RGB pada gambar sumber", "937 gambar sumber, sebelum cleaning • Histogram agregat dari data_quality_report.json", (11, 5.8))
        for hist, color, name in zip(self.quality["rgb_histograms"], [RED, TEAL, BLUE], ["Red", "Green", "Blue"]):
            hist = np.array(hist, dtype=float); aa[0, 0].plot(range(256), hist / hist.sum(), color=color, label=name)
        aa[0, 0].set(xlim=(0, 255), xlabel="Intensitas piksel", ylabel="Proporsi piksel dalam kanal", title="Distribusi intensitas"); aa[0, 0].legend()
        self.save(f, "05_dataset/histogram_rgb_sumber", "Histogram RGB sumber sebelum cleaning.",
                  "Histogram ini mencakup sumber sebelum deduplikasi; jumlahnya berbeda dari plot data bersih.")
        f, aa = self.fig(2, 4, "Contoh gambar dataset bersih", "Dua gambar per kelas dari split train • Sampling deterministik seed 42", (13, 8.3))
        for c in range(4):
            sub = self.manifests["train"].query("label_id == @c").sample(2, random_state=42)
            for r, row in enumerate(sub.itertuples()):
                ax = aa[r, c]; ax.imshow(self.image(row.content_hash)); ax.axis("off")
                ax.set_title(f"{self.names[c]}\n{row.image_id}", fontsize=9)
        self.save(f, "05_dataset/contoh_gambar_train", "Contoh dua gambar per kelas dari train.",
                  "Gambar contoh mengikuti label dataset; pemilihan tidak berdasarkan hasil prediksi.")
        pairs = self.split["unreviewed_near_duplicate_pairs_crossing_splits"]
        if pairs:
            pair = pairs[0]; ids = [pair["image_id_a"], pair["image_id_b"]]
            f, aa = self.fig(1, 2, "Kandidat gambar mirip lintas split", "Kandidat pHash dari audit sumber • Belum dikonfirmasi sebagai duplikat", (10.5, 5.8))
            for ax, ident in zip(aa.flat, ids):
                row = df[df.image_id == ident].iloc[0]; ax.imshow(self.image(row.content_hash)); ax.axis("off")
                split = next(s for s, d in self.manifests.items() if ident in set(d.image_id))
                ax.set_title(f"{ident}\n{split} · {row.label_name}", fontsize=10)
            self.save(f, "05_dataset/kandidat_mirip_lintas_split", "Pasangan kandidat gambar mirip yang melintasi train–validation.",
                      "Perlu tinjauan manual sebelum menyimpulkan kebocoran; exact content hash tidak beririsan antarsplit.")
        preview = self.read_path("augmentation_samples/preview.png")
        dest = self.output / "plots/05_dataset/preview_augmentasi_asli.png"
        shutil.copy2(preview, dest)
        self.figures.append({"path": str(dest.relative_to(self.output)), "svg": None,
                             "caption": "Preview augmentasi asli, disalin apa adanya agar transform yang tercatat tetap otentik."})
        print("Plot dataset dan robustness selesai.", flush=True)

    def efficiency_plots(self):
        d = self.cread("evaluation/efficiency/raw_timings.csv")
        f, aa = self.fig(1, 2, "Latency inferensi pada CPU host", "E03 Large seed 42 • FP32, batch 1, 4 threads • Pengukuran lama, bukan benchmark ulang", (13.5, 6.1))
        for ax, kind, component, title in [(aa[0, 0], "model_only", "forward", "Model saja · 200 ulangan/sesi"),
                                            (aa[0, 1], "pipeline", "total", "Pipeline total · 50 gambar/sesi")]:
            sub = d[(d.kind == kind) & (d.component == component)]
            groups = [sub.loc[sub.session == s, "milliseconds"].to_numpy() for s in sorted(sub.session.unique())]
            bp = ax.boxplot(groups, patch_artist=True, tick_labels=[f"Sesi {i+1}" for i in range(len(groups))], flierprops={"marker": ".", "markersize": 3})
            for patch in bp["boxes"]: patch.set_facecolor(TEAL if kind == "model_only" else BLUE); patch.set_alpha(.6)
            for i, g in enumerate(groups): ax.text(i + 1, np.median(g) + 2, f"median {np.median(g):.2f}", ha="center", fontsize=9)
            ax.set_title(title); ax.set_ylabel("Waktu (ms)"); ax.set_ylim(0, max(sub.milliseconds) * 1.12)
        self.save(f, "06_efisiensi/latency_cpu_host", "Distribusi latency model dan pipeline pada CPU host.",
                  "Model-only tidak mencakup preprocessing. Pipeline memakai warm OS cache. Tidak mengukur HP atau membandingkan latency Small.")

    def report(self):
        m, selective = self.metrics["four_class"], self.metrics["selective"]
        small, large = self.agg.iloc[0], self.agg.iloc[1]
        ratio = large.parameters / small.parameters
        chosen = self.runs[self.selected]
        last = chosen["history"].iloc[-1]
        paired_lo, paired_hi = np.array(self.paired["ci_95"]) * 100
        accuracy_ci = self.ci["metrics"]["accuracy"]["ci"]
        f1_ci = self.ci["metrics"]["macro_f1"]["ci"]
        raw, calibrated = self.metrics["calibration_raw"], self.metrics["calibration_scaled"]
        model_latency = np.median([s["median_ms"] for s in self.bench["summaries"] if s["kind"] == "model_only"])
        pipeline_latency = np.median([s["median_ms"] for s in self.bench["summaries"] if s["kind"] == "pipeline" and s["component"] == "total"])
        worst = self.stress.loc[self.stress.macro_f1.idxmin()]
        best_ce = self.table.sort_values(["validation_macro_f1", "validation_val_ce"], ascending=[False, True]).iloc[0]
        summary = {
            "recommended_recipe": "E03", "recommended_variant": "MobileNetV3-Large", "recommended_run": self.selected,
            "selection_basis": "mean validation macro-F1 of three seeds; fixed seed42 handoff per original protocol",
            "validation_three_seed_macro_f1_mean": float(large.macro_f1_mean),
            "validation_three_seed_macro_f1_sample_std": float(large.macro_f1_sample_std),
            "small_validation_three_seed_macro_f1_mean": float(small.macro_f1_mean),
            "delta_macro_f1_percentage_points": self.delta * 100,
            "test_accuracy": m["accuracy"], "test_macro_f1": m["macro_f1"],
            "test_n": len(self.test), "test_correct": int((self.test.true_label_id == self.test.predicted_label_id).sum()),
            "test_scope": "only E03_large_seed42; no comparative test evidence for other checkpoints",
            "best_single_run_by_validation_f1_then_ce": best_ce.run_id,
            "checkpoint": str((self.source / "training" / self.selected / "checkpoints/best.pt").resolve()),
            "inference_weights": str((self.source / "training/handoff/model_state_dict.pt").resolve()),
            "parameters_large": int(large.parameters), "parameters_small": int(small.parameters),
            "validation_paired_bootstrap": self.paired,
            "evidence_limitations": ["135 test images; 13 healthy images", "Same internal split for all seeds",
                "One unreviewed near-duplicate candidate crossing train-validation", "Field and OOD data pending",
                "Validation reused for model selection, calibration, and policy"]}
        self.write_json("data/rekomendasi_model.json", summary)
        training = []
        for run, s in self.runs.items():
            h = s["history"]; end = h.iloc[-1]
            training.append({"run_id": run, "best_epoch": s["best"]["epoch"], "epochs_run": len(h),
                             "best_validation_ce": s["best"]["val_ce"], "last_validation_ce": float(end.val_ce),
                             "last_train_accuracy": float(end.train_accuracy), "last_validation_accuracy": float(end.val_accuracy),
                             "last_validation_macro_f1": float(end.val_macro_f1)})
        self.csv("diagnostik_training.csv", pd.DataFrame(training))
        self.csv("interval_test.csv", pd.DataFrame([
            {"metric": key, "value": val["value"], "lower_95": val["ci"][0], "upper_95": val["ci"][1],
             "method": val["method"]} for key, val in self.ci["metrics"].items() if val.get("ci")]))
        txt = (
            "ANALISIS HASIL MOBILENETV3\n\n"
            f"Rekomendasi: E03 MobileNetV3-Large, checkpoint {self.selected}.\n"
            f"Macro-F1 validation mean 3 seed: {100*large.macro_f1_mean:.2f}% (SD {100*large.macro_f1_sample_std:.2f} pp).\n"
            f"Small E02: {100*small.macro_f1_mean:.2f}% (SD {100*small.macro_f1_sample_std:.2f} pp).\n"
            f"Keunggulan Large: {100*self.delta:.3f} poin persentase; margin protokol {100*self.cfg['small_margin']:.2f} pp.\n"
            f"Test checkpoint terpilih: accuracy {100*m['accuracy']:.2f}%, macro-F1 {100*m['macro_f1']:.2f}%, 133/135 benar.\n"
            f"Single run terbaik jika diurutkan macro-F1 lalu CE: {best_ce.run_id}; belum memiliki evaluasi test.\n"
            "Seed 42 direkomendasikan karena sesuai handoff dan sudah dievaluasi; seed dipilih tetap dalam protokol.\n"
            f"Large: {int(large.parameters):,} parameter; Small: {int(small.parameters):,}. Large memakai {ratio:.2f} kali parameter Small.\n"
            f"Kelemahan terbesar: {worst['transform']} {worst.level:g}, macro-F1 {100*worst.macro_f1:.2f}%.\n"
            "Bukti terbatas pada dataset internal. Selisih tipis; bukan bukti keunggulan statistik atau kesiapan lapangan.\n\n"
            "BUKA laporan_analisis.html untuk laporan lengkap dan galeri seluruh plot.\n"
            "plots/: PNG 300 dpi dan SVG untuk grafik yang dibuat ulang; satu preview augmentasi asli hanya PNG.\n"
            "data/: tabel hasil, rekomendasi JSON, bootstrap validasi, dan audit verifikasi.\n"
            "generate_analysis.py: skrip reproduksi; dependensi numpy, pandas, matplotlib, scikit-learn, Pillow.\n"
            "Jalankan dari root Hackathon:\n"
            "  .venv/bin/python MobileNetV3/hasil_analisis/generate_analysis.py\n\n"
            "Checkpoint dan data sumber tidak dipindahkan atau dimodifikasi.\n"
            f"Checkpoint: {summary['checkpoint']}\n"
            f"Bobot inferensi: {summary['inference_weights']}\n"
        )
        (self.output / "BACA_SAYA.txt").write_text(txt)
        rows = []
        for r in self.table.itertuples():
            rows.append({"Run": r.run_id + (" · handoff" if r.run_id == self.selected else ""),
                         "Macro-F1 val": f"{100*r.validation_macro_f1:.2f}%", "Accuracy val": f"{100*r.validation_accuracy:.2f}%",
                         "Balanced acc val": f"{100*r.validation_balanced_accuracy:.2f}%", "CE val ↓": f"{r.validation_val_ce:.4f}",
                         "Epoch terbaik": r.best_epoch, "Test": "tersedia" if r.test_status == "evaluated" else "belum dievaluasi"})
        table = pd.DataFrame(rows).to_html(index=False, border=0, classes="metrics")
        class_table = pd.DataFrame([
            {"Kelas": self.names[c], "n test": m["per_class"][str(c)]["support"],
             **{k.capitalize(): f"{100*m['per_class'][str(c)][k]:.2f}%" for k in ["precision", "recall", "f1"]}}
            for c in range(4)]).to_html(index=False, border=0)
        def figure(rel):
            item = next(x for x in self.figures if x["path"] == f"plots/{rel}.png")
            return (f'<figure><a href="{html.escape(item["path"])}"><img loading="lazy" src="{html.escape(item["path"])}" '
                    f'alt="{html.escape(item["caption"])}"></a><figcaption>{html.escape(item["caption"])}</figcaption></figure>')
        gallery = []
        group_labels = {"01_perbandingan": "Perbandingan model", "02_training": "Training seluruh run", "03_evaluasi": "Evaluasi test",
                        "04_robustness": "Robustness", "05_dataset": "Dataset", "06_efisiensi": "Efisiensi"}
        for group, label in group_labels.items():
            items = []
            for item in self.figures:
                if item["path"].split("/")[1] != group: continue
                svg = f' · <a href="{html.escape(item["svg"])}">SVG</a>' if item["svg"] else " · PNG sumber asli"
                items.append(f'<li><a href="{html.escape(item["path"])}">{html.escape(item["caption"])}</a>{svg}</li>')
            gallery.append(f'<details><summary>{label} ({len(items)})</summary><ul>{"".join(items)}</ul></details>')
        checkpoint_rel = os.path.relpath(summary["checkpoint"], self.output)
        weights_rel = os.path.relpath(summary["inference_weights"], self.output)
        content = f'''<!doctype html>
<html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Analisis hasil MobileNetV3 · PisangLENS</title>
<style>
:root{{color-scheme:light;--navy:{NAVY};--teal:{TEAL};--muted:#587084}}*{{box-sizing:border-box}}
body{{margin:0;background:#f2f6f8;color:var(--navy);font:16px/1.7 system-ui,sans-serif}}
main{{max-width:1160px;margin:auto;padding:48px 30px 80px}}h1{{font-size:42px;line-height:1.15;margin:12px 0 18px}}
h2{{font-size:25px;margin:38px 0 14px}}h3{{font-size:19px;margin:24px 0 10px}}p{{margin:12px 0}}
.eyebrow{{color:var(--teal);font-size:13px;font-weight:750;letter-spacing:1.4px;text-transform:uppercase}}
.lead{{font-size:20px;max-width:950px}}.card,section{{background:white;padding:26px 30px;border:1px solid #dce5eb;border-radius:14px;margin:20px 0}}
.kpis{{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:26px 0}}
.kpi{{background:white;border-top:4px solid var(--teal);padding:18px;border-radius:8px;border-bottom:1px solid #dce5eb}}
.kpi strong{{display:block;font-size:29px}}.kpi span,small,figcaption{{color:var(--muted);font-size:13px}}
.note{{background:#f0f7f6;border-left:4px solid var(--teal);padding:14px 18px;border-radius:5px}}
table{{border-collapse:collapse;width:100%;font-size:14px;margin:16px 0}}th,td{{padding:11px 10px;text-align:left;border-bottom:1px solid #e2e8ec;white-space:nowrap}}
th{{background:#edf4f6}}.scroll{{overflow-x:auto}}figure{{margin:22px 0}}img{{width:100%;height:auto;border-radius:7px}}
a{{color:#006e79;text-decoration-thickness:1px;text-underline-offset:3px}}code{{overflow-wrap:anywhere;font-size:.9em}}
summary{{cursor:pointer;font-weight:650;padding:13px 0}}details{{border-bottom:1px solid #dce5eb}}li{{margin:7px 0}}
@media(max-width:750px){{main{{padding:26px 16px}}h1{{font-size:32px}}.kpis{{grid-template-columns:repeat(2,1fr)}}section{{padding:20px}}}}
@media print{{body{{background:white}}main{{padding:0}}section{{break-inside:avoid}}details{{display:block}}}}
</style><main>
<div class="eyebrow">PisangLENS · Analisis artefak eksperimen</div>
<h1>MobileNetV3-Large menjadi pilihan utama pada hasil internal ini.</h1>
<p class="lead">Pilih resep <strong>E03</strong> dan gunakan checkpoint <strong>{self.selected}</strong> yang sudah dipilih oleh protokol.
Large unggul <strong>{100*self.delta:.3f} poin persentase</strong> atas E02 Small pada rata-rata macro-F1 tiga seed validation.</p>
<p><small>Dibuat {datetime.now(ZoneInfo('Asia/Jakarta')).strftime('%d %B %Y, %H:%M WIB')} · Analisis dari hasil tersimpan, tanpa training atau fitting ulang.</small></p>
<div class="kpis">
<div class="kpi"><strong>{100*large.macro_f1_mean:.2f}%</strong><span>Macro-F1 validation · mean 3 seed</span></div>
<div class="kpi"><strong>{100*m['accuracy']:.2f}%</strong><span>Akurasi test · 133 / 135 benar</span></div>
<div class="kpi"><strong>{100*m['macro_f1']:.2f}%</strong><span>Macro-F1 test · seed 42 saja</span></div>
<div class="kpi"><strong>{int(large.parameters)/1e6:.2f} juta</strong><span>Parameter model Large</span></div>
</div>
<p class="note">Keunggulannya tipis dan belum terbukti secara independen. Model lain belum memiliki hasil test pembanding di folder ini.
Kesimpulan “terbaik” memakai validation, sedangkan test mengukur checkpoint final yang sudah dipilih.</p>
<section><h2>Dasar rekomendasi</h2>
<p>Finalis E02 Small mencapai <strong>{100*small.macro_f1_mean:.2f}% ± {100*small.macro_f1_sample_std:.2f} pp</strong>,
sedangkan E03 Large mencapai <strong>{100*large.macro_f1_mean:.2f}% ± {100*large.macro_f1_sample_std:.2f} pp</strong> (mean ± SD sampel dari seed 17, 42, 2026).
Selisih {100*self.delta:.3f} pp melewati margin preferensi Small {100*self.cfg['small_margin']:.2f} pp yang telah ditetapkan dalam notebook.</p>
<p>Nilai F1 Large sama di tiga seed pada split ini. Hal itu hanya menunjukkan stabilitas skor yang teramati;
probabilitas dan CE tetap berbeda. Dengan aturan urut macro-F1 lalu CE, <strong>{best_ce.run_id}</strong> menjadi run numerik teratas
(CE {best_ce.validation_val_ce:.4f}). Handoff tetap seed 42 sesuai protokol yang sudah ada; test seed 17 belum tersedia.</p>
{figure('01_perbandingan/ringkasan_model')}
<div class="scroll">{table}</div>
<p>Small tetap masuk akal jika kapasitas model menjadi prioritas: {int(small.parameters):,} parameter dibanding {int(large.parameters):,} pada Large,
atau <strong>{100*(1-small.parameters/large.parameters):.1f}% lebih sedikit</strong>. Latency Small belum diukur sehingga keunggulan kecepatannya belum dapat dinyatakan.</p>
<p>Pada seed 42, balanced accuracy Small {100*self.runs['E02_small_seed42']['best']['balanced_accuracy']:.2f}% sedikit lebih tinggi daripada Large
{100*chosen['best']['balanced_accuracy']:.2f}%. Recall Cordana Small 95,83% vs Large 91,67%; recall Pestalotiopsis Small 96,15% vs Large 100%.
Jadi Large tidak unggul pada setiap kelas dan metrik.</p>
<p>Bootstrap berpasangan validation seed 42 (2.000 replikasi, stratifikasi kelas) menghasilkan selisih macro-F1
{100*self.paired['delta_macro_f1']:.3f} pp dengan interval deskriptif 95% [{paired_lo:.2f}, {paired_hi:.2f}] pp.
Interval ini melintasi nol dan dihitung setelah seleksi pada validation yang sama; bukan CI selisih mean tiga seed atau pengujian independen.</p>
</section>
<section><h2>Hasil test checkpoint final</h2>
<p>Test berisi 135 gambar: akurasi <strong>{100*m['accuracy']:.2f}%</strong>, macro-F1 <strong>{100*m['macro_f1']:.2f}%</strong>,
balanced accuracy <strong>{100*m['balanced_accuracy']:.2f}%</strong>. Baseline selalu memilih Sigatoka hanya memperoleh
akurasi {100*self.metrics['dummy_majority']['metrics']['accuracy']:.2f}% dan macro-F1 {100*self.metrics['dummy_majority']['metrics']['macro_f1']:.2f}%.</p>
<p>Interval 95% tersimpan: akurasi [{100*accuracy_ci[0]:.2f}, {100*accuracy_ci[1]:.2f}]% (Wilson), macro-F1
[{100*f1_ci[0]:.2f}, {100*f1_ci[1]:.2f}]% (stratified image bootstrap). Interval mengasumsikan gambar independen; metadata tanaman/sesi belum tersedia.</p>
<div class="scroll">{class_table}</div>
{figure('03_evaluasi/confusion_matrix_test')}
<p>Dua kesalahan: satu <strong>Pestalotiopsis → Healthy</strong>, dan satu <strong>Sigatoka → Pestalotiopsis</strong>.
Aturan confidence yang dipasang pada validation menandai kesalahan pertama sebagai uncertain, sedangkan kesalahan kedua tetap diterima.</p>
<p>Policy menerima 134/135 gambar (coverage {100*selective['coverage']['value']:.2f}%), dengan 1/134 prediksi diterima salah
(selective risk {100*selective['selective_risk']['value']:.2f}%). Pada argmax murni terdapat 1/122 gambar sakit yang diprediksi healthy;
setelah policy, 0/122 mendapat keputusan healthy yang diterima. Batas atas interval Wilson 95% untuk angka terakhir masih
{100*self.ci['metrics']['false_reassurance']['ci'][1]:.2f}%, sehingga hasil nol pada sampel ini tidak berarti risiko nol.</p>
{figure('03_evaluasi/galeri_kesalahan')}
</section>
<section><h2>Training dan kalibrasi</h2>
<p>Large seed 42 memilih epoch {chosen['best']['epoch']} dari {len(chosen['history'])} epoch, dengan CE validation
{chosen['best']['val_ce']:.4f}. Di epoch akhir, akurasi train {100*last.train_accuracy:.2f}% dan CE validation {last.val_ce:.4f};
akurasi validation tidak terus naik. Ini konsisten dengan manfaat early stopping/checkpoint terbaik dan kemungkinan overfit pada epoch lanjutan.
Objective weighted train dan CE biasa validation berbeda definisi, sehingga jarak kedua kurva loss tidak boleh ditafsirkan langsung sebagai besarnya overfit.</p>
{figure('02_training/E03_large_seed42/kurva_training')}
<p>Temperature scaling T={self.temp['temperature']:.4f} menurunkan NLL test {raw['nll']:.4f} → {calibrated['nll']:.4f}
dan Brier {raw['brier_multiclass_sum']:.4f} → {calibrated['brier_multiclass_sum']:.4f}, tetapi ECE naik
{100*raw['ece_top_label']:.2f}% → {100*calibrated['ece_top_label']:.2f}%. Kalibrasi tidak membaik pada semua metrik.
Validation yang sama dipakai untuk seleksi, kalibrasi, dan policy, sehingga hasil development berpotensi optimistis.</p>
</section>
<section><h2>Ketahanan gambar</h2>
<p>Gangguan paling merugikan yang diuji adalah <strong>blur radius 1,5</strong>: macro-F1 turun dari {100*m['macro_f1']:.2f}% menjadi
{100*worst.macro_f1:.2f}% (turun {100*(m['macro_f1']-worst.macro_f1):.2f} pp). JPEG kualitas 40 menurunkan macro-F1 menjadi 94,04%
dan recall Cordana menjadi 84%. Kecerahan pada level yang diuji mempertahankan label prediksi.</p>
{figure('04_robustness/gangguan_gambar')}
<p>Rotasi 10° menghasilkan satu keputusan sakit→healthy yang diterima. Beberapa gangguan justru memperbaiki skor pada sampel ini;
hal tersebut bukan dasar untuk memilih ulang model atau menjanjikan perbaikan pada data lain. Semua stress memakai turunan dari test yang sama.</p>
</section>
<section><h2>Data dan batas bukti</h2>
<p>Dari 937 baris sumber, 2 baris konflik label dikarantina dan 38 duplikasi tambahan dikeluarkan; tersisa 897 gambar:
627 train, 135 validation, 135 test. Audit ini mengonfirmasi tidak ada image_id atau exact content hash yang beririsan antarsplit.
Sigatoka mendominasi 473/897 gambar (52,73%), sehingga macro-F1 menjadi dasar utama pembandingan.</p>
{figure('05_dataset/distribusi_kelas_dan_split')}
<p>Ada <strong>satu pasangan kandidat gambar mirip lintas train–validation</strong> yang belum ditinjau manual.
Statusnya kandidat, sehingga belum cukup untuk menyimpulkan kebocoran. Kesamaan tanaman/daun/sesi pengambilan juga belum dapat diaudit dari metadata yang tersedia.
Test healthy hanya berisi 13 gambar; recall 100% untuk kelas ini masih memiliki batas bawah Wilson sekitar 77,19%.</p>
<p>Evaluasi lapangan Indonesia, data di luar kelas yang didukung, dan aturan kualitas berlabel manusia belum tersedia.
Hasil ini mendukung pemilihan model untuk eksperimen/prototipe berikutnya. Bukti untuk menyatakan kesiapan lapangan belum tersedia.
Pengembangan setelah melihat test perlu holdout baru yang dipisahkan berdasarkan kebun, tanaman, atau sesi.</p>
</section>
<section><h2>Efisiensi dan artefak yang dipakai</h2>
<p>Large mempunyai {int(large.parameters):,} parameter dan bobot state_dict {self.bench['inference_weights_bytes']/1e6:.2f} MB
({self.bench['inference_weights_bytes']/2**20:.2f} MiB, optimizer tidak termasuk). Median dari median tiga sesi CPU host adalah
{model_latency:.2f} ms untuk forward model dan {pipeline_latency:.2f} ms untuk pipeline total, batch 1 FP32 dengan 4 threads dan warm OS cache.
Angka ini berasal dari benchmark tersimpan dan tidak mewakili latency HP.</p>
<p>Gunakan <a href="{html.escape(str(checkpoint_rel))}">checkpoint training terpilih</a> atau
<a href="{html.escape(str(weights_rel))}">state_dict inferensi handoff</a> beserta label mapping dan preprocessing di folder handoff.
SHA-256 checkpoint: <code>{self.sel['checkpoint_sha256']}</code>.</p>
<p>Metrik semua run dihitung ulang dari logit/prediksi; epoch checkpoint dicocokkan dengan history; checksum manifest,
checkpoint terpilih, dan seluruh berkas handoff diverifikasi. Berkas training/selection.json masih bertuliskan test_status=not_evaluated
karena dibuat sebelum tahap test; hasil test yang selesai terdapat di evaluation/internal. Artefak sumber tidak diubah.</p>
</section>
<section><h2>Galeri seluruh plot</h2><p>{len(self.figures)} gambar tersusun per topik. Grafik yang dibuat ulang tersedia sebagai PNG 300 dpi dan SVG;
preview augmentasi asli disertakan sebagai PNG. Klik nama untuk membuka gambar penuh.</p>{''.join(gallery)}
<h3>Tabel dan reproduksi</h3><ul>
<li><a href="data/perbandingan_semua_run.csv">Tabel perbandingan seluruh run</a></li>
<li><a href="data/agregat_finalis_tiga_seed.csv">Agregat finalis tiga seed</a></li>
<li><a href="data/metrik_per_kelas_test.csv">Metrik test per kelas</a> · <a href="data/interval_test.csv">Interval test</a></li>
<li><a href="data/rekomendasi_model.json">Rekomendasi model dan ruang lingkup bukti</a></li>
<li><a href="data/audit_verifikasi.json">Audit verifikasi dan checksum sumber</a></li>
<li><a href="generate_analysis.py">Skrip reproduksi</a> · <a href="BACA_SAYA.txt">Petunjuk singkat</a></li>
</ul></section>
<small>Sumber: MobileNetV3/outputs/{html.escape(self.source.name)}/ · Tidak menggunakan pencarian web atau hasil dari folder model lain.</small>
</main></html>'''
        (self.output / "laporan_analisis.html").write_text(content)

    def finish(self):
        self.csv("indeks_plot.csv", pd.DataFrame(self.figures))
        self.write_json("data/audit_verifikasi.json", {
            "source": str(self.source), "output": str(self.output),
            "timestamp": datetime.now(ZoneInfo("Asia/Jakarta")).isoformat(),
            "checks": self.checks, "all_passed": all(x["status"] == "passed" for x in self.checks),
            "source_sha256": self.sources, "plots_total": len(self.figures),
            "regenerated_plots_png_and_svg": sum(bool(f["svg"]) for f in self.figures),
            "copied_original_preview": sum(not bool(f["svg"]) for f in self.figures),
            "notes": ["Verification covers saved predictions and metadata, not a fresh inference run.",
                      "Original model files and notebook are preserved."]})
        print(f"Selesai: {len(self.figures)} gambar, {len(self.checks)} pemeriksaan, laporan {self.output / 'laporan_analisis.html'}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1] / "outputs/bananalsd_notebook_device_auto_v2")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()
    a = Analysis(args.source, args.output)
    a.verify()
    a.comparisons()
    a.training_plots()
    a.evaluation_plots()
    a.robustness_plots()
    a.dataset_plots()
    a.efficiency_plots()
    a.report()
    a.finish()


if __name__ == "__main__":
    main()
