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
          { text: 'Architecture', link: '/architecture' },
          { text: 'Configuration', link: '/configuration' },
          { text: 'Operations', link: '/operations' },
        ],
        sidebar: [
          {
            text: 'Documentation',
            items: [
              { text: 'Getting started', link: '/guide' },
              { text: 'Architecture and workflow', link: '/architecture' },
              { text: 'Configuration reference', link: '/configuration' },
              { text: 'Runtime and operations', link: '/operations' },
            ],
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
          { text: '架构与流程', link: '/zh-CN/architecture' },
          { text: '配置参考', link: '/zh-CN/configuration' },
          { text: '运行与运维', link: '/zh-CN/operations' },
        ],
        sidebar: [
          {
            text: '文档',
            items: [
              { text: '快速开始', link: '/zh-CN/guide' },
              { text: '架构与工作流程', link: '/zh-CN/architecture' },
              { text: '配置参考', link: '/zh-CN/configuration' },
              { text: '运行环境与运维', link: '/zh-CN/operations' },
            ],
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
