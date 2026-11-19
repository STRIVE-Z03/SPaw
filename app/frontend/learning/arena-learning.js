(function () {
  "use strict";
  let app,
    actor = "",
    catalog = null,
    textbooks = null,
    pending = new Set(),
    failures = new Map(),
    subject = "math",
    channel = "sync",
    progress = null,
    resumeInfo = null;
  const courses = new Map(),
    chapters = new Map(),
    questions = new Map(),
    drafts = new Map(),
    timers = new Map(),
    checking = new Set(),
    hinted = new Set(),
    viewSaving = new Set(),
    visits = new Map(),
    unitContexts = new Map();
  let activeQuestion = "";
  const esc = (value) => app.esc(value),
    rich = (value) =>
      window.BX_CHAT?.markdown(value) || esc(value).replace(/\n/g, "<br>");
  const actorKey = () =>
      String(app.user()?.id || "") + ":" + String(app.childId() || ""),
    parent = () => ["admin", "parent"].includes(app.user()?.role),
    isAdmin = () => app.user()?.role === "admin";
  const publicImage = (url) => window.BX_MEDIA?.asset(url) || url;
  const fi = (name) =>
    `<img class="lesson-ficon" src="${publicImage(`assets/figma/${name}.svg`)}" alt="">`;
  const cat = () =>
    `<span class="lesson-cat" aria-hidden="true"><img src="${publicImage("assets/figma/lower-paw.svg")}" class="lower" alt=""><img src="${publicImage("assets/figma/kitten-head.svg")}" class="head" alt=""><img src="${publicImage("assets/figma/raised-paw.svg")}" class="raised" alt=""></span>`;
  const kind = (q) =>
    ({
      choice: "选择题",
      fill: "填空题",
      reading: "阅读思考",
      calculation: "计算题",
      written: "解答题",
    })[q.type] || "思考与作答";
  const level = (q) =>
    ({ basic: "基础", medium: "中等", advanced: "进阶" })[q.difficulty] || "";
  const point = (q) =>
    q.knowledgePointTitle ||
    (typeof q.knowledgePoint === "string"
      ? q.knowledgePoint
      : q.knowledgePoint?.name || q.knowledgePoint?.title || "");
  function legacySources(ch) {
    return [
      ...new Map(
        (ch?.legacySources || [])
          .filter(
            (v) =>
              /^[a-f0-9]{20}$/.test(v.courseId || "") &&
              /^[a-f0-9]{12}$/.test(v.chapterId || "") &&
              Number(v.questionCount) > 0,
          )
          .map((v) => [v.courseId + ":" + v.chapterId, v]),
      ).values(),
    ];
  }
  function chapterAvailability(book, ch) {
    const count = Number(ch.questionCount ?? ch.unitCount ?? 0) || 0,
      sources = legacySources(ch),
      old = sources.reduce((sum, v) => sum + Number(v.questionCount), 0);
    return book.curriculumCourse
      ? "预置 " +
          count +
          (ch.targetQuestionCount ? " / " + ch.targetQuestionCount : "") +
          " 题" +
          (count ? "" : " · 整理中") +
          (old
            ? sources.length > 1
              ? " · 原配套共 " + old + " 题 / " + sources.length + " 份"
              : " · 原配套 " + old + " 题可练"
            : "")
      : count > 0
        ? count + " 道 / 项练习"
        : book.generatedCourse
          ? "内容整理中"
          : "暂无练习";
  }
  function chapterDestination(book, ch) {
    const sources = legacySources(ch),
      source =
        book.curriculumCourse &&
        !(ch.questionCount ?? ch.unitCount ?? 0) &&
        sources.length === 1
          ? sources[0]
          : null;
    return source
      ? { courseId: source.courseId, chapterId: source.chapterId }
      : { courseId: book.id, chapterId: ch.id };
  }
  function revisionHint(book) {
    if (!book?.hasAlternateRevision) return "";
    const titles = (book.tocPreview || [])
      .slice(0, 3)
      .map((v) => (typeof v === "string" ? v : v.title || ""))
      .filter(Boolean);
    return `<p class="lesson-revision-hint">${esc(book.matchingTip || "同版教材有不同目录，请对照手里的课本选择。")}${titles.length ? `<br>目录：${esc(titles.join(" · "))}` : ""}</p>`;
  }
  function questionTags(q) {
    return q.generated
      ? `<div class="lesson-question-tags"><span>AI原创</span>${level(q) ? `<span>${esc(level(q))}</span>` : ""}${point(q) ? `<span>${esc(point(q))}</span>` : ""}${q.qualityStatus === "four-role-reviewed" ? "<span>四个模拟角色逐题复核</span>" : ""}</div>`
      : "";
  }
  function progressFor(q) {
    const local = drafts.get(q.id) || stored(q.id),
      remote = progress?.[q.id];
    return local?.dirty ? "working" : remote?.state || "new";
  }
  const stateLabel = (value) =>
    ({
      correct: "已核对",
      review: "待巩固",
      working: "作答中",
      skipped: "已跳过",
      new: "未开始",
    })[value] || "未开始";
  function ensureProgress() {
    if (progress === null)
      queueMicrotask(() =>
        fetchOnce(
          "progress",
          "/api/arena/progress" +
            (app.childId() ? "?childId=" + app.childId() : ""),
          (v) => (progress = v.progress),
        ),
      );
  }
  function recordProgress(q, value) {
    if (progress === null) return;
    const check = value.check;
    progress[q] = {
      state:
        check?.answer === value.answer && check.result?.verdict === "correct"
          ? "correct"
          : check?.answer === value.answer && check.result?.verdict === "check"
            ? "review"
            : "working",
      updated: Date.now() / 1000,
    };
  }
  const storage = (q) => "bx-arena-draft:" + actor + ":" + q;
  const uuid = () =>
    typeof crypto?.randomUUID === "function"
      ? crypto.randomUUID()
      : Date.now().toString(36) + "_" + Math.random().toString(36).slice(2);
  function reset() {
    const next = actorKey();
    if (next === actor) return;
    actor = next;
    progress = null;
    catalog = null;
    textbooks = null;
    resumeInfo = null;
    pending.clear();
    failures.clear();
    courses.clear();
    chapters.clear();
    questions.clear();
    unitContexts.clear();
    drafts.clear();
    visits.clear();
    viewSaving.clear();
    activeQuestion = "";
    checking.clear();
    hinted.clear();
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    const prefs = readNavigation("preferences", {});
    subject = ["math", "chinese", "english"].includes(prefs.subject)
      ? prefs.subject
      : "math";
    channel = ["sync", "extension", "workbooks"].includes(prefs.channel)
      ? prefs.channel
      : "sync";
  }
  function refresh() {
    if (["arena", "home", "ai"].includes(app.route()[0])) app.render();
  }
  function fetchOnce(key, url, save) {
    if (pending.has(key) || failures.has(key)) return;
    pending.add(key);
    const owner = actor;
    app
      .api(url)
      .then((value) => {
        if (owner !== actorKey()) return;
        save(value);
      })
      .catch((error) => {
        if (owner === actor) {
          failures.set(key, error.message);
          if (
            key.startsWith("home-question:") &&
            [400, 404].includes(error.status)
          ) {
            try {
              localStorage.setItem("bx-arena-resume:" + actor, "");
            } catch (_) {}
          }
        }
      })
      .finally(() => {
        if (owner !== actor) return;
        pending.delete(key);
        refresh();
      });
  }
  function loading(key) {
    return `<div class="empty-state" data-lesson-loading><h2>${esc(failures.get(key) || "正在打开章节练习")}</h2>${failures.has(key) ? `<button class="secondary" data-lesson-retry="${key}">重新打开</button>` : "<p>题目、图示和保存记录会一起恢复。</p>"}</div>`;
  }
  function course(id) {
    if (!courses.has(id)) {
      queueMicrotask(() =>
        fetchOnce("course:" + id, "/api/arena/books/" + id, (value) =>
          courses.set(id, value),
        ),
      );
      return null;
    }
    return courses.get(id);
  }
  function chapter(id, ch) {
    const key = id + ":" + ch;
    if (!chapters.has(key)) {
      queueMicrotask(() =>
        fetchOnce(
          "chapter:" + key,
          "/api/arena/chapter?book=" + id + "&chapter=" + ch,
          (value) => chapters.set(key, value),
        ),
      );
      return null;
    }
    return chapters.get(key);
  }
  function stored(q) {
    try {
      return JSON.parse(localStorage.getItem(storage(q)) || "null");
    } catch (_) {
      return null;
    }
  }
  function persist(q) {
    const value = drafts.get(q);
    try {
      localStorage.setItem(
        storage(q),
        JSON.stringify({
          answer: value.answer,
          revision: value.revision,
          dirty: value.dirty,
          check: value.check,
          at: Date.now(),
        }),
      );
    } catch (_) {
      value.status = "本机缓存不可用，请保持网络连接";
    }
  }
  function work(q) {
    if (!drafts.has(q)) {
      const local = stored(q);
      drafts.set(q, {
        answer: local?.answer || "",
        revision: local?.revision || 0,
        dirty: !!local?.dirty,
        loaded: false,
        saving: false,
        status: local?.dirty ? "本机草稿待同步" : "正在恢复记录",
        check: local?.check || null,
        conflict: null,
      });
      recoverWork(q);
    }
    return drafts.get(q);
  }
  function recoverWork(q) {
    queueMicrotask(() =>
      fetchOnce(
        "work:" + q,
        "/api/arena/questions/" +
          q +
          "/work" +
          (app.childId() ? "?childId=" + app.childId() : ""),
        (remote) => {
          const value = drafts.get(q);
          if (!value) return;
          value.loaded = true;
          value.check = remote.check;
          const local = view(q);
          if (
            remote.view &&
            (!local?.dirty || local.revision !== remote.view.revision)
          ) {
            putView(q, { ...remote.view, dirty: false });
            if (remote.view.hint?.key)
              window.BX_HINTS?.restore(remote.view.hint.key, remote.view.hint);
          }
          if (activeQuestion === q) saveView(q);
          if (value.dirty) {
            if (
              value.revision !== remote.revision &&
              value.answer !== remote.answer
            ) {
              value.conflict = remote;
              value.status = "发现另一处更新，本机草稿已保留";
            } else {
              value.revision = remote.revision;
              queueMicrotask(() => save(q));
            }
          } else {
            value.answer = remote.answer;
            value.revision = remote.revision;
            value.status = "已同步";
            persist(q);
          }
          if (remote.check?.job_id && remote.check.status === "running")
            poll(q, remote.check.job_id);
        },
      ),
    );
  }
  function status(q) {
    const value = drafts.get(q),
      node = document.querySelector('[data-lesson-save-status="' + q + '"]');
    if (node && value) node.textContent = value.status;
    const retry = document.querySelector('[data-lesson-sync="' + q + '"]');
    if (retry && value)
      retry.hidden = !value.dirty || value.saving || !!value.conflict;
  }
  async function save(q, keepalive = false) {
    if (!app || actor !== actorKey()) return;
    const value = drafts.get(q);
    if (!value?.dirty || value.saving || !value.loaded || value.conflict)
      return;
    value.saving = true;
    value.status = "正在同步";
    status(q);
    const answer = value.answer,
      revision = value.revision,
      owner = actor;
    try {
      const result = await app.api(
        "/api/arena/questions/" + q + "/work",
        { answer, revision, childId: app.childId() },
        { keepalive },
      );
      if (owner !== actorKey()) return;
      recordProgress(q, value);
      value.revision = result.revision;
      value.dirty = value.answer !== answer;
      value.retries = 0;
      value.status = value.dirty ? "本机草稿待同步" : "已同步";
      persist(q);
    } catch (error) {
      if (owner !== actorKey()) return;
      if (error.status === 409) {
        value.conflict = error.data;
        value.status = "发现另一处更新，本机草稿已保留";
        refresh();
      } else {
        value.retries = (value.retries || 0) + 1;
        value.status =
          value.retries >= 3
            ? "草稿已保留，点“重新同步”重试"
            : "已保存在本机，联网后继续同步";
      }
    } finally {
      value.saving = false;
      status(q);
      if (
        owner === actorKey() &&
        value.dirty &&
        !value.conflict &&
        (value.retries || 0) < 3 &&
        window.navigator?.onLine !== false
      ) {
        clearTimeout(timers.get(q));
        timers.set(
          q,
          setTimeout(
            () => save(q),
            Math.min(15000, 1500 * 2 ** (value.retries || 0)),
          ),
        );
      }
    }
  }
  function resume(q) {
    try {
      localStorage.setItem("bx-arena-resume:" + actor, q);
      localStorage.setItem("bx-arena-resume-at:" + actor, String(Date.now()));
    } catch (_) {}
  }
  function last() {
    try {
      const id = localStorage.getItem("bx-arena-resume:" + actor) || "";
      return /^[a-f0-9]{20}:[a-f0-9]{16}:[a-f0-9]{12}$/.test(id) ? id : "";
    } catch (_) {
      return "";
    }
  }
  function readNavigation(name, fallback) {
    try {
      return (
        JSON.parse(
          localStorage.getItem("bx-arena-navigation:" + actor + ":" + name) ||
            "null",
        ) ?? fallback
      );
    } catch (_) {
      return fallback;
    }
  }
  function writeNavigation(name, value) {
    try {
      localStorage.setItem(
        "bx-arena-navigation:" + actor + ":" + name,
        JSON.stringify(value),
      );
    } catch (_) {}
  }
  function filterFor(id, ch) {
    const key = actor + ":" + id + ":" + ch;
    if (!chapterFilters.has(key)) {
      const saved = readNavigation("filter:" + id + ":" + ch, {});
      chapterFilters.set(key, {
        level: ["all", "basic", "medium", "advanced"].includes(saved.level)
          ? saved.level
          : "all",
        point: typeof saved.point === "string" ? saved.point.slice(0, 120) : "",
      });
    }
    return chapterFilters.get(key);
  }
  function setFilter(id, ch, patch) {
    const value = { ...filterFor(id, ch), ...patch };
    chapterFilters.set(actor + ":" + id + ":" + ch, value);
    writeNavigation("filter:" + id + ":" + ch, value);
  }
  function routePosition(route) {
    const value = readNavigation("position:" + route, {});
    return Number.isFinite(value.top) && value.top >= 0 ? value.top : 0;
  }
  function screen(route, html) {
    return `<div class="lesson-screen" data-lesson-screen="${esc(Array.isArray(route) ? route.join("/") : route)}" data-lesson-ready="${!html.includes("data-lesson-loading")}">${html}</div>`;
  }
  function locationFor(raw = {}) {
    const questionId = raw.questionId || "",
      unitId = raw.arenaUnitId || raw.unitId || "",
      q = questions.get(questionId),
      unit = raw.unit || unitContexts.get(unitId);
    if (questionId && !q)
      queueMicrotask(() =>
        fetchOnce(
          "question:" + questionId,
          "/api/arena/questions/" + questionId,
          (value) => questions.set(questionId, value),
        ),
      );
    if (unitId && !unit && !questionId)
      queueMicrotask(() =>
        fetchOnce(
          "nav-unit:" + unitId,
          "/api/arena/units/" + encodeURIComponent(unitId),
          (value) => unitContexts.set(unitId, value),
        ),
      );
    const id = raw.courseId || questionId.split(":")[0] || unitId.split(":")[0],
      ch = raw.chapterId || q?.chapterId || unit?.chapterId || "",
      part = chapters.get(id + ":" + ch),
      book = raw.book || courses.get(id) || part?.book || q?.course;
    if (id && !book) course(id);
    const chapterTitle =
      raw.chapterTitle ||
      q?.chapterTitle ||
      unit?.chapterTitle ||
      part?.chapter?.title ||
      book?.chapters?.find((c) => c.id === ch)?.title ||
      "";
    const position =
        q?.chapterPosition ||
        (part?.questions.findIndex((item) => item.id === questionId) ?? -1) + 1,
      total = q?.chapterTotal || part?.questions.length || 0;
    return {
      id,
      ch,
      q,
      unit,
      questionId,
      unitId,
      book: book || courses.get(id),
      chapterTitle,
      position,
      total,
    };
  }
  function identityLabel(book) {
    return [
      book?.gradeLabel || (book?.grade ? book.grade + "年级" : ""),
      book?.subjectLabel ||
        { math: "数学", chinese: "语文", english: "英语" }[book?.subject] ||
        "",
      book?.version,
      book?.term === 2 ? "下册" : book?.term === 1 ? "上册" : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }
  function navigation(raw = {}, options = {}) {
    if (!app) return "";
    reset();
    const info = locationFor(raw),
      mode = options.mode || "question";
    if (!info.id) return "";
    const title =
        info.chapterTitle || (mode === "course" ? "本册目录" : "正在定位章节"),
      identity = identityLabel(info.book),
      suffix =
        mode === "ai"
          ? "答疑"
          : mode === "unit"
            ? "历史原段落"
            : mode === "answers"
              ? "家长参考"
              : mode === "question" && info.position && info.total
                ? info.position + "/" + info.total + "题"
                : mode === "chapter"
                  ? "本章练习"
                  : "";
    const origin = info.questionId
      ? "arena/question/" + info.questionId
      : info.unitId
        ? "arena/unit/" + info.unitId
        : info.ch
          ? "arena/chapter/" + info.id + "/" + info.ch
          : "arena/course/" + info.id;
    return `<nav class="lesson-location" aria-label="当前学习位置"><button class="lesson-location-directory" data-lesson-directory="${esc(info.id)}" data-chapter="${esc(info.ch)}" data-origin="${esc(origin)}" aria-label="打开本册目录，切换章节">${app.ico("book-open", "small")}<span>目录</span></button><div class="lesson-location-current">${identity ? `<small title="${esc(identity)}">${esc(identity)}</small>` : ""}<strong title="${esc(title)}">${esc(title)}${suffix ? `<span>${esc(suffix)}</span>` : ""}</strong></div>${mode === "ai" ? `<button class="lesson-location-return" data-go="${esc(origin)}">${info.questionId ? "回原题" : info.unitId ? "回练习" : "回本章"}</button>` : `<button class="lesson-location-more" data-lesson-more="${esc(info.id)}" data-chapter="${esc(info.ch)}" data-question="${esc(info.questionId)}" data-unit="${esc(info.unitId)}" data-mode="${esc(mode)}" aria-label="更多学习操作">•••</button>`}</nav>`;
  }
  function more(info, mode) {
    const q = info.q,
      lastId = last();
    app.modal(
      "学习与记录",
      `<div class="lesson-more-menu"><p class="lesson-menu-identity">${esc(identityLabel(info.book))}</p><h3>${esc(info.chapterTitle || info.book?.title || "本册练习")}</h3>${info.ch ? `<button class="secondary block" data-go="arena/chapter/${esc(info.id)}/${esc(info.ch)}">本章题目与记录</button>` : ""}${q && !q.retired ? `<button class="secondary block" data-lesson-discuss="${esc(q.id)}">继续问爪爪</button>${q.practiceGroup ? `<button class="text-action" data-lesson-skip="${esc(q.id)}">这个知识点我会了</button>` : ""}${parent() ? `<button class="text-action" data-lesson-reference="${esc(q.id)}">家长核对参考</button>` : ""}${isAdmin() ? `<button class="text-action" data-lesson-review="${esc(q.id)}">核对本题答案</button>` : ""}` : ""}${lastId ? `<button class="secondary block" data-go="arena/question/${lastId}">继续上次${questions.get(lastId)?.chapterTitle ? " · " + esc(questions.get(lastId).chapterTitle) : ""}</button>` : ""}<button class="text-action" data-go="arena/course/${esc(info.book?.canonicalCourseId || info.id)}">${info.book?.canonicalCourseId ? "教材章节目录" : "本册目录页"}</button><button class="text-action" data-go="arena">我的教材与练习册</button>${q ? `<details class="lesson-menu-source"><summary>来源与旧记录</summary><p>${esc(sourceLabel(q))}${q.generated ? " · AI原创专项练习" : " · 原文件第 " + q.sourcePage + " 页"}</p><p>${q.generated ? "按本章知识点生成，经四个模拟角色逐题复核；非教材出版社原题。" : "章节关联不代表本题已有出版社标准答案。"}</p>${!q.generated ? `<button class="text-action" data-go="arena/unit/${esc(q.unitId)}">原段落与历史想法</button>` : ""}</details>` : ""}</div>`,
    );
  }
  function view(q) {
    try {
      return JSON.parse(
        localStorage.getItem("bx-arena-view:" + actor + ":" + q) || "null",
      );
    } catch (_) {
      return null;
    }
  }
  function putView(q, value) {
    try {
      localStorage.setItem(
        "bx-arena-view:" + actor + ":" + q,
        JSON.stringify(value),
      );
    } catch (_) {}
  }
  function rememberView(q, patch) {
    putView(q, { ...(view(q) || {}), ...patch, dirty: true, at: Date.now() });
    clearTimeout(timers.get("view:" + q));
    timers.set(
      "view:" + q,
      setTimeout(() => saveView(q), 650),
    );
  }
  async function saveView(q, keepalive = false) {
    if (
      !app ||
      actor !== actorKey() ||
      viewSaving.has(q) ||
      !drafts.get(q)?.loaded ||
      !questions.has(q)
    )
      return;
    const value = view(q) || { top: 0, revision: 0 },
      visit = visits.get(q) === 0;
    if (!value.dirty && !visit) return;
    const owner = actor;
    viewSaving.add(q);
    try {
      const result = await app.api(
        "/api/arena/questions/" + q + "/view",
        {
          view: {
            ...value,
            revision: value.revision || 0,
            visit,
            visitToken: visits.get(q) || value.visitToken || 0,
          },
          childId: app.childId(),
        },
        { keepalive },
      );
      if (owner !== actorKey()) return;
      if (result.view.conflict) {
        putView(q, { ...result.view, dirty: false });
        app.toast("已保留另一处较新的学习位置，当前作答不受影响");
        if (visit) setTimeout(() => saveView(q), 0);
      } else {
        visits.set(q, result.view.visitToken);
        if (visit && activeQuestion === q) {
          try {
            localStorage.setItem(
              "bx-arena-resume-token:" + actor,
              String(result.view.visitToken),
            );
          } catch (_) {}
        }
        const newer = view(q);
        putView(
          q,
          newer?.at !== value.at
            ? {
                ...newer,
                revision: result.view.revision,
                visitToken: result.view.visitToken,
              }
            : { ...result.view, dirty: false },
        );
      }
    } catch (_) {
      /* Position remains local; answer synchronization has its own visible status. */
    } finally {
      viewSaving.delete(q);
    }
  }
  function resumeCard() {
    reset();
    if (
      !pending.has("home-resume") &&
      !failures.has("home-resume") &&
      resumeInfo === null
    ) {
      queueMicrotask(() =>
        fetchOnce(
          "home-resume",
          "/api/arena/resume" +
            (app.childId() ? "?childId=" + app.childId() : ""),
          (v) => {
            resumeInfo = v;
            if (v.question) {
              questions.set(v.question.id, v.question);
              let token = 0;
              try {
                token = Number(
                  localStorage.getItem("bx-arena-resume-token:" + actor) || 0,
                );
              } catch (_) {}
              if (
                !last() ||
                (v.record?.visit_token > token && !stored(last())?.dirty)
              ) {
                resume(v.question.id);
                try {
                  localStorage.setItem(
                    "bx-arena-resume-token:" + actor,
                    String(v.record.visit_token),
                  );
                } catch (_) {}
              }
            }
          },
        ),
      );
    }
    const remembered = last();
    if (remembered && !questions.has(remembered))
      queueMicrotask(() =>
        fetchOnce(
          "home-question:" + remembered,
          "/api/arena/questions/" + remembered,
          (v) => questions.set(remembered, v),
        ),
      );
    const q = questions.get(last()) || resumeInfo?.question,
      id = last() || q?.id;
    if (!id) return "";
    return {
      id,
      title: q?.chapterTitle || "上次章节练习",
      detail: q
        ? `${q.course?.gradeLabel || ""} · ${q.chapterPosition ? "第 " + q.chapterPosition + " / " + q.chapterTotal + " 题" : q.title} · 选项、草稿与提示自动保存`
        : "回到原题，接着上次的想法",
    };
  }
  const selected = (answer) => (/^[A-F](?:\n|$)/.test(answer) ? answer[0] : "");
  const reasoning = (answer) =>
    selected(answer)
      ? answer.split("\n想法：").slice(1).join("\n想法：")
      : answer;
  const combine = (option, idea) =>
    option + (idea ? (option ? "\n想法：" : "") + idea : "");
  function capture() {
    if (!app || actor !== actorKey()) return null;
    const element = document.querySelector("[data-lesson-question]"),
      host = document.querySelector("[data-lesson-screen]"),
      q = element?.dataset.lessonQuestion || "",
      route = host?.dataset.lessonScreen || (q ? "arena/question/" + q : "");
    if (!route) return null;
    const input = element?.querySelector("#lesson-answer"),
      ready =
        host?.dataset.lessonReady !== "false" && (!q || drafts.get(q)?.loaded),
      snapshot = {
        q,
        route,
        ready,
        top: window.scrollY,
        focused: !!input && document.activeElement === input,
        start: input?.selectionStart,
        end: input?.selectionEnd,
      };
    if (ready) {
      writeNavigation("position:" + route, {
        top: snapshot.top,
        at: Date.now(),
      });
      if (q) rememberView(q, { top: snapshot.top });
    }
    return snapshot;
  }
  function restore(saved) {
    if (!app || actor !== actorKey() || app.route()[0] !== "arena") return;
    const element = document.querySelector("[data-lesson-question]"),
      host = document.querySelector("[data-lesson-screen]"),
      q = element?.dataset.lessonQuestion || "",
      route = host?.dataset.lessonScreen || (q ? "arena/question/" + q : "");
    if (!route || host?.dataset.lessonReady === "false") return;
    const same = saved?.route === route && saved.ready !== false,
      top = same
        ? saved.top
        : q
          ? (view(q)?.top ?? routePosition(route))
          : routePosition(route);
    window.scrollTo(0, top);
    if (same && saved.focused) {
      const input = element?.querySelector("#lesson-answer");
      input?.focus({ preventScroll: true });
      try {
        input?.setSelectionRange(saved.start, saved.end);
      } catch (_) {}
    }
  }
  function sourceLabel(q) {
    return String(q.sourceName || "题目来源")
      .replace(/\.pdf$/i, "")
      .replace(/主书|参考答案/g, "原册资料");
  }
  function image(q, url, support = false) {
    url = url || q.diagramUrl || q.imageUrl;
    if (!url) return "";
    const size = url.includes("continuation")
      ? q.continuationSize
      : support
        ? q.supportSize
        : q.imageSize;
    return `<button class="lesson-image-button" data-lesson-image="${esc(url)}" aria-label="完整查看${support ? "阅读材料" : q.generated ? "本题配图" : "原题"}"><img ${window.BX_MEDIA?.source(url) || `src="${esc(url)}"`} alt="${esc(support ? "与本题相关的阅读材料" : q.generated ? q.diagramAlt || "本题配图，请结合题干阅读" : "当前题目的原始文字、算式与图示")}" ${size ? `width="${size[0]}" height="${size[1]}"` : ""} data-hint-figure loading="${support ? "lazy" : "eager"}"></button>`;
  }
  function questionPage(id) {
    if (!questions.has(id)) {
      queueMicrotask(() =>
        fetchOnce("question:" + id, "/api/arena/questions/" + id, (value) =>
          questions.set(id, value),
        ),
      );
      return loading("question:" + id);
    }
    const q = questions.get(id),
      value = work(id),
      part = chapter(id.split(":")[0], q.chapterId),
      index = part?.questions.findIndex((v) => v.id === id) ?? -1,
      previous = part?.questions[index - 1],
      next = part?.questions
        .slice(index + 1)
        .find((item) => progressFor(item) !== "skipped");
    if (activeQuestion !== id) {
      activeQuestion = id;
      visits.set(id, 0);
      resume(id);
      if (value.loaded) queueMicrotask(() => saveView(id));
    }
    if (q.retired)
      return `<section class="lesson-source-card"><h2>原综合练习已拆成独立题目</h2><p>${esc(q.retirementReason || "旧记录已保留，请打开具体题目继续。")}</p><div class="lesson-chapter-drawer">${(q.replacementIds || []).map((next, i) => `<button class="primary block" data-go="arena/question/${next}">打开第 ${i + 1} 道独立练习</button>`).join("")}</div><details><summary>查看原来的作答与想法</summary><p class="chat-rich">${rich(value.answer || "此前尚未作答")}</p></details><button class="text-action" data-lesson-image="${q.imageUrl}">查看旧的完整题图</button></section>`;
    const result = value.check?.result,
      applicable = result && value.check.answer === value.answer,
      conflict = value.conflict;
    if (
      applicable &&
      result.verdict !== "correct" &&
      result.hints?.length &&
      !hinted.has(value.check.job_id || value.check.created + id)
    ) {
      hinted.add(value.check.job_id || value.check.created + id);
      queueMicrotask(() =>
        window.BX_HINTS?.show(
          document.querySelector("[data-lesson-question]"),
          result.hints,
        ),
      );
    }
    const total = part?.questions.length || 0,
      number = index >= 0 ? index + 1 : 0,
      feedback = checking.has(id)
        ? '<span class="working-dots"><i></i><i></i><i></i></span>爪爪正在核对原题和这一步…'
        : applicable
          ? `<strong class="${result.verdict === "correct" ? "good" : "check"}">${result.verdict === "correct" ? "这一步有依据" : result.verdict === "check" ? "我们检查这一处" : result.verdict === "unclear" ? "需要看清条件" : "先核对题目"}</strong><div class="chat-rich">${rich(result.feedback)}</div><small>${esc(result.note || "")}</small>`
          : result
            ? "<p>作答已修改，可以重新核对。</p>"
            : value.check?.status === "error"
              ? "<p>上次核对没有完成，作答已保存，可重新检查。</p>"
              : "<p>不会也没关系，先找一个已知条件。</p>";
    return `<section class="lesson-question" data-lesson-question="${id}"><div class="lesson-source-card"><div class="lesson-question-summary"><span>${esc(kind(q))}${level(q) ? " · " + esc(level(q)) : ""}${point(q) ? " · " + esc(point(q)) : ""}</span>${q.generated ? "" : `<button class="text-action" data-lesson-image="${q.imageUrl}" aria-label="放大原题">${fi("zoom")}</button>`}</div>${q.supportUrl ? `<details class="lesson-reading" open><summary>先读材料</summary>${image(q, q.supportUrl, true)}</details>` : ""}${q.generated ? `<div class="lesson-generated-stem chat-rich" data-hint-stem>${rich(q.stem)}</div>${q.diagramUrl || q.imageUrl ? `<div class="lesson-source-figure lesson-generated-figure">${image(q)}</div>${q.diagramAlt ? `<p class="lesson-diagram-caption">${esc(q.diagramAlt)}</p>` : ""}` : ""}` : `<div class="lesson-source-figure ${q.imageSize?.[1] > 2.3 * q.imageSize?.[0] ? "is-tall" : ""}">${image(q)}</div>`}${q.continuationUrl ? `<div class="lesson-continuation"><small>接着看完整条件</small>${image(q, q.continuationUrl)}</div>` : ""}${q.generated ? "" : `<details class="lesson-transcription"><summary>文字辅助阅读</summary><div class="chat-rich" data-hint-stem>${rich(q.stem)}</div><small>数字、算式及排版以原题图为准，发现不清楚可请爪爪一起核对。</small></details>`}</div>${applicable && result.hints?.length ? window.BX_HINTS?.panel(result.hints, id + ":" + (value.check.job_id || value.check.created || "")) || "" : ""}<div class="lesson-answer-heading"><strong>${q.options.length ? "选一选" : q.type === "fill" ? "填写答案" : "写下答案或你的想法"}</strong><small data-lesson-save-status="${id}">${esc(value.status)}</small>${parent() ? `<button class="text-action" data-lesson-reference="${id}">配套答案</button>` : ""}<button class="text-action" data-lesson-sync="${id}" ${!value.dirty || value.conflict ? "hidden" : ""}>重新同步</button></div>${failures.has("work:" + id) ? `<div class="lesson-conflict">暂未连上保存记录，本机草稿已保留。<button class="secondary" data-lesson-retry="work:${id}">恢复同步</button></div>` : ""}${q.options.length ? `<div class="lesson-options">${q.options.map((option) => `<button class="${selected(value.answer) === option.id ? "selected" : ""}" aria-pressed="${selected(value.answer) === option.id}" data-lesson-option="${option.id}" data-question="${id}" data-hint-option="${option.id}"><b>${option.id}</b><span>${esc(option.text)}</span><i>${selected(value.answer) === option.id ? fi("check") : ""}</i></button>`).join("")}</div><label class="lesson-answer-label" for="lesson-answer">也可以写下选择的理由</label>` : `<label class="sr-only" for="lesson-answer">答案或想法</label>`}<textarea id="lesson-answer" data-question="${id}" maxlength="5000" rows="3" placeholder="输入答案或想法">${esc(q.options.length ? reasoning(value.answer) : value.answer)}</textarea>${conflict ? `<div class="lesson-conflict"><p>另一处的作答：${esc(conflict.answer || "空白")}。本机输入已保留。</p><button class="secondary" data-lesson-keep="${id}">继续使用本机作答</button><button class="text-action" data-lesson-remote="${id}">载入已同步版本</button></div>` : ""}<div class="lesson-feedback" aria-live="polite">${feedback}${!checking.has(id) && value.check?.status === "running" ? `<button class="secondary" data-lesson-resume-check="${id}">继续查看核对结果</button>` : ""}</div><div class="lesson-step-nav">${previous ? `<button class="text-action" data-go="arena/question/${previous.id}">${fi("back")}上一题</button>` : "<span></span>"}<span></span>${next ? `<button class="text-action" data-go="arena/question/${next.id}">下一题${fi("right")}</button>` : "<span></span>"}</div><div class="lesson-fixed-actions"><div class="lesson-primary-actions"><button class="secondary" data-lesson-hint="${id}" ${checking.has(id) ? "disabled" : ""}>${fi("bulb")}给我提示</button><button class="primary" data-lesson-check="${id}" ${checking.has(id) ? "disabled" : ""}>检查这一步</button></div></div></section>`;
  }
  async function poll(q, job) {
    if (checking.has(q)) return;
    checking.add(q);
    const owner = actor;
    let attempts = 0;
    try {
      while (owner === actorKey() && attempts++ < 360) {
        const current = await app.api("/api/study/jobs/" + job);
        if (owner !== actorKey()) return;
        if (["done", "error"].includes(current.status)) {
          const remote = await app.api(
            "/api/arena/questions/" +
              q +
              "/work" +
              (app.childId() ? "?childId=" + app.childId() : ""),
          );
          if (owner !== actorKey()) return;
          drafts.get(q).check = remote.check;
          persist(q);
          recordProgress(q, drafts.get(q));
          if (current.status === "done" && remote.check?.result?.intent !== "hint") {
            document.dispatchEvent(new Event("paw:answer-checked"));
          }
          if (current.status === "error") app.toast(current.error);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      if (owner === actorKey())
        app.toast("答题记录已保留，恢复连接后可继续核对。");
    } finally {
      checking.delete(q);
      if (owner === actorKey()) refresh();
    }
  }
  async function check(q, onlyHint = false) {
    const owner = actor;
    const value = work(q),
      question = questions.get(q);
    if (checking.has(q)) return;
    if (!onlyHint && question?.options?.length && !selected(value.answer)) {
      window.BX_HINTS?.close?.();
      app.toast(
        "先选一个选项，再检查这一步。你的想法已经保留，也可以点“给我提示”。",
      );
      document
        .querySelector("[data-lesson-option]")
        ?.focus?.({ preventScroll: true });
      return;
    }
    if (!onlyHint && !value.answer.trim()) {
      app.toast("先写下答案，或点“给我提示”开始。");
      return;
    }
    if (
      onlyHint &&
      value.check?.result?.hints?.length &&
      value.check.answer === value.answer
    ) {
      window.BX_HINTS?.show(
        document.querySelector("[data-lesson-question]"),
        value.check.result.hints,
      );
      return;
    }
    persist(q);
    save(q);
    checking.add(q);
    refresh();
    try {
      const answer = value.answer,
        result = await app.api("/api/arena/questions/" + q + "/check", {
          answer,
          intent: onlyHint ? "hint" : "check",
          requestId: uuid(),
          childId: app.childId(),
        });
      if (owner !== actorKey()) return;
      value.check = { answer, job_id: result.job.id, status: "running" };
      persist(q);
      checking.delete(q);
      poll(q, result.job.id);
    } catch (error) {
      if (owner !== actorKey()) return;
      checking.delete(q);
      app.toast(error.message);
      refresh();
    }
  }
  function chapterPage(id, ch) {
    const data = chapter(id, ch);
    if (!data) return loading("chapter:" + id + ":" + ch);
    ensureProgress();
    const rows = data.questions,
      remembered = last(),
      done = rows.filter((q) => progressFor(q) === "correct").length,
      skipped = rows.filter((q) => progressFor(q) === "skipped"),
      batches = [
        ...new Map(
          skipped.map((q) => [progress?.[q.id]?.batchId, progress?.[q.id]]),
        ).values(),
      ].filter(Boolean),
      advance = batches.some((b) => b.sourceId === remembered),
      at = rows.findIndex((q) => q.id === remembered),
      ordered = advance
        ? [...rows.slice(at + 1), ...rows.slice(0, at + 1)]
        : rows,
      target =
        (!advance && rows.find((q) => q.id === remembered)) ||
        ordered.find((q) => !["correct", "skipped"].includes(progressFor(q))) ||
        rows[0];
    const filter = filterFor(id, ch),
      hasLayers = rows.some((q) => q.generated),
      filtered = rows.filter(
        (q) =>
          (filter.level === "all" || q.difficulty === filter.level) &&
          (!filter.point || point(q) === filter.point),
      ),
      points = [...new Set(rows.map(point).filter(Boolean))];
    const filters = hasLayers
      ? `<div class="lesson-layer-filters" aria-label="按层次与知识点筛选"><div class="study-history-tabs">${[
          ["all", "全部题目"],
          ["basic", "基础"],
          ["medium", "中等"],
          ["advanced", "进阶"],
        ]
          .map(
            ([value, label]) =>
              `<button class="${filter.level === value ? "active" : ""}" data-lesson-level="${value}" data-course="${id}" data-chapter="${ch}">${label}</button>`,
          )
          .join(
            "",
          )}</div>${points.length ? `<label>知识点<select data-lesson-point data-course="${id}" data-chapter="${ch}"><option value="">全部知识点</option>${points.map((name) => `<option value="${esc(name)}" ${filter.point === name ? "selected" : ""}>${esc(name)}</option>`).join("")}</select></label>` : ""}<small>显示 ${filtered.length} / ${rows.length} 道 / 项练习</small></div>`
      : "";
    const sources = legacySources(data.chapter),
      originalPractice =
        data.book.curriculumCourse && sources.length
          ? `<section class="lesson-legacy-practice"><h2>原配套练习</h2><p>保留原有作答与记录，和预置练习分别计数。</p><div class="lesson-chapter-list">${sources.map((source) => `<button data-go="arena/chapter/${source.courseId}/${source.chapterId}"><span><strong>${esc(source.title || "本章原配套练习")}</strong><small>${Number(source.questionCount)} 道原配套练习</small></span>${fi("right")}</button>`).join("")}</div></section>`
          : "";
    const related = data.related?.length
      ? `<section class="lesson-source-card"><h2>本章其他配套练习</h2><p>同一本教材、同一章节的其他练习册，分别保留作答进度。</p><div class="lesson-chapter-list">${data.related.map((other) => `<button data-go="arena/chapter/${other.bookId}/${other.chapterId}"><span><strong>${esc(other.title)}</strong><small>${other.questionCount} 道 / 项练习</small></span>${fi("right")}</button>`).join("")}</div></section>`
      : "";
    return `<div class="lesson-chapter-overview"><h1>章节练习</h1><p>${esc(data.book.title)} · ${esc(data.book.curriculumCourse ? chapterAvailability(data.book, { ...data.chapter, questionCount: rows.length }) : "本章 " + rows.length + " 道 / 项练习")}</p><div class="lesson-chapter-meter"><div><i style="width:${rows.length ? (done / rows.length) * 100 : 0}%"></i></div><span>${done} / ${rows.length} 题已核对${skipped.length ? ` · ${skipped.length} 题已跳过` : ""}</span></div></div>${batches.map((batch) => `<div class="lesson-skip-notice"><span>${esc(batch.label)} · 已跳过，随时可以补练</span><button class="text-action" data-lesson-undo-skip="${batch.batchId}">撤销跳过</button></div>`).join("")}<div class="lesson-list-heading"><span>${data.chapter.match?.status === "verified" ? "已核对教材章节" : "独立拓展 / 专题资料"}</span><small>${data.book.curriculumCourse ? "预置 " : ""}${rows.length} 道 / 项练习</small></div>${filters}<div class="lesson-question-list">${
      filtered
        .map((q) => {
          const i = rows.indexOf(q),
            state = progressFor(q);
          return `<button class="${q.id === remembered ? "current" : ""}" data-go="arena/question/${q.id}"><b class="${state === "correct" ? "done" : ""}">${state === "correct" ? "✓" : String(i + 1).padStart(2, "0")}</b><span><strong>${esc(q.preview || q.title)}</strong><small>${esc(kind(q))}${level(q) ? " · " + esc(level(q)) : ""}${point(q) ? " · " + esc(point(q)) : ""} · ${esc(q.title)}</small></span><em class="${state}">${stateLabel(state)}</em>${fi("chevron")}</button>`;
        })
        .join("") ||
      (rows.length
        ? '<p class="empty-state">当前筛选没有题目，切换层次或知识点查看。</p>'
        : data.chapter.match?.status === "verified" && data.book.mode === "sync"
          ? '<p class="empty-state">本章内容正在整理，完成后会在这里展示。可先学习其他章节。</p>'
          : '<p class="empty-state">本章暂无已核对练习；请选择其他章节。</p>')
    }</div>${originalPractice}${related}${target ? `<div class="lesson-chapter-continue"><p>${cat()}一步一步来，先尝试一个小问题。</p><button class="primary block" data-go="arena/question/${target.id}">继续练习 · 第 ${rows.indexOf(target) + 1} 题</button></div>` : ""}`;
  }
  const chapterFilters = new Map();
  function coursePage(id) {
    const book = course(id);
    if (!book) return loading("course:" + id);
    return `<div class="lesson-book-heading"><h2>${esc(book.title)}</h2><p>${esc(book.gradeLabel)} · ${esc(book.version)} · ${book.mode === "bridge" ? "暑假衔接" : book.term === 2 ? "下册" : book.term === 1 ? "上册" : "册次待核对"} · ${esc(book.subjectLabel)}</p>${revisionHint(book)}${book.canonicalCourseId ? `<button class="text-action" data-go="arena/course/${esc(book.canonicalCourseId)}">返回教材章节目录</button>` : ""}${isAdmin() && !book.generatedCourse && !book.curriculumCourse ? `<button class="secondary" data-lesson-classify="${id}">整理教材挂接</button>` : ""}</div><div class="lesson-chapter-list">${book.chapters
      .filter(
        (ch) =>
          book.generatedCourse ||
          book.curriculumCourse ||
          (ch.questionCount ?? ch.unitCount) > 0,
      )
      .map(
        (ch) =>
          `<button data-go="arena/chapter/${chapterDestination(book, ch).courseId}/${chapterDestination(book, ch).chapterId}"><span><strong>${esc(ch.title)}</strong><small>${esc(chapterAvailability(book, ch))} · ${ch.match?.status === "verified" ? "已核对教材章节" : "拓展或待核对"}</small></span>${app.ico("chevron-right", "small")}</button>`,
      )
      .join("")}</div>`;
  }
  function refreshGeneration(book, chapter) {
    const route = app.route();
    if (
      route[0] === "arena" &&
      ((route[1] === "chapter" && route[2] === book && route[3] === chapter) ||
        (route[1] === "course" && route[2] === book) ||
        !route[1] ||
        route[1] === "book")
    )
      app.render();
  }
  function mainPage(route) {
    ensureProgress();
    if (!catalog) {
      queueMicrotask(() =>
        fetchOnce("catalog", "/api/arena", (v) => (catalog = v)),
      );
      return loading("catalog");
    }
    if (!textbooks) {
      queueMicrotask(() =>
        fetchOnce(
          "textbooks",
          "/api/arena/textbooks",
          (v) => (textbooks = v.textbooks),
        ),
      );
      return loading("textbooks");
    }
    const savedSelection = app.selection(),
      allBooks = app.books?.() || textbooks.map((t) => t.book),
      explicit = route[1] === "book" ? route[2] : null,
      requested = explicit
        ? allBooks.find(
            (b) =>
              b.id === explicit && b.enabled !== false && b.kind !== "answers",
          )
        : null;
    if (explicit && !requested)
      return '<div class="empty-state"><h2>这本教材暂不可用于章节练习</h2><p>请返回教材列表，选择已上架并核对身份的课本。</p><button class="secondary" data-go="arena">返回我的教材</button></div>';
    if (
      requested &&
      (![1, 2, 3, 4, 5, 6].includes(Number(requested.grade)) ||
        ![1, 2].includes(Number(requested.term)))
    )
      return '<div class="empty-state"><h2>这本教材的年级或册次还需核对</h2><p>核对完成后才能准确匹配本章练习。</p><button class="secondary" data-go="arena">返回我的教材</button></div>';
    if (requested) subject = requested.subject;
    const selection = requested
        ? {
            ...savedSelection,
            grade: Number(requested.grade),
            term: Number(requested.term),
            pins: { ...savedSelection.pins, [subject]: requested.id },
          }
        : savedSelection,
      library = allBooks.filter(
        (b) =>
          b.enabled !== false &&
          b.kind !== "answers" &&
          b.subject === subject &&
          b.grade === selection.grade &&
          b.term === selection.term,
      ),
      pinned = library.find((b) => b.id === selection.pins?.[subject]),
      book =
        requested ||
        pinned ||
        library.find((b) => !/五四|54制|待核对/.test(b.version)) ||
        library[0],
      identity = book?.id;
    const rows = catalog.books.filter(
      (c) =>
        c.grades.includes(Number(selection.grade)) && c.subject === subject,
    );
    const matching = rows.filter(
        (c) => c.mode === "sync" && c.textbookIds.includes(identity),
      ),
      canonicalMeta = matching.find((c) => c.curriculumCourse);
    if (channel === "sync") for (const meta of matching) course(meta.id);
    const chaptersForBook = new Map();
    for (const meta of matching) {
      const data = courses.get(meta.id);
      if (!data) continue;
      for (const ch of data.chapters) {
        const match = ch.match;
        if (
          match?.status !== "verified" ||
          !(match.bookIds || [match.bookId]).includes(identity)
        )
          continue;
        const name = match.title || ch.title;
        if (!chaptersForBook.has(name)) chaptersForBook.set(name, []);
        chaptersForBook.get(name).push({ book: data, chapter: ch });
      }
    }
    const source = textbooks.find((t) => t.book.id === identity),
      toc = source?.titles || [];
    const entries = [...chaptersForBook].sort((a, b) => {
      const ai = toc.findIndex((t) => t.title === a[0]),
        bi = toc.findIndex((t) => t.title === b[0]);
      return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
    });
    return `<div class="study-title"><h1>爪爪竞技场</h1><button class="text-action" data-lesson-settings>教材设置</button></div><div class="lesson-welcome">${cat()}今天，也来挑战一小步！</div><div class="lesson-subject-tabs">${[
      ["math", "数学"],
      ["chinese", "语文"],
      ["english", "英语"],
    ]
      .map(
        ([id, name]) =>
          `<button class="${subject === id ? "active" : ""}" data-lesson-subject="${id}">${name}</button>`,
      )
      .join(
        "",
      )}</div><div class="lesson-book-heading"><small>正在学习</small><h2>${esc(identity ? `${selection.grade}年级 · ${book?.subjectLabel || { math: "数学", chinese: "语文", english: "英语" }[subject] || "其他学科"} · ${book?.version || "已选版本"} · ${selection.term === 2 ? "下册" : "上册"}` : "请在教材设置中选择本册课本")}</h2><p>${selection.grade}年级 · ${selection.term === 2 ? "下册" : "上册"} · ${esc(book?.version || "版本待选择")}</p>${revisionHint(canonicalMeta)}</div><div class="study-history-tabs"><button class="${channel === "sync" ? "active" : ""}" data-lesson-channel="sync">教材同步</button><button class="${channel === "extension" ? "active" : ""}" data-lesson-channel="extension">拓展与衔接</button><button class="${channel === "workbooks" ? "active" : ""}" data-lesson-channel="workbooks">练习册目录</button></div>${last() ? `<button class="lesson-resume-card" data-go="arena/question/${last()}"><span>${fi("paw")}继续上次</span><strong>${esc(questions.get(last())?.chapterTitle || "回到刚刚的练习")}</strong><b>继续练习 →</b></button>` : ""}${
      channel === "sync"
        ? entries.length
          ? `<div class="lesson-chapter-list">${entries.map(([name, refs]) => `<button data-lesson-chapter-choice="${esc(name)}" data-textbook="${esc(identity)}"><span><strong>${esc(name)}</strong><small>${refs.some((r) => r.book.curriculumCourse) ? esc(chapterAvailability(refs.find((r) => r.book.curriculumCourse).book, refs.find((r) => r.book.curriculumCourse).chapter)) : refs.reduce((sum, r) => sum + (r.chapter.questionCount ?? r.chapter.unitCount ?? 0), 0) > 0 ? refs.reduce((sum, r) => sum + (r.chapter.questionCount ?? r.chapter.unitCount ?? 0), 0) + " 道 / 项练习" : "内容整理中"} · ${refs.some((r) => !r.book.generatedCourse) ? refs.filter((r) => !r.book.generatedCourse).length + " 本配套资料" : "教材真实章节"}</small></span>${app.ico("chevron-right", "small")}</button>`).join("")}</div>`
          : matching.some((m) => pending.has("course:" + m.id))
            ? loading("chapters")
            : '<div class="empty-state"><h2>本册暂无已核对的同步练习</h2><p>可以切换正确的教材册次，或选择独立拓展资料；其他版本不会自动混为本册练习。</p><button class="secondary" data-lesson-channel="extension">查看拓展与衔接</button></div>'
        : `<div class="lesson-workbook-list">${
            rows
              .filter(
                (c) =>
                  channel === "workbooks" ||
                  c.mode !== "sync" ||
                  !c.textbookIds.includes(identity),
              )
              .map(
                (c) =>
                  `<button data-go="arena/course/${c.id}"><strong>${esc(c.title)}</strong><small>${esc(c.version)} · ${esc(c.modeLabel)} · ${c.chapterCount} 个章节 / 专题</small></button>`,
              )
              .join("") || "<p>当前年级与学科没有已导入的拓展资料。</p>"
          }</div>`
    }<p class="study-retention">每题保留来源；参考答案由家长查看。未核对的章节不会冒充同步内容。</p>`;
  }
  let directoryTurn = 0;
  async function directory(id, ch, origin = "") {
    const owner = actor,
      route = app.route().join("/"),
      turn = ++directoryTurn;
    let awaitingSheet = false;
    const stillOwnsSheet = () =>
      !awaitingSheet ||
      !!document.querySelector(
        '[data-lesson-directory-loading="' + turn + '"]',
      );
    capture();
    window.BX_HINTS?.close?.();
    try {
      let book = courses.get(id);
      if (!book) {
        app.modal(
          "本册目录",
          `<div class="lesson-directory-sheet" data-lesson-directory-loading="${turn}"><p role="status">正在读取本册章节…</p></div>`,
        );
        awaitingSheet = true;
        book = await app.api("/api/arena/books/" + id);
        if (owner !== actorKey()) return;
        courses.set(id, book);
      }
      if (
        owner !== actorKey() ||
        turn !== directoryTurn ||
        route !== app.route().join("/") ||
        !stillOwnsSheet()
      )
        return;
      if (book.canonicalCourseId) {
        const oldId = id,
          oldChapter = ch,
          canonicalId = book.canonicalCourseId;
        let canonical = courses.get(canonicalId);
        if (!canonical) {
          if (!awaitingSheet) {
            app.modal(
              "本册目录",
              `<div class="lesson-directory-sheet" data-lesson-directory-loading="${turn}"><p role="status">正在读取教材章节…</p></div>`,
            );
            awaitingSheet = true;
          }
          canonical = await app.api("/api/arena/books/" + canonicalId);
          if (owner !== actorKey()) return;
          courses.set(canonicalId, canonical);
        }
        if (
          owner !== actorKey() ||
          turn !== directoryTurn ||
          route !== app.route().join("/") ||
          !stillOwnsSheet()
        )
          return;
        const exact = canonical.chapters.find((item) =>
          (item.legacySources || []).some(
            (source) =>
              source.courseId === oldId && source.chapterId === oldChapter,
          ),
        );
        if (exact) {
          book = canonical;
          id = canonicalId;
          ch = exact.id;
        }
      }
      const lastId = last(),
        entries = book.chapters.filter(
          (v) =>
            book.generatedCourse ||
            book.curriculumCourse ||
            v.match?.status === "verified" ||
            (v.questionCount ?? v.unitCount) > 0,
        );
      app.modal(
        "本册目录",
        `<div class="lesson-directory-sheet"><header><small>${esc(identityLabel(book))}</small><h3>${esc(book.title || "本册练习")}</h3><p>${esc(ch ? entries.find((v) => v.id === ch)?.title || "当前章节" : "选择一个章节，直接开始练习")}</p></header><div class="lesson-directory-shortcuts">${origin ? `<button class="text-action" data-go="${esc(origin)}">${origin.startsWith("arena/question/") ? "回到当前题" : origin.startsWith("arena/unit/") ? "回到原段落" : "回到当前章"}</button>` : ""}${lastId ? `<button class="text-action" data-go="arena/question/${lastId}">继续上次</button>` : ""}<button class="text-action" data-go="arena/course/${esc(id)}">本册目录页</button></div><div class="lesson-chapter-drawer" role="list" aria-label="本册章节">${entries
          .map((item, index) => {
            const cached = chapters.get(id + ":" + item.id),
              done =
                cached?.questions.filter((q) => progressFor(q) === "correct")
                  .length || 0,
              count = item.questionCount ?? item.unitCount ?? 0;
            return `<button class="${ch === item.id ? "active" : ""}" data-lesson-open-chapter="${esc(chapterDestination(book, item).chapterId)}" data-course="${esc(chapterDestination(book, item).courseId)}" ${ch === item.id ? 'aria-current="page"' : ""}><b>${String(index + 1).padStart(2, "0")}</b><span><strong>${esc(item.match?.title || item.title)}</strong><small>${esc(chapterAvailability(book, item))}${done ? " · " + done + "题已核对" : ""}</small></span>${app.ico("chevron-right", "small")}</button>`;
          })
          .join(
            "",
          )}</div><footer><button class="text-action" data-go="arena">我的教材与练习册</button><small>切换章节会保留当前草稿和学习位置。</small></footer></div>`,
      );
    } catch (error) {
      if (
        owner === actorKey() &&
        turn === directoryTurn &&
        route === app.route().join("/") &&
        stillOwnsSheet()
      )
        app.modal(
          "本册目录",
          `<div class="lesson-directory-sheet"><p>${esc(error.message || "目录暂时未打开")}</p><button class="secondary" data-lesson-directory="${esc(id)}" data-chapter="${esc(ch || "")}">重新读取目录</button><button class="text-action" data-go="arena/course/${esc(id)}">前往本册目录页</button></div>`,
        );
    }
  }
  const skipPlans = new Map();
  async function previewSkip(qid) {
    const owner = actor;
    try {
      const value = work(qid);
      persist(qid);
      await save(qid);
      if (owner !== actorKey()) return;
      const plan = await app.api(
        "/api/arena/questions/" +
          qid +
          "/skip" +
          (app.childId() ? "?childId=" + app.childId() : ""),
      );
      if (owner !== actorKey()) return;
      const excluded = plan.questionIds.filter((id) => {
        const local = drafts.get(id) || stored(id);
        return !!local?.answer?.trim() || local?.dirty;
      });
      plan.questionIds = plan.questionIds.filter(
        (id) => !excluded.includes(id),
      );
      if (!plan.group || !plan.questionIds.length) {
        app.toast("本章没有可批量跳过的同类未答题；可以单独进入下一题。");
        return;
      }
      skipPlans.set(qid, { ...plan, excluded, requestId: uuid() });
      app.modal(
        "跳过同类题？",
        `<div class="lesson-skip-confirm"><h3>${esc(plan.group.label)}</h3><p>跳过本章同知识点、同题型的 ${plan.questionIds.length} 道未答题，继续下一部分。</p><p class="muted">${esc(plan.group.basis)}。已做题目和草稿保留；跳过不计分，也不会标记为已掌握。之后可以撤销或补练。</p><button class="primary block" data-lesson-skip-confirm="${qid}">跳过这 ${plan.questionIds.length} 道题</button><button class="secondary block" data-action="close-modal">继续做当前题</button></div>`,
      );
    } catch (error) {
      app.toast(error.message);
    }
  }
  async function applySkip(qid, button) {
    const plan = skipPlans.get(qid);
    if (!plan) return;
    button.disabled = true;
    const owner = actor;
    try {
      const result = await app.api("/api/arena/skip", {
        questionId: qid,
        requestId: plan.requestId,
        excluded: plan.excluded,
        childId: app.childId(),
      });
      if (owner !== actorKey()) return;
      for (const id of result.questionIds)
        if (progress)
          progress[id] = {
            state: "skipped",
            batchId: result.batchId,
            sourceId: result.sourceId,
            label: result.label,
          };
      try {
        localStorage.setItem(
          "bx-arena-last-skip:" + actor,
          JSON.stringify(result),
        );
      } catch (_) {}
      app.toast(result.count + " 道同类题已跳过，原记录已保留");
      app.go(
        "arena/chapter/" +
          qid.split(":")[0] +
          "/" +
          questions.get(qid).chapterId,
      );
    } catch (error) {
      app.toast(error.message);
    } finally {
      button.disabled = false;
    }
  }
  function settings() {
    const selection = app.selection(),
      books = (app.books?.() || textbooks.map((t) => t.book)).filter(
        (b) => b.kind === "textbook" || b.kind === undefined,
      );
    app.modal(
      "选择孩子正在学的教材",
      `<form id="lesson-settings-form"><label>年级<select name="grade">${[1, 2, 3, 4, 5, 6].map((g) => `<option value="${g}" ${selection.grade === g ? "selected" : ""}>${g}年级</option>`).join("")}</select></label><label>册次<select name="term"><option value="1" ${selection.term === 1 ? "selected" : ""}>上册</option><option value="2" ${selection.term === 2 ? "selected" : ""}>下册</option></select></label><label>本学科教材<select name="book">${books
        .filter(
          (b) =>
            b.subject === subject &&
            b.grade === selection.grade &&
            b.term === selection.term,
        )
        .map(
          (b) =>
            `<option value="${b.id}" ${selection.pins?.[subject] === b.id ? "selected" : ""}>${b.grade}年级${b.term === 2 ? "下册" : "上册"} · ${esc(b.version)} · ${esc(b.title)}</option>`,
        )
        .join(
          "",
        )}</select></label><p>确认教材的年级、册次、版本与学制一致后保存。</p><button class="primary block" type="submit">保存教材设置</button></form>`,
    );
  }
  document.addEventListener("input", (event) => {
    if (!app || event.target.id !== "lesson-answer") return;
    const q = event.target.dataset.question,
      value = work(q);
    const item = questions.get(q);
    value.answer = item?.options.length
      ? combine(selected(value.answer), event.target.value)
      : event.target.value;
    value.dirty = true;
    value.status = "已保存在本机";
    persist(q);
    status(q);
    clearTimeout(timers.get(q));
    timers.set(
      q,
      setTimeout(() => save(q), 600),
    );
  });
  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || !app || button.disabled) return;
    const d = button.dataset;
    if (d.lessonRetry) {
      failures.delete(d.lessonRetry);
      if (d.lessonRetry.startsWith("work:"))
        recoverWork(d.lessonRetry.slice(5));
      refresh();
      return;
    }
    if (d.lessonSync) {
      const value = work(d.lessonSync);
      value.retries = 0;
      save(d.lessonSync);
      return;
    }
    if (d.go) {
      capture();
      window.BX_HINTS?.close?.();
      if (activeQuestion) {
        persist(activeQuestion);
        save(activeQuestion, true);
        saveView(activeQuestion, true);
      }
      if (d.go === app.route().join("/")) app.modalClose?.();
    }
    if (d.action === "close-modal") {
      directoryTurn++;
      return;
    }
    if (d.lessonMore) {
      more(
        locationFor({
          courseId: d.lessonMore,
          chapterId: d.chapter,
          questionId: d.question,
          arenaUnitId: d.unit,
        }),
        d.mode,
      );
      return;
    }
    if (d.lessonOpenChapter) {
      capture();
      if (activeQuestion) {
        persist(activeQuestion);
        save(activeQuestion, true);
        saveView(activeQuestion, true);
      }
      app.modalClose?.();
      directoryTurn++;
      app.go("arena/chapter/" + d.course + "/" + d.lessonOpenChapter);
      return;
    }
    if (d.lessonLevel) {
      setFilter(d.course, d.chapter, { level: d.lessonLevel });
      refresh();
      return;
    }
    if (d.lessonSubject) {
      subject = d.lessonSubject;
      writeNavigation("preferences", { subject, channel });
      if (app.route()[1] === "book") {
        app.go("arena");
        return;
      }
      refresh();
      return;
    }
    if (d.lessonChannel) {
      channel = d.lessonChannel;
      writeNavigation("preferences", { subject, channel });
      refresh();
      return;
    }
    if ("lessonSettings" in d) {
      settings();
      return;
    }
    if (d.lessonDirectory) {
      directory(d.lessonDirectory, d.chapter, d.origin);
      return;
    }
    if (d.lessonOption) {
      const q = d.question,
        value = work(q);
      value.answer = combine(d.lessonOption, reasoning(value.answer));
      value.dirty = true;
      value.status = "已保存在本机";
      persist(q);
      save(q);
      refresh();
      return;
    }
    if (d.lessonCheck) {
      check(d.lessonCheck);
      return;
    }
    if (d.lessonResumeCheck) {
      const value = work(d.lessonResumeCheck);
      if (value.check?.job_id) poll(d.lessonResumeCheck, value.check.job_id);
      return;
    }
    if (d.lessonHint) {
      check(d.lessonHint, true);
      return;
    }
    if (d.lessonSkip) {
      previewSkip(d.lessonSkip);
      return;
    }
    if (d.lessonSkipConfirm) {
      applySkip(d.lessonSkipConfirm, button);
      return;
    }
    if (d.lessonUndoSkip) {
      button.disabled = true;
      const owner = actor;
      app
        .api("/api/arena/skip", {
          action: "undo",
          batchId: d.lessonUndoSkip,
          childId: app.childId(),
        })
        .then((value) => {
          if (owner !== actorKey()) return;
          progress = null;
          app.toast("已撤销跳过，原来的作答和提示还在");
          app.go("arena/question/" + value.questionId);
        })
        .catch((error) => app.toast(error.message))
        .finally(() => (button.disabled = false));
      return;
    }
    if (d.lessonKeep || d.lessonRemote) {
      const q = d.lessonKeep || d.lessonRemote,
        value = work(q);
      value.revision = value.conflict.revision;
      if (d.lessonRemote) {
        value.answer = value.conflict.answer;
        value.dirty = false;
      }
      value.conflict = null;
      persist(q);
      if (d.lessonKeep) save(q);
      refresh();
      return;
    }
    if (d.lessonImage) {
      window.BX_IMAGES.open(app, d.lessonImage, "原题图示");
      return;
    }
    if (d.lessonDiscuss) {
      const q = questions.get(d.lessonDiscuss);
      if (!q) return;
      const value = work(q.id);
      capture();
      persist(q.id);
      save(q.id);
      app.modalClose?.();
      window.BX_STUDY?.resumeContext?.(
        { questionId: q.id, arenaUnitId: q.unitId },
        "这道题是：" +
          q.stem +
          "。" +
          (value.answer ? "我的想法是：" + value.answer : "我还没有思路。") +
          "请先核对原题图片，给我能开始的一步。",
      );
      return;
    }
    if (d.lessonChapterChoice) {
      const selection = app.selection(),
        names = [];
      for (const book of courses.values())
        if (book.mode === "sync")
          for (const ch of book.chapters)
            if (
              ch.match?.status === "verified" &&
              (ch.match.bookIds || [ch.match.bookId]).includes(d.textbook) &&
              (ch.match.title || ch.title) === d.lessonChapterChoice
            )
              names.push({ book, ch });
      const canonical = names.find((v) => v.book.curriculumCourse);
      if (canonical) {
        app.go("arena/chapter/" + canonical.book.id + "/" + canonical.ch.id);
        return;
      }
      if (names.length === 1) {
        app.go("arena/chapter/" + names[0].book.id + "/" + names[0].ch.id);
        return;
      }
      app.modal(
        d.lessonChapterChoice,
        `<div class="lesson-chapter-drawer">${names.map(({ book, ch }) => `<button class="secondary block" data-go="arena/chapter/${book.id}/${ch.id}">${esc(book.title)}<small>${(ch.questionCount ?? ch.unitCount ?? 0) > 0 ? (ch.questionCount ?? ch.unitCount) + " 道 / 项练习" : book.generatedCourse ? "本章内容整理中" : "暂无练习"}</small></button>`).join("")}</div>`,
      );
      return;
    }
    if (d.lessonReference) {
      if (!parent()) {
        app.toast("参考答案由已绑定的家长查看");
        return;
      }
      const q = questions.get(d.lessonReference),
        owner = actorKey();
      if (!q) return;
      button.disabled = true;
      app
        .api("/api/arena/questions/" + q.id + "/reference")
        .then((data) => {
          if (owner !== actorKey() || !parent()) return;
          const reference = data.reference;
          if (!reference) {
            app.modal(
              "家长核对参考",
              `<p>本题尚无逐题人工核对的标准参考。可查看同章资料，务必核对题号、数值与条件。</p><button class="secondary block" data-go="arena/answers/${q.id.split(":")[0]}/${q.chapterId}">查看本章参考资料</button><button class="text-action" data-go="arena/answers/${q.id.split(":")[0]}">查看本册参考资料</button>`,
            );
            return;
          }
          const labels = {
              teacher: "模拟教师",
              student: "模拟学生",
              lead: "模拟学科负责人",
              subject_lead: "模拟学科负责人",
              expert: "模拟学科专家",
            },
            steps = Array.isArray(reference.solution) ? reference.solution : [],
            audits = Array.isArray(reference.qualityAudit)
              ? reference.qualityAudit
              : [];
          app.modal(
            "家长核对参考",
            `<div class="lesson-parent-reference"><h3>${data.generated ? "AI原创题参考（非教材原题）" : "已核对的本题参考"}</h3>${data.generated ? `<p>${esc(level(reference))}${point(reference) ? " · " + esc(point(reference)) : ""}</p>` : ""}<h4>参考答案</h4><div class="chat-rich">${rich(reference.answer)}</div>${steps.length ? `<h4>详细解答</h4><ol class="lesson-solution-steps">${steps.map((step) => `<li><div class="chat-rich">${rich(typeof step === "string" ? step : step.text || step.description || "")}</div></li>`).join("")}</ol>` : ""}${reference.note ? `<h4>核对依据</h4><div class="chat-rich">${rich(reference.note)}</div>` : ""}${audits.length ? `<details class="lesson-quality-records"><summary>模拟角色逐题复核记录（${audits.length} 项）</summary><p>以下为模型扮演的审核角色与实际调用记录。</p>${audits.map((a) => `<section><strong>${esc(a.label || labels[a.role] || a.role || "模拟审核角色")}</strong><small>${esc(a.model || "模型未记录")}${a.passed === true ? " · 本轮通过" : ""}</small><p>${esc(a.summary || "本轮核对已记录")}</p></section>`).join("")}</details>` : ""}</div>`,
          );
        })
        .catch((error) => {
          if (owner === actorKey()) app.toast(error.message);
        })
        .finally(() => (button.disabled = false));
      return;
    }
    if (d.lessonReview) {
      const q = d.lessonReview;
      app.modal(
        "核对本题参考",
        `<form id="lesson-review-form" data-question="${q}"><label>核对后的答案<input name="answer" maxlength="2000" required></label><label>核对依据<textarea name="note" maxlength="1000" required placeholder="请说明核对的原题、题号及参考来源"></textarea></label><button class="primary block" type="submit">保存核对记录</button></form>`,
      );
    }
    if (d.lessonClassify) {
      const book = courses.get(d.lessonClassify),
        library = (app.books?.() || textbooks.map((t) => t.book)).filter(
          (b) =>
            b.kind !== "answers" &&
            b.subject === book.subject &&
            b.grade === book.grade,
        );
      app.modal(
        "整理教材与章节挂接",
        `<form id="lesson-classify-form" data-course="${book.id}"><label>整理范围<select name="chapter"><option value="*">整册名称与资料分类</option>${book.chapters
          .filter((c) => c.questionCount > 0)
          .map((c) => `<option value="${c.id}">${esc(c.title)}</option>`)
          .join(
            "",
          )}</select></label><label>资料名称<input name="title" maxlength="150" value="${esc(book.title)}"></label><label>类型<select name="mode">${[
          ["sync", "同步 / 专题练习"],
          ["extension", "独立拓展"],
          ["bridge", "暑假衔接"],
          ["pending", "待核对"],
          ["duplicate", "重复资料归档"],
        ]
          .map(
            ([id, text]) =>
              `<option value="${id}" ${book.mode === id ? "selected" : ""}>${text}</option>`,
          )
          .join(
            "",
          )}</select></label><label>册次<select name="term"><option value="0" ${!book.term ? "selected" : ""}>待核对</option><option value="1" ${book.term === 1 ? "selected" : ""}>上册</option><option value="2" ${book.term === 2 ? "selected" : ""}>下册</option></select></label><label>章节对应教材<select name="textbook"><option value="">独立拓展，不挂接教材</option>${library.map((b) => `<option value="${b.id}">${b.term === 2 ? "下册" : "上册"} · ${esc(b.version)} · ${esc(b.title)}</option>`).join("")}</select></label><label>对应教材章节<input name="chapterTitle" maxlength="80" placeholder="逐字核对教材目录中的章节名称"></label><label>重复资料的主册<select name="duplicate"><option value="">非重复资料可留空</option>${catalog.books
          .filter(
            (b) =>
              b.id !== book.id &&
              b.grade === book.grade &&
              b.subject === book.subject,
          )
          .map((b) => `<option value="${b.id}">${esc(b.title)}</option>`)
          .join(
            "",
          )}</select></label><label>核对依据<textarea name="note" required maxlength="1000" placeholder="说明对应的教材版次、目录章节和原册依据；撤回挂接时也记录原因"></textarea></label><button class="primary block" type="submit">保存并保留核对记录</button><button class="text-action" type="button" data-lesson-audit>查看修改记录</button></form>`,
      );
      return;
    }
    if ("lessonAudit" in d) {
      app
        .api("/api/admin/arena/mappings")
        .then((value) =>
          app.modal(
            "教材挂接修改记录",
            `<div class="lesson-chapter-drawer">${
              value.changes
                .slice(0, 80)
                .map(
                  (row) =>
                    `<section><strong>${esc(catalog.books.find((b) => b.id === row.course_id)?.title || row.course_id)}</strong><p>${esc(row.value.modeLabel || "章节核对")} · ${new Date(row.created * 1000).toLocaleString("zh-CN")}</p><p>${esc(row.value.note || "")}</p></section>`,
                )
                .join("") || "<p>暂未修改过教材挂接。</p>"
            }</div>`,
          ),
        )
        .catch((error) => app.toast(error.message));
      return;
    }
  });
  document.addEventListener("submit", (event) => {
    if (!app) return;
    if (event.target.id === "lesson-settings-form") {
      event.preventDefault();
      const form = event.target,
        b = (app.books?.() || textbooks.map((t) => t.book)).find(
          (v) => v.id === form.elements.book.value,
        ),
        grade = Number(form.elements.grade.value),
        term = Number(form.elements.term.value);
      if (!b || b.grade !== grade || b.term !== term) {
        app.toast("所选教材与年级、册次不一致，请核对后保存");
        return;
      }
      app.updateSelection?.({ grade, term, subject, bookId: b.id });
      app.modalClose?.();
      refresh();
    }
    if (event.target.id === "lesson-review-form") {
      event.preventDefault();
      const form = event.target;
      app
        .api("/api/admin/arena/review", {
          questionId: form.dataset.question,
          answer: form.elements.answer.value,
          note: form.elements.note.value,
        })
        .then(() => {
          questions.delete(form.dataset.question);
          drafts.delete(form.dataset.question);
          progress = null;
          app.toast("本题参考和核对依据已保存");
          app.modalClose?.();
          refresh();
        })
        .catch((error) => app.toast(error.message));
    }
    if (event.target.id === "lesson-classify-form") {
      event.preventDefault();
      const form = event.target,
        fields = form.elements;
      app
        .api("/api/admin/arena/classify", {
          courseId: form.dataset.course,
          chapterId: fields.chapter.value,
          title: fields.title.value,
          mode: fields.mode.value,
          term: Number(fields.term.value),
          textbookId: fields.textbook.value,
          chapterTitle: fields.chapterTitle.value,
          duplicateOf: fields.duplicate.value,
          note: fields.note.value,
        })
        .then((result) => {
          courses.set(result.book.id, result.book);
          catalog = null;
          app.toast("资料归类和核对依据已保存");
          app.modalClose?.();
          refresh();
        })
        .catch((error) => app.toast(error.message));
    }
  });
  document.addEventListener("change", (event) => {
    const form = event.target.closest?.("#lesson-settings-form");
    if (!form || !app || !["grade", "term"].includes(event.target.name)) return;
    const grade = Number(form.elements.grade.value),
      term = Number(form.elements.term.value),
      choices = (app.books?.() || textbooks.map((t) => t.book)).filter(
        (b) =>
          b.kind !== "answers" &&
          b.subject === subject &&
          b.grade === grade &&
          b.term === term,
      );
    form.elements.book.innerHTML =
      choices
        .map(
          (b) =>
            `<option value="${b.id}">${esc(b.version)} · ${esc(b.title)}</option>`,
        )
        .join("") || '<option value="">该年级册次暂无教材</option>';
  });
  document.addEventListener("change", (event) => {
    const select = event.target;
    if (!app || !("lessonPoint" in (select.dataset || {}))) return;
    setFilter(select.dataset.course, select.dataset.chapter, {
      point: select.value,
    });
    refresh();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden")
      for (const q of drafts.keys()) save(q, true);
  });
  window.addEventListener("pagehide", () => {
    capture();
    for (const q of drafts.keys()) {
      persist(q);
      save(q, true);
      saveView(q, true);
    }
  });
  window.addEventListener(
    "scroll",
    () => {
      if (app && app.route()[0] === "arena") capture();
    },
    { passive: true },
  );
  window.addEventListener("hashchange", () => {
    if (app && !(app.route()[0] === "arena" && app.route()[1] === "question"))
      activeQuestion = "";
    queueMicrotask(() => restore(null));
  });
  window.addEventListener("online", () => {
    for (const [q, value] of drafts) {
      value.retries = 0;
      save(q);
      saveView(q);
    }
  });
  function page(route) {
    reset();
    ensureProgress();
    let html,
      context = null,
      mode = route[1];
    if (mode === "question") {
      html = questionPage(route[2]);
      context = { questionId: route[2] };
    } else if (mode === "chapter" || (mode === "course" && route[3])) {
      html = chapterPage(route[2], route[3]);
      context = { courseId: route[2], chapterId: route[3] };
      mode = "chapter";
    } else if (mode === "course") {
      html = coursePage(route[2]);
      context = { courseId: route[2] };
    } else html = mainPage(route);
    return screen(route, (context ? navigation(context, { mode }) : "") + html);
  }
  window.BX_ARENA_LEARNING = {
    connect(value) {
      app = value;
      window.BX_HINTS?.connect({
        owner: actorKey,
        onChange: (key, hint) => {
          const q = key.split(":").slice(0, 3).join(":");
          if (questions.has(q)) rememberView(q, { hint });
        },
      });
    },
    async finish() {
      capture();
      await Promise.all([...drafts.keys()].map((q) => save(q)));
      return [...drafts.values()].every(
        (v) => !v.dirty && !v.conflict && !v.saving,
      );
    },
    page,
    capture,
    restore,
    resumeCard,
    navigation,
    screen,
    registerUnit(unit) {
      reset();
      unitContexts.set(unit.id, unit);
    },
    invalidate(q) {
      questions.delete(q);
      drafts.delete(q);
      progress = null;
      chapters.clear();
    },
    resume() {
      if (!app) return "";
      reset();
      return last();
    },
  };
})();
