# Proveo

电商场景 AIGC 带货视频生成系统。面向 TikTok Shop 国际电商，输入商品链接或商品素材后，系统完成爆款配方参考、剧本分镜、可编辑制作台、Seedance 成片、Video Passport 和数据反馈闭环。

本仓库是提交用的干净源码仓库，保留完整功能链路源码，而不是只放演示素材的展示仓库。仓库保留完整源代码、Prisma schema/migrations、README、架构/API 文档、CI/CD 和生产部署文件；录屏素材、临时产物、缓存和内部协作文档已清理。

## 核心价值

- 一条主链路：商品链接/主图 -> 爆款配方 -> 剧本分镜 -> 制作台确认 -> Seedance 成片 -> 预览导出 -> Video Passport -> 数据反馈。
- 一个用户入口：商家只和对话生产 Agent 交互，内部由 Researcher、Composer、Renderer、Auditor 工具链执行。
- 可控生成：先生成剧本和分镜，用户确认后再触发高成本成片，不把生成过程做成黑盒。
- 素材边界清晰：当前商品素材只作为 Seedance 生成参考，不裁切、不混剪进最终成片；参考视频只进入爆款配方和方法论资产。
- 可信交付：证据接地、合规检查、QA 和 Passport 记录每条成片的来源、风险和可交付状态。
- 增长反馈：看板展示投放表现、创作因子归因和 A/B 版本对比入口；比赛场景下允许使用 mock/display-only 数据。

## 功能范围

| 模块               | 说明                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| 对话生产 Agent     | `/api/agent/chat` 负责需求理解、资料检查、调研、剧本分镜、制作台交接和进度追问。                                |
| CloneCast 爆款配方 | 检索参考库，拆解 Hook、节奏、镜头结构、字幕策略和成交因子，并克隆到新商品。                                     |
| 素材库             | 上传或抓取当前商品素材，按 `productId` 隔离；素材用于生成参考，不进入素材混剪池。                               |
| 制作台             | 编辑分镜、旁白、字幕、镜头节奏、版本树和成片确认。                                                              |
| 视频生成           | Worker 通过 BullMQ 执行 Seedance 分镜生成，FFmpeg 合成最终 MP4。Seedance 或 FFmpeg 不可用时任务失败并暴露原因。 |
| Video Passport     | 汇总 TrustScore、证据覆盖、合规风险、素材边界和交付信息。                                                       |
| 数据反馈           | 展示表现数据、创作因子归因和 A/B 版本对比入口。                                                                 |
| 多语种             | 支持面向 TikTok Shop 海外市场的脚本语言和字幕文案生成，前端界面可中文。                                         |

## 架构概览

```text
apps/web      React/Vite 商家工作台
apps/api      Express API, SSE, provider transport, project snapshot
apps/worker   BullMQ worker, script/render/material/maintenance/agent processors
packages/db   Prisma schema, migrations, repositories
packages/queue BullMQ queue definitions
packages/storage S3/local object storage adapter
packages/agent-runtime Mastra workflow adapter and shared runtime types
packages/trustloop Passport, policy, QA and evidence utilities
```

运行底座：

- Postgres：任务、素材、剧本、分镜、Passport、证据和表现数据。
- Redis/BullMQ：持久任务队列和 Worker 执行。
- 对象存储：上传素材、参考图、分镜视频和最终 MP4。
- Qdrant：参考库和素材检索向量服务。
- FFmpeg：最终 MP4 合成、字幕和音频处理。

AI provider：

- Doubao / Ark：剧本、分镜和语义补全。
- Seedance：正式视频生成。
- Qwen-VL：可选字幕位置与视觉理解。
- Qwen Image / GPTImage2：可选多角度图或商品参考图。

## 快速启动

推荐 Node.js 20+、Docker Desktop / Colima、FFmpeg。

```bash
git clone https://github.com/kaigeliang/proveo.git
cd proveo

npm install
cp .env.example .env

docker compose up -d postgres redis minio qdrant
npm run db:generate
npm run db:deploy
npm run dev
```

访问：

- Web: http://localhost:5173
- API health: http://localhost:5001/api/health
- API readiness: http://localhost:5001/api/healthz

停止：

```bash
npm run dev:down
docker compose down
```

也可以用一键脚本：

```bash
./setup.sh
./start.sh --with-services
```

前台运行时按 `Ctrl+C` 停止 API / Worker / Web；如果用后台模式，执行：

```bash
./stop.sh --with-services
```

## 环境变量

仓库不包含任何真实密钥。先复制模板，再按需填写：

```bash
cp .env.example .env
```

### 基础必需项（本地服务，docker compose 默认值即可）

