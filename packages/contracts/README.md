# 共享接口合同（@shiling/contracts）

前后端共享的 TypeBox 请求、响应与错误合同。公开入口提供 `common`、`permissions`、`identity`、`uploads`、`assets`、`library`、`public`、`admin` 对应的 schema 和类型；固定能力目录为 26 项。

合同区分团队与公开投影。`PublicAssetSchema` 不包含成员身份、原始文件名或内部标签 ID；`UploadUiStateSchema` 不包含仅属于浏览器交互的 `cancelling`。公共合同保持浏览器安全，不导入 backend、Node 专用库、数据库类型、存储 SDK 或服务端密钥。请求/响应合同不是直接序列化数据库对象的许可。

跨包只使用公开入口并显式声明工作区依赖；TypeScript 构建输出 `dist` 目录与类型声明。
