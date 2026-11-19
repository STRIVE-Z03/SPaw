# 伴学爪本地开发

运行 ./run-local.sh 后打开 http://127.0.0.1:18768/ 。开发库位于 .local/demo，教材位于 教材。初次可以注册测试学生。

首次检出运行 `python3 app/deployment/install_browser_assets.py`，再在虚拟环境里安装 `app/requirements.txt`。浏览器依赖按版本和校验值恢复。Python 建议使用 3.12。隔离库生成的本机管理员初始密码保存在 .local/demo/admin-bootstrap.txt。

公开仓库提供应用和 OCR 服务源码。OCR 服务需独立配置 PaddleOCR 及对应模型。

- app/backend/identity 管理账号、绑定与额度。
- app/backend/materials 管理教材和语音等资料。
- app/backend/learning 管理章节题、学习记录、题组与补缺。
- app/backend/agent 管理教学任务、工具、提示、模型路由与流式解码。
- app/backend/storage 管理新功能的事务和数据结构。
- app/backend/http 管理新接口及公开文件映射。app/server.py 保持原启动入口。
- app/frontend 按站点框架、学习、答疑、账号、媒体与样式分目录。网页仍使用原有公共资源地址。

复制 `.env.example` 为 `.env.local` 后按需配置。模型、Tavily 和 QQ 发信的密钥均从服务端环境读取。管理员可在「AI 设置」更新模型线路和 Tavily 密钥，并测试连通。后台保存到权限为 0600 的环境文件，页面只显示配置状态。启动时注入的环境变量优先。无模型配置时，使用本地讲解和规则验算。

专项练习可独立配置 `PAW_PRACTICE_AI_BASE_URL`、`PAW_PRACTICE_AI_API_KEY` 和 `PAW_PRACTICE_AI_MODEL`。模型收到学生主动提问时的本题作答和草稿。提交后以服务端批改为准，讲解按步骤核对。下一组结合竞技场与小爪练习的最新批改，从竞技场题库调整知识点、难度和题量。累计 10 道实判原题可在学生首页「看分析」查看知识图。

真实模型冒烟用 `node tests/smoke_practice_ui.cjs`，需要 Playwright 和 Chromium。使用 `PAW_SMOKE_OFFLINE=1` 可验证本地讲解和图表。可用 `PLAYWRIGHT_PATH` 和 `PAW_SMOKE_CHROME` 指定已有安装。脚本使用独立测试库和模拟学生，截图输出到 `.local/verification/practice-smoke`。

QQ 邮箱验证码发送需要在私有配置中填写 `PAW_SMTP_ADDRESS` 和 `PAW_SMTP_AUTHORIZATION`，再重启应用。授权码由发信邮箱生成。宝宝和家长可共用收件邮箱，各自使用用户名登录和重置密码。未绑定邮箱的旧账号仍可联系管理员恢复。

管理员可从左侧菜单或手机后台页签进入通知管理。发布前可预览正文和配图。编辑保留各账号的已读状态，删除同步移除已读记录。用户点开单条通知后，铃铛角标才扣减。

运行 .venv/bin/python -m unittest discover -s tests -v 验证。数据库和工具合同见 [数据模型与工具](docs/database-and-tools.md)。

## 教材与练习册整理

本机已安好的运行环境可导出 `Markdown + 原图 + 题目索引 + 可搜索 PDF`。首次使用额外安装 `reportlab`。

```sh
.venv/bin/python app/deployment/material_pack.py --arena-course 053036a4fe1e644148d9
.venv/bin/python app/deployment/material_pack.py --input "教材/课本.pdf" --pages 9-10 --questions --section 四则运算
```

普通 PDF 使用现有文字层。图片、扫描 PDF 或 `--questions` 使用 macOS 本机识别，也可用 `--ocr-url` 连接项目 OCR 服务。其他系统通过 `--font` 指定支持中文的 TrueType 字体。自动切题后保留原页和题目截图，识别稿标为待核对。

管理员在「后台 → 资料 → 已整理的 Markdown / PDF」预览或下载。文件默认输出到 `output/pdf`，可用 `BANXUEPAW_PACK_DIR` 指定站点读取的目录。进入智能组题的题目使用核对后的竞技场版本。

公开仓库提供代码、依赖清单及配置模板。教材及索引、竞技场归档、人工复核索引、语文语料及音频、扫描输出与开发库在本机另行配置。竞技场通过 `BANXUEPAW_ARENA_DATA` 指向归档，复核索引通过 `BANXUEPAW_ARENA_REVIEW_FILE` 指向私有 JSON。缺少样本时，涉及这些资料的集成测试自动跳过。
