# 架构与数据边界

最后更新：2026-06-02 CST。本文合并原状态、工程架构、向量检索、参考视频、多角度、FastMoss 和 TrustDAG 专题文档，作为长期架构入口。

## 当前运行状态

- 默认链路：Postgres + Redis + BullMQ Worker 是唯一生成任务运行时；API 不再进程内执行剧本、切片、角度图或渲染任务。
- API：`npm run dev` / `./start.sh` 启动 Express，并固定 queue 生产链路。
- Worker：消费 `aigc.script`、`aigc.render`、`aigc.material`、`aigc.maintenance`、`aigc.agent`。
- 前端：React/Vite 中文工作台，主入口在 `apps/web/src/simple/`。
- 基础服务：Postgres、Redis、MinIO、Qdrant 是完整生成链路前置条件；Qdrant 是默认在线向量库。
- 正式成片：所有镜头必须由 Seedance 生成，再由 FFmpeg 合成字幕、旁白和转场；Seedance 或 FFmpeg 不可用时任务失败并暴露原因，不降级为素材裁切、本地视频或 HTML。

## 生产工作流

主线固定为：

```text
商品链接/主图
  -> 爆款配方
  -> 剧本+分镜
  -> Seedance 一键成片
  -> 进度/预览/导出
  -> 折叠数据看板
```

对外讲法是 **Production Workflow Orchestrator**：Postgres 保存持久状态，Redis/BullMQ 保存持久队列，Worker 真正执行生成，API 只做请求校验、任务创建和状态查询。不称为“自研 agent 框架”，不与 LangGraph 正面比较。

当前 workflow 边界已经接入 `@mastra/core` Workflow；Mastra 定义位于 `packages/agent-runtime/src/mastra-workflow.ts`，供 API 派发计划和 Worker 执行审计共用：

- Mastra plan：`requirements.confirm -> research.parallel -> script.compose -> storyboard.compose -> storyboard.approval -> render.dispatch -> qa.passport`。
- `requirements.confirm` 是 branch 节点，决定补资料、先调研、先出剧本，还是进入确认出片。
- `research.parallel` 是 parallel 节点，聚合商品页抓取、当前商品素材检查、参考库检索和合规预检。
- `storyboard.approval` 是 human-in-the-loop suspend 节点；恢复入口是 `POST /api/agent-runs/:runId/resume`。
- `render.dispatch` 只派发 BullMQ/AgentRun；Seedance、FFmpeg、QA 和 Passport 仍在 Worker 中执行。
- `createQueuedAgentRun()` 会为新 AgentRun 生成内部 `mastraWorkflow` 派发计划，脚本/成片节点只输出 BullMQ dispatch descriptor，不直接调用模型、Seedance 或 FFmpeg。
- `script_generate` 已迁到 Worker 侧 Mastra 分支：不再进入 `executeAgentGraph()` / `graphForRun()`；Worker 按 Mastra step 写入 `AgentStep` 和 `AgentArtifact`，并调用现有 script use case（商品抓图、素材检查、参考检索、证据、合规、Doubao/本地剧本生成、分镜与评分）。
- `GET /api/agents/workflow` 返回该 Mastra plan、已 commit 的 Mastra runtime graph、HITL 信息和现有 8-stage/3-agent 诊断视图。

## 对话 Agent 与用户可见过程

`POST /api/agent/chat` 是当前商家端对话生产入口。用户看到的是一个生产 Agent；内部工具链可以启动 Researcher、Composer、Renderer、Auditor，或查询正在运行的 AgentRun/Task。

前端 `ChatPage` 优先消费基于 `@ag-ui/core` schema 校验的 `agent_ui` SSE 事件，对旧工具事件只保留兼容：

