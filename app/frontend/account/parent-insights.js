(function () {
  "use strict";
  let app,
    owner = "",
    focus = "",
    epoch = 0,
    requestNumber = 0,
    detailNumber = 0,
    data = null,
    detail = null,
    error = "",
    detailError = "",
    loading = false,
    loadingKey = "",
    detailLoading = false,
    period = "month",
    activeRange = null,
    rangeDraft = { from: "", to: "" },
    rangeOpen = false,
    questionLimit = 20;
  const cache = new Map(),
    labels = {
      free: "问爪爪",
      photo: "拍照提问",
      homework: "检查作业",
      book: "教材答疑",
      arena: "章节答疑",
      practice: "专项练习答疑",
      legacy: "原有提问",
    };
  const count = (value) =>
    Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  const esc = (value) => app.esc(value),
    allowed = () => ["parent", "admin"].includes(app?.user()?.role);
  const actor = () =>
    allowed() && app.childId?.()
      ? String(app.user().id) +
        ":" +
        app.user().role +
        ":" +
        String(app.childId())
      : "";
  const today = () =>
    new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  function reset(next) {
    owner = next;
    epoch++;
    requestNumber++;
    detailNumber++;
    data = null;
    detail = null;
    error = "";
    detailError = "";
    loading = false;
    loadingKey = "";
    detailLoading = false;
    period = "month";
    activeRange = null;
    rangeDraft = { from: today().slice(0, 8) + "01", to: today() };
    rangeOpen = false;
    questionLimit = 20;
    focus = "";
    cache.clear();
  }
  function key() {
    return (
      owner +
      ":" +
      period +
      ":" +
      (activeRange?.from || "") +
      ":" +
      (activeRange?.to || "")
    );
  }
  function refresh() {
    if (actor() === owner && allowed()) app.render();
  }
  function query() {
    const params = new URLSearchParams({
      childId: String(app.childId()),
      period,
    });
    if (activeRange) {
      params.set("from", activeRange.from);
      params.set("to", activeRange.to);
    }
    return "/api/parent/insights?" + params;
  }
  async function load(force = false) {
    const queryKey = key(),
      cached = cache.get(queryKey);
    if (!owner || owner !== actor() || (loading && loadingKey === queryKey))
      return;
    if (!force && cached && Date.now() - cached.at < 15000) {
      data = cached.value;
      return;
    }
    loading = true;
    loadingKey = queryKey;
    error = "";
    detail = null;
    detailNumber++;
    const stamp = epoch,
      number = ++requestNumber,
      identity = owner;
    data = cached?.value || null;
    refresh();
    try {
      const result = await app.api(query());
      if (
        stamp !== epoch ||
        identity !== actor() ||
        number !== requestNumber ||
        queryKey !== key()
      )
        return;
      const value = result?.insights?.totals
        ? result.insights
        : result?.summary?.totals
          ? result.summary
          : result;
      if (!value?.totals || !Array.isArray(value.byDay))
        throw new Error("invalid insights");
      data = { ...value, requestKey: queryKey };
      cache.set(queryKey, { value: data, at: Date.now() });
    } catch (_) {
      if (stamp === epoch && identity === actor() && number === requestNumber)
        error =
          "学习记录暂时没有同步，请稍后重新读取。已有草稿和记录不会受影响。";
    } finally {
      if (stamp === epoch && identity === actor() && number === requestNumber) {
        loading = false;
        loadingKey = "";
        refresh();
      }
    }
  }
  function dates() {
    return data?.period
      ? `${data.period.from || data.period.fromDate} 至 ${data.period.to || data.period.toDate}`
      : "正在读取日期范围";
  }
  function barChart() {
    let rows = data.byDay;
    if (rows.length > 45) {
      const chunks = [];
      for (let i = 0; i < rows.length; i += 7) {
        const batch = rows.slice(i, i + 7);
        chunks.push({
          date: batch[0].date,
          toDate: batch.at(-1).date,
          correct: batch.reduce((sum, r) => sum + count(r.correct), 0),
          check: batch.reduce((sum, r) => sum + count(r.check), 0),
          uncertain: batch.reduce((sum, r) => sum + count(r.uncertain), 0),
        });
      }
      rows = chunks;
    }
    const maximum = Math.max(
      1,
      ...rows.map(
        (r) => count(r.correct) + count(r.check) + count(r.uncertain),
      ),
    );
    return `<figure class="insight-main-chart"><figcaption><strong>${data.byDay.length > 45 ? "每周核对记录" : "每日核对记录"}</strong><small>点击日期，查看对应的学习与提问</small></figcaption><div class="insight-bars" role="group" aria-label="每日答对、需检查和未确定记录">${rows
      .map((r, index) => {
        const total = count(r.correct) + count(r.check) + count(r.uncertain),
          height = total ? Math.max(8, (total / maximum) * 96) : 2;
        return `<button type="button" data-insight-day="${esc(r.date)}" ${r.toDate ? `data-to="${esc(r.toDate)}"` : ""} aria-label="${esc(r.date)}：答对${count(r.correct)}，需检查${count(r.check)}，未确定${count(r.uncertain)}"><span class="insight-bar-value">${total || ""}</span><span class="insight-bar" style="height:${height}px">${total ? `<i class="uncertain" style="height:${(count(r.uncertain) / total) * 100}%"></i><i class="check" style="height:${(count(r.check) / total) * 100}%"></i><i class="correct" style="height:${(count(r.correct) / total) * 100}%"></i>` : ""}</span><small>${rows.length <= 8 || index === 0 || index === rows.length - 1 || index % 5 === 0 ? esc(r.date.slice(5)) : ""}</small></button>`;
      })
      .join(
        "",
      )}</div><div class="insight-legend"><span><i class="correct"></i>答对</span><span><i class="check"></i>需检查</span><span><i class="uncertain"></i>未确定</span></div><p>同一题跨天重练会分别显示；区间总数按题目去重，不能直接相加。</p></figure>`;
  }
  function distribution() {
    const rows = [
        ["correct", "答对", count(data.totals.correct), "#3b82f6"],
        ["check", "需检查", count(data.totals.check), "#e6a24b"],
        ["uncertain", "未确定", count(data.totals.uncertain), "#a8b0bc"],
      ],
      total = rows.reduce((sum, r) => sum + r[2], 0);
    let offset = 0;
    const slices = rows
      .map(([id, label, value, color]) => {
        const fraction = total ? (value / total) * 100 : 0,
          result = `<circle cx="50" cy="50" r="35" fill="none" stroke="${color}" stroke-width="14" pathLength="100" stroke-dasharray="${fraction} ${100 - fraction}" stroke-dashoffset="${-offset}" transform="rotate(-90 50 50)"></circle>`;
        offset += fraction;
        return result;
      })
      .join("");
    return `<details class="insight-distribution"><summary>查看分布与学习活动</summary><div class="insight-distribution-body">${total ? `<svg viewBox="0 0 100 100" role="img" aria-label="本区间核对结果分布">${slices}<text x="50" y="49" text-anchor="middle">${total}</text><text x="50" y="61" text-anchor="middle" class="insight-chart-unit">题</text></svg>` : "<p>暂无可展示的核对样本。</p>"}<div>${rows.map(([, label, value]) => `<p>${label}<strong>${value} 道</strong></p>`).join("")}<p>当前草稿<strong>${count(data.totals.drafts)} 道</strong></p><p>阅读记录<strong>${count(data.totals.readingPages)} 页次</strong></p><p>活跃学习<strong>${count(data.totals.studyMinutes)} 分钟</strong></p></div></div><div class="insight-category-lines"><p><strong>练习学科：</strong>${(data.bySubject || []).map((r) => esc(r.label) + " " + count(r.graded) + "题").join(" · ") || "暂无已核对样本"}</p><p><strong>练习题型：</strong>${(data.byTaskKind || []).map((r) => esc(r.label) + " " + count(r.graded) + "题").join(" · ") || "暂无已核对样本"}</p></div><small>草稿和未确定结果不计入答错；页次来自逐日记录，不等于阅读能力评分。</small></details>`;
  }
  function points() {
    const weak = data.needsPractice || [],
      improved = data.improving || [],
      rows = data.knowledgePoints || [],
      minimum = count(data.minSamples) || 5;
    return `<section class="insight-knowledge"><h3>值得陪着再想一想</h3>${
      weak.length
        ? weak
            .slice(0, 5)
            .map(
              (p) =>
                `<div class="insight-point-row"><span><strong>${esc(p.label)}</strong><small>${esc(p.chapterTitle || "")} · ${count(p.graded)}道已核对题</small></span><b>${count(p.check)}道需再检查</b></div>`,
            )
            .join("")
        : `<p>暂未发现达到${minimum}道独立样本的待巩固知识点。少量记录不急着贴标签。</p>`
    }${
      improved.length
        ? `<h4>本期记录有变化</h4>${improved
            .slice(0, 4)
            .map(
              (p) =>
                `<p>${esc(p.label)}：核对一致率较前一同长度区间提高${count(p.delta)}个百分点（本期${count(p.graded)}题，上期${count(p.previousGraded)}题）。</p>`,
            )
            .join("")}`
        : ""
    }<details><summary>全部知识点与比较依据（${rows.length}项）</summary><p>至少${minimum}道样本后才标记待巩固；两期都达到样本数才比较变化。题目和难度可能不同。</p><div class="insight-point-table"><table><thead><tr><th>知识点 / 章节</th><th>本期答对</th><th>前期答对比例</th><th>记录变化</th></tr></thead><tbody>${rows.map((p) => `<tr><td>${esc(p.label)}<small>${esc(p.chapterTitle || "")}</small></td><td>${count(p.correct)}/${count(p.graded)}${p.status === "insufficient" ? "<small>样本不足</small>" : ""}</td><td>${count(p.previousGraded) >= minimum && p.previousAccuracy !== null ? esc(p.previousAccuracy) + "%" : "样本不足"}</td><td>${p.delta !== null && p.delta !== undefined ? (Number(p.delta) > 0 ? "+" : "") + esc(p.delta) + "个百分点" : "暂不比较"}</td></tr>`).join("") || '<tr><td colspan="4">尚无可归类的知识点记录。</td></tr>'}</tbody></table></div></details></section>`;
  }
  function questionList() {
    const rows = (data.questions || []).slice(0, questionLimit);
    return `<section class="insight-questions"><h3>这段时间，孩子都问了什么</h3><p>${count(data.questionCount)}次提问统计；当前可查原文${count(data.availableQuestionCount)}条。</p>${rows.map((q) => `<button type="button" class="insight-question-row" data-insight-question="${esc(q.id)}"><span><small>${new Date(q.at * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} · ${esc(labels[q.kind] || "学习提问")}${q.hasImage ? " · 有原图" : ""}</small><strong>${esc((q.questionText || q.title || "查看这次提问").slice(0, 150))}</strong></span><span aria-hidden="true">›</span></button>`).join("") || "<p>这个区间没有仍在保留期内的提问原文。过期内容只保留统计，不会补写。</p>"}${questionLimit < (data.questions || []).length ? '<button type="button" class="text-action" data-insight-more>再看20条</button>' : ""}${data.hasMoreQuestions ? "<small>当前展示最近200条原文，可选择某一天或缩短日期范围查看更多。</small>" : ""}</section>`;
  }
  function detailPage() {
    return `<section class="parent-insight-detail"><button type="button" class="text-action" data-insight-back>‹ ${focus === "questions" ? "返回提问列表" : "返回学习洞察"}</button><h2>${esc(detail?.title || "提问记录")}</h2><p>仅查看孩子已保存的原文；家长自己的问爪爪会话保持独立。</p>${detailLoading ? '<p role="status">正在读取这次提问…</p>' : ""}${detailError ? `<p class="error-banner">${esc(detailError)}</p>` : ""}${detail?.hasImage && /^[a-f0-9]{32}$/.test(detail.id) ? `<a class="insight-original-image" href="/api/parent/questions/${detail.id}/image?childId=${encodeURIComponent(app.childId())}" target="_blank" rel="noopener"><img src="/api/parent/questions/${detail.id}/image?childId=${encodeURIComponent(app.childId())}" alt="这次提问的原图"><span>查看完整原图</span></a>` : ""}${(detail?.messages || []).map((m) => `<article class="insight-message"><small>${m.role === "assistant" ? "爪爪的回复" : "孩子的提问"}${m.at ? " · " + new Date(m.at * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : ""}</small><div>${m.role === "assistant" && window.BX_CHAT ? window.BX_CHAT.markdown(m.content) : esc(m.content).replace(/\n/g, "<br>")}</div></article>`).join("")}</section>`;
  }
  const styles = `<style>.parent-insights{max-width:880px;margin:auto;min-width:0;color:var(--bx-ink,#20242c)}.insight-title{display:flex;justify-content:space-between;gap:12px;align-items:center}.insight-title h2,.parent-insight-detail h2{font-size:20px;margin:0}.insight-title button{font-size:12px;min-height:40px}.insight-date{font-size:12px;color:var(--bx-muted,#687180);line-height:1.8;margin:4px 0 10px}.insight-periods{display:flex;gap:5px;align-items:center;margin:10px 0}.insight-periods>button{font-size:13px;min-height:40px;padding:7px 16px;border:0;border-radius:8px;background:#f2f4f7;color:#566174}.insight-periods>button.active{background:#edf3ff;color:#2563eb}.insight-range{margin-left:auto;font-size:12px;position:relative}.insight-range>summary{min-height:40px;display:flex;align-items:center;cursor:pointer;padding:6px}.insight-range-form{display:grid;gap:10px;position:absolute;z-index:30;right:0;top:42px;width:min(290px,80vw);padding:14px;background:#fff;border:1px solid #e5e8ee;border-radius:10px;box-shadow:0 8px 24px #24364b14}.insight-range-form label{font-size:12px;display:grid;gap:4px}.insight-range-form input{min-height:40px;width:100%;border:1px solid #e5e8ee;border-radius:8px;padding:7px}.insight-range-form button{min-height:40px;font-size:13px}.insight-kpis{display:grid;grid-template-columns:repeat(3,1fr);padding:14px 0;border-top:1px solid #eef1f5;border-bottom:1px solid #eef1f5;gap:10px}.insight-kpis strong,.insight-kpis small{display:block}.insight-kpis strong{font-size:22px;font-weight:600;line-height:1.5}.insight-kpis small{font-size:11px;color:var(--bx-muted,#687180)}.insight-main-chart{margin:18px 0}.insight-main-chart figcaption strong{font-size:15px}.insight-main-chart figcaption small{display:block;font-size:11px;color:var(--bx-muted,#687180);margin:3px 0}.insight-bars{display:flex;align-items:flex-end;gap:4px;overflow-x:auto;padding:16px 0 3px;min-height:150px;overscroll-behavior:contain}.insight-bars>button{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:4px;flex:1;min-width:18px;max-width:56px;padding:0;min-height:140px;border:0;background:transparent;font-size:10px}.insight-bars>button>small{display:block;font-size:9px;min-height:15px;white-space:nowrap;color:#687180}.insight-bar-value{font-size:10px;color:#687180}.insight-bar{width:100%;max-width:24px;min-width:10px;background:#e9edf3;border-radius:3px 3px 0 0;overflow:hidden;display:flex;flex-direction:column}.insight-bar>i{display:block;flex-shrink:0;min-height:0}.insight-legend{display:flex;gap:16px;font-size:11px;color:#687180;margin-top:8px}.insight-legend>span{display:flex;gap:4px;align-items:center}.insight-legend i{display:block;width:8px;height:8px;border-radius:2px}.insight-bars .correct,.insight-legend .correct{background:#3b82f6}.insight-bars .check,.insight-legend .check{background:#e6a24b}.insight-bars .uncertain,.insight-legend .uncertain{background:#a8b0bc}.insight-main-chart>p,.insight-knowledge>p,.insight-questions>p,.insight-summary>p,.insight-distribution>small{font-size:12px;line-height:1.8;color:#687180}.insight-distribution,.insight-knowledge,.insight-questions,.insight-summary,.insight-limitations{border-top:1px solid #eef1f5;padding:14px 0}.insight-distribution>summary,.insight-knowledge details>summary,.insight-limitations>summary{min-height:40px;display:flex;align-items:center;font-size:13px;cursor:pointer}.insight-distribution-body{display:flex;gap:24px;align-items:center;padding:8px 0}.insight-distribution svg{width:128px;height:128px;flex-shrink:0}.insight-distribution text{font-size:17px;fill:#20242c}.insight-distribution .insight-chart-unit{font-size:9px;fill:#687180}.insight-distribution-body>div{flex:1;font-size:12px}.insight-category-lines{font-size:12px;line-height:1.8;color:#687180}.insight-category-lines strong{font-weight:500;color:#4b5563}.insight-distribution-body p{display:flex;justify-content:space-between;gap:10px;margin:6px 0}.insight-distribution-body strong{font-weight:500}.insight-knowledge h3,.insight-questions h3,.insight-summary h3{font-size:15px;margin:0 0 9px}.insight-knowledge h4{font-size:13px;margin:16px 0 8px}.insight-point-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0}.insight-point-row strong,.insight-point-row small{display:block}.insight-point-row strong{font-size:14px;font-weight:500}.insight-point-row small{font-size:11px;color:#687180;line-height:1.8}.insight-point-row>b{font-size:12px;color:#977032;font-weight:500;flex-shrink:0}.insight-knowledge details>p,.insight-limitations p{font-size:12px;line-height:1.8;color:#687180}.insight-point-table{overflow:auto}.insight-point-table table{width:100%;min-width:480px;font-size:12px;border-collapse:collapse}.insight-point-table th,.insight-point-table td{text-align:left;padding:9px 8px;border-bottom:1px solid #eef1f5;font-weight:400}.insight-point-table small{display:block;color:#687180;font-size:10px}.insight-question-row{width:100%;display:flex;gap:12px;align-items:center;justify-content:space-between;padding:11px 0;border:0;border-bottom:1px solid #f1f3f6;border-radius:0;background:#fff;text-align:left;color:#20242c;min-height:52px}.insight-question-row>span:first-child{min-width:0;flex:1}.insight-question-row small{display:block;font-size:11px;color:#687180;line-height:1.7}.insight-question-row strong{font-size:13px;line-height:1.7;font-weight:400;overflow-wrap:anywhere;display:block}.insight-questions>small{font-size:11px;color:#687180}.parent-insight-detail{min-width:0}.parent-insight-detail>p{font-size:12px;line-height:1.8;color:#687180}.insight-message{padding:14px 0;border-bottom:1px solid #eef1f5;font-size:14px;line-height:1.85;overflow-wrap:anywhere}.insight-message>small{font-size:11px;color:#687180;display:block;margin-bottom:6px}.insight-original-image{display:block;max-width:100%;font-size:12px;color:#687180}.insight-original-image img{display:block;max-width:100%;max-height:55dvh;height:auto;object-fit:contain}.parent-insights .error-banner{font-size:13px;line-height:1.8}@media(max-width:600px){.insight-kpis strong{font-size:20px}.insight-periods>button{padding:7px 13px}.insight-point-row{align-items:flex-start}.insight-distribution-body{gap:16px}.insight-question-row strong{font-size:13px}.insight-title h2{font-size:18px}}</style>`;
  function page(value) {
    app = value;
    const next = actor();
    if (next !== owner) reset(next);
    if (!allowed())
      return '<p class="empty-state">学习洞察仅供已绑定的家长查看。</p>';
    if (!next) return '<p class="empty-state">请先绑定并选择要查看的宝宝。</p>';
    const nextFocus = app.focus === "questions" ? "questions" : "";
    if (nextFocus !== focus) {
      focus = nextFocus;
      detailNumber++;
      detail = null;
      detailError = "";
      detailLoading = false;
    }
    const cached = cache.get(key());
    if (
      !detail &&
      !detailLoading &&
      !loading &&
      !error &&
      (!cached || Date.now() - cached.at >= 15000)
    )
      queueMicrotask(() => load());
    if (detail || detailLoading || detailError)
      return styles + `<div class="parent-insights">${detailPage()}</div>`;
    return `${styles}<div class="parent-insights"><div class="insight-title"><h2>${focus === "questions" ? "孩子提问" : "学习洞察"}</h2><button class="text-action" data-insight-refresh ${loading ? "disabled" : ""}>${loading ? "同步中…" : "刷新记录"}</button></div>${focus === "questions" ? '<button class="text-action" data-go="parent/report">查看完整学习报告</button>' : ""}<p class="insight-date">${esc(dates())}${focus !== "questions" && data?.period ? " · 与 " + esc(data.period.previousFrom) + " 至 " + esc(data.period.previousTo) + " 比较" : ""}</p><div class="insight-periods">${[
      ["day", "日"],
      ["week", "周"],
      ["month", "月"],
    ]
      .map(
        ([id, label]) =>
          `<button class="${period === id && !activeRange ? "active" : ""}" data-insight-period="${id}">${label}</button>`,
      )
      .join(
        "",
      )}<details class="insight-range" data-insight-range ${rangeOpen ? "open" : ""}><summary>更多日期</summary><form id="insight-range-form" class="insight-range-form"><label>开始日期<input type="date" name="from" data-insight-date="from" max="${today()}" value="${esc(rangeDraft.from)}" required></label><label>结束日期<input type="date" name="to" data-insight-date="to" max="${today()}" value="${esc(rangeDraft.to)}" required></label><button class="primary" type="submit">查看这段时间</button></form></details></div>${error ? `<p class="error-banner" role="alert">${esc(error)}</p>` : ""}${!data ? `<p role="status">${loading ? "正在汇总实际学习记录…" : "尚未读取到学习记录。"}</p>` : focus === "questions" ? questionList() : `<section class="insight-kpis"><div><strong>${count(data.totals.graded)}</strong><small>已核对题目</small></div><div><strong>${count(data.totals.correct)}/${count(data.totals.graded)}</strong><small>答对 / 已核对</small></div><div><strong>${count(data.totals.questionsAsked)}</strong><small>提问记录</small></div></section>${barChart()}${distribution()}<section class="insight-summary"><h3>这段时间的学习记录</h3>${(data.summary || []).map((s) => `<p>${esc(s)}</p>`).join("")}</section>${points()}${questionList()}<details class="insight-limitations"><summary>统计依据与记录范围</summary>${(data.limitations || []).map((s) => `<p>${esc(s)}</p>`).join("")}</details>`}</div>`;
  }
  async function openQuestion(id) {
    if (!owner || owner !== actor() || (detailLoading && detail?.id === id))
      return;
    const stamp = epoch,
      number = ++detailNumber,
      identity = owner;
    detail = { id, title: "提问记录", messages: [] };
    detailLoading = true;
    detailError = "";
    refresh();
    try {
      const result = await app.api(
        "/api/parent/questions/" +
          encodeURIComponent(id) +
          "?childId=" +
          encodeURIComponent(app.childId()),
      );
      if (stamp !== epoch || identity !== actor() || number !== detailNumber)
        return;
      const value = result?.question?.messages ? result.question : result;
      if (!Array.isArray(value?.messages)) throw new Error();
      detail = value;
    } catch (_) {
      if (stamp === epoch && identity === actor() && number === detailNumber)
        detailError =
          "这条原文暂时无法读取，可能已超过保留窗口。统计记录仍然保留。";
    } finally {
      if (stamp === epoch && identity === actor() && number === detailNumber) {
        detailLoading = false;
        refresh();
      }
    }
  }
  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled || !app || !allowed() || owner !== actor())
      return;
    const d = button.dataset;
    if (d.insightPeriod) {
      period = d.insightPeriod;
      activeRange = null;
      detail = null;
      detailError = "";
      questionLimit = 20;
      data = cache.get(key())?.value || null;
      load();
      refresh();
      return;
    }
    if ("insightRefresh" in d) {
      load(true);
      return;
    }
    if (d.insightDay) {
      period = d.to ? "term" : "day";
      activeRange = { from: d.insightDay, to: d.to || d.insightDay };
      rangeDraft = { ...activeRange };
      questionLimit = 20;
      data = null;
      load(true);
      return;
    }
    if (d.insightQuestion) {
      openQuestion(d.insightQuestion);
      return;
    }
    if ("insightBack" in d) {
      detailNumber++;
      detail = null;
      detailError = "";
      detailLoading = false;
      refresh();
      return;
    }
    if ("insightMore" in d) {
      questionLimit += 20;
      refresh();
    }
  });
  document.addEventListener("input", (event) => {
    if (
      app &&
      allowed() &&
      owner === actor() &&
      ["from", "to"].includes(event.target.dataset?.insightDate)
    )
      rangeDraft[event.target.dataset.insightDate] = event.target.value;
  });
  document.addEventListener("submit", (event) => {
    if (
      event.target.id !== "insight-range-form" ||
      !app ||
      !allowed() ||
      owner !== actor()
    )
      return;
    event.preventDefault();
    if (!rangeDraft.from || !rangeDraft.to || rangeDraft.from > rangeDraft.to) {
      error = "请检查开始和结束日期。";
      refresh();
      return;
    }
    period = "term";
    activeRange = { ...rangeDraft };
    rangeOpen = false;
    questionLimit = 20;
    data = null;
    detail = null;
    load(true);
  });
  document.addEventListener(
    "toggle",
    (event) => {
      if (
        event.target.dataset &&
        "insightRange" in event.target.dataset &&
        app &&
        owner === actor()
      )
        rangeOpen = event.target.open;
    },
    true,
  );
  window.BX_PARENT_INSIGHTS = { page };
})();
