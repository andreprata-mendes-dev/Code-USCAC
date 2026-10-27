# Echo Voice Companion — VS Code (on-device AI edition)

This separate VS Code edition adds reference-based AI speech generation on your own Apple Silicon Mac. The local model is available only while this project runs on that Mac. It does not use an account or cloud voice API. Standard browser/device voices remain available as a separate feature.

The model does not permanently train or fine-tune new weights. Qwen3-TTS Base uses a saved voice sample and its exact transcript as reference conditioning for each request. The generated result may sound different from the speaker; an exact copy is not guaranteed.

## Mac requirements and model size

- Native Apple Silicon (M-series) macOS. Intel Macs, Windows, and Linux can use the browser/device voices but cannot run the MLX model.
- Python 3.12 running natively as `arm64` (not through Rosetta). If needed, install it with `brew install python@3.12`.
- The setup pins `mlx-audio[tts]==0.6.0` in an isolated `.venv`.
- The first generation downloads the Qwen3-TTS 0.6B Base 6-bit weights (about 2.6 GB) from Hugging Face into its normal model cache. Setup installs the Python package but does not download the model.
- The upstream short-prompt benchmark reports about 3.9 GB of working memory for one 6-bit sequence. This is not a minimum guarantee; an 8 GB Mac may feel tight when other apps are open.

## Open and run in VS Code

1. Extract the downloaded ZIP with macOS Archive Utility. Do not open the ZIP itself in VS Code.
2. In VS Code, choose **File → Open Folder…** and select the extracted project folder.
3. Choose **Terminal → New Terminal** and run `./setup-local-ai.sh`. This creates `.venv/` and installs the pinned local inference packages. It does not access the microphone or load the model.
4. Run `./build.sh` to copy the editable root files into `public/`.
5. Run `./run.sh`. It serves the page and local API on `127.0.0.1`, selecting a free port from 3000 through 3010, and prints the exact URL. Open that URL in Safari or Chrome.
6. Keep that terminal open while using Echo. Stop it with **Control+C**. If the shell says “Permission denied,” run `chmod +x setup-local-ai.sh build.sh run.sh` once, then retry.

Do not start a second copy while one is running; use the printed address from the existing terminal. If all ports 3000–3010 are occupied, stop another local server and try again. Do not open `index.html` as `file://`: microphone access and browser storage need `localhost` or HTTPS. If the app opens but reports that local AI needs Python 3.12, rerun `./setup-local-ai.sh` and restart `./run.sh`.

The `run.bat` launcher is for a basic browser-voice preview on Windows. MLX voice generation requires Apple Silicon macOS and Python 3.12.

## Create and use a consented voice

1. In Echo, open **Voice Studio** and enter the speaker's name.
2. Check the recording permission box. Record only your own voice or a speaker who explicitly agreed. Make a clean, short sample with little background noise. Stop the recording and review it in the player.
3. Type the words exactly as spoken in **Recording transcript** and save the profile. A transcript edited after saving must be saved with the profile before generation is enabled.
4. Edit that profile again to open its saved sample in Voice Studio.
5. Enter the sentence to generate and choose one of the supported AI languages: English, Spanish, French, German, Chinese, Italian, or Japanese.
6. Check the separate speaker-permission box for that sentence, then click **Generate locally**. The checkbox is consumed for one request; check it again before every new generation. Changing the sentence or language also clears the consent check.
7. The first generation downloads the model weights and may take several minutes. When it finishes, play the temporary result or explicitly download its WAV file.

The browser voice selector is separate: sample phrases continue to use voices installed in Safari, Chrome, or macOS. A saved recording does not automatically replace a browser voice or the generated model's voice profile.

## Audio and privacy boundaries

- The original clip is stored in this browser's IndexedDB. Profile details and the reference transcript are stored in this browser's local storage. They are not shared with other browsers or devices.
- Only after you separately consent and click **Generate locally** does Echo send the selected sample, its saved transcript, sentence, and language to the Python process on this same Mac at `127.0.0.1`. The server is bound to loopback; it is not exposed to the local network.
- The server writes a temporary reference WAV while processing and removes the temporary working directory afterward. It calls the pinned model API directly so submitted text is not printed by the convenience generation helper. It does not log request bodies, transcripts, audio, or target sentences.
- MLX-Audio's reference-code cache is cleared after each completed or canceled request while the model weights remain loaded locally. Package installation and the first model-weight download use the internet; the download contains model files, not your recording.
- **Cancel** prevents generated audio from being returned to the page. If inference has already started, the model cannot be interrupted mid-call; it continues locally on this Mac until completion, after which temporary files and reference cache are cleared.
- You can remove the saved clip or profile in Echo. Only use a person's voice with their explicit permission and respect applicable law and the model's license.

## Verify real MLX inference on the Mac

The automated server tests use a mocked model in this Linux development environment, so they do not verify actual Apple Silicon inference. After setup, run this optional real-model smoke test in VS Code's terminal:

```sh
.venv/bin/python tests/mac_model_smoke_test.py
```

It asks you to confirm speaker permission, then requests a local WAV sample, its exact transcript, a target sentence, and a language. It normalizes the sample locally, runs the pinned model, checks for a valid generated WAV, and verifies that the reference cache was cleared. It does not save the generated audio. The first run may download the model weights.

## Troubleshooting

- **“Local AI packages are not installed”**: run `./setup-local-ai.sh`, then stop and restart `./run.sh`.
- **Python version or architecture error**: use the project's `.venv` created by `./setup-local-ai.sh`; ensure VS Code and Python run natively on Apple Silicon rather than Rosetta.
- **Model unavailable / first run**: click **Check local model**. Keep the Mac connected to the internet until the model-weight download completes; the model weights are cached for later runs.
- **Unsupported language**: local AI generation is limited to English, Spanish, French, German, Chinese, Italian, and Japanese. Browser/device speech may support more languages.
- **No microphone or a denied prompt**: allow microphone access for localhost in the browser's site settings, then return to Voice Studio and try again.
- **Poor voice match**: use a clean sample, avoid music or overlapping voices, and provide an exact transcript. Voice resemblance varies; one brief recording cannot guarantee a perfect match.
- **Memory pressure**: close other large apps before generating. The first load can use several GB of unified memory.
- **Port in use**: the local server tries the next port through 3010 and prints the URL it actually selected.

For model/API details see [Qwen3-TTS Base](https://github.com/Blaizzy/mlx-audio/blob/v0.6.0/mlx_audio/tts/models/qwen3_tts/README.md), [Qwen's model card and license](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base), and [MLX-Audio 0.6.0](https://pypi.org/project/mlx-audio/0.6.0/).