- `agent_ui` 事件覆盖 run lifecycle、state snapshot、tool start/result 和 text delta；API 发出前会用 `EventSchemas` 校验，旧 `tool_call` / `tool_result` 不再作为商家端主显示协议。
- 每一步显示业务动作、状态、摘要和可展开详情，例如“需要补充信息”“正在调研商品”“正在生成剧本”“等待你确认分镜”“正在生成视频”“生成失败，需要补素材”。
- 寒暄、否定、退出、能力咨询和明显非生产问题由对话模型直接回复，不应调用 `assess_project_brief`，也不应把短句当商品名；后端只保留高成本生产动作的硬门槛。
- `assess_project_brief` 属于内部资料检查，不进入商家端制作过程时间线；资料不足时只通过最终回复告诉用户需要补什么。
- 展开详情只能展示用户能理解且可行动的信息；`taskId`、`runId`、`scriptId`、向量 store、模型名、trace 原始字段等内部信息不得出现在商家端自然语言 UI。
- `workflowDecision`、`decisionReason`、`currentState`、`guidance` 等内部判断字段只能留在后端工具结果、trace 或诊断页，不进入商家端时间线文案。
- Agent 负责基于上下文做语义决策，不由前端关键词直接路由生产动作。普通“生成视频/马上生成”默认只进入资料检查、调研、剧本和分镜；用户确认方案后才渲染成片。
- `start_one_click_video` 和 `start_render_full` 是高成本动作，必须带 `workflowDecision`、`renderConsent=true` 和 `decisionReason`。缺少语义确认时，后端只返回“先看剧本分镜/等待确认出片”的确认点。
- 输入框右侧在思考或生成中显示停止按钮。用户发现 Agent 动作超出预期时，可以打断当前 SSE 回复或取消后台 AgentRun，再修改需求重新提交。
- 当前会话没有活跃任务时，单纯询问“进度/完成了吗”应返回“当前没有正在跟踪的制作任务”一类状态，不启动新成片任务。
- 该组件只参考同类产品“步骤可见、可展开、状态明确”的信息层级，不复制第三方产品视觉、文案或交互细节。

## 关键边界

- 商家上传或商品链接抓取到的当前商品图片/视频进入 `Material` / `Slice`，只能作为 Seedance 生成参考。
- 公开视频、榜单视频或授权参考视频进入 `ReferenceVideo`，只保存结构化拆解、检索特征和创作方法论，不进入素材混剪池。
- 任何素材切片都不得绑定为 `materialRef`，不得被 FFmpeg 裁入最终成片。
- 第三方历史表现数据可用于参考库、benchmark 和离线评估，不写成当前生成视频的真实 `VideoPerfRecord`。
- FastMoss AI 工具箱结果只做产品研究和字段设计参考，不直接写入业务 truth 表。

### 素材库 vs 参考库

- 素材库是当前商品/当前商家自己的生产素材集合，来源包括商品链接抓取图、用户上传商品主图和商品视频切片；必须按 `productId` 隔离。
- 参考库是爆款视频、榜单视频、授权样本、Qwen-VL 拆解、字幕风格和 CloneCast 配方资产；它是跨商品的创作方法论库。
- 用户上传“复刻/参考”的视频时，默认进入参考语义或配方输入，不进入素材库；只有用户明确上传当前商品自有图片/视频时，才写入 `Material` / `Slice`。
- 素材库和参考库都只能给 Seedance、剧本生成、字幕策略和配方检索提供参考，不提供裁切、混剪或直接复用原片的成片路径。

## 数据与向量

- Postgres 是业务 source of truth：`Task`、`Material`、`Slice`、`Script`、`Shot`、`VideoAsset`、`VideoSegment`、`VideoTag`、`EmbeddingVector`、`TrendSource`、`TrendItem` 等以数据库为准。
- Redis 是 BullMQ 必需队列后端。
- Qdrant 是默认在线向量库；collection 为 `aigc_video_clip_vectors`，默认向量模型为 `jinaai/jina-clip-v2`，维度 1024，距离 `Cosine`。
- pgvector 表仅保留历史兼容，不再作为默认在线召回路径。
- 本地压缩索引代码和旧 gzip 产物已移除；Qdrant 或真实 embedding 模型不可用时，检索/重建任务直接失败并暴露原因，不生成 hash embedding fallback。

在线召回入口：

- `GET /api/materials/search?q=&mode=&k=&productId=`
- `GET /api/video-tags/status`
- `POST /api/video-tags/reindex`
- `GET /api/video-tags/search?q=&k=&productId=&tags=`
- `GET /api/trends/search?q=&k=`
- `GET /api/trends/vector-search?q=&k=`
- `GET /api/trends/qdrant-search?q=&k=`

Worker 任务：

- `trend.refresh`：写入趋势源、趋势项、真实 CLIP embedding 元数据和 Qdrant point。
- `video-tags.reindex`：把素材切片、视频片段和趋势项重建为统一 Qdrant point。
- 自动刷新由 `TREND_REFRESH_INTERVAL_MINUTES` 和 `VECTOR_REINDEX_INTERVAL_MINUTES` 控制。

## CloneCast 与参考视频

`ReferenceCreativeAnalysis` 是授权参考视频端到端 Qwen-VL 精拆资产，用来提炼节奏、分镜、字幕、Hook 和 CloneCast 配方。

- 业务概念：`ReferenceCreativeAnalysis`
- 唯一存储字段：`ReferenceVideo.breakdownReport.referenceCreativeAnalysis`
- 当前 schemaVersion：`ReferenceCreativeAnalysis.v1`

运行链路：

