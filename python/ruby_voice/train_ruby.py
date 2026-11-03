"""Fine-tune a GPT-SoVITS v2Pro voice for Ruby, headlessly.

This drives the same pipeline as the project's Gradio WebUI, but as plain
subprocess calls so training can run unattended:

    1a  1-get-text.py           phoneme + BERT features
    1b  2-get-hubert-wav32k.py  self-supervised audio features (+ 2-get-sv.py for Pro)
    1c  3-get-semantic.py       semantic tokens
    2a  s2_train.py             SoVITS stage
    2b  s1_train.py             GPT stage

Run it with the ruby_voice venv; it invokes the gpt_sovits venv internally:

    .venv\\Scripts\\python.exe train_ruby.py

Prerequisite: build_dataset.py has produced dataset/ruby.list.

Version choice: v2Pro. The upstream README notes v1/v2/v2Pro cope with
average-quality training audio while v3/v4 do not, and Ruby's source clips are
band-limited to about 10 kHz. v2Pro also keeps v2's low VRAM cost, which the
4 GB RTX 2050 needs.
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

import yaml

RUBY_DIR = Path(__file__).resolve().parent
REPO = RUBY_DIR.parent / "gpt_sovits"
VENV_PYTHON = REPO / ".venv" / "Scripts" / "python.exe"
DATASET_LIST = RUBY_DIR / "dataset" / "ruby.list"
DATASET_WAVS = RUBY_DIR / "dataset" / "wavs"

EXP_NAME = "ruby"
VERSION = "v2Pro"
EXP_DIR = f"logs/{EXP_NAME}"

BERT_DIR = "GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large"
CNHUBERT_DIR = "GPT_SoVITS/pretrained_models/chinese-hubert-base"
SV_PATH = "GPT_SoVITS/pretrained_models/sv/pretrained_eres2netv2w24s4ep4.ckpt"
PRETRAINED_S2G = "GPT_SoVITS/pretrained_models/v2Pro/s2Gv2Pro.pth"
PRETRAINED_S2D = "GPT_SoVITS/pretrained_models/v2Pro/s2Dv2Pro.pth"
PRETRAINED_S1 = "GPT_SoVITS/pretrained_models/s1v3.ckpt"
S2_CONFIG = "GPT_SoVITS/configs/s2v2Pro.json"
S1_CONFIG = "GPT_SoVITS/configs/s1longer-v2.yaml"
SOVITS_WEIGHT_DIR = "SoVITS_weights_v2Pro"
GPT_WEIGHT_DIR = "GPT_weights_v2Pro"


def patch_upstream_for_single_gpu_windows() -> None:
    """Adapt upstream training scripts to one 4 GB GPU on Windows.

    Three changes, all applied idempotently so the vendored clone stays
    disposable and the reasoning lives in version control:

    1/2. Dataloader workers. Upstream targets large machines and spawns 4
    workers for SoVITS and at least 12 for the GPT validation loader. Each
    worker is a process that loads torch, which exhausts RAM here and fails
    with "WinError 1455: The paging file is too small". One worker is used
    rather than zero because these call sites pass persistent_workers=True,
    which PyTorch rejects when num_workers is 0.

    3. Distributed strategy. The GPT stage always wraps training in
    DDPStrategy, whose gloo backend cannot bind on Windows and dies with
    "makeDeviceForHostname(): unsupported gloo device". Distributed training is
    pointless on a single GPU, so Lightning picks the strategy itself.

    4. Bucket sampler. It decides whether to query the distributed process
    group based on CUDA being present rather than on distributed actually being
    initialized, so with a single-device strategy it raises "Default process
    group has not been initialized". Gate those calls on dist.is_initialized().
    """
    edits = {
        REPO / "GPT_SoVITS" / "s2_train.py": [("num_workers=4,", "num_workers=1,")],
        REPO / "GPT_SoVITS" / "AR" / "data" / "data_module.py": [
            ("num_workers=max(self.num_workers, 12),", "num_workers=self.num_workers,"),
            ("prefetch_factor=16,", "prefetch_factor=2,"),
        ],
        REPO / "GPT_SoVITS" / "s1_train.py": [
            (
                'strategy=DDPStrategy(process_group_backend="nccl" if platform.system() != "Windows" else "gloo")\n'
                "        if torch.cuda.is_available()\n"
                '        else "auto",',
                'strategy="auto",',
            ),
        ],
        REPO / "GPT_SoVITS" / "AR" / "data" / "bucket_sampler.py": [
            (
                "num_replicas = dist.get_world_size() if torch.cuda.is_available() else 1",
                "num_replicas = dist.get_world_size() if dist.is_initialized() else 1",
            ),
            (
                "rank = dist.get_rank() if torch.cuda.is_available() else 0",
                "rank = dist.get_rank() if dist.is_initialized() else 0",
            ),
        ],
    }
    for path, replacements in edits.items():
        source = path.read_text(encoding="utf-8")
        updated = source
        for old, new in replacements:
            updated = updated.replace(old, new)
        if updated != source:
            path.write_text(updated, encoding="utf-8")
            print(f"   patched {path.name} for single-GPU Windows training")


def run_step(label: str, script: str, extra_env: dict[str, str], args: list[str] | None = None) -> None:
    """Run one pipeline script inside the GPT-SoVITS repo, failing loudly."""
    env = os.environ.copy()
    env.update(extra_env)
    env["PYTHONPATH"] = f"{REPO}{os.pathsep}{REPO / 'GPT_SoVITS'}"
    env["PYTHONIOENCODING"] = "utf-8"
    # The preprocessing scripts shell out to ffmpeg to read audio; without this
    # they fail with WinError 2 and silently produce no features.
    ffmpeg_bin = REPO / "ffmpeg_bin"
    if ffmpeg_bin.is_dir():
        env["PATH"] = f"{ffmpeg_bin}{os.pathsep}{env.get('PATH', '')}"
    command = [str(VENV_PYTHON), "-s", script, *(args or [])]

    print(f"\n{'=' * 70}\n[{label}] {' '.join(command[1:])}\n{'=' * 70}", flush=True)
    result = subprocess.run(command, cwd=REPO, env=env)
    if result.returncode != 0:
        raise SystemExit(f"[{label}] failed with exit code {result.returncode}")


def merge_parts(opt_dir: Path, pattern: str, target: str, header: str | None = None) -> None:
    """Concatenate the per-GPU shard files the preprocessing scripts emit."""
    lines: list[str] = [header] if header else []
    shards = sorted(opt_dir.glob(pattern))
    if not shards:
        raise SystemExit(f"Expected {pattern} in {opt_dir}; preprocessing produced nothing.")
    for shard in shards:
        lines += shard.read_text(encoding="utf-8").strip("\n").split("\n")
        shard.unlink()
    (opt_dir / target).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"   merged {len(shards)} shard(s) -> {target} ({len(lines)} lines)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    # minmem // 2 is what the WebUI itself picks for a 4 GB card.
    parser.add_argument("--batch-size", type=int, default=2)
    parser.add_argument("--sovits-epochs", type=int, default=8, help="WebUI default for v2Pro")
    parser.add_argument("--gpt-epochs", type=int, default=15)
    parser.add_argument("--skip-preprocess", action="store_true")
    parser.add_argument("--stage", choices=["all", "sovits", "gpt"], default="all")
    args = parser.parse_args()

    if not VENV_PYTHON.exists():
        raise SystemExit(f"GPT-SoVITS venv not found at {VENV_PYTHON}")
    if not DATASET_LIST.exists():
        raise SystemExit(f"Dataset manifest not found at {DATASET_LIST}. Run build_dataset.py first.")

    opt_dir = REPO / EXP_DIR
    opt_dir.mkdir(parents=True, exist_ok=True)
    (REPO / "TEMP").mkdir(exist_ok=True)
    # Upstream writes finished weights here but never creates the directories;
    # training otherwise runs to completion and then dies on FileNotFoundError.
    (REPO / SOVITS_WEIGHT_DIR).mkdir(exist_ok=True)
    (REPO / GPT_WEIGHT_DIR).mkdir(exist_ok=True)
    patch_upstream_for_single_gpu_windows()

    shared_env = {
        "inp_text": str(DATASET_LIST),
        "inp_wav_dir": str(DATASET_WAVS),
        "exp_name": EXP_NAME,
        "opt_dir": EXP_DIR,
        "i_part": "0",
        "all_parts": "1",
        "_CUDA_VISIBLE_DEVICES": "0",
        "is_half": "True",
        "version": VERSION,
    }

    if not args.skip_preprocess:
        run_step("1a text", "GPT_SoVITS/prepare_datasets/1-get-text.py",
                 {**shared_env, "bert_pretrained_dir": BERT_DIR})
        merge_parts(opt_dir, "2-name2text-*.txt", "2-name2text.txt")

        run_step("1b hubert", "GPT_SoVITS/prepare_datasets/2-get-hubert-wav32k.py",
                 {**shared_env, "cnhubert_base_dir": CNHUBERT_DIR, "sv_path": SV_PATH})
        # v2Pro additionally needs speaker-verification embeddings.
        run_step("1b speaker-vector", "GPT_SoVITS/prepare_datasets/2-get-sv.py",
                 {**shared_env, "cnhubert_base_dir": CNHUBERT_DIR, "sv_path": SV_PATH})

        run_step("1c semantic", "GPT_SoVITS/prepare_datasets/3-get-semantic.py",
                 {**shared_env, "pretrained_s2G": PRETRAINED_S2G, "s2config_path": S2_CONFIG})
        merge_parts(opt_dir, "6-name2semantic-*.tsv", "6-name2semantic.tsv",
                    header="item_name\tsemantic_audio")

    if args.stage in ("all", "sovits"):
        with open(REPO / S2_CONFIG, encoding="utf-8") as handle:
            s2 = json.load(handle)
        s2["train"].update({
            "batch_size": args.batch_size,
            "epochs": args.sovits_epochs,
            "pretrained_s2G": PRETRAINED_S2G,
            "pretrained_s2D": PRETRAINED_S2D,
            "if_save_latest": True,
            "if_save_every_weights": True,
            "save_every_epoch": args.sovits_epochs,
            "gpu_numbers": "0",
            "grad_ckpt": False,
            "lora_rank": 32,
            "fp16_run": True,
        })
        s2["model"]["version"] = VERSION
        s2["data"]["exp_dir"] = s2["s2_ckpt_dir"] = EXP_DIR
        s2["save_weight_dir"] = SOVITS_WEIGHT_DIR
        s2["name"] = EXP_NAME
        s2["version"] = VERSION
        s2_path = REPO / "TEMP" / "ruby_s2.json"
        s2_path.write_text(json.dumps(s2), encoding="utf-8")
        (REPO / EXP_DIR / f"logs_s2_{VERSION}").mkdir(parents=True, exist_ok=True)

        run_step("2a SoVITS train", "GPT_SoVITS/s2_train.py", shared_env,
                 ["--config", str(s2_path)])

    if args.stage in ("all", "gpt"):
        with open(REPO / S1_CONFIG, encoding="utf-8") as handle:
            s1 = yaml.safe_load(handle)
        s1["train"].update({
            "batch_size": args.batch_size,
            "epochs": args.gpt_epochs,
            "save_every_n_epoch": args.gpt_epochs,
            "if_save_every_weights": True,
            "if_save_latest": True,
            "if_dpo": False,
            "half_weights_save_dir": GPT_WEIGHT_DIR,
            "exp_name": EXP_NAME,
            "precision": "16-mixed",
        })
        s1["pretrained_s1"] = PRETRAINED_S1
        s1["train_semantic_path"] = f"{EXP_DIR}/6-name2semantic.tsv"
        s1["train_phoneme_path"] = f"{EXP_DIR}/2-name2text.txt"
        s1["output_dir"] = f"{EXP_DIR}/logs_s1_{VERSION}"
        # Keep worker processes to a minimum; see patch_dataloader_workers.
        s1["data"]["num_workers"] = 1
        s1_path = REPO / "TEMP" / "ruby_s1.yaml"
        s1_path.write_text(yaml.dump(s1, default_flow_style=False), encoding="utf-8")
        (REPO / EXP_DIR / f"logs_s1_{VERSION}").mkdir(parents=True, exist_ok=True)

        run_step("2b GPT train", "GPT_SoVITS/s1_train.py",
                 {**shared_env, "hz": "25hz"}, ["--config_file", str(s1_path)])

    print("\nTraining complete.")
    for label, directory in (("SoVITS", SOVITS_WEIGHT_DIR), ("GPT", GPT_WEIGHT_DIR)):
        target = REPO / directory
        found = sorted(target.glob("*")) if target.exists() else []
        print(f"   {label} weights: {[p.name for p in found] or 'NONE FOUND'}")


if __name__ == "__main__":
    sys.exit(main())
