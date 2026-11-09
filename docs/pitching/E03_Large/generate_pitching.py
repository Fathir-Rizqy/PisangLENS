#!/usr/bin/env python3
"""Kurasi pitching E03 dari artefak lokal, tanpa training atau inferensi ulang.

Jalankan dari workspace: .venv/bin/python MobileNetV3/pitching_E03_Large/generate_pitching.py
"""
from __future__ import annotations

import ast
import hashlib
import html
import io
import json
import math
import os
from pathlib import Path
import random
import shutil
import textwrap
import zipfile

os.environ.setdefault('MPLCONFIGDIR', '/tmp/matplotlib-pitching-e03')
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.ticker import PercentFormatter, MaxNLocator
import numpy as np
import pandas as pd
from PIL import Image, ImageOps, ImageDraw, ImageFont
import torch
import torchvision
from torchvision import transforms as T
from torchvision.transforms import functional as TF, InterpolationMode
from sklearn.metrics import accuracy_score, f1_score, confusion_matrix

ROOT = Path(__file__).resolve().parent
BASE = ROOT.parent / 'outputs/bananalsd_notebook_device_auto_v2'
OLD = ROOT.parent / 'hasil_analisis/plots'
NOTEBOOK = ROOT.parent / 'PisangLENS.ipynb'
MAIN = ROOT / '01_PLOT_UTAMA'
BACK = ROOT / '02_PLOT_PENDUKUNG'
DATA = ROOT / '07_DATA_DAN_SUMBER'
for p in [MAIN, BACK, DATA]: p.mkdir(parents=True, exist_ok=True)
NAVY, TEAL, BLUE, GOLD, RED = '#17384B', '#008579', '#477DA9', '#C0832B', '#B65367'
COLORS = [TEAL, BLUE, GOLD, RED]
plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 15,
    'text.color': NAVY, 'axes.labelcolor': NAVY, 'xtick.color': NAVY, 'ytick.color': NAVY,
    'axes.spines.top': False, 'axes.spines.right': False, 'axes.edgecolor': '#CAD5DB',
    'axes.axisbelow': True, 'grid.color': '#E4EAEE', 'legend.frameon': False,
    'figure.facecolor': 'white', 'savefig.facecolor': 'white', 'svg.fonttype': 'none'})
SOURCES, FIGURES, IMAGES, CHECKS = {}, [], [], []


def sha(p):
    with open(p, 'rb') as f: return hashlib.file_digest(f, 'sha256').hexdigest()


def record(p):
    p = Path(p).resolve()
    SOURCES[str(p.relative_to(ROOT.parent))] = sha(p)
    return p


def jread(name): return json.loads(record(BASE / name).read_text())
def cread(name): return pd.read_csv(record(BASE / name))
def check(label, condition):
    if not bool(condition): raise ValueError('Verifikasi gagal: ' + label)
    CHECKS.append({'check': label, 'status': 'passed'})


def save_csv(name, frame):
    frame.to_csv(DATA / name, index=False, encoding='utf-8-sig')


def figure(title, subtitle, foot):
    f = plt.figure(figsize=(16, 9))
    f.text(.055, .93, title, fontsize=26, weight='bold')
    f.text(.055, .879, subtitle, fontsize=14, color='#5D7380')
    f.text(.055, .045, foot, fontsize=11, color='#5D7380')
    return f


def save(f, name, title, caption, talk, priority='utama'):
    folder = MAIN if priority == 'utama' else BACK
    p = folder / name
    p.parent.mkdir(parents=True, exist_ok=True)
    f.canvas.draw()
    renderer = f.canvas.get_renderer()
    for t in f.texts:
        if t.get_position()[1] == .93:
            while t.get_window_extent(renderer).x1 > f.bbox.width * .95:
                t.set_fontsize(t.get_fontsize() - .5)
    f.savefig(p.with_suffix('.png'), dpi=180)
    f.savefig(p.with_suffix('.svg'))
    plt.close(f)
    FIGURES.append({'path': str(p.with_suffix('.png').relative_to(ROOT)),
        'svg': str(p.with_suffix('.svg').relative_to(ROOT)), 'title': title,
        'caption': caption, 'narasi': talk, 'prioritas': priority})


def local_image(row):
    p = BASE / 'cache/rgb' / Path(row.source_reference).name
    if not p.exists(): raise FileNotFoundError(p)
    return record(p)


def export_image(row, folder, role, suffix='', image=None, seed=None):
    src = local_image(row)
    dest = ROOT / folder / row.label_name / f'{row.image_id}{suffix}.png'
    dest.parent.mkdir(parents=True, exist_ok=True)
    if image is None: shutil.copy2(src, dest)
    else: image.save(dest)
    IMAGES.append({'file': str(dest.relative_to(ROOT)), 'parent_image_id': row.image_id,
        'label_dataset': row.label_name, 'split': row.get('split', 'test'),
        'role': role, 'augmentation_seed': seed, 'source_file': str(src.relative_to(ROOT.parent)),
        'source_sha256': sha(src), 'export_sha256': sha(dest), 'width': Image.open(dest).width,
        'height': Image.open(dest).height})
    if image is None: check('Salinan identik: ' + str(dest.relative_to(ROOT)), sha(src) == sha(dest))
    return dest


def image_axis(f, rect, path, title='', color=NAVY, fontsize=16):
    ax = f.add_axes(rect)
    ax.imshow(Image.open(path), interpolation='nearest')
    ax.axis('off')
    if title: ax.set_title(title, fontsize=fontsize, color=color, pad=12, weight='bold')
    return ax


mapping = jread('label_mapping.json')
labels = [k for k, v in sorted(mapping.items(), key=lambda x: x[1])]
names = [s.capitalize() for s in labels]
selection = jread('training/handoff/selection.json')
check('Checkpoint terpilih E03 Large seed42', selection['selected_run'] == 'E03_large_seed42')
run = 'training/E03_large_seed42/'
summary = jread(run + 'summary.json')
config = jread(run + 'config.resolved.json')
cfg = config['cfg']
history = cread(run + 'metrics.csv')
experiments = cread('training/experiments.csv')
test = cread('evaluation/internal/predictions.csv')
val = cread(run + 'validation/logits.csv')
metrics = jread('evaluation/internal/metrics.json')
ci = jread('evaluation/internal/confidence_intervals.json')['metrics']
quality = jread('reports/data_quality_report.json')
split = jread('reports/split_summary.json')
policy = jread('evaluation/policy/decision_policy.json')
temp = jread('evaluation/calibration/temperature.json')
stress = cread('evaluation/stress/metrics.csv')
bench = jread('evaluation/efficiency/host_benchmark.json')
manifests = {s: cread(f'manifests/{s}.csv') for s in ['train', 'validation', 'test']}
check('SHA256 checkpoint cocok dengan seleksi', sha(record(BASE / run / 'checkpoints/best.pt')) == selection['checkpoint_sha256'])
check('Semua prediksi test berasal dari checkpoint yang sama', set(test.checkpoint_sha256) == {selection['checkpoint_sha256']})
check('135 ID test sama dengan manifest', set(test.image_id) == set(manifests['test'].image_id) and len(test) == 135)
check('Label test sama dengan manifest', test.set_index('image_id').true_label_id.sort_index().equals(
    manifests['test'].set_index('image_id').label_id.sort_index()))
