import { defineConfig } from 'vitepress'

export default defineConfig({
  base: '/Corvex/',
  cleanUrls: true,
  locales: {
    root: {
      label: 'English',
      lang: 'en-US',
      title: 'Corvex',
      description: 'A self-hosted GitLab code review and repair agent',
      themeConfig: {
        nav: [
          { text: 'Home', link: '/' },
          { text: 'Guide', link: '/guide' },
        ],
        sidebar: [
          {
            text: 'Guide',
            items: [{ text: 'Getting started', link: '/guide' }],
          },
        ],
      },
    },
    'zh-CN': {
      label: '简体中文',
      lang: 'zh-CN',
      title: 'Corvex',
      description: '面向自托管 GitLab 的代码审查与修复代理',
      themeConfig: {
        nav: [
          { text: '首页', link: '/zh-CN/' },
          { text: '使用指南', link: '/zh-CN/guide' },
        ],
        sidebar: [
          {
            text: '使用指南',
            items: [{ text: '快速开始', link: '/zh-CN/guide' }],
          },
        ],
      },
    },
  },
  themeConfig: {
    siteTitle: 'Corvex',
    search: {
      provider: 'local',
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/axetroy/Corvex' },
    ],
  },
})
