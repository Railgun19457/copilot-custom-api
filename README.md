# Copilot Custom API

![Copilot Custom API 访问计数](https://count.getloli.com/@railgun19457_copilot-custom-api?name=copilot-custom-api&theme=miku&padding=7&offset=0&align=top&scale=1&pixelated=1&darkmode=auto)

Copilot Custom API 是一个把自定义 API 模型接入 VS Code Copilot Chat 的扩展。供应商地址、密钥和模型都可以在图形界面中管理，保存后的模型可直接在 Copilot Chat 中选择。

## 功能特性

- **多供应商与多协议**，支持 OpenAI Chat Completions / Responses、Anthropic Messages、Gemini Interactions / GenerateContent。
- **模型发现**，从供应商获取模型列表，用 [models.dev](https://models.dev/) 补全模型名称、Token 上限、图片输入、工具调用和推理档位。
- **模型配置**，支持逐模型测试、流式响应、推理档位多选，以及自定义协议、请求头和请求参数。
- **同模型跨渠道路由**，按 API 模型 ID 合并，优先走主渠道，连续失败后切换备用渠道。
- **辅助模型**，可从已添加的模型中选择常规和轻量辅助模型。
- **中英文界面**，管理页默认跟随 VS Code 显示语言，可在页首切换。

## 运行环境

| 项目 | 要求 |
| --- | --- |
| 编辑器 | VS Code 1.145 或更新版本 |
| 聊天入口 | Copilot Chat。使用 Copilot harness 时启用 `chat.agentHost.byokModels.enabled` |
| API | 支持下方协议之一的端点，以及端点所需的 API 密钥 |

[VS Code BYOK 文档](https://code.visualstudio.com/docs/agent-customization/language-models#_bring-your-own-language-model-key)

## 快速开始

1. 在 VS Code 扩展面板菜单选择 **从 VSIX 安装…**，选择安装包。也可按下方的开发命令从源码打包。
2. 打开活动栏 **Copilot Custom API**，点击 **新建供应商**。填入名称、API 协议、端点地址和鉴权信息。
3. 在 **模型** 页点击 **获取模型**，勾选需要的模型。也可以点 **手动添加**，填入端点接受的 API 模型 ID。
4. 核对 Token 上限和模型能力，点击 **保存供应商**，再展开模型点击 **测试模型**。
5. 在 Copilot Chat 的模型选择器中选用已保存的模型。若模型被隐藏，可在 **Chat: Manage Language Models** 中显示它。

## 界面说明

| 区域 | 用途 |
| --- | --- |
| 活动栏 → 供应商 | 创建供应商，或点击已有供应商打开管理页 |
| 连接 | 设置地址、协议、鉴权、请求头和会话 ID |
| 模型 | 获取或手动添加模型，配置 Token 上限、图片输入、工具调用、流式响应和推理档位 |
| 模型 → 高级请求设置 | 配置模型专用协议、请求头、额外 JSON 请求参数和渠道优先级 |
| 模型设置 | 选择常规辅助模型和轻量辅助模型，启用跨渠道路由 |

供应商列表中的 Token 上限优先于 models.dev。手动添加时，输入模型 ID 后会查询默认值，也可点 **从 models.dev 获取默认值** 再查一次。推理强度可勾选多个档位，也可添加自定义档位。默认档位从已勾选的项中选取。

## API 协议

| 协议 | 基础地址追加的标准路径 | 默认鉴权 |
| --- | --- | --- |
| OpenAI Chat Completions | `/v1/chat/completions` | Bearer |
| OpenAI Responses | `/v1/responses` | Bearer |
| Anthropic Messages | `/v1/messages` | `x-api-key` |
| Gemini Interactions | `/v1/interactions` | `x-goog-api-key` |
| Gemini GenerateContent | `/v1beta/models/{model}:generateContent`（流式为 `:streamGenerateContent`） | `x-goog-api-key` |

基础地址已带版本号时会复用该版本，也可直接填写带标准路径的地址。网关使用自定义路径时，选择 **使用完整端点地址**。Gemini GenerateContent 可用 `{model}` 引用当前 API 模型 ID。获取模型时可填写 **自定义模型列表地址**，地址须与供应商端点同源。

API 密钥保存在 VS Code SecretStorage。鉴权还可设为 Bearer、自定义密钥请求头或无需鉴权。**请求头与会话** 默认使用 Copilot 兼容请求头，可切换为仅协议请求头。可填写固定的 `X-Session-Id`，也可在自定义请求头中用 `${sessionId}` 引用会话 ID。留空时优先使用 Copilot 对话提供的 ID。

## 跨渠道路由

在两个供应商里添加同一个 API 模型 ID，例如 `example-chat`。分别将 **渠道优先级** 设为 `20` 和 `10`，再到 **模型设置 → 跨渠道路由** 启用并保存。

- Copilot 只显示一个 `example-chat` 条目。两个渠道都支持当前请求时，先用优先级为 `20` 的渠道。默认优先级为 `0`。
- 主渠道连续失败两次后进入一分钟冷却，未开始输出的请求可切换到备用渠道。已经开始输出时，下一次请求再使用备用渠道。
- 一次成功会清除该渠道的连续失败计数。冷却结束后，按优先级重新选择渠道。

## 命令

在命令面板搜索 `Copilot Custom API`。

| 命令 | 用途 |
| --- | --- |
| 打开供应商管理器 | 打开图形管理页 |
| 新建供应商 | 直接打开新供应商表单 |
| 添加供应商（分步向导） | 用 VS Code 输入框添加连接和模型 |
| 管理供应商（分步向导） | 用命令面板管理已有供应商 |

## 配置项

| 配置项 | 用途 |
| --- | --- |
| `copilotCustomApi.language` | 管理页语言，默认 `auto`，也可选 `zh-cn` 或 `en` |
| `copilotCustomApi.providers` | 供应商和模型配置，由管理页维护 |
| `chat.utilityModel` | 常规辅助模型，用于摘要、设置搜索和 Git 审查等任务 |
| `chat.utilitySmallModel` | 轻量辅助模型，用于提交信息、PR 描述和本地 Copilot 会话标题等任务 |

供应商配置和密钥由同一份本机 VS Code 用户数据共享。可在扩展面板选择 **Apply Extension to all Profiles**。辅助模型和跨渠道路由开关按 Profile 保存。[VS Code Profile 文档](https://code.visualstudio.com/docs/configure/profiles#_apply-an-extension-to-all-profiles) · [辅助模型文档](https://code.visualstudio.com/docs/agent-customization/language-models#_change-the-model-for-utility-tasks)

## 开发

使用 Node.js 22 或更新版本，在仓库根目录执行。

```bash
npm ci
npm test
npm run test:vscode
npm run package
```

集成测试默认下载 VS Code 1.145.3，使用独立用户数据和本地模拟端点。设置 `VSCODE_EXECUTABLE` 可改用本机已安装的 VS Code。打包产物为仓库根目录下的 `copilot-custom-api-<version>.vsix`。

扩展源码在 `src/`，管理页资源在 `media/`，测试在 `test/`。

## 发布

在 Visual Studio Marketplace 的发布者 `copilot-custom-api` 下创建 **Trusted Publishing** 策略。Repository owner 填 `Railgun19457`，Repository 填 `copilot-custom-api`，Workflow 填 `publish.yml`，Environment 留空。[发布者管理后台](https://marketplace.visualstudio.com/manage) · [OIDC 配置文档](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-with-github-actions-and-trusted-publishing)

更新并提交 `package.json` 和 `package-lock.json` 的版本后，推送对应标签。Marketplace 上的每次发布都需要独立的数字版本。

| 发布渠道 | 标签示例 | 扩展版本 |
| --- | --- | --- |
| Beta | `v0.5.3-beta.1` | `0.5.3` |
| 正式版 | `v0.6.0` | `0.6.0` |

**Publish extension** 会跑测试并构建 VSIX，再用同一个包发布到 Marketplace 和 GitHub Releases。也可以在 Actions 页手动运行，选择 Beta 或正式版来验证构建并下载 VSIX。手动运行只执行测试和打包。