- `DATABASE_URL` — Postgres 连接串
- `REDIS_URL` — BullMQ 队列连接串
- `OBJECT_STORAGE_*` — 对象存储；用 `docker-compose.yml` 里的 MinIO 默认值即可
- `QDRANT_URL` — 向量检索地址

### 配置你自己的模型 Key（核心）

剧本生成与正式成片依赖火山方舟的 Doubao（文本）和 Seedance（视频）。在 [火山方舟控制台](https://console.volcengine.com/ark) 开通后：

1. 创建一个 **API Key**。
2. 分别为 **Doubao-Seed 文本模型** 与 **Doubao-Seedance 视频模型** 各创建一个在线推理接入点（Endpoint，形如 `ep-xxxxxxxx`）。
3. 把它们填进 `.env`：

```bash
ARK_API_KEY=你的火山方舟 API Key
ARK_TEXT_MODEL_ID=ep-你的文本模型接入点
ARK_VIDEO_MODEL_ID=ep-你的视频模型接入点
```

### 可选能力 Key（不配则自动降级或跳过，不影响主链路启动）

- `QWEN_IMAGE_API_KEY` 或 `DASHSCOPE_API_KEY` — 商品多角度参考图（Qwen Image Edit / DashScope）
- `QWEN_VL_API_KEY` — 爆款视频拆解与字幕视觉决策（Qwen-VL）
- `GPTIMAGE2_API_KEY` 或 `OPENAI_API_KEY` — 无商家主图时生成干净的商品参考首帧

### 验证 Key 是否生效

```bash
curl http://localhost:5001/api/health
```

返回里的 `providers.doubaoText` 与 `providers.seedanceVideo` 均为 `true`，即表示火山方舟 Key 配置正确。

### 直连火山方舟超时怎么办

如果本机无法直连火山方舟（请求超时或 HTTP 000），在 `.env` 配置你自己的代理后再启动；部署到能直连火山的服务器时无需配置：

```bash
HTTP_PROXY=http://你的代理地址:端口
HTTPS_PROXY=http://你的代理地址:端口
```

正式成片必须走 Seedance。未配置 Seedance 时，剧本和页面可运行，但成片任务会明确失败，不会降级成素材裁切或 HTML 假视频。

## 常用命令

```bash
npm run build                 # 全仓库构建
npm run lint                  # Web/API lint
npm run stylelint             # CSS 检查
npm run format:check          # 格式检查
npm run test:agent-ui         # AG-UI 事件协议烟测
npm run test:mastra-workflow  # Mastra workflow 烟测
npm run test:p0:snapshot      # 项目快照烟测
npm run test:p0:real-e2e      # 真实 E2E；默认不耗 Seedance，需显式开启环境变量
```

完整生产预览：

```bash
npm run build
npm start
npm run preview --prefix apps/web
```

## VPS 演示部署

`docker-compose.lite.yml` 面向低配 VPS 演示环境。它保留 API、Worker、Web、Postgres、Redis、FFmpeg、Doubao 和 Seedance 主线，关闭本地重模型和高内存向量任务。

```bash
cp .env.lite.example .env.lite
npm run demo:lite:check -- --env-file=.env.lite
npm run demo:lite:up
curl http://127.0.0.1:5001/api/healthz
```

停止：

```bash
npm run demo:lite:down
```

注意：VPS Demo 只是线上部署演示入口；本仓库保留完整功能链路源码。低配 VPS 无法承载的 CLIP/Jina/Qdrant/Qwen-VL 等重任务会使用可说明的 fallback，不伪装成真实模型结果。

## 数据与数据库

提交仓库保留必要数据库结构：

- `packages/db/prisma/schema.prisma`
- `packages/db/prisma/migrations/**/migration.sql`

如需导入比赛演示数据或重建向量库，可使用脚本目录中的数据处理命令：

```bash
npm run kalodata:prepare
npm run references:index
npm run qwen:reference
npm run qwen:reindex
```

实际数据包、模型缓存、上传素材、生成视频和录屏产物不进入本提交仓库。

## 验证记录

最近一次干净仓库实跑验证覆盖：

- `npm install` 通过
- `npm run db:generate` 通过
- `npm run db:deploy` 通过，10 个 Prisma migration 无待应用项
- `npm run build` 通过
- API / Worker / Web 从 clean clone 启动
- API health 返回 Postgres / Redis up
- 真实触发 Doubao 剧本生成和 Seedance 成片
- 生成 MP4：15.125s，720x1280，H.264 + AAC

## 文档

- 架构说明：`docs/architecture.md`
- API / ER 参考：`docs/api-reference.md`
- OpenAPI：`docs/openapi.json`
- 生产部署：`.github/workflows/cd.yml`、`deploy/docker-compose.production.yml`
