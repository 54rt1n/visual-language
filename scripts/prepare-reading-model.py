"""Build an isolated, smaller G2pW candidate from the hash-pinned official ONNX.

The conditional heads store values for every phoneme, although the upstream
per-character phoneme mask always excludes almost all of them. Retain only that
character's candidate columns, gather compact rows, and scatter into the original
output shape. This packing is exact under the upstream candidate-mask contract.
Optional int4 conversion is lossy and must be evaluated separately.

No downloads, corpus-based corrections, credential access or application writes.
"""
import argparse
import hashlib
import json
import logging
import pathlib
import sys


def digest(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--packages', type=pathlib.Path)
    parser.add_argument('--model', type=pathlib.Path, required=True)
    parser.add_argument('--model-data', type=pathlib.Path, required=True)
    parser.add_argument('--out', type=pathlib.Path, required=True)
    parser.add_argument('--int4', action='store_true')
    args = parser.parse_args()
    if args.out.exists():
        raise FileExistsError('Refusing to overwrite a model.')
    if digest(args.model) != 'bb40c8c7b5baa755b2acd317c6bc5a65e4af7b80c40a569247fbd76989299999':
        raise ValueError('Only the pinned official G2PW v2 ONNX model is supported.')
    if args.packages:
        sys.path.insert(0, str(args.packages.resolve()))
    import numpy as np
    import onnx
    from onnx import helper, numpy_helper

    poly_path = args.model_data / 'POLYPHONIC_CHARS.txt'
    if digest(poly_path) != 'b63cd02d842dbaea32ca55b3fbbdef986a617854967cc2fb9ec1f2126715b747':
        raise ValueError('The label inventory does not match the pinned model.')
    entries = [line.split('\t') for line in poly_path.read_text(encoding='utf-8').strip().split('\n')]
    labels = sorted({sound for char, sound in entries})
    chars = sorted({char for char, sound in entries})
    choices = {char: sorted({labels.index(sound) for c, sound in entries if c == char}) for char in chars}
    if len(labels) != 1305 or len(chars) != 3582:
        raise ValueError('Unexpected v2 label inventory.')
    width = max(map(len, choices.values()))
    indices = np.zeros((len(chars), width), dtype=np.int64)
    for i, char in enumerate(chars):
        # Padding must NOT overwrite a real candidate during ScatterElements.
        unused = next(index for index in range(len(labels)) if index not in choices[char])
        indices[i, :] = unused
        indices[i, :len(choices[char])] = choices[char]
    model = onnx.load(str(args.model))
    names = {'char_descriptor.weight': 1, 'second_order_descriptor.weight': 11}
    new_weights, savings = [], {}
    for weight in model.graph.initializer:
        if weight.name not in names:
            continue
        multiplier = names[weight.name]
        dense = numpy_helper.to_array(weight)
        if dense.shape != (len(chars) * multiplier, len(labels)):
            raise ValueError('Unexpected conditional-head shape.')
        packed = np.zeros((dense.shape[0], width), dtype=np.float32)
        for char_id, char in enumerate(chars):
            for pos_id in range(multiplier):
                row = char_id * multiplier + pos_id
                packed[row, :len(choices[char])] = dense[row, choices[char]]
        new_weights.append(numpy_helper.from_array(packed, weight.name + '.vl_packed'))
        savings[weight.name] = {'fromBytes': dense.nbytes, 'toBytes': packed.nbytes}
    if len(new_weights) != 2:
        raise ValueError('Both expected conditional heads must exist.')
    new_nodes = [helper.make_node('Gather', ['vl_candidate_columns', 'char_ids'], ['vl_selected_columns'], axis=0, name='vl_candidate_indices_gather'),
                 helper.make_node('Mul', ['phoneme_mask', 'vl_zero'], ['vl_empty_phonemes'])]
    counts = {name: 0 for name in names}
    for node in model.graph.node:
        referenced = set(node.input).intersection(names)
        if not referenced:
            new_nodes.append(node)
            continue
        if len(referenced) != 1 or node.op_type != 'Gather' or node.input[0] not in names or len(node.output) != 1:
            raise ValueError('Unexpected use of a packed conditional weight.')
        name = node.input[0]; counts[name] += 1
        output = node.output[0]
        rewritten = onnx.NodeProto(); rewritten.CopyFrom(node)
        rewritten.input[0] = name + '.vl_packed'; rewritten.output[0] = output + '.vl_values'
        new_nodes += [rewritten, helper.make_node('ScatterElements', ['vl_empty_phonemes', 'vl_selected_columns', output + '.vl_values'], [output], axis=1)]
    if any(count != 1 for count in counts.values()):
        raise ValueError('Unexpected conditional-head consumer count.')
    retained = [weight for weight in model.graph.initializer if weight.name not in names]
    del model.graph.initializer[:]
    model.graph.initializer.extend(retained + new_weights + [numpy_helper.from_array(indices, 'vl_candidate_columns'), numpy_helper.from_array(np.array(0, dtype=np.float32), 'vl_zero')])
    del model.graph.node[:]; model.graph.node.extend(new_nodes)
    model.doc_string += '\nVisual Language diagnostic derivative: packed masked conditional tables; ' + ('int4 block32 symmetric weight quantization.' if args.int4 else 'float32 retained.')
    onnx.checker.check_model(model)
    if args.int4:
        from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer
        logging.getLogger().setLevel(logging.ERROR)
        model = onnx.version_converter.convert_version(model, 21)
        # These are integer INDEXES, not floating weights. ORT's generic Gather
        # quantizer otherwise produces an invalid int64 scale tensor for them.
        quantizer = MatMulNBitsQuantizer(model, block_size=32, is_symmetric=True, accuracy_level=4,
                                        op_types_to_quantize=('MatMul', 'Gather'), nodes_to_exclude=['vl_candidate_indices_gather'])
        quantizer.process(); model = quantizer.model.model
        onnx.checker.check_model(model)
    with args.out.open('xb') as target:
        onnx.save_model(model, target)
    print(json.dumps({'file': args.out.name, 'sha256': digest(args.out), 'bytes': args.out.stat().st_size, 'maxCandidates': width, 'packedHeads': savings,
                      'quantized': args.int4, 'onnxVersion': onnx.__version__, 'sourceSha256': digest(args.model), 'labelsSha256': digest(poly_path)}, indent=2))


if __name__ == '__main__':
    main()