check('Akurasi test hitung ulang cocok', np.isclose(accuracy_score(test.true_label_id, test.predicted_label_id), metrics['four_class']['accuracy']))
check('Macro-F1 test hitung ulang cocok', np.isclose(f1_score(test.true_label_id, test.predicted_label_id, average='macro'), metrics['four_class']['macro_f1']))
check('Confusion matrix test hitung ulang cocok', np.array_equal(confusion_matrix(test.true_label_id, test.predicted_label_id, labels=range(4)), metrics['four_class']['confusion_matrix']))
for a, b in [('train', 'validation'), ('train', 'test'), ('validation', 'test')]:
    check(f'Tidak ada exact content hash overlap {a} / {b}', not set(manifests[a].content_hash) & set(manifests[b].content_hash))
logits = test[[f'logit_{i}' for i in range(4)]].to_numpy()
check('Argmax logits sesuai label prediksi', np.array_equal(logits.argmax(1), test.predicted_label_id))
probs = test[[f'probability_calibrated_{i}' for i in range(4)]].to_numpy()
check('Confidence adalah probabilitas terkalibrasi maksimum', np.allclose(probs.max(1), test.confidence))
calculated_accept = np.where(test.predicted_label_id == mapping['healthy'],
    test.confidence >= policy['tau_healthy'], test.confidence >= policy['tau_disease'])
check('Keputusan policy cocok dengan threshold tersimpan', np.array_equal(calculated_accept, test.policy_status.eq('supported_prediction')))
errors = test[test.true_label_id != test.predicted_label_id].copy()
check('Tepat dua salah klasifikasi argmax', len(errors) == 2)
check('Satu salah diterima dan satu uncertain', errors.policy_status.value_counts().to_dict() == {'uncertain': 1, 'supported_prediction': 1})
best_epoch = summary['best']['epoch']
check('Checkpoint epoch ada dalam history', best_epoch in history.epoch.values)

# Raw adalah gambar dari config dataset raw, sudah 224x224 pada artefak sumber.
raw, augmented = {}, {}
train = manifests['train']
for c, label in enumerate(labels):
    rows = train[train.label_name == label].head(3)
    for i, (_, row) in enumerate(rows.iterrows()):
        p = export_image(row, '03_GAMBAR_RAW', 'raw_training')
        if i == 0: raw[c] = (row, p)

# Ekstrak satu fungsi murni dari notebook, bukan mengeksekusi sel/notebook penuh.
nb = json.loads(record(NOTEBOOK).read_text())
node = None
for cell in nb['cells']:
    if cell['cell_type'] != 'code': continue
    code = ''.join(cell['source'])
    if 'def augment_pil(' not in code: continue
    module = ast.parse(code)
    node = next(n for n in module.body if isinstance(n, ast.FunctionDef) and n.name == 'augment_pil')
    break
if node is None: raise ValueError('Fungsi augment_pil tidak ditemukan')
scope = {'random': random, 'math': math, 'T': T, 'TF': TF, 'InterpolationMode': InterpolationMode}
exec(compile(ast.Module(body=[node], type_ignores=[]), str(NOTEBOOK), 'exec'), scope)
(DATA / 'fungsi_augmentasi_dari_notebook.py').write_text(ast.unparse(node) + '\n')
for c, (row, p) in raw.items():
    augmented[c] = []
    for k in range(3):
        seed = 42 + c * 1000 + k
        random.seed(seed); np.random.seed(seed); torch.manual_seed(seed)
        im = scope['augment_pil'](Image.open(p).convert('RGB'), cfg)
        dest = export_image(row, '04_GAMBAR_AUGMENTASI', 'regenerated_online_training_preview',
            f'__aug{k+1}_seed{seed}', im, seed)
        augmented[c].append(dest)
check('Semua contoh augmentasi berasal dari train', all(x['split'] == 'train' for x in IMAGES if x['augmentation_seed'] is not None))

f = figure('Empat kelas daun pisang yang dikenali model',
    'Contoh gambar raw dari training set | label mengikuti anotasi dataset',
    'Raw = config dataset raw; artefak sudah RGB 224 × 224, bukan foto kamera beresolusi penuh.')
for c in range(4):
    image_axis(f, [.06+c*.235, .28, .21, .46], raw[c][1], names[c], COLORS[c])
    f.text(.06+c*.235, .21, raw[c][0].image_id.rsplit('_',1)[-1]+' · train', fontsize=13)
f.text(.06, .125, '1 kelas sehat + 3 kelas penyakit; contoh ini menjelaskan cakupan label model.', fontsize=19)
save(f, '01_EDA_contoh_raw', 'Kenali data dan empat kelas',
    'Empat contoh training; gambar raw individual tersedia pada folder 03_GAMBAR_RAW.',
    'Model mengenali healthy, cordana, pestalotiopsis, dan sigatoka. Label aktual merujuk dataset.')

f = figure('Data diperiksa sebelum model dilatih',
    '937 gambar sumber → 897 gambar setelah pembersihan | split 627 train / 135 validation / 135 test',
    '38 baris duplikat tambahan dibuang setelah 2 baris konflik label dikarantina; total pengurangan 40 baris.')
ax = f.add_axes([.16, .28, .38, .48]); y=np.arange(4)
orig=[quality['counts_original_valid'][s] for s in labels]; clean=[quality['counts_clean'][s] for s in labels]
ax.barh(y+.18, orig, .32, color='#C9D5DE', label='Sumber raw (937)')
ax.barh(y-.18, clean, .32, color=COLORS, label='Setelah cleaning (897)')
ax.set_yticks(y, names); ax.invert_yaxis(); ax.set_xlim(0,555); ax.set_xlabel('Jumlah gambar'); ax.grid(axis='x')
for i,(a,b) in enumerate(zip(orig,clean)):
    ax.text(a+6,i+.18,str(a),va='center',fontsize=12);ax.text(b+6,i-.18,str(b),va='center',fontsize=12)
ax.legend(loc='upper right', bbox_to_anchor=(1,1.18), fontsize=11)
ax = f.add_axes([.65, .28, .28, .48]); bottom=np.zeros(4)
for s,color in zip(['train','validation','test'],[TEAL,BLUE,GOLD]):
    n=[split['class_counts'][s][l] for l in labels]
    ax.bar(np.arange(4),n,bottom=bottom,color=color,label=f'{s} ({sum(n)})');bottom+=n
