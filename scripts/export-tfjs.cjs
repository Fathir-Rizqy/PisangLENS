// Supported TF.js Layers API + model.save(IOHandler), with original FP32 weights.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const tf = require(process.env.TFJS_PACKAGE || '@tensorflow/tfjs');
const root = path.resolve(__dirname, '..');
const work = process.argv[2] || '/tmp/pisanglens-export';
const output = process.argv[3] || path.join(root, 'conversion/e03-large-seed42-fp32');

async function main() {
    const { registerModelLayers } = await import(pathToFileURL(path.join(root, 'public/js/model-layers.js')));
    registerModelLayers(tf);
    const { architecture, weights, metadata } = JSON.parse(fs.readFileSync(path.join(work, 'architecture.json')));
    const bytes = fs.readFileSync(path.join(work, 'source-weights.bin'));
    let offset = 0;
    const values = weights.map(spec => {
        const raw = bytes.subarray(offset, offset + spec.bytes); offset += spec.bytes;
        return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    });
    function apply(node, input) {
        const config = { name: node.name };
        let layer;
        switch (node.kind) {
        case 'sequence': return node.children.reduce((x, child) => apply(child, x), input);
        case 'residual': {
            const x = apply(node.block, input);
            return node.residual ? tf.layers.add(config).apply([input, x]) : x;
        }
        case 'conv': case 'depthwise': {
            if (node.padding.some(p => p !== 0)) input = tf.layers.zeroPadding2d({ padding: [[node.padding[0], node.padding[0]], [node.padding[1], node.padding[1]]], name: node.name + '_pad' }).apply(input);
            const options = { ...config, kernelSize: node.kernel, strides: node.strides, padding: 'valid', useBias: node.bias };
            layer = node.kind === 'conv' ? tf.layers.conv2d({ ...options, filters: node.filters }) : tf.layers.depthwiseConv2d({ ...options, depthMultiplier: 1 });
            break;
        }
        case 'bn': layer = tf.layers.batchNormalization({ ...config, epsilon: node.epsilon, axis: -1 }); break;
        case 'dense': layer = tf.layers.dense({ ...config, units: node.units }); break;
        case 'relu': return tf.layers.reLU(config).apply(input);
        case 'dropout': return tf.layers.dropout({ ...config, rate: node.rate }).apply(input);
        case 'hardSwish': {
            const Layer = tf.serialization.SerializationMap.getMap().classNameMap.PisangHardSwish[0];
            return new Layer(config).apply(input);
        }
        case 'se': {
            let scale = tf.layers.globalAveragePooling2d({ name: node.name + '_pool' }).apply(input);
            scale = tf.layers.reshape({ name: node.name + '_reshape', targetShape: [1, 1, input.shape[3]] }).apply(scale);
            scale = tf.layers.reLU({ name: node.name + '_relu' }).apply(apply(node.fc1, scale));
            scale = apply(node.fc2, scale);
            const Layer = tf.serialization.SerializationMap.getMap().classNameMap.PisangHardSigmoid[0];
            scale = new Layer({ name: node.name + '_gate' }).apply(scale);
            return tf.layers.multiply(config).apply([input, scale]);
        }
        default: throw new Error('Unsupported layer ' + node.kind);
        }
        const result = layer.apply(input);
        const tensors = node.weights.map(i => tf.tensor(values[i], weights[i].shape, 'float32'));
        layer.setWeights(tensors); tensors.forEach(t => t.dispose());
        return result;
    }
    const input = tf.input({ name: 'rgb_normalized', shape: [224, 224, 3], dtype: 'float32' });
    let result = apply(architecture.features, input);
    result = tf.layers.globalAveragePooling2d({ name: 'avgpool' }).apply(result);
    result = apply(architecture.classifier, result);
    const model = tf.model({ inputs: input, outputs: result, name: 'pisanglens_e03_large_seed42' });
    fs.mkdirSync(output, { recursive: true });
    await model.save(tf.io.withSaveHandler(async artifacts => {
        const data = Buffer.from(artifacts.weightData), shardSize = 4 * 1024 * 1024;
        const count = Math.ceil(data.length / shardSize), paths = [];
        for (let i = 0; i < count; i++) {
            const name = `group1-shard${i + 1}of${count}.bin`;
            fs.writeFileSync(path.join(output, name), data.subarray(i * shardSize, (i + 1) * shardSize)); paths.push(name);
        }
        fs.writeFileSync(path.join(output, 'model.json'), JSON.stringify({ format: 'layers-model', generatedBy: 'TensorFlow.js 4.22.0', convertedBy: 'PisangLENS exact torchvision FP32 weight transfer', modelTopology: artifacts.modelTopology, weightsManifest: [{ paths, weights: artifacts.weightSpecs }], userDefinedMetadata: metadata }));
        fs.writeFileSync(path.join(output, 'labels.json'), JSON.stringify(metadata.labels, null, 2));
        fs.writeFileSync(path.join(output, 'metadata.json'), JSON.stringify({ ...metadata, weight_bytes: data.length, shards: paths }, null, 2));
        return { modelArtifactsInfo: tf.io.getModelArtifactsInfoForJSON(artifacts) };
    }));
    const assets = ['model.json', 'metadata.json', 'labels.json', ...JSON.parse(fs.readFileSync(path.join(output, 'metadata.json'))).shards];
    const files = assets.map(name => { const data = fs.readFileSync(path.join(output, name)); return { path: name, bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') }; });
    fs.writeFileSync(path.join(output, 'assets.json'), JSON.stringify({ model_version: metadata.model_version, files }, null, 2));
    console.log(JSON.stringify({ output, layers: model.layers.length, parameters: model.countParams(), weight_bytes: files.filter(x => x.path.endsWith('.bin')).reduce((n, f) => n + f.bytes, 0) }));
    model.dispose();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
