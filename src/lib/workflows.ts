/**
 * RU: Установка встроенных ComfyUI-workflow. При первом запуске плагина
 *     шаблоны копируются в $DSH_HOME/genvideo, если там ещё нет workflow.
 *     Пользовательский workflow никогда не перезаписывается.
 * EN: Bundled ComfyUI workflow installation. On first start the templates are
 *     copied into $DSH_HOME/genvideo when no workflow exists yet. A user-defined
 *     workflow is never overwritten.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { genvideoHome } from './paths.js'

/** RU: Встроенные шаблоны. EN: Bundled templates. */
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
  for (const entry of BUNDLED_WORKFLOWS) {
    const target = join(home, entry.target)
    if (existsSync(target)) {
      skipped.push(target)
      continue
    }
    const source = fileURLToPath(new URL(entry.source, import.meta.url))
    if (!existsSync(source)) {
      skipped.push(source)
      continue
    }
    copyFileSync(source, target)
    installed.push(target)
  }
  return { installed, skipped }
}
