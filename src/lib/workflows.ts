/**
 * RU: Установка встроенных ComfyUI-workflow. При первом запуске плагина
 *     шаблоны копируются в $DSH_HOME/genvideo, если там ещё нет workflow.
 *     Пользовательский workflow никогда не перезаписывается.
 * EN: Bundled ComfyUI workflow installation. On first start the templates are
 *     copied into $DSH_HOME/genvideo when no workflow exists yet. A user-defined
 *     workflow is never overwritten.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { genvideoHome } from './paths.js'

/** RU: Встроенные шаблоны. EN: Bundled templates. */
export const BUNDLED_WORKFLOW_VERSION = '1.2.0'
export const BUNDLED_WORKFLOWS = [
  { source: '../../workflows/ltxv-t2v.json', target: 'workflow.json' },
  { source: '../../workflows/ltxv-image-to-video.json', target: 'workflow-image.json' },
  { source: '../../workflows/ltxv-video-to-video.json', target: 'workflow-video.json' },
] as const

/** RU: Копирует недостающие workflow. EN: Copies missing workflows. */
export function installBundledWorkflows(): { installed: string[]; skipped: string[] } {
  const home = genvideoHome()
  mkdirSync(home, { recursive: true })
  const installed: string[] = []
  const skipped: string[] = []
  const manifestPath = join(home, 'workflows.manifest.json')
  const previous = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, 'utf8'))?.version ?? '') : ''
  const migrate = previous !== BUNDLED_WORKFLOW_VERSION
  for (const entry of BUNDLED_WORKFLOWS) {
    const target = join(home, entry.target)
    if (existsSync(target)) {
      if (!migrate) {
        skipped.push(target)
        continue
      }
      // RU: Обновляем шаблон, сохраняя резервную копию. EN: Update template, keep a backup.
      copyFileSync(target, `${target}.bak-${Date.now()}`)
    }
    const source = fileURLToPath(new URL(entry.source, import.meta.url))
    if (!existsSync(source)) {
      skipped.push(source)
      continue
    }
    copyFileSync(source, target)
    installed.push(target)
  }
  writeFileSync(manifestPath, JSON.stringify({ version: BUNDLED_WORKFLOW_VERSION }, null, 2))
  return { installed, skipped }
}