ax.set_xticks(range(4),['Cor.','Healthy','Pest.','Sig.']);ax.set_ylabel('Jumlah gambar');ax.grid(axis='y');ax.legend(fontsize=11)
f.text(.16,.15,'Sigatoka: 52,73% dari data bersih → laporkan macro-F1 bersama akurasi.',fontsize=18,weight='bold')
save(f,'02_EDA_cleaning_distribusi_split','EDA, cleaning, dan pembagian data',
    'Jumlah sumber raw berbeda dari set bersih. Augmentasi online tidak menambah jumlah gambar unik pada manifest.',
    'Kami menghapus duplikat, mengarantina konflik label, lalu membagi 897 gambar. Ketimpangan kelas menjadi alasan memakai macro-F1.')

f = figure('Variasi gambar dibuat hanya untuk training',
    'Contoh dibuat ulang dengan fungsi augment_pil dan konfigurasi E03 yang tersimpan',
    'Ini preview baru yang dapat direproduksi; bukan rekaman batch training. Validation dan test tidak diaugmentasi.')
for r,c in enumerate([0,3]):
    for k,p in enumerate([raw[c][1]]+augmented[c]):
        image_axis(f,[.055+k*.167,.515-r*.34,.145,.255],p,
            names[c]+'\n'+('Raw' if k==0 else f'Augmentasi {k}'),fontsize=12)
f.text(.76,.72,'Augmentasi online',fontsize=20,weight='bold')
f.text(.76,.65,'Crop ringan · p 0,35\nFlip horizontal · p 0,50\nAffine acak · p 0,40\nKontras · p 0,30\nBlur · p 0,10',fontsize=15,linespacing=1.8,va='top')
f.text(.76,.30,'Brightness, noise, dan\nCLAHE tidak diaktifkan\npada training E03.',fontsize=14,color='#5D7380',linespacing=1.5,va='top')
save(f,'03_EDA_raw_vs_augmentasi','Raw dibanding augmentasi',
    'Dua kelas ditampilkan agar terbaca. Seluruh empat kelas dan 12 file hasil augmentasi tersedia terpisah.',
    'Augmentasi menambah variasi tampilan pada training, bukan sampel independen. Preview memakai fungsi asli notebook dengan seed tercatat.')

f=figure('Mengapa E03 MobileNetV3-Large dipilih?',
    'Perbandingan memakai validation pada split yang sama; tiga seed per finalis',
    'Titik = seed; garis = mean. Selisih mean +0,665 poin persentase; tiga seed memakai split validation yang sama.')
ax=f.add_axes([.12,.28,.43,.48])
for i,(variant,recipe,color) in enumerate([('small','E02',BLUE),('large','E03',TEAL)]):
    d=experiments[(experiments.variant==variant)&(experiments.recipe==recipe)]
    ax.scatter(np.arange(len(d))*.08+i-.08, d.val_macro_f1*100, s=95,color=color,zorder=3)
    mean=d.val_macro_f1.mean()*100;ax.hlines(mean,i-.22,i+.22,color=color,lw=3)
    ax.text(i,d.val_macro_f1.max()*100+.23,f'{mean:.3f}%',ha='center',fontsize=17,weight='bold')
ax.set_xticks([0,1],['E02 Small','E03 Large']);ax.set_xlim(-.5,1.5);ax.set_ylim(95.5,99.5)
ax.yaxis.set_major_formatter(PercentFormatter());ax.set_ylabel('Macro-F1 validation');ax.grid(axis='y')
f.text(.64,.69,'Checkpoint handoff',fontsize=17,color='#5D7380')
f.text(.64,.62,'E03_large_seed42',fontsize=23,weight='bold')
f.text(.64,.53,'98,52%  akurasi validation\n98,27%  macro-F1 validation\nEpoch 7 · stage B',fontsize=18,linespacing=1.8,va='top')
f.text(.64,.26,'Seed42 ditetapkan oleh protokol;\nseed17 memiliki validation CE lebih rendah.',fontsize=13,color='#5D7380',va='top')
save(f,'04_TRAINING_alasan_pemilihan','Dasar pemilihan E03 Large',
    'E03 mean validation macro-F1 98,267%; E02 97,601%. Seed42 adalah checkpoint handoff sesuai protokol.',
    'Large dipilih berdasarkan agregat validation tiga seed. Hasil test yang dibahas berikutnya khusus seed42.')

f=figure('Training dua tahap; checkpoint terbaik pada epoch 7',
    'E03 Large seed42 | 5 epoch classifier + 8 epoch fine-tuning tercatat',
    'Loss train berbobot dan CE validation memiliki definisi berbeda. Garis vertikal emas menandai checkpoint terpilih.')
for i in range(2):
    ax=f.add_axes([.10+i*.46,.29,.38,.45]);ax.axvspan(.7,5.5,color='#EFF5F7');ax.axvline(5.5,color='#8BA0AD',ls='--')
    ax.axvline(best_epoch,color=GOLD,ls=':',lw=2.5)
    if i==0:
        ax.plot(history.epoch,history.train_objective_loss,color=BLUE,lw=2.5,label='Weighted loss train')
        ax.plot(history.epoch,history.val_ce,color=RED,lw=2.5,label='CE validation');ax.set_ylabel('Loss')
    else:
        ax.plot(history.epoch,history.train_accuracy*100,color=BLUE,lw=2.5,label='Akurasi train')
        ax.plot(history.epoch,history.val_accuracy*100,color=TEAL,lw=2.5,label='Akurasi validation')
        ax.set_ylim(75,101);ax.yaxis.set_major_formatter(PercentFormatter())
    ax.set_xlabel('Epoch');ax.xaxis.set_major_locator(MaxNLocator(integer=True));ax.grid();ax.legend(fontsize=12)
f.text(.10,.16,'Checkpoint: val macro-F1 98,27%  |  4 blok akhir dibuka pada stage B',fontsize=20,weight='bold')
save(f,'05_TRAINING_learning_curves','Kurva training E03 seed42',
    'History asli 13 epoch; best checkpoint epoch 7. Early stopping memakai kriteria tersimpan, bukan test.',
    'Model dilatih dalam dua tahap. Performa validation cepat mendatar; hasil tinggi ini masih perlu diuji pada data lapangan baru.')

f=figure('133 dari 135 gambar test diprediksi benar',
    'Test internal | akurasi 98,52% · macro-F1 97,94% · balanced accuracy 98,69%',
    'Confusion matrix memakai prediksi argmax sebelum penolakan confidence; baris = aktual, kolom = prediksi.')
