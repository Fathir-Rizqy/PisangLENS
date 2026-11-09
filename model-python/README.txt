PAKET INFERENCE — E03 MOBILENETV3-LARGE SEED 42
============================================

Folder ini dapat dipindah atau disalin sebagai satu kesatuan. Inference berjalan
offline setelah dependensi terpasang; tidak memerlukan notebook atau dataset asli.
Bobot yang disertakan adalah state_dict inferensi (tanpa optimizer), sekitar 17 MB.

PAKAI DARI ROOT HACKATHON (environment yang sekarang)

  .venv/bin/python MobileNetV3/model_terbaik_E03_Large_seed42/inference.py /path/daun.jpg

COBA LANGSUNG DENGAN GAMBAR CONTOH

  .venv/bin/python MobileNetV3/model_terbaik_E03_Large_seed42/inference.py MobileNetV3/model_terbaik_E03_Large_seed42/examples/contoh_cordana.png

DI KOMPUTER LAIN

Gunakan Python 3.12 atau lebih baru. Masuk ke folder paket ini, lalu:

  python -m venv .venv
  source .venv/bin/activate
  python -m pip install -r requirements.txt
  python inference.py /path/daun.jpg

Perintah aktivasi di atas untuk Linux/macOS; Windows memakai .venv\Scripts\activate.
Versi dependensi dipatok sesuai environment CPU yang telah diuji. Build CUDA dapat
dipasang sesuai perangkat jika ingin memakai --device cuda; GPU belum diuji ulang
dalam proses pemaketan ini. Default inference memakai CPU.

BEBERAPA GAMBAR DAN OUTPUT JSON

  python inference.py daun1.jpg daun2.png --batch-size 8 --output hasil.json
  python inference.py daun.jpg --device cpu --threads 4

Path gambar dan --output relatif terhadap folder tempat perintah dijalankan.
Path bobot/config selalu relatif terhadap inference.py. Output yang sudah ada
dapat diganti selama bukan aset paket atau gambar input.

DIPANGGIL DARI PYTHON (dari root Hackathon)

  from MobileNetV3.model_terbaik_E03_Large_seed42 import Predictor

  predictor = Predictor(device="cpu")
  hasil = predictor.predict("/path/daun.jpg")
  print(hasil["decision"], hasil["confidence"])

predict() juga menerima PIL.Image. Muat Predictor satu kali dan pakai kembali.
predict_many([path1, path2]) memproses satu batch; batasi jumlah gambar sesuai RAM.
predictor.preprocess(image) menyediakan tensor [3,224,224] yang sudah dinormalisasi.

ARTI OUTPUT

  predicted_label_id : indeks argmax 0–3.
  predicted_label    : kelas argmax, termasuk ketika keputusan uncertain.
  confidence         : probabilitas kelas argmax setelah temperature scaling.
  policy_status      : supported_prediction atau uncertain.
  decision           : label jika lolos threshold, selain itu "uncertain".
  probabilities      : probabilitas terkalibrasi semua kelas (rentang 0–1).
  probabilities_raw  : softmax tanpa temperature scaling.
  logits             : output mentah model sebelum softmax.

Untuk keputusan aplikasi, gunakan decision/policy_status. Jika uncertain, minta
foto yang lebih jelas atau tinjauan pengguna; predicted_label tetap hanya argmax.

LABEL DAN PREPROCESSING

  0 = cordana
  1 = healthy
  2 = pestalotiopsis
  3 = sigatoka

  1. Koreksi orientasi EXIF dan konversi RGB.
  2. Direct resize ke 224×224 dengan bilinear antialias, tanpa center crop.
  3. Ubah menjadi tensor float32 CHW dengan piksel 0–1.
  4. Normalisasi satu kali: mean [0.485,0.456,0.406], std [0.229,0.224,0.225].
  5. Forward model eval() dengan float32; tidak memakai augmentasi inference.
  6. probabilities = softmax(logits / 1.3768672768090888).
  7. Terima healthy bila confidence >= 0.80; penyakit lain >= 0.50.

Jangan memakai transform default bobot ImageNet yang melakukan crop, atau melakukan
normalisasi kedua kali. preprocessing.py sudah menangani langkah 1–4.

ISI PAKET

  model_state_dict.pt       Bobot inferensi E03 Large seed 42.
  model_config.json         Arsitektur, jumlah kelas, dropout.
  preprocessing.json       Konfigurasi preprocessing khusus inference.
  preprocessing.py         Implementasi preprocessing yang dapat dipakai ulang.
  label_mapping.json       Mapping asli nama kelas -> ID.
  inference_contract.json  Kontrak input/output asli dari handoff.
  calibration.json         Temperature yang dipasang pada validation.
  decision_policy.json     Threshold healthy/disease dari validation.
  inference.py             CLI dan kelas Predictor.
  metadata.json            Identitas model, hash sumber, dan metrik evaluasi.
  requirements.txt         Dependensi runtime yang telah diuji.
  checksums.json           SHA-256 aset dan kode paket.
  verify_package.py        Verifikasi checksum dan hasil gambar referensi.
  verification_report.json Hasil verifikasi penuh saat pemaketan.
  examples/                Tiga contoh dari test lama, bukan holdout baru.

VERIFIKASI SETELAH MENYALIN FOLDER

  python verify_package.py

Script memeriksa hash, kesesuaian logit/confidence dengan evaluasi asli, policy
uncertain, batch vs single, grayscale, RGBA, serta orientasi EXIF. Toleransi numerik
memperhitungkan perbedaan CPU dan lingkungan GPU asal. Jangan mengubah label mapping,
temperature, atau preprocessing tanpa memperbarui dan memvalidasi paket.

Saat pemaketan, seluruh 135 prediksi test dan keputusan policy cocok dengan hasil
asli. Seluruh 25 tensor preprocessing referensi cocok persis, termasuk input
grayscale, RGBA, portrait/landscape, dan EXIF. Selisih logit maksimum pada test
sekitar 0.0000391 akibat lingkungan numerik yang berbeda. Rincian pengujian ada
di verification_report.json. Pemaketan tidak melatih atau memilih ulang model.

HASIL MODEL DAN BATAS PENGGUNAAN

Macro-F1 validation mean 3 seed: 98.27%. Akurasi test seed 42: 98.52% (133/135),
macro-F1 test 97.94%. Hasil masih terbatas pada dataset internal; evaluasi lapangan
Indonesia dan deteksi gambar di luar cakupan belum tersedia. Healthy berarti tidak
teridentifikasi tiga penyakit daun yang didukung, bukan jaminan seluruh tanaman sehat.
Gambar blur berat menurunkan performa. Policy confidence belum mendeteksi input
yang bukan daun pisang atau penyakit di luar empat kelas ini.
