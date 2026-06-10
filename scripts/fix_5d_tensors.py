# (c) City96 || Apache-2.0 — bundled for guIDE sd.cpp 5D GGUF compatibility
import os
import gguf
import torch
import argparse
from tqdm import tqdm
from safetensors.torch import load_file


def get_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--src", required=True)
    parser.add_argument("--dst", required=True)
    parser.add_argument("--fix", required=False, help="Defaults to ./fix_5d_tensors_[arch].safetensors")
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()

    if not os.path.isfile(args.src):
        parser.error(f"Invalid source file '{args.src}'")
    if not args.overwrite and os.path.exists(args.dst):
        parser.error(f"Output exists, use '--overwrite' ({args.dst})")

    return args


def get_arch_str(reader):
    field = reader.get_field("general.architecture")
    return str(field.parts[field.data[-1]], encoding="utf-8")


def get_file_type(reader):
    field = reader.get_field("general.file_type")
    part = field.parts[field.data[-1]]
    ft = int(part.item()) if hasattr(part, "item") else int(part)
    return gguf.LlamaFileType(ft)


if __name__ == "__main__":
    args = get_args()

    reader = gguf.GGUFReader(args.src)
    arch = get_arch_str(reader)
    file_type = get_file_type(reader)
    print(f"Detected arch: '{arch}' (ftype: {str(file_type)})")

    if args.fix is None:
        args.fix = f"./fix_5d_tensors_{arch}.safetensors"

    if not os.path.isfile(args.fix):
        raise OSError(f"No 5D tensor fix file: {args.fix}")

    sd5d = load_file(args.fix)
    sd5d = {k: v.numpy() for k, v in sd5d.items()}
    print("5D tensors:", list(sd5d.keys()))

    writer = gguf.GGUFWriter(path=None, arch=arch)
    writer.add_quantization_version(gguf.GGML_QUANT_VERSION)
    writer.add_file_type(file_type)

    added = []

    def add_extra_key(writer, key, data):
        global added
        data_qtype = gguf.GGMLQuantizationType.F32
        data = gguf.quants.quantize(data, data_qtype)
        tqdm.write(f"Adding key {key} ({data.shape})")
        writer.add_tensor(key, data, raw_dtype=data_qtype)
        added.append(key)

    skip_names = set(sd5d.keys())
    for tensor in tqdm(reader.tensors):
        if tensor.name in skip_names:
            continue
        writer.add_tensor(tensor.name, tensor.data, raw_dtype=tensor.tensor_type)
        key5d = tensor.name.replace(".bias", ".weight")
        if key5d in sd5d.keys() and key5d not in skip_names:
            add_extra_key(writer, key5d, sd5d[key5d])
            skip_names.add(key5d)

    for key, data in sd5d.items():
        if key not in added:
            add_extra_key(writer, key, data)

    writer.write_header_to_file(path=args.dst)
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file(progress=True)
    writer.close()
    print(f"Wrote fixed GGUF: {args.dst}")
