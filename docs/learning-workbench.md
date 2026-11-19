# 智能小爪陪你学工作台

把「今天学什么」升级为首页主卡，点卡直接进入做题工作台。沿用伴学爪的配色、圆角、爪爪形象、导航和字号设置。复用已有题组、讲解、教材跳页及流式答疑。 [首页与练习](../app/frontend/learning/personal-learning.js) · [答疑组件](../app/frontend/study/study-ui.js) · [原分析报告方案](learning-agent-redesign.md)

## 新增交互

| 区域 | 展示与操作 |
| --- | --- |
| 首页卡片 | 浅蓝玻璃、小范围流光、原爪爪角色。首屏只放一个薄弱点、一条来自作答记录的依据及「练 5 道」「看分析」。 |
| 答题区 | 一行放知识点、进度、上一题和下一题。题干、输入框与提交优先可见。提交后在原位展开验算、简短解析和教材页。记录充足时提供「下一组」。 |
| 对话区 | 复用「问爪爪」，加当前题标签、「给个提示」「讲个例子」「看教材」三个快捷提问。桌面在答题区侧边并排，手机从吸附侧展开为可拉伸的半高抽屉。 |
| 边缘小爪 | 收起时变成固定在左缘或右缘的 36px 角色。拖动松手后吸到最近一侧，纵向限制在安全区。松手时保存左右方向和相对高度。生成中用一个小点提示。 |

开合借鉴 macOS 窗口最小化的收放动效。面板向角色位置收窄，约 240ms，展开沿原路径返回。以指针捕获区分拖动和点击，减少动态效果模式用短淡入淡出。收起只改变显示，草稿、作答进度和流式任务仍可恢复。 [macOS 窗口动画设置](https://support.apple.com/sr-rs/guide/mac-help/mchlp1119/mac) · [Pointer Capture](https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture)

紧凑档题干和聊天正文约 14px，题号及标签 11–12px，卡片间距 6–8px。手机答题输入框保持 16px，公式、图示和长解析按需展开。沿用个人中心字号设置，在 320px 宽屏幕上检查答题和提交可见性。

## 后台 Agent

1. **汇总与计划。** 服务端从批改结果、错题类型、有效用时和提问主题汇总证据。提问作为卡点线索，正确率由已批改作答计算。首批组题用「薄弱点 3 道、前置 1 道、复习 1 道」，下一组根据验算结果调整。作答步骤能证明小数点没对齐时，先讲位值并加入对齐题。只有最终答案时，说明错在小数加法并引导学生自查步骤。样本不足时沿用入门题。
2. **知识点元数据。** 扩展现有 `topics.py`，增加 `subject`、`grade`、`difficulty`、`prerequisiteIds`、`commonErrorCodes`、`bookRefs` 和 `version`。知识点 ID 稳定，前置关系与相关推荐独立。后台校验版本、页码和前置关系。Agent 动态调整学生练习优先级、难度和讲解方式，课程元数据的改动由审核发布。题组在创建时固定题目版本。
3. **工具与讲解。** 限定 Agent 可请求 `get_topic_metadata(topicIds)`、现有 `search_textbook(terms)` 和 `propose_practice_plan(items)`。模型计划只包含知识点 ID、题数、难度和证据编号。服务端从登录和题组推导学生归属，校验计划，再生成可验算的题。绑定 `setId` 与 `itemId` 获取当前题上下文。提交前给一步提示或同型例子，提交后讲错因、验算和教材页。
4. **存储与恢复。** 复用 `practice_sets`、`practice_items`、`practice_attempts` 和 `study_sessions`、`study_messages`、`study_jobs`。用 `request_id` 幂等创建题组。收起后保留任务 ID，重开先取快照再继续流式接收。诊断和组题仍有规则方案，当前演示环境的真实大模型调用需配置后联调。工作台沿用 22 张表的迁移目标。 [知识点](../app/backend/learning/topics.py) · [教学工具](../app/backend/agent/teaching_tools.py) · [作答事务](../app/backend/storage/learning.py) · [对话任务](../app/backend/learning/learning_history.py)

## 面试题与项目场景

| 面试问法 | 用本项目作答 |
| --- | --- |
| Function Calling 如何鉴权和校验参数？ | `search_textbook` 只传术语，服务端从会话确定教材权限。`propose_practice_plan` 只提议知识点和题数，服务端校验并执行。 [Agent Journey 工具调用](https://www.agent-journey.cn/knowledge?activeKey=function-calling) |
| RAG 怎么验证引用真实？ | 以教材页为检索单位，服务端返回书 ID、页码和摘录。验证链接可跳到证据页，同时检查命中率和引用准确性。 |
| SSE 断线或收起怎么恢复？ | 提问用 POST，回复用 SSE。用 `job_id` 恢复任务快照并续接，重复请求复用任务。 [SSE 规范说明](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events) |
| 重复点击如何防止重复题组或扣费？ | `(student_id, request_id)` 约束题组创建。同一事务保存题目，扣费按自己的幂等键结算。SQLite WAL 仍串行写入，模型调用在事务外。 [SQLite WAL](https://www.sqlite.org/wal.html) |
| Agent 组题和解释如何评测？ | 固定一批匿名答题记录，检查推荐命中薄弱点、题目可验算、提交前提示分级、教材页准确、模型超时可降级。 |

## 实施与验收

1. 首页卡和紧凑答题框。复用现有题组，验证「小数 5 题错 3 题」可点进练习和 30 天报告。
2. 元数据和分级讲解。提交后按证据调整下一组，同一请求只生成一组。教材链接、答案和知识点均可核对。
3. 小爪吸附与对话面板。验证左右吸附、连续收放、320px 窄屏出键盘、刷新续做和断网重连。收放期间保留题目与草稿，重开沿用原对话任务。
