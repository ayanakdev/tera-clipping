import * as ort from 'onnxruntime-node';

const s = await ort.InferenceSession.create('tools/models/face_detection_yunet_2023mar.onnx');
console.log(JSON.stringify({ inputs: s.inputNames, outputs: s.outputNames, inputMeta: s.inputMetadata, outputMeta: s.outputMetadata }, null, 2));
process.exit(0);
