export type DocsLocale = 'en' | 'zh-CN'

export function getPreferredLocale(languages: readonly string[]): DocsLocale {
  for (const language of languages) {
    if (/^zh(?:-|$)/i.test(language)) return 'zh-CN'
    if (/^en(?:-|$)/i.test(language)) return 'en'
  }

  return 'en'
}