cm=np.array(metrics['four_class']['confusion_matrix'])
for k,mat in enumerate([cm,cm/cm.sum(1,keepdims=True)*100]):
    ax=f.add_axes([.14+k*.45,.25,.33,.51]);ax.imshow(mat,cmap='Blues',vmin=0,vmax=cm.max() if k==0 else 100)
    ax.set_xticks(range(4),names,rotation=20,ha='right',fontsize=12)
    ax.set_yticks(range(4),names,fontsize=12);ax.set_title('Jumlah gambar' if k==0 else 'Normalisasi per baris (%)',fontsize=16,pad=15)
    for (i,j),v in np.ndenumerate(mat):
        ax.text(j,i,str(int(v)) if k==0 else f'{v:.1f}%',ha='center',va='center',fontsize=16,color='white' if v>(cm.max()*.5 if k==0 else 50) else NAVY)
    ax.set_xlabel('Prediksi',fontsize=13);ax.set_ylabel('Aktual',fontsize=13)
save(f,'06_EVALUASI_confusion_matrix_test','Confusion matrix test internal',
    'Dua kesalahan: pestalotiopsis→healthy dan sigatoka→pestalotiopsis, masing-masing satu gambar.',
    'Test terdiri dari 135 gambar. Dua kesalahan tetap dihitung dalam akurasi 98,52%, termasuk satu prediksi yang ditolak policy.')

