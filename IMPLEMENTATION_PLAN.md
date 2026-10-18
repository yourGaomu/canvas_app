# Infinite Canvas 移动端 App 实施方案

> 本文件是移动端 App 的实施记录与边界说明。当前工程已完成第一版可运行前台、API 客户端和本地素材工作流，原生真机验收仍需在目标设备上进行。

## 1. 目标与边界

在独立 Git 仓库 `canvas_app` 中实现可安装到 Android/iOS 的 Infinite Canvas 前台 App；本地工程目录为仓库根目录。

App 的固定 API 站点为：

```text
https://mikasa.icu
```

App 只负责：

- 移动端界面、导航和交互；
- 注册、登录、二次验证和退出登录；
- 获取用户模型、额度和 Token 状态；
- 调用 New API 的文本、图片、图片编辑和视频接口；
- 在本地保存画布、素材和生成记录。

App 不负责：

- 上游 OpenAI、Gemini、视频平台的直接调用；
- 渠道选择、计费、重试、模型路由和上游 API Key 管理；
- 新增任何 New API 后端接口；
- 在服务器保存用户画布和素材。

所有模型请求都发送到 `https://mikasa.icu`，由 New API 根据已配置的渠道和模型完成后续转发。

## 2. 关键安全约束

New API 文档中的标准 AI 接口使用：

```http
Authorization: Bearer <New API 用户 Token>
```

例如：

```text
GET  https://mikasa.icu/v1/models
POST https://mikasa.icu/v1/images/generations
POST https://mikasa.icu/v1/images/edits
POST https://mikasa.icu/v1/videos
POST https://mikasa.icu/v1/chat/completions
```

登录接口返回的 Dashboard `access_token` 不能直接替代 `/v1` 所需的 API Token。因此，在“不增加后端代理”的前提下，App 必须执行以下流程：

1. 使用 New API 登录接口取得用户登录 `access_token`。
2. 调用用户 Token 接口，查找或创建名为 `Infinite Canvas` 的用户 Token。
3. 调用 Token Key 接口取得该用户 Token 的完整 Key。
4. 后续 `/v1` 模型请求使用这个用户自己的 Key。
5. 将登录 Token 和用户 API Token 只保存到 Android Keystore/iOS Keychain；不写入普通日志、URL、画布数据或可见设置页面。

这意味着：

- App 不包含总账户 Key；
- App 不包含任何上游供应商 Key；
- 每个用户使用自己的 New API Token，额度和计费仍由 New API 管理；
- 纯前台 App 无法做到“用户设备永远接触不到自己的 API Token”。如果必须完全隐藏 Token，就必须恢复服务端 Relay，这与当前“不增加后端接口”的要求冲突。

### 原生 App 的登录会话注意事项

Capacitor 运行时的来源通常是 `capacitor://localhost`（iOS）或 `http://localhost`（Android WebView），不是普通网站的 `https://canvas.example.com`。因此第一阶段必须在真机验证 New API 的以下行为：

- `/api/user/login` 的 refresh Cookie 能否被 WebView 持久化；
- `/api/user/auth/refresh` 是否能在 App 重启后继续工作；
- `/api/user/self` 和 `/v1/*` 是否允许来自 App WebView 的请求；
- New API 的 CORS/Origin 配置是否接受 Android/iOS 的 App 来源。

这不是新增接口，但属于 `https://mikasa.icu` 的现有部署配置。若现有 Cookie 策略无法覆盖原生来源，第一版将使用安全存储中的短期登录 `access_token`，在过期时要求用户重新登录；不会把密码或 refresh Cookie 复制到普通存储中。是否能够实现无感刷新，需要真机验收后再定。

## 3. 技术方案

推荐使用 **Capacitor + React + TypeScript**：

- 复用现有 Infinite Canvas 的 React/TypeScript 经验；
- `mobile-app` 是独立 App 工程，不改写现有 `web/` 的生产入口；
- Android 和 iOS 共用一套移动界面与 API 客户端；
- 原生能力通过 Capacitor 插件接入：安全存储、相册、文件选择、下载和分享；
- API 直接请求 `https://mikasa.icu`，不引入 App 专用后端；
- 可先生成 Android APK/AAB，再在 macOS + Xcode 上生成 iOS IPA。

