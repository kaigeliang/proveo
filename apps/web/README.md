# 前端工作台

这是参赛项目的中文前端界面，使用 React、TypeScript 和 Vite 构建。

## 本地开发

```bash
npm install
npm run dev
```

默认访问 `http://localhost:5173`，接口代理到 `http://localhost:5001`。

## 界面范围

- 开始页：输入商品链接或说明，通过 `/api/scripts/generate` 生成带因子标记的结构化分镜。
- 素材库：上传素材、生成切片、按 keyword/tag/vector 检索，并保留来源声明。
- 出片页：编辑分镜、单镜重渲染、一键成片、导出预览和合规检查。
- 数据看板：写入或模拟表现数据，查看归因、A/B 对比和因子权重演化。

参赛提交说明保留在根目录 `README.md`，不出现在商家端产品界面。
