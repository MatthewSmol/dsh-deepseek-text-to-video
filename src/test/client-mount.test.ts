/**
 * RU: Тест реального монтирования Vue-панели через React-мост DSH: happy-dom
 *     даёт DOM, заглушки fetch/EventSource отдают состояние сервиса, после
 *     чего проверяется, что в контейнере появился готовый интерфейс.
 * EN: Real Vue panel mount test through the DSH React bridge: happy-dom provides
 *     the DOM, fetch/EventSource stubs return service state, and the container is
 *     checked for the rendered interface.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'
import { DEFAULT_SETTINGS } from '../lib/store.js'

/** RU: Минимальное состояние сервиса для рендера. EN: Minimal service state for rendering. */
function fixtureState() {
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.language = 'en'
  return {
    version: '1.0.0',
    startedAt: Date.now(),
    revision: 1,
    settings,
    gpu: { available: false, gpus: [], error: 'nvidia-smi returned no GPUs', hints: ['Mock works'], checkedAt: Date.now() },
    deps: {
      ffmpeg: { ok: true, path: '/usr/bin/ffmpeg', version: 'ffmpeg 8', encoders: ['libx264', 'aac'] },
      ffprobe: { ok: true, path: '/usr/bin/ffprobe', version: 'ffprobe 8' },
      python: { ok: true, path: 'python3', version: '3.14' },
      venv: { ok: false, path: '/tmp/venv', torch: null, diffusers: null, cuda: false },
      cargo: { ok: false, path: 'cargo', version: null },
      candle: { ok: false, path: '' },
      comfyui: { ok: false, url: '', error: 'not configured' },
      disk: { freeGB: 10, totalGB: 20 },
      checkedAt: Date.now(),
    },
    models: [
      {
        entry: {
          id: 'ltx-0.9.8-2b-distilled', title: 'LTX-Video 0.9.8 2B distilled', family: 'ltx-video',
          repo: 'oxide-lab/LTX-Video-0.9.8-2B-distilled', kind: 'candle-ltxv',
          variants: [{ id: 'unified', title: 'Unified', files: ['a.safetensors'], sizeGB: 9.7, precision: 'bf16' }],
          runtimes: ['mock'], capabilities: { t2v: true, i2v: false, v2v: false, audio: false },
          durationSec: { min: 1, max: 10.7, recommended: 4 }, fps: [24], width: 768, height: 512,
          vramGB: { min: 8, recommended: 12 }, maxPromptChars: 2000, license: 'LTX', notes: 'Candle', extraFiles: [],
        },
        installed: false, installedBytes: 0, requiredBytes: 9_700_000_000, variant: 'unified',
        missingFiles: ['a.safetensors'], updateAvailable: false, checkedAt: null, remoteRevision: null, newerCandidates: [],
      },
    ],
    jobs: [],
    paths: { videosDir: '/tmp/Videos', modelsDir: '/tmp/models', genvideoHome: '/tmp/gv' },
  }
}

test('the Vue panel mounts through the React bridge and renders the scoped UI', async () => {
  const window = new Window({ url: 'http://127.0.0.1:3080/' })
  const document = window.document
  const globals = globalThis as any
  const state = fixtureState()

  // RU: Глобалы нужны Vue runtime-dom и клиентскому бандлу.
  // EN: These globals are required by Vue runtime-dom and the client bundle.
  globals.window = window
  globals.document = document
  globals.HTMLElement = window.HTMLElement
  globals.Element = window.Element
  globals.SVGElement = window.SVGElement
  globals.Node = window.Node
  globals.Event = window.Event
  globals.MutationObserver = window.MutationObserver
  globals.fetch = async (url: string) => {
    const path = String(url)
    const value = path.includes('/library') ? [] : path.includes('/state') ? state : null
    return { ok: true, status: 200, json: async () => ({ ok: true, value }) }
  }
  globals.EventSource = class {
    readyState = 0
    onmessage: any = null
    close() {}
  }

  let loaded: any = null;
  (window as any).__ModuleLoader__ = { load: (module: any) => (loaded = module) }

  const effects: Array<() => any> = []
  const react = {
    useRef: (initial: any) => ({ current: initial }),
    useEffect: (effect: () => any) => effects.push(effect),
    createElement: (type: any, props: any, ...children: any[]) => ({ type, props, children }),
  }

  const moduleUrl = new URL('../client.js', import.meta.url).href
  await import(moduleUrl)
  assert.ok(loaded, 'the bundle must register itself through __ModuleLoader__')

  const registrations: Array<{ options: any; component: any }> = []
  const ctx = {
    effect: (callback: () => any) => callback(),
    locale: { register: () => undefined, bind: () => (key: string) => key },
    slots: {
      inject: (_name: string, callback: () => unknown) => callback(),
      register: (options: any, component: any) => {
        registrations.push({ options, component })
        return () => undefined
      },
    },
  }
  if (!loaded) throw new Error('client bundle did not register')
  loaded.factory(() => react).apply(ctx)
  assert.equal(registrations.length, 4)

  const main = registrations.find((item) => item.options.name === 'main')?.component
  assert.equal(typeof main, 'function')

  // RU: MainPanel → VueHost создаёт div и эффект монтирования Vue-приложения.
  // EN: MainPanel → VueHost creates a div and the Vue mount effect.
  const outer = main({})
  const inner = outer.type(outer.props)
  const containerRef = inner.props.ref
  containerRef.current = document.createElement('div')
  const container = containerRef.current
  assert.ok(container, 'the bridge must provide a container element')
  document.body.appendChild(container)
  const cleanup = await effects[0]!()

  // RU: Ждём ответ /state и следующий тик Vue. EN: Wait for /state and the next Vue tick.
  await new Promise((resolve) => setTimeout(resolve, 50))
  try {
  const html = container.innerHTML
  assert.ok(html.includes('GenVideo'), 'the header title must be rendered')
  assert.ok(html.includes('gv-'), 'scoped panel classes must be applied')
  assert.ok(html.includes('gv-panel'), 'the root must be the scrollable panel')
  assert.ok(html.includes('.gv-panel'), 'the scroll CSS must be inlined')
  assert.ok(html.includes('Generate video') || html.includes('Generate'), 'the generate tab must be visible')
  assert.ok(html.includes('ffmpeg'), 'environment state must be rendered')
  assert.ok(html.length > 2000, `expected a full panel, got ${html.length} chars`)

  // RU: Снимаем Vue-приложение и закрываем happy-dom, иначе интервал опроса
  //     состояния не даст тестовому процессу завершиться.
  // EN: Unmount the Vue app and close happy-dom; otherwise the state polling
  //     interval keeps the test process alive.
  } finally {
    if (typeof cleanup === 'function') cleanup()
    await (window as any).happyDOM?.close?.()
  }
})