React Native 是后续需要极致原生性能时的替代方案，但会重写画布、手势、媒体预览和文件处理，第一版不采用。

## 4. 目录设计

```text
mobile-app/
├─ src/
│  ├─ api/
│  │  ├─ client.ts                 # 固定请求 https://mikasa.icu
│  │  ├─ auth.ts                   # 注册、登录、2FA、刷新、退出
│  │  ├─ tokens.ts                 # 用户 Token 创建、查询、取 Key
│  │  ├─ models.ts                 # /v1/models
│  │  ├─ chat.ts                   # /v1/chat/completions
│  │  ├─ image.ts                  # 生图和图片编辑
│  │  ├─ video.ts                  # 创建任务、轮询、下载
│  │  └─ account.ts                # 用户信息、额度、充值信息
│  ├─ auth/
│  │  ├─ auth-store.ts             # 登录状态
│  │  └─ secure-session.ts         # Keychain/Keystore 封装
│  ├─ components/                  # 移动端通用组件
│  ├─ features/
│  │  ├─ home/                     # 首页和最近生成
│  │  ├─ canvas/                   # 移动画布
│  │  ├─ generate/                 # 统一生成面板
│  │  ├─ image/                    # 生图和图片编辑
│  │  ├─ video/                    # 视频任务和进度
│  │  ├─ assets/                   # 我的素材
│  │  └─ account/                  # 账户、额度、充值、Token 状态
│  ├─ navigation/                  # 登录栈和主 Tab 导航
│  ├─ storage/                     # 本地项目、素材和生成记录
│  └─ theme/                       # 颜色、间距、字体和安全区
├─ android/                        # Capacitor Android 工程
├─ ios/                            # Capacitor iOS 工程
├─ capacitor.config.ts
├─ package.json
└─ README.md
```

`mobile-app` 不包含 `server/`、`api/` 后端目录，也不复制 New API 源码。

## 5. New API 接口映射

