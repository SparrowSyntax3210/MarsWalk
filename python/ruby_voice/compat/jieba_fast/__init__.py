"""Alias `jieba_fast` to the pure-Python `jieba` package.

GPT-SoVITS imports jieba_fast from its Chinese text frontend, and
inference_webui.py loads that frontend eagerly even for English synthesis.
jieba_fast is a C-extension drop-in replacement for jieba and has no Windows
wheel, so installing it needs Microsoft Visual C++ Build Tools.

Ruby only speaks English, so the speed difference is irrelevant and the
upstream API (`jieba_fast.setLogLevel`, `jieba_fast.posseg`) is identical.
Mapping the module onto jieba satisfies the import without a compiler.

Put this directory on sys.path (or PYTHONPATH) before importing the engine.
"""
import sys

import jieba
import jieba.posseg

sys.modules[__name__] = jieba
sys.modules[f"{__name__}.posseg"] = jieba.posseg
