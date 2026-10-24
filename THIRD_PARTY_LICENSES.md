# Third-party components

InstantCognition itself is MIT licensed. It bundles, downloads or links the
components below, each under its own license. This list covers what ships in a
release binary and what the build scripts fetch; the full dependency tree with
its licenses is reproducible with `npm ls` and the `license` field of each
package.

## Runtime dependencies (npm)

| Component | License | Used for |
|---|---|---|
| [Electron](https://github.com/electron/electron) | MIT | Application runtime |
| [@ghostery/adblocker-electron](https://github.com/ghostery/adblocker) | MPL-2.0 | Ad and tracker blocking |
| [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) | MIT | MCP tool servers |
| [sherpa-onnx-node](https://github.com/k2-fsa/sherpa-onnx) | Apache-2.0 | Local speech recognition |
| [winston](https://github.com/winstonjs/winston) | MIT | Logging |
| [cross-fetch](https://github.com/lquixada/cross-fetch) | MIT | HTTP client |
| [electron-prompt](https://github.com/p-sam/electron-prompt) | MIT | Native prompt dialogs |
| [extract-zip](https://github.com/maxogden/extract-zip) | BSD-2-Clause | Extension archive unpacking |
| [electron-updater](https://github.com/electron-userland/electron-builder) | MIT | App auto-update |
| [marked](https://github.com/markedjs/marked) | MIT | Markdown rendering |
| [DOMPurify](https://github.com/cure53/DOMPurify) | MPL-2.0 OR Apache-2.0 | Sanitizing rendered markdown |
| [highlight.js](https://github.com/highlightjs/highlight.js) | BSD-3-Clause | Code syntax highlighting |
| [mermaid](https://github.com/mermaid-js/mermaid) | MIT | Diagrams in artifacts |
| [jsdiff](https://github.com/kpdecker/jsdiff) (`diff`) | BSD-3-Clause | File diffs in agent approvals |
| [picomatch](https://github.com/micromatch/picomatch) | MIT | Permission and path glob matching |
| [yaml](https://github.com/eemeli/yaml) | ISC | Skill (`SKILL.md`) frontmatter |
| [tldts-experimental](https://github.com/remusao/tldts) | MIT | Registrable-domain checks for the third-party cookie setting |

## Bundled binaries and models

| Component | License | Notes |
|---|---|---|
| [llama.cpp](https://github.com/ggml-org/llama.cpp) (`llama-server`) | MIT | Prebuilt binary fetched per platform by `scripts/fetch-llama-server.js` and bundled into releases |
| [Moonshine tiny-en](https://github.com/usefulsensors/moonshine) ONNX model, packaged by [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | MIT (model), Apache-2.0 (sherpa-onnx packaging) | Local voice input; fetched by `scripts/fetch-moonshine-model.js` |
| [python-build-standalone](https://github.com/astral-sh/python-build-standalone) | Python Software Foundation License (CPython) plus the per-component licenses it documents | Relocatable Python used to run the MLX servers on Apple silicon; fetched by `scripts/fetch-mlx-runtime.js` and `scripts/fetch-omlx-runtime.js` |
| [MLX](https://github.com/ml-explore/mlx) and `mlx-lm` | MIT | Apple-silicon inference backend, installed into the bundled Python runtime |
| [mlx-openai-server](https://github.com/cubist38/mlx-openai-server) | MIT | OpenAI-compatible MLX server, installed into the bundled MLX Python runtime |
| [oMLX](https://github.com/jundot/omlx) | Apache-2.0 | Continuous-batching MLX server, installed with its dependencies into its own bundled Python runtime |

## Downloaded at runtime

| Component | License | Notes |
|---|---|---|
| [Hagezi DNS blocklists](https://github.com/hagezi/dns-blocklists) | GPL-3.0 | Filter lists fetched on demand by the ad blocker; not redistributed with the app |
| [vLLM](https://github.com/vllm-project/vllm) | Apache-2.0 | Installed by Settings → LLM → Set up vLLM into a private environment (Linux) or the app's WSL distro (Windows); not redistributed with the app |
| [Ubuntu 24.04 WSL image](https://ubuntu.com/desktop/wsl) | Per-package (Canonical) | Downloaded on Windows by vLLM setup to create the app's WSL distro; not redistributed with the app |
| Models from [Hugging Face](https://huggingface.co) | Per-model | Downloaded by the user through the Model Hub; each model carries its own license and terms |

## Trademarks

`assets/ai-logos/` contains service marks (ChatGPT, Claude, Gemini, Copilot,
Mistral, Perplexity and others) used only to identify the corresponding service
in the space picker. They remain the property of their respective owners and
their inclusion implies no affiliation with or endorsement by them.