接口基于 [New API 中文 API 文档](https://docs.newapi.ai/zh/docs/api)。实际实现会以部署在 `https://mikasa.icu` 的版本为准，并对响应字段做兼容解析。

### 5.1 账户认证

| 功能 | 请求 |
| --- | --- |
| 查询公开配置 | `GET /api/status` |
| 注册 | `POST /api/user/register` |
| 登录 | `POST /api/user/login` |
| 二次验证登录 | `POST /api/user/login/2fa` |
| 刷新登录 | `POST /api/user/auth/refresh` |
| 退出登录 | `POST /api/user/auth/logout` |
| 当前用户 | `GET /api/user/self` |

账户接口使用 Dashboard 登录 Token。登录后会保存用户 ID、用户名、额度和登录状态；密码不会保存。

### 5.2 用户 Token

| 功能 | 请求 |
| --- | --- |
| 获取 Token 列表 | `GET /api/token/` |
| 创建 `Infinite Canvas` Token | `POST /api/token/` |
| 获取完整 Token Key | `POST /api/token/{id}/key` |
| 删除 Token | `DELETE /api/token/{id}` |
| 查询 Token 使用情况 | `GET /api/usage/token/` |

创建 Token 的默认名称为 `Infinite Canvas`。创建接口只返回成功状态时，再通过 `POST /api/token/{id}/key` 读取完整 Key。App 不在普通业务状态中展示完整 Key。

### 5.3 模型与生成

| 功能 | 请求 | 说明 |
| --- | --- | --- |
| 模型列表 | `GET /v1/models` | 使用用户 API Token |
| 文本对话 | `POST /v1/chat/completions` | 支持流式和非流式 |
| 图片生成 | `POST /v1/images/generations` | JSON 请求 |
| 图片编辑 | `POST /v1/images/edits` | multipart/form-data |
| 创建视频 | `POST /v1/videos` | multipart/form-data，返回任务 ID |
| 查询视频 | `GET /v1/videos/{id}` | 轮询任务状态 |
| 下载视频 | `GET /v1/videos/{id}/content` | 任务完成后下载 |

App 不直接请求 `/v1beta`、官方 OpenAI 地址或任何上游渠道地址。需要 Gemini、OpenAI 兼容模型或其他渠道时，统一由 New API 的渠道配置完成路由。

### 5.4 图片协议适配矩阵

移动端不会把所有图片模型都当成同一种请求处理。第一版按以下协议适配：

| 模型类别 | New API 请求 | 生成方式 | 编辑方式 | 重要限制 |
| --- | --- | --- | --- | --- |
| GPT Image、DALL-E | `POST /v1/images/generations` | OpenAI Image JSON | `POST /v1/images/edits` multipart | `gpt-image-*` 不发送 `response_format`；尺寸、质量和背景按模型支持情况发送 |
| Gemini、Nano Banana | `POST /v1beta/models/{model}:generateContent` | Gemini `contents + generationConfig.responseModalities` | 参考图作为 `inline_data` | 原生 Gemini 路径不使用 mask；尺寸使用 `imageConfig.aspectRatio/imageSize` |
| Grok Imagine | `POST /v1/images/generations` | New API xAI 适配器的 OpenAI 图片格式 | 暂不承诺图片编辑 | 当前 xAI 图片请求只稳定支持 `model`、`prompt`、`n`、`response_format`，不发送 `size`、`quality`、`style` |

请求头统一为：

```http
Authorization: Bearer <用户自己的 New API Token>
Content-Type: application/json
```

Gemini 原生路径也使用 New API 文档要求的 Bearer Token，不把 `x-goog-api-key` 或上游 Gemini Key 放入 App。

模型列表接口只返回模型 ID，不能可靠告诉客户端每个模型支持哪些参数。因此移动端会维护一个最小的本地能力表，并允许管理员在 New API 中通过模型命名约定或 App 配置修正能力：

- `gpt-image-*`、`dall-e-*`、`gemini-*`、`nano-banana*`、`grok-imagine-image*` 默认归类为图片；
- 未识别模型默认只发送最小必需字段；
- 服务器返回“参数不支持”时，不把该参数加入下一次请求，而不是盲目切换到其他模型；
- 认证失败、余额不足、模型未定价不会自动重试或换模型；
- 临时网络错误最多有限重试，并向用户显示重试状态。

现有 Web 端已经实现 GPT/OpenAI 图片路径、Gemini 原生路径和 Gemini 失败后的有限协议降级；但它的自动能力关键词目前没有覆盖 `grok-imagine-image`。这不会直接复用到移动端，移动端会在正式实现时按上表单独处理并补充测试。

## 6. 生成参数策略

之前出现过“unsupported or unpriced parameters for this model”问题，因此移动端不会把所有参数无条件发送给每个模型。

实现规则：

1. 先获取 `/v1/models`，建立模型选择列表。
2. 对图片模型只发送 `model`、`prompt` 以及当前模型明确支持的尺寸、质量、数量和响应格式。
3. 图片编辑使用文件上传，不把不支持的生成参数混入 multipart 表单。
4. 视频默认只发送 `model`、`prompt`、输入图片、时长和尺寸；可选字段由模型能力配置决定。
5. 服务端返回参数不支持、模型未定价或余额不足时，显示明确错误，不重复扣费重试。
6. 只有网络超时或明确的临时上游错误才进入有限次数重试；不会自动换成未经用户选择的模型。

## 7. 移动端界面

### 登录流程

- 启动页检查安全存储中的登录状态；
- 登录、注册、邮箱验证和 2FA；
- 登录成功后自动创建或恢复 `Infinite Canvas` Token；
- 登录失败显示 New API 返回的中文错误；
- 退出时清除本地登录 Token 和用户 API Token。

### 主导航

底部使用四个主入口：

1. **创作**：提示词、模型、尺寸、质量、参考图和生成按钮。
2. **画布**：移动端节点画布、拖拽、缩放、节点详情和生成结果。
3. **素材**：图片、视频、音频和本地导入内容。
4. **账户**：用户信息、余额、Token 状态、充值入口、设置和退出。

### 生成页面

- 图片：文生图、图生图、参考图上传和结果对比；
- 视频：文生视频、图生视频、任务进度、失败重试和结果下载；
- 文本：对话消息、流式输出和停止生成；
- 生成结果保存到设备本地，并支持加入画布和分享。

## 8. 本地数据策略

不增加服务器数据接口，移动端数据按以下方式保存：

- 登录 Token、用户 API Token：Keychain/Android Keystore；
- 画布结构、模型偏好、生成记录：App 本地数据库或 Capacitor Preferences；
- 图片和视频文件：应用沙盒文件目录；
- 退出登录：删除密钥和登录状态，但不默认删除用户已导出的本地素材。

当前 Web 端 IndexedDB 数据不会自动迁移到移动端。后续可以增加导入/导出 JSON 或 WebDAV 同步，但不作为第一版必需功能。

## 9. 充值流程

充值属于 New API 账户能力，不新增支付后端：

1. App 调用 New API 的充值信息接口读取可用支付配置。
2. App 调用 New API 用户充值/支付接口。
3. 如果返回支付 URL，使用系统浏览器或安全的应用内网页打开。
4. 支付完成后重新请求用户信息和额度。

支付渠道、订单签名、回调和实际到账仍由 `https://mikasa.icu` 上的 New API 负责。

## 10. 实施阶段

### 阶段一：工程骨架

- 创建 `mobile-app` Capacitor React 工程；
- 固定 API Base URL 为 `https://mikasa.icu`；
- 配置 Android/iOS 包名、应用名、图标和启动页；
- 建立移动端主题、导航和安全区布局。

### 阶段二：账户和 Token

- 实现注册、登录、2FA、刷新和退出；
- 实现用户信息、余额和 Token 列表；
- 自动创建或恢复 `Infinite Canvas` Token；
- 接入 Keychain/Keystore；
- 验证不保存密码、不打印完整 Token。

### 阶段三：模型和生成

- 接入 `/v1/models`；
- 接入文本、图片、图片编辑；
- 接入视频创建、轮询和内容下载；
- 增加模型参数能力表、错误解析和有限重试。

### 阶段四：画布和本地素材

- 将移动端原型转成真实 React 组件；
- 实现画布缩放、拖拽、节点选择和生成结果回填；
- 接入相册、文件选择、下载和系统分享；
- 完成本地数据持久化和导入导出。

### 阶段五：真机验收和发布

- Android 真机测试、签名和 AAB 构建；
- Android 构建环境使用 JDK 21、Android SDK Platform 35 和 Build Tools；
- iOS 真机测试、签名和 IPA 构建；
- 检查 API 请求均指向 `https://mikasa.icu`；
- 检查图片、视频、充值和退出登录；
- 检查 Token 不出现在日志、URL 和普通存储中。

## 11. 验收标准

- 用户可以在 App 内注册、登录和完成 2FA；
- 登录后可以自动创建或恢复自己的 `Infinite Canvas` Token；
- 图片、图片编辑、文本和视频请求均发送到 `https://mikasa.icu`；
- App 不请求任何官方上游域名；
- New API 能正确扣减用户额度并返回错误；
- 视频任务中断后可以继续查询或显示失败；
- 用户可以查看余额、Token 状态并完成充值；
- Android 可安装运行，iOS 可在真机运行；
- 不需要为移动端新增 New API 后端接口。

## 12. 开始实现前需要确认的事项

1. App 名称是否继续使用 `Infinite Canvas`，还是使用新的商业品牌名？
2. Android 包名和 iOS Bundle ID 使用什么值？暂定为 `com.mikasa.infinitecanvas`。
3. 是否先开发 Android，再补 iOS？iOS 真机构建需要 macOS + Xcode。
4. 是否接受“无新增后端时，App 需要安全保存当前用户自己的 New API Token”这一技术事实？
5. 充值是否先跳转 New API 返回的支付页面，还是需要在 App 内做完整支付页面？
