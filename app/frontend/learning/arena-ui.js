(function () {
  "use strict";
  let app,
    catalog,
    actor = "",
    pending = new Set(),
    currentAnswer = "",
    currentQuestion = "",
    lastUnit = "",
    busy = false;
  const courses = new Map(),
    units = new Map(),
    answerSets = new Map(),
    answerPages = new Map(),
    attempts = new Map(),
    errors = new Map(),
    detailState = new Map();
  const detailOpen = (key, fallback = false) =>
    (detailState.get(key) ?? fallback) ? " open" : "";
  const esc = (value) => app.esc(value);
  const rich = (value) =>
    window.BX_CHAT
      ? window.BX_CHAT.markdown(value)
      : esc(value).replace(/\n/g, "<br>");
  const parent = () => ["parent", "admin"].includes(app.user()?.role);
  const ownerKey = () =>
    String(app.user()?.id || "") + ":" + String(app.childId?.() || "");
  function localDraft(id) {
    try {
      return JSON.parse(
        localStorage.getItem("bx-arena-unit-draft:" + actor + ":" + id) ||
          "null",
      );
    } catch (_) {
      return null;
    }
  }
  function keepDraft(dirty = true) {
    if (!lastUnit || actor !== ownerKey()) return;
    try {
      localStorage.setItem(
        "bx-arena-unit-draft:" + actor + ":" + lastUnit,
        JSON.stringify({
          question: currentQuestion,
          answer: currentAnswer,
          dirty,
          at: Date.now(),
        }),
      );
    } catch (_) {}
  }
  const legacyScreen = (route, html) =>
    window.BX_ARENA_LEARNING?.screen(route, html) || html;
  function fetchOnce(key, path, save) {
    if (pending.has(key) || errors.has(key)) return;
    pending.add(key);
    const owner = actor;
    app
      .api(path)
      .then((value) => {
        if (owner !== ownerKey()) return;
        save(value);
        errors.delete(key);
      })
      .catch((error) => {
        if (owner === ownerKey()) errors.set(key, error.message);
      })
      .finally(() => {
        if (owner !== actor || owner !== ownerKey()) return;
        pending.delete(key);
        if (app.route()[0] === "arena") app.render();
      });
  }
  function loading(key, label = "正在打开练习") {
    return `<div class="empty-state" data-lesson-loading><h2>${esc(errors.get(key) || label)}</h2>${errors.has(key) ? `<button class="secondary" data-arena-retry="${esc(key)}">再试一次</button>` : "<p>正在准备题目与来源信息…</p>"}</div>`;
  }
  function parts(unit, answer = false) {
    return unit.parts
      .map((part) =>
        part.type === "image"
          ? `<figure class="arena-figure"><button class="arena-image-zoom" data-arena-image="${unit.id}" data-arena-asset="${part.asset}" data-arena-answer="${answer ? "1" : "0"}" aria-label="放大查看${esc(part.alt || "题目图示")}"><img loading="lazy" ${window.BX_MEDIA?.source(`/api/arena/units/${encodeURIComponent(unit.id)}/asset/${part.asset}${answer ? "?answer=1" : ""}`) || `src="/api/arena/units/${encodeURIComponent(unit.id)}/asset/${part.asset}${answer ? "?answer=1" : ""}"`} alt="${esc(part.alt || "原题图示或复杂算式")}" width="${part.width}" height="${part.height}"></button><figcaption>${esc(part.alt || "原题图示 / 算式")} · 点图放大</figcaption></figure>`
          : `<div class="chat-rich arena-text">${rich(part.text)}</div>`,
      )
      .join("");
  }
  function matchLabel(chapter) {
    return chapter.match?.status === "verified"
      ? `<span class="pill mint">已核对教材章节</span>`
      : `<span class="pill">${chapter.match?.status === "extension" ? "拓展 / 衔接" : "章节待核对"}</span>`;
  }
  function referenceParts(answer) {
    if (answer.generated)
      return `${answer.diagramUrl ? `<figure class="arena-figure"><button data-arena-reference-image="${esc(answer.diagramUrl)}" aria-label="放大本题图示"><img loading="lazy" ${window.BX_MEDIA?.source(answer.diagramUrl) || `src="${esc(answer.diagramUrl)}"`} alt="与审核版本一致的本题图示"></button></figure>` : ""}${parts(answer, true)}<button class="text-action" data-go="arena/question/${esc(answer.questionId)}">回到这道题</button>`;
    const originals = answer.parts.filter((p) => p.kind === "reference-source");
    if (!originals.length) return parts(answer, true);
    return `${parts({ ...answer, parts: originals }, true)}<p class="arena-note">数字、算式和图形请按原答案裁图核对，可点图放大。</p><details class="arena-reference-text" data-arena-detail="transcription:${answer.id}"${detailOpen("transcription:" + answer.id)}><summary>查看文字整理，辅助检索</summary>${parts({ ...answer, parts: answer.parts.filter((p) => p.kind !== "reference-source") }, true)}</details>`;
  }
  function courseLinks(course) {
    return `<div class="arena-source-links">${
      course.textbookIds
        ?.slice(0, 1)
        .map(
          (id) =>
            `<button class="secondary" data-go="reader/${id}/1">${app.ico("book-open", "small")}查看对应教材</button>`,
        )
        .join("") || ""
    }${parent() ? `<button class="secondary" data-go="arena/answers/${course.id}">家长参考答案</button><a class="text-action" href="/api/arena/books/${course.id}/bundle">下载 Markdown 与图示</a>` : ""}</div>`;
  }
  function page(route) {
    if (!app) return "";
    if (window.BX_ARENA_LEARNING && !["unit", "answers"].includes(route[1]))
      return window.BX_ARENA_LEARNING.page(route);
    const identity = ownerKey();
    if (actor !== identity) {
      actor = identity;
      catalog = null;
      courses.clear();
      units.clear();
      answerSets.clear();
      answerPages.clear();
      attempts.clear();
      errors.clear();
      detailState.clear();
      pending.clear();
      currentAnswer = "";
      currentQuestion = "";
      lastUnit = "";
      busy = false;
    }
    const type = route[1];
    if (type === "unit") {
      const id = route[2],
        key = "unit:" + id;
      if (!units.has(id)) {
        queueMicrotask(() =>
          fetchOnce(
            key,
            "/api/arena/units/" + encodeURIComponent(id),
            (value) => units.set(id, value),
          ),
        );
        return legacyScreen(
          route,
          (window.BX_ARENA_LEARNING?.navigation(
            { arenaUnitId: id },
            { mode: "unit" },
          ) || "") + loading(key),
        );
      }
      const unit = units.get(id);
      window.BX_ARENA_LEARNING?.registerUnit(unit);
      if (lastUnit !== id) {
        lastUnit = id;
        const saved = localDraft(id) || attempts.get(id)?.[0];
        currentAnswer = saved?.answer || "";
        currentQuestion = saved?.question || "";
      }
      if (!attempts.has(id))
        queueMicrotask(() =>
          fetchOnce(
            "attempt:" + id,
            "/api/arena/attempts?unitId=" +
              encodeURIComponent(id) +
              (app.childId()
                ? "&childId=" + encodeURIComponent(app.childId())
                : ""),
            (value) => {
              attempts.set(id, value.attempts);
              if (
                lastUnit === id &&
                !localDraft(id)?.dirty &&
                !currentAnswer &&
                !currentQuestion
              ) {
                currentAnswer = value.attempts[0]?.answer || "";
                currentQuestion = value.attempts[0]?.question || "";
              }
            },
          ),
        );
      return legacyScreen(
        route,
        `${window.BX_ARENA_LEARNING?.navigation({ arenaUnitId: id, unit }, { mode: "unit" }) || app.back("爪爪竞技场", "arena/chapter/" + id.split(":")[0] + "/" + unit.chapterId)}<div class="arena-study-path"><span>读教材</span><b>→</b><strong>做练习</strong><b>→</b><span>爪爪带着想</span></div><div class="arena-step-nav">${unit.previousUnitId ? `<button class="secondary" data-go="arena/unit/${unit.previousUnitId}">上一组</button>` : "<span></span>"}<small>原册第 ${unit.sourcePage} 页</small>${unit.nextUnitId ? `<button class="secondary" data-go="arena/unit/${unit.nextUnitId}">下一组</button>` : "<span></span>"}</div><section class="arena-problem"><div class="arena-unit-heading"><span class="pill mint">${esc(unit.chapterTitle)}</span><small>${esc(unit.sourceName)} · 文件第 ${unit.sourcePage} 页</small></div><h2>${esc(unit.title)}</h2>${unit.continuation ? `<details class="arena-continuation" data-arena-detail="continuation:${unit.id}"${detailOpen("continuation:" + unit.id, true)}><summary>接上一页的题干</summary>${parts(unit.continuation)}</details>` : ""}${parts(unit)}<p class="arena-ocr-note">扫描资料转成文字，图示和复杂算式按原图保留。遇到数字或条件不清楚，先核对，不猜题。</p></section><section class="arena-work"><label for="arena-qnumber">这页的哪一题？<small>可填“第2题”，也可以留空讨论整段内容</small></label><input id="arena-qnumber" maxlength="80" placeholder="例如：第2题" value="${esc(currentQuestion)}"><label for="arena-answer">写下你的想法</label><textarea id="arena-answer" maxlength="3000" placeholder="我知道……，我想先……">${esc(currentAnswer)}</textarea><div class="arena-work-actions"><button class="secondary" data-arena-save="${id}" ${busy ? "disabled" : ""}>保存作答</button>${app.user()?.role !== "parent" ? `<button class="primary" data-arena-tutor="${id}" ${busy ? "disabled" : ""}>爪爪带我一步步做</button>` : ""}</div><small>${unit.hasAnswer ? "本章有参考资料，爪爪会先核对题目条件，再陪你一步步推导。" : "原资料未匹配到这段的明确答案，爪爪会先看清题目，再一起推导。"}</small></section>${parent() ? `<button class="secondary block" data-go="arena/answers/${id.split(":")[0]}/${unit.chapterId}">查看这一章的参考答案</button>` : ""}`,
      );
    }
    if (type === "course" || type === "answers") {
      const id = route[2],
        key = "course:" + id;
      if (!courses.has(id)) {
        queueMicrotask(() =>
          fetchOnce(key, "/api/arena/books/" + id, (value) =>
            courses.set(id, value),
          ),
        );
        return loading(key);
      }
      const course = courses.get(id),
        chapter = route[3];
      if (type === "answers") {
        if (!parent())
          return app.empty(
            "参考答案由家长保管",
            "你可以回到练习，让爪爪陪你一步步想。",
          );
        const sectionKey = id + ":" + (chapter || "all"),
          answerPage = answerPages.get(sectionKey) || 1,
          answerKey = sectionKey + ":" + answerPage;
        if (!answerSets.has(answerKey)) {
          queueMicrotask(() =>
            fetchOnce(
              "answers:" + answerKey,
              "/api/arena/answers?book=" +
                id +
                (chapter ? "&chapter=" + encodeURIComponent(chapter) : "") +
                "&page=" +
                answerPage,
              (value) => answerSets.set(answerKey, value),
            ),
          );
          return loading("answers:" + answerKey, "正在核对参考答案");
        }
        const referencePage = answerSets.get(answerKey),
          answers = referencePage.answers;
        return legacyScreen(
          route,
          `${window.BX_ARENA_LEARNING?.navigation({ courseId: id, chapterId: chapter, book: course }, { mode: "answers" }) || app.back("家长参考答案", "arena/course/" + id)}<h2 class="arena-course-title">${esc(course.title)}</h2><p class="arena-note">供家长核对和引导。请对照题号、数值与条件；拓展题和教材原题不能混用答案。</p>${chapter ? `<button class="text-action" data-go="arena/answers/${id}">查看本册全部答案</button>` : ""}${answers.length ? answers.map((answer) => `<details class="arena-answer" data-arena-detail="answer:${answer.id}"${detailOpen("answer:" + answer.id)}><summary>${esc(answer.title)}<small>${esc(answer.sourceName)}${answer.generated ? "" : " · 文件第 " + answer.sourcePage + " 页"}</small></summary>${referenceParts(answer)}</details>`).join("") : app.empty("这一章没有明确匹配的参考答案", "可以查看本册全部答案，或结合原题进行核对。")}${referencePage.pages > 1 ? `<nav class="chinese-pagination" aria-label="配套答案分页"><button class="secondary" data-arena-reference-page="${referencePage.page - 1}" data-reference-section="${esc(sectionKey)}" ${referencePage.page <= 1 ? "disabled" : ""}>上一页</button><span>${referencePage.page}/${referencePage.pages} · ${referencePage.total}题</span><button class="secondary" data-arena-reference-page="${referencePage.page + 1}" data-reference-section="${esc(sectionKey)}" ${referencePage.page >= referencePage.pages ? "disabled" : ""}>下一页</button></nav>` : ""}<a class="secondary block" href="/api/arena/books/${id}/bundle">下载本册 Markdown 与必要图示</a>`,
        );
      }
      const selected = course.chapters.find((c) => c.id === chapter);
      const list = chapter
        ? course.units.filter((u) => u.chapterId === chapter)
        : [];
      return `${app.back(selected ? selected.title : "爪爪竞技场", chapter ? "arena/course/" + id : "arena")}<h2 class="arena-course-title">${esc(course.title)}</h2><p class="arena-note">${course.gradeLabel} · ${esc(course.version)} · ${esc(course.modeLabel)} · ${course.unitCount} 组原题练习</p>${courseLinks(course)}${chapter ? `${matchLabel(selected || {})}<div class="arena-unit-list">${list.map((unit, i) => `<button data-go="arena/unit/${unit.id}"><span class="arena-number">${i + 1}</span><span><strong>${esc(unit.title)}</strong><small>来源文件第 ${unit.sourcePage} 页${unit.hasAnswer ? " · 已关联参考资料" : ""}</small></span>${app.ico("chevron-right", "small")}</button>`).join("")}</div>${!list.length ? app.empty("这一章暂未整理出练习", "请返回选择其他章节。") : ""}` : `<div class="arena-chapters">${course.chapters.map((ch) => `<button data-go="arena/course/${id}/${ch.id}"><div><strong>${esc(ch.title)}</strong><small>${ch.unitCount} 组练习${ch.match?.title ? " · 对应教材：" + esc(ch.match.title) : ""}</small></div>${matchLabel(ch)}</button>`).join("")}</div>`}`;
    }
    if (!catalog) {
      queueMicrotask(() =>
        fetchOnce("catalog", "/api/arena", (value) => (catalog = value)),
      );
      return (
        app.back("爪爪竞技场", "home") +
        loading("catalog", "正在整理年级与教材章节")
      );
    }
    const textbook = type === "book" ? route[2] : "",
      all = catalog.books;
    const selection = app.selection();
    const items = all.filter((course) =>
      textbook
        ? course.textbookIds.includes(textbook)
        : course.grades.includes(Number(filters.grade || selection.grade)) &&
          (!filters.subject || course.subject === filters.subject) &&
          (!filters.version || course.version === filters.version),
    );
    const versions = [
      ...new Set(
        all
          .filter((c) =>
            c.grades.includes(Number(filters.grade || selection.grade)),
          )
          .map((c) => c.version),
      ),
    ];
    return `${app.back("爪爪竞技场", textbook ? "reader/" + textbook + "/" + (selection.reading?.[textbook]?.page || 1) : "home")}<div class="arena-intro"><span class="pill mint">教材 · 练习 · AI 辅导</span><h2>从读懂一页，到自己做出来</h2><p>选教材和章节，做原题，卡住时让爪爪陪你想下一步。</p></div>${
      textbook
        ? `<p class="arena-note">这里只显示通过章节匹配校验、关联这本教材的资料。</p><button class="text-action" data-go="arena">查看同年级拓展与衔接资料</button>`
        : `<div class="arena-filters"><select id="arena-grade" aria-label="练习年级">${[1, 2, 3, 4, 5, 6].map((g) => `<option value="${g}" ${Number(filters.grade || selection.grade) === g ? "selected" : ""}>${g}年级</option>`).join("")}</select><select id="arena-subject" aria-label="练习学科"><option value="">全部学科</option>${[
            ["math", "数学"],
            ["chinese", "语文"],
            ["english", "英语"],
          ]
            .map(
              ([v, t]) =>
                `<option value="${v}" ${filters.subject === v ? "selected" : ""}>${t}</option>`,
            )
            .join(
              "",
            )}</select><select id="arena-version" aria-label="练习版本"><option value="">全部版本</option>${versions.map((v) => `<option ${filters.version === v ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></div>`
    }<div class="arena-courses">${items.map((course) => `<button class="arena-course" data-go="arena/course/${course.id}"><span class="pill ${course.subject === "math" ? "orange" : "mint"}">${esc(course.gradeLabel)} · ${esc(course.subjectLabel)}</span><h3>${esc(course.title)}</h3><p>${esc(course.version)} · ${esc(course.modeLabel)}</p><small>${course.chapterCount} 个章节 / 专题 · ${course.unitCount} 组练习</small><span class="arena-course-bottom">${course.verifiedChapters ? "已校验 " + course.verifiedChapters + " 个教材章节" : "拓展与衔接练习"}${app.ico("arrow-right", "small")}</span></button>`).join("")}</div>${!items.length ? app.empty("当前没有已匹配的练习资料", "可以选择其他年级、版本，或从全部资料查看独立拓展。") : ""}<p class="arena-note">${parent() ? `${catalog.summary.sources || 0} 份资料已按年级整理，每册一个 Markdown，图示单独保留。参考答案由家长查看。` : "先读懂题目，再写下你的想法。卡住时，爪爪陪你迈出下一小步。"}</p>`;
  }
  const filters = { grade: "", subject: "", version: "" };
  document.addEventListener("change", (event) => {
    if (!event.target.id?.startsWith("arena-")) return;
    const key = event.target.id.slice(6);
    if (!(key in filters)) return;
    filters[key] = event.target.value;
    if (key === "grade") filters.version = "";
    app.render();
  });
  document.addEventListener("input", (event) => {
    if (event.target.id === "arena-answer") currentAnswer = event.target.value;
    if (event.target.id === "arena-qnumber")
      currentQuestion = event.target.value;
    if (["arena-answer", "arena-qnumber"].includes(event.target.id))
      keepDraft();
  });
  document.addEventListener("click", (event) => {
    const summary = event.target.closest("summary"),
      details = summary?.parentElement;
    if (details?.dataset.arenaDetail) {
      detailState.set(details.dataset.arenaDetail, !details.open);
      return;
    }
    const button = event.target.closest("button");
    if (!button || button.disabled || !app) return;
    if (button.dataset.go) keepDraft();
    if (button.dataset.arenaImage) {
      app.modal(
        "题目图示 · 可拖动查看",
        `<div class="arena-image-view"><img src="/api/arena/units/${encodeURIComponent(button.dataset.arenaImage)}/asset/${button.dataset.arenaAsset}${button.dataset.arenaAnswer === "1" ? "?answer=1" : ""}" alt="题目图示完整内容"></div>`,
      );
      return;
    }
    if (button.dataset.arenaRetry) {
      errors.delete(button.dataset.arenaRetry);
      app.render();
      return;
    }
    if (actor !== ownerKey()) return;
    if (button.dataset.arenaReferencePage) {
      answerPages.set(
        button.dataset.referenceSection,
        Math.max(1, Number(button.dataset.arenaReferencePage) || 1),
      );
      app.render();
      return;
    }
    if (button.dataset.arenaReferenceImage) {
      window.BX_IMAGES.open(
        app,
        button.dataset.arenaReferenceImage,
        "本题图示",
      );
      return;
    }
    const id = button.dataset.arenaSave || button.dataset.arenaTutor;
    if (!id || busy) return;
    const unit = units.get(id);
    if (!unit) return;
    if (button.dataset.arenaSave && !currentAnswer.trim()) {
      app.toast("先写下你的想法，再保存。");
      return;
    }
    const owner = actor,
      answer = currentAnswer,
      question = currentQuestion;
    busy = true;
    app.render();
    (async () => {
      if (answer.trim()) {
        await app.api("/api/arena/attempt", {
          unitId: id,
          question,
          answer,
          childId: app.childId(),
        });
        if (owner !== ownerKey()) return;
        attempts.set(id, [{ question, answer }]);
        if (
          lastUnit === id &&
          currentAnswer === answer &&
          currentQuestion === question
        )
          keepDraft(false);
      }
      if (owner !== ownerKey()) return;
      if (button.dataset.arenaTutor) app.tutor(unit, { question, answer });
      else app.toast("想法已保存。可以接着做，或请爪爪给一步提示。");
    })()
      .catch((error) => {
        if (owner === ownerKey()) app.toast(error.message);
      })
      .finally(() => {
        if (owner !== ownerKey()) return;
        busy = false;
        if (app.route()[0] === "arena") app.render();
      });
  });
  document.addEventListener(
    "toggle",
    (event) => {
      const target = event.target;
      if (target.isConnected !== false && target.dataset?.arenaDetail)
        detailState.set(target.dataset.arenaDetail, target.open);
    },
    true,
  );
  window.BX_ARENA = {
    connect(value) {
      app = value;
      window.BX_ARENA_LEARNING?.connect(value);
    },
    page,
  };
})();
