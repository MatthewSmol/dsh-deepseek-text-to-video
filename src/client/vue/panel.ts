/**
 * RU: Клиентская панель GenVideo для DSH Web на Vue 3 (Composition API,
 *     render-функции). Регистрирует иконку в левом сайдбаре, главную панель и
 *     раздел настроек; стили — собственный CSS с префиксом `gv-`, встроенный в
 *     бандл через Vite `?inline`.
 * EN: GenVideo client panel for DSH Web built with Vue 3 (Composition API,
 *     render functions). Registers a left-sidebar icon, the main panel and a
 *     settings section; styles are scoped plain CSS with the `gv-` prefix,
 *     embedded into the bundle through Vite `?inline`.
 */
import { h, ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'

import styles from '../styles.css?inline'

const NS = 'genvideo'
const PANEL_ID = 'genvideo'
const API = '/genvideo/api'

/** RU: Английский словарь. EN: English dictionary. */
const en: Record<string, string> = {
  nav: 'GenVideo', title: 'GenVideo', subtitle: 'Text to local video through the MCP service',
  generate: 'Generate', jobs: 'Jobs', gallery: 'Gallery', environment: 'Environment',
  refresh: 'Refresh', loading: 'Loading…', save: 'Save', saved: 'Saved', reset: 'Reset', cancel: 'Cancel', close: 'Close',
  done: 'Done', failed: 'Failed', running: 'Running', queued: 'Queued', cancelled: 'Cancelled',
  progress: 'Progress', phase: 'Phase', segment: 'Segment', eta: 'ETA', elapsed: 'Elapsed',
  install: 'Install', installing: 'Installing…', installed: 'Installed', notInstalled: 'Not installed',
  update: 'Update', checkUpdates: 'Check updates', model: 'Model', runner: 'Runner', auto: 'Auto',
  prompt: 'Prompt', promptHint: 'Describe scene, camera, lighting and action. Long prompts are split between segments.',
  duration: 'Duration', durationHint: 'Longer than the model clip limit is generated as segments and merged.', perClip: 'max/clip',
  platform: 'Platform', aspect: 'Aspect', resolution: 'Resolution', fps: 'FPS', seed: 'Seed', random: 'random',
  negative: 'Negative prompt', continuity: 'Continuity', none: 'None', lastFrame: 'Last frame → next clip',
  imageInput: 'Reference image (image-to-video)', videoInput: 'Reference video (video-to-video)',
  i2vHint: 'Needs the diffusers LTX-Video 0.9.8 2B (i2v) model and the Python engine; the Candle build is text-to-video only.', denoise: 'Denoise', denoiseHint: '0.35–0.5 keeps motion and background; 0.55–0.75 redraws strongly.',
  referenceInput: 'Reference input', switchToI2v: 'Choose i2v model',
  v2vHint: 'No built-in model supports video input yet.',
  chooseFile: 'Choose file', removeFile: 'Remove', advanced: 'Advanced', steps: 'Steps', guidance: 'Guidance',
  clipLength: 'Clip length', videoFormat: 'Format', clipLengthHint: 'Length of one generated clip. The last clip may be shorter.', promptMode: 'Prompt mode',
  promptFull: 'Full scene in every clip', promptSplit: 'Split by sentences', promptShots: 'Shot prompts', shotPrompts: 'Shot prompts (one per line)', shotPromptsHint: 'One prompt per clip. The agent or you can write N different actions; empty lines are ignored.',
  promptModeHint: 'Full scene repeats the whole description in every clip (best for one continuous scene).',
  promptModeHintShots: 'One prompt per clip. Write N different actions; best for long storyboarded videos.',
  promptModeHintSplit: 'Splits the text by sentences across clips. Action progresses, but scene context may weaken.',
  transcode: 'Transcode after generation', transcodeHint: 'Pick one: no transcode, quality tiers, or a size limit.', noTranscode: 'No transcode',
  codec: 'MP4 codec', codecH264: 'H.264 (AVC)', codecH265: 'H.265 (HEVC)', codecHint: 'MP4 only; WebM/GIF ignore it. H.265 needs a player with HEVC support.',
  encoder: 'Encoder for ffmpeg', encoderAuto: 'Auto (CPU fallback)', encoderCpu: 'CPU (libx264)', encoderVulkan: 'Vulkan Video', encoderNvenc: 'NVIDIA NVENC',
  encoderHint: 'FFmpeg encoder for the final file. Auto tries NVENC, then CPU libx264; Vulkan needs an NVIDIA ICD.',
  candleArgs: 'candle-video extra arguments', candleArgsHint: 'One argv per line; for a custom Vulkan build, e.g. --device and vulkan.',
  quality: 'Quality', sizeLimit: 'Size limit', mb: 'MB', high: 'High', medium: 'Medium', compressed: 'Max compression',
  format: 'Format', fit: 'Fit', released: 'Released', contain: 'Contain (bars)', cover: 'Cover (crop)', source: 'Source',
  estimate: 'Estimate', vram: 'VRAM', generationTime: 'Generation time', fitVram: 'Fit to VRAM', fitVramBusy: 'Finding a fit…', fitVramResult: 'Applied: {dims}, {sec}s → ~{gb} GB VRAM', fitVramFailed: 'Nothing fits even at the lowest resolution; use CPU offload or a smaller model.', time: 'Time', size: 'Size', segments: 'Segments', warnings: 'Warnings',
  generateButton: 'Generate video', generating: 'Starting…',
  gpu: 'GPU', gpuNone: 'No CUDA GPU detected', gpuHint: 'Only the Mock runner can produce video without a GPU.',
  totalMemory: 'Total', usedMemory: 'Used', gpuStrategy: 'Strategy', single: 'Single GPU',
  roundRobin: 'Round-robin', tensorParallel: 'Tensor parallel',
  tools: 'Tools',
  enginesIntro: 'Video generation runs through a ComfyUI server with a model workflow. Mock is always available for a quick check.',
  engineReady: 'Ready', engineMissing: 'Not installed', recommended: 'Recommended',
  pythonEngine: 'Python engine (diffusers)', pythonEngineDesc: 'Diffusers models, including LTX-Video 0.9.8 2B and image-to-video. About 5 GB, no root.',
  candleEngine: 'Candle (Rust + CUDA)', candleEngineDesc: 'Faster on NVIDIA. Needs the CUDA toolkit (nvcc); the build takes 10–20 minutes.',
  cudaRequired: 'Install the CUDA toolkit first in Ubuntu:', cudaReady: 'CUDA toolkit found',
  cudaOld: 'CUDA is too old for this glibc. Install CUDA 13.x:', cudaToolkitUpgrade: 'sudo apt-get install -y cuda-toolkit-13-5',
  buildDepsRequired: 'Install build dependencies first in Ubuntu:', buildDepsReady: 'Build dependencies found',
  comfyEngine: 'ComfyUI', comfyEngineDesc: 'External server; the plugin auto-probes 127.0.0.1:8188, 8189 and 8000.',
  comfyCheck: 'Check again', mockEngine: 'Mock', mockEngineDesc: 'Synthetic video without a GPU, useful to test the pipeline.',
  alwaysAvailable: 'Always available', systemTools: 'System tools',
  enginesNote: 'The plugin downloads models and starts engines automatically when it can. Everything below is an optional override, not required setup.',
  candleVideo: 'candle-video', candleNotFound: 'Not found; auto-checked in PATH and ./candle-video/target/release/examples/ltx-video. Building needs the CUDA toolkit (nvcc).',
  buildCandle: 'Build candle engine', buildStarted: 'Candle build started; progress is in Jobs.',
  cargoHint: 'Needed only to build candle-video; Python and ComfyUI do not require Rust.',
  advancedEngines: 'Advanced: external engine overrides', advancedHint: 'Empty values mean auto-detect.', autoHint: 'Empty = auto-detect.',
  ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', python: 'Python', venv: 'Venv', cargo: 'Cargo',
  comfyui: 'ComfyUI', path: 'Path', test: 'Test', installFfmpeg: 'Install ffmpeg', installPython: 'Install Python engine',
  outputDir: 'Output folder', modelsDir: 'Models folder', language: 'Language', english: 'English', russian: 'Русский',
  defaults: 'Defaults', service: 'MCP service', uptime: 'Uptime', unavailable: 'Unavailable',
  mcpDown: 'Service unavailable', noJobs: 'No jobs yet.', noClips: 'Videos/ is empty.',
  selectClips: 'Select clips to merge', merge: 'Merge selected', merging: 'Merging…', play: 'Play', deleteClip: 'Delete', confirmDeleteClip: 'Delete this video from Videos?',
  modelCapabilities: 'Capabilities', requiredVram: 'Required VRAM', license: 'License', notes: 'Notes',
  newerVersion: 'Newer version available', installModel: 'Install model', weightsInstalled: 'Weights installed', deleteModel: 'Delete model', confirmDeleteModel: 'Delete the model files from disk?', deletedModel: 'Model deleted', deleting: 'Deleting…', addModel: 'Add a custom model',
  repo: 'Hugging Face repo', runtime: 'Runner', commandTemplate: 'Command template (one argv token per line)',
  weights: 'Weights (one file per line)', removeModel: 'Delete model', saveModel: 'Save model',
  saveDefaults: 'Save settings', uploading: 'Uploading…', planFailed: 'Could not build the plan', qualityMode: 'Quality tiers', sizeMode: 'Size limit',
  mcpTools: 'Tools', version: 'Version', settingsHint: 'Stored in DSH_HOME/genvideo/settings.json.',
  outputHint: 'Default: <project>/Videos', modelsHint: 'Default: <project>/models', seedHint: '-1 = random',
  stepsHint: '0 = model default', negativeHint: 'What to avoid in the shot', inputHint: 'The model must support this input.', sectionScene: 'Enter prompt', sectionReferences: 'Source', sectionOutput: 'Output', sectionEncoding: 'Encoding', sourceHint: 'The base to start from: a reference image or video.',
  jobsHint: 'Live progress comes from the local GenVideo engine via SSE.', stageSample: 'Sample', stageUpscale: 'Upscale', stageMerge: 'Merge', stageEncode: 'Encode', stageReady: 'Ready', currentStep: 'Current step', clip: 'clip', libraryHint: 'Finished videos from the Videos folder.',
  gpuSelect: 'GPUs to use', budgetHint: '0 = no limit; compare with the GPU total above.',
  ffmpegMissing: 'ffmpeg is missing: generation and merging are unavailable.',
  comfyuiHint: 'URL of a running ComfyUI, e.g. http://127.0.0.1:8188', candleHint: 'Path to the built candle-video binary',
  pythonHint: 'Creates a venv with torch and diffusers (several GB).', confirmPython: 'Install the Python engine? This downloads several gigabytes.',
  confirmReset: 'Reset every GenVideo setting to defaults?', savedSettings: 'Settings saved', uploadFailed: 'Upload failed',
  modelInstalled: 'Model installation started', noSelection: 'Select at least two clips', inputMissing: 'Upload an input file first',
}

/** RU: Русский словарь. EN: Russian dictionary. */
const ru: Record<string, string> = {
  nav: 'GenVideo', title: 'GenVideo', subtitle: 'Текст в локальное видео через MCP-сервис',
  generate: 'Генерация', jobs: 'Задания', gallery: 'Галерея', environment: 'Окружение',
  refresh: 'Обновить', loading: 'Загрузка…', save: 'Сохранить', saved: 'Сохранено', reset: 'Сбросить', cancel: 'Отмена', close: 'Закрыть',
  done: 'Готово', failed: 'Ошибка', running: 'Выполняется', queued: 'В очереди', cancelled: 'Отменено',
  progress: 'Прогресс', phase: 'Фаза', segment: 'Сегмент', eta: 'Осталось', elapsed: 'Прошло',
  install: 'Установить', installing: 'Установка…', installed: 'Установлена', notInstalled: 'Не установлена',
  update: 'Обновить', checkUpdates: 'Проверить обновления', model: 'Модель', runner: 'Раннер', auto: 'Авто',
  prompt: 'Промпт', promptHint: 'Опишите сцену, камеру, свет и действие. Длинный промпт делится между сегментами.',
  duration: 'Длительность', durationHint: 'Если дольше лимита клипа модели — генерация сегментами и склейка.', perClip: 'макс/клип',
  platform: 'Платформа', aspect: 'Аспект', resolution: 'Разрешение', fps: 'Кадры/с', seed: 'Seed', random: 'случайно',
  negative: 'Негативный промпт', continuity: 'Непрерывность', none: 'Нет', lastFrame: 'Последний кадр → следующий клип',
  imageInput: 'Опорная картинка (image-to-video)', videoInput: 'Опорное видео (video-to-video)',
  i2vHint: 'Нужна diffusers-модель LTX-Video 0.9.8 2B (i2v) и Python-движок; Candle-сборка умеет только text-to-video.', denoise: 'Denoise', denoiseHint: '0.35–0.5 сохраняет движение и фон; 0.55–0.75 сильно перерисовывает.',
  referenceInput: 'Опорный вход', switchToI2v: 'Выбрать i2v-модель',
  v2vHint: 'Встроенные модели пока не поддерживают видео-вход.',
  chooseFile: 'Выбрать файл', removeFile: 'Убрать', advanced: 'Дополнительно', steps: 'Шаги', guidance: 'Guidance',
  clipLength: 'Длина клипа', videoFormat: 'Формат', clipLengthHint: 'Длительность одного клипа. Последний может быть короче.', promptMode: 'Режим промпта',
  promptFull: 'Полная сцена в каждом клипе', promptSplit: 'Разбить по предложениям', promptShots: 'Промпты по кадрам', shotPrompts: 'Промпты по клипам (по одному в строке)', shotPromptsHint: 'Один промпт на клип. Агент или вы пишете N разных действий; пустые строки игнорируются.',
  promptModeHint: 'Полная сцена повторяет всё описание в каждом клипе (лучше для одной непрерывной сцены).',
  promptModeHintShots: 'Один промпт на клип. Напишите N разных действий; лучший вариант для длинной раскадровки.',
  promptModeHintSplit: 'Делит текст по предложениям между клипами. Действие меняется, но контекст сцены может размываться.',
  transcode: 'Перекодировать после генерации', transcodeHint: 'Один режим: без перекодирования, уровни качества или лимит размера.', noTranscode: 'Без перекодирования',
  codec: 'Кодек MP4', codecH264: 'H.264 (AVC)', codecH265: 'H.265 (HEVC)', codecHint: 'Только для MP4; WebM/GIF игнорируют. Для H.265 нужен плеер с поддержкой HEVC.',
  encoder: 'Энкодер для ffmpeg', encoderAuto: 'Авто (fallback на CPU)', encoderCpu: 'CPU (libx264)', encoderVulkan: 'Vulkan Video', encoderNvenc: 'NVIDIA NVENC',
  encoderHint: 'Энкодер ffmpeg для итогового файла. Auto пробует NVENC, затем CPU libx264; Vulkan требует NVIDIA ICD.',
  candleArgs: 'Дополнительные аргументы candle-video', candleArgsHint: 'По одному argv в строке; для своей Vulkan-сборки, например --device и vulkan.',
  quality: 'Качество', sizeLimit: 'Лимит размера', mb: 'МБ', high: 'Высокое', medium: 'Среднее', compressed: 'Максимальное сжатие',
  format: 'Формат', fit: 'Вписывание', released: 'Вышла', contain: 'Вписать (поля)', cover: 'Заполнить (обрезка)', source: 'Исходное',
  estimate: 'Оценка', vram: 'VRAM', generationTime: 'Время генерации', fitVram: 'Подогнать под VRAM', fitVramBusy: 'Подбираю…', fitVramResult: 'Применено: {dims}, {sec} с → ~{gb} ГБ VRAM', fitVramFailed: 'Даже минимальное разрешение не влезает; нужен offload или модель поменьше.', time: 'Время', size: 'Размер', segments: 'Сегменты', warnings: 'Предупреждения',
  generateButton: 'Сгенерировать видео', generating: 'Запуск…',
  gpu: 'GPU', gpuNone: 'CUDA GPU не найдена', gpuHint: 'Без GPU видео может создать только Mock-раннер.',
  totalMemory: 'Всего', usedMemory: 'Занято', gpuStrategy: 'Стратегия', single: 'Одна GPU',
  roundRobin: 'По очереди', tensorParallel: 'Tensor parallel',
  tools: 'Инструменты',
  enginesIntro: 'Генерация идёт через сервер ComfyUI с workflow модели. Mock всегда доступен для быстрой проверки.',
  engineReady: 'Готов', engineMissing: 'Не установлен', recommended: 'Рекомендуется',
  pythonEngine: 'Python-движок (diffusers)', pythonEngineDesc: 'Модели diffusers, включая LTX-Video 0.9.8 2B и image-to-video. Около 5 ГБ, без sudo.',
  candleEngine: 'Candle (Rust + CUDA)', candleEngineDesc: 'Быстрее на NVIDIA. Нужен CUDA toolkit (nvcc); сборка 10–20 минут.',
  cudaRequired: 'Сначала установите CUDA toolkit в Ubuntu:', cudaReady: 'CUDA toolkit найден',
  cudaOld: 'CUDA слишком старая для этой glibc. Установите CUDA 13.x:', cudaToolkitUpgrade: 'sudo apt-get install -y cuda-toolkit-13-5',
  buildDepsRequired: 'Сначала установите зависимости сборки в Ubuntu:', buildDepsReady: 'Зависимости сборки найдены',
  comfyEngine: 'ComfyUI', comfyEngineDesc: 'Внешний сервер; плагин сам ищет 127.0.0.1:8188, 8189 и 8000.',
  comfyCheck: 'Проверить снова', mockEngine: 'Mock', mockEngineDesc: 'Синтетическое видео без GPU — для проверки пайплайна.',
  alwaysAvailable: 'Всегда доступен', systemTools: 'Системные инструменты',
  enginesNote: 'Плагин сам скачивает модели и по возможности запускает движки. Всё ниже — необязательное переопределение, а не обязательная настройка.',
  candleVideo: 'candle-video', candleNotFound: 'Не найден; проверяется PATH и ./candle-video/target/release/examples/ltx-video. Для сборки нужен CUDA toolkit (nvcc).',
  buildCandle: 'Собрать candle-движок', buildStarted: 'Сборка Candle запущена; прогресс во вкладке «Задания».',
  cargoHint: 'Нужен только для сборки candle-video; Python и ComfyUI не требуют Rust.',
  advancedEngines: 'Дополнительно: переопределения внешних движков', advancedHint: 'Пустое значение = автоопределение.', autoHint: 'Пусто = автоопределение.',
  ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', python: 'Python', venv: 'Окружение', cargo: 'Cargo',
  comfyui: 'ComfyUI', path: 'Путь', test: 'Проверить', installFfmpeg: 'Установить ffmpeg', installPython: 'Установить Python-движок',
  outputDir: 'Папка результатов', modelsDir: 'Папка моделей', language: 'Язык', english: 'English', russian: 'Русский',
  defaults: 'Значения по умолчанию', service: 'MCP-сервис', uptime: 'Аптайм', unavailable: 'Недоступен',
  mcpDown: 'Сервис недоступен', noJobs: 'Заданий пока нет.', noClips: 'Папка Videos/ пуста.',
  selectClips: 'Выберите ролики для склейки', merge: 'Склеить выбранные', merging: 'Склейка…', play: 'Смотреть',
  modelCapabilities: 'Возможности', requiredVram: 'Нужно VRAM', license: 'Лицензия', notes: 'Примечания',
  newerVersion: 'Доступна более новая версия', installModel: 'Установить модель', weightsInstalled: 'Веса установлены', deleteModel: 'Удалить модель', confirmDeleteModel: 'Удалить файлы модели с диска?', deletedModel: 'Модель удалена', deleting: 'Удаление…', addModel: 'Своя модель',
  repo: 'Репозиторий Hugging Face', runtime: 'Раннер', commandTemplate: 'Шаблон команды (по одному токену в строке)',
  weights: 'Файлы весов (по одному в строке)', removeModel: 'Удалить модель', saveModel: 'Сохранить модель',
  saveDefaults: 'Сохранить настройки', uploading: 'Загрузка…', planFailed: 'Не удалось построить план', qualityMode: 'Уровни качества', sizeMode: 'Лимит размера',
  mcpTools: 'Инструменты', version: 'Версия', settingsHint: 'Хранится в DSH_HOME/genvideo/settings.json.',
  outputHint: 'По умолчанию: <проект>/Videos', modelsHint: 'По умолчанию: <проект>/models', seedHint: '-1 = случайный',
  stepsHint: '0 = по умолчанию модели', negativeHint: 'Чего избегать в кадре', inputHint: 'Модель должна поддерживать этот вход.', sectionScene: 'Введите промпт', sectionReferences: 'Исходник', sectionOutput: 'Выход', sectionEncoding: 'Кодирование', sourceHint: 'База, от чего отталкиваться: референс-картинка или видео.',
  jobsHint: 'Прогресс приходит от локального движка GenVideo по SSE.', stageSample: 'Сэмплинг', stageUpscale: 'Апскейл', stageMerge: 'Склейка', stageEncode: 'Кодирование', stageReady: 'Готово', currentStep: 'Текущий шаг', clip: 'клип', libraryHint: 'Готовые ролики из папки Videos.',
  gpuSelect: 'Используемые GPU', budgetHint: '0 = без лимита; сравнивайте с объёмом GPU выше.',
  ffmpegMissing: 'ffmpeg не найден: генерация и склейка недоступны.',
  comfyuiHint: 'URL запущенного ComfyUI, например http://127.0.0.1:8188', candleHint: 'Путь к собранному бинарю candle-video',
  pythonHint: 'Создаст venv с torch и diffusers (несколько ГБ).', confirmPython: 'Установить Python-движок? Это скачает несколько гигабайт.',
  confirmReset: 'Сбросить все настройки GenVideo?', savedSettings: 'Настройки сохранены', uploadFailed: 'Не удалось загрузить файл',
  modelInstalled: 'Загрузка модели запущена', noSelection: 'Выберите минимум два ролика', inputMissing: 'Сначала загрузите входной файл',
}

/** RU: Функция перевода для выбранного языка. EN: Translation function for a language. */
function makeT(language: string): (key: string) => string {
  const dict = language === 'ru' ? ru : en
  return (key: string) => dict[key] ?? en[key] ?? key
}

/** RU: Размер в человекочитаемом виде. EN: Human-readable bytes. */
function fmtBytes(bytes: number): string {
  const value = Number(bytes) || 0
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)} GB`
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)} MB`
  if (value >= 1e3) return `${Math.round(value / 1e3)} KB`
  return `${Math.round(value)} B`
}

