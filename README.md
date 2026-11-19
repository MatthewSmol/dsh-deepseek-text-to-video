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

There is no MCP server, no stdio transport and no `endpoint.json`. The plugin starts the engine in-process, serves the panel over `/genvideo`, and registers native DSH tools for the agent.

### Tabs

- **Generate** — numbered sections (Scene → References → Output → Encoding), actions at the top, prompt/negative, reference image and video, prompt mode, duration/clip/platform/aspect/resolution/FPS and ffmpeg transcode settings.
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

Native DSH tools (no MCP):

`genvideo_status`, `genvideo_plan`, `genvideo_generate`, `genvideo_jobs`, `genvideo_job`, `genvideo_cancel`, `genvideo_merge`, `genvideo_transcode`.

`genvideo_generate` accepts prompt, negative prompt, prompt mode, duration/clip, platform/aspect/size/fps, transcode options and `inputImageId`/`inputVideoId`.

### Features

- ComfyUI is the only backend; models, VAEs and text encoders are managed there.
- Image and video reference uploads are sent to ComfyUI input and substituted into the workflow.
- Long videos are split into clips; each clip calls ComfyUI, then ffmpeg concatenates and transcodes.
- **LLM storyboard:** call `genvideo_plan` to get N, write N different prompts, and pass them as `segmentPrompts` to `genvideo_generate`. The UI has a `Shot prompts` field for the same list.
- **Continuity:** by default each clip starts from the last frame of the previous one (`workflow-image.json` + `{{image}}`); seeds change per clip when `seed=-1`.
- Transcode: no transcode, quality tiers or a size limit; MP4/WebM/GIF; H.264/H.265; ffmpeg encoder auto/CPU/NVENC/Vulkan.
- Detailed job progress over SSE; cancel; log tail.
- English/Russian UI; the language switcher is in the panel header.
- **Save defaults** persists duration, clip length, platform, aspect, resolution, FPS, prompt mode, continuity and transcode; the form rehydrates from saved settings on reload.

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

### Build

```bash
npm install
npm run build     # host + client bundle + dist checks
npm test          # 45 tests, including ffmpeg mock e2e
```

`dist/` is committed, so installation does not require a build.

### Folders

| Path | Content |
|---|---|
| `<project>/Videos/` | finished videos |
| `$DSH_HOME/genvideo/workflow.json` | ComfyUI API workflow |
| `$DSH_HOME/genvideo/workflow-image.json` | optional image-to-video workflow |
| `$DSH_HOME/genvideo/workflow-video.json` | optional video-to-video workflow |
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

MCP-сервера, stdio-транспорта и `endpoint.json` больше нет. Движок работает внутри Host-плагина, панель обслуживается через `/genvideo`, а агенту доступны нативные DSH-инструменты.

### Вкладки

- **Generate** — пронумерованные секции (Сцена → Референсы → Выход → Кодирование), действия сверху, промпт/негатив, референс-картинка и видео, режим промпта, длительность/клип/платформа/аспект/разрешение/FPS и настройки транскода.
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

Поддерживаемые плейсхолдеры: `{{prompt}}`, `{{negative}}`, `{{width}}`, `{{height}}`, `{{frames}}`, `{{fps}}`, `{{seed}}`, `{{image}}`, `{{video}}`.

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
- **Save defaults** сохраняет длительность, длину клипа, платформу, аспект, разрешение, FPS, режим промпта, непрерывность и транскод; форма восстанавливается из настроек после перезагрузки.

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
| `$DSH_HOME/genvideo/workflow-video.json` | опциональный video-to-video workflow |
| `$DSH_HOME/genvideo/settings.json` | output dir, язык, дефолты генерации/транскода |
| `$DSH_HOME/genvideo/jobs.json`, `logs/` | история заданий и логи |
| `$DSH_HOME/genvideo/work/` | временные сегменты и скретч склейки |
