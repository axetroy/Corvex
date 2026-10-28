import DefaultTheme from 'vitepress/theme'
import { getPreferredLocale } from './language'

export default {
  extends: DefaultTheme,
  enhanceApp() {
    if (typeof window === 'undefined') return

    const languages = window.navigator.languages.length
      ? window.navigator.languages
      : [window.navigator.language]
    if (getPreferredLocale(languages) !== 'zh-CN') return

    const basePath = new URL(import.meta.env.BASE_URL, window.location.origin).pathname
    const currentPath = window.location.pathname
    if (currentPath !== basePath && currentPath !== basePath.replace(/\/$/, '')) return

    const localizedUrl = new URL(`${basePath}zh-CN/`, window.location.origin)
    localizedUrl.search = window.location.search
    localizedUrl.hash = window.location.hash
    window.location.replace(localizedUrl.href)
  },
}
