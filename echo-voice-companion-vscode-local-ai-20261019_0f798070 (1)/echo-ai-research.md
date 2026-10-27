# Echo local voice model: pinned implementation notes

Updated 2026-10-19 for the VS Code bundle's pinned `mlx-audio==0.6.0` dependency.

The official Qwen3-TTS Base guide demonstrates voice cloning with `model.generate(text=..., ref_audio=..., ref_text=...)`, and warns not to pass a preset `voice` when using reference audio and transcript. The server therefore calls the model API directly, passes the exact saved transcript, and does not choose a preset speaker. [1]

The MLX-Audio 0.6.0 convenience `generate_audio` helper prints the target text in its ordinary generation path. Echo avoids that helper and calls `Model.generate(..., verbose=False)` directly. Python stdout and stderr are redirected during the inference call so model diagnostics do not reveal submitted text. [2]

The pinned Qwen3-TTS 0.6.0 model source initializes `self._icl_cache` and stores reference speech codes and reference-text tokens in it, keyed using the reference transcript and audio fingerprint. The pinned source exposes no public reference-cache eviction method. Echo therefore pins the package version, clears the version-specific `_icl_cache` in a `finally` path, calls `mlx.core.clear_cache()`, and runs garbage collection after each completed or failed inference. If the expected cache is absent, generation fails closed rather than silently retaining unknown reference state. [3]

The release tag confirms `mlx-audio` 0.6.0. The server also requires Python 3.12, native Apple Silicon, and the pinned library version before it reports local AI as ready. [4]

The pinned `mlx_audio.audio_io.read` API accepts `dtype`, `sample_rate`, `nchannels`, and `duration`, and returns `(audio, sample_rate)`. The optional Mac smoke test uses it to normalize no more than 30 seconds of input to mono 24 kHz float32, then writes a local temporary WAV through the matching `audio_io.write(file, data, samplerate, format)` API. [5]

Real MLX inference cannot be executed in the Linux development sandbox; the only available execution device for this session is the Sandbox. `tests/test_echo_ai_server.py` uses a fake model for deterministic consent, language, model-loading, generation, logging, cleanup, cancellation, and HTTP-origin checks. `tests/mac_model_smoke_test.py` is provided for a user-run Apple Silicon Mac check with an explicitly consented local sample; it verifies a valid WAV response and an empty reference cache.

## References

[1]: https://raw.githubusercontent.com/Blaizzy/mlx-audio/v0.6.0/mlx_audio/tts/models/qwen3_tts/README.md "Qwen3-TTS voice cloning guide at v0.6.0"
[2]: https://raw.githubusercontent.com/Blaizzy/mlx-audio/v0.6.0/mlx_audio/tts/generate.py "MLX-Audio generation helper at v0.6.0"
[3]: https://raw.githubusercontent.com/Blaizzy/mlx-audio/v0.6.0/mlx_audio/tts/models/qwen3_tts/qwen3_tts.py "Qwen3-TTS model implementation at v0.6.0"
[4]: https://github.com/Blaizzy/mlx-audio/releases/tag/v0.6.0 "MLX-Audio 0.6.0 release notes"
[5]: https://raw.githubusercontent.com/Blaizzy/mlx-audio/v0.6.0/mlx_audio/audio_io.py "MLX-Audio audio I/O at v0.6.0"