/** RU: Длительность в человекочитаемом виде. EN: Human-readable duration. */
function fmtDuration(seconds: number): string {
  const value = Number(seconds) || 0
  if (value <= 0) return '—'
  if (value < 60) return `${value.toFixed(1)}s`
  const total = Math.round(value)
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`
}

/** RU: Помещается ли оценка VRAM в лимит. EN: Whether the VRAM estimate fits the limit. */
function fitsVram(vramGB: number | null, limitGB: number): boolean {
  return vramGB !== null && vramGB > 0 && vramGB <= limitGB
}

/** RU: Компактное число (1.2K, 3.4M). EN: Compact count (1.2K, 3.4M). */
function fmtCount(value: number): string {
  const n = Number(value) || 0
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(n)
}

/** RU: Время ЧЧ:ММ. EN: HH:MM time. */
function fmtTime(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return '—'
  }
}

/** RU: Вызов API с проверкой конверта ok/error. EN: API call with the ok/error envelope. */
async function api(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  let payload: any = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  if (!response.ok || payload?.ok === false) {
    const error = new Error(payload?.error?.message || payload?.error?.code || `HTTP ${response.status}`)
    ;(error as any).code = payload?.error?.code
    throw error
  }
  return payload?.value
}

/** RU: Тон бейджа по статусу. EN: Badge tone by status. */
function statusTone(status: string): string {
  if (status === 'done') return 'gv-border-ok-soft gv-bg-ok-soft gv-text-ok'
  if (status === 'failed') return 'gv-border-danger-soft gv-bg-danger-soft gv-text-danger'
  if (status === 'running') return 'gv-border-brand-soft gv-bg-brand-soft gv-text-brand'
  return 'gv-border-line gv-bg-surface-2 gv-text-muted'
}

/** RU: Значения формы по умолчанию. EN: Default form values. */
function emptyForm(settings?: any) {
  return {
    prompt: '',
    negativePrompt: settings?.negativePrompt ?? '',
    modelId: 'comfyui-workflow',
    runner: 'comfyui',
    platform: settings?.platform ?? 'youtube',
    aspect: settings?.aspect ?? '16:9',
    width: settings?.orientation === 'portrait' ? 720 : 1280,
    height: settings?.orientation === 'portrait' ? 1280 : 720,
    fps: [15, 24, 30, 60].includes(settings?.fps) ? settings.fps : 30,
    targetDurationSec: settings?.targetDurationSec ?? 60,
    clipSec: 0,
    orientation: settings?.orientation ?? 'landscape',
    promptMode: 'full',
    segmentPrompts: '',
    continuity: settings?.continuity ?? 'last-frame',
    seed: settings?.seed ?? -1,
    steps: settings?.steps ?? 0,
    guidance: settings?.guidance ?? 0,
    denoise: settings?.denoise ?? 0.6,
    inputImageId: '',
    inputVideoId: '',
    transcode: {
      enabled: settings?.transcode?.enabled ?? true,
      mode: settings?.transcode?.mode ?? 'quality',
      quality: settings?.transcode?.quality ?? 'high',
      targetSizeMB: settings?.transcode?.targetSizeMB ?? 25,
      format: settings?.transcode?.format ?? 'mp4',
      codec: settings?.transcode?.codec ?? 'h265',
      encoder: settings?.transcode?.encoder ?? 'nvenc',
      width: settings?.transcode?.width ?? 0,
      height: settings?.transcode?.height ?? 0,
      fps: settings?.transcode?.fps ?? 0,
      fit: settings?.transcode?.fit ?? 'contain',
    },
  }
}

/** RU: Пустая форма своей модели. EN: Empty custom-model form. */
function emptyCustom() {
  return { id: '', title: '', repo: '', runtime: 'command', vramGB: 12, sizeGB: 0, durationSec: 4, fps: 24, width: 768, height: 512, supportsImage: false, supportsVideo: false, filesText: '', templateText: '' }
}

/** RU: Размеры под аспект и высоту. EN: Dimensions for an aspect and height. */
function dimsFor(height: number, aspect: string): { width: number; height: number } {
  const ratio = aspect === '9:16' ? 9 / 16 : aspect === '1:1' ? 1 : aspect === '4:5' ? 0.8 : aspect === '3:4' ? 0.75 : 16 / 9
  return { width: Math.round((height * ratio) / 2) * 2, height }
}

// RU: Переиспользуемые элементы интерфейса (функциональные компоненты Vue).
// EN: Reusable UI elements (Vue functional components).
const Icon = (props: any) =>
  h('svg', {
    viewBox: '0 0 64 64', width: props.size ?? 18, height: props.size ?? 18, 'aria-hidden': true,
    style: { display: 'block', color: props.active ? 'var(--dsw-alias-brand-primary)' : 'currentColor' },
  }, [
    h('rect', { x: 4, y: 6, width: 56, height: 52, rx: 10, fill: 'none', stroke: 'currentColor', 'stroke-width': 4 }),
    ...[14, 29, 44].map((y) => h('rect', { key: `l${y}`, x: 11, y, width: 6, height: 6, rx: 1.5, fill: 'currentColor' })),
    ...[14, 29, 44].map((y) => h('rect', { key: `r${y}`, x: 47, y, width: 6, height: 6, rx: 1.5, fill: 'currentColor' })),
    h('path', { d: 'M27 23.5v17a1.5 1.5 0 0 0 2.3 1.3l13.4-8.5a1.5 1.5 0 0 0 0-2.6L29.3 22.2A1.5 1.5 0 0 0 27 23.5Z', fill: '#e5484d' }),
  ])

// RU: Vue передаёт третий аргумент h() в слоты, а не в props.children —
//     поэтому компоненты читают и слот по умолчанию, и явный prop.
// EN: Vue puts the third h() argument into slots rather than props.children, so
//     components read both the default slot and an explicit prop.
const slotChildren = (props: any, ctx: any) =>
  props?.children ?? (typeof ctx?.slots?.default === 'function' ? ctx.slots.default() : undefined)

const Badge = (props: any, ctx: any) => h('span', { class: `gv-badge ${props.tone ?? ''}` }, slotChildren(props, ctx))

const Toggle = (props: any) =>
  h('label', { class: `gv-flex gv-items-start gv-justify-between gv-gap-4 gv-py-2 ${props.disabled ? 'gv-opacity-50' : 'gv-cursor-pointer'}` }, [
    h('span', { class: 'gv-flex gv-flex-col gv-gap-0.5' }, [
      h('span', { class: 'gv-text-[12.5px] gv-font-medium gv-text-text' }, props.label),
      props.hint ? h('span', { class: 'gv-hint' }, props.hint) : null,
    ]),
    h('button', {
      type: 'button', role: 'switch', 'aria-checked': Boolean(props.checked), disabled: props.disabled,
      onClick: () => !props.disabled && props.onChange(!props.checked),
      class: `gv-relative gv-h-5 gv-w-9 gv-shrink-0 gv-rounded-full gv-transition-colors ${props.checked ? 'gv-bg-brand' : 'gv-bg-line-2'}`,
    }, [h('span', { class: 'gv-absolute gv-top-0.5 gv-h-4 gv-w-4 gv-rounded-full gv-bg-white gv-transition-all', style: { left: props.checked ? '18px' : '2px' } })]),
  ])

const Segmented = (props: any) =>
  h('div', { class: 'gv-inline-flex gv-rounded-lg gv-border gv-border-line gv-bg-surface-2 gv-p-0.5' },
    (props.options ?? []).map((option: any) =>
      h('button', {
        key: option.value, type: 'button', onClick: () => props.onChange(option.value),
        class: `gv-seg gv-rounded-md gv-px-2.5 gv-py-1 gv-text-[11.5px] gv-font-medium gv-transition-colors ${props.value === option.value ? 'gv-seg-active gv-bg-surface gv-text-text gv-shadow-sm' : 'gv-text-muted'}`,
      }, option.label),
    ),
  )

const Field = (props: any, ctx: any) =>
  h('div', { class: 'gv-flex gv-flex-col gv-gap-1.5' }, [
    h('span', { class: 'gv-text-[12px] gv-font-medium gv-text-text' }, props.label),
    slotChildren(props, ctx),
    props.hint ? h('span', { class: 'gv-hint' }, props.hint) : null,
  ])

const Card = (props: any, ctx: any) =>
  h('section', { class: 'gv-card gv-p-4' }, [
    props.title
      ? h('div', { class: 'gv-mb-2 gv-flex gv-items-start gv-justify-between gv-gap-3' }, [
          h('div', null, [
            h('h3', { class: 'gv-group-title' }, props.title),
            props.hint ? h('p', { class: 'gv-hint gv-mt-0.5' }, props.hint) : null,
          ]),
          props.action ?? null,
        ])
      : null,
    slotChildren(props, ctx),
  ])

const Progress = (props: any) => {
  const value = Math.max(0, Math.min(100, Number(props.percent) || 0))
  return h('div', { class: 'gv-h-2 gv-w-full gv-overflow-hidden gv-rounded-full gv-bg-surface-3' },
    h('div', { class: `gv-h-full gv-rounded-full gv-transition-all ${props.tone ?? 'gv-bg-brand'}`, style: { width: `${value}%` } }))
}

const Row = (props: any, ctx: any) =>
  h('div', { class: 'gv-row' }, [
    h('div', { class: 'gv-min-w-0' }, [
      h('div', { class: 'gv-text-[12.5px] gv-font-medium gv-text-text' }, props.label),
      props.hint ? h('div', { class: 'gv-hint' }, props.hint) : null,
    ]),
    h('div', { class: 'gv-flex gv-shrink-0 gv-items-center gv-gap-2' }, slotChildren(props, ctx)),
  ])

/** RU: Основная панель. EN: Main panel. */
const Panel = {
  props: { surface: { type: String, default: 'main' } },
  setup(props: any) {
    const state = ref<any>(null)
    const tab = ref(props.surface === 'settings' ? 'settings' : 'generate')
    const form = ref<any>(emptyForm())
    let formHydrated = false
    const plan = ref<any>(null)
    const planError = ref('')
    const liveJobs = ref<Record<string, any>>({})
    const library = ref<any[]>([])
    const workflows = ref<any[]>([])
    const models = ref<any[]>([])
    const selected = ref<string[]>([])
    const busy = ref('')
    const preview = ref<any>(null)
    const error = ref('')
    const notice = ref('')
    const uploading = ref('')
    const settingsDraft = ref<any>(null)
    const custom = ref<any>(emptyCustom())
    const language = ref('en')
    const modelsTab = ref<'installed' | 'explore'>('installed')
    const runners = ref<any[]>([])
    let runnerRequest = 0
    const explore = ref<any>(null)
    const explorePage = ref(1)
    const exploreBusy = ref(false)
    const exploreVram = ref(8)
    const source = ref<any>(null)
    let refreshTimer: any = null
    let planTimer: any = null
    let pollTimer: any = null

    const t = (key: string) => makeT(language.value)(key)
    const settings = computed<any>(() => settingsDraft.value ?? state.value?.settings ?? {})
    const modelsById = computed(() => {
      const map: Record<string, any> = {}
      for (const item of models.value) map[item.entry.id] = item
      return map
    })
    const modelState = computed(() => modelsById.value[form.value.modelId])
    const modelEntry = computed(() => modelState.value?.entry)
    const runner = computed(() => (modelEntry.value?.runtimes?.includes(form.value.runner) ? form.value.runner : 'auto'))
    const jobs = computed(() => {
      const byId: Record<string, any> = {}
      for (const job of state.value?.jobs ?? []) byId[job.id] = job
      for (const job of Object.values(liveJobs.value) as any[]) byId[job.id] = job
      return Object.values(byId).sort((a: any, b: any) => b.createdAt - a.createdAt)
    })

    /** RU: Загружает состояние сервиса. EN: Loads service state. */
    // RU: Принудительно пересканирует окружение (после установки CUDA/ComfyUI).
    // EN: Force-rescans the environment (after installing CUDA/ComfyUI).
    async function recheckDeps() {
      try {
        await api('/deps/refresh', { method: 'POST', body: '{}' })
        await refresh()
      } catch (err: any) {
        error.value = err.message
      }
    }

    async function refresh() {
      try {
        const next = await api('/state')
        state.value = next
        models.value = next.models
        void refreshWorkflows()
        if (!settingsDraft.value) settingsDraft.value = next.settings
        if (!formHydrated) {
          form.value = { ...emptyForm(next.settings), prompt: form.value.prompt, segmentPrompts: form.value.segmentPrompts }
          formHydrated = true
        }
        language.value = next.settings?.language ?? 'en'
        void refreshRunners()
      } catch (err: any) {
        error.value = err.message
      }
    }

    /** RU: Загружает библиотеку. EN: Loads the library. */
    /** RU: Доступность всех раннеров для выбранной модели.
     *  EN: Availability of every runner for the selected model. */
    async function refreshRunners(modelId = form.value.modelId) {
      const request = ++runnerRequest
      try {
        const list = await api(`/runners?modelId=${encodeURIComponent(modelId)}`)
        if (request === runnerRequest && Array.isArray(list)) runners.value = list
      } catch {
        /* keep the previous list */
      }
    }

    // RU: Пояснение, почему выбранный раннер недоступен для этой модели.
    // EN: Why the selected runner is unavailable for this model.
    const runnerHint = computed(() => {
      if (runner.value !== 'auto') {
        const item = runners.value.find((entry: any) => entry.id === runner.value)
        if (!item || item.available !== false) return ''
        return [item.reason, item.hint].filter(Boolean).join(' — ')
      }
      // RU: В режиме Auto показываем, почему ни один путь модели не доступен.
      // EN: In Auto mode explain why none of the model's paths is available.
      const runtimes = modelEntry.value?.runtimes ?? []
      const candidates = runners.value.filter((entry: any) => runtimes.includes(entry.id))
      if (!candidates.length || candidates.some((entry: any) => entry.available !== false)) return ''
      return candidates.map((entry: any) => `${entry.id}: ${entry.reason ?? t('unavailable')}`).join(' · ')
    })

    async function refreshWorkflows() {
      try { workflows.value = await api('/workflow') } catch { /* optional */ }
    }

    async function refreshLibrary() {
      try {
        library.value = await api('/library')
      } catch (err: any) {
        error.value = err.message
      }
    }

    /** RU: Загружает страницу обзора HF. EN: Loads a page of the HF overview. */
    async function loadExplore(page: number) {
      exploreBusy.value = true
      try {
        explore.value = await api(`/models/explore?page=${Math.max(1, page)}`)
        explorePage.value = explore.value.page
      } catch (err: any) {
        error.value = err.message
      } finally {
        exploreBusy.value = false
      }
    }

    /** RU: Пересчитывает план с задержкой. EN: Recomputes the plan with a delay. */
    function schedulePlan() {
      if (planTimer) clearTimeout(planTimer)
      if (!form.value.prompt.trim()) {
        plan.value = null
        return
      }
      planTimer = setTimeout(async () => {
        try {
          plan.value = await api('/plan', {
            method: 'POST',
            body: JSON.stringify({ ...form.value, segmentPrompts: form.value.segmentPrompts.split(/\n+/).map((line: string) => line.trim()).filter(Boolean), modelId: 'comfyui-workflow', runner: 'comfyui' }),
          })
          planError.value = ''
        } catch (err: any) {
          planError.value = err.message
        }
      }, 700)
    }

    /** RU: Обновляет поля формы. EN: Updates form fields. */
    const patch = (updates: any) => {
      form.value = { ...form.value, ...updates }
    }
    const patchTranscode = (updates: any) => {
      form.value = { ...form.value, transcode: { ...form.value.transcode, ...updates } }
    }

    function applyPlatform(platform: string) {
      const presets: Record<string, any> = {
        reels: { aspect: '9:16', width: 1080, height: 1920, fps: 30 },
        shorts: { aspect: '9:16', width: 1080, height: 1920, fps: 30 },
        youtube: { aspect: '16:9', width: 1920, height: 1080, fps: 30 },
        youtube4k: { aspect: '16:9', width: 3840, height: 2160, fps: 30 },
        cinema: { aspect: '16:9', width: 1920, height: 1080, fps: 24 },
        square: { aspect: '1:1', width: 1080, height: 1080, fps: 30 },
        portrait45: { aspect: '4:5', width: 1080, height: 1350, fps: 30 },
      }
      patch({ platform, ...(presets[platform] ?? {}) })
    }

    function applyAspect(aspect: string) {
      const size = dimsFor(aspect === '9:16' ? 1920 : aspect === '1:1' ? 1080 : aspect === '4:5' ? 1350 : aspect === '3:4' ? 1440 : 1080, aspect)
      patch({ aspect, width: size.width, height: size.height })
    }

    async function upload(file: File, field: 'inputImageId' | 'inputVideoId') {
      uploading.value = field
      try {
        const response = await fetch(`${API}/inputs`, {
          method: 'POST',
          headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': file.name },
          body: file,
        })
        const payload = await response.json()
        if (!response.ok || payload.ok === false) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
        patch({ [field]: payload.value.id })
        notice.value = `${file.name} · ${fmtBytes(payload.value.bytes)}`
      } catch (err: any) {
        error.value = err.message
      } finally {
        uploading.value = ''
      }
    }

    const generationBody = (extra: Record<string, unknown> = {}) => ({
      ...form.value,
      segmentPrompts: form.value.segmentPrompts.split(/\n+/).map((line: string) => line.trim()).filter(Boolean),
      modelId: 'comfyui-workflow',
      runner: 'comfyui',
      ...extra,
    })

    async function requestGenerate() {
      busy.value = 'plan'
      error.value = ''
      notice.value = ''
      try {
        preview.value = await api('/plan', { method: 'POST', body: JSON.stringify(generationBody()) })
      } catch (err: any) {
        error.value = err.message
      } finally {
        busy.value = ''
      }
    }

    async function confirmGenerate() {
      const planned = preview.value
      if (!planned?.planId) return
      preview.value = null
      busy.value = 'generate'
      try {
        const result = await api('/generate', { method: 'POST', body: JSON.stringify(generationBody({ planId: planned.planId })) })
        liveJobs.value = { ...liveJobs.value, [result.job.id]: result.job }
        tab.value = 'jobs'
        notice.value = `${t('queued')}: ${result.plan.segments.length} × ${fmtDuration(result.plan.clipSec)}`
      } catch (err: any) {
        error.value = err.message
      } finally {
        busy.value = ''
      }
    }

    async function cancelJob(id: string) {
      try {
        await api(`/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
      } catch (err: any) {
        error.value = err.message
      }
    }

    // RU: Прогресс/ошибка скачивания конкретной модели из живых job-событий.
    // EN: Live download progress/failure for a specific model from job events.
    const downloadProgress = (id: string) => {
      const active = jobs.value.find((job: any) => job.kind === 'download' && job.params?.modelId === id && (job.status === 'running' || job.status === 'queued'))
      if (!active) return null
      return h('div', { class: 'gv-mt-2' }, [
        h(Progress, { percent: active.percent }),
        h('div', { class: 'gv-hint gv-mt-1' }, `${active.percent}% · ${active.message}`),
      ])
    }
    const downloadFailure = (id: string) => {
      const failed = jobs.value.find((job: any) => job.kind === 'download' && job.params?.modelId === id && job.status === 'failed')
      if (!failed) return null
      return h('div', { class: 'gv-mt-2 gv-text-[11.5px] gv-text-danger' }, `${failed.error?.code ?? 'download-failed'}: ${failed.error?.message ?? failed.message}`)
    }
    const hasActiveDownload = (id: string) =>
      jobs.value.some((job: any) => job.kind === 'download' && job.params?.modelId === id && (job.status === 'running' || job.status === 'queued'))

    async function installModel(modelId: string) {
      busy.value = `install-${modelId}`
      try {
        const job = await api('/models/install', { method: 'POST', body: JSON.stringify({ modelId }) })
        liveJobs.value = { ...liveJobs.value, [job.id]: job }
        notice.value = t('modelInstalled')
        await refresh()
      } catch (err: any) {
        error.value = err.message
      } finally {
        busy.value = ''
      }
    }

    async function checkUpdates() {
      try {
        const result = await api('/models/check-updates', { method: 'POST', body: '{}' })
        const updates = Array.isArray(result) ? result : result.items ?? []
        models.value = models.value.map((item) => {
          const update = updates.find((entry: any) => entry.modelId === item.entry.id)
          return update ? { ...item, updateAvailable: update.updateAvailable, remoteRevision: update.remoteRevision, newerCandidates: update.newerCandidates ?? [] } : item
        })
        notice.value = updates.map((item: any) => `${item.modelId}: ${item.error ?? (item.updateAvailable ? 'update' : 'ok')}`).join(' · ')
      } catch (err: any) {
        error.value = err.message
      }
    }

    async function mergeClips() {
      if (selected.value.length < 2) {
        error.value = t('noSelection')
        return
      }
      busy.value = 'merge'
      try {
        const job = await api('/merge', { method: 'POST', body: JSON.stringify({ names: selected.value, transcode: form.value.transcode }) })
        liveJobs.value = { ...liveJobs.value, [job.id]: job }
        selected.value = []
        tab.value = 'jobs'
      } catch (err: any) {
        error.value = err.message
      } finally {
        busy.value = ''
      }
    }

    async function saveSettings(updates: any) {
      busy.value = 'settings'
      try {
        const next = await api('/settings', { method: 'POST', body: JSON.stringify(updates) })
        settingsDraft.value = next
        language.value = next.language ?? language.value
        if (state.value) state.value = { ...state.value, settings: next }
        notice.value = t('savedSettings')
      } catch (err: any) {
        error.value = err.message
      } finally {
        busy.value = ''
      }
    }

    // RU: Сохраняет текущие параметры формы Generate как дефолты.
    // EN: Persists the current Generate form values as defaults.
    async function saveGenerateDefaults() {
      await saveSettings({
        modelId: form.value.modelId,
        platform: form.value.platform,
        aspect: form.value.aspect,
        width: form.value.width,
        height: form.value.height,
        orientation: form.value.orientation,
        fps: form.value.fps,
        targetDurationSec: form.value.targetDurationSec,
        clipSec: form.value.clipSec,
        promptMode: form.value.promptMode,
        negativePrompt: form.value.negativePrompt,
        seed: form.value.seed,
        steps: form.value.steps,
        guidance: form.value.guidance,
        continuity: form.value.continuity,
        denoise: form.value.denoise,
        transcode: form.value.transcode,
      })
    }

    // RU: Удаляет файлы модели и запись кастомной модели.
    // EN: Deletes model files and the custom-model record.
    async function deleteModel(modelId: string) {
      if (!window.confirm(t('confirmDeleteModel'))) return
      busy.value = `delete-${modelId}`
      try {
        await api('/models/delete', { method: 'POST', body: JSON.stringify({ modelId }) })
        const custom = settings.value?.customModels ?? []
        if (custom.some((model: any) => model.id === modelId)) {
          await saveSettings({ customModels: custom.filter((model: any) => model.id !== modelId) })
        }
        notice.value = t('deletedModel')
        await refresh()
      } catch (err: any) {
        error.value = err.message
      } finally {
        busy.value = ''
      }
    }

    async function saveCustom() {
      const id = String(custom.value.id || '').trim()
      if (!id) {
        error.value = 'id is required'
        return
      }
      const entry = {
        id,
        title: custom.value.title || id,
        repo: custom.value.repo || '',
        runtime: custom.value.runtime,
        vramGB: Number(custom.value.vramGB) || 12,
        sizeGB: Number(custom.value.sizeGB) || 0,
        durationSec: Number(custom.value.durationSec) || 4,
        fps: Number(custom.value.fps) || 24,
        width: Number(custom.value.width) || 768,
        height: Number(custom.value.height) || 512,
        supportsImage: Boolean(custom.value.supportsImage),
        supportsVideo: Boolean(custom.value.supportsVideo),
        files: String(custom.value.filesText || '').split('\n').map((line: string) => line.trim()).filter(Boolean),
        commandTemplate: String(custom.value.templateText || '').split('\n').map((line: string) => line.trim()).filter(Boolean),
      }
      const next = [...(settings.value.customModels ?? []).filter((model: any) => model.id !== id), entry]
      await saveSettings({ customModels: next })
      custom.value = emptyCustom()
    }

    async function installFfmpeg() {
      try {
        const result = await api('/deps/install', { method: 'POST', body: '{}' })
        notice.value = result.ok ? result.message : `${result.message}: ${result.command}`
        await refresh()
      } catch (err: any) {
        error.value = err.message
      }
    }

    async function installPython() {
      if (!window.confirm(t('confirmPython'))) return
      try {
        await api('/engine/install', { method: 'POST', body: '{}' })
        notice.value = t('installing')
        tab.value = 'jobs'
        await refresh()
      } catch (err: any) {
        error.value = err.message
      }
    }

    async function installCandle() {
      busy.value = 'candle'
      try {
        const job = await api('/engine/install-candle', { method: 'POST', body: '{}' })
        liveJobs.value = { ...liveJobs.value, [job.id]: job }
        notice.value = t('buildStarted')
        tab.value = 'jobs'
      } catch (err: any) {
        error.value = err.message
      } finally {
        busy.value = ''
      }
    }

    async function resetSettings() {
      if (!window.confirm(t('confirmReset'))) return
      try {
        const next = await api('/settings/reset', { method: 'POST', body: '{}' })
        settingsDraft.value = next
        form.value = emptyForm(next)
        language.value = next.language ?? 'en'
      } catch (err: any) {
        error.value = err.message
      }
    }

    onMounted(() => {
      void refresh()
      void refreshLibrary()
      void refreshWorkflows()
      try {
        source.value = new EventSource('/genvideo/api/events')
        source.value.onmessage = (event: MessageEvent) => {
          try {
            const payload = JSON.parse(event.data)
            if (payload.kind === 'job') {
              liveJobs.value = { ...liveJobs.value, [payload.job.id]: payload.job }
              // RU: После завершения скачивания обновляем карточки моделей.
              // EN: Refresh model cards once a download finishes.
              if (payload.job.kind === 'download' && ['done', 'failed', 'cancelled'].includes(payload.job.status)) {
                if (refreshTimer) clearTimeout(refreshTimer)
                refreshTimer = setTimeout(() => void refresh(), 300)
              }
            }
            if (payload.kind === 'state') {
              if (refreshTimer) clearTimeout(refreshTimer)
              refreshTimer = setTimeout(() => void refresh(), 400)
            }
          } catch {
            /* ignore malformed frames */
          }
        }
      } catch {
        /* SSE unsupported, polling below still works */
      }
      pollTimer = setInterval(() => {
        if (source.value?.readyState === 2) void refresh()
      }, 5000)
      watch(form, schedulePlan, { deep: true })
    })

    onBeforeUnmount(() => {
      source.value?.close?.()
      if (refreshTimer) clearTimeout(refreshTimer)
      if (planTimer) clearTimeout(planTimer)
      if (pollTimer) clearInterval(pollTimer)
    })

    const previewModal = () => {
      const p = preview.value
      if (!p) return null
      const warn = (p.warnings ?? []).map((item: any) => item.message)
      return h('div', { class: 'gv-modal-backdrop' }, [
        h('div', { class: 'gv-modal' }, [
          h('div', { class: 'gv-text-[15px] gv-font-semibold gv-text-text' }, 'Generation preview'),
          h('div', { class: 'gv-mt-3 gv-grid gv-grid-cols-2 gv-gap-2 gv-text-[12px]' }, [
            h('div', { class: 'gv-hint' }, 'Format'), h('div', null, p.orientation === 'portrait' ? 'Vertical · 9:16' : 'Horizontal · 16:9'),
            h('div', { class: 'gv-hint' }, 'Output'), h('div', null, `${p.width}×${p.height}`),
            h('div', { class: 'gv-hint' }, 'Base'), h('div', null, `${p.baseWidth}×${p.baseHeight}`),
            h('div', { class: 'gv-hint' }, t('fps')), h('div', null, String(p.fps)),
            h('div', { class: 'gv-hint' }, 'Mode'), h('div', null, String(p.mode ?? 't2v').toUpperCase() + (p.mode === 'v2v' ? ` · denoise ${p.denoise}` : '')),
            h('div', { class: 'gv-hint' }, 'Auto clip'), h('div', null, `${p.clipSec}s · ${p.frames} frames`),
            h('div', { class: 'gv-hint' }, t('segments')), h('div', null, `${p.segments.length} · ${fmtDuration(p.totalSec)}`),
            h('div', { class: 'gv-hint' }, 'Upscaler'), h('div', null, '2× Nomos → ImageScale'),
            h('div', { class: 'gv-hint' }, 'ComfyUI'), h('div', null, state.value.deps.comfyui.ok ? 'ready' : 'unavailable'),
          ]),
          warn.length ? h('ul', { class: 'gv-mt-3 gv-list-disc gv-pl-5 gv-text-[11.5px] gv-text-warn' }, warn.map((line: string, index: number) => h('li', { key: index }, line))) : null,
          h('div', { class: 'gv-mt-4 gv-flex gv-justify-end gv-gap-2' }, [
            h('button', { type: 'button', class: 'gv-btn', onClick: () => (preview.value = null) }, t('cancel')),
            h('button', { type: 'button', class: 'gv-btn gv-btn-primary', disabled: !state.value.deps.comfyui.ok, onClick: () => void confirmGenerate() }, 'Confirm generation'),
          ]),
        ]),
      ])
    }

    const header = () => h('div', { class: 'gv-header gv-flex gv-flex-wrap gv-items-center gv-justify-between gv-gap-3' }, [
      h('div', { class: 'gv-flex gv-items-center gv-gap-3' }, [
        h('div', { class: 'gv-flex gv-h-9 gv-w-9 gv-items-center gv-justify-center gv-rounded-xl gv-bg-surface-2 gv-text-brand' }, [h(Icon, { size: 20, active: true })]),
        h('div', null, [h('h2', { class: 'gv-text-[15px] gv-font-semibold gv-text-text' }, t('title')), h('p', { class: 'gv-text-[11.5px] gv-text-muted' }, t('subtitle'))]),
      ]),
      h('div', { class: 'gv-flex gv-flex-wrap gv-items-center gv-gap-1.5' }, [
        h('select', {
          class: 'gv-select gv-h-8 gv-w-24',
          value: language.value,
          onChange: (event: any) => {
            const value = event.target.value === 'ru' ? 'ru' : 'en'
            language.value = value
            void saveSettings({ language: value })
          },
        }, [h('option', { value: 'en' }, t('english')), h('option', { value: 'ru' }, t('russian'))]),
        h(Badge, { tone: state.value.gpu.available ? 'gv-border-ok-soft gv-bg-ok-soft gv-text-ok' : 'gv-border-danger-soft gv-bg-danger-soft gv-text-danger' }, `GPU ${state.value.gpu.gpus.length}`),
        h(Badge, { tone: state.value.deps.ffmpeg.ok ? 'gv-border-ok-soft gv-bg-ok-soft gv-text-ok' : 'gv-border-danger-soft gv-bg-danger-soft gv-text-danger' }, 'ffmpeg'),
        h(Badge, { tone: 'gv-border-line gv-bg-surface-2 gv-text-muted' }, `v${state.value.version}`),
      ]),
    ])

    // RU: Бюджет VRAM: явный лимит из настроек либо самая большая выбранная карта.
    // EN: VRAM budget: explicit setting, otherwise the largest selected GPU.
    const vramBudgetGB = computed(() => {
      const configured = Number(state.value.settings?.gpu?.vramBudgetGB ?? 0)
      if (configured > 0) return configured
      const ids = state.value.settings?.gpu?.ids ?? []
      const selected = (state.value.gpu.gpus ?? []).filter((gpu: any) => !ids.length || ids.includes(gpu.index))
      return selected.length ? Math.max(...selected.map((gpu: any) => gpu.totalMB / 1024)) : 0
    })

    const snap32 = (value: number) => Math.max(64, Math.round(value / 32) * 32)

    // RU: Подбирает максимальное разрешение (и при необходимости длительность),
    //     которое укладывается в бюджет VRAM, и применяет его к форме.
    // EN: Finds the largest resolution (and duration if needed) within the VRAM
    //     budget and applies it to the form.
    async function fitToVram() {
      const budget = vramBudgetGB.value
      if (!budget || !modelEntry.value) return
      busy.value = 'fit'
      try {
        const base = { ...form.value, runner: runner.value === 'auto' ? undefined : runner.value }
        const heights = [768, 704, 640, 576, 512, 448, 384, 320, 256, 224, 192]
        const tryPlan = async (height: number) => {
          const ratio = form.value.width / Math.max(1, form.value.height)
          const width = snap32(height * ratio)
          const snapped = snap32(height)
          const planResult = await api('/plan', {
            method: 'POST',
            body: JSON.stringify({ ...base, width, height: snapped }),
          })
          return { width, height: snapped, plan: planResult }
        }

        let best: any = null
        for (const height of heights) {
          const result = await tryPlan(height)
          if (result.plan.vramFit) { best = result; break }
        }
        if (!best) throw new Error(t('fitVramFailed'))
        patch({ width: best.width, height: best.height })
        notice.value = t('fitVramResult')
          .replace('{dims}', `${best.width}×${best.height}`)
          .replace('{sec}', String(form.value.targetDurationSec))
          .replace('{gb}', String(best.plan.estimatedVramGB))
      } catch (err: any) {
        error.value = err.message
      } finally {
        busy.value = ''
      }
    }

    const estimate = () => h(Card, { title: t('estimate'), hint: planError.value || null }, [
      plan.value
        ? h('div', { class: 'gv-flex gv-flex-col gv-gap-2' }, [
            h('div', { class: 'gv-grid gv-grid-cols-2 gv-gap-2 gv-text-[11.5px] sm:gv-grid-cols-4' }, [
              h('div', { class: 'gv-rounded-lg gv-bg-surface-2 gv-p-2' }, [h('div', { class: 'gv-text-muted' }, t('vram')), h('div', { class: 'gv-font-semibold' }, `${plan.value.estimatedVramGB} GB`)]),
              h('div', { class: 'gv-rounded-lg gv-bg-surface-2 gv-p-2' }, [h('div', { class: 'gv-text-muted' }, t('generationTime')), h('div', { class: 'gv-font-semibold' }, fmtDuration(plan.value.estimatedSeconds))]),
              h('div', { class: 'gv-rounded-lg gv-bg-surface-2 gv-p-2' }, [h('div', { class: 'gv-text-muted' }, t('segments')), h('div', { class: 'gv-font-semibold' }, String(plan.value.segments.length))]),
              h('div', { class: 'gv-rounded-lg gv-bg-surface-2 gv-p-2' }, [h('div', { class: 'gv-text-muted' }, t('size')), h('div', { class: 'gv-font-semibold' }, plan.value.transcode.estimatedBytes ? fmtBytes(plan.value.transcode.estimatedBytes) : '—')]),
            ]),
            h('div', { class: 'gv-hint' }, `${plan.value.width}×${plan.value.height} · ${plan.value.fps} fps · ${fmtDuration(plan.value.totalSec)} · ${plan.value.availableRunner ?? '—'}`),
            h('div', { class: 'gv-flex gv-flex-wrap gv-items-center gv-justify-between gv-gap-2' }, [
              h('span', { class: plan.value.vramFit ? 'gv-text-[11.5px] gv-text-ok' : 'gv-text-[11.5px] gv-text-warn' },
                `${plan.value.estimatedVramGB} GB / ${Math.round(vramBudgetGB.value * 10) / 10} GB`),
              h('button', {
                type: 'button', class: 'gv-btn gv-h-8 gv-px-3', disabled: Boolean(busy.value), onClick: () => void fitToVram(),
              }, busy.value === 'fit' ? t('fitVramBusy') : t('fitVram')),
            ]),
            plan.value.warnings.length
              ? h('ul', { class: 'gv-list-disc gv-space-y-1 gv-pl-5 gv-text-[11.5px] gv-text-warn' }, plan.value.warnings.map((warning: any, index: number) => h('li', { key: index }, warning.message)))
              : null,
          ])
        : h('div', { class: 'gv-flex gv-flex-col gv-gap-2' }, [
            h('div', { class: 'gv-hint' }, planError.value || t('planFailed')),
            modelEntry.value?.runtimes?.includes('diffusers') && !state.value.deps.venv.ok
              ? h('button', { type: 'button', class: 'gv-btn gv-btn-primary gv-h-8 gv-px-3', disabled: Boolean(busy.value), onClick: installPython }, t('installPython'))
              : null,
          ]),
    ])

    const generateView = () => h('div', { class: 'gv-generate gv-flex gv-flex-col gv-gap-4' }, [
      h('div', { class: 'gv-actions gv-flex gv-flex-wrap gv-items-center gv-justify-between gv-gap-3' }, [
        h('div', { class: 'gv-flex gv-flex-wrap gv-items-center gv-gap-2' }, [
          h('button', { type: 'button', class: 'gv-btn gv-btn-primary gv-h-10 gv-px-4', disabled: Boolean(busy.value) || !form.value.prompt.trim(), onClick: () => void requestGenerate() }, busy.value === 'plan' ? 'Planning…' : busy.value === 'generate' ? t('generating') : t('generateButton')),
          h('button', { type: 'button', class: 'gv-btn', disabled: Boolean(busy.value), onClick: () => void saveGenerateDefaults() }, t('saveDefaults')),
          h('button', { type: 'button', class: 'gv-btn', onClick: () => void refresh() }, t('refresh')),
        ]),
        plan.value
          ? h('div', { class: 'gv-hint' }, `${plan.value.segments.length} clips · ${plan.value.segments.length > 1 ? `${plan.value.segments.length - 1}×${fmtDuration(plan.value.clipSec)} + ${fmtDuration(plan.value.segments[plan.value.segments.length - 1]?.durationSec ?? 0)}` : fmtDuration(plan.value.totalSec)} = ${fmtDuration(plan.value.totalSec)}`)
          : null,
      ]),
      h('div', { class: 'gv-flex gv-flex-col gv-gap-4' }, [
        h(Card, { title: `1 · ${t('sectionScene')}` }, [
          h('textarea', {
            class: 'gv-input gv-h-28 gv-resize-y gv-py-2', placeholder: t('promptHint'), value: form.value.prompt,
            onInput: (event: any) => patch({ prompt: event.target.value }),
          }),
          h('p', { class: 'gv-hint gv-mt-1.5' }, t('promptHint')),
          h('div', { class: 'gv-mt-3' }, [
            h(Field, { label: t('negative'), hint: t('negativeHint') }, [
              h('input', {
                class: 'gv-input', type: 'text', value: form.value.negativePrompt,
                onInput: (event: any) => patch({ negativePrompt: event.target.value }),
              }),
            ]),
          ]),
        ]),
        h(Card, { title: `2 · ${t('sectionReferences')}`, hint: t('sourceHint') }, [
          h('div', { class: 'gv-grid gv-grid-cols-1 gv-gap-3 sm:gv-grid-cols-2' }, [
            h(Field, { label: t('imageInput'), hint: t('inputHint') }, [
              h('div', { class: 'gv-flex gv-items-center gv-gap-2' }, [
                h('button', {
                  type: 'button', class: 'gv-btn', disabled: uploading.value === 'inputImageId',
                  onClick: () => {
                    const input = document.createElement('input')
                    input.type = 'file'
                    input.accept = 'image/*'
                    input.onchange = () => {
                      const file = input.files?.[0]
                      if (file) void upload(file, 'inputImageId')
                    }
                    input.click()
                  },
                }, uploading.value === 'inputImageId' ? t('uploading') : t('chooseFile')),
                form.value.inputImageId ? h('span', { class: 'gv-hint gv-truncate' }, form.value.inputImageId.slice(0, 28)) : null,
                form.value.inputImageId ? h('button', { type: 'button', class: 'gv-btn', onClick: () => patch({ inputImageId: '' }) }, t('removeFile')) : null,
              ]),
            ]),
            h(Field, { label: t('videoInput'), hint: t('inputHint') }, [
              h('div', { class: 'gv-flex gv-items-center gv-gap-2' }, [
                h('button', {
                  type: 'button', class: 'gv-btn', disabled: uploading.value === 'inputVideoId',
                  onClick: () => {
                    const input = document.createElement('input')
                    input.type = 'file'
                    input.accept = 'video/*'
                    input.onchange = () => {
                      const file = input.files?.[0]
                      if (file) void upload(file, 'inputVideoId')
                    }
                    input.click()
                  },
                }, uploading.value === 'inputVideoId' ? t('uploading') : t('chooseFile')),
                form.value.inputVideoId ? h('span', { class: 'gv-hint gv-truncate' }, form.value.inputVideoId.slice(0, 28)) : null,
                form.value.inputVideoId ? h('button', { type: 'button', class: 'gv-btn', onClick: () => patch({ inputVideoId: '' }) }, t('removeFile')) : null,
              ]),
            ]),
            form.value.inputVideoId
              ? h('div', { class: 'gv-mt-3' }, [
                  h(Field, { label: t('denoise'), hint: t('denoiseHint') }, [
                    h('input', {
                      class: 'gv-input', type: 'range', min: 0.3, max: 0.8, step: 0.05, value: form.value.denoise,
                      onInput: (event: any) => patch({ denoise: Number(event.target.value) }),
                    }),
                    h('span', { class: 'gv-hint' }, String(form.value.denoise)),
                  ]),
                ])
              : null,
          ]),
        ]),
        h(Card, { title: `3 · ${t('sectionOutput')}` }, [
          h('div', { class: 'gv-grid gv-grid-cols-1 gv-gap-3 sm:gv-grid-cols-2 lg:gv-grid-cols-4' }, [
            h(Field, { label: t('duration'), hint: t('durationHint') }, [
              h('input', { class: 'gv-input', type: 'number', min: 1, max: 600, value: form.value.targetDurationSec, onInput: (event: any) => patch({ targetDurationSec: Number(event.target.value) || 1 }) }),
              h('div', { class: 'gv-mt-1 gv-flex gv-gap-1' }, [30, 60, 120].map((sec) => h('button', {
                key: sec, type: 'button', class: 'gv-btn gv-h-7 gv-px-2 gv-text-[10.5px]',
                onClick: () => patch({ targetDurationSec: sec }),
              }, sec >= 60 ? `${sec / 60}m` : `${sec}s`))),
            ]),
            h(Field, { label: t('videoFormat') }, [
              h(Segmented, {
                value: form.value.orientation,
                onChange: (value: string) => {
                  const horizontal = value !== 'portrait'
                  patch({ orientation: horizontal ? 'landscape' : 'portrait', width: horizontal ? 1280 : 720, height: horizontal ? 720 : 1280 })
                },
                options: [
                  { value: 'landscape', label: 'Horizontal · 16:9' },
                  { value: 'portrait', label: 'Vertical · 9:16' },
                ],
              }),
            ]),
            h(Field, { label: t('fps') }, [
              h('select', { class: 'gv-select', value: String(form.value.fps), onChange: (event: any) => patch({ fps: Number(event.target.value) }) },
                [15, 24, 30, 60].map((value) => h('option', { key: value, value: String(value) }, String(value)))),
            ]),
            h(Field, { label: t('continuity'), hint: 'Continue each clip from the previous frame. Requires workflow-image.json.' }, [
              h('select', { class: 'gv-select', value: form.value.continuity, onChange: (event: any) => patch({ continuity: event.target.value }) }, [
                h('option', { value: 'last-frame' }, t('lastFrame')),
                h('option', { value: 'none' }, t('none')),
              ]),
            ]),
          ]),
          plan.value
            ? h('div', { class: 'gv-hint gv-mt-2' }, `${t('segments')}: ${plan.value.segments.length} · ${plan.value.segments.length > 1 ? `${plan.value.segments.length - 1}×${fmtDuration(plan.value.clipSec)} + ${fmtDuration(plan.value.segments[plan.value.segments.length - 1]?.durationSec ?? 0)}` : fmtDuration(plan.value.totalSec)} = ${fmtDuration(plan.value.totalSec)}`)
            : null,
        ]),
        h(Card, { title: `4 · ${t('sectionEncoding')}`, hint: t('transcodeHint') }, [
          h('div', { class: 'gv-flex gv-flex-col gv-gap-3' }, [
            h(Segmented, {
              value: form.value.transcode.enabled ? form.value.transcode.mode : 'off',
              onChange: (value: string) => patchTranscode(
                value === 'off'
                  ? { enabled: false }
                  : { enabled: true, mode: value === 'size' ? 'size' : 'quality' },
              ),
              options: [
                { value: 'off', label: t('noTranscode') },
                { value: 'quality', label: t('qualityMode') },
                { value: 'size', label: t('sizeMode') },
              ],
            }),
            form.value.transcode.enabled
              ? h('div', { class: 'gv-grid gv-grid-cols-1 gv-gap-3 sm:gv-grid-cols-2 lg:gv-grid-cols-3' }, [
              form.value.transcode.mode === 'quality'
                ? h(Field, { label: t('quality') }, [
                    h('select', { class: 'gv-select', value: form.value.transcode.quality, onChange: (event: any) => patchTranscode({ quality: event.target.value }) }, [
                      h('option', { value: 'high' }, t('high')),
                      h('option', { value: 'medium' }, t('medium')),
                      h('option', { value: 'compressed' }, t('compressed')),
                    ]),
                  ])
                : h(Field, { label: `${t('sizeLimit')} (${t('mb')})` }, [
                    h('input', { class: 'gv-input', type: 'number', min: 1, max: 20000, value: form.value.transcode.targetSizeMB, onInput: (event: any) => patchTranscode({ targetSizeMB: Number(event.target.value) || 1 }) }),
                  ]),
              h(Field, { label: t('encoder'), hint: t('encoderHint') }, [
                h('select', { class: 'gv-select', value: form.value.transcode.encoder, onChange: (event: any) => patchTranscode({ encoder: event.target.value }) }, [
                  h('option', { value: 'auto' }, t('encoderAuto')),
                  h('option', { value: 'cpu' }, t('encoderCpu')),
                  h('option', { value: 'nvenc' }, t('encoderNvenc')),
                  h('option', { value: 'vulkan' }, t('encoderVulkan')),
                ]),
              ]),
              h(Field, { label: t('codec'), hint: t('codecHint') }, [
                h('select', { class: 'gv-select', value: form.value.transcode.codec, onChange: (event: any) => patchTranscode({ codec: event.target.value }) }, [
                  h('option', { value: 'h264' }, t('codecH264')),
                  h('option', { value: 'h265' }, t('codecH265')),
                ]),
              ]),
              h(Field, { label: t('format') }, [
                h('select', { class: 'gv-select', value: form.value.transcode.format, onChange: (event: any) => patchTranscode({ format: event.target.value }) },
                  ['mp4', 'webm', 'gif'].map((value) => h('option', { key: value, value }, value.toUpperCase()))),
              ]),
              h(Field, { label: t('fit') }, [
                h('select', { class: 'gv-select', value: form.value.transcode.fit, onChange: (event: any) => patchTranscode({ fit: event.target.value }) }, [
                  h('option', { value: 'contain' }, t('contain')),
                  h('option', { value: 'cover' }, t('cover')),
                ]),
              ]),
                ])
              : null,
          ]),
        ]),
      ]),
    ])

    const clipStages = [
      { key: 'sample', label: 'stageSample' },
      { key: 'upscale', label: 'stageUpscale' },
      { key: 'ready', label: 'stageReady' },
    ]

    const clipStageIndex = (segment: any): number => {
      if (segment.status === 'done') return clipStages.length
      const phase = String(segment.phase ?? '')
      if (phase === 'upscaling' || phase === 'muxing' || phase === 'decoding') return 1
      if (segment.status === 'running') return 0
      return -1
    }

    const clipStageTone = (segment: any, index: number): string => {
      const current = clipStageIndex(segment)
      if (segment.status === 'failed' || segment.status === 'cancelled') return index <= current ? 'gv-stage-failed' : 'gv-stage-pending'
      if (segment.status === 'done' || index < current) return 'gv-stage-done'
      if (index === current) return 'gv-stage-active'
      return 'gv-stage-pending'
    }

    const jobTitle = (job: any): string => job.kind === 'generate' ? 'Video generation' : job.kind === 'transcode' ? 'Transcode' : job.kind === 'merge' ? 'Merge' : job.kind

    const jobsView = () => h('div', { class: 'gv-flex gv-flex-col gv-gap-3' }, [
      h('div', { class: 'gv-flex gv-flex-wrap gv-items-center gv-justify-between gv-gap-2' }, [
        h('p', { class: 'gv-hint' }, t('jobsHint')),
        h('button', { type: 'button', class: 'gv-btn', onClick: () => void refresh() }, t('refresh')),
      ]),
      jobs.value.length === 0 ? h('div', { class: 'gv-card gv-p-6 gv-text-center gv-hint' }, t('noJobs')) : null,
      ...jobs.value.map((job: any) => {
        const total = job.progress?.segmentCount ?? job.params?.segments ?? 0
        const params = job.params ?? {}
        const mode = params.inputVideoId ? 'V2V' : params.inputImageId ? 'I2V' : 'T2V'
        const running = job.status === 'running' || job.status === 'queued'
        const live = liveJobs.value[job.id] ?? job
        const segments = job.segments ?? []
        const merging = String(job.phase ?? '') === 'concatenating'
        const encoding = String(job.phase ?? '').includes('transcod') || job.phase === 'verifying'
        const finished = job.status === 'done'
        return h('div', { key: job.id, class: 'gv-card gv-job-card gv-p-4' }, [
          h('div', { class: 'gv-flex gv-flex-wrap gv-items-start gv-justify-between gv-gap-3' }, [
            h('div', { class: 'gv-min-w-0' }, [
              h('div', { class: 'gv-flex gv-flex-wrap gv-items-center gv-gap-2' }, [
                h('span', { class: `gv-job-dot ${running ? 'gv-job-dot-live' : ''}` }),
                h('span', { class: 'gv-text-[13px] gv-font-semibold gv-text-text' }, jobTitle(job)),
                h(Badge, { tone: statusTone(job.status) }, t(job.status) || job.status),
                h(Badge, null, mode),
                total > 0 ? h(Badge, null, `${Math.min(total, (job.progress?.segmentIndex ?? 0) + 1)}/${total}`) : null,
              ]),
              h('div', { class: 'gv-mt-1 gv-hint gv-truncate' }, `${fmtTime(job.createdAt)} · ${job.id.slice(0, 8)}${params.prompt ? ` · ${String(params.prompt).slice(0, 90)}` : ''}`),
            ]),
            h('div', { class: 'gv-flex gv-items-center gv-gap-3' }, [
              h('div', { class: 'gv-text-right' }, [
                h('div', { class: 'gv-text-[20px] gv-font-semibold gv-leading-none gv-text-text' }, `${live.percent ?? job.percent}%`),
                h('div', { class: 'gv-hint gv-mt-1' }, job.progress?.etaMs ? `${t('eta')} ${fmtDuration(job.progress.etaMs / 1000)}` : job.status),
              ]),
              running ? h('button', { type: 'button', class: 'gv-btn gv-h-8 gv-px-2', onClick: () => void cancelJob(job.id) }, t('cancel')) : null,
            ]),
          ]),
          h('div', { class: 'gv-mt-3 gv-flex gv-items-center gv-gap-2' }, [
            h('div', { class: 'gv-flex-1' }, [h(Progress, { percent: live.percent ?? job.percent, tone: job.status === 'failed' ? 'gv-bg-danger' : job.status === 'done' ? 'gv-bg-ok' : 'gv-bg-brand' })]),
          ]),
          h('div', { class: 'gv-mt-3 gv-flex gv-flex-col gv-gap-2' }, segments.map((segment: any) => {
            const idx = clipStageIndex(segment)
            return h('div', { key: segment.index, class: 'gv-clip-row' }, [
              h('div', { class: 'gv-flex gv-flex-wrap gv-items-center gv-justify-between gv-gap-2' }, [
                h('div', { class: 'gv-flex gv-items-center gv-gap-2' }, [
                  h('span', { class: 'gv-clip-num' }, `#${segment.index + 1}`),
                  h(Badge, { tone: statusTone(segment.status) }, t(segment.status) || segment.status),
                  h('span', { class: 'gv-text-[11.5px] gv-text-text' }, segment.message || (segment.status === 'done' ? t('stageReady') : '')),
                ]),
                h('span', { class: 'gv-text-[11px] gv-text-muted' }, `${segment.percent}%`),
              ]),
              h('div', { class: 'gv-mt-1.5 gv-flex gv-flex-wrap gv-items-center gv-gap-1' }, clipStages.map((stage: any, index: number) =>
                h('div', { key: stage.key, class: `gv-stage gv-flex gv-items-center gv-gap-1.5 ${clipStageTone(segment, index)}` }, [
                  h('span', { class: 'gv-stage-num' }, segment.status === 'done' || index < idx ? '✓' : String(index + 1)),
                  h('span', null, t(stage.label)),
                  index < clipStages.length - 1 ? h('span', { class: 'gv-stage-sep' }, '›') : null,
                ]))),
              h('div', { class: 'gv-mt-1.5' }, [h(Progress, { percent: segment.percent, tone: segment.status === 'failed' ? 'gv-bg-danger' : segment.status === 'done' ? 'gv-bg-ok' : 'gv-bg-brand' })]),
            ])
          })),
          segments.length > 0 ? h('div', { class: 'gv-mt-3 gv-flex gv-flex-wrap gv-items-center gv-gap-1' }, [
            h('div', { class: `gv-stage gv-flex gv-items-center gv-gap-1.5 ${finished || merging ? (merging ? 'gv-stage-active' : 'gv-stage-done') : 'gv-stage-pending'}` }, [
              h('span', { class: 'gv-stage-num' }, finished || !merging ? '✓' : '1'),
              h('span', null, t('stageMerge')),
            ]),
            h('span', { class: 'gv-stage-sep' }, '›'),
            h('div', { class: `gv-stage gv-flex gv-items-center gv-gap-1.5 ${finished || encoding ? (encoding ? 'gv-stage-active' : 'gv-stage-done') : 'gv-stage-pending'}` }, [
              h('span', { class: 'gv-stage-num' }, finished ? '✓' : '2'),
              h('span', null, t('stageEncode')),
            ]),
          ]) : null,
          h('div', { class: 'gv-mt-3 gv-rounded-lg gv-bg-surface-2 gv-p-2.5' }, [
            h('div', { class: 'gv-flex gv-flex-wrap gv-items-center gv-justify-between gv-gap-2' }, [
              h('span', { class: 'gv-text-[11px] gv-font-medium gv-text-muted' }, t('currentStep')),
              h('span', { class: 'gv-text-[11.5px] gv-text-text' }, job.message || job.phase),
            ]),
            job.error ? h('div', { class: 'gv-mt-1 gv-text-[11.5px] gv-text-danger' }, `${job.error.code}: ${job.error.message}`) : null,
          ]),
          h('div', { class: 'gv-mt-2 gv-flex gv-flex-wrap gv-items-center gv-gap-x-3 gv-gap-y-1 gv-text-[11.5px] gv-text-muted' }, [
            params.width ? h('span', null, `${params.width}×${params.height}`) : null,
            params.fps ? h('span', null, `${params.fps} fps`) : null,
            params.seed !== undefined && params.seed !== null ? h('span', null, `seed ${params.seed}`) : null,
            params.denoise !== undefined && params.denoise !== null ? h('span', null, `denoise ${params.denoise}`) : null,
            params.clipSec ? h('span', null, `clip ${fmtDuration(Number(params.clipSec))}`) : null,
          ]),
          job.outputs?.length
            ? h('div', { class: 'gv-mt-3 gv-flex gv-flex-wrap gv-gap-2' }, job.outputs.map((output: any) =>
                h('a', { key: output.id, class: 'gv-btn gv-h-8 gv-px-2', href: `/genvideo/api/media/${encodeURIComponent(output.name)}`, target: '_blank', rel: 'noreferrer' }, `${output.name} · ${fmtBytes(output.bytes)}`)))
            : null,
          job.logTail?.length
            ? h('details', { class: 'gv-mt-3' }, [
                h('summary', { class: 'gv-cursor-pointer gv-text-[11.5px] gv-text-muted' }, `log · ${job.logTail.length}`),
                h('pre', { class: 'gv-mt-1 gv-max-h-48 gv-overflow-auto gv-whitespace-pre-wrap gv-rounded-lg gv-bg-surface-2 gv-p-2 gv-text-[10.5px] gv-text-muted' }, job.logTail.slice(-40).join('\n')),
              ])
            : null,
        ])
      }),
    ])

    async function deleteClip(name: string) {
      if (!window.confirm(t('confirmDeleteClip'))) return
      try {
        await api('/library/delete', { method: 'POST', body: JSON.stringify({ name }) })
        selected.value = selected.value.filter((item) => item !== name)
        notice.value = t('deleteClip')
        await refreshLibrary()
      } catch (err: any) {
        error.value = err.message
      }
    }

    const libraryView = () => h('div', { class: 'gv-flex gv-flex-col gv-gap-3' }, [
      h('div', { class: 'gv-flex gv-flex-wrap gv-items-center gv-justify-between gv-gap-2' }, [
        h('p', { class: 'gv-hint' }, t('libraryHint')),
        h('div', { class: 'gv-flex gv-items-center gv-gap-2' }, [
          h('button', { type: 'button', class: 'gv-btn', onClick: () => void refreshLibrary() }, t('refresh')),
          h('button', { type: 'button', class: 'gv-btn gv-btn-primary', disabled: Boolean(busy.value) || selected.value.length < 2, onClick: mergeClips }, busy.value === 'merge' ? t('merging') : t('merge')),
        ]),
      ]),
      library.value.length === 0 ? h('div', { class: 'gv-card gv-p-6 gv-text-center gv-hint' }, t('noClips')) : null,
      h('div', { class: 'gv-grid gv-grid-cols-1 gv-gap-3 sm:gv-grid-cols-2 lg:gv-grid-cols-3' },
        library.value.map((clip: any) =>
          h('div', { key: clip.id, class: `gv-card gv-p-3 ${selected.value.includes(clip.name) ? 'gv-ring-2 gv-ring-brand' : ''}` }, [
            h('video', { class: 'gv-aspect-video gv-w-full gv-rounded-lg gv-bg-black', src: `/genvideo/api/media/${encodeURIComponent(clip.name)}`, controls: true, preload: 'metadata' }),
            h('div', { class: 'gv-mt-2 gv-flex gv-items-center gv-justify-between gv-gap-2' }, [
              h('label', { class: 'gv-flex gv-min-w-0 gv-items-center gv-gap-2 gv-text-[11.5px]' }, [
                h('input', {
                  type: 'checkbox', checked: selected.value.includes(clip.name),
                  onChange: (event: any) => {
                    selected.value = event.target.checked ? [...selected.value, clip.name] : selected.value.filter((name) => name !== clip.name)
                  },
                }),
                h('span', { class: 'gv-truncate' }, clip.name),
              ]),
              h('div', { class: 'gv-flex gv-items-center gv-gap-2' }, [
                h('span', { class: 'gv-hint' }, fmtBytes(clip.bytes)),
                h('button', { type: 'button', class: 'gv-btn gv-btn-danger gv-h-7 gv-px-2 gv-text-[10.5px]', onClick: () => void deleteClip(clip.name) }, t('deleteClip')),
              ]),
            ]),
          ]),
        ),
      ),
    ])

    const customCard = () => h(Card, { title: t('addModel') }, [
      h('div', { class: 'gv-grid gv-grid-cols-1 gv-gap-3 sm:gv-grid-cols-3' }, [
        h(Field, { label: 'id' }, [h('input', { class: 'gv-input', value: custom.value.id, onInput: (event: any) => (custom.value = { ...custom.value, id: event.target.value }) })]),
        h(Field, { label: 'title' }, [h('input', { class: 'gv-input', value: custom.value.title, onInput: (event: any) => (custom.value = { ...custom.value, title: event.target.value }) })]),
        h(Field, { label: t('repo') }, [h('input', { class: 'gv-input', value: custom.value.repo, onInput: (event: any) => (custom.value = { ...custom.value, repo: event.target.value }) })]),
        h(Field, { label: t('runtime') }, [
          h('select', { class: 'gv-select', value: custom.value.runtime, onChange: (event: any) => (custom.value = { ...custom.value, runtime: event.target.value }) },
            ['command', 'diffusers', 'candle', 'comfyui', 'mock'].map((value) => h('option', { key: value, value }, value))),
        ]),
        h(Field, { label: 'VRAM, GB' }, [h('input', { class: 'gv-input', type: 'number', value: custom.value.vramGB, onInput: (event: any) => (custom.value = { ...custom.value, vramGB: Number(event.target.value) }) })]),
        h(Field, { label: 'size, GB' }, [h('input', { class: 'gv-input', type: 'number', value: custom.value.sizeGB, onInput: (event: any) => (custom.value = { ...custom.value, sizeGB: Number(event.target.value) }) })]),
        h(Field, { label: `${t('duration')}, s` }, [h('input', { class: 'gv-input', type: 'number', value: custom.value.durationSec, onInput: (event: any) => (custom.value = { ...custom.value, durationSec: Number(event.target.value) }) })]),
        h(Field, { label: t('fps') }, [h('input', { class: 'gv-input', type: 'number', value: custom.value.fps, onInput: (event: any) => (custom.value = { ...custom.value, fps: Number(event.target.value) }) })]),
        h(Field, { label: t('resolution') }, [
          h('div', { class: 'gv-flex gv-items-center gv-gap-2' }, [
            h('input', { class: 'gv-input', type: 'number', value: custom.value.width, onInput: (event: any) => (custom.value = { ...custom.value, width: Number(event.target.value) }) }),
            h('span', { class: 'gv-hint' }, '×'),
            h('input', { class: 'gv-input', type: 'number', value: custom.value.height, onInput: (event: any) => (custom.value = { ...custom.value, height: Number(event.target.value) }) }),
          ]),
        ]),
      ]),
      h('div', { class: 'gv-mt-3 gv-grid gv-grid-cols-1 gv-gap-3 sm:gv-grid-cols-2' }, [
        h(Field, { label: t('weights') }, [h('textarea', { class: 'gv-input gv-h-20 gv-py-2', value: custom.value.filesText, onInput: (event: any) => (custom.value = { ...custom.value, filesText: event.target.value }) })]),
        h(Field, { label: t('commandTemplate') }, [h('textarea', { class: 'gv-input gv-h-20 gv-py-2', value: custom.value.templateText, onInput: (event: any) => (custom.value = { ...custom.value, templateText: event.target.value }) })]),
      ]),
      h('div', { class: 'gv-mt-3 gv-flex gv-items-center gv-gap-4' }, [
        h('label', { class: 'gv-flex gv-items-center gv-gap-2 gv-text-[11.5px]' }, [h('input', { type: 'checkbox', checked: custom.value.supportsImage, onChange: (event: any) => (custom.value = { ...custom.value, supportsImage: event.target.checked }) }), 'I2V']),
        h('label', { class: 'gv-flex gv-items-center gv-gap-2 gv-text-[11.5px]' }, [h('input', { type: 'checkbox', checked: custom.value.supportsVideo, onChange: (event: any) => (custom.value = { ...custom.value, supportsVideo: event.target.checked }) }), 'V2V']),
        h('button', { type: 'button', class: 'gv-btn gv-btn-primary', disabled: Boolean(busy.value), onClick: saveCustom }, t('saveModel')),
      ]),
    ])

    const installedModelsView = () => h('div', { class: 'gv-flex gv-flex-col gv-gap-3' }, [
      h('div', { class: 'gv-flex gv-flex-wrap gv-items-center gv-justify-between gv-gap-2' }, [
        h('p', { class: 'gv-hint' }, `${t('modelsDir')}: ${state.value.paths.modelsDir}`),
        h('button', { type: 'button', class: 'gv-btn', onClick: checkUpdates }, t('checkUpdates')),
      ]),
      ...models.value.map((item: any) => h(Card, { key: item.entry.id, title: item.entry.title, hint: item.entry.repo }, [
        h('div', { class: 'gv-flex gv-flex-wrap gv-gap-1.5' }, [
          h(Badge, { tone: item.installed ? 'gv-border-ok-soft gv-bg-ok-soft gv-text-ok' : 'gv-border-warn-soft gv-bg-warn-soft gv-text-warn' }, item.installed ? t('installed') : t('notInstalled')),
          h(Badge, null, `${fmtBytes(item.installedBytes)} / ${fmtBytes(item.requiredBytes)}`),
          h(Badge, null, `${item.entry.vramGB.min}–${item.entry.vramGB.recommended} GB`),
          h(Badge, null, `${item.entry.durationSec.min}–${item.entry.durationSec.max}s`),
          h(Badge, null, item.entry.runtimes.join(' · ')),
          item.entry.releasedAt
            ? h(Badge, { tone: 'gv-border-line gv-bg-surface-2 gv-text-muted' }, `${t('released')}: ${item.entry.releasedAt.slice(0, 10)}`)
            : null,
          item.entry.encoder
            ? h(Badge, {
                tone: item.entry.encoder.sizeGB !== null && item.entry.encoder.sizeGB > 8
                  ? 'gv-border-warn-soft gv-bg-warn-soft gv-text-warn'
                  : 'gv-border-ok-soft gv-bg-ok-soft gv-text-ok',
                title: [item.entry.encoder.format, item.entry.encoder.note].filter(Boolean).join(' · '),
              }, `${t('encoder')}: ${item.entry.encoder.name}${item.entry.encoder.sizeGB !== null ? ` · ${item.entry.encoder.sizeGB} GB` : ''}`)
            : null,
        ]),
        h('p', { class: 'gv-hint gv-mt-2' }, item.entry.notes),
        item.installed && item.entry.runtimes.includes('diffusers') && !state.value.deps.venv.ok
          ? h('div', { class: 'gv-mt-2 gv-flex gv-flex-wrap gv-items-center gv-gap-2' }, [
              h('span', { class: 'gv-text-[11.5px] gv-text-warn' }, t('weightsNoEngine')),
              h('button', { type: 'button', class: 'gv-btn gv-btn-primary gv-h-8 gv-px-3', disabled: Boolean(busy.value), onClick: installPython }, t('installPython')),
            ])
          : null,
        h('div', { class: 'gv-mt-2 gv-flex gv-flex-wrap gv-gap-1.5' },
          (['t2v', 'i2v', 'v2v', 'audio'] as const).map((capability) =>
            h(Badge, { key: capability, tone: item.entry.capabilities[capability] ? 'gv-border-ok-soft gv-bg-ok-soft gv-text-ok' : 'gv-border-line gv-bg-surface-2 gv-text-muted' }, capability.toUpperCase()))),
        downloadProgress(item.entry.id),
        downloadFailure(item.entry.id),
        item.updateAvailable || (item.newerCandidates ?? []).length
          ? h('div', { class: 'gv-mt-2 gv-rounded-lg gv-border gv-border-warn-soft gv-bg-warn-soft gv-p-2 gv-text-[11.5px] gv-text-warn' }, [
              h('div', null, t('newerVersion')),
              ...(item.newerCandidates ?? []).slice(0, 3).map((candidate: any) => h('div', { key: candidate.repo }, `${candidate.repo} — ${candidate.reason}`)),
            ])
          : null,
        h('div', { class: 'gv-mt-3 gv-flex gv-items-center gv-gap-2' }, [
          item.installed
            ? h('button', {
                type: 'button', class: 'gv-btn gv-btn-danger',
                disabled: Boolean(busy.value) || hasActiveDownload(item.entry.id),
                onClick: () => void deleteModel(item.entry.id),
              }, busy.value === `delete-${item.entry.id}` ? t('deleting') : t('deleteModel'))
            : h('button', {
                type: 'button', class: 'gv-btn gv-btn-primary',
                disabled: Boolean(busy.value) || !item.entry.repo || hasActiveDownload(item.entry.id),
                onClick: () => void installModel(item.entry.id),
              }, busy.value === `install-${item.entry.id}` ? t('installing') : t('installModel')),
          item.missingFiles?.length ? h('span', { class: 'gv-hint' }, `${item.missingFiles.length} file(s) missing`) : null,
          !item.installed && settings.value.customModels?.some((model: any) => model.id === item.entry.id)
            ? h('button', {
                type: 'button', class: 'gv-btn gv-btn-danger',
                onClick: () => void saveSettings({ customModels: settings.value.customModels.filter((model: any) => model.id !== item.entry.id) }),
              }, t('removeModel'))
            : null,
        ]),
      ])),
      customCard(),
    ])

    // RU: Строка обзора HF: VRAM, параметры, популярность и эвристики качества.
    // EN: HF overview row: VRAM, parameters, popularity and quality heuristics.
    const exploreView = () => {
      const page = explore.value?.page ?? explorePage.value
      const total = explore.value?.total ?? 0
      const pages = Math.max(1, Math.ceil(total / 10))
      const qualityText = (reasons: string[]) =>
        reasons.map((code) => t(`q_${code.replace(/-/g, '_')}`)).join(' · ')
      const limit = exploreVram.value
      return h('div', { class: 'gv-flex gv-flex-col gv-gap-2' }, [
        h('div', { class: 'gv-flex gv-flex-wrap gv-items-center gv-justify-between gv-gap-2' }, [
          h('p', { class: 'gv-hint gv-max-w-[520px]' }, `${t('exploreHint')} ${t('targetHint')}`),
          h('div', { class: 'gv-flex gv-items-center gv-gap-2' }, [
            h('span', { class: 'gv-hint' }, `${t('vramTarget')}:`),
            h(Segmented, {
              value: String(exploreVram.value),
              onChange: (value: string) => { exploreVram.value = Number(value) || 8 },
              options: [{ value: '8', label: '8 GB' }, { value: '16', label: '16 GB' }, { value: '24', label: '24 GB' }],
            }),
            h('button', { type: 'button', class: 'gv-btn gv-h-8 gv-px-3', disabled: exploreBusy.value, onClick: () => void loadExplore(page) }, t('exploreRefresh')),
          ]),
        ]),
        exploreBusy.value && !explore.value
          ? h('div', { class: 'gv-card gv-p-4 gv-hint' }, t('loading'))
          : null,
        ...(explore.value?.items ?? []).map((model: any) =>
          h('div', { key: model.id, class: 'gv-flex gv-flex-col gv-gap-1 gv-rounded-xl gv-border gv-border-line gv-bg-surface-2 gv-p-3' }, [
            h('div', { class: 'gv-flex gv-flex-wrap gv-items-center gv-justify-between gv-gap-2' }, [
              h('a', {
                href: `https://huggingface.co/${model.id}`, target: '_blank', rel: 'noreferrer',
                class: 'gv-break-all gv-text-[12.5px] gv-font-semibold gv-text-brand',
              }, model.id),
              h('div', { class: 'gv-flex gv-flex-wrap gv-items-center gv-gap-1.5' }, [
                h(Badge, { tone: model.vramGB !== null ? 'gv-border-brand-soft gv-bg-brand-soft gv-text-brand' : '' },
                  model.vramGB !== null ? `~${model.vramGB} GB VRAM` : t('vramUnknown')),
                h(Badge, {
                  tone: fitsVram(model.vramGB, limit)
                    ? 'gv-border-ok-soft gv-bg-ok-soft gv-text-ok'
                    : 'gv-border-warn-soft gv-bg-warn-soft gv-text-warn',
                }, fitsVram(model.vramGB, limit) ? `${limit} GB ✓` : `${limit} GB ✗`),
                model.paramsB ? h(Badge, null, `${model.paramsB}B`) : null,
                model.encoder ? h(Badge, { tone: 'gv-border-line gv-bg-surface-2 gv-text-muted' }, `${t('encoder')}: ${model.encoder}`) : null,
                model.createdAt ? h(Badge, { tone: 'gv-border-line gv-bg-surface-2 gv-text-muted' }, `${t('released')}: ${String(model.createdAt).slice(0, 10)}`) : null,
                h(Badge, null, `${fmtCount(model.downloads)} ${t('downloadsLabel')}`),
                h(Badge, null, `♥ ${fmtCount(model.likes)}`),
              ]),
            ]),
            h('div', { class: 'gv-hint' }, qualityText(model.reasons ?? [])),
            h('div', { class: 'gv-flex gv-flex-wrap gv-items-center gv-gap-2 gv-text-[10.5px]' }, [
              h('span', { class: 'gv-text-muted' }, `${t('benchmarks')}:`),
              h('a', { href: 'https://vchitect.github.io/VBench-project/', target: '_blank', rel: 'noreferrer', class: 'gv-text-brand' }, t('vbenchLeaderboard')),
              h('span', { class: 'gv-text-muted' }, '·'),
              h('a', { href: `https://huggingface.co/${model.id}`, target: '_blank', rel: 'noreferrer', class: 'gv-text-brand' }, t('modelCard')),
            ]),
            h('div', { class: 'gv-flex gv-flex-wrap gv-gap-1' },
              (model.tags ?? []).filter((tag: string) => !tag.startsWith('base_model:') && !tag.startsWith('license:') && !tag.startsWith('region:')).slice(0, 6).map((tag: string) =>
                h('span', { key: tag, class: 'gv-rounded gv-bg-surface-3 gv-px-1.5 gv-py-0.5 gv-text-[10px] gv-text-muted' }, tag))),
          ])),
        h('div', { class: 'gv-mt-1 gv-flex gv-items-center gv-justify-between gv-gap-2' }, [
          h('button', { type: 'button', class: 'gv-btn gv-h-8 gv-px-3', disabled: exploreBusy.value || page <= 1, onClick: () => void loadExplore(page - 1) }, t('prevPage')),
          h('span', { class: 'gv-hint' }, explore.value ? `${page} / ${pages} · ${total}` : '—'),
          h('button', { type: 'button', class: 'gv-btn gv-h-8 gv-px-3', disabled: exploreBusy.value || !explore.value?.hasMore, onClick: () => void loadExplore(page + 1) }, t('nextPage')),
        ]),
      ])
    }

    const modelsView = () => h('div', { class: 'gv-flex gv-flex-col gv-gap-3' }, [
      h(Segmented, {
        value: modelsTab.value,
        onChange: (value: string) => {
          modelsTab.value = value === 'explore' ? 'explore' : 'installed'
          if (modelsTab.value === 'explore' && !explore.value) void loadExplore(1)
        },
        options: [{ value: 'installed', label: t('installedModels') }, { value: 'explore', label: t('exploreModels') }],
      }),
      modelsTab.value === 'installed' ? installedModelsView() : exploreView(),
    ])

    const gpuSection = () => h(Card, { title: t('gpu'), hint: state.value.gpu.error ?? null }, [
      state.value.gpu.available
        ? h('div', { class: 'gv-flex gv-flex-col gv-gap-3' }, [
            ...state.value.gpu.gpus.map((gpu: any) =>
              h('label', { key: gpu.index, class: 'gv-flex gv-items-center gv-justify-between gv-gap-3 gv-rounded-lg gv-border gv-border-line gv-p-2.5' }, [
                h('span', { class: 'gv-flex gv-min-w-0 gv-items-center gv-gap-2' }, [
                  h('input', {
                    type: 'checkbox', checked: settings.value.gpu.ids.length === 0 || settings.value.gpu.ids.includes(gpu.index),
                    onChange: (event: any) => {
                      const current = settings.value.gpu.ids.length === 0 ? state.value.gpu.gpus.map((item: any) => item.index) : settings.value.gpu.ids
                      const next = event.target.checked ? [...current, gpu.index] : current.filter((id: number) => id !== gpu.index)
                      settingsDraft.value = { ...settings.value, gpu: { ...settings.value.gpu, ids: next } }
                    },
                  }),
                  h('span', { class: 'gv-flex gv-flex-col' }, [
                    h('span', { class: 'gv-text-[12px] gv-font-medium' }, gpu.name),
                    h('span', { class: 'gv-hint' }, `#${gpu.index} · driver ${gpu.driver} · cc ${gpu.computeCap}`),
                  ]),
                ]),
                h('span', { class: 'gv-flex gv-w-32 gv-flex-col gv-gap-1' }, [
                  h('span', { class: 'gv-text-right gv-text-[11px] gv-text-muted' }, `${Math.round(gpu.usedMB / 1024)} / ${Math.round(gpu.totalMB / 1024)} GB`),
                  h(Progress, { percent: gpu.totalMB ? (gpu.usedMB / gpu.totalMB) * 100 : 0, tone: 'gv-bg-warn' }),
                ]),
              ])),
            h('span', { class: 'gv-hint' }, t('gpuSelect')),
          ])
        : h('div', { class: 'gv-flex gv-flex-col gv-gap-2' }, [
            h('div', { class: 'gv-text-[12.5px] gv-font-medium gv-text-danger' }, t('gpuNone')),
            h('div', { class: 'gv-hint' }, state.value.gpu.error ?? ''),
            h('ul', { class: 'gv-list-disc gv-pl-5 gv-text-[11.5px] gv-text-muted' }, (state.value.gpu.hints ?? []).map((hint: string, index: number) => h('li', { key: index }, hint))),
            h('button', { type: 'button', class: 'gv-btn gv-w-fit', onClick: () => void api('/gpus/refresh', { method: 'POST', body: '{}' }).then(refresh) }, t('refresh')),
          ]),
    ])

    // RU: Понятные карточки движков: что это, готов ли, что нажать.
    // EN: Clear engine cards: what it is, whether it is ready, what to click.
    const engineCard = (title: string, description: string, ready: boolean, statusText: string, action: any, extra: any = null) =>
      h('div', { class: 'gv-flex gv-flex-col gv-gap-2 gv-rounded-xl gv-border gv-border-line gv-bg-surface-2 gv-p-3' }, [
        h('div', { class: 'gv-flex gv-flex-wrap gv-items-start gv-justify-between gv-gap-2' }, [
          h('div', { class: 'gv-min-w-0' }, [
            h('div', { class: 'gv-text-[13px] gv-font-semibold gv-text-text' }, title),
            h('div', { class: 'gv-hint gv-mt-0.5' }, description),
          ]),
          h(Badge, { tone: ready ? 'gv-border-ok-soft gv-bg-ok-soft gv-text-ok' : 'gv-border-warn-soft gv-bg-warn-soft gv-text-warn' }, statusText),
        ]),
        action ? h('div', { class: 'gv-flex gv-flex-wrap gv-items-center gv-gap-2' }, action) : null,
        extra,
      ])

    const toolsSection = () => {
      const deps = state.value.deps
      const comfyReady = deps.comfyui.ok
      return h(Card, { title: t('tools') }, [
        h('p', { class: 'gv-hint gv-mb-3' }, t('enginesIntro')),
        h('div', { class: 'gv-flex gv-flex-col gv-gap-3' }, [
          engineCard(
            t('comfyEngine'),
            t('comfyEngineDesc'),
            comfyReady,
            comfyReady ? deps.comfyui.url : t('engineMissing'),
            [h('button', { type: 'button', class: 'gv-btn gv-h-8 gv-px-3', onClick: () => void recheckDeps() }, t('comfyCheck'))],
          ),
          engineCard(t('mockEngine'), t('mockEngineDesc'), true, t('alwaysAvailable'), null),
        ]),
        h('div', { class: 'gv-mt-4' }, [
          h('div', { class: 'gv-group-title gv-mb-1' }, t('systemTools')),
          h('div', { class: 'gv-flex gv-flex-col' }, [
            h(Row, { label: t('ffmpeg'), hint: deps.ffmpeg.version ?? '' }, [
              h(Badge, { tone: deps.ffmpeg.ok ? 'gv-border-ok-soft gv-bg-ok-soft gv-text-ok' : 'gv-border-danger-soft gv-bg-danger-soft gv-text-danger' }, deps.ffmpeg.ok ? deps.ffmpeg.path : t('unavailable')),
              !deps.ffmpeg.ok ? h('button', { type: 'button', class: 'gv-btn gv-h-8 gv-px-3', onClick: installFfmpeg }, t('installFfmpeg')) : null,
            ]),
            h(Row, { label: t('ffprobe') }, [
              h(Badge, { tone: deps.ffprobe.ok ? 'gv-border-ok-soft gv-bg-ok-soft gv-text-ok' : 'gv-border-danger-soft gv-bg-danger-soft gv-text-danger' }, deps.ffprobe.ok ? deps.ffprobe.path : t('unavailable')),
            ]),
          ]),
        ]),
      ])
    }

    const pathsSection = () => h(Card, { title: t('defaults'), hint: t('settingsHint') }, [
      h('div', { class: 'gv-grid gv-grid-cols-1 gv-gap-3 sm:gv-grid-cols-2' }, [
        h(Field, { label: t('outputDir'), hint: t('outputHint') }, [
          h('input', {
            class: 'gv-input', placeholder: state.value.paths.videosDir, value: settings.value.outputDir,
            onInput: (event: any) => (settingsDraft.value = { ...settings.value, outputDir: event.target.value }),
          }),
        ]),
        h(Field, { label: t('modelsDir'), hint: t('modelsHint') }, [
          h('input', {
            class: 'gv-input', placeholder: state.value.paths.modelsDir, value: settings.value.modelsDir,
            onInput: (event: any) => (settingsDraft.value = { ...settings.value, modelsDir: event.target.value }),
          }),
        ]),
        h(Field, { label: t('language') }, [
          h('select', {
            class: 'gv-select', value: settings.value.language,
            onChange: (event: any) => {
              language.value = event.target.value
              settingsDraft.value = { ...settings.value, language: event.target.value }
            },
          }, [h('option', { value: 'en' }, t('english')), h('option', { value: 'ru' }, t('russian'))]),
        ]),
        h(Field, { label: t('defaults') }, [
          h('select', {
            class: 'gv-select', value: settings.value.platform,
            onChange: (event: any) => (settingsDraft.value = { ...settings.value, platform: event.target.value }),
          }, ['reels', 'shorts', 'youtube', 'youtube4k', 'cinema', 'square', 'portrait45', 'custom'].map((value) => h('option', { key: value, value }, value))),
        ]),
      ]),
      h('div', { class: 'gv-mt-3 gv-flex gv-flex-wrap gv-items-center gv-gap-2' }, [
        h('button', { type: 'button', class: 'gv-btn gv-btn-primary', disabled: Boolean(busy.value), onClick: () => void saveSettings(settings.value) }, t('save')),
        h('button', { type: 'button', class: 'gv-btn', onClick: resetSettings }, t('reset')),
      ]),
    ])

    const networkSection = () => h(Card, { title: t('network'), hint: t('proxyHint') }, [
      h(Toggle, {
        checked: settings.value.proxy.enabled,
        label: t('useProxy'),
        hint: t('proxyHint'),
        onChange: (enabled: boolean) => (settingsDraft.value = { ...settings.value, proxy: { ...settings.value.proxy, enabled } }),
      }),
      settings.value.proxy.enabled
        ? h(Field, { label: t('proxyUrl'), hint: t('proxyUrlHint') }, [
            h('input', {
              class: 'gv-input', placeholder: 'socks5://127.0.0.1:1080', value: settings.value.proxy.url,
              onInput: (event: any) => (settingsDraft.value = { ...settings.value, proxy: { ...settings.value.proxy, url: event.target.value } }),
            }),
          ])
        : null,
    ])

    const serviceSection = () => h(Card, { title: t('service') }, [
      h(Row, { label: t('version') }, [h(Badge, null, state.value.version)]),
      h(Row, { label: t('uptime') }, [h(Badge, null, fmtDuration((Date.now() - state.value.startedAt) / 1000))]),
      h(Row, { label: t('mcpTools') }, [h(Badge, { tone: 'gv-border-ok-soft gv-bg-ok-soft gv-text-ok' }, 'mcp__genvideo__*')]),
    ])

    const environmentView = () => {
      const deps = state.value.deps
      return h('div', { class: 'gv-flex gv-flex-col gv-gap-3' }, [
        h(Card, { title: t('environment') }, [
          h('p', { class: 'gv-hint gv-mb-3' }, 'Read-only status of the engine used for generation.'),
          h('div', { class: 'gv-flex gv-flex-col gv-gap-2' }, [
            h(Row, { label: 'ComfyUI', hint: deps.comfyui.url ?? '' }, [
              h(Badge, { tone: deps.comfyui.ok ? 'gv-border-ok-soft gv-bg-ok-soft gv-text-ok' : 'gv-border-danger-soft gv-bg-danger-soft gv-text-danger' }, deps.comfyui.ok ? deps.comfyui.url : t('unavailable')),
            ]),
            h(Row, { label: 'Workflow' }, [
              h(Badge, null, '$DSH_HOME/genvideo/workflow.json'),
            ]),
            h(Row, { label: t('ffmpeg'), hint: deps.ffmpeg.version ?? '' }, [
              h(Badge, { tone: deps.ffmpeg.ok ? 'gv-border-ok-soft gv-bg-ok-soft gv-text-ok' : 'gv-border-danger-soft gv-bg-danger-soft gv-text-danger' }, deps.ffmpeg.ok ? deps.ffmpeg.path : t('unavailable')),
            ]),
            h(Row, { label: t('ffprobe') }, [
              h(Badge, { tone: deps.ffprobe.ok ? 'gv-border-ok-soft gv-bg-ok-soft gv-text-ok' : 'gv-border-danger-soft gv-bg-danger-soft gv-text-danger' }, deps.ffprobe.ok ? deps.ffprobe.path : t('unavailable')),
            ]),
          ]),
          h('div', { class: 'gv-mt-4' }, [
            h('div', { class: 'gv-group-title gv-mb-1' }, t('workflowInfo')),
            ...workflows.value.map((wf: any) => h('div', { key: wf.name, class: 'gv-rounded-lg gv-border gv-border-line gv-bg-surface-2 gv-p-2 gv-mt-1' }, [
              h('div', { class: 'gv-flex gv-flex-wrap gv-items-center gv-justify-between gv-gap-2' }, [
                h('span', { class: 'gv-text-[12px] gv-font-semibold gv-text-text' }, wf.name.toUpperCase()),
                h(Badge, { tone: wf.valid ? 'gv-border-ok-soft gv-bg-ok-soft gv-text-ok' : 'gv-border-danger-soft gv-bg-danger-soft gv-text-danger' }, wf.valid ? 'valid' : wf.exists ? 'invalid' : 'missing'),
              ]),
              h('div', { class: 'gv-hint gv-truncate', title: wf.path }, wf.path),
              wf.valid
                ? h('div', { class: 'gv-mt-1 gv-flex gv-flex-col gv-gap-0.5 gv-text-[11.5px]' }, [
                    h('div', null, `${t('model')}: ${wf.model ?? '—'}`),
                    h('div', null, `${t('textEncoder')}: ${wf.encoder ?? '—'}`),
                    h('div', null, `VAE: ${wf.vae ?? '—'}`),
                    h('div', null, `${t('upscaling')}: ${wf.upscalers?.length ? wf.upscalers.join(', ') : '—'}`),
                  ])
                : null,
            ])),
          ]),
          h('div', { class: 'gv-mt-3' }, [
            h('div', { class: 'gv-group-title gv-mb-1' }, 'Agent tools'),
            h('div', { class: 'gv-flex gv-flex-wrap gv-gap-1.5' }, ['genvideo_status','genvideo_plan','genvideo_generate','genvideo_jobs','genvideo_job','genvideo_cancel','genvideo_merge','genvideo_transcode'].map((tool) => h(Badge, { key: tool }, tool))),
          ]),
          h('div', { class: 'gv-mt-3' }, [h('button', { type: 'button', class: 'gv-btn gv-h-8 gv-px-3', onClick: () => void recheckDeps() }, t('refresh'))]),
        ]),
      ])
    }

    const settingsView = () => h('div', { class: 'gv-grid gv-grid-cols-1 gv-gap-4 lg:gv-grid-cols-2' }, [
      gpuSection(), toolsSection(), pathsSection(), networkSection(), serviceSection(),
    ])

    return () => {
      if (!state.value) {
        return h('div', { class: 'gv-panel gv-flex gv-flex-col gv-gap-3 gv-p-6 gv-text-text' }, [h('style', null, typeof styles === 'string' ? styles : ''), h('div', { class: 'gv-hint' }, t('loading'))])
      }
      const tabs = [['generate', t('generate')], ['jobs', t('jobs')], ['gallery', t('gallery')], ['environment', t('environment')]]
      const content = tab.value === 'generate' ? generateView()
        : tab.value === 'jobs' ? jobsView()
        : tab.value === 'gallery' ? libraryView()
        : environmentView()
      return h('div', { class: 'gv-panel gv-flex gv-flex-col gv-gap-4 gv-p-4 gv-font-sans gv-text-text' }, [
        h('style', null, typeof styles === 'string' ? styles : ''),
        header(),
        error.value ? h('div', { class: 'gv-rounded-lg gv-border gv-border-danger-soft gv-bg-danger-soft gv-px-3 gv-py-2 gv-text-[12px] gv-text-danger' }, error.value) : null,
        notice.value ? h('div', { class: 'gv-rounded-lg gv-border gv-border-ok-soft gv-bg-ok-soft gv-px-3 gv-py-2 gv-text-[12px] gv-text-ok' }, notice.value) : null,
        !state.value.deps.ffmpeg.ok ? h('div', { class: 'gv-rounded-lg gv-border gv-border-warn-soft gv-bg-warn-soft gv-px-3 gv-py-2 gv-text-[12px] gv-text-warn' }, t('ffmpegMissing')) : null,
        props.surface === 'settings' ? null : h('div', { class: 'gv-tabs gv-flex gv-gap-1' },
          tabs.map(([value, label]) =>
            h('button', {
              key: value, type: 'button',
              onClick: () => {
                tab.value = value
                if (value === 'gallery') void refreshLibrary()
              },
              class: `gv-tab gv-relative gv-px-3 gv-py-2 gv-text-[12.5px] gv-font-medium gv-transition-colors ${tab.value === value ? 'gv-tab-active gv-text-text' : 'gv-text-muted'}`,
            }, [label, tab.value === value ? h('span', { class: 'gv-absolute gv-inset-x-2 gv-bottom-0 gv-h-0.5 gv-rounded-t gv-bg-brand' }) : null]))),
        props.surface === 'settings' ? settingsView() : content,
        preview.value ? previewModal() : null,
      ])
    }
  },
}

/** RU: Экспорт Vue-приложения панели для React-моста. EN: Vue panel app export for the React bridge. */
export const GenVideoPanel = Panel