correct=test[test.true_label_id==test.predicted_label_id]
correct_files={}
for c in range(4):
    d=correct[correct.true_label_id==c].sort_values(['confidence','image_id'])
    rows=pd.concat([d.iloc[[0]],d.iloc[[len(d)//2]]]).drop_duplicates('image_id')
    for i,(_,row) in enumerate(rows.iterrows()):
        p=export_image(row,'06_GAMBAR_PREDIKSI_BENAR','correct_lowest_confidence' if i==0 else 'correct_median_confidence')
        if i==1 or len(rows)==1: correct_files[c]=(row,p)
f=figure('Contoh prediksi benar pada test internal',
    'Satu contoh per kelas, dipilih dekat median confidence di antara prediksi yang benar',
    'Contoh bersifat ilustratif; performa keseluruhan tetap memakai semua 135 gambar test. Confidence terkalibrasi.')
for c in range(4):
    row,p=correct_files[c];image_axis(f,[.06+c*.235,.29,.21,.43],p,names[c],COLORS[c])
    f.text(.06+c*.235,.22,f'Confidence {row.confidence:.2%}',fontsize=15,weight='bold')
    f.text(.06+c*.235,.17,'ID '+row.image_id.rsplit('_',1)[-1],fontsize=13,color='#5D7380')
save(f,'07_EVALUASI_contoh_prediksi_benar','Contoh prediksi benar',
    'File individual mencakup contoh benar berconfidence terendah dan median per kelas; bukan pilihan hanya confidence tertinggi.',
    'Berikut contoh prediksi benar dari test. Confidence bukan jaminan bahwa gambar baru dari lapangan akan dikenali dengan benar.')

error_paths=[]
for _,row in errors.iterrows():
    error_paths.append(export_image(row,'05_MISKLASIFIKASI/gambar','misclassified_argmax'))
f=figure('Dua kesalahan yang perlu dibahas dengan mentor',
    'Label aktual mengikuti dataset; penyebab kesalahan memerlukan pemeriksaan ahli',
    'Confidence terkalibrasi. Policy: healthy ≥ 80%; prediksi penyakit ≥ 50%. Tidak ada label yang diubah.')
for i,(_,row) in enumerate(errors.iterrows()):
    x=.06+i*.48
    image_axis(f,[x,.29,.245,.44],error_paths[i])
    f.text(x+.26,.69,'Aktual',fontsize=14,color='#5D7380')
    f.text(x+.26,.64,names[int(row.true_label_id)],fontsize=17,weight='bold')
    f.text(x+.26,.55,'Prediksi argmax',fontsize=14,color='#5D7380')
    f.text(x+.26,.50,names[int(row.predicted_label_id)],fontsize=17,color=RED,weight='bold')
    f.text(x+.26,.41,f'{row.confidence:.2%}',fontsize=23,weight='bold')
    f.text(x+.26,.32,'Ditandai tidak yakin' if row.policy_status=='uncertain' else 'Masih diterima policy',fontsize=13,color=RED)
    f.text(x,.20,'ID '+row.image_id.rsplit('_',1)[-1]+' · test internal',fontsize=14)
f.text(.06,.12,'Diskusi: variasi gejala, kualitas foto, anotasi label, dan threshold keputusan.',fontsize=18)
save(f,'08_EVALUASI_dua_misklasifikasi','Seluruh salah klasifikasi test',
    'Pestalotiopsis→healthy 71,29% ditolak; sigatoka→pestalotiopsis 59,58% tetap diterima policy.',
    'Policy menahan satu prediksi healthy yang salah, tetapi belum menghilangkan kesalahan nama penyakit. Penyebab visual belum terkonfirmasi ahli.')

f=figure('Confidence membantu menahan satu kesalahan',
    'Hasil policy pada 135 gambar test yang sama | 134 prediksi diterima, 1 ditandai tidak yakin',
    '0/122 penyakit→healthy yang diterima adalah observasi sampel ini; bukan jaminan risiko nol pada penggunaan lapangan.')
ax=f.add_axes([.12,.31,.40,.43]);counts=[133,1,1]
ax.barh([2,1,0],counts,color=[TEAL,RED,GOLD],height=.58)
ax.set_yticks([2,1,0],['Benar, diterima','Salah, diterima','Tidak yakin'],fontsize=14);ax.set_xlim(0,147)
for y,v in zip([2,1,0],counts):ax.text(v+2,y,str(v),va='center',fontsize=21,weight='bold')
ax.set_xlabel('Jumlah gambar');ax.grid(axis='x')
f.text(.63,.69,'99,26%',fontsize=40,weight='bold',color=TEAL)
f.text(.63,.63,'Coverage: 134 / 135',fontsize=18)
f.text(.63,.49,'0,75%',fontsize=32,weight='bold',color=RED)
f.text(.63,.43,'Kesalahan diterima: 1 / 134',fontsize=17)
f.text(.63,.27,'Threshold healthy 80% · penyakit 50%\nDipilih pada validation, bukan test.',fontsize=15,linespacing=1.7,va='top')
save(f,'09_EVALUASI_policy_confidence','Perilaku kebijakan confidence',
    'Akurasi klasifikasi mentah 133/135; sesudah policy ada 133 benar diterima, 1 salah diterima, dan 1 uncertain.',
    'Coverage 99,26% dan risiko salah di antara prediksi diterima 0,75%. Satu uncertain tidak dihapus dari perhitungan akurasi mentah.')

f=figure('Blur berat dan kompresi menurunkan performa',
    'Stress test sintetis pada 135 gambar yang sama; model dan threshold tetap',
    'Garis putus = macro-F1 gambar bersih 97,94%. Stress sintetis belum mewakili foto lapangan dan data di luar cakupan.')
for i,(kind,title) in enumerate([('brightness','Brightness'),('blur','Blur σ'),('jpeg','JPEG quality'),('rotation','Rotasi (°)')]):
    ax=f.add_axes([.08+i*.235,.31,.185,.43]);d=stress[stress['transform']==kind]
    vals=d.macro_f1.to_numpy()*100;ax.plot(range(3),vals,'o-',lw=2.5,color=COLORS[i],ms=8)
    ax.axhline(metrics['four_class']['macro_f1']*100,color='#869DAA',ls='--')
    ax.set_xticks(range(3),[f'{v:g}' for v in d.level]);ax.set_ylim(85,101)
    ax.yaxis.set_major_formatter(PercentFormatter());ax.set_title(title,fontsize=16);ax.grid(axis='y')
    for j,v in enumerate(vals):ax.text(j,v+.7,f'{v:.2f}',ha='center',fontsize=12)
    if i==0:ax.set_ylabel('Macro-F1 (%)')
f.text(.08,.17,'Blur σ 1,5: 91,70% macro-F1  |  JPEG quality 40: 94,04%',fontsize=21,weight='bold')
save(f,'10_ROBUSTNESS_stress_test','Ketahanan terhadap gangguan gambar',
    'Evaluasi tersimpan, tanpa tuning baru. Nilai yang naik pada transform tertentu bukan bukti augmentasi selalu memperbaiki model.',
    'Model sensitif pada blur berat dan kompresi kuat. Ini memberi prioritas untuk panduan kualitas foto dan pengujian eksternal berikutnya.')

f=figure('Model ringkas; latensi yang tersedia berasal dari CPU host',
    'Benchmark tersimpan | FP32 · batch 1 · 4 threads · 3 sesi',
    'Host evaluasi berbeda dari smartphone/browser. Durasi training sekitar 86 detik pada lingkungan training Tesla T4.')
ax=f.add_axes([.16,.31,.36,.43]);tab=pd.DataFrame(bench['summaries'])
for i,(kind,component,color) in enumerate([('model_only','forward',BLUE),('pipeline','total',TEAL)]):
    d=tab[(tab.kind==kind)&(tab.component==component)].sort_values('session')
    ax.plot(range(1,4),d.median_ms,'o-',color=color,lw=2.5,ms=8,label='Model saja' if i==0 else 'Pipeline total')
    for j,v in enumerate(d.median_ms):ax.text(j+1,v+.5,f'{v:.2f}',ha='center',fontsize=12)
ax.set_xticks([1,2,3]);ax.set_xlabel('Sesi benchmark');ax.set_ylabel('Median latensi (ms)');ax.set_ylim(0,36);ax.grid();ax.legend(fontsize=13,loc='lower right')
f.text(.63,.67,'4,21 juta',fontsize=35,weight='bold');f.text(.63,.61,'parameter inferensi',fontsize=19)
f.text(.63,.47,f"{bench['inference_weights_bytes']/1e6:.2f} MB",fontsize=35,weight='bold',color=TEAL)
f.text(.63,.41,'bobot state_dict FP32',fontsize=19)
f.text(.63,.26,'Latensi mobile / browser:\nbelum diukur pada artefak ini.',fontsize=17,linespacing=1.6,va='top')
save(f,'11_EFISIENSI_benchmark_host','Ukuran model dan benchmark CPU',
    'Ukuran 17,02 MB desimal untuk inference state_dict, tidak termasuk optimizer. Latensi adalah median per sesi CPU host.',
    'MobileNetV3-Large memiliki 4,21 juta parameter dengan file bobot sekitar 17 MB. Klaim performa perangkat pengguna menunggu benchmark nyata.')

f=figure('Hasil internal kuat; validasi berikutnya dibuat terarah',
    'Poin review yang perlu disampaikan saat pitching ke mentor',
    'Satu kandidat near-duplicate train–validation masih belum direview; bukan duplikat yang sudah dipastikan.')
items=[('01','Bukti saat ini','133/135 benar pada test internal; 13 gambar healthy.\n95% CI akurasi: 94,76–99,59% dengan asumsi gambar independen.'),
    ('02','Kualitas dan independensi data','Tidak ada exact hash overlap antarsplit. Metadata daun/sesi belum ada;\nsatu kandidat mirip lintas train–validation perlu pemeriksaan manual.'),
    ('03','Prioritas pengujian berikutnya','Foto lapangan baru, input di luar empat kelas, dan foto buram.\nUji latency pada perangkat target; validation terpisah untuk kalibrasi/policy.')]
for i,(n,title,body) in enumerate(items):
    y=.72-i*.235;f.text(.07,y,n,fontsize=28,color=TEAL,weight='bold')
    f.text(.145,y,title,fontsize=21,weight='bold');f.text(.145,y-.04,body,fontsize=16,linespacing=1.55,va='top')
save(f,'12_REVIEW_batas_bukti_dan_langkah_lanjut','Batas bukti dan diskusi mentor',
    'Field test dan OOD belum tersedia. Validation digunakan kembali untuk pemilihan model, kalibrasi, dan policy.',
    'Temuan saat ini mendukung prototipe dan pengujian berikutnya. Kami belum memiliki bukti generalisasi lapangan atau kecepatan pada perangkat target.')

# Salin plot asli dan analisis lama sebagai lampiran terkurasi, dengan kategori jelas.
copies=[
 ('eda/class_distribution.png','01_EDA/distribusi_sumber_937_asli.png'),
 ('eda/quality_distributions.png','01_EDA/kualitas_gambar_asli.png'),
 ('eda/rgb_histogram.png','01_EDA/histogram_rgb_asli.png'),
 ('eda/representative_images.png','01_EDA/contoh_per_kelas_asli.png'),
 ('augmentation_samples/preview.png','01_EDA/preview_augmentasi_dari_run_asli.png'),
 (run+'plots/learning_curves.png','02_TRAINING/learning_curves_E03_seed42_asli.png'),
 (run+'plots/learning_rate.png','02_TRAINING/learning_rate_E03_seed42_asli.png'),
 (run+'validation/confusion_matrix.png','02_TRAINING/confusion_matrix_VALIDATION_asli.png'),
 ('evaluation/internal/confusion_matrix.png','03_EVALUASI/confusion_matrix_TEST_asli.png'),
 ('evaluation/internal/confusion_matrix_normalized.png','03_EVALUASI/confusion_matrix_TEST_normalized_asli.png'),
 ('evaluation/internal/roc_curves.png','03_EVALUASI/roc_TEST_asli.png'),
 ('evaluation/calibration/reliability.png','03_EVALUASI/reliability_asli.png')]
for src,dest in copies:
    out=BACK/dest;out.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(record(BASE/src),out)
    FIGURES.append({'path':str(out.relative_to(ROOT)),'svg':'','title':out.stem.replace('_',' '),
        'caption':'Salinan plot asli: '+src,'narasi':'Lampiran teknis; perhatikan split dan sumber pada nama file.','prioritas':'pendukung'})
for src,dest in [('03_evaluasi/performa_dan_interval','03_EVALUASI/performa_per_kelas_dan_interval'),
                 ('03_evaluasi/roc_dan_precision_recall','03_EVALUASI/roc_dan_precision_recall_TEST'),
                 ('05_dataset/kandidat_mirip_lintas_split','05_REVIEW/kandidat_mirip_train_validation'),
                 ('02_training/E03_large_seed42/kurva_training','02_TRAINING/kurva_training_rinci_E03_seed42')]:
    for ext in ['.png','.svg']:
        source=OLD/(src+ext);out=BACK/(dest+ext);out.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(record(source),out)
    FIGURES.append({'path':str((BACK/(dest+'.png')).relative_to(ROOT)),'svg':str((BACK/(dest+'.svg')).relative_to(ROOT)),
        'title':Path(dest).name.replace('_',' '),'caption':'Salinan analisis tersimpan: '+src,
        'narasi':'Lampiran untuk tanya jawab mentor.','prioritas':'pendukung'})

# Galeri raw dan augmentasi semua kelas, untuk lampiran.
f=figure('Raw dan tiga variasi augmentasi per kelas','Seluruh kelas | sumber train | contoh baru dari pipeline asli',
    'Tidak mengubah manifest, label, checkpoint, maupun hasil evaluasi. Seed setiap file tercatat di indeks_gambar.csv.')
for c in range(4):
    for k,p in enumerate([raw[c][1]]+augmented[c]):
        image_axis(f,[.16+k*.19,.64-c*.175,.15,.16],p,
            ('Raw' if k==0 else f'Augmentasi {k}') if c==0 else '',fontsize=12)
    f.text(.02,.71-c*.175,names[c],fontsize=13,weight='bold')
save(f,'01_EDA/raw_vs_augmentasi_empat_kelas','Semua kelas: raw dan augmentasi',
    'Setiap baris berasal dari satu gambar train yang sama. Variasi tidak harus menjalankan setiap jenis transformasi.',
    'Lampiran seluruh kelas untuk menjelaskan augmentasi online.',priority='pendukung')

# Contoh stres dipilih dari gambar yang benar pada clean, tetapi salah pada blur berat.
blur=cread('evaluation/stress/predictions/blur_1.5.csv')
candidate=blur[(blur.true_label_id!=blur.predicted_label_id)&blur.image_id.isin(correct.image_id)].sort_values('image_id').iloc[0]
base_row=test[test.image_id==candidate.image_id].iloc[0];base_im=Image.open(local_image(base_row)).convert('RGB')
variants=[('Bersih',base_im,base_row),('Brightness 0,55',TF.adjust_brightness(base_im,.55),None),
    ('Blur σ 1,5',TF.gaussian_blur(base_im,7,1.5),candidate)]
br=cread('evaluation/stress/predictions/brightness_0.55.csv');variants[1]=(variants[1][0],variants[1][1],br[br.image_id==base_row.image_id].iloc[0])
f=figure('Contoh konkret: blur dapat mengubah prediksi','Satu gambar test yang sama; prediksi diambil dari CSV stress tersimpan',
    'Transformasi dibuat ulang untuk visual; tidak menjalankan inferensi baru. Kernel blur 7, sigma 1,5 sesuai notebook.')
stress_examples=[]
for i,(title,im,row) in enumerate(variants):
    p=export_image(base_row,'08_CONTOH_GANGGUAN', 'synthetic_stress_preview',f'__{i}',im)
    image_axis(f,[.07+i*.31,.30,.25,.44],p,title,fontsize=18)
    f.text(.07+i*.31,.21,names[int(row.predicted_label_id)]+f' · {row.confidence:.2%}',fontsize=16,weight='bold')
    stress_examples.append({'file':str(p.relative_to(ROOT)),'image_id':row.image_id,'label_aktual':labels[int(row.true_label_id)],
        'prediksi':labels[int(row.predicted_label_id)],'confidence_calibrated':row.confidence,'kondisi':title})
save(f,'04_ROBUSTNESS/contoh_gambar_gangguan','Contoh dampak gangguan pada satu gambar',
    'Kasus dipilih karena benar pada clean dan salah pada blur berat; bukan sampel acak atau estimasi rata-rata.',
    'Contoh ini mengilustrasikan kasus kegagalan yang teramati pada stress test.',priority='pendukung')
save_csv('contoh_gangguan.csv',pd.DataFrame(stress_examples))

errors['label_aktual']=errors.true_label_id.map(dict(enumerate(labels)))
errors['prediksi']=errors.predicted_label_id.map(dict(enumerate(labels)))
errors['gambar_lokal']=[str(p.relative_to(ROOT)) for p in error_paths]
errors['catatan_review']='Label mengikuti dataset; penyebab kesalahan belum dikonfirmasi ahli'
errors.to_csv(ROOT/'05_MISKLASIFIKASI/semua_misklasifikasi_test.csv',index=False,encoding='utf-8-sig')
save_csv('misklasifikasi_test.csv',errors)
save_csv('prediksi_test_lengkap.csv',test)
save_csv('history_E03_large_seed42.csv',history)
save_csv('perbandingan_validation_semua_run.csv',experiments)
save_csv('stress_test.csv',stress)
save_csv('indeks_gambar.csv',pd.DataFrame(IMAGES))
save_csv('indeks_plot_dan_narasi.csv',pd.DataFrame(FIGURES))
save_csv('distribusi_split.csv',pd.DataFrame([{'split':s,'kelas':l,'jumlah':split['class_counts'][s][l]} for s in manifests for l in labels]))
save_csv('metrik_per_kelas_test.csv',pd.DataFrame([{'kelas':labels[int(c)],**v} for c,v in metrics['four_class']['per_class'].items()]))
for src in [run+'config.resolved.json',run+'summary.json','training/handoff/selection.json',
    'evaluation/internal/metrics.json','evaluation/internal/confidence_intervals.json',
    'evaluation/policy/decision_policy.json','evaluation/calibration/temperature.json',
    'reports/split_summary.json','reports/near_duplicate_split_audit.csv']:
    out=DATA/'artefak_asli'/src;out.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(record(BASE/src),out)

guide='''PAKET PITCHING E03 MOBILENETV3-LARGE — PisangLENS
Dibuat dari artefak lokal pada 7 November 2026 (Asia/Jakarta).

MULAI DI SINI
Buka KATALOG_PITCHING.html untuk melihat visual dan narasi setiap gambar.
01_PLOT_UTAMA berisi 12 visual berurutan, PNG 2880×1620 (16:9) dan SVG.
Untuk pitching sekitar 5 menit, pilih nomor 01, 02, 03, 05, 06, 08, dan 12.
Untuk diskusi mentor 10–15 menit, gunakan seluruh urutan dan buka lampiran saat tanya jawab.

ISI FOLDER
01_PLOT_UTAMA       : EDA → training → evaluasi → misklasifikasi → robustness → review.
02_PLOT_PENDUKUNG   : EDA, kurva rinci, learning rate, confusion matrix VALIDATION/TEST,
                     ROC/PR, metrik per kelas, interval, kalibrasi, dan kandidat mirip.
03_GAMBAR_RAW       : 3 gambar train per kelas, total 12; salinan identik cache RGB.
04_GAMBAR_AUGMENTASI: 3 variasi dari 1 gambar train per kelas, total 12.
05_MISKLASIFIKASI  : seluruh 2 kesalahan test, gambar individual dan CSV lengkap.
06_GAMBAR_PREDIKSI_BENAR: contoh benar dengan confidence terendah dan median per kelas.
07_DATA_DAN_SUMBER  : data pendukung, indeks gambar/plot, narasi, config, dan audit.
08_CONTOH_GANGGUAN  : gambar bersih, brightness rendah, dan blur berat pada kasus yang sama.

ANGKA YANG DIPAKAI
Run terpilih: E03_large_seed42; best checkpoint epoch 7, stage B.
Validation: akurasi 98,52%; macro-F1 98,27% (135 gambar).
Test internal: akurasi 98,52%; macro-F1 97,94%; balanced accuracy 98,69% (135 gambar).
133 prediksi benar / 135; 2 salah argmax.
Policy: 133 benar diterima, 1 salah diterima, 1 uncertain; coverage 99,26%.
Bobot inferensi: 4.207.156 parameter; 17,02 MB desimal (state_dict FP32).

CARA MEMAKAI
PNG cocok langsung dimasukkan ke slide. SVG tersedia untuk pengeditan vector.
Gambar individual tetap 224×224; jangan mengklaim detail tambahan dari pembesaran.
Raw berarti konfigurasi dataset raw, bukan file kamera resolusi penuh.
Augmentasi folder 04 adalah preview baru dari fungsi asli notebook dan konfigurasi E03,
bukan rekaman batch aktual. Seed, parent ID, split, dan hash ada di indeks_gambar.csv.
Preview augmentasi dari proses lama tetap tersedia terpisah dalam lampiran.
Confidence pada visual kasus memakai temperature scaling, bukan probabilitas raw.
Narasi per visual ada di KATALOG_PITCHING.html dan indeks_plot_dan_narasi.csv.

REPRODUKSI
.venv/bin/python MobileNetV3/pitching_E03_Large/generate_pitching.py
Dependensi lokal: numpy, pandas, matplotlib, Pillow, scikit-learn, torch, torchvision.
Script tidak melatih model atau menjalankan inferensi. Fungsi augmentasi diekstrak
dengan AST dari notebook; checkpoint hanya dibaca untuk SHA256, tidak di-load.
Perbedaan versi torchvision dari runtime training dapat mengubah pixel preview;
versi lokal dicatat dalam audit_verifikasi.json. Sumber dan hash tercatat di manifest.
'''
(ROOT/'BACA_DULU.txt').write_text(guide)
review='''REVIEW MODEL UNTUK DISKUSI MENTOR

1. Identitas model dan dasar pemilihan
E03 MobileNetV3-Large seed42 sesuai selection.json dan SHA256 best.pt.
Large dipilih dari mean validation macro-F1 tiga seed: 98,267%, dibanding
E02 Small 97,601% (selisih 0,665 poin persentase pada split yang sama).
Seed42 adalah handoff sesuai protokol; seed17 mempunyai validation CE lebih rendah.
Belum ada perbandingan test Small vs Large, sehingga jangan mengklaim keunggulan test.

2. EDA dan pembersihan
937 gambar sumber: cordana 162, healthy 129, pestalotiopsis 173, sigatoka 473.
Setelah 2 baris konflik label dikarantina dan 38 duplikat tambahan dihapus: 897.
Data bersih: cordana 162, healthy 90, pestalotiopsis 172, sigatoka 473.
Split: 627 train, 135 validation, 135 test; augmentasi online hanya pada train.
Tidak ada exact content hash overlap antarsplit. Satu pasangan kandidat pHash
dekat melintasi train–validation (00130 vs 00140); status belum ditinjau.
Metadata identitas daun/tanaman/sesi belum tersedia, sehingga independensi belum terverifikasi.

3. Training
ImageNet pretrained; classifier 5 epoch, lalu membuka 4 modul akhir backbone.
13 epoch tersimpan, checkpoint terpilih epoch 7. Weighted objective train berbeda
dari CE validation; jangan memakai selisih loss sebagai ukuran langsung generalisasi.
Akurasi train mendekati 100%, sementara validation mendatar. Ini memberi alasan
untuk uji baru; kurva ini saja tidak membuktikan generalisasi lapangan.

4. Evaluasi dan seluruh kesalahan test
Akurasi 133/135 = 98,52%; macro-F1 97,94%. 95% CI akurasi 94,76–99,59%
dengan asumsi foto independen. Test healthy hanya 13 gambar.
00341: pestalotiopsis → healthy; raw confidence 81,76%, calibrated 71,29%; uncertain.
00748: sigatoka → pestalotiopsis; raw confidence 65,46%, calibrated 59,58%; diterima.
Semua label aktual merujuk dataset; penyebab kesalahan belum diperiksa ahli.
File errors/index.csv asli memuat semua 135 baris; paket ini memfilter kesalahan
berdasarkan true_label_id != predicted_label_id, sehingga tidak mencampur prediksi benar.

5. Policy dan kalibrasi
Threshold healthy 80%, penyakit 50%; fit pada validation. Coverage 134/135.
Salah di antara prediksi diterima 1/134 (0,75%). Kasus penyakit→healthy diterima
0/122 pada sampel ini; sebelum policy terdapat satu kasus demikian.
Validation digunakan untuk pemilihan, kalibrasi, dan policy: ada risiko optimisme development.
Temperature scaling memperbaiki NLL test 0,03841 → 0,03766, tetapi ECE top-label
justru 0,01192 → 0,01482. Jangan mengklaim semua ukuran kalibrasi membaik.
Confidence-only policy belum memverifikasi gambar di luar cakupan empat kelas.

6. Robustness dan efisiensi
Blur sigma 1,5: macro-F1 91,70%; JPEG quality 40: 94,04%.
Hasil stress berasal dari transformasi sintetis pada 135 foto yang sama, bukan data baru.
17.022.327 bytes = 17,02 MB desimal / sekitar 16,23 MiB; inference state_dict FP32.
Benchmark CPU host FP32 batch 1 dan 4 threads; bukan benchmark smartphone/browser.
Durasi training sekitar 86 detik tidak termasuk seluruh persiapan data/evaluasi.

7. Arah diskusi yang disarankan
- Review dua misklasifikasi dan satu kandidat mirip lintas train–validation bersama ahli.
- Kumpulkan holdout lapangan baru dengan metadata daun, tanaman, lokasi, dan sesi.
- Uji gambar di luar label serta foto blur/gelap; ukur kegagalan dan coverage.
- Pisahkan data kalibrasi/policy dari data pemilihan model bila data mencukupi.
- Benchmark perangkat target sebelum mengklaim kecepatan penggunaan nyata.

Sumber: seluruh angka di atas dari JSON/CSV artefak lokal, bukan benchmark baru.
Audit paket memverifikasi prediksi tersimpan, metrik, split hash, policy, dan salinan gambar.
'''
(ROOT/'CATATAN_REVIEW_MENTOR.txt').write_text(review)

cards=[]
for x in FIGURES:
    e=lambda key:html.escape(str(x[key]),quote=True)
    cards.append(f'<article class="{e("prioritas")}"><small>{e("prioritas").upper()}</small><h2>{e("title")}</h2>'
        f'<a href="{e("path")}"><img loading="lazy" src="{e("path")}" alt="{e("title")}"></a>'
        f'<p>{e("caption")}</p><p class="talk"><b>Narasi:</b> {e("narasi")}</p>'
        f'<a href="{e("path")}">Buka PNG</a>'+ (f' · <a href="{e("svg")}">Buka SVG</a>' if x['svg'] else '')+'</article>')
page='''<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PisangLENS · Paket pitching E03 Large</title><style>
*{box-sizing:border-box}body{margin:0;background:#edf3f4;color:#17384b;font:16px/1.6 system-ui,sans-serif}
header,main{max-width:1200px;margin:auto;padding:32px}header{padding-top:52px}h1{font-size:38px;line-height:1.15}
nav a,.pill{display:inline-block;background:white;padding:8px 14px;border-radius:8px;margin:5px}a{color:#007e73}
.intro{font-size:18px;max-width:900px}.metric{display:flex;gap:18px;flex-wrap:wrap}.pill b{font-size:28px;display:block}
article{background:white;padding:28px;margin:0 0 28px;border-radius:14px;border:1px solid #d8e4e6}
article img{display:block;width:100%;height:auto;background:white}small{color:#008579;font-weight:bold;letter-spacing:.12em}
h2{font-size:24px;margin:8px 0 20px}.talk{border-left:4px solid #008579;padding-left:14px;background:#f3f8f7}
.note{background:#fff2d8;padding:15px;border-radius:8px}@media(max-width:650px){header,main{padding:18px}article{padding:15px}h1{font-size:29px}}
</style><header><small>PISANGLENS · E03_LARGE_SEED42</small><h1>Visual untuk pitching ke mentor</h1>
<p class="intro">12 visual utama, plot pendukung, gambar raw dan augmentasi, seluruh misklasifikasi, serta data sumber.
Semua evaluasi berasal dari artefak tersimpan. Tidak ada training atau inferensi ulang.</p>
<div class="metric"><span class="pill"><b>98,52%</b>Akurasi test internal</span><span class="pill"><b>97,94%</b>Macro-F1 test internal</span>
<span class="pill"><b>133 / 135</b>Prediksi benar sebelum policy</span></div>
<p class="note">Bukti masih internal. Dua kesalahan argmax: satu ditandai tidak yakin, satu tetap diterima policy.
Foto lapangan, input di luar empat kelas, dan benchmark perangkat target belum tersedia.</p>
<nav><a href="BACA_DULU.txt">Petunjuk & urutan singkat</a><a href="CATATAN_REVIEW_MENTOR.txt">Review untuk mentor</a>
<a href="07_DATA_DAN_SUMBER/indeks_plot_dan_narasi.csv">Indeks plot & narasi</a>
<a href="05_MISKLASIFIKASI/semua_misklasifikasi_test.csv">Data misklasifikasi</a>
<a href="07_DATA_DAN_SUMBER/indeks_gambar.csv">Indeks gambar individual</a></nav>
<p>Pitching 5 menit: pilih visual utama 01, 02, 03, 05, 06, 08, dan 12. PNG utama berukuran 2880×1620; SVG tersedia untuk edit.</p>
</header><main>'''+''.join(cards)+'''</main></html>'''
(ROOT/'KATALOG_PITCHING.html').write_text(page)

# Kontak visual ringan untuk inspeksi dan pemilihan cepat.
thumb_w,thumb_h=640,360
contact=Image.new('RGB',(thumb_w*3,thumb_h*4),'#EDF3F4')
for i,x in enumerate([x for x in FIGURES if x['prioritas']=='utama']):
    im=Image.open(ROOT/x['path']).convert('RGB').resize((thumb_w,thumb_h),Image.Resampling.LANCZOS)
    contact.paste(im,((i%3)*thumb_w,(i//3)*thumb_h))
contact.save(ROOT/'PRATINJAU_12_VISUAL.png')
for x in FIGURES:
    p=ROOT/x['path']
    with Image.open(p) as im:
        im.verify()
    if x['prioritas']=='utama':check('Ukuran PNG utama 2880x1620: '+p.name,Image.open(p).size==(2880,1620))
for x in IMAGES: check('Gambar individual 224x224: '+x['file'],(x['width'],x['height'])==(224,224))
for x in FIGURES:
    check('File plot tersedia: '+x['path'],(ROOT/x['path']).exists())
    if x['svg']:check('SVG tersedia: '+x['svg'],(ROOT/x['svg']).exists())
(DATA/'manifest_sumber_sha256.json').write_text(json.dumps(SOURCES,indent=2,ensure_ascii=False)+'\n')
audit={'status':'passed','checks':CHECKS,'selected_run':selection['selected_run'],
    'checkpoint_sha256':selection['checkpoint_sha256'],'training_or_inference_rerun':False,
    'main_figures':sum(x['prioritas']=='utama' for x in FIGURES),
    'supporting_figures':sum(x['prioritas']=='pendukung' for x in FIGURES),
    'image_files':len(IMAGES),'misclassified_test_images':len(errors),
    'augmentation_provenance':'Regenerated preview using extracted augment_pil and E03 resolved config; train only',
    'runtime':{'torch':torch.__version__,'torchvision':torchvision.__version__},
    'source_runtime':config['runtime'],
    'limitations':['Internal test only','Capture independence unverified','One unreviewed near-duplicate candidate across train-validation',
        'Validation reused for selection, calibration, and policy','Synthetic stress is not field validation',
        'Preview pixel values can differ across torchvision versions']}
(DATA/'audit_verifikasi.json').write_text(json.dumps(audit,indent=2,ensure_ascii=False)+'\n')
archive=ROOT.parent/'pitching_E03_Large.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for p in sorted(ROOT.rglob('*')):
        if p.is_file() and '__pycache__' not in p.parts:z.write(p,Path(ROOT.name)/p.relative_to(ROOT))
with zipfile.ZipFile(archive) as z:check('ZIP lolos CRC',z.testzip() is None)
print(json.dumps({'output':str(ROOT),'zip':str(archive),'zip_mb':round(archive.stat().st_size/1e6,2),
    'main':audit['main_figures'],'supporting':audit['supporting_figures'],'individual_images':len(IMAGES),
    'checks':len(CHECKS),'status':'passed'},indent=2))
