/**
 * RU: Мост DSH → Vue. Слоты DSH рендерятся React-ом, поэтому клиентский модуль
 *     держит крошечный React-компонент, который монтирует Vue-приложение
 *     `GenVideoPanel` в свой div. Весь UI, состояние и i18n — Vue 3.
 * EN: DSH → Vue bridge. DSH slots are rendered by React, so the client module
 *     keeps a tiny React component that mounts the Vue `GenVideoPanel` app into
 *     its div. All UI, state and i18n live in Vue 3.
 */
import { createApp, h } from 'vue'
import { GenVideoPanel } from './vue/panel.js'

const NS = 'genvideo'
const PANEL_ID = 'genvideo'

/** RU: Клиентский модуль для загрузчика DSH. EN: Client module for the DSH loader. */
;(window as any).__ModuleLoader__.load({
  id: '@local/dsh-genvideo',
  factory(require: (id: string) => any) {
    const React = require('react')

    /**
     * RU: Монтирует Vue-приложение один раз и снимает его при размонтировании
     *     React-компонента. Пропсы слота передаются в Vue как обычный объект.
     * EN: Mounts the Vue app once and unmounts it when the React component is
     *     removed. Slot props are passed to Vue as a plain object.
     */
    function VueHost(props: any) {
      const container = React.useRef(null)
      React.useEffect(() => {
        if (!container.current) return undefined
        const app = createApp({ render: () => h(GenVideoPanel, { ...props }) })
        app.mount(container.current)
        return () => app.unmount()
      }, [])
      return React.createElement('div', { ref: container, class: 'genvideo-host' })
    }

    // RU: main и settings используют один Vue-компонент с разным surface.
    // EN: main and settings share one Vue component with a different surface.
    const MainPanel = (props: any) => React.createElement(VueHost, { ...props, surface: 'main' })
    const SettingsPanel = (props: any) => React.createElement(VueHost, { ...props, surface: 'settings' })
    const PanelIcon = (props: any) => {
      const size = props?.size ?? 16
      const active = Boolean(props?.active)
      return React.createElement(
        'svg',
        {
          viewBox: '0 0 64 64', width: size, height: size, 'aria-hidden': true,
          style: { display: 'block', color: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor' },
        },
        React.createElement('rect', { x: 4, y: 6, width: 56, height: 52, rx: 10, fill: 'none', stroke: 'currentColor', strokeWidth: 4 }),
        React.createElement('path', { d: 'M27 23.5v17a1.5 1.5 0 0 0 2.3 1.3l13.4-8.5a1.5 1.5 0 0 0 0-2.6L29.3 22.2A1.5 1.5 0 0 0 27 23.5Z', fill: '#e5484d' }),
      )
    }

    /** RU: Регистрация слотов плагина. EN: Plugin slot registration. */
    function apply(ctx: any) {
      ctx.effect?.(() => ctx.locale.register(NS, { en: { nav: 'GenVideo' }, ru: { nav: 'GenVideo' } }), 'genvideo: locale namespace')
      const bound = ctx.locale?.bind?.(NS)
      const label = () => (typeof bound === 'function' ? bound('nav') : 'GenVideo') || 'GenVideo'

      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, MainPanel))
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 30, label, locale: NS }, PanelIcon))
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register({ name: 'settings.section', id: PANEL_ID, order: 60, label, locale: NS }, SettingsPanel))
      ctx.slots.inject('settings.section.icon', () =>
        ctx.slots.register({ name: 'settings.section.icon', id: PANEL_ID, locale: NS }, PanelIcon))
    }

    return { apply, inject: ['slots', 'locale'] }
  },
})
