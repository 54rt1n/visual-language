"""Isolated G2pW evaluation; never imported by the application.

Requires local ONNX models, the pinned BERT vocabulary, upstream label data,
numpy, transformers (tokenizer only) and onnxruntime. No network/downloads or
credentials. Input preparation follows G2pW's 32-character window and official
BertTokenizer. Python str.splitlines() is NOT a valid BERT vocabulary parser:
Unicode separators inside tokens shift thousands of token IDs.
"""
import argparse
import hashlib
import json
import pathlib
import re
import sys
import time


def digest(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--packages', type=pathlib.Path, help='Optional isolated Python package directory; no package installation occurs.')
    parser.add_argument('--model', type=pathlib.Path, action='append', required=True)
    parser.add_argument('--model-data', type=pathlib.Path, required=True, help='Directory containing POLYPHONIC_CHARS.txt from the official v2 model.')
    parser.add_argument('--upstream-data', type=pathlib.Path, required=True, help='The upstream g2pw directory containing S2T and romanization data; no Python code is executed.')
    parser.add_argument('--vocab', type=pathlib.Path, required=True)
    parser.add_argument('--corpus', type=pathlib.Path, default=pathlib.Path('tests/evaluation/reading-pronunciation.json'))
    parser.add_argument('--out', type=pathlib.Path, required=True, help='New report path, never overwritten.')
    parser.add_argument('--inputs-out', type=pathlib.Path, help='New input-vector report for identical browser verification.')
    args = parser.parse_args()
    if args.packages:
        sys.path.insert(0, str(args.packages.resolve()))
    import numpy as np
    import onnxruntime as ort
    from transformers import BertTokenizer

    if digest(args.vocab) != '45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c':
        raise ValueError('The vocabulary is not the pinned google-bert/bert-base-chinese artifact.')
    corpus = json.loads(args.corpus.read_text(encoding='utf-8'))
    if corpus['version'] != 'reading-pronunciation-v1' or corpus['annotationStatus'] != 'project-authored-provisional':
        raise ValueError('Unsupported reading corpus version or annotation status.')
    if len({case['id'] for case in corpus['cases']}) != len(corpus['cases']):
        raise ValueError('Duplicate case IDs.')
    tokenizer = BertTokenizer(vocab_file=str(args.vocab), do_lower_case=True)
    if tokenizer.convert_tokens_to_ids(['[CLS]', '[SEP]', '你', '得', '地', '還']) != [101, 102, 872, 2533, 1765, 6917]:
        raise ValueError('Tokenizer sentinel IDs differ from the pinned vocabulary.')
    poly_path = args.model_data / 'POLYPHONIC_CHARS.txt'
    s2t_path = args.upstream_data / 'bert-base-chinese_s2t_dict.txt'
    roman_path = args.upstream_data / 'bopomofo_to_pinyin_wo_tune_dict.json'
    for path, expected_hash in [(poly_path, 'b63cd02d842dbaea32ca55b3fbbdef986a617854967cc2fb9ec1f2126715b747'),
                               (s2t_path, '394822822c43f53adc258aaf7feca6e8bd82a84ff7d02ee4a6adcf70b572f447'),
                               (roman_path, '0fe90e26be7653023772b3ad2d08952961bbf295fb39ba685c7172d3d9769f52')]:
        if digest(path) != expected_hash:
            raise ValueError('Upstream pronunciation data does not match the pinned artifacts.')
    poly = [line.split('\t') for line in poly_path.read_text(encoding='utf-8').strip().split('\n')]
    labels = sorted({sound for char, sound in poly})
    char2phonemes = {}
    for char, sound in poly:
        char2phonemes.setdefault(char, []).append(labels.index(sound))
    chars = sorted(char2phonemes)
    if len(labels) != 1305 or len(chars) != 3582:
        raise ValueError('Label inventory is not the expected v2 phoneme-label model.')
    s2t = dict(line.split('\t') for line in s2t_path.read_text(encoding='utf-8').strip().split('\n'))
    roman = json.loads(roman_path.read_text(encoding='utf-8'))
    sounds = [roman.get(sound[:-1], sound[:-1]) + sound[-1] for sound in labels]
    inputs, cases = [], []
    for case in corpus['cases']:
        pieces = case['marked'].split('▁')
        if len(pieces) != 3 or len(pieces[1]) != 1 or len(case['marked']) > 200:
            raise ValueError('Each bounded case must mark exactly one character.')
        before, target, after = pieces
        source, query = before + target + after, len(before)
        text = ''.join(s2t.get(char, char) for char in source).lower()
        if len(text) != len(source) or text[query] not in char2phonemes:
            raise ValueError('Case needs length-preserving conversion and a supported polyphonic target.')
        begin, end = max(0, query - 16), min(len(text), query + 16)
        context = text[begin:end]
        tokens, text2token = [], [None] * len(context)
        # Upstream groups ASCII letters/digits, skips ASCII spaces, and tokenizes
        # remaining characters separately. Preserve offsets through punctuation,
        # unknown tokens and supplementary Unicode. Do not retokenize whole text.
        for match in re.finditer(r'[a-zA-Z0-9]+|[^ ]', context):
            word_tokens = tokenizer.tokenize(match.group())
            if not word_tokens or word_tokens == ['[UNK]']:
                text2token[match.start():match.end()] = [len(tokens)] * len(match.group())
                tokens.append('[UNK]')
                continue
            offset = match.start()
            for token in word_tokens:
                length = len(token.removeprefix('##'))
                text2token[offset:offset + length] = [len(tokens)] * length
                tokens.append(token)
                offset += length
            if offset != match.end():
                raise ValueError('Tokenizer normalization changed an input span; do not guess its target offset.')
        query_token = text2token[query - begin]
        if query_token is None or tokens[query_token] != text[query]:
            raise ValueError('The marked character is not the selected model token.')
        ids = tokenizer.convert_tokens_to_ids(['[CLS]'] + tokens + ['[SEP]'])
        mask = np.zeros((1, len(labels)), dtype=np.float32)
        mask[0, char2phonemes[text[query]]] = 1
        feeds = {'input_ids': np.array([ids], dtype=np.int64), 'token_type_ids': np.zeros((1, len(ids)), dtype=np.int64),
                 'attention_mask': np.ones((1, len(ids)), dtype=np.int64), 'phoneme_mask': mask,
                 'char_ids': np.array([chars.index(text[query])], dtype=np.int64), 'position_ids': np.array([query_token + 1], dtype=np.int64)}
        start16 = len(before.encode('utf-16-le')) // 2
        cases.append({'id': case['id'], 'tag': case['tag'], 'text': source, 'target': target, 'start': start16,
                      'end': start16 + len(target.encode('utf-16-le')) // 2, 'expected': case['expected']})
        inputs.append(feeds)
    metadata = {'corpusVersion': corpus['version'], 'corpusHash': digest(args.corpus), 'annotationStatus': corpus['annotationStatus'], 'runnerSha256': digest(pathlib.Path(__file__)),
                'scope': corpus['scope'], 'dataHashes': {path.name: digest(path) for path in [args.vocab, poly_path, s2t_path, roman_path]}}
    # Reserve report paths exclusively before inference, retaining a clear running
    # marker if interrupted. A running/incomplete file is never acceptance evidence.
    with args.out.open('x', encoding='utf-8') as report_file:
        report = {'format': 'visual-language-reading-onnx-evaluation', 'version': 1, 'status': 'running', **metadata,
                  'runtime': {'python': sys.version.split()[0], 'onnxruntime': ort.__version__, 'browser': False, 'externalProviderCalls': 0}, 'models': []}
        report_file.write(json.dumps(report, ensure_ascii=False, indent=2) + '\n'); report_file.flush()
        if args.inputs_out:
            with args.inputs_out.open('x', encoding='utf-8') as input_file:
                json.dump({'format': 'visual-language-reading-onnx-inputs', 'version': 1, **metadata, 'sounds': sounds,
                           'cases': [{**case, 'feeds': {key: {'type': str(value.dtype), 'dims': list(value.shape), 'data': value.flatten().tolist()}
                                                     for key, value in feeds.items()}} for case, feeds in zip(cases, inputs)]}, input_file, ensure_ascii=False)
        for path in args.model:
            options = ort.SessionOptions(); options.intra_op_num_threads = 2
            started = time.monotonic()
            session = ort.InferenceSession(str(path), sess_options=options, providers=['CPUExecutionProvider'])
            load_ms = (time.monotonic() - started) * 1000
            results = []
            for case, feeds in zip(cases, inputs):
                started = time.monotonic(); probs = session.run([], feeds)[0][0]; elapsed = (time.monotonic() - started) * 1000
                if probs.shape != (len(labels),) or not np.isfinite(probs).all():
                    raise ValueError('Invalid model probability vector.')
                best = int(probs.argmax()); actual = sounds[best]
                results.append({**case, 'actual': actual, 'confidence': float(probs[best]), 'matches': actual == case['expected'], 'milliseconds': elapsed})
            model = {'file': path.name, 'sha256': digest(path), 'bytes': path.stat().st_size, 'loadMilliseconds': load_ms,
                     'total': len(results), 'matches': sum(row['matches'] for row in results), 'results': results}
            report['models'].append(model)
            print(json.dumps({key: value for key, value in model.items() if key != 'results'}, ensure_ascii=False), flush=True)
            print('Failures:', json.dumps([row for row in results if not row['matches']], ensure_ascii=False), flush=True)
            del session
        report['status'] = 'finished'
        report_file.seek(0); json.dump(report, report_file, ensure_ascii=False, indent=2); report_file.write('\n'); report_file.truncate()
    return 0 if all(model['matches'] == model['total'] for model in report['models']) else 1


if __name__ == '__main__':
    sys.exit(main())
