import assert from 'node:assert/strict';
import { predictMock as predict, setPredictionScenario } from '../public/js/predict-mock.js';
import { predict as predictReal } from '../public/js/predict.js';
import { consultationEligible } from '../public/js/consultations.js';
import { USE_MOCK_PREDICTION, MOCK_PREDICTION_LABEL, CONFIDENCE_THRESHOLD } from '../public/js/config.js';

assert.equal(USE_MOCK_PREDICTION, false);
assert.equal(CONFIDENCE_THRESHOLD, 0.8);
assert.equal(consultationEligible({ predicted_class: 'Healthy', confidence_score: 0.8 }), false);
assert.equal(consultationEligible({ predicted_class: 'Healthy', confidence_score: 0.799999 }), true);
assert.equal(MOCK_PREDICTION_LABEL, 'Simulasi prediksi — bukan hasil analisis foto');
const canvas = { width: 224, height: 224 };
const defaultResult = await predict(canvas);
assert.equal(defaultResult.class_name, 'Healthy');
assert.deepEqual(await predict({ width: 800, height: 400 }), defaultResult);
console.log('PASS: default mock is deterministic and independent of image dimensions');
for (const [scenario, label, score, eligible] of [
    ['healthy', 'Healthy', .94, false],
    ['disease', 'Sigatoka', .88, true],
    ['low', 'Cordana Leaf Spot', .64, true],
]) {
    setPredictionScenario(scenario);
    const result = await predict(canvas);
    assert.deepEqual(result, {class_name: label, confidence_score: score, prediction_source: 'mock', model_version: 'phase-1-mock'});
    assert.equal(consultationEligible({predicted_class: label, confidence_score: score}), eligible);
    console.log('PASS: internal ' + scenario + ' fixture and consultation eligibility');
}
setPredictionScenario('failure');
await assert.rejects(predict(canvas), /gagal/);
setPredictionScenario('healthy');
await assert.rejects(predict({width: 0, height: 0}), /Foto belum tersedia/);
assert.deepEqual(await predict(canvas), defaultResult);
console.log('PASS: error fixture, missing image rejection and default restoration');
await assert.rejects(predictReal({ width: 0, height: 0 }), /Foto belum tersedia/);
const pixels = new Uint8ClampedArray(224 * 224 * 4).fill(128);
for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
globalThis.fetch = async () => { throw new Error('Intentional unavailable model asset'); };
await assert.rejects(predictReal({ width: 224, height: 224, getContext: () => ({ getImageData: () => ({ width: 224, height: 224, data: pixels }) }) }), /Analisis AI lokal gagal/);
console.log('PASS: real model failures reject without simulation fallback');
