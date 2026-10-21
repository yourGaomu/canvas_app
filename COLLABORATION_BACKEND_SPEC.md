# Infinite Canvas 协作后端规范

本文档是 Infinite Canvas 多人画布 Go 协作服务的唯一后端实现依据。

它参考 `D:\Go_All\TokenSpend\BACKEND_SPEC.md` 的工程化约定，但只负责画布协作领域，不负责 NewAPI 的账户、模型、额度和生成接口。NewAPI 仍由移动端按现有方式直接使用；协作服务只使用 NewAPI 的登录令牌识别用户，并管理房间、成员权限和 Yjs 文档。

## 1. 服务边界

```text
移动端
  ├─ https://mikasa.icu/v1/*       -> NewAPI：模型、图片、视频、文本和计费
  ├─ https://canvas-api.mikasa.wiki/collab-api/* -> B：Go 房间、成员、协作 JWT
  └─ wss://canvas-api.mikasa.wiki/collab-ws      -> B：Hocuspocus Yjs 实时同步

Go 协作 API
  ├─ 向 A 的 NewAPI 用户信息接口验证 Bearer Token
  ├─ 管理房间和成员权限
  ├─ 签发短期协作 JWT
  └─ 不保存 NewAPI access token 或模型 API Key

Hocuspocus
  ├─ 验证 Go 签发的协作 JWT
  ├─ 校验 documentName 与 room_id
  ├─ 拒绝 readonly 用户的 Yjs 更新
  └─ 读写 PostgreSQL 中的 Yjs 文档状态
```

Go 服务和 Hocuspocus 可以共用 PostgreSQL，但必须使用各自的表和迁移。Go 服务不修改 NewAPI 源码。

## 2. 版本、地址与通用约定

### 2.1 地址

生产环境：

```text
HTTP API:  https://canvas-api.mikasa.wiki/collab-api/v1
WebSocket: wss://canvas-api.mikasa.wiki/collab-ws
```

开发环境：

```text
HTTP API:  http://localhost:8080/collab-api/v1
WebSocket: ws://localhost:1234
```

客户端配置：

```env
VITE_COLLAB_API_URL=https://canvas-api.mikasa.wiki
VITE_COLLAB_API_PREFIX=/collab-api/v1
VITE_COLLAB_WS_URL=wss://canvas-api.mikasa.wiki/collab-ws
```

### 2.2 HTTP 约定

- 所有接口使用 `Content-Type: application/json; charset=utf-8`。
- 所有接口返回 UTF-8 JSON；不得返回 HTML 错误页。
- 时间统一使用 RFC 3339 UTC，例如 `2026-10-20T03:30:00Z`。
- ID 使用小写 UUID 字符串；不得将数据库自增整数 ID 暴露为房间或成员公开 ID。
- JSON 字段统一使用 `snake_case`；Go DTO 必须显式声明 `json` tag。
- 未提供的可选字段使用 `null` 或省略，具体以 DTO 定义为准；同一个字段不得在不同接口中混用字符串、数字和对象类型。
- 用户输入必须在服务端校验和 trim；不能信任客户端的角色、用户 ID、Awareness 用户字段。

### 2.3 认证请求头

HTTP API 使用当前 NewAPI 登录令牌：

```http
Authorization: Bearer <new-api-access-token>
X-Request-ID: <optional-client-request-id>
```

`X-Request-ID` 可由客户端提供合法的 1 至 64 字符标识；未提供时由 Go 服务生成。响应中的 `request_id` 必须始终存在。

## 3. 统一响应格式

所有 HTTP API（包括成功和失败）必须使用同一个响应外壳：

```json
{
  "code": 200,
  "message": "success",
  "data": {},
  "request_id": "req_01J9Z5W5B6K4H9R9NQ5V2Q8M3P"
}
```

