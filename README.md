# GenVideo — ComfyUI video generation for DeepSeek Harness

[English](#english) | [Русский](#русский)

---

## English

GenVideo is a DeepSeek Harness plugin that drives a local **ComfyUI** server. It adds a left-sidebar Vue 3 panel and native `genvideo_*` tools for the agent. Models and text encoders live inside ComfyUI; the plugin does not download or manage them.

The design target was an **NVIDIA RTX 3060 Ti with 8 GB VRAM**. A full LTX/Wan pipeline does not fit into 8 GB, so **ComfyUI was chosen as the backend**: it loads quantized **GGUF** diffusion models and text encoders (Q4/Q5) and can offload components, which makes a 5B-class model usable on this card.

### Architecture

```
Vue 3 panel ── /genvideo/api ──┐
                               ├─ Engine (in the Host plugin) ── ComfyUI HTTP API
Agent ── native genvideo_* tools┘
```

The engine runs in-process inside the Host plugin. The panel is served over `/genvideo`, and the agent uses native DSH `genvideo_*` tools.

### Tabs

- **Generate** — numbered sections (Enter prompt → Source → Output → Encoding); prompt/negative, reference image and video, duration, **Format** (Horizontal 16:9 / Vertical 9:16), **FPS** (15/24/30/60), continuity and ffmpeg transcode. Clip length is chosen automatically from VRAM.
- **Generation preview** — Generate opens a plan with output/base size, fps, auto clip, frames, clips and warnings; the job starts only after **Confirm generation**.
- **Prompt quality** — each T2V/I2V clip gets its own detailed prompt (LTX profile: 80–220 words, subject, setting, light, camera, action, continuity). Short or repeated prompts are flagged in the preview; the count must equal the clip count.
- **Modes** — no references: T2V then last-frame I2V for later clips; reference image: I2V from it, then last-frame; reference video: one V2V clip without the frame chain. Image and video references are mutually exclusive.
- **Sharpness** — after the 2× upscale and final `ImageScale`, every workflow runs `ImageSharpen` (radius 1, sigma 1.0, alpha 0.8); `SaveWEBM` uses crf 24 instead of 32.
- **V2V** — a reference video is loaded through `LoadVideo → GetVideoComponents → VAEEncodeTiled`, denoised with `SplitSigmasDenoise` (0.3–0.8, default 0.6), then upscaled and saved. V2V is one clip, cropped to 8n+1 frames (max 257).
- **ComfyUI auto-start** — Environment can start a local ComfyUI automatically when it is down. Set the directory (`main.py` + `venv/bin/python`), enable the checkbox, or press **Start now**. The plugin waits up to 60s and reports the log on failure.
- **Troubleshooting** — if ComfyUI stops mid-job, the plugin reports `comfyui-unreachable` instead of a bare `fetch failed`; restart ComfyUI and retry. The Environment state is refreshed before each plan.
- **Автозапуск ComfyUI** — Environment умеет поднимать локальный ComfyUI, если он упал. Укажите папку (`main.py` + `venv/bin/python`), включите чекбокс или нажмите **Запустить сейчас**. Плагин ждёт до 60 секунд и показывает лог при ошибке.
- **Диагностика** — если ComfyUI остановился во время job, плагин сообщает `comfyui-unreachable` вместо голого `fetch failed`; перезапустите ComfyUI и повторите. Состояние Environment обновляется перед каждым планом.
- **Jobs** — the active job with progress, segments, log and result, plus recent jobs.
- **Gallery** — finished videos from `Videos/`; preview, download/open, delete, select and merge.
- **Environment** — read-only status: ComfyUI, workflow path, ffmpeg/ffprobe, available agent tools, and the parsed workflow model, text encoder, VAE and upscalers.

### Prompt modes (agent tools)

The panel always uses **Full scene in every clip**. The native tools also accept `promptMode` and `segmentPrompts`.

- **Shot prompts** — one prompt per line; each clip gets its own action. Best for long storyboarded videos.
- **Full scene in every clip** — repeats the whole scene in every clip. Best for one continuous scene, but action may repeat.
- **Split by sentences** — distributes sentences across clips. Action progresses, but scene context may weaken.

### Workflow

ComfyUI runs an API-format workflow JSON. Default path:

```
$DSH_HOME/genvideo/workflow.json
```

Override with `GENVIDEO_COMFY_WORKFLOW`. Image-to-video uses `workflow-image.json` next to it, video-to-video uses `workflow-video.json`.

Supported placeholders:

| Placeholder | Value |
|---|---|
| `{{prompt}}` | positive prompt |
| `{{negative}}` | negative prompt |
| `{{width}}`, `{{height}}` | frame size |
| `{{frames}}` | frame count |
| `{{fps}}` | frame rate |
| `{{seed}}` | seed |
| `{{image}}` | uploaded image name in ComfyUI input |
| `{{video}}` | uploaded video name in ComfyUI input |

If an uploaded reference is present but the workflow has no corresponding placeholder, generation fails before submitting to ComfyUI.

### Agent tools

Native DSH tools:

`genvideo_status`, `genvideo_plan`, `genvideo_generate`, `genvideo_jobs`, `genvideo_job`, `genvideo_cancel`, `genvideo_merge`, `genvideo_transcode`.

`genvideo_plan` returns the preview and `planId`; `genvideo_generate` accepts `planId`, prompt, negative prompt, orientation (`landscape`/`portrait`), fps (15/24/30/60), denoise for V2V, transcode options and `inputImageId`/`inputVideoId`.

### Features

- ComfyUI is the only backend; models, VAEs and text encoders are managed there.
- Image and video reference uploads are sent to ComfyUI input and substituted into the workflow.
- Long videos are split into clips; each clip calls ComfyUI, then ffmpeg concatenates and transcodes.
- **LLM storyboard:** call `genvideo_plan` to get N, write N different prompts, and pass them as `segmentPrompts` to `genvideo_generate`. The UI has a `Shot prompts` field for the same list.
- **Continuity:** by default each clip starts from the last frame of the previous one (`workflow-image.json` + `{{image}}`); seeds change per clip when `seed=-1`.
- Transcode: no transcode, quality tiers or a size limit; MP4/WebM/GIF; H.264/H.265; ffmpeg encoder auto/CPU/NVENC/Vulkan.
- Detailed job progress over SSE; cancel; log tail.
- English/Russian UI; the language switcher is in the panel header.
- **Save defaults** persists duration, Format (Horizontal/Vertical), FPS, continuity, Denoise and transcode; clip length is automatic and the form rehydrates from saved settings on reload.

### Requirements

- DeepSeek Harness Web with a profile.
- Node.js 24+.
- `ffmpeg` and `ffprobe` in `PATH` (the Environment tab can install ffmpeg with `sudo -n apt-get`).
- A running ComfyUI server (default probes `127.0.0.1:8188`, `8189`, `8000`; override with `GENVIDEO_COMFY_URL`) and a valid workflow.
- All models used by the workflow must already be installed in ComfyUI.

### Install

1. Add `/home/main/TextToVideo` as a third-party plugin and enable the GenVideo bundle.
2. Refresh DSH. The film icon appears in the left sidebar.
3. Start ComfyUI and export the workflow in API format to `$DSH_HOME/genvideo/workflow.json`.
4. Open the panel and generate.

### ComfyUI setup script

`deploy/install-comfyui.sh` installs a working ComfyUI + LTX-Video 2B stack into a clean directory
(no Docker, no root). It pins ComfyUI `995456d0`, Python 3.12 (via `uv`), `torch 2.11.0+cu130`,
downloads the LTX 0.9.8 fp8 checkpoint, the `t5xxl_fp8` encoder and the `2xNomosUni` upscaler
(~10 GB), and copies the bundled UI workflows.

```bash
bash deploy/install-comfyui.sh --dir ~/comfyui --cuda-device 1 --port 8188
bash ~/comfyui/start-comfyui.sh
```

Useful flags:

| Flag | Effect |
|---|---|
| `--models-from /path/to/ComfyUI/models` | copy models instead of downloading ~10 GB |
| `--with-extra` | also fetch the bf16 checkpoint and both LTX VAEs (+7 GB) |
| `--no-models` | install code only |
| `--force-plugin-workflow` | overwrite the existing `$DSH_HOME/genvideo/workflow.json` |

The existing `$DSH_HOME/genvideo/workflow.json` is never overwritten unless
`--force-plugin-workflow` is passed. After the install, set the ComfyUI URL
(`http://127.0.0.1:8188`) in Settings → Advanced.

### Build

```bash
npm install
npm run build     # host + client bundle + dist checks
npm test          # 45 tests, including ffmpeg mock e2e
```

`dist/` is committed, so installation does not require a build. On first activation the bundled `workflows/ltxv-*.json` templates are copied to `$DSH_HOME/genvideo` only when the target file is missing; custom workflows are never overwritten.

### Folders

| Path | Content |
|---|---|
| `<project>/Videos/` | finished videos |
| `$DSH_HOME/genvideo/workflow.json` | ComfyUI API workflow |
| `$DSH_HOME/genvideo/workflow-image.json` | optional image-to-video workflow |
| `$DSH_HOME/genvideo/workflow-video.json` | video-to-video workflow (bundled) |
| `$DSH_HOME/genvideo/settings.json` | output dir, language, generation/transcode defaults |
| `$DSH_HOME/genvideo/jobs.json`, `logs/` | job history and logs |
| `$DSH_HOME/genvideo/work/` | temporary segments and merge scratch |

---

## Русский

GenVideo — плагин DeepSeek Harness, который работает с локальным сервером **ComfyUI**. Он добавляет панель в левом сайдбаре и нативные инструменты `genvideo_*` для агента. Модели и текстовые энкодеры находятся в ComfyUI; плагин их не скачивает и не устанавливает.

Ориентиром была **NVIDIA RTX 3060 Ti с 8 ГБ VRAM**. Полный пайплайн LTX/Wan в 8 ГБ не помещается, поэтому бэкендом выбран **ComfyUI**: он умеет загружать квантованные **GGUF**-модели и текстовые энкодеры (Q4/Q5) и выгружать компоненты, благодаря чему модель класса 5B реально работает на этой карте.

### Архитектура

```
Vue 3 панель ── /genvideo/api ──┐
                                 ├─ Engine в Host-плагине ── ComfyUI HTTP API
Агент ── нативные genvideo_* tools┘
```

Движок работает внутри Host-плагина. Панель обслуживается через `/genvideo`, агенту доступны нативные DSH-инструменты `genvideo_*`.

### Вкладки

- **Generate** — пронумерованные секции (Введите промпт → Исходник → Выход → Кодирование); промпт/негатив, референс-картинка и видео, длительность, **Format** (Horizontal 16:9 / Vertical 9:16), **FPS** (15/24/30/60), непрерывность и транскод. Длина клипа выбирается автоматически по VRAM.
- **Предпросмотр** — Generate сначала строит план: итоговый/base размер, fps, auto clip, кадры, число клипов и warnings; job создаётся только после **Confirm generation**.
- **Качество промптов** — у каждого клипа T2V/I2V свой подробный промпт (профиль LTX: 80–220 слов, субъект, локация, свет, камера, действие, continuity). Короткие и повторные промпты видны в preview; число промптов должно совпадать с числом клипов.
- **Режимы** — без референсов: T2V, затем последний кадр → I2V для следующих клипов; reference image: I2V от неё, затем последний кадр; reference video: один V2V-клип без цепочки. Картинка и видео взаимоисключающие.
- **Резкость** — после 2× апскейла и финального `ImageScale` каждый workflow прогоняет `ImageSharpen` (radius 1, sigma 1.0, alpha 0.8); `SaveWEBM` пишет crf 24 вместо 32.
- **V2V** — опорное видео проходит `LoadVideo → GetVideoComponents → VAEEncodeTiled`, перерисовывается через `SplitSigmasDenoise` (0.3–0.8, по умолчанию 0.6), затем апскейл и сохранение. V2V — один клип, обрезается до 8n+1 кадров (максимум 257).
- **Jobs** — активная генерация с прогрессом, сегментами, логом и результатом; ниже последние задания.
- **Gallery** — готовые ролики из `Videos/`: просмотр, скачивание/открытие, удаление, выбор и склейка.
- **Environment** — статус только для чтения: ComfyUI, путь workflow, ffmpeg/ffprobe, доступные tools, а также модель, текстовый энкодер, VAE и апскейлеры из workflow.

### Prompt modes (agent tools)

The panel always uses **Full scene in every clip**. The native tools also accept `promptMode` and `segmentPrompts`.

- **Shot prompts** — one prompt per line; each clip gets its own action. Best for long storyboarded videos.
- **Full scene in every clip** — repeats the whole scene in every clip. Best for one continuous scene, but action may repeat.
- **Split by sentences** — distributes sentences across clips. Action progresses, but scene context may weaken.

### Prompt modes (agent tools)

The panel always uses **Full scene in every clip**. The native tools also accept `promptMode` and `segmentPrompts`.

- **Shot prompts** — один промпт на строку; у каждого клипа своё действие. Лучший вариант для длинной раскадровки.
- **Full scene in every clip** — повторяет всю сцену в каждом клипе. Лучше для одной непрерывной сцены, но действие может повторяться.
- **Split by sentences** — распределяет предложения по клипам. Действие меняется, но контекст сцены может размываться.

### Workflow

ComfyUI запускает workflow в API-формате JSON. Путь по умолчанию:

```
$DSH_HOME/genvideo/workflow.json
```

Переопределяется через `GENVIDEO_COMFY_WORKFLOW`. Для image-to-video используется `workflow-image.json` рядом, для video-to-video — `workflow-video.json`.

Поддерживаемые плейсхолдеры: `{{prompt}}`, `{{negative}}`, `{{baseWidth}}`, `{{baseHeight}}`, `{{outWidth}}`, `{{outHeight}}`, `{{frames}}`, `{{fps}}`, `{{seed}}`, `{{image}}`, `{{video}}`.

Если референс загружен, а плейсхолдера в workflow нет — генерация завершится ошибкой до отправки в ComfyUI.

### Инструменты агента

`genvideo_status`, `genvideo_plan`, `genvideo_generate`, `genvideo_jobs`, `genvideo_job`, `genvideo_cancel`, `genvideo_merge`, `genvideo_transcode`.

### Возможности

- Единственный бэкенд — ComfyUI; модели, VAE и текстовые энкодеры настраиваются в нём.
- Референс-картинка и видео загружаются в input ComfyUI и подставляются в workflow.
- Длинное видео делится на клипы; каждый клип генерируется через ComfyUI, затем ffmpeg склеивает и транскодирует.
- **LLM-раскадровка:** вызвать `genvideo_plan`, получить N, написать N разных промптов и передать их массивом `segmentPrompts` в `genvideo_generate`. В UI для этого есть поле `Shot prompts`.
- **Непрерывность:** по умолчанию каждый клип начинается с последнего кадра предыдущего (`workflow-image.json` + `{{image}}`); при `seed=-1` seed меняется для каждого клипа.
- Транскод: без транскода, уровни качества или лимит размера; MP4/WebM/GIF; H.264/H.265; энкодер ffmpeg auto/CPU/NVENC/Vulkan.
- Подробный прогресс по SSE, отмена, лог.
- Интерфейс EN/RU; переключатель языка находится в шапке панели.
- **Save defaults** сохраняет длительность, Format (Horizontal/Vertical), FPS, непрерывность, Denoise и транскод; длина клипа автоматическая, форма восстанавливается из настроек после перезагрузки.

### Требования

- DeepSeek Harness Web с профилем.
- Node.js 24+.
- `ffmpeg` и `ffprobe` в `PATH` (вкладка Environment умеет установить ffmpeg через `sudo -n apt-get`).
- Запущенный ComfyUI (по умолчанию `127.0.0.1:8188`, `8189`, `8000`; переопределяется `GENVIDEO_COMFY_URL`) и валидный workflow.
- Все модели workflow должны быть установлены в ComfyUI.

### Установка

1. Добавить `/home/main/TextToVideo` как сторонний плагин и включить бандл GenVideo.
2. Обновить DSH — иконка появится в сайдбаре.
3. Запустить ComfyUI и положить workflow в API-формате в `$DSH_HOME/genvideo/workflow.json`.
4. Открыть панель и генерировать.

### Скрипт установки ComfyUI

`deploy/install-comfyui.sh` ставит рабочий ComfyUI + LTX-Video 2B в отдельный каталог
(без Docker и без root). Фиксирует ComfyUI `995456d0`, Python 3.12 (через `uv`),
`torch 2.11.0+cu130`, скачивает fp8-чекпоинт LTX 0.9.8, энкодер `t5xxl_fp8` и
апскейлер `2xNomosUni` (~10 ГБ) и копирует воркфлоу из `deploy/ui-workflows/`.

```bash
bash deploy/install-comfyui.sh --dir ~/comfyui --cuda-device 1 --port 8188
bash ~/comfyui/start-comfyui.sh
```

Полезные флаги:

| Флаг | Что делает |
|---|---|
| `--models-from /path/to/ComfyUI/models` | копирует модели вместо скачивания ~10 ГБ |
| `--with-extra` | дополнительно bf16-чекпоинт и оба VAE LTX (+7 ГБ) |
| `--no-models` | только код, без моделей |
| `--force-plugin-workflow` | перезаписать существующий `$DSH_HOME/genvideo/workflow.json` |

Существующий `$DSH_HOME/genvideo/workflow.json` не перезаписывается без
`--force-plugin-workflow`. После установки укажите URL ComfyUI
(`http://127.0.0.1:8188`) в Settings → Advanced.

### Сборка

```bash
npm install
npm run build     # host + клиентский бандл + проверки dist
npm test          # 45 тестов, включая ffmpeg mock e2e
```

### Папки

| Путь | Содержимое |
|---|---|
| `<project>/Videos/` | готовые ролики |
| `$DSH_HOME/genvideo/workflow.json` | ComfyUI API workflow |
| `$DSH_HOME/genvideo/workflow-image.json` | опциональный image-to-video workflow |
| `$DSH_HOME/genvideo/workflow-video.json` | video-to-video workflow (встроенный) |
| `$DSH_HOME/genvideo/settings.json` | output dir, язык, дефолты генерации/транскода |
| `$DSH_HOME/genvideo/jobs.json`, `logs/` | история заданий и логи |
| `$DSH_HOME/genvideo/work/` | временные сегменты и скретч склейки |
