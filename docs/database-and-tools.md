# 数据模型与工具

本地使用一个 SQLite 数据库。空库初始化后有 44 张应用表。学习流程新增 3 张业务表、1 张公开检索限额表、1 张迁移版本表。邮箱验证和通知新增 3 张表。新功能与原有流程共用用户、统计事实、对话和额度结构。

| 表 | 字段及用途 |
| --- | --- |
| users | id 是内部整数主键。username 唯一，用于登录。child_name 用于展示。email 是可空的已验证邮箱，同一邮箱允许多个账号。salt、password_hash、role、enabled、created 支撑账号安全和生命周期。 |
| family_links | child_id、parent_id 引用用户，组合主键防止重复绑定，created 记录绑定时间。反向索引支持家长查宝宝。旧表用单个事务补外键，既有绑定完整迁移。 |
| email_codes | email、purpose、username 为组合主键。digest 仅保存校验摘要，issued_at 用于过期和重发，attempts 限制试错。复用 login_limits 限流。 |
| notifications | id 为发布请求的 UUID。author_id 引用管理员。title、body、可空 image、published_at 支持图文及按时间分页。 |
| notification_reads | user_id、notification_id 同时是外键和组合主键。只记录已读通知。按通知删除时通过反向索引级联清理。 |
| practice_sets | id、student_id、request_id、topic_id、created_at、source_set_id、style。student_id 引用用户，source_set_id 关联调题前的练习。每个学生的 request_id 唯一。 |
| practice_items | set_id、id、position、stem、expected_answer、details。组合主键为 (set_id, id)，组内 position 唯一。details 存原题 ID、知识点、难度、题型、选项和分步题小问，标准答案单独保存。旧题继续按原填答题读取。 |
| practice_attempts | set_id、item_id、answer、correct、created_at、elapsed_seconds。组合主键同时是指向题目的组合外键。作答归属沿题目和题组确认。 |
| learning_insight_events | event_key 唯一键，user_id、occurred、kind、question_id、facts、recorded。保存源自竞技场的核对事实、提问事件和历史修正。 |
| study_sessions | id、user_id、client_id、kind、title、context、image_id、created、updated。context 保存已校验的教材页或题目上下文。 |
| study_messages | session_id、seq、role、content、data、at。正文逐条保存。data 存题卡、教材引用或提问时的本题作答与草稿快照。 |
| study_jobs | id、session_id、request_id、prompt、status、partial、stage、error、created、updated。用于重试、恢复和流式快照。 |
| study_images | id、user_id、path、mime、created。文件本体存在私有目录。 |
| learning_source_requests | student_id、created_at。计算公开检索限额并清理该用户的过期记录。 |
| learning_migrations | version。标记已完成的本地结构迁移。 |

用户关联沿用整数主键，且每次由登录会话及有效绑定确认。新题组和题目用 UUID v4。对话和任务继续使用已有 128 位随机 ID，兼容历史链接。JSON 不重复存一份用户 UUID，也不在一个大 JSON 里追加整段会话。当前用户整数 ID 仍由旧接口使用。公开用户标识如需扩展，应先定义调用方和迁移范围。ID 的随机性不能代替鉴权。

对话正文按 (session_id, seq) 查。JSON 只放可选的结构化内容。任务表兼容现有流式接口，仍保留任务 prompt 和已发布的最后快照，重启后供页面恢复或重试。若后续迁移 PostgreSQL，可改用用户消息序号引用问题，终态正文从消息表读取，替换前先验证历史恢复协议。

## 查询与事务

- 学习分析按学生读取已有练习和核对事实。统计按原题合并，取最新有效批改。明细独立分页。排序与图表在事务外计算，生成报表不落新表。
- 题组归属和创建时间使用 practice_sets_student_created。对话顺序使用 study_messages 的组合主键。活跃会话任务使用 study_active_jobs 部分索引。单题作答通过组合主键查找。隔离库的 EXPLAIN QUERY PLAN 已确认这四条查询走索引。样本规模不足以推断线上吞吐量。
- SQLite 使用 WAL，连接都开启外键。创建题组和写入题目在一个事务中。查重和首次作答在一个事务中。相同请求可重放，修改已经提交的答案需要发起新练习。
- 邮箱验证码消费和建号、绑定或重置密码同一事务提交。邮件网络请求在事务外。重置按用户名和邮箱确认账号，用 sessions_by_user 撤销该账号旧登录。
- 发布通知时只写一行。阅读时插入组合键，重试只保留一行。未读量以通知总数减当前账号已读数。编辑保留已读，删除通过外键级联清除已读记录。
- 对话入队先核对会话归属，再预留额度和写入用户消息。每个会话仅允许一个活跃任务。最终消息、任务结束和额度结算在同一提交中，模型调用在事务外。重启释放未完成任务的额度，学生可以重试。
- PostgreSQL 迁移单独执行。用唯一约束保护幂等请求，用会话行锁或条件更新协调消息序号。任务消费者在确需多进程时再引入租约。迁移期间保持单一权威写库，逐项验证家庭归属、作答结果、消息顺序和额度。

## Function tooling

app/backend/agent/skills/child-tutor/SKILL.md 在组装教学提示时加载。首批六个知识点提供离线讲解。涉多个知识点时页面分别显示教材链接。

常见知识点按规则快速检索。用户明确要找教材出处且结果不足时，模型可以提出一次 search_textbook 调用。参数形如 {"terms":["运算律","交换律"]}。教材 ID 由会话授权，模型参数不能替换。模型规划请求只接受完整工具参数，讲解仍复用原有流式通道。工具查到的片段作为材料，教材链接由服务端按书和真实页码组装。

公开检索由页面“找更多公开资料”触发。search_public_sources 仅接受已有 topicId，例如 {"topicId":"decimal"}。Tavily 收到的是服务端拼接的知识词语，返回结果经过域名筛选。每个学生滚动 24 小时最多十次。

可对照 [Pi Agent](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)、[DeepSeek Harness 工具](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/README.md)、[Agent Journey 多智能体适用边界](https://www.agent-journey.cn/knowledge?activeKey=multi-agent) 和 [Function Calling](https://www.agent-journey.cn/knowledge?activeKey=function-calling)。面试可用并发创建、重复作答、答疑入队和真实页码说明幂等、事务边界及工具鉴权。