字段定义：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `code` | `integer` | 是 | 成功为 `200`；失败使用本文档定义的稳定业务错误码 |
| `message` | `string` | 是 | 面向用户或日志的中文短消息；不得包含 Token、密码或内部堆栈 |
| `data` | `object \| array \| null` | 是 | 成功载荷；失败固定为 `null` |
| `request_id` | `string` | 是 | 服务端请求追踪 ID |

成功响应的 HTTP 状态码和 `code` 必须一致。当前版本所有成功业务接口使用 `200`，创建房间也不使用裸 `201`，以保持移动端和 TokenSpend 风格一致。

成功示例：

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "room_id": "8c3b0f2d-7af3-4d5f-bc31-1a5f10f98f08",
    "title": "产品草图",
    "role": "owner"
  },
  "request_id": "req_01J9Z5W5B6K4H9R9NQ5V2Q8M3P"
}
```

失败示例：

```json
{
  "code": 40301,
  "message": "你没有邀请成员的权限",
  "data": null,
  "request_id": "req_01J9Z5W5B6K4H9R9NQ5V2Q8M3P"
}
```

移动端 `apiRequest` 会自动取出成功响应的 `data`。Go 服务不能返回只有 `data` 的裸对象，也不能把错误写成 HTML、纯文本或另一种 `error` 结构。

## 4. 错误码与处理规则

错误码必须稳定，客户端只根据 `code` 做分支，`message` 只作为展示文本。服务端日志必须记录 `request_id`、HTTP 路径、用户 ID 和错误码。

| HTTP | `code` | 标识 | 说明 |
| ---: | ---: | --- | --- |
| 400 | 40001 | `invalid_request` | JSON 无法解析或请求结构错误 |
| 400 | 40002 | `validation_failed` | 字段缺失、长度或格式不合法 |
| 401 | 40101 | `unauthorized` | 缺少、过期或无效的 NewAPI Bearer Token |
| 403 | 40301 | `forbidden` | 当前用户没有房间或成员操作权限 |
| 404 | 40401 | `room_not_found` | 房间不存在或已被删除 |
| 404 | 40402 | `member_not_found` | 目标用户或成员不存在 |
| 409 | 40901 | `room_already_exists` | 相同客户端项目已经绑定共享房间 |
| 409 | 40902 | `member_already_exists` | 目标用户已经是房间成员 |
| 409 | 40903 | `owner_operation_forbidden` | 不能删除房主或把房主改成普通角色 |
| 422 | 42201 | `unsupported_role` | 角色不是 `editor` 或 `readonly` |
| 429 | 42901 | `rate_limited` | 请求频率超过限制 |
| 502 | 50201 | `newapi_unavailable` | 无法向 NewAPI 验证用户或查找成员 |
| 503 | 50301 | `storage_unavailable` | PostgreSQL 或 Yjs 存储暂不可用 |
| 500 | 50001 | `internal_error` | 未分类的服务端错误 |

除调试环境外，`message` 不得泄露 SQL、JWT 签名、上游响应原文或堆栈。

## 5. DTO 规范

### 5.1 Go 目录和命名

建议 Go 项目按下面结构组织：

```text
internal/
  dto/          # 请求、响应 DTO；只放 JSON 边界结构
  model/        # GORM/数据库模型；不直接作为 API 响应
  handler/      # HTTP 参数解析、鉴权和响应包装
  service/      # 房间、成员、JWT 业务逻辑
  repository/   # PostgreSQL 查询和事务
  auth/         # NewAPI Token 校验、协作 JWT
```

DTO 不得直接复用 GORM model。所有对外字段必须通过 DTO 显式暴露，敏感字段必须使用 `json:"-"` 或不定义在响应 DTO 中。

### 5.2 基础枚举

```go
type CollaborationRole string

const (
    RoleOwner    CollaborationRole = "owner"
    RoleEditor   CollaborationRole = "editor"
    RoleReadonly CollaborationRole = "readonly"
)

type CollaborationScope string

