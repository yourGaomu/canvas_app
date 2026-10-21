# Changelog

## Unreleased

- [新增] 协作面板展示 Yjs 文档同步进度状态，连接与待同步更新期间显示动态进度条。
- [调整] 生产环境的协同 API 与 WebSocket 默认连接 B 机器的 `canvas-api.mikasa.wiki`。
- [文档] 新增多人画布协作后端正式规范，统一响应外壳、错误码、DTO、JWT、Hocuspocus、Yjs 持久化和 Nginx 部署约定。
- [新增] 增加 Yjs 多人画布接入、房间与成员入口，以及 Go 协作 API 契约。
- [修复] 共享画布仅在 Yjs 同步完成后开放编辑，断线期间保护画布，并为连接失败提供提示和重试。
- [修复] 只读协作者无法触发计费生成请求；在线成员状态按不可信 Awareness 数据校验。
