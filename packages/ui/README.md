# 共享界面组件（@shiling/ui）

此包导出 v0.2 界面的语义设计 token 与字节/时间展示工具。它不依赖 Vue，当前不包含业务页面、数据请求、权限规则或演示数据；Vue 展示组件位于 `apps/web/src/components`。

UI 包不能依赖 backend、media、数据库、存储 SDK 或服务端配置；业务请求编排留在应用功能模块，不把权限判断或领域规则藏在展示组件中。消费者通过公开导出使用 `themeTokens`、`formatBytes` 与 `formatDate`。

TypeScript 构建输出 `dist` 目录与类型声明。若后续将 Vue 组件迁入此包，应同时补齐编译配置与对等依赖（`peerDependencies`）；当前 `tsc` 配置不用于编译 `.vue` 文件。