const (
    ScopeReadWrite CollaborationScope = "read-write"
    ScopeReadonly  CollaborationScope = "readonly"
)
```

角色和 scope 的关系：

| 房间角色 | JWT `scope` | 是否可以写 Yjs | 是否可以触发生成 |
| --- | --- | ---: | ---: |
| `owner` | `read-write` | 是 | 客户端开放 |
| `editor` | `read-write` | 是 | 客户端开放 |
| `readonly` | `readonly` | 否 | 客户端禁用 |

最后一列是当前 App 的交互策略，不是协作服务端对 NewAPI 的强制限制。NewAPI 生图/视频仍由 App 使用用户自己的 NewAPI Token 直连；只读用户理论上仍可绕过 App 直接请求 NewAPI。若以后要求服务端强制限制生成，必须另建能够校验协作角色的生成代理，超出当前协作服务范围。

### 5.3 统一响应 DTO

```go
type APIResponse[T any] struct {
    Code      int    `json:"code"`
    Message   string `json:"message"`
    Data      T      `json:"data"`
    RequestID string `json:"request_id"`
}

type APIErrorResponse = APIResponse[any] // Data 必须为 nil
```

推荐统一使用：

```go
func Success[T any](requestID string, data T) APIResponse[T] {
    return APIResponse[T]{Code: 200, Message: "success", Data: data, RequestID: requestID}
}

func Failure(requestID string, code int, message string) APIErrorResponse {
    return APIErrorResponse{Code: code, Message: message, Data: nil, RequestID: requestID}
}
```

### 5.4 房间 DTO

```go
type CreateRoomRequest struct {
    ClientProjectID string `json:"client_project_id" binding:"required,max=128"`
    Title           string `json:"title" binding:"required,max=120"`
}

type RoomResponse struct {
    RoomID          string             `json:"room_id"`
    ClientProjectID string             `json:"client_project_id"`
    Title           string             `json:"title"`
    Role            CollaborationRole  `json:"role"`
    Owner           PublicUserResponse `json:"owner"`
    CreatedAt       string             `json:"created_at"`
    UpdatedAt       string             `json:"updated_at"`
}

type PublicUserResponse struct {
    UserID      string `json:"user_id"`
    Username    string `json:"username"`
    DisplayName string `json:"display_name"`
}
```

创建房间时客户端只发送 `client_project_id` 和 `title`。`owner`、时间和角色全部由服务端生成，禁止客户端传入。

### 5.5 成员 DTO

```go
type AddMemberRequest struct {
    Username string            `json:"username" binding:"required,max=128"`
    Role     CollaborationRole `json:"role" binding:"required"`
}

type MemberResponse struct {
    MemberID    string            `json:"member_id"`
    UserID      *string           `json:"user_id"`
    Username    string            `json:"username"`
    DisplayName string            `json:"display_name"`
    Status      MemberStatus      `json:"status"`
    Role        CollaborationRole `json:"role"`
    CreatedAt   string            `json:"created_at"`
    UpdatedAt   string            `json:"updated_at"`
}

type MemberStatus string

const (
    MemberInvited MemberStatus = "invited"
    MemberActive  MemberStatus = "active"
)