1. `kalodata:prepare` / `references:index` 写入 `ReferenceVideo` 并建立 reference 向量检索。
2. `qwen:select` 或人工指定 `referenceId` 选择自有或授权可分析视频。
3. `npm run qwen:reference -- --reference-id=<id> --file=<mp4> --write-db` 调用 Qwen-VL 并写入 `referenceCreativeAnalysis`。
4. `POST /api/recipes/extract` 优先读取 `referenceCreativeAnalysis.cloneRecipe`，否则回退历史拆解或保守模板。
5. `POST /api/recipes/:id/clone` 把配方与新商品组合并投递 `script` 队列。
6. Worker 生成分镜时只把素材切片检索结果作为生成参考，最终镜头仍由 Seedance 生成。

不做：

- 不把参考视频原片作为商家素材复用或混剪。
- 不把参考视频切片写入生产 `Slice`。
- 不把无版本字符串 `ReferenceCreativeAnalysis` 当作持久化 schemaVersion。

## 多角度商品参考图

当前采用“多角度 2D 参考图”，不接真 3D mesh：

- `MaterialAngle` 保存角度 key、展示图、渲染参考图、prompt hint、provider、姿态 pose 和降级状态。
- `POST /api/materials/:id/angles` 支持 `force`、`includePresets`、`customAngles`。
- 前端素材页用 360 环绕控件生成 LoRA 兼容 prompt，例如 `<sks> front-right quarter view eye-level shot medium shot`。
- 生产队列模式下，`material.angle` Worker 读取 Postgres 素材，生成 Qwen 或本地 fallback 角度图，缓存到对象存储，并写入 `MaterialAngle`。
- 后续如果要跑 Hugging Face LoRA / ComfyUI，应新增 ComfyUI provider；如果要真 3D mesh，需要独立 GPU worker 或托管 API，不混入当前默认链路。

## FastMoss 智能数据

FastMoss/VOC 数据已进入 Postgres 一等表：

- `ProductVocInsight`
- `ProductReviewInsight`
- `CreativePerformance`
- `VideoSceneTruth`

`npm run fastmoss:ingest` 支持 `.xlsx`、`.csv`、`.json` 导出，`--kind=auto` 自动识别 VOC、评论原声、AI 视频榜/广告创意表现和视频大纲场景；默认 dry-run 输出归一化 JSON，`--write-db` 写库。

当前口径：

- `CreativePerformance=1212` 作为剧本/文案资产与榜单上下文。
- `VideoSceneTruth` 仅保留授权或本项目可持久化数据。
- FastMoss AI 工具箱的 transcript、outline、智能切片等只借鉴字段和交互方式，不直接当 truth 入库。

## TrustDAG / Passport

TrustDAG 后端和 Passport 推导保留，独立 Evidence/TrustDAG 前端可视化已删除；用户可见溯源折叠在进度和交付详情里。

决策：

- `TrustNode` / `TrustEdge` 持久化 `video -> script -> shot -> claim -> evidence` 内容寻址关系。
- Passport 优先从视频关联脚本反向遍历 DAG 推导证据覆盖、素材比例和 stale 风险。
- `POST /api/trust-dag/nodes/:nodeId/stale` 沿依赖反向边把派生节点级联标记为 stale。
- Worker graph 执行按 `researcher`、`composer`、`auditor` 三个责任角色归类。
- API route 创建数据库任务并投递 BullMQ；Worker processors 拥有任务进度、存储和生成 fallback 编排。

主要接口：

- `GET /api/trust-dag/passport/:videoId`
- `GET /api/trust-dag/nodes`
- `GET /api/trust-dag/nodes/:nodeId/dependents`
- `POST /api/trust-dag/nodes/:nodeId/stale`

<!-- BEGIN GENERATED_EVALUATION -->

## 评测与 ML 结论

最后更新：2026-06-02 CST。本文合并原 ML 消融、CloneCast 检索/性能报告和评测口径。`node scripts/eval-reference-retrieval.mjs` 会更新本节。

### 评测口径

- scoring 分两层：`benchmark-scorer` 是真实训练模型；`mock-ctr` / `/feedback/simulate` 是 display-only 模拟表现。后续视频数据模拟必须优先使用训练出的 scorer、cohort similarity 和 Qwen attribution/校准头；如果现有模型无法支撑，应基于训练数据补一个专门的模拟/校准模型，不能随意手写 mock 曲线。
- GMV、销量、播放等历史表现只作 label / 参考排序，不作新视频上线前评分输入。
- Qwen 创意因子用于归因、可解释和生成引导，不用于提升主预测精度。
- 对外使用 creator-disjoint 数字，避免随机切分造成乐观估计。

