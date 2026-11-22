---
layout: home

hero:
  name: Corvex
  text: 自托管 GitLab 持久对话代理
  tagline: 在运维台围绕代码持续对话——查看仓库、编辑文件、操作 Git，并在明确要求时写入 GitLab。
  actions:
    - theme: brand
      text: 快速开始
      link: /zh-CN/guide
    - theme: alt
      text: 在 GitHub 上查看
      link: https://github.com/axetroy/Corvex

features:
  - title: 持久化对话
    details: 对话绑定仓库分支与固定提交；每一轮的思考、工具调用和轨迹都完整留存，可随时回看。
  - title: 受控的写入边界
    details: 文件改动保存到会话 ref，Git push 只写 refs/conversations/<id>；GitLab 写入需要明确的用户意图。
  - title: 自行部署
    details: 单一 Server 进程（HTTP + 内联对话），SQLite 持久化，GitLab OAuth2 登录，可用 Docker Compose 部署。
---
