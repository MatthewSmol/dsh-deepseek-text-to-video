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
import { join } from 'node:path'
import type { Runner, RunnerAvailabilityInput, RunnerResult, RunnerRunInput } from './types.js'
import { available, unavailable } from './types.js'
import { GenVideoError } from '../errors.js'
import { modelsDirOf } from '../store.js'

/** RU: Где искать workflow. EN: Where to look for the workflow. */
export function workflowPath(modelId: string, modelsDir: string): string {
  return process.env.GENVIDEO_COMFY_WORKFLOW || join(modelsDir, modelId, 'workflow.json')
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
      return unavailable('ComfyUI is not reachable', 'Start ComfyUI and set its URL in Settings → ComfyUI, then press Test')
    }
    return available()
  },
  async run(input: RunnerRunInput): Promise<RunnerResult> {
    const base = (input.settings.deps.comfyuiUrl || '').replace(/\/+$/, '')
    if (!base) throw new GenVideoError('comfyui-missing', 'ComfyUI URL is not configured')
    const wfPath = workflowPath(input.model.id, modelsDirOf(input.settings))
    if (!(await exists(wfPath))) {
      throw new GenVideoError(
        'comfyui-workflow-missing',
        `Workflow not found at ${wfPath}. Export it in API format and place it there, or set GENVIDEO_COMFY_WORKFLOW.`,
      )
    }
    const template = await (await import('node:fs/promises')).readFile(wfPath, 'utf8')
    const workflowText = substituteWorkflow(template, {
      prompt: input.prompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"'),
      negative: input.negativePrompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"'),
      width: String(input.width),
      height: String(input.height),
      frames: String(input.frames),
      fps: String(input.fps),
      seed: String(Math.max(0, input.seed)),
      steps: String(Math.max(0, input.steps)),
      image: input.imagePath ?? '',
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