type RoomMembersResponse struct {
    RoomID  string           `json:"room_id"`
    Members []MemberResponse `json:"members"`
}
```

约束：

- `AddMemberRequest.role` 只能是 `editor` 或 `readonly`。
- 不能邀请当前房主为普通成员。
- 同一房间同一规范化用户名只能有一条成员记录。
- 成员查询返回 `user_id`、`username`、`display_name`、`status`，不得返回 NewAPI Token、密码或 Cookie。
- `user_id` 尚未绑定时 JSON 返回 `null`，状态为 `invited`；用户用自己的 NewAPI 登录令牌首次获取 session 后，Go 服务将其绑定并置为 `active`。

### 5.6 协作会话 DTO

```go
type CollaborationSessionResponse struct {
    RoomID    string             `json:"room_id"`
    Role      CollaborationRole  `json:"role"`
    Scope     CollaborationScope `json:"scope"`
    Token     string             `json:"token"`
    ExpiresIn int                `json:"expires_in"`
    ExpiresAt string             `json:"expires_at"`
    WebSocketURL string          `json:"websocket_url"`
}
```

`token` 是短期协作 JWT，只能用于指定房间的 WebSocket 连接。推荐有效期 5 至 15 分钟；不得把 NewAPI access token 直接作为 WebSocket token 返回。

## 6. HTTP 接口

所有下列接口都必须返回第 3 节的统一响应包装。

### 6.1 创建房间

```http
POST /collab-api/v1/rooms
Authorization: Bearer <new-api-access-token>
Content-Type: application/json
```

请求 DTO：`CreateRoomRequest`

```json
{
  "client_project_id": "canvas-123",
  "title": "产品草图"
}
```

成功响应 `data`：`RoomResponse`

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "room_id": "8c3b0f2d-7af3-4d5f-bc31-1a5f10f98f08",
    "client_project_id": "canvas-123",
    "title": "产品草图",
    "role": "owner",
    "owner": {
      "user_id": "12",
      "username": "alice",
      "display_name": "Alice"
    },
    "created_at": "2026-10-20T03:30:00Z",
    "updated_at": "2026-10-20T03:30:00Z"
  },
  "request_id": "req_..."
}
```

### 6.2 查询房间

```http
GET /collab-api/v1/rooms/{room_id}
Authorization: Bearer <new-api-access-token>
```

返回 `RoomResponse`。用户不是房主或成员时返回 `40301`；存在匹配当前已验证 NewAPI 用户名的 `invited` 成员时，允许读取房间信息，以便当前客户端完成加入流程；不存在的房间返回 `40401`。不能通过错误信息泄露房间是否存在给无权限用户，生产环境可以将两者统一为 `40401`。

### 6.3 获取房间成员

```http
GET /collab-api/v1/rooms/{room_id}/members
Authorization: Bearer <new-api-access-token>
```

返回 `RoomMembersResponse`。所有已加入房间成员可以查看成员列表，只有房主可以修改成员；列表同时包含 `invited` 和 `active` 状态。

### 6.4 邀请成员

```http
POST /collab-api/v1/rooms/{room_id}/members
Authorization: Bearer <new-api-access-token>
Content-Type: application/json
```

请求 DTO：`AddMemberRequest`

```json
{
  "username": "bob",
  "role": "editor"
}
```

成功响应 `data`：`MemberResponse`。只有 `owner` 可以调用。该接口按用户名创建 `invited` 状态的成员，不要求 Go 服务使用 NewAPI 管理员凭据搜索其他用户；目标用户的 `user_id` 在其使用自己的 NewAPI 登录令牌获取房间 session 时绑定。不能接受客户端传入的 `user_id`。

### 6.5 获取协作会话 JWT

```http
POST /collab-api/v1/rooms/{room_id}/session
Authorization: Bearer <new-api-access-token>
```

请求体为空。成功响应 `data`：`CollaborationSessionResponse`。

服务端处理顺序：

