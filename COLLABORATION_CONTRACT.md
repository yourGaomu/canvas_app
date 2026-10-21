# 画布协作服务接口契约

> 后端开发请以 [`COLLABORATION_BACKEND_SPEC.md`](./COLLABORATION_BACKEND_SPEC.md) 为准。本文件保留为移动端接入摘要，完整的统一响应格式、错误码、DTO、数据库和部署规范不再在此重复维护。

移动端的多人画布接入已预留为独立服务，不修改 New API。业务服务可以使用 Go；Yjs 实时同步仍由独立的 Hocuspocus WebSocket 进程提供。

## 配置

```env
VITE_COLLAB_API_URL=https://collab.example.com
VITE_COLLAB_API_PREFIX=/collab-api/v1
VITE_COLLAB_WS_URL=wss://collab.example.com/collab-ws
```

开发环境默认使用 `http://localhost:8080` 代理 `/collab-api`，WebSocket 默认连接 `ws://localhost:1234`。

## 认证约定

移动端在 HTTP 请求中发送当前 New API 登录令牌：

```http
Authorization: Bearer <new-api-access-token>
```

Go 服务负责验证用户身份，并为具体房间签发短期协作令牌。New API 的模型 Token 不参与画布协作，也不会写入协作文档。

Hocuspocus 的 `onAuthenticate` 使用协作令牌验证以下声明：

```json
{
  "sub": "new-api-user-id",
  "room_id": "room-uuid",
  "scope": "read-write",
  "exp": 1790000000
}
```

`scope` 只能是 `read-write` 或 `readonly`。WebSocket 的 `documentName` 就是房间 ID，服务端必须再次确认令牌中的 `room_id` 与文档名一致。

建议由 Go 使用私钥签发 JWT、Hocuspocus 使用公钥验签；签名密钥不得进入移动端构建产物。Awareness 中的 `user` 字段只用于界面展示，不得用作身份或权限判断。

## HTTP 接口

### 创建房间

```http
POST /collab-api/v1/rooms
Authorization: Bearer <new-api-access-token>
Content-Type: application/json
```

请求：

```json
{
  "client_project_id": "canvas-123",
  "title": "产品草图"
}
```

响应至少包含：

```json
{
  "room_id": "room-uuid",
  "title": "产品草图",
  "role": "owner"
}
```

### 查询房间

```http
GET /collab-api/v1/rooms/{room_id}
Authorization: Bearer <new-api-access-token>
```

响应至少包含 `room_id`、`title`、`role`。没有成员权限时返回 `403`。

### 获取房间协作令牌

```http
POST /collab-api/v1/rooms/{room_id}/session
Authorization: Bearer <new-api-access-token>
```

响应：

```json
{
  "room_id": "room-uuid",
  "role": "editor",
  "token": "short-lived-jwt"
}
```

### 邀请成员

```http
POST /collab-api/v1/rooms/{room_id}/members
Authorization: Bearer <new-api-access-token>
Content-Type: application/json
```

请求：

```json
{
  "username": "member-name",
  "role": "editor"
}
```

`role` 为 `editor` 或 `readonly`。只有房间所有者可以邀请成员。

## Yjs 文档结构

移动端使用以下顶层共享类型：

```text
meta          Y.Map
nodes         Y.Map<nodeId, Y.Map<node fields>>
connections   Y.Map<connectionId, Y.Map<connection fields>>
```

`nodes` 和 `connections` 使用独立记录同步。节点位置在拖动结束时写入 Yjs；拖动过程通过 Awareness 的 `drag` 字段广播临时位置，不写入数据库。

Hocuspocus 需要在加载/保存钩子中读取和持久化 Yjs 文档状态，房间元数据和成员权限由 Go 管理。PostgreSQL 可供两个服务分别使用各自的数据表。Awareness 拖动标记是提示性状态，不是强一致锁；两人几乎同时开始移动同一节点时，以 Yjs 合并后的最终位置为准。

客户端只有在收到 Hocuspocus 首轮 `synced` 事件后才允许写入共享画布；仅收到 WebSocket `connected` 不代表远端文档已加载。断线或重连期间客户端应暂时禁止编辑，重新 `synced` 后再恢复。只读成员不能写入画布或触发会消耗 New API 配额的生成请求。

```json
{
  "user": { "id": 12, "name": "张三" },
  "drag": {
    "nodeIds": ["image-1"],
    "positions": { "image-1": { "x": 0.42, "y": 0.31 } }
  }
}
```

## 素材限制

当前移动端素材仍保存在本机。协作文档只同步 `assetId`，因此第一批接入只能保证节点、连线、文本和位置同步；其他设备看到本地图片/视频节点时可能显示“素材不可用”。

要完整支持共享素材，Go 服务还需要提供对象存储的上传授权和素材元数据接口，下一阶段再接入。

## Nginx 路由

```nginx
location ^~ /collab-api/ {
    proxy_pass http://go_collab:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location ^~ /collab-ws {
    proxy_pass http://hocuspocus:1234;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

生产环境还需要为 Go API 配置允许的 Web/App Origin；WebSocket 服务应检查 `Origin` 并校验房间 JWT 和成员权限。
