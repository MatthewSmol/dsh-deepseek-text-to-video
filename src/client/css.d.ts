/**
 * RU: Vite отдаёт содержимое CSS-файла строкой при импорте с суффиксом `?inline`.
 * EN: Vite returns the CSS file contents as a string for `?inline` imports.
 */
declare module '*.css?inline' {
  const css: string
  export default css
}