1. 先用当前 NewAPI Token 得到已验证用户。
2. 查询房主、`active` 成员和当前用户名匹配的 `invited` 成员。
3. 如果匹配到 `invited` 成员，使用事务将其绑定到当前 `user_id`、保存当前展示名并更新为 `active`；如果该房间已有其他成员占用这个 `user_id`，返回 `40902`。
4. 只有绑定成功或已有权限的用户才能签发 JWT。

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "room_id": "8c3b0f2d-7af3-4d5f-bc31-1a5f10f98f08",
    "role": "editor",
    "scope": "read-write",
    "token": "eyJhbGciOiJSUzI1NiIs...",
    "expires_in": 900,
    "expires_at": "2026-10-20T03:45:00Z",
    "websocket_url": "wss://canvas-api.mikasa.wiki/collab-ws"
  },
  "request_id": "req_..."
}
```

### 6.6 删除成员

```http
DELETE /collab-api/v1/rooms/{room_id}/members/{member_id}
Authorization: Bearer <new-api-access-token>
```

只有房主可以调用。不能删除房主，成功时 `data` 为 `null`，返回 `code: 200`。

### 6.7 删除房间

```http
DELETE /collab-api/v1/rooms/{room_id}
Authorization: Bearer <new-api-access-token>
```

只有房主可以调用。服务端必须在一个事务中标记房间不可用、删除成员关系，并安排 Yjs 文档清理；不能在 HTTP 请求中无保护地直接删除仍有 WebSocket 连接的文档。

## 7. NewAPI 身份校验

Go 服务收到 HTTP 请求后必须：

1. 读取 `Authorization: Bearer <token>`，缺失或格式不正确返回 `40101`。
2. 使用服务端配置的 NewAPI 地址调用用户身份接口，验证 Token 有效性。
3. 从 NewAPI 身份响应中提取 `user_id`、`username`、`display_name`，生成内部 `AuthenticatedUser`；内部 `user_id` 统一转成字符串，用户名 trim 并 Unicode 小写化后用于邀请匹配。
4. 不把 NewAPI Token 写入 PostgreSQL、日志、协作 JWT 或 Yjs 文档。
5. NewAPI 身份接口超时或不可用返回 `50201`，不能误判为普通权限错误。

推荐配置：

```env
NEW_API_BASE_URL=https://mikasa.icu
NEW_API_USERINFO_PATH=/api/user/self
NEW_API_TIMEOUT=10s
COLLAB_JWT_PRIVATE_KEY_FILE=/run/secrets/collab-jwt-private.pem
COLLAB_JWT_PUBLIC_KEY_FILE=/run/secrets/collab-jwt-public.pem
COLLAB_JWT_ISSUER=infinite-canvas-collaboration
COLLAB_SESSION_TTL=15m
COLLAB_ALLOWED_ORIGINS=https://mikasa.icu,capacitor://localhost,http://localhost:4173
```

NewAPI 的具体用户信息响应可能存在包装差异，适配逻辑必须集中在 `auth/newapi`，不得让 handler 到处解析上游 JSON。

## 8. 协作 JWT

### 8.1 必填声明

Go 使用 RSA/ECDSA 非对称签名生成 JWT；私钥只在 Go 服务，Hocuspocus只持有公钥。

```json
{
  "iss": "infinite-canvas-collaboration",
  "sub": "12",
  "room_id": "8c3b0f2d-7af3-4d5f-bc31-1a5f10f98f08",
  "role": "editor",
  "scope": "read-write",
  "iat": 1792467000,
  "exp": 1792467900,
  "jti": "session-uuid"
}
```

声明约束：

- `iss` 必须等于服务端配置值。
- `sub` 必须是已通过 NewAPI 校验的用户 ID。
- `room_id` 必须是 UUID，并且必须与 WebSocket 的 `documentName` 完全相等。
- `role` 只能是 `owner`、`editor`、`readonly`。
- `scope` 只能是 `read-write`、`readonly`，并且必须与 `role` 的映射一致。
- `exp` 必须存在且不能超过服务端当前时间加配置的最大 TTL。
- Hocuspocus 必须拒绝算法为 `none`、使用错误 key 或缺少任一必填声明的 Token。

## 9. Hocuspocus WebSocket 规范

### 9.1 连接

客户端使用：

```text
wss://canvas-api.mikasa.wiki/collab-ws
documentName = room_id
token = Go /session 接口返回的协作 JWT
```

Hocuspocus 必须在认证钩子中完成：

1. 验证 JWT 签名、issuer、有效期和必填声明。
2. 检查 `documentName === token.room_id`。
3. 检查房间仍处于 active 状态。
4. 通过 Go 服务或共享只读数据库确认成员权限；不能只信任 JWT 中旧的角色。
5. 将经过服务端确认的用户和角色放入连接上下文。

### 9.2 只读保护

`readonly` 用户可以接收文档和 Awareness 更新，但：

- 不得提交 Yjs 文档更新。
- 不得修改房间标题、节点、连线或位置。
- 客户端在只读共享画布内必须禁用图片、视频、文本生成入口。
- 服务端拒绝写入，而不是只在前端禁用按钮。

协作服务无法拦截用户直接调用 NewAPI；此限制由当前客户端执行，不能作为防止用户消耗其自身 NewAPI 额度的服务端安全保证。

连接、同步和拒绝原因必须记录 `request_id` 或 WebSocket connection ID、room ID、user ID、role；不得记录 Token 原文。

### 9.3 Yjs 文档结构

顶层共享类型必须保持稳定：

```text
meta          Y.Map
nodes         Y.Map<nodeId, Y.Map<node fields>>
connections   Y.Map<connectionId, Y.Map<connection fields>>
```

`meta` 至少包含：

```text
schemaVersion: number
initialized: boolean
title: string
updatedAt: number
```

节点和连线按独立记录同步。节点拖动过程写入 Awareness 的 `drag` 字段，拖动结束后才把正式位置写入 Yjs；Awareness 不作为锁，也不作为最终数据来源。

当前协作版本只保证同步节点、连线、文字、位置和 `asset_id`。图片、视频本体仍在用户设备本地，其他设备可能显示“素材不可用”。

Awareness 展示数据格式：

```json
{
  "user": {
    "id": 12,
    "name": "张三"
  },
  "drag": {
    "node_ids": ["image-1"],
    "positions": {
      "image-1": { "x": 0.42, "y": 0.31 }
    }
  }
}
```

Awareness 中的 `user` 仅用于显示。服务端权限判断必须使用连接上下文中的 JWT 和数据库成员记录。

## 10. PostgreSQL 数据模型

以下是逻辑模型；字段名和约束应保持一致，数据库实现可以使用 GORM 或手写 SQL。

### 10.1 `collab_rooms`

```sql
CREATE TABLE collab_rooms (
    id uuid PRIMARY KEY,
    client_project_id varchar(128) NOT NULL,
    title varchar(120) NOT NULL,
    owner_user_id varchar(128) NOT NULL,
    status varchar(16) NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT collab_rooms_status_check CHECK (status IN ('active', 'deleted')),
    CONSTRAINT collab_rooms_project_unique UNIQUE (owner_user_id, client_project_id)
);
```

### 10.2 `collab_room_members`

```sql
CREATE TABLE collab_room_members (
    id uuid PRIMARY KEY,
    room_id uuid NOT NULL REFERENCES collab_rooms(id) ON DELETE CASCADE,
    user_id varchar(128),
    username varchar(128) NOT NULL,
    username_normalized varchar(128) NOT NULL,
    display_name varchar(128) NOT NULL DEFAULT '',
    role varchar(16) NOT NULL,
    status varchar(16) NOT NULL DEFAULT 'invited',
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT collab_members_role_check CHECK (role IN ('owner', 'editor', 'readonly')),
    CONSTRAINT collab_members_status_check CHECK (status IN ('invited', 'active')),
    CONSTRAINT collab_members_username_unique UNIQUE (room_id, username_normalized)
);

