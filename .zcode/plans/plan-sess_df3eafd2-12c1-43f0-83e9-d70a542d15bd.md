# 论文研究型 Agent Harness 开发计划

## 目标

在 `/root/projects/Hyra_rebuild` 从零开发一个**论文研究型 agent harness**(暂定名 `paperlab`):输入一个研究主题,自动完成"文献调研 → 研究方案 → 实验执行 → 结果解读 → 论文写作 → 评审修改",输出一篇**有真实实验数据支撑**的论文 PDF 和全过程 artifacts。

定位是 AgentLaboratory 的现代化重写(借鉴其阶段结构与角色设定),以 pi coding agent 作为底层 agent 运行时(沿用之前确认的决策:TypeScript 编排器 + DeepSeek/GLM/Kimi/Qwen 模型)。

## 借鉴什么、修复什么

**从 AgentLaboratory 借鉴**:六阶段流水线、PhD/Postdoc/MLEngineer/Reviewer 角色对话、copilot 模式(其论文核心发现:阶段性人工反馈显著提升质量)。

**修复它的已知硬伤**(调研确认的):
- 文献调研太浅(仅 5 篇摘要、无 bibtex 无作者)→ 用 Semantic Scholar + arXiv + OpenAlex,产出结构化 papers.jsonl + 真实 bibtex
- `exec()` 直接跑 LLM 代码、无沙箱 → 实验代码进 Docker
- LaTeX 编译失败只返回"Compilation failed"不给日志 → 完整编译链 + 日志解析回喂 agent
- 用 LLM 打分代替真实指标 → 强制 metrics.json 纪律(下述"反造假设计")

**从现代项目吸收**(AI-Scientist-v2 / MLR-Bench / co-scientist 的教训):MLR-Bench 发现 coding agent 实验造假率约 80%、论文流畅掩盖实验空洞——所以本 harness 的核心差异化是**实验真实性优先于文采**。

## 架构

```
Hyra_rebuild/
├── package.json            # tsx + @earendil-works/pi-coding-agent (含 SDK) + pi-ai
├── config.example.yaml     # 角色→模型映射、预算、copilot 开关
└── src/
    ├── cli.ts              # `paperlab run --topic "..." | --config x.yaml`
    ├── config.ts           # 加载配置;模型: deepseek/zai(GLM)/moonshot/qwen 走 pi-ai 原生 provider
    ├── orchestrator.ts     # 阶段流水线 + JSON checkpoint(可断点恢复,不是 pickle)
    ├── core/
    │   ├── agent.ts        # pi 封装: createAgentSession + systemPromptOverride + 阶段性 customTools
    │   └── run-store.ts    # run 目录 artifacts 落盘 + tokens.json 成本跟踪
    ├── roles/              # 各角色 system prompt(phd / postdoc / mlengineer / reviewer / ac)
    ├── phases/
    │   ├── 1-literature.ts
    │   ├── 2-plan.ts
    │   ├── 3-experiment.ts
    │   ├── 4-interpret.ts
    │   ├── 5-write.ts
    │   └── 6-review.ts
    └── tools/              # defineTool 实现(按阶段注入)
        ├── paper-search.ts # s2_search / arxiv_search / openalex(限速 S2≤1RPS,重试)
        ├── sandbox.ts      # run_python:Docker 优先,探测不到降级本地子进程+cwd隔离+超时
        └── latex.ts        # pdflatex→bibtex→pdflatex→pdflatex(或 tectonic),日志解析成结构化错误
```

每个阶段 = 一个(或一对)pi session:`DefaultResourceLoader({ systemPromptOverride })` 设角色,`customTools` 只注入该阶段工具(pi 无权限门、工具自动执行,所以工具集按阶段最小化)。

## 六阶段流水线

1. **文献调研**(PhD):工具检索论文 → `papers.jsonl`(题目/作者/年份/摘要/bibtex/一句话笔记)+ 综述 `related_work.md`
2. **方案制定**(Postdoc↔PhD 对话):产出 `plan.json`——假设、新颖性声明(对照文献查重)、数据集、baseline、指标、实验步骤、消融、成功判据;copilot 模式下此处人工确认
3. **实验执行**(MLEngineer,最重的阶段):在沙箱里按 baseline → 主方法 → 消融顺序写代码跑实验;**必须**产出 `metrics.json` 和图表数据(CSV/NPY);代码、日志全落盘;debug 循环有界(错误历史防重复,失败回退)
4. **结果解读**(Postdoc↔PhD):`findings.md`——上下文直接注入 metrics.json 文件内容,所有数字有出处
5. **论文写作**:单遍生成全文 LaTeX + reflection 循环(默认 3 轮),反馈 = 编译日志解析 + 引用核对(只允许引用 papers.jsonl 里真实存在的 bibtex)+ 页数检查;图表只允许由实验产物生成的 matplotlib 脚本产出
6. **评审修改**:3 个 persona 的 NeurIPS 式评审 + Area Chair meta-review;**评审输入 = PDF + 实验代码 + 日志 + metrics.json**(不只读 prose,针对评审投机);有界修改(默认 2 轮),最终评分报告

**反造假三原则**(贯穿架构):实验数字只能来自 metrics.json 注入、reviewer 必须审查代码与日志、图必须由实验数据生成。

**Run 目录结构**:`runs/<topic-slug>/<timestamp>/` 下放全部中间产物,任一阶段后可 `--resume` 恢复。

## 沙箱与工具链(运行时自动探测)

- 实验执行:`sandbox=docker`(每 run 一个容器,docker exec 跑代码)→ 探测不到 docker 则 `local`(子进程 + 独立 cwd + 超时 + 明确警告)
- LaTeX:系统 pdflatex → tectonic 单二进制 → docker texlive 镜像,逐级探测

## 里程碑(建议顺序,每步可独立验证)

1. **M1 骨架**:scaffold + pi session 封装 + 角色 prompt 框架 + run-store + 配置加载(验证:两个角色跑通一段对话)
2. **M2 文献阶段**(验证:真实主题检索出带 bibtex 的论文列表)
3. **M3 方案阶段**(验证:plan.json 结构完整)
4. **M4 实验阶段**(验证:沙箱里跑通一个小实验并产出 metrics.json + debug 循环生效)
5. **M5 写作阶段**(验证:含真实引用和真实图表的 PDF 编译通过)
6. **M6 评审阶段**(验证:三份评审 + meta-review 落盘)
7. **M7 收尾**:copilot 人工门 + 断点恢复 + 端到端 demo(CPU-only 主题,如开放数据集上的模型对比+改进)

**最终验收**:端到端跑通一个主题,论文中每一个数字都能溯源到 `metrics.json`,PDF 编译零错误。

## 明确不做(MVP 范围外,留作演进)

Elo 锦标赛选题(co-scientist 式)、多 lab 并行、跨 run 共享论文库(AgentRxiv 式)、GPU 训练任务、自动投稿。
