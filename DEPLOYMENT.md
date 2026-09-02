# 部署在线演示版

Spectra Copilot 有两种运行模式：

| 模式 | 使用场景 | 文件来源 | API Key |
| --- | --- | --- | --- |
| 本地桌面模式（默认） | 开发、自己的电脑 | Desktop 搜索或浏览器上传 | 保存在本机浏览器存储中 |
| 公共上传演示模式 | 面试链接、公开 Demo | 仅访问者主动上传 | 仅当前浏览器标签页暂存，访问者自行提供 |

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

不要把自己的 DeepSeek 或其他模型 API Key 写入平台环境变量、GitHub Secrets 或前端代码。这个演示版采用 BYOK（访问者自带 Key），因此你的账户不会因访客使用而产生模型调用费用。

## 上线边界

这是公开演示版，不是带登录、数据库和计费系统的 SaaS。若要让用户无需填写自己的 Key，则必须增加服务端密钥管理、身份验证、速率限制、用量配额、审计与隐私政策后再上线。
