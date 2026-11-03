---
layout: home

hero:
  name: Corvex
  text: GitLab 代码审查与 Issue 实现代理
  tagline: 自托管异步审查、受限修复，以及可选的 Issue Draft MR。
  actions:
    - theme: brand
      text: 快速开始
      link: /zh-CN/guide
    - theme: alt
      text: 在 GitHub 上查看
      link: https://github.com/axetroy/Corvex

features:
  - title: 审查合并请求
    details: 从 GitLab 评论创建审查任务，并以行级讨论的形式发布经过验证的问题。
  - title: 保留变更控制权
    details: 修复提案供人工应用；Issue 实现会创建 Draft MR，绝不自动合并。
  - title: 自行部署
    details: 使用 Docker Compose 部署服务端和可选 Worker，并由 SQLite 提供持久化存储。
---
