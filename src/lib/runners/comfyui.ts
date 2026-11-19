/**
 * RU: ComfyUI-раннер. Пользователь экспортирует workflow в API-формате,
 *     кладёт его в `<models>/<modelId>/workflow.json` (или задаёт
 *     GENVIDEO_COMFY_WORKFLOW) и плагин подставляет плейсхолдеры, ставит
 *     задачу через /prompt, ждёт /history и скачивает результат через /view.
 * EN: ComfyUI runner. The user exports a workflow in API format, places it at
 *     `<models>/<modelId>/workflow.json` (or sets GENVIDEO_COMFY_WORKFLOW), and
 *     the plugin substitutes placeholders, submits through /prompt, waits on
 *     /history and downloads the result through /view.
 */
import { access, mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { Runner, RunnerAvailabilityInput, RunnerResult, RunnerRunInput } from './types.js'
import { available, unavailable } from './types.js'
import { GenVideoError } from '../errors.js'
import { modelsDirOf } from '../store.js'
import { detectComfyUi } from '../deps.js'
import { genvideoHome } from '../paths.js'

/** RU: Загружает референс в input ComfyUI и возвращает имя для LoadImage/LoadVideo.
 *  EN: Uploads a reference into ComfyUI's input folder and returns its node name. */
async function uploadInput(base: string, filePath: string, signal: AbortSignal): Promise<string> {
  const data = await readFile(filePath)
  const form = new FormData()
  form.append('image', new Blob([data]), basename(filePath))
  form.append('type', 'input')
  const response = await fetch(`${base}/upload/image`, { method: 'POST', body: form, signal })
  if (!response.ok) {
    throw new GenVideoError('comfyui-upload-failed', `ComfyUI rejected the reference upload: HTTP ${response.status}`)
  }
  const payload = await response.json() as { name?: string; subfolder?: string }
  if (!payload.name) throw new GenVideoError('comfyui-upload-failed', 'ComfyUI did not return an uploaded file name')
  return payload.subfolder ? `${payload.subfolder}/${payload.name}` : payload.name
}

/** RU: Где искать workflow. EN: Where to look for the workflow. */
export function workflowPath(modelId: string, modelsDir: string): string {
  return process.env.GENVIDEO_COMFY_WORKFLOW || join(genvideoHome(), 'workflow.json')
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** RU: Подставляет значения в JSON-workflow. EN: Substitutes values into the JSON workflow. */
export function substituteWorkflow(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? '')
}

interface HistoryOutput {
  filename?: string
  subfolder?: string
  type?: string
}

interface HistoryEntry {
  outputs?: Record<string, { images?: HistoryOutput[]; gifs?: HistoryOutput[]; videos?: HistoryOutput[] }>
  status?: { status_str?: string; completed?: boolean }
}

export const comfyuiRunner: Runner = {
  id: 'comfyui',
  availability(input: RunnerAvailabilityInput) {
    if (!input.model.runtimes.includes('comfyui')) return unavailable('This model has no ComfyUI path', 'Use a command template or the diffusers path')
    if (!input.deps.comfyui.ok) {
      return unavailable('ComfyUI is not reachable', 'Start ComfyUI; the plugin probes 127.0.0.1:8188, 8189 and 8000 automatically, or set a URL in Settings → Advanced')
    }
    return available()
  },
  async run(input: RunnerRunInput): Promise<RunnerResult> {
    const detected = await detectComfyUi(input.settings.deps.comfyuiUrl)
    const base = (input.settings.deps.comfyuiUrl || detected.url || '').replace(/\/+$/, '')
    if (!base) throw new GenVideoError('comfyui-missing', 'ComfyUI URL is not configured')
    const baseWorkflow = workflowPath(input.model.id, modelsDirOf(input.settings))
    const variantWorkflow = input.imagePath
      ? join(dirname(baseWorkflow), 'workflow-image.json')
      : input.videoPath
        ? join(dirname(baseWorkflow), 'workflow-video.json')
        : baseWorkflow
    const wfPath = (await exists(variantWorkflow)) ? variantWorkflow : baseWorkflow
    if (!(await exists(wfPath))) {
      throw new GenVideoError(
        'comfyui-workflow-missing',
        `Workflow not found at ${wfPath}. Export it in API format and place it there, or set GENVIDEO_COMFY_WORKFLOW.`,
      )
    }
    const template = await readFile(wfPath, 'utf8')
    if (input.imagePath && !template.includes('{{image}}')) {
      throw new GenVideoError('workflow-image-placeholder-missing', `Workflow ${wfPath} has no {{image}} placeholder`)
    }
    if (input.videoPath && !template.includes('{{video}}')) {
      throw new GenVideoError('workflow-video-placeholder-missing', `Workflow ${wfPath} has no {{video}} placeholder`)
    }
    const uploadedImage = input.imagePath ? await uploadInput(base, input.imagePath, input.signal) : ''
    const uploadedVideo = input.videoPath ? await uploadInput(base, input.videoPath, input.signal) : ''
    const escapeJson = (value: string) => value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
    const landscape = input.width >= input.height
    const baseWidth = landscape ? 768 : 512
    const baseHeight = landscape ? 512 : 768
    const workflowText = substituteWorkflow(template, {
      prompt: escapeJson(input.prompt),
      negative: escapeJson(input.negativePrompt),
      width: String(input.width),
      height: String(input.height),
      frames: String(input.frames),
      fps: String(input.fps),
      seed: String(Math.max(0, input.seed)),
      steps: String(Math.max(0, input.steps)),
      image: uploadedImage,
      video: uploadedVideo,
      baseWidth: String(baseWidth),
      baseHeight: String(baseHeight),
      outWidth: String(input.width),
      outHeight: String(input.height),
      model: input.model.id,
    })
    let workflow: unknown
    try {
      workflow = JSON.parse(workflowText)
    } catch {
      throw new GenVideoError('comfyui-workflow-invalid', 'The ComfyUI workflow is not valid JSON after substitution')
    }

    input.onProgress({ phase: 'encoding_prompt', percent: 5, message: 'Submitting to ComfyUI' })
    const response = await fetch(`${base}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: `genvideo-${Date.now()}` }),
      signal: input.signal,
    })
    if (!response.ok) {
      throw new GenVideoError('comfyui-rejected', `ComfyUI returned HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`)
    }
    const submitted = (await response.json()) as { prompt_id?: string }
    const promptId = submitted.prompt_id
    if (!promptId) throw new GenVideoError('comfyui-rejected', 'ComfyUI did not return a prompt_id')

    const started = Date.now()
    const estimateMs = Math.max(30_000, input.durationSec * 20_000)
    let entry: HistoryEntry | null = null
    while (!entry) {
      if (input.signal.aborted) {
        await fetch(`${base}/interrupt`, { method: 'POST', signal: AbortSignal.timeout(3000) }).catch(() => undefined)
        throw new Error('aborted')
      }
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const percent = Math.min(90, 5 + Math.round(((Date.now() - started) / estimateMs) * 85))
      input.onProgress({ phase: 'sampling', percent, message: 'ComfyUI is rendering' })
      const historyResponse = await fetch(`${base}/history/${promptId}`, { signal: input.signal })
      if (!historyResponse.ok) continue
      const history = (await historyResponse.json()) as Record<string, HistoryEntry>
      entry = history[promptId] ?? null
    }

    const outputs = entry.outputs ?? {}
    let file: HistoryOutput | null = null
    for (const node of Object.values(outputs)) {
      const candidate = node.videos?.[0] ?? node.gifs?.[0] ?? node.images?.[0]
      if (candidate?.filename) {
        file = candidate
        break
      }
    }
    if (!file?.filename) {
      throw new GenVideoError('comfyui-no-output', 'The workflow finished without a video output. Check that the workflow saves a video (VHS/VideoCombine or SaveAnimatedWEBP), not a still image.')
    }

    input.onProgress({ phase: 'muxing', percent: 92, message: 'Downloading the result' })
    const query = new URLSearchParams({
      filename: file.filename,
      subfolder: file.subfolder ?? '',
      type: file.type ?? 'output',
    })
    const download = await fetch(`${base}/view?${query.toString()}`, { signal: input.signal })
    if (!download.ok || !download.body) {
      throw new GenVideoError('comfyui-no-output', `Could not download the result: HTTP ${download.status}`)
    }
    await mkdir(join(input.outputPath, '..'), { recursive: true })
    await writeFile(input.outputPath, Buffer.from(await download.arrayBuffer()))
    return {
      outputPath: input.outputPath,
      width: input.width,
      height: input.height,
      fps: input.fps,
      durationSec: input.durationSec,
    }
  },
}
