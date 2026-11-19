# GenVideo — local text-to-video for DeepSeek Harness

[English](#english) | [Русский](#русский)

---

## English

GenVideo is a DeepSeek Harness plugin that turns text into video with local LTX models and exposes the whole engine as an **MCP service**. The agent gets `mcp__genvideo__*` tools; the user gets a left-sidebar **Vue 3** panel with generation, queue, library, models and settings (scoped CSS on DSH theme tokens, English/Russian).

### Architecture

```
DSH Web UI (Vue 3 panel)
        │  same-origin /genvideo/*
        ▼
Host plugin (thin proxy, index.ts)
        │  127.0.0.1:<random> + X-GenVideo-Token
        ▼
MCP service (server/genvideo-mcp.ts) — one process, one state
  ├─ stdio JSON-RPC for the agent (initialize/tools/list/tools/call)
  ├─ HTTP API + SSE for the panel
  └─ engine: jobs, GPU, deps, models, planner, ffmpeg, runners
        │
        ▼
Videos/  (finished clips)   models/  (downloaded weights)
```

The service publishes `{port, token, pid}` to `$DSH_HOME/genvideo/endpoint.json`; the Host plugin reads it and proxies every `/genvideo/*` request, adding the token. Nothing is stored twice.

### Features

- **Two target models** plus any custom model:
  - `SulphurAI/Sulphur-2-base` — 22B DiT on LTX-2.3, text/image/video conditioning and audio, 29–46 GB of weights per variant.
  - `oxide-lab/LTX-Video-0.9.8-2B-distilled` — Rust/Candle, 9.7 GB, text-to-video, 8–12 GB VRAM.
  - `Lightricks/LTX-Video` 2B distilled — diffusers path with image-to-video.
- **GPU panel**: which GPUs are used, total/used VRAM, multi-GPU strategy, VRAM budget, and per-model VRAM requirements with fit warnings.
- **Duration limits per model**: longer videos are split into segments, generated, and merged into one file.
- **Input support is explicit**: badges show T2V/I2V/V2V/audio; reference images and videos can be uploaded when the model supports them.
- **Platform presets**: Instagram Reels, YouTube Shorts, YouTube 1080p/4K, cinema 16:9, square 1:1, portrait 4:5, custom.
- **Quality OR size limit** (mutually exclusive):
  - quality tiers: High (CRF 18), Medium (CRF 23), Max compression (CRF 28);
  - size limit: two-pass H.264/VP9 under a chosen number of megabytes, verified after encoding.
- **Formats**: MP4 (H.264/AAC), WebM (VP9/Opus), GIF.
- **Long videos**: segment plan, continuity via the previous clip's last frame (i2v), ffmpeg concatenation; merge any finished clips from the Library.
- **Detailed progress**: phase, diffusion step, segment x/y, ETA, transcode pass 1/2, log tail, cancel.
- **Transcode encoders**: CPU/libx264 (default), NVIDIA NVENC, Vulkan Video, with an automatic libx264 retry when the hardware encoder is unavailable.
- **Custom Candle args**: extra argv (for example `--device vulkan`) for a self-built Vulkan candle-video; the shipped LTX example is CUDA/cuDNN-only.
- **Model management**: sizes, install state, download with resume and progress, update detection, newer-version suggestions, custom model form.
- **Bilingual UI** (English/Russian) and a scoped CSS design system that respects the host light/dark theme.
- **MCP tools for the agent** — the same engine the panel uses.

### Requirements

- DeepSeek Harness Web with a profile (the plugin is installed as a bundle).
- Node.js 24+ (the DSH runtime).
- `ffmpeg` and `ffprobe` in `PATH` (the panel can install ffmpeg via `sudo -n apt-get` or show the command).
- For real generation, one of:
  - an NVIDIA GPU with CUDA (WSL2 supported when the Windows driver exposes the device);
  - ComfyUI running locally with an LTX workflow;
  - a built `candle-video` binary;
  - Python with a venv containing `torch` and `diffusers` (the panel creates it).

Mock mode works everywhere and is meant for pipeline checks, not for real content.

### Install

#### Through the Plugins page

1. Open **Plugins → Add plugin → Install a third-party plugin**.
2. Enter the absolute path to this directory (`/home/main/TextToVideo`).
3. Install, then enable the `GenVideo` bundle.
4. Refresh the DSH page. The film icon appears in the left sidebar.

#### Through the agent

Ask the agent to run `plugin_manager` with `action: install_bundle` and `target: /home/main/TextToVideo`, then refresh the page.

#### From source

```bash
npm install                       # dev only: typescript, @types/node, vite, vue, happy-dom
npm run build                     # tsc (host) + tsc --noEmit (client) + vite IIFE + bundle checks
npm test                          # 34 tests, including a real ffmpeg mock e2e
```

The Vue 3 browser half is minified by Vite (IIFE, esbuild minify); its scoped CSS is imported with `?inline` and embedded in the same script, so DSH loads one classic file (~128 KB, ~43 KB gzip). `dist/` is committed, so installation does not need a build.

### Models

| Model | Size | Duration | Inputs | VRAM | Runners |
|---|---|---|---|---|---|
| Sulphur 2 base | 29.2 GB fp8 / 46.1 GB bf16 | 6–20 s | T2V, I2V, V2V, audio | ≥24 GB fp8 | ComfyUI, command |
| LTX-Video 0.9.8 2B distilled | 9.7 GB | up to ~10.7 s (8n+1 frames) | T2V | 8–12 GB | Candle, command |
| LTX-Video 2B 0.9.8 (diffusers) | 6.34 GB | up to ~10.7 s | T2V, I2V | 8–12 GB | diffusers, command |

Weights are downloaded to `models/<modelId>/` in the project. Gated repositories need `HF_TOKEN` in the environment of the DSH process.

### Folders

| Path | Content |
|---|---|
| `<project>/Videos/` | finished clips (default output) |
| `<project>/models/` | downloaded weights and `manifest.json` |
| `$DSH_HOME/genvideo/settings.json` | settings |
| `$DSH_HOME/genvideo/jobs.json`, `logs/` | job history and logs |
| `$DSH_HOME/genvideo/endpoint.json` | port/token of the running MCP service |
| `$DSH_HOME/genvideo/work/` | intermediate segments and merge scratch |

### Runners

| Runner | Needs | Progress source |
|---|---|---|
| `mock` | ffmpeg | synthetic clip, timed phases |
| `diffusers` | venv with torch/diffusers, CUDA or “Allow CPU” | worker JSON lines |
| `candle` | built `candle-video` binary + CUDA | parsed logs, ETA |
| `comfyui` | running ComfyUI + API workflow at `models/<id>/workflow.json` | polling `/history` |
| `command` | custom argv template | `%` lines or ETA |

The runner matrix in **Models** shows exactly what is missing and how to fix it.

### MCP tools

Server name: `genvideo`; public names are `mcp__genvideo__<tool>`.

| Tool | Purpose |
|---|---|
| `status` | GPUs, ffmpeg, Python, cargo, ComfyUI, models, paths |
| `models` | registry with capabilities, sizes, VRAM, install state |
| `install_model` | download a model variant (job) |
| `check_updates` | remote revisions and newer-family candidates |
| `plan` | limits, segments, VRAM/time/size estimate, warnings |
| `generate` | start a generation job (returns job id + plan) |
| `jobs`, `job`, `cancel` | queue inspection and cancellation |
| `merge` | concatenate clips from `Videos/` |
| `transcode` | quality mode or size limit |
| `probe` | ffprobe metadata |
| `settings` | read/update plugin settings |
| `engine_install` | install Python engine or ffmpeg; Candle returns the build command |

Example prompt for the agent:

> Use `mcp__genvideo__plan` for "a slow drone shot over a winter forest", 20 seconds, YouTube, then `mcp__genvideo__generate` with the mock runner to check the pipeline, and summarize the warnings.

### Settings reference

- **GPU**: selected devices, strategy (`single`, `round-robin`, `tensor-parallel`), VRAM budget.
- **Tools**: ffmpeg/ffprobe paths and status, Python, venv, cargo, ComfyUI URL, Candle binary.
- **Paths**: output folder (`Videos`), models folder (`models`).
- **Language**: English/Russian.
- **Defaults**: platform, aspect, resolution, fps, clip length.

### Troubleshooting

- **`nvidia-smi` fails with “Failed to initialize NVML” (WSL2)** — update the Windows NVIDIA driver (not the one inside WSL), run `nvidia-smi` in the WSL shell, and check `/usr/lib/wsl/lib/libcuda.so.1`. Until then only Mock and ffmpeg-only operations work.
- **ffmpeg is missing** — use *Settings → Tools → Install ffmpeg* (needs passwordless sudo) or run the shown `sudo apt-get install -y ffmpeg`.
- **diffusers runner unavailable** — run *Install Python engine* (several GB) and enable *Allow CPU generation* only if you accept very slow CPU inference.
- **ComfyUI runner unavailable** — start ComfyUI, set its URL, export a workflow in **API format** to `models/<modelId>/workflow.json`; placeholders are `{{prompt}}`, `{{negative}}`, `{{width}}`, `{{height}}`, `{{frames}}`, `{{fps}}`, `{{seed}}`, `{{image}}`.
- **Candle runner unavailable** — build `candle-video` (`cargo build --release --features flash-attn,cudnn`) and set the binary path in Settings.
- **`mcp-unavailable` in the panel** — the MCP row is disabled or crashed; enable `genvideo-mcp` or restart DSH.
- **Size limit rejected** — the limit is below the minimum for the clip duration; the error reports the minimum.

### Privacy and security

- The HTTP sidecar binds `127.0.0.1` only and requires a random token; the Host plugin adds it.
- Only files inside `Videos/`, `models/` and the inputs folder are served; traversal is rejected.
- Model downloads go directly to Hugging Face; no telemetry.
- GitHub/Hugging Face tokens are read from environment variables and never written to settings or logs.

### Limitations

- Real model inference requires a CUDA GPU and the corresponding toolchain; the current development host has no working GPU, so the delivered verification covers the Mock pipeline, ffmpeg, merging, the HTTP API, MCP and the UI.
- Sulphur 2 / LTX-2.3 needs the LTX-2 text encoder and either ComfyUI or the official `ltx_pipelines`; diffusers support for LTX-2.3 is not released yet.
- 4K local generation depends on VRAM; the planner warns before you run it.
- No training, LoRA creation, cloud APIs or prompt translation.

### Third-party notices

- LTX-Video and LTX-2.3 are licensed by Lightricks (LTX Video / LTX-2 Community License); Sulphur 2 is distributed by SulphurAI under its own terms. Check the licenses before commercial use.
- `candle-video` is Apache-2.0.
- The plugin itself contains no model weights.

---

## Русский

GenVideo — плагин DeepSeek Harness, который превращает текст в видео локальными LTX-моделями и отдаёт весь движок как **MCP-сервис**. Агенту доступны инструменты `mcp__genvideo__*`, пользователю — панель на **Vue 3** в левом сайдбаре: генерация, очередь, библиотека, модели и настройки (собственный scoped CSS на токенах темы, русский/английский).

### Архитектура

```
Панель DSH (Vue 3)  ──/genvideo/*──▶  Host-плагин (прокси + токен)
                                             │ 127.0.0.1:<порт>
                                             ▼
MCP-сервис (один процесс, одно состояние)
  ├─ stdio JSON-RPC для агента
  ├─ HTTP API + SSE для панели
  └─ движок: задания, GPU, зависимости, модели, планировщик, ffmpeg, раннеры
                                             │
                       Videos/ (ролики)      models/ (веса)
```

Сервис публикует `{port, token, pid}` в `$DSH_HOME/genvideo/endpoint.json`; Host-плагин читает файл и проксирует `/genvideo/*`, добавляя токен.

### Возможности

- **Две целевые модели** и свои:
  - `SulphurAI/Sulphur-2-base` — 22B DiT на LTX-2.3, t2v/i2v/v2v/audio, 29–46 ГБ весов на вариант.
  - `oxide-lab/LTX-Video-0.9.8-2B-distilled` — Rust/Candle, 9.7 ГБ, t2v, 8–12 ГБ VRAM.
  - `Lightricks/LTX-Video` 2B distilled — diffusers с image-to-video.
- **GPU**: какие карты используются, всего/занято VRAM, стратегия, бюджет памяти, требования модели и предупреждения о нехватке.
- **Лимиты длительности**: длинные ролики делятся на сегменты, генерируются и склеиваются в один файл.
- **Входы**: бейджи T2V/I2V/V2V/audio; загрузка опорной картинки/видео, когда модель это умеет.
- **Платформы**: Reels, Shorts, YouTube 1080p/4K, кино 16:9, квадрат 1:1, портрет 4:5, своё.
- **Качество ИЛИ лимит размера** (взаимоисключающе):
  - уровни: высокое (CRF 18), среднее (CRF 23), максимальное сжатие (CRF 28);
  - лимит: двухпроходный H.264/VP9 под заданное число МБ с проверкой после кодирования.
- **Форматы**: MP4 (H.264/AAC), WebM (VP9/Opus), GIF.
- **Длинные ролики**: план сегментов, непрерывность по последнему кадру (i2v), склейка ffmpeg; отдельная склейка готовых роликов из библиотеки.
- **Подробный прогресс**: фаза, шаг диффузии, сегмент x/y, ETA, проходы транскода, хвост лога, отмена.
- **Модели**: размеры, статус установки, загрузка с докачкой и прогрессом, проверка обновлений, подсказка более новой версии, форма своей модели.
- **Два языка** (EN/RU) и собственный CSS-дизайн на токенах темы, учитывающий светлую/тёмную тему DSH.
- **Энкодеры транскода**: CPU/libx264 (по умолчанию), NVIDIA NVENC, Vulkan Video; при недоступном аппаратном энкодере автоматически повторяется на libx264.
- **Свои аргументы Candle**: дополнительные argv (например, `--device vulkan`) для собственной Vulkan-сборки candle-video; официальный пример LTX — только CUDA/cuDNN.
- **MCP-инструменты для агента** — тот же движок, что и у панели.

### Требования

- DeepSeek Harness Web с профилем.
- Node.js 24+.
- `ffmpeg`/`ffprobe` в `PATH` (панель может установить или показать команду).
- Для реальной генерации — одно из: NVIDIA GPU с CUDA (включая WSL2 с проброшенным драйвером), запущенный ComfyUI с LTX-воркфлоу, собранный `candle-video` или venv с `torch`/`diffusers`.

Mock-режим работает всегда и служит для проверки пайплайна, а не для реального контента.

### Установка

1. **Plugins → Add plugin → Install a third-party plugin**.
2. Укажите абсолютный путь `/home/main/TextToVideo`.
3. Установите и включите бандл `GenVideo`.
4. Обновите страницу DSH — в левом сайдбаре появится иконка плёнки.

Через агента: `plugin_manager` → `install_bundle` → `target: /home/main/TextToVideo`, затем обновить страницу.

Сборка из исходников:

```bash
npm install
npm run build     # tsc + vite (IIFE, минификация) + проверки бандла
npm test
```

Браузерная часть на Vue 3 минифицируется Vite (IIFE, esbuild); собственный CSS импортируется через `?inline` и встраивается в тот же скрипт, поэтому DSH загружает один классический файл (~128 КБ, ~43 КБ gzip). `dist/` коммитится — для установки сборка не нужна.

### Модели

| Модель | Размер | Длительность | Входы | VRAM | Раннеры |
|---|---|---|---|---|---|
| Sulphur 2 base | 29.2 ГБ fp8 / 46.1 ГБ bf16 | 6–20 с | T2V, I2V, V2V, audio | ≥24 ГБ fp8 | ComfyUI, command |
| LTX-Video 0.9.8 2B distilled | 9.7 ГБ | до ~10.7 с (8n+1 кадров) | T2V | 8–12 ГБ | Candle, command |
| LTX-Video 2B 0.9.8 (diffusers) | 6.34 ГБ | до ~10.7 с | T2V, I2V | 8–12 ГБ | diffusers, command |

Веса скачиваются в `models/<modelId>/`. Для закрытых репозиториев нужен `HF_TOKEN` в окружении процесса DSH.

### Папки

| Путь | Содержимое |
|---|---|
| `<проект>/Videos/` | готовые ролики |
| `<проект>/models/` | веса и `manifest.json` |
| `$DSH_HOME/genvideo/settings.json` | настройки |
| `$DSH_HOME/genvideo/jobs.json`, `logs/` | история заданий и логи |
| `$DSH_HOME/genvideo/endpoint.json` | порт/токен MCP-сервиса |
| `$DSH_HOME/genvideo/work/` | промежуточные сегменты и склейка |

### Раннеры

| Раннер | Требует | Источник прогресса |
|---|---|---|
| `mock` | ffmpeg | синтетический клип, фазы по таймеру |
| `diffusers` | venv с torch/diffusers, CUDA или «Allow CPU» | JSON-строки воркера |
| `candle` | собранный `candle-video` + CUDA | логи, ETA |
| `comfyui` | ComfyUI + API-воркфлоу в `models/<id>/workflow.json` | опрос `/history` |
| `command` | свой шаблон argv | строки с `%` или ETA |

Матрица раннеров в разделе **Модели** показывает, чего не хватает и как это исправить.

### MCP-инструменты

Имя сервера: `genvideo`; публичные имена — `mcp__genvideo__<tool>`.

`status`, `models`, `install_model`, `check_updates`, `plan`, `generate`, `jobs`, `job`, `cancel`, `merge`, `transcode`, `probe`, `settings`, `engine_install`.

Пример запроса агенту:

> Вызови `mcp__genvideo__plan` для «медленный облёт зимнего леса», 20 секунд, YouTube, затем `mcp__genvideo__generate` с mock-раннером для проверки пайплайна и перечисли предупреждения.

### Настройки

- **GPU**: выбранные устройства, стратегия (`single`, `round-robin`, `tensor-parallel`), бюджет VRAM.
- **Инструменты**: пути ffmpeg/ffprobe, Python, venv, cargo, URL ComfyUI, бинарь Candle.
- **Папки**: результаты (`Videos`), модели (`models`).
- **Язык**: English/Русский.
- **Значения по умолчанию**: платформа, аспект, разрешение, fps, длина клипа.

### Решение проблем

- **`nvidia-smi` падает с «Failed to initialize NVML» (WSL2)** — обновите драйвер NVIDIA в Windows, проверьте `/usr/lib/wsl/lib/libcuda.so.1`; до этого доступны только Mock и ffmpeg-операции.
- **Нет ffmpeg** — *Настройки → Инструменты → Установить ffmpeg* (нужен sudo без пароля) или выполните показанную команду.
- **Недоступен diffusers** — установите Python-движок (несколько ГБ); «Allow CPU» включайте только если готовы к очень медленной генерации.
- **Недоступен ComfyUI** — запустите ComfyUI, укажите URL, экспортируйте воркфлоу в **API-формате** в `models/<modelId>/workflow.json`; доступны плейсхолдеры `{{prompt}}`, `{{negative}}`, `{{width}}`, `{{height}}`, `{{frames}}`, `{{fps}}`, `{{seed}}`, `{{image}}`.
- **Недоступен Candle** — соберите `candle-video` и укажите путь к бинарю.
- **`mcp-unavailable`** — строка `genvideo-mcp` отключена или упала; включите её или перезапустите DSH.
- **Лимит размера отклонён** — он ниже минимума для длительности; в ошибке указан минимум.

### Приватность и безопасность

- HTTP sidecar слушает только `127.0.0.1` и требует случайный токен; токен добавляет Host-плагин.
- Отдаются только файлы из `Videos/`, `models/` и папки входов; обход путей запрещён.
- Загрузка моделей идёт напрямую с Hugging Face; телеметрии нет.
- Токены GitHub/Hugging Face читаются из переменных окружения и не попадают в настройки и логи.

### Ограничения

- Реальный вывод моделей требует CUDA GPU и соответствующего тулчейна; на текущей машине рабочей GPU нет, поэтому проверены Mock-пайплайн, ffmpeg, склейка, HTTP API, MCP и UI.
- Sulphur 2 / LTX-2.3 требует текст-энкодер LTX-2 и ComfyUI либо официальные `ltx_pipelines`; поддержка LTX-2.3 в diffusers пока не вышла.
- 4K локально зависит от VRAM — планировщик предупредит заранее.
- Нет обучения, LoRA, облачных API и перевода промптов.

### Лицензии третьих сторон

- LTX-Video и LTX-2.3 лицензируются Lightricks; Sulphur 2 распространяется SulphurAI на своих условиях — проверьте лицензии перед коммерческим использованием.
- `candle-video` — Apache-2.0.
- Плагин не содержит весов моделей.
