(function () {
  "use strict";
  let app,
    owner = "",
    data = null,
    error = "",
    busy = false,
    filter = { book: "", chapter: "", status: "pending", search: "", page: 0 },
    generation = 0;
  const rich = (value) => window.BX_CHAT?.markdown(value) || app.esc(value);
  function refresh() {
    if (app.route()[0] === "admin" && app.route()[1] === "questions")
      app.render();
  }
  async function load() {
    if (busy || app.user()?.role !== "admin") return;
    busy = true;
    error = "";
    const stamp = ++generation,
      actor = app.user()?.id;
    try {
      const params = new URLSearchParams(filter);
      const value = await app.api("/api/admin/arena/reviews?" + params);
      if (
        stamp !== generation ||
        actor !== app.user()?.id ||
        app.user()?.role !== "admin"
      )
        return;
      data = value;
      filter.book = value.book?.id || "";
      filter.page = value.page;
    } catch (e) {
      if (
        stamp === generation &&
        actor === app.user()?.id &&
        app.user()?.role === "admin"
      )
        error = e.message;
    } finally {
      if (stamp === generation) {
        busy = false;
        refresh();
      }
    }
  }
  function page(value) {
    app = value;
    if (app.user()?.role !== "admin") {
      generation++;
      data = null;
      owner = "";
      error = "";
      busy = false;
      return '<p class="empty-state">需要管理员权限才能查看题目与答案核对。</p>';
    }
    const id = String(app.user()?.id);
    if (id !== owner) {
      owner = id;
      generation++;
      data = null;
      busy = false;
      error = "";
      filter = {
        book: "",
        chapter: "",
        status: "pending",
        search: "",
        page: 0,
      };
    }
    if (!data && !busy && !error) queueMicrotask(load);
    const esc = app.esc;
    return `<div class="study-title"><h1>题目与答案核对</h1><button class="secondary" data-review-refresh ${busy ? "disabled" : ""}>刷新</button></div><p class="source-notice">逐题核对原图、条件、选项和参考来源。学生看不到这里的参考答案；题源变化后必须重新核对。</p><form id="arena-review-filter" class="review-filters"><label>练习册<select name="book">${(data?.books || []).map((b) => `<option value="${b.id}" ${b.id === filter.book ? "selected" : ""}>${esc(b.gradeLabel)} · ${esc(b.subjectLabel)} · ${b.term === 2 ? "下册" : b.term === 1 ? "上册" : "册次待核对"} · ${esc(b.title)}</option>`).join("")}</select></label><label>章节<select name="chapter"><option value="">全部章节</option>${(
      data?.book?.chapters || []
    )
      .filter((c) => c.questionCount)
      .map(
        (c) =>
          `<option value="${c.id}" ${filter.chapter === c.id ? "selected" : ""}>${esc(c.match?.title || c.title)}</option>`,
      )
      .join("")}</select></label><label>状态<select name="status">${[
      ["pending", "待核对"],
      ["reviewed", "已核对"],
      ["stale", "题源已变化"],
      ["all", "全部"],
    ]
      .map(
        ([key, text]) =>
          `<option value="${key}" ${filter.status === key ? "selected" : ""}>${text}</option>`,
      )
      .join(
        "",
      )}</select></label><label>搜索题目<input name="search" maxlength="100" value="${esc(filter.search)}" placeholder="输入题干关键词"></label><button class="primary" ${busy ? "disabled" : ""}>筛选</button></form>${error ? `<p class="error-banner">${esc(error)}</p>` : ""}<div class="review-counts">待核对 ${data?.counts?.pending || 0} · 已核对 ${data?.counts?.reviewed || 0} · 题源变化 ${data?.counts?.stale || 0}</div>${busy ? '<p role="status">正在读取真实题目…</p>' : ""}<div class="review-question-list">${(data?.questions || []).map((q) => `<article class="review-question-card"><div class="between"><h2>${esc(q.chapterTitle)} · ${esc(q.title)}</h2><span class="pill">${q.reviewState === "reviewed" ? "已核对" : q.reviewState === "stale" ? "需要重新核对" : "待核对"}</span></div><p>${esc(q.course.gradeLabel)} · ${esc(q.course.version)}${q.generated ? " · AI原创练习" : " · 原文件第 " + q.sourcePage + " 页"}${q.segmented === false ? " · 综合练习，需逐小题核对" : ""}</p>${q.generated ? `<div class="chat-rich">${rich(q.stem)}</div>${q.diagramUrl || q.imageUrl ? `<button class="lesson-image-button" data-review-image="${esc(q.diagramUrl || q.imageUrl)}"><img src="${esc(q.diagramUrl || q.imageUrl)}" loading="lazy" alt="${esc(q.diagramAlt || "本题实际配图，点击缩放")}"></button>${q.diagramAlt ? `<p class="lesson-diagram-caption">${esc(q.diagramAlt)}</p>` : ""}` : ""}<small>AI原创 · ${{ basic: "基础", medium: "中等", advanced: "进阶" }[q.difficulty] || "层次待核对"}${q.knowledgePointTitle ? " · " + esc(q.knowledgePointTitle) : ""}${q.qualityStatus === "four-role-reviewed" ? " · 四个模拟角色复核" : ""} · 可进一步人工核对</small>` : `<button class="lesson-image-button" data-review-image="${esc(q.imageUrl)}"><img src="${esc(q.imageUrl)}" loading="lazy" alt="本题原图，点击缩放"></button>`}${q.supportUrl ? `<button class="secondary" data-review-image="${esc(q.supportUrl)}">查看阅读材料</button>` : ""}${q.continuationUrl ? `<button class="secondary" data-review-image="${esc(q.continuationUrl)}">查看接续条件</button>` : ""}<details><summary>辅助文字与选项</summary><div class="chat-rich">${rich(q.stem)}</div>${q.options.map((o) => `<p>${esc(o.id)}. ${esc(o.text)}</p>`).join("")}</details>${q.reference ? `<details><summary>上次核对记录${q.reviewState === "stale" ? "（原题已变，不用于判题）" : ""}</summary><div class="chat-rich">${rich(q.reference.answer)}</div><p>${esc(q.reference.note)}</p></details>` : ""}<div class="review-actions"><button class="primary" data-review-edit="${q.id}">核对并保存参考</button><button class="secondary" data-go="arena/question/${q.id}">打开做题界面</button><button class="text-action" data-go="arena/answers/${q.id.split(":")[0]}/${q.chapterId}">查看本章参考资料</button><button class="text-action" data-review-audit="${q.id}">修改记录</button></div></article>`).join("") || (!busy ? '<p class="empty-state">当前筛选没有题目，调整练习册或状态继续核对。</p>' : "")}</div><div class="list-pagination"><button class="secondary" data-review-page="${(data?.page || 0) - 1}" ${!data || data.page === 0 || busy ? "disabled" : ""}>上一组</button><span>第 ${(data?.page || 0) + 1} / ${Math.max(1, Math.ceil((data?.total || 0) / 20))} 组 · ${data?.total || 0} 题</span><button class="secondary" data-review-page="${(data?.page || 0) + 1}" ${!data || (data.page + 1) * 20 >= data.total || busy ? "disabled" : ""}>下一组</button></div>`;
  }
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!app || app.user()?.role !== "admin" || !button || button.disabled)
      return;
    const d = button.dataset,
      esc = app.esc;
    if ("reviewRefresh" in d) {
      load();
      return;
    }
    if ("reviewPage" in d) {
      filter.page = Number(d.reviewPage);
      load();
      return;
    }
    if (d.reviewImage) {
      window.BX_IMAGES.open(app, d.reviewImage);
      return;
    }
    if (d.reviewEdit) {
      const q = data?.questions.find((q) => q.id === d.reviewEdit);
      if (!q) return;
      app.modal(
        "核对本题参考",
        `<form id="arena-review-edit" data-question="${q.id}" data-source="${q.sourceHash}"><p>请先逐项核对原图中的数字、条件和选项。${q.options.length ? "选择题填写选项字母。" : ""}</p><label>核对后的答案<textarea name="answer" maxlength="2000" required>${esc(q.reference?.answer || "")}</textarea></label><label>核对依据<textarea name="note" maxlength="1000" required placeholder="原册题号、答案页、关键数值和选项顺序">${esc(q.reference?.note || "")}</textarea></label><button class="primary block">保存核对记录</button><p class="error-banner" role="alert" hidden></p></form>`,
      );
      return;
    }
    if (d.reviewAudit) {
      button.disabled = true;
      const actor = app.user()?.id;
      try {
        const value = await app.api(
          "/api/admin/arena/review-audit?question=" + d.reviewAudit,
        );
        if (actor !== app.user()?.id || app.user()?.role !== "admin") return;
        app.modal(
          "本题核对修改记录",
          value.records
            .map(
              (r) =>
                `<section><p>${new Date(r.created * 1000).toLocaleString("zh-CN")} · 管理员 #${r.actor_id}</p><div class="chat-rich">${rich(r.value.answer)}</div><p>${esc(r.value.note)}</p></section>`,
            )
            .join("") || "<p>暂无核对记录。</p>",
        );
      } catch (e) {
        if (actor === app.user()?.id && app.user()?.role === "admin")
          app.toast(e.message);
      } finally {
        button.disabled = false;
      }
    }
  });
  document.addEventListener("change", (event) => {
    if (
      !app ||
      app.user()?.role !== "admin" ||
      event.target.name !== "book" ||
      !event.target.closest("#arena-review-filter")
    )
      return;
    filter.book = event.target.value;
    filter.chapter = "";
    filter.page = 0;
    load();
  });
  document.addEventListener("submit", async (event) => {
    const form = event.target;
    if (
      !app ||
      app.user()?.role !== "admin" ||
      !["arena-review-filter", "arena-review-edit"].includes(form.id)
    )
      return;
    event.preventDefault();
    if (form.id === "arena-review-filter") {
      for (const key of ["book", "chapter", "status", "search"])
        filter[key] = form.elements[key].value;
      filter.page = 0;
      load();
      return;
    }
    const button = form.querySelector("button"),
      error = form.querySelector('[role="alert"]'),
      actor = app.user()?.id;
    button.disabled = true;
    error.hidden = true;
    try {
      await app.api("/api/admin/arena/review", {
        questionId: form.dataset.question,
        sourceHash: form.dataset.source,
        answer: form.elements.answer.value,
        note: form.elements.note.value,
      });
      if (actor !== app.user()?.id || app.user()?.role !== "admin") return;
      app.modalClose?.();
      app.toast("核对记录已保存，旧判断会提示重新核对");
      window.BX_ARENA_LEARNING?.invalidate?.(form.dataset.question);
      load();
    } catch (e) {
      if (actor === app.user()?.id && app.user()?.role === "admin") {
        error.textContent = e.message;
        error.hidden = false;
      }
    } finally {
      button.disabled = false;
    }
  });
  window.BX_ARENA_REVIEW = { page };
})();
