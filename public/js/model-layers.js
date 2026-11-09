// Exact torchvision activations. Keras' hardSigmoid uses a different slope.
export function registerModelLayers(tf) {
    if (tf.serialization.SerializationMap.getMap().classNameMap.PisangHardSwish) return;
    class PisangHardSwish extends tf.layers.Layer {
        static className = 'PisangHardSwish';
        call(inputs) { return tf.tidy(() => { const x = Array.isArray(inputs) ? inputs[0] : inputs; return x.mul(x.add(3).clipByValue(0, 6).div(6)); }); }
        computeOutputShape(shape) { return shape; }
    }
    class PisangHardSigmoid extends tf.layers.Layer {
        static className = 'PisangHardSigmoid';
        call(inputs) { return tf.tidy(() => { const x = Array.isArray(inputs) ? inputs[0] : inputs; return x.add(3).clipByValue(0, 6).div(6); }); }
        computeOutputShape(shape) { return shape; }
    }
    tf.serialization.registerClass(PisangHardSwish);
    tf.serialization.registerClass(PisangHardSigmoid);
}
