/**
 * RU: Smoke-тест Vue-бандла: модуль должен загрузиться, вызвать
 *     `window.__ModuleLoader__.load` и зарегистрировать четыре слота.
 * EN: Vue bundle smoke test: the module must load, call
 *     `window.__ModuleLoader__.load` and register four slots.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const bundlePath = fileURLToPath(new URL('../client.js', import.meta.url))

test('vue bundle registers the sidebar, main and settings slots', async () => {
  const code = await readFile(bundlePath, 'utf8')
  assert.ok(code.includes('__ModuleLoader__'))
  assert.ok(!/^\s*(?:import|export)\s/m.test(code))

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

  const sandbox: any = {
    window: {
      __ModuleLoader__: {
        load: (module: any) => {
          // RU: React приходит из таблицы модулей загрузчика; для регистрации
          //     слотов достаточно заглушки — компоненты ещё не рендерятся.
          // EN: React comes from the loader's module table; a stub is enough for
          //     slot registration because components are not rendered yet.
          const reactStub = { useRef: () => ({ current: null }), useEffect: () => undefined, createElement: () => ({}) }
          module.factory(() => reactStub).apply(ctx)
        },
      },
    },
    console,
    document: {
      createElement: () => ({ style: {}, appendChild: () => undefined, remove: () => undefined }),
      body: { appendChild: () => undefined },
    },
    navigator: { userAgent: 'node' },
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined,
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, value: {} }) }),
    EventSource: class {
      readyState = 0
      close() {}
    },
  }
  vm.runInNewContext(code, sandbox, { filename: 'client.js' })

  assert.equal(registrations.length, 4, 'expected main, sidebar, settings and settings icon registrations')
  const names = registrations.map((item) => item.options.name)
  assert.deepEqual(names, ['main', 'sidebar.panellist', 'settings.section', 'settings.section.icon'])
  assert.equal(registrations[0]?.options.key, 'genvideo')
  assert.equal(registrations[1]?.options.id, 'genvideo')
  assert.equal(registrations[1]?.options.order, 30)
  for (const registration of registrations) {
    assert.ok(registration.component, 'each slot must receive a component')
  }
})