### ML 消融：CLIP vs Qwen 创意因子

可复现：

```bash
npm run ml:export-dataset
npm run ml:ablate
```

脚本：

- `scripts/export-scorer-dataset.mjs`
- `scripts/ablate-creative-factors.py`

数据：

- 来源：`EmbeddingVector` 中 `embeddingModel='jinaai/jina-clip-v2'` 的 889 条 kalodata 爆款参考视频。
- 特征：1024 维 embedding、benchmark/winner 标签、Qwen 因子、creator、时长、类目。
- 切分：creator-disjoint，train=699 / test=190，达人零重叠。

实验结果：

| 目标                    | A 基线(CLIP) | B 仅因子 | C 融合 |
| ----------------------- | ------------ | -------- | ------ |
| benchmarkScore Spearman | **0.449**    | 0.212    | 0.449  |
| benchmarkScore NDCG@20  | 0.883        | 0.825    | 0.890  |
| benchmarkScore R2       | 0.157        | 0.017    | 0.148  |
| organicWinner AUC       | **0.809**    | 0.652    | 0.808  |

结论：

1. Qwen 创意因子对预测无增量；CLIP embedding 已隐式涵盖 hook、demo 和场景结构。
2. 因子价值在归因/可解释，不在预测精度。正向关联包括 unboxing hook、product_demo hook、高产品露出、首秒露出、手部演示、3+ 场景；负向关联包括 offer hook、before_after hook、产品露出过晚、social_proof hook。
3. 内容信号天花板约 R2=0.16，其余方差来自商品、价格、达人、流量等缺失维度。
4. 线上随机切分数字偏乐观；对外建议使用 creator-disjoint Spearman 0.45 / AUC 0.81。

注意：因子 lift 是关联，不是因果；呈现时必须避免“保证提升转化”等表述。

### CloneCast 评测与性能报告

_生成时间: 2026-05-30T13:55:39.521Z · 索引规模: 889 条 QwenVL 分析爆款 · 留出测试 query: 177 条_

#### 1. 打分模型 — 留出测试集指标 (scorer-model v2)

在 Kalodata 真实电商 GMV/ROAS 数据上训练的 PCA(50)+LightGBM scorer，held-out 测试集表现：

| 指标               | 值         | 含义                        |
| ------------------ | ---------- | --------------------------- |
| AUC (自然流量爆款) | **0.9299** | 区分自然流量爆款的能力      |
| AUC (低粉爆款)     | **0.881**  | 区分低粉爆款的能力          |
| NDCG@20            | **0.9152** | 排序质量                    |
| Spearman           | 0.5028     | 与真实表现的秩相关          |
| MAE                | 0.1133     | benchmarkScore 平均绝对误差 |
| R2                 | 0.2547     | 解释方差                    |

#### 2. 检索质量 — 留出 query 留一法

用 177 条 held-out 视频做 query（排除自身），看 top-K 是否召回同类目爆款：

| 指标           | Qdrant (ANN) | pgvector (暴力) |
| -------------- | ------------ | --------------- |
| categoryHit@1  | 0.4237       | 0.4237          |
| categoryHit@3  | 0.6102       | 0.5989          |
| categoryHit@5  | 0.6441       | 0.6328          |
| categoryHit@10 | 0.7119       | 0.678           |
| 同类目精度@10  | 0.2056       | 0.1746          |

Qdrant vs pgvector top-1 一致率：0.9887。

#### 3. 性能 — 单条 query 延迟

| 阶段                      | p50 (ms) | p95 (ms) | mean (ms) |
| ------------------------- | -------- | -------- | --------- |
| 文本向量化 (jina-clip-v2) | 151.8    | 201.55   | 161.2382  |
| Qdrant ANN 检索           | 9.62     | 14.97    | 10.5382   |
| pgvector 暴力检索         | 197.61   | 224.39   | 201.2862  |

检索默认走 Qdrant ANN；pgvector 仅作历史兼容和离线对照。

复现：

```bash
node scripts/eval-reference-retrieval.mjs
```

<!-- END GENERATED_EVALUATION -->

## 仍需复验/推进

- 完整 Docker `api` / `worker` / `web` 镜像栈尚需复测。
- 完整真实 Seedance 端到端 smoke 仍需按额度和密钥状态执行。
- Qwen-VL 字幕决策要求 raw video URL 可被云端访问；本地 `localhost` 对象 URL 会自动降级本地字幕计划。
- Qdrant-only 链路依赖本地可加载 `jinaai/jina-clip-v2`；首次刷新/检索可能需要下载模型缓存。
- 真实 TikTok/公开电商趋势 adapter 仍是后续增强；当前趋势源以本地 seed 和已导入榜单为主。
