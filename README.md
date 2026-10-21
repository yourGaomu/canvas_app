# Infinite Canvas Mobile App

这是 Infinite Canvas 的独立移动端前台工程，使用 React + TypeScript + Vite + Capacitor。App 不新增后端，也不直接调用 OpenAI、Gemini 或其他上游地址；注册、登录、模型和生成请求全部发送到：

```text
https://mikasa.icu
```

## 本地开发

```bash
npm install
npm run dev
```

浏览器打开 `http://localhost:4173`。浏览器模式使用本地存储保存会话；原生 Android/iOS 模式使用 Capacitor Secure Storage 保存会话和用户自己的 New API Token。

Vite 开发服务器会把 `/api`、`/v1`、`/v1beta`、`/kling` 和 `/jimeng` 代理到 `https://mikasa.icu`，因此本地调试不会因为 `localhost:4173` 跨域而直接失败。生产构建不会使用这个代理，仍然直连固定 API 地址。

## 构建原生 App

Android 构建必须使用 **JDK 21**。当前 Capacitor 7 Android 依赖的 Java 编译目标是 21，JDK 17 会报 `无效的源发行版：21`。Android Studio 自带的 `jbr` 一般就是 JDK 21，也可以单独安装 Temurin/OpenJDK 21。

PowerShell 临时切换到 Android Studio 自带 JDK 的示例：

```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
java -version
```

确认输出为 21.x 后，再执行 Android 构建。若 Android Studio 安装在其他位置，把路径替换成实际的 `jbr` 目录。

先构建 Web 资源并同步 Capacitor：

```bash
npm run build
npm run cap:sync
```

Android 需要安装 Android Studio 和 Android SDK：

```bash
npx cap add android
npm run android
```

iOS 需要在 macOS 上安装 Xcode：

```bash
npx cap add ios
npm run ios
```

首次执行 `cap add` 只需要一次；后续修改前端后执行 `npm run build` 和 `npm run cap:sync` 即可。

## API 与认证

用户登录成功后，App 会通过 New API 的用户 Token 接口查找或创建名为 `Infinite Canvas` 的 Token，并将该用户自己的完整 Token 放入原生安全存储。图片、图片编辑、视频和文本请求均使用这个 Token 发往 `https://mikasa.icu/v1/*`。

App 不保存密码、总账户 Key 或任何上游供应商 Key。退出登录会清除本机登录会话和用户 Token，但不会删除已经保存的本地素材。

## 查看 Android 调试日志

修改前端日志后，在仓库根目录依次运行 `npm run build` 和 `npm run cap:sync`，再用 Android Studio 重新运行并安装 App。Android Studio 的 `Logcat` 选择 App 进程并过滤 `mikasa-app`；日志会记录 API 路径、请求方式、HTTP 状态码、耗时、模型和失败原因。Android Capacitor 原生日志已关闭，避免桥接层输出请求参数；App 仅通过原生 `mikasa-app` 标签输出经过脱敏的诊断信息，不打印 Authorization、完整 Token、密码、Cookie、图片内容或提示词正文。请求失败时提供对应的 `request:failed` 或 `generation:failed` 日志即可。

## 部署前检查

正式环境需要确认 `mikasa.icu`：

- 允许浏览器来源以及 Android/iOS WebView 来源访问认证和 `/v1/*` 接口；
- Cloudflare/WAF 不要对 `/api/*`、`/v1/*`、`/v1beta/*`、`/kling/*` 和 `/jimeng/*` 返回挑战页或 403；这些接口必须返回 JSON，并允许 `OPTIONS` 预检；
- 如果 App 以独立 HTTPS 域名部署，New API 的 `SESSION_COOKIE_TRUSTED_URL` 需要加入该域名的精确 Origin；
- 正确处理 `Authorization: Bearer <用户 Token>`；
- 已配置模型价格、渠道和图片/视频路由；
- 视频接口支持 `POST /v1/videos`、`GET /v1/videos/{id}`；任务若返回直链则直接使用，否则再读取 `/v1/videos/{id}/content`；
- 若登录刷新依赖 HttpOnly Cookie，需要在 Android/iOS 真机上验证 Cookie 持久化；否则 App 会在短期 access token 过期后要求重新登录。

## 当前界面

- 创作：图片、图片编辑、视频和文本对话；素材页的“提示词库”可搜索、筛选提示词并填入创作输入框；
- 画布：独立的本地画布项目，可从素材库主动选择图片、视频和文字加入；支持节点选择、拖动、多选、平移、连线，以及画布内生图/视频节点；生成结果进入素材库并作为连线结果节点加入当前画布；
- 素材：本地图片、视频和对话记录；
- 账户：额度、请求次数、Token 状态和退出登录。

个人画布和素材仍保存在设备本地，不包含素材云同步。素材库删除素材不会删除画布项目；画布移除节点也不会删除素材。

## 多人协作接入

移动端已预留 `Yjs + Hocuspocus Provider` 协作层。个人画布仍使用本地存储；点击“创建共享画布”或“加入协作”后，才会请求独立的 Go 协作 API，并通过 WebSocket 连接 Hocuspocus。后端实现请以 [`COLLABORATION_BACKEND_SPEC.md`](./COLLABORATION_BACKEND_SPEC.md) 为准，移动端字段摘要见 [`COLLABORATION_CONTRACT.md`](./COLLABORATION_CONTRACT.md)。

当前版本同步节点、连线、文本、位置和在线拖动状态；图片、视频仍是本机素材，尚未实现共享素材上传。协作服务未部署或未配置时，不影响本地画布和 New API 生图功能。
