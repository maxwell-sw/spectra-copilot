# 部署在线演示版

Spectra Copilot 有两种运行模式：

| 模式 | 使用场景 | 文件来源 | API Key |
| --- | --- | --- | --- |
| 本地桌面模式（默认） | 开发、自己的电脑 | Desktop 搜索或浏览器上传 | 保存在本机浏览器存储中 |
| 公共上传演示模式 | 面试链接、公开 Demo | 访问者主动上传，或内置 5 份演示样例 | 默认由访问者提供；可选服务端演示额度 |

公共演示版不会扫描访问者电脑，也不会在服务器保存模型 API Key。上传的文件与生成的交付物只保留在运行内存；无活动两小时后自动删除，服务重启也会清空。

## 部署前检查

在项目目录运行：

```bash
npm ci
npm test
SPECTRA_MODE=public PORT=10000 npm start
```

然后访问 `http://127.0.0.1:10000/api/health`。返回内容中的 `root` 应为“上传文件（公共演示）”。

## 使用任意 Docker 托管平台

仓库已带有 `Dockerfile`。在 Render、Railway、Fly.io、Google Cloud Run 等支持 Docker 的平台中：

1. 用 GitHub 仓库 `1178922523-maker/spectra-copilot` 创建一个新的 Web Service。
2. 选择 Dockerfile 构建。
3. 设置环境变量：`SPECTRA_MODE=public`。
4. 让平台通过 `PORT` 环境变量分配端口；不要固定为 8787。
5. 部署后访问 `<你的域名>/api/health`；确认返回 `ok: true`。
6. 将平台提供的 HTTPS 链接用于面试展示。

默认采用 BYOK（访问者自带 Key），因此你的账户不会因访客使用而产生模型调用费用。

### 可选：只给内置面试样例提供服务端额度

如果希望面试官无需填写 Key 就能运行首页的 5 份内置样例，可仅在托管平台的**环境变量**中设置：

```text
SPECTRA_DEMO_API_KEY=新建的专用 DeepSeek Key
SPECTRA_DEMO_RUN_LIMIT=3
SPECTRA_DEMO_MODEL=deepseek-v4-flash
```

- Key 只存在于 Render 等托管平台的服务端环境，不会进入 Git、Docker 镜像、网页 JavaScript 或浏览器网络请求。
- 服务端额度只接受内置的 5 份 `IR-Candidate` 演示文件，固定使用 DeepSeek 端点；上传自己的数据仍需要访问者填写自己的 Key。
- 默认每个访问地址每 10 分钟最多运行 3 次，防止公开链接被轻易刷空额度。若要更严格的防滥用保护，需要增加登录、验证码和用量监控。
- 请使用单独新建、限额很低的演示 Key；如果 Key 曾被发到聊天、截图或代码中，应立即撤销并新建。

## 上线边界

这是公开演示版，不是带登录、数据库和计费系统的 SaaS。内置样例的受控额度适合面试展示，不等同于面向任意用户的免费模型服务；若要扩大到所有上传数据，仍必须增加身份验证、用量配额、审计与隐私政策。