CREATE UNIQUE INDEX collab_members_user_unique
    ON collab_room_members (room_id, user_id)
    WHERE user_id IS NOT NULL;
```

房主必须同时有一条 `owner`、`active` 成员记录，创建房间和房主成员记录必须在同一事务中完成。邀请记录可先只有 `username_normalized`；用户首次成功获取 session 时，必须在事务中检查用户名与 `user_id` 是否冲突，再绑定 `user_id` 并更新为 `active`。已绑定到其他用户 ID 的邀请不得被同名用户接管。

### 10.3 `collab_yjs_documents`

```sql
CREATE TABLE collab_yjs_documents (
    room_id uuid PRIMARY KEY REFERENCES collab_rooms(id) ON DELETE CASCADE,
    state bytea NOT NULL,
    version bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL
);
```

Yjs 状态必须以二进制保存，不能把 Yjs 更新当作 JSON 文本拼接。写入时使用事务或版本控制，避免两个 Hocuspocus 实例同时覆盖文档。

## 11. Nginx 与生产组网

Go 和 Hocuspocus 不直接暴露公网端口，只加入与 Nginx 相同的 Docker 网络。Nginx 示例：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl http2;
    server_name mikasa.icu;

    # 证书配置按现有站点配置保留

    location ^~ /collab-api/ {
        proxy_pass http://go_collab:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
        proxy_send_timeout 30s;
    }

    location ^~ /collab-ws {
        proxy_pass http://hocuspocus:1234;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

生产检查项：

- 只允许 HTTPS；HTTP 统一重定向。
- `/collab-api/` 和 `/collab-ws` 必须返回 JSON 或 WebSocket，不得被 Cloudflare challenge 页面替换。
- WebSocket 必须配置 HTTP/1.1 Upgrade。
- Go 服务校验 `Origin`，允许列表来自 `COLLAB_ALLOWED_ORIGINS`，不能使用任意 `*`。
- Nginx、Go、Hocuspocus 日志不得记录 Authorization、协作 JWT 或提示词正文。
- PostgreSQL 不开放公网端口，数据库密码通过 Docker secret 或环境注入。

## 12. 客户端兼容要求

当前移动端已经调用：

```text
POST /collab-api/v1/rooms
GET  /collab-api/v1/rooms/{room_id}
POST /collab-api/v1/rooms/{room_id}/session
POST /collab-api/v1/rooms/{room_id}/members
```

服务端至少先实现以上四个接口。客户端读取的关键字段是：

```text
rooms: data.room_id, data.title, data.role
session: data.room_id, data.role, data.token
```

实现新增的成员查询、删除房间和删除成员接口后，不需要修改现有客户端即可兼容。`data` 外层必须存在，字段必须使用 snake_case；客户端对 `roomId`、`collaboration_token` 的兼容解析只用于历史开发版本，正式 Go 服务不得依赖这些别名。

## 13. 实现顺序与验收标准

### 第一阶段：Go HTTP API

1. 初始化 Go 服务、配置加载、结构化日志和 PostgreSQL 迁移。
2. 实现 NewAPI Bearer Token 校验和 `AuthenticatedUser`。
3. 实现统一响应中间件、错误码和 request ID。
4. 实现创建房间、查询房间、创建 session、邀请成员。
5. 用 `curl` 验证所有成功和错误响应都符合本规范。

### 第二阶段：Hocuspocus

1. 使用公钥校验协作 JWT。
2. 校验 `room_id`、`documentName`、角色和房间状态。
3. 加载和保存 `collab_yjs_documents`。
4. 拒绝 readonly 写入，验证 owner/editor 可以同步。
5. 通过 Nginx 验证断线重连和多实例连接。

### 第三阶段：双设备联调

- A 用户创建房间，B 用户被邀请并加入。
- 节点、连线、标题和正式位置可以双向同步。
- 拖动过程能看到 Awareness 临时位置，松手后最终位置一致。
- readonly 用户只能查看，不能拖动、撤销、重做或触发生成。
- 断网重连后等待 `synced` 才恢复编辑。
- 图片和视频节点明确显示本地素材不可用，不伪造远端素材。

## 14. 不在本阶段实现的内容

- 不修改 NewAPI 源码。
- 不把 NewAPI 模型 Token 当作协作 Token。
- 不把图片、视频本体写入 Yjs。
- 不在没有对象存储和素材元数据接口的情况下承诺跨设备共享素材。
- 不使用客户端传入的 user、role 或权限字段替代服务端鉴权。
