// Explicit test simulation; never selected after a real inference failure.
let scenario = 'healthy';
const scenarios = { healthy: ['Healthy', 0.94], disease: ['Sigatoka', 0.88], low: ['Cordana Leaf Spot', 0.64] };
export function setPredictionScenario(value) { scenario = value; }
export async function predictMock(canvas) {
    if (!canvas?.width || !canvas?.height) throw new Error('Foto belum tersedia.');
    if (!Object.hasOwn(scenarios, scenario)) throw new Error('Simulasi prediksi gagal.');
    const [class_name, confidence_score] = scenarios[scenario];
    return { class_name, confidence_score, prediction_source: 'mock', model_version: 'phase-1-mock' };
}
