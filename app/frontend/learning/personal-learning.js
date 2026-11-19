(function () {
  "use strict";
  let app,
    owner = "",
    dashboard = null,
    lesson = null,
    practice = null;
  let pending = "",
    problem = "",
    sources = null,
    selectedBook = "";
  let dashboardDirty = false;
  let recordFilter = "", recordPage = null, practiceRoute = "";
  const answerStarts = new Map();
  const practiceEvents = typeof BroadcastChannel === "function" ? new BroadcastChannel("paw-learning") : null;
  const labels = {basic:"基础", medium:"进阶", advanced:"挑战", unclassified:"未分级"};
  const pointStatus = {"needs-practice":"再练练", mastered:"已掌握", observed:"继续练", insufficient:"再做几道"};
  const escape = (value) => app.esc(value);
  const token = () => crypto.randomUUID();
  const practiceRequests = new Map();
  const answerDrafts = new Map();
  const scratchDrafts = new Map();
  let shownQuestion = "", assistOpen = false, dragging, dockClickAfter = 0;
  let dockSide = "right", dockHeight = 58;
  const mascot = 'assets/brand/paw-mascot.png';
  const qualified = () => owner && String(app.user()?.id || "") === owner;


  function resetOwner() {
    const current = String(app.user()?.id || "");
    if (current === owner) return;
    owner = current;
    dashboard = lesson = practice = sources = null;
    dashboardDirty = false;
    recordFilter = practiceRoute = "";
    recordPage = null;
    answerStarts.clear();
    selectedBook = "";
    pending = problem = "";
    practiceRequests.clear();
    answerDrafts.clear();
    scratchDrafts.clear();
    shownQuestion = "";
    assistOpen = false;
    dockSide = "right";
    dockHeight = 58;
    try {
      dockSide = localStorage.getItem(`bx-practice-dock:${owner}:side`) === "left" ? "left" : "right";
      dockHeight = Number(localStorage.getItem(`bx-practice-dock:${owner}:height`)) || 58;
    } catch {}
  }
  function repaint() {
    if (["home", "learn"].includes(app.route()[0])) app.render();
  }
  async function loadDashboard() {
    if (pending) return;
    const expected = owner;
    pending = "dashboard";
    problem = "";
    try {
      const value = await app.api("/api/learning/dashboard");
      if (owner !== expected || String(app.user()?.id || "") !== expected)
        return;
      dashboard = value;
      dashboardDirty = false;
      if (!recordFilter && !recordPage) recordPage = value.analysis;
      if (
        !selectedBook ||
        !value.books.some((book) => book.id === selectedBook)
      )
        selectedBook = value.books[0]?.id || "";
    } catch (error) {
      if (owner === expected) problem = error.message;
    } finally {
      if (owner === expected) {
        pending = "";
        repaint();
      }
    }
  }
  function refreshDashboard() {
    dashboardDirty = true;
    if (!app || !qualified()) return;
    const [section, tab] = app.route();
    if (section === "home" || (section === "learn" && tab === "analysis")) {
      recordPage = null;
      recordFilter = "";
      if (!pending) loadDashboard();
    }
  }
  document.addEventListener("paw:answer-checked", () => {
    practiceEvents?.postMessage(owner);
    refreshDashboard();
  });
  practiceEvents?.addEventListener("message", event => {
    if (String(event.data) === owner) refreshDashboard();
  });
  window.addEventListener("focus", refreshDashboard);
  window.addEventListener("hashchange", refreshDashboard);

  function init(value) {
    app = value;
    resetOwner();
    const [section, page] = app.route();
    if (section !== "learn" || page !== "practice") practiceRoute = "";
    if ((!dashboard || (dashboardDirty && (section === "home" || page === "analysis"))) && !pending && !problem) {
      queueMicrotask(loadDashboard);
    }
  }
  function home(value) {
    init(value);
    const heading = "智能小爪陪你学";
    if (!dashboard)
      return `<section class="personal-home"><h2>${heading}</h2><p>${problem ? escape(problem) : "正在看看你的学习记录…"}</p>${problem ? '<button class="secondary" data-personal-retry>重试</button>' : ""}</section>`;
    const weak = dashboard.points.find(point => point.status === "needs-practice");
    const { graded, threshold } = dashboard.analysis;
    const message = weak ? `${weak.title}最近错了 ${weak.samples - weak.correct} 道，先练这里。` :
      graded >= threshold ? `已批改 ${graded} 道题，来练下一组。` : `已批改 ${graded}/${threshold} 道，做满就能看知识图。`;
    return `<section class="personal-home paw-learning-card">
      <div class="personal-heading"><h2>${heading}</h2><button class="text-action" data-go="learn">全部知识点</button></div>
      <div class="paw-learning-body"><div><p>${escape(message)}</p><div class="paw-learning-actions">
        <button class="primary" data-personal-practice="adaptive" data-practice-style="arena">智能组题</button>
        <button class="secondary" data-personal-practice="adaptive" data-practice-style="arena-paper">智能组卷</button>
        ${dashboard.resume ? `<button class="text-action" data-go="learn/practice/${escape(dashboard.resume.id)}">继续上次</button>` : ""}
        <button class="text-action" data-go="learn/analysis">看分析</button>
      </div></div><img src="${mascot}" alt=""></div>
      ${problem ? `<p class="error-banner" role="alert">${escape(problem)}</p>` : ""}
    </section>`;
  }
  function bookPicker() {
    if (!dashboard?.books.length)
      return "<p>还没有可用教材；你仍可以学习和练习。</p>";
    return `<label class="personal-book">我的教材 <select id="personal-book">${dashboard.books.map((book) => `<option value="${escape(book.id)}" ${book.id === selectedBook ? "selected" : ""}>${escape(book.title)}</option>`).join("")}</select></label>`;
  }
  async function loadLesson(topic) {
    if (pending) return;
    const expected = owner,
      key = topic + ":" + selectedBook;
    pending = "lesson";
    problem = "";
    try {
      const value = await app.api(
        "/api/learning/lesson?topicId=" +
          encodeURIComponent(topic) +
          (selectedBook ? "&bookId=" + encodeURIComponent(selectedBook) : ""),
      );
      if (
        owner === expected &&
        app.route()[1] === topic &&
        key === topic + ":" + selectedBook
      )
        lesson = { key, value };
    } catch (error) {
      if (owner === expected) problem = error.message;
    } finally {
      if (owner === expected) {
        pending = "";
        repaint();
      }
    }
  }
  async function loadPractice(id) {
    if (pending) return;
    const expected = owner;
    pending = "practice";
    problem = "";
    try {
      const value = await app.api(
        "/api/learning/practice/" + encodeURIComponent(id),
      );
      if (owner === expected) {
        if (practice?.id !== id) shownQuestion = app.route()[3] || "";
        practice = value;
      }
    } catch (error) {
      if (owner === expected) problem = error.message;
    } finally {
      if (owner === expected) {
        pending = "";
        repaint();
      }
    }
  }
  function lessonDiagram(diagram) {
    const { kind, groups } = diagram;
    if (kind === "triangle") {
      return '<figure class="personal-diagram"><svg viewBox="0 0 160 100" aria-hidden="true"><path d="M80 10 148 89H12Z" fill="#fdf1cf" stroke="#3869a1" stroke-width="3"/></svg><figcaption>三条边围起来。</figcaption></figure>';
    }
    const alt =
      kind === "decimal"
        ? "十小格中左边三格已涂色"
        : kind === "subtraction"
          ? "五个圆没有划掉，三个圆被划掉"
          : "两组圆，和例题的数量一致";
    return (
      '<figure class="personal-diagram"><div class="diagram-groups" role="img" aria-label="' +
      alt +
      '">' +
      groups
        .map(
          (count, index) =>
            '<span class="diagram-group ' +
            (index === 1
              ? kind === "subtraction"
                ? "crossed"
                : kind === "decimal"
                  ? "empty-cell"
                  : "other"
              : "") +
            " " +
            (kind === "decimal" ? "cells" : "") +
            '">' +
            "<i></i>".repeat(count) +
            "</span>",
        )
        .join("") +
      "</div></figure>"
    );
  }
  const practiceContext = (question) => ({
    practiceSetId: practice.id,
    practiceItemId: question.id,
    bookId: dashboard?.books.find(book => book.id === selectedBook && book.subject === (question.subject || "math") && (!question.grade || book.grade === question.grade))?.id
      || dashboard?.books.find(book => book.subject === (question.subject || "math") && (!question.grade || book.grade === question.grade))?.id || "",
  });

  function activeQuestion() {
    if (!practice) return null;
    return practice.questions.find(question => question.id === shownQuestion)
      || practice.questions.find(question => !(question.id in practice.attempts));
  }

  function answerFields(question, saved, answered) {
    if (question.kind === "choice") {
      return `<fieldset class="practice-options" aria-label="选择一个答案" ${answered ? "disabled" : ""}>${question.options.map((option, index) => {
        const label = question.optionIds?.[index] || "ABCD"[index];
        const value = question.optionIds ? label : option;
        return `<label class="practice-option"><input type="radio" name="answer" value="${escape(value)}" ${saved?.[0] === value ? "checked" : ""} required>
        <span class="practice-option-letter">${escape(label)}</span><span>${escape(option)}</span></label>`;
      }).join("")}</fieldset>`;
    }
    const steps = question.steps || ["填写答案"];
    return `<fieldset class="practice-steps" ${answered ? "disabled" : ""}>${steps.map((step, index) => `<label>
      <span>${question.kind === "written" ? `${index + 1}. ` : ""}${escape(step)}</span>
      <input name="answer" inputmode="decimal" maxlength="24" required value="${escape(saved?.[index] || "")}" aria-label="${escape(step)}">
    </label>`).join("")}</fieldset>`;
  }

  function reviewMarkup(question, answered, review) {
    if (!answered) return "";
    const correct = practice.attempts[question.id];
    return `<section class="practice-review" role="status"><strong>${correct ? "答对了" : "再看一看"}</strong>
      ${review ? `<ul>${review.steps.map((step, index) => `<li>${question.kind === "written" ? `第 ${index + 1} 步 · ` : ""}${step.correct ? "正确" : `参考答案 ${escape(step.expected)}`}</li>`).join("")}</ul>` : ""}
      <button type="button" class="text-action" data-practice-ask="帮我验算这道题，讲讲关键一步">请爪爪验算</button>
    </section>`;
  }

  function assistantMarkup(question) {
    if (!assistOpen) {
      return `<button type="button" id="practice-dock" class="practice-dock dock-${dockSide}" data-practice-dock aria-label="打开问爪爪" aria-haspopup="dialog" style="--dock-height:${dockHeight}dvh"><img src="${mascot}" alt=""><span>问爪爪</span></button>`;
    }
    const raw = practiceContext(question);
    queueMicrotask(() => {
      const panel = document.querySelector("#practice-assistant");
      if (panel && !panel.open) panel.showModal();
    });
    return `<dialog id="practice-assistant" class="practice-assistant dock-${dockSide}" aria-labelledby="practice-assistant-title">
      <header><img src="${mascot}" alt=""><h3 id="practice-assistant-title">问爪爪</h3><button type="button" data-practice-dock aria-label="关闭问爪爪">×</button></header>
      <div id="practice-conversation" data-set="${escape(raw.practiceSetId)}" data-item="${escape(raw.practiceItemId)}" data-book="${escape(raw.bookId)}">${window.BX_STUDY?.practicePanel(raw) || ""}</div>
    </dialog>`;
  }

  function practicePage(id) {
    const path = app.route().join("/");
    if (practiceRoute !== path) {
      practiceRoute = path;
      shownQuestion = app.route()[3] || "";
      assistOpen = false;
    }
    if (practice?.id !== id && !pending && !problem)
      queueMicrotask(() => loadPractice(id));
    if (!practice || practice.id !== id) return "<p>正在打开练习…</p>";
    const question = activeQuestion();
    if (!question) {
      const correct = Object.values(practice.attempts).filter(Boolean).length;
      return `<section class="personal-card practice-complete"><h2>练习完成</h2><p>做对 ${correct} / ${practice.questions.length} 道。</p>
        <button type="button" class="primary" data-personal-next="${escape(practice.id)}">按薄弱点组下一组</button>
        <button type="button" class="text-action" data-go="learn/analysis">看分析</button>
        <button type="button" class="text-action" data-practice-move="${practice.questions.at(-1).id}">回看答题</button></section>`;
    }
    const index = practice.questions.indexOf(question), total = practice.questions.length;
    const answered = question.id in practice.attempts;
    if (!answered && !answerStarts.has(question.id)) answerStarts.set(question.id, performance.now());
    const review = practice.reviews?.[question.id];
    const saved = review ? [].concat(review.answer) : answerDrafts.get(question.id);
    const scratch = scratchDrafts.get(question.id) || "";
    const next = index + 1 === total ? "done" : practice.questions[index + 1].id;
    const topic = question.pointTitle || dashboard.topics.find(item => item.id === question.topicId)?.title || practice.title;
    const heading = practice.style === "arena-paper" || !practice.style && total === 10 ? "智能组卷" :
      practice.style === "arena" ? "智能组题" : `${practice.title}小练习`;
    return `<div class="paw-workbench">
      <section class="practice-main personal-card"><div class="practice-heading"><h2>${escape(heading)}</h2><span>第 ${index + 1} / ${total} 题</span></div>
      ${practice.sourceSetId && index === 0 && practice.title !== "竞技场" ? `<p class="practice-plan">本组重点练${escape(practice.title)}。</p>` : ""}
      <span class="practice-kind">${escape(topic)} · ${question.kind === "choice" ? "选择题" : question.kind === "written" ? "分步大题" : "填答题"}${question.originId ? ` · ${question.grade ? `${escape(question.grade)} 年级 · ` : ""}${labels[question.difficulty]}` : ""}</span>
      <p class="personal-question">${escape(question.stem)}</p>
      ${(question.images || []).map((src, i) => `<a class="practice-source-figure" href="${escape(src)}" target="_blank" rel="noopener"><img src="${escape(src)}" alt="${i ? "原题补充图" : "竞技场原题图"}"></a>`).join("")}
      <form id="personal-answer-form" data-item="${question.id}">${answerFields(question, saved, answered)}
        ${question.kind === "written" ? `<details class="practice-scratch" ${scratch ? "open" : ""}><summary>写草稿</summary><textarea name="scratch" rows="2" maxlength="600" aria-label="算式或解题草稿" placeholder="写下你的算式或想法">${escape(scratch)}</textarea></details>` : ""}
        <div class="practice-controls">
          ${index ? `<button type="button" class="secondary" data-practice-move="${practice.questions[index - 1].id}">上一题</button>` : ""}
          ${answered ? `<button type="button" class="primary" data-practice-move="${next}">${next === "done" ? "查看结果" : "下一题"}</button>` : `<button class="primary" type="submit" ${pending ? "disabled" : ""}>提交</button>`}
        </div>
      </form>
      ${reviewMarkup(question, answered, review)}
      ${answered && question.originId ? `<a class="practice-source-link" href="#/arena/question/${escape(question.originId)}">竞技场原题 ↗</a>` : ""}
      ${practice.feedback && !question.kind ? `<p role="status">${escape(practice.feedback)}</p>` : ""}
      <div class="practice-help"><img src="${mascot}" alt=""><span>问爪爪</span>
        <button type="button" data-practice-ask="看我的作答和草稿，提示我下一步">给个提示</button>
        <button type="button" data-practice-ask="讲个同类例子">讲个例子</button>
        <button type="button" data-practice-ask="哪里能在教材里找到这个知识点">看教材</button>
      </div>
      </section>${assistantMarkup(question)}
    </div>`;
  }

  function triangleChart(subjects) {
    const vertices = [[80, 13], [21, 110], [139, 110]];
    const center = [80, 76];
    const values = subjects.map((subject, i) => {
      if (!subject.graded) return null;
      const ratio = subject.correct / subject.graded;
      return vertices[i].map((v, axis) => center[axis] + (v - center[axis]) * ratio);
    });
    return `<svg class="analysis-triangle" viewBox="0 0 160 122" role="img" aria-label="语文、数学、英语答对比例">
      <polygon points="80,13 21,110 139,110" fill="#eff5fe" stroke="#a7bfe0"/>
      ${vertices.map(([x, y]) => `<line x1="80" y1="76" x2="${x}" y2="${y}" stroke="#c5d5eb"/>`).join("")}
      ${values.every(Boolean) ? `<polygon points="${values.join(" ")}" fill="#4d80d85c" stroke="#3468c6" stroke-width="2"/>` : ""}
      ${values.filter(Boolean).map(([x, y]) => `<circle cx="${x}" cy="${y}" r="4" fill="#3468c6"/>`).join("")}
      <text x="80" y="10" text-anchor="middle">数学</text><text x="20" y="121" text-anchor="middle">语文</text><text x="140" y="121" text-anchor="middle">英语</text>
    </svg>`;
  }

  const recordTime = new Intl.DateTimeFormat("zh-CN", {month:"numeric", day:"numeric", hour:"2-digit", minute:"2-digit"});
  function analysisPage() {
    const data = dashboard.analysis;
    const page = recordPage || data;
    const points = dashboard.points;
    const wrong = data.graded - data.correct;
    const percentage = Math.round(100 * data.correct / (data.graded || 1));
    const weak = points.filter(point => point.status === "needs-practice");
    const errorSamples = weak.reduce((sum, point) => sum + point.samples - point.correct, 0);
    const colors = ["#3473c8", "#f49a44", "#955fc5", "#2c9b83", "#bd5b63", "#5979a2"];
    let left = 0;
    const colorsByPoint = weak.map((point, index) => {
      const count = point.samples - point.correct;
      const start = left;
      left += 100 * count / errorSamples;
      return {point, count, color:colors[index % colors.length], start, end:left};
    });
    return `<section class="personal-card analysis-summary"><div class="personal-heading"><h1>学习分析</h1><button class="text-action" data-go="home">回首页</button></div>
      <div class="analysis-totals"><span><strong>${data.graded}</strong> 已批改</span><span><strong>${data.correct}</strong> 答对</span><span><strong>${wrong}</strong> 再练</span><span><strong>${data.questionsAsked}</strong> 提问</span></div>
      ${data.pending ? `<p>另有 ${data.pending} 道待核对。</p>` : ""}
      ${data.graded < data.threshold ? `<section class="analysis-unlock"><h2>我的知识图</h2><progress value="${data.graded}" max="${data.threshold}"></progress><p>再做 ${data.threshold - data.graded} 道已批改的题，就能看到知识图。</p></section>` :
        `<div class="analysis-charts">
          <section><h2>答对了多少</h2><div class="analysis-ring" style="--percent:${percentage}%" role="img" aria-label="答对 ${data.correct} 道，待复习 ${wrong} 道"><b>${percentage}%</b></div><p>对 ${data.correct} 道 · 错 ${wrong} 道</p></section>
          <section><h2>哪里要多练</h2>${weak.length ? `<div class="analysis-pie" style="--pie:${colorsByPoint.map(c => `${c.color} ${c.start}% ${c.end}%`).join(",")}" aria-hidden="true"></div><div class="analysis-legend">${colorsByPoint.map(c => `<button type="button" data-analysis-point="${escape(c.point.id)}"><i style="--dot:${c.color}"></i>${escape(c.point.title)} ${c.count}</button>`).join("")}</div>` : '<p>暂时没有需要重点补练的知识点。</p>'}</section>
          <section><h2>三科学习</h2>${triangleChart(data.subjects)}<p>${data.subjects.map(subject => `${escape(subject.title)} ${subject.graded ? `${subject.correct}/${subject.graded}` : "无记录"}`).join(" · ")}</p></section>
        </div><section class="analysis-map"><h2>我的知识图</h2><p>点知识点看答题记录。每项按最近最多 8 道题判断。</p>
          <div class="analysis-points">${points.map(point => `<button type="button" class="${point.status}" data-analysis-point="${escape(point.id)}"><strong>${escape(point.title)}</strong><span>${point.correct}/${point.samples} · ${pointStatus[point.status]}</span></button>`).join("") || "<p>这些题的知识点还在整理中。</p>"}</div></section>`}
      </section>
      <section class="personal-card analysis-records" id="analysis-records"><div class="personal-heading"><h2>${recordFilter ? escape(points.find(p=>p.id===recordFilter)?.title || "知识点") : "答题明细"}</h2>${recordFilter ? '<button type="button" class="text-action" data-analysis-point="">全部记录</button>' : ""}</div>
        ${page.items.length ? `<ol>${page.items.map(row => `<li><div>${row.href ? `<a href="${escape(row.href)}">${escape(row.title)}</a>` : `<strong>${escape(row.title)}</strong>`}<small>${escape(row.source)} · ${recordTime.format(new Date(row.at * 1000))}${row.elapsed == null ? "" : ` · ${row.elapsed} 秒`}</small></div><b class="${row.correct == null ? "pending" : row.correct ? "correct" : "incorrect"}">${row.correct == null ? "待核对" : row.correct ? "答对" : "答错"}</b></li>`).join("")}</ol>` : "<p>做完题后，这里会留下记录。</p>"}
        ${page.nextOffset !== null ? `<button type="button" class="text-action" data-analysis-more="${page.nextOffset}">查看更多</button>` : ""}
      </section>`;
  }

  async function loadRecords(point, offset = 0) {
    if (pending) return;
    pending = "records";
    const expected = owner;
    problem = "";
    try {
      const query = new URLSearchParams({offset, point});
      const value = await app.api("/api/learning/records?" + query);
      if (expected !== owner || app.route()[1] !== "analysis") return;
      const previous = recordPage || dashboard.analysis;
      recordFilter = point;
      recordPage = offset ? {...value, items:[...previous.items, ...value.items]} : value;
    } catch (error) {
      if (expected === owner) problem = error.message;
    } finally {
      if (expected === owner) {
        pending = "";
        repaint();
        if (!offset) document.querySelector("#analysis-records")?.scrollIntoView({block:"start"});
      }
    }
  }

  function page(value) {
    init(value);
    if (!dashboard)
      return `<section class="personal-learning"><h1>一起学</h1><p>${problem ? escape(problem) : "正在准备…"}</p><button class="secondary" data-personal-retry>重试</button></section>`;
    const route = app.route(),
      topic = route[1];
    let content;
    if (topic === "practice" && route[2]) content = practicePage(route[2]);
    else if (topic === "analysis") content = analysisPage();
    else if (!topic)
      content = `<h1>一起学</h1><p>${escape(dashboard.message)}</p>${bookPicker()}<div class="personal-topics">${dashboard.topics.map((item) => `<button data-go="learn/${item.id}"><strong>${escape(item.title)}</strong><span>看看例子 →</span></button>`).join("")}</div>`;
    else {
      const key = topic + ":" + selectedBook;
      if (lesson?.key !== key && !pending && !problem)
        queueMicrotask(() => loadLesson(topic));
      if (!lesson || lesson.key !== key)
        content = "<h1>一起学</h1><p>正在查找教材…</p>";
      else {
        const item = lesson.value;
        content = `<button class="text-action" data-go="learn">← 全部知识点</button><h1>${escape(item.title)}</h1>${bookPicker()}<section class="personal-card"><h2>先弄明白</h2><p>${escape(item.explanation)}</p><h2>看一个例子</h2><p>${escape(item.example)}</p>${lessonDiagram(item.diagram)}</section><section class="personal-card"><h2>教材里这样找</h2>${item.references.length ? item.references.map((ref) => `<a class="personal-reference" href="${escape(ref.url)}"><strong>${escape(ref.title)}</strong><span>${escape(ref.bookTitle)} · 第 ${ref.page} 页 →</span></a>`).join("") : "<p>这本教材里暂时没有找到清楚的相关文字，可以换一本教材看看。</p>"}</section>${item.related.length ? `<section class="personal-card"><h2>还可以一起看</h2>${item.related.map((ref) => `<button class="secondary" data-go="learn/${ref.id}">${escape(ref.title)}</button>`).join(" ")}</section>` : ""}${item.practice ? `<button class="primary" data-personal-practice="${escape(item.id)}" ${pending ? "disabled" : ""}>做几道题</button>` : ""}<button class="secondary" data-personal-ask>问爪爪</button><button class="text-action" data-personal-sources="${escape(item.id)}" ${pending ? "disabled" : ""}>找更多公开资料</button>${sources?.topic === item.id ? `<section class="personal-card"><h2>更多资料</h2>${sources.value.sources.length ? sources.value.sources.map((s) => `<p><a href="${escape(s.url)}" target="_blank" rel="noopener noreferrer">${escape(s.title)} ↗</a></p>`).join("") : "<p>暂时没有找到可用资料。</p>"}</section>` : ""}`;
      }
    }
    return `<section class="personal-learning">${problem ? `<p class="error-banner" role="alert">${escape(problem)} <button data-personal-retry>重试</button></p>` : ""}${content}</section>`;
  }
  document.addEventListener("change", (event) => {
    if (event.target.id !== "personal-book") return;
    selectedBook = event.target.value;
    lesson = null;
    sources = null;
    problem = "";
    repaint();
  });
  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || !app || button.disabled) return;
    if ("analysisPoint" in button.dataset) {
      loadRecords(button.dataset.analysisPoint);
      return;
    }
    if (button.dataset.analysisMore) {
      loadRecords(recordFilter, Number(button.dataset.analysisMore));
      return;
    }
    if (button.hasAttribute("data-practice-dock")) {
      if (performance.now() >= dockClickAfter) toggleAssist();
      return;
    }
    if (button.dataset.practiceAsk) {
      const question = activeQuestion();
      if (question) {
        if (!assistOpen) { assistOpen = true; repaint(); }
        window.BX_STUDY?.askPractice(practiceContext(question), button.dataset.practiceAsk);
      }
      return;
    }
    if (button.dataset.practiceMove && !pending) {
      shownQuestion = button.dataset.practiceMove === "done" ? "" : button.dataset.practiceMove;
      problem = "";
      repaint();
      return;
    }
    if ("personalRetry" in button.dataset) {
      problem = "";
      dashboard = null;
      lesson = null;
      practice = null;
      repaint();
      return;
    }
    if ("personalAsk" in button.dataset && lesson) {
      const ref = lesson.value.references[0];
      const context = ref
        ? { bookId: ref.bookId, page: ref.page, label: ref.bookTitle }
        : selectedBook
          ? { bookId: selectedBook, page: 1 }
          : {};
      window.BX_STUDY?.prepare(context);
      app.go("ai");
      window.BX_STUDY?.send(
        "请用一个简单的例子讲讲" + lesson.value.title + "。",
        context,
      );
      return;
    }
    if (button.dataset.personalPractice || button.dataset.personalNext) {
      if (pending) return;
      const { personalPractice: topicId, personalNext: setId, practiceStyle: style = "guided" } = button.dataset;
      const requestKey = setId ? `next:${setId}` : `${style}:${topicId}`;
      const requestId = practiceRequests.get(requestKey) || token();
      const expected = owner;
      practiceRequests.set(requestKey, requestId);
      pending = "create";
      button.disabled = true;
      app.api(setId ? "/api/learning/next-practice" : "/api/learning/practice",
        setId ? {setId, requestId} : {topicId, style, requestId, grade: app.grade?.()})
        .then(value => {
          if (owner !== expected || !qualified()) return;
          practiceRequests.delete(requestKey);
          practice = value;
          shownQuestion = "";
          assistOpen = false;
          dashboardDirty = true;
          app.go("learn/practice/" + value.id);
        })
        .catch(error => { if (owner === expected) problem = error.message; })
        .finally(() => {
          if (owner === expected) {
            pending = "";
            repaint();
          }
        });
      return;
    }
    if (button.dataset.personalSources) {
      const topic = button.dataset.personalSources,
        expected = owner;
      pending = "sources";
      button.disabled = true;
      app
        .api("/api/learning/sources", { topicId: topic })
        .then((value) => {
          if (owner === expected) sources = { topic, value };
        })
        .catch((error) => {
          if (owner === expected) problem = error.message;
        })
        .finally(() => {
          if (owner === expected) {
            pending = "";
            repaint();
          }
        });
    }
  });
  function toggleAssist() {
    const panel = document.querySelector(".practice-assistant");
    if (panel?.classList.contains("is-closing")) return;
    assistOpen = !assistOpen;
    if (!assistOpen && panel && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      panel.classList.add("is-closing");
      const close = () => {
        if (assistOpen || !panel.isConnected) return;
        repaint();
        document.querySelector("#practice-dock")?.focus({preventScroll: true});
      };
      panel.addEventListener("animationend", (event) => { if (event.target === panel) close(); });
      setTimeout(close, 230);
    } else {
      repaint();
    }
  }
  document.addEventListener("cancel", event => {
    if (event.target.id !== "practice-assistant") return;
    event.preventDefault();
    toggleAssist();
  }, true);
  document.addEventListener("pointerdown", event => {
    const dock = event.target.closest?.("#practice-dock");
    if (!dock || event.button !== 0) return;
    dock.setPointerCapture(event.pointerId);
    const rect = dock.getBoundingClientRect();
    dragging = { id:event.pointerId, dock, x:event.clientX, y:event.clientY, width:rect.width, offset:event.clientX-rect.x, moved:false };
  });
  document.addEventListener("pointermove", event => {
    if (dragging?.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - dragging.x, event.clientY - dragging.y) < 7 && !dragging.moved) return;
    dragging.moved = true;
    const dock = dragging.dock;
    dock.classList.add("is-dragging");
    dock.style.setProperty("--drag-x", `${Math.max(4, Math.min(innerWidth - dragging.width - 4, event.clientX - dragging.offset))}px`);
    dock.style.setProperty("--dock-height", `${Math.max(64, Math.min(innerHeight - 122, event.clientY - 18))}px`);
  });
  function releaseDock(event) {
    if (dragging?.id !== event.pointerId) return;
    const moved = dragging.moved;
    dragging = null;
    if (!moved) return;
    if (event.type === "pointercancel") {
      repaint();
      return;
    }
    dockSide = event.clientX < innerWidth / 2 ? "left" : "right";
    dockHeight = Math.max(12, Math.min(83, (event.clientY - 18) * 100 / innerHeight));
    dockClickAfter = performance.now() + 260;
    try {
      localStorage.setItem(`bx-practice-dock:${owner}:side`, dockSide);
      localStorage.setItem(`bx-practice-dock:${owner}:height`, String(dockHeight));
    } catch {}
    repaint();
  }
  document.addEventListener("pointerup", releaseDock);
  document.addEventListener("pointercancel", releaseDock);
  document.addEventListener("input", event => {
    const form = event.target.form;
    if (form?.id !== "personal-answer-form") return;
    if (event.target.name === "scratch") scratchDrafts.set(form.dataset.item, event.target.value);
    else answerDrafts.set(form.dataset.item, new FormData(form).getAll("answer"));
  });
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (form.id !== "personal-answer-form") return;
    event.preventDefault();
    if (!practice || pending || !qualified()) return;
    const question = activeQuestion(), set = practice, expected = owner;
    if (!question || form.dataset.item !== question.id || question.id in set.attempts) return;
    const answers = new FormData(form).getAll("answer");
    const answer = question.kind === "written" ? answers : answers[0];
    pending = "answer";
    problem = "";
    form.querySelector('button[type="submit"]').disabled = true;
    const elapsed = Math.min(3600, Math.max(0, Math.floor((performance.now() - answerStarts.get(question.id)) / 1000)));
    app.api("/api/learning/attempts", {setId:set.id, questionId:question.id, answer, elapsed})
      .then(result => {
        if (owner !== expected || !qualified() || practice !== set) return;
        set.attempts[question.id] = result.correct;
        if (result.review) {
          set.reviews ||= {};
          set.reviews[question.id] = result.review;
          shownQuestion = question.id;
        } else {
          shownQuestion = "";
          set.feedback = result.feedback;
        }
        answerDrafts.delete(question.id);
        answerStarts.delete(question.id);
        document.dispatchEvent(new Event("paw:answer-checked"));
      })
      .catch(error => { if (owner === expected && practice === set) problem = error.message; })
      .finally(() => {
        if (owner === expected) {
          pending = "";
          repaint();
        }
      });
  });
  window.BX_PERSONAL = { home, page };
})();
