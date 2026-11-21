(function () {
  "use strict";
  const C = window.BX_CURRICULUM,
    $ = (s) => document.querySelector(s);
  const esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const ico = (name, size = "") =>
    `<svg class="icon ${size}" aria-hidden="true" viewBox="0 0 24 24">${window.BX_ICONS[name] || window.BX_ICONS["circle-help"]}</svg>`;
  const uiAsset = (url) => window.BX_MEDIA?.asset(url) || url;
  const img = (name, cls = "", alt = "") =>
    `<img class="${cls}" src="${esc(uiAsset(`assets/${name}.png`))}" alt="${alt}" loading="${name === "brand/paw-logo" ? "eager" : "lazy"}" decoding="async">`;
  const gradeName = (g) => (g ? C.GRADE_NAMES[g - 1] + "年级" : "年级待核对");
  const dateKey = (date = new Date()) =>
    new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(
      date,
    );
  const defaults = () => ({
    childName: "张三三",
    grade: 3,
    term: 1,
    points: 0,
    completed: [],
    mistakes: [],
    attempts: [],
    questionEvents: [],
    reading: {},
    notes: {},
    pins: {},
    conversations: {},
    daily: {},
    parentMessage: "",
    settings: {
      limit: 30,
      bedtime: "21:00",
      cleanReading: true,
      hints: true,
      reminders: true,
      sound: true,
    },
  });
  let user = null,
    family = { parents: [], children: [] },
    applicationLoadGeneration = 0;
  let state = defaults(),
    revision = 0,
    connected = false,
    dirty = false,
    syncing = false,
    conflict = false,
    syncTimer,
    toastTimer,
    modalReturn;
  let books = [],
    issues = [],
    health = {},
    metadata = new Map(),
    chatAbort,
    chatGeneration = 0,
    lastActive = Date.now(),
    lastTick = Date.now();
  const ui = {
    subject: "all",
    version: "all",
    kind: "textbook",
    search: "",
    allGrades: false,
    adminSearch: "",
    adminStatus: "all",
    page: 1,
    zoom: 100,
    loading: "",
    error: "",
    chatId: "free",
    chatBook: null,
    chatPage: 1,
    chatContext: "",
    chatImage: "",
    draft: "",
    busy: false,
    aiError: "",
    practice: null,
    filter: "all",
    scanUrl: "",
    scanData: "",
    scanText: "",
    scanBusy: false,
    scanMode: "question",
    dictation: 0,
    answer: "",
    feedback: "",
    models: [],
    modelsLoading: false,
  };
  const route = () => (location.hash.replace(/^#\/?/, "") || "home").split("/");
  const stateStorageKey = () =>
    "banxuezhua-v4-" +
    user.id +
    (user.role === "parent" ? ":child:" + ui.activeChildId : "");
  const book = (id) => books.find((b) => b.id === id);
  const subject = (b) =>
    C.SUBJECTS[b?.subject] || { name: "其他", icon: "book-open", tone: "blue" };
  const label = (b) =>
    `${gradeName(b.grade)} · ${b.term === 1 ? "上册" : b.term === 2 ? "下册" : "册次待核对"} · ${b.version}`;
  const bookTitle = (b) => subject(b).name + " · " + label(b);
  const progress = (n) =>
    `<div class="progress"><span style="width:${Math.max(0, Math.min(100, n))}%"></span></div>`;
  const button = (text, action, cls = "secondary") =>
    `<button class="${cls}" data-action="${action}">${text}</button>`;
  const empty = (heading, detail, action = "") =>
    `<div class="empty-state">${ico("book-open", "large")}<h2>${esc(heading)}</h2><p>${esc(detail)}</p>${action}</div>`;
  const title = (name, detail = "") =>
    `<div class="page-header"><h1>${esc(name)}</h1>${detail ? `<p>${esc(detail)}</p>` : ""}</div>`;
  const back = (name, dest = "library") =>
    `<div class="back-title"><button class="back-button" data-go="${dest}" aria-label="返回">${ico("arrow-left")}</button><h1>${esc(name)}</h1></div>`;
  function toast(text) {
    $("#toast").textContent = text;
    $("#toast").classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $("#toast").classList.remove("show"), 4500);
  }
  async function api(path, body, options = {}) {
    if (
      user?.role === "parent" &&
      ui.activeChildId &&
      path.startsWith("/api/arena")
    ) {
      if (body === undefined && !/[?&]childId=/.test(path))
        path +=
          (path.includes("?") ? "&" : "?") +
          "childId=" +
          encodeURIComponent(ui.activeChildId);
      else if (body && body.childId == null)
        body = { ...body, childId: ui.activeChildId };
    }
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...options,
    });
    let data;
    try {
      data = await response.json();
    } catch (_) {
      const error = new Error(
        [429, 503].includes(response.status)
          ? "请求有些密集，稍等片刻再试，刚才的内容还在。"
          : "服务暂时没有连接成功，请稍后重试。",
      );
      error.status = response.status;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(
        data.error ||
          ([429, 503].includes(response.status)
            ? "请求有些密集，稍等片刻再试，刚才的内容还在。"
            : "服务请求失败，请稍后重试。"),
      );
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }
  function restrictStudentRecords(value) {
    if (user?.role !== "child" || !ui.restrictedBooks) return value;
    const hidden = (id) =>
      typeof id === "string" && ui.restrictedBooks.has(id.split(":")[0]);
    for (const key of ["reading", "notes", "conversations"])
      if (value[key])
        value[key] = Object.fromEntries(
          Object.entries(value[key]).filter(([id]) => !hidden(id)),
        );
    if (value.pins)
      value.pins = Object.fromEntries(
        Object.entries(value.pins).filter(([, id]) => !hidden(id)),
      );
    for (const key of ["attempts", "mistakes", "questionEvents"])
      if (Array.isArray(value[key]))
        value[key] = value[key].filter((row) => !hidden(row?.book));
    if (value.completed)
      value.completed = value.completed.filter((id) => !hidden(id));
    for (const d of Object.values(value.daily || {}))
      if (d?.pages) d.pages = d.pages.filter((id) => !hidden(id));
    return value;
  }
  function normalize(raw) {
    const base = defaults(),
      v = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const next = {
      ...base,
      ...v,
      settings: { ...base.settings, ...v.settings },
    };
    next.childName =
      typeof next.childName === "string"
        ? next.childName.trim().slice(0, 30) || "张三三"
        : "张三三";
    next.grade = Math.max(1, Math.min(6, Number(next.grade) || 3));
    next.term = next.term === 2 ? 2 : 1;
    next.points = Math.max(0, Number(next.points) || 0);
    for (const k of ["completed", "mistakes", "attempts", "questionEvents"])
      if (!Array.isArray(next[k])) next[k] = [];
    for (const k of ["reading", "notes", "pins", "conversations", "daily"])
      if (!next[k] || typeof next[k] !== "object" || Array.isArray(next[k]))
        next[k] = {};
    for (const [id, r] of Object.entries(next.reading)) {
      if (!r || typeof r !== "object" || Array.isArray(r)) {
        delete next.reading[id];
        continue;
      }
      r.page = Math.max(1, Math.floor(Number(r.page) || 1));
      r.at = Number(r.at) || 0;
      r.bookmarks = Array.isArray(r.bookmarks)
        ? r.bookmarks.filter((n) => Number.isInteger(n) && n > 0)
        : [];
    }
    for (const [date, d] of Object.entries(next.daily)) {
      if (!d || typeof d !== "object" || Array.isArray(d)) {
        delete next.daily[date];
        continue;
      }
      d.seconds = Math.max(0, Math.min(86400, Number(d.seconds) || 0));
      d.pages = Array.isArray(d.pages)
        ? d.pages.filter((x) => typeof x === "string")
        : [];
      d.questions = Math.max(0, Number(d.questions) || 0);
      d.dictation = Math.max(0, Number(d.dictation) || 0);
    }
    for (const [id, messages] of Object.entries(next.conversations))
      next.conversations[id] = Array.isArray(messages)
        ? messages.filter(
            (m) =>
              m &&
              ["user", "assistant"].includes(m.role) &&
              typeof m.content === "string",
          )
        : [];
    next.mistakes = next.mistakes.filter(
      (m) =>
        m &&
        typeof m.id === "string" &&
        m.question &&
        typeof m.question.q === "string" &&
        Array.isArray(m.question.o),
    );
    next.attempts = next.attempts.filter(
      (a) => a && typeof a.question === "string" && Number.isFinite(a.at),
    );
    next.questionEvents = next.questionEvents.filter(
      (e) => e && typeof e.text === "string",
    );
    next.settings.limit = Math.max(
      10,
      Math.min(60, Number(next.settings.limit) || 30),
    );
    next.settings.bedtime = /^\d{2}:\d{2}$/.test(next.settings.bedtime)
      ? next.settings.bedtime
      : "21:00";
    return restrictStudentRecords(next);
  }
  function persist() {
    try {
      writeLocalState(
        JSON.stringify({
          state,
          revision,
          dirty: true,
          restore: !!ui.restoreToken,
        }),
      );
    } catch (_) {
      toast("浏览器缓存不可用，记录仍会保存到学习服务");
    }
    dirty = true;
    clearTimeout(syncTimer);
    if (connected && !conflict) syncTimer = setTimeout(sync, 350);
  }
  async function sync() {
    if (syncing || !dirty || !connected || conflict) return;
    syncing = true;
    dirty = false;
    const syncKey = stateStorageKey(),
      restoreToken = ui.restoreToken;
    try {
      const result = await api(
        restoreToken ? "/api/state/import" : "/api/state",
        {
          state,
          revision,
          childId: user.role === "parent" ? ui.activeChildId : undefined,
        },
      );
      if (!user || stateStorageKey() !== syncKey) return;
      revision = result.revision;
      if (ui.restoreToken === restoreToken) ui.restoreToken = null;
      try {
        writeLocalState(
          JSON.stringify({
            state,
            revision,
            dirty,
            restore: !!ui.restoreToken,
          }),
        );
      } catch (_) {}
    } catch (error) {
      if (!user || stateStorageKey() !== syncKey) return;
      dirty = true;
      if (error.status === 409) {
        conflict = true;
        toast("其他页面已更新记录，请导出本页记录后刷新同步");
      } else toast("服务保存失败，已保留浏览器副本，稍后重试");
    } finally {
      syncing = false;
      if (dirty && !conflict) syncTimer = setTimeout(sync, 3000);
    }
  }
  function writeLocalState(value) {
    if (!ui.cacheRecoveryBlocked)
      localStorage.setItem(stateStorageKey(), value);
  }
  function keepRecovery(local) {
    const key = "bx-state-recovery:" + stateStorageKey() + ":" + local.revision;
    try {
      if (!localStorage.getItem(key))
        localStorage.setItem(
          key,
          JSON.stringify({ ...local, recoveredAt: Date.now() }),
        );
      return true;
    } catch (_) {
      return false;
    }
  }
  function recoveryCopies() {
    const prefix = "bx-state-recovery:" + stateStorageKey() + ":",
      copies = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(prefix)) {
          const value = JSON.parse(localStorage.getItem(key));
          if (value?.state) copies.push(value);
        }
      }
    } catch (_) {}
    if (ui.cacheRecoveryBlocked)
      try {
        const value = JSON.parse(
          localStorage.getItem(stateStorageKey()) || "null",
        );
        if (value?.state) copies.push({ ...value, recoveredAt: Date.now() });
      } catch (_) {}
    return copies.sort((a, b) => (b.recoveredAt || 0) - (a.recoveredAt || 0));
  }
  function recoveryPanel() {
    const copies = recoveryCopies();
    return copies.length
      ? `<section class="settings-section"><h2>本机未同步记录</h2><p class="muted">旧副本已单独保留。当前使用服务器最新记录；备份包含原来的进度、笔记和对话，可核对后恢复。</p>${copies.map((value, index) => `<button class="secondary" data-recovery-download="${index}">下载恢复备份 · ${new Date(value.recoveredAt).toLocaleString("zh-CN")}</button>`).join("")}</section>`
      : "";
  }
  document.addEventListener("click", (event) => {
    const b = event.target.closest?.("[data-recovery-download]");
    if (!b) return;
    const value = recoveryCopies()[Number(b.dataset.recoveryDownload)];
    if (value)
      download(
        JSON.stringify(
          {
            version: 4,
            owner: user.id,
            exportedAt: new Date().toISOString(),
            state: value.state,
          },
          null,
          2,
        ),
        "application/json",
        "伴学爪-本机未同步恢复备份.json",
      );
  });
  function go(path) {
    stopSpeech();
    closeModal();
    ui.error = "";
    if (location.hash === "#/" + path) render();
    else if (!window.BX_SITE_NAV?.replaceRoute(path))
      location.hash = "#/" + path;
  }
  function day() {
    return (state.daily[dateKey()] ||= {
      seconds: 0,
      pages: [],
      questions: 0,
      dictation: 0,
    });
  }
  function minutes() {
    return Math.round(
      Object.values(state.daily).reduce(
        (n, d) => n + (Number(d.seconds) || 0),
        0,
      ) / 60,
    );
  }
  function streak() {
    let n = 0,
      d = new Date(dateKey() + "T12:00:00+08:00");
    if (!state.daily[dateKey()]?.seconds) d.setDate(d.getDate() - 1);
    for (let i = 0; i < 3660; i++) {
      if (!state.daily[dateKey(d)]?.seconds) break;
      n++;
      d.setDate(d.getDate() - 1);
    }
    return n;
  }
  function latest() {
    return Object.entries(state.reading)
      .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
      .map(([id]) => book(id))
      .find((b) => b?.enabled);
  }
  function favorites() {
    return Object.keys(C.SUBJECTS)
      .map((s) => {
        const pinned = book(state.pins[s]);
        if (pinned) return pinned;
        const candidates = books.filter(
          (b) =>
            b.enabled &&
            b.kind === "textbook" &&
            b.subject === s &&
            b.grade === state.grade &&
            b.term === state.term,
        );
        return (
          candidates.find((b) => !/五四|54制|待核对/.test(b.version)) ||
          candidates[0]
        );
      })
      .filter(Boolean);
  }
  function shell(content, name) {
    const r = route(),
      parent =
        user.role === "parent" || (r[0] === "parent" && user.role === "admin"),
      admin = r[0] === "admin";
    document.body.classList.toggle("parent-mode", parent || admin);
    const focusLesson =
      !parent &&
      !admin &&
      (r[0] === "practice" ||
        (r[0] === "arena" && ["question", "unit"].includes(r[1])));
    document.body.classList.toggle("liquid-focus-lesson", focusLesson);
    document.body.classList.toggle(
      "has-liquid-navigation",
      !parent && !admin && !focusLesson && !!window.BX_LIQUID_NAV,
    );
    const links = admin
      ? [
          ["admin/overview", "chart-column", "数据概览"],
          ["admin/notifications", "bell", "通知管理"],
          ["admin/users", "users", "用户管理"],
          ["admin/membership", "shield-check", "会员与兑换码"],
          ["admin/books", "library", "资料管理"],
          ["admin/coverage", "grid-2x2", "覆盖检查"],
          ["admin/questions", "flag", "题目与答案核对"],
          ["admin/ai", "sparkles", "AI 服务"],
          ["arena", "flag", "竞技场题库"],
        ]
      : parent
        ? [
            ["parent/today", "chart-column", "学习概览"],
            ["parent/insight", "brain", "练习情况"],
            ["ai", "messages-square", "家长答疑"],
            ["scan", "camera", "拍题核对"],
            ["parent/books", "library", "教材管理"],
            ["arena", "flag", "章节练习 / 答案"],
            ["parent/settings", "shield-check", "陪伴设置"],
          ]
        : [
            ["home", "home", "今日"],
            ["library", "library", "教材"],
            ["ai", "sparkles", "问爪爪"],
            ["arena", "flag", "竞技场"],
            ["profile", "user-round", "我的"],
          ];
    const active =
      parent || admin
        ? r[0] + "/" + (r[1] || "today")
        : ["reader", "practice"].includes(r[0])
          ? "library"
          : r[0];
    const nav = links
      .map(
        ([path, icon, text]) =>
          `<button data-go="${path}" class="${path === active ? "active" : ""}" aria-label="${text}" ${path === active ? 'aria-current="page"' : ""}>${ico(icon)}<span>${text}</span></button>`,
      )
      .join("");
    return `<aside class="desktop-sidebar"><div class="brand">${img("brand/paw-logo")}<div>伴学爪<small>${admin ? "管理教材与账号" : parent ? "看见每一步真实成长" : "把好奇，读成自己的发现"}</small></div></div><nav class="sidebar-nav" aria-label="主导航">${nav}</nav><div class="sidebar-divider"></div>${user.role !== "parent" ? `<nav class="sidebar-nav secondary-nav"><button data-go="scan" aria-label="拍题答疑">${ico("camera")}<span>拍题答疑</span></button><button data-go="dictation" aria-label="听写小站">${ico("headphones")}<span>听写小站</span></button></nav>` : ""}<div class="sidebar-bottom"><div class="sidebar-companion">${img("brand/paw-mascot", "", "爪爪")}<p>没关系，我们一起想一想。</p></div><button class="text-action block" data-go="${user.role === "parent" ? "profile" : parent || admin ? "home" : "family"}">${ico("users", "small")}<span>${user.role === "parent" ? "个人中心" : parent || admin ? "回到宝宝端" : "绑定家长"}</span></button>${user?.role === "admin" ? '<button class="text-action block" data-go="admin/overview" aria-label="管理员">' + ico("settings", "small") + "<span>管理员</span></button>" : ""}<div class="sidebar-footer"><span>${connected ? "学习服务已连接" : "连接中"}</span><a href="assets.html">资源库</a></div></div></aside><div class="app-main"><header class="topbar"><div class="topbar-path">${ico(parent ? "users" : "home", "small")}<span>${admin ? "管理员" : parent ? "家长中心" : "我的学习空间"}</span>${ico("chevron-right", "small")}<strong>${esc(name)}</strong></div><div class="topbar-actions"><button class="text-action desktop-menu-trigger" data-action="web-menu" aria-label="打开学习导航">${ico("grid-2x2")}<span>功能</span></button><span class="pill mint">独立学习档案</span><button class="text-action" data-action="grade">${gradeName(state.grade)} · ${state.term === 1 ? "上册" : "下册"}${ico("chevron-down", "small")}</button><button class="text-action" data-go="${user.role === "parent" ? "profile" : parent || admin ? "home" : "family"}">${user.role === "parent" ? "我的账户" : parent || admin ? "宝宝端" : "绑定家长"}</button>${window.BX_NOTICES?.trigger() || ""}</div></header><header class="web-header"><button class="web-brand" data-go="${user.role === "parent" ? "parent/today" : "home"}" aria-label="回到网站首页">${img("brand/paw-logo")}<span>伴学爪</span></button><nav aria-label="网站快捷导航">${window.BX_NOTICES?.trigger() || ""}<button class="web-record-trigger" data-go="${user.role === "parent" ? "parent/today" : "ai/history"}" aria-label="${user.role === "parent" ? "学习概览" : "提问记录"}">${ico(user.role === "parent" ? "chart-column" : "notebook-pen")}<span>${user.role === "parent" ? "概览" : "记录"}</span></button>${focusLesson ? `<button class="liquid-focus-plus" data-action="web-menu" aria-label="打开功能菜单">${ico("plus")}</button>` : ""}${parent || admin ? `<button class="web-menu-trigger" data-action="web-menu" aria-label="打开学习导航">${ico("grid-2x2")}<span>功能</span></button>` : ""}</nav></header>${conflict ? '<div class="error-banner">记录已在其他页面更新，请导出本页记录后刷新同步。</div>' : ""}${admin ? '<nav class="mobile-admin-nav" aria-label="管理快捷入口">' + [
      ["overview","概览"],["notifications","通知"],["users","账号"],["books","资料"],["ai","AI 设置"],["membership","会员"]
    ].map(([tab,label])=>'<button data-go="admin/'+tab+'" aria-current="'+((r[1]||"overview")===tab?'page':'false')+'">'+label+'</button>').join("") + '</nav>' : ""}<main id="main" tabindex="-1" class="page">${ui.error ? `<div class="error-banner" role="alert">${esc(ui.error)}</div>` : ""}${content}</main>${!parent && !admin && !focusLesson ? window.BX_LIQUID_NAV?.render(r, ico) || "" : ""}</div>`;
  }
  function card(b) {
    const r = state.reading[b.id];
    return `<button class="book-card tone-${subject(b).tone}" data-read="${b.id}" aria-label="打开${esc(bookTitle(b))} ${b.kind === "answers" ? "习题答案" : "教材"}"><div class="book-cover-wrap"><img loading="lazy" src="${esc(uiAsset(`assets/books/${C.SUBJECTS[b.subject] ? b.subject : "math"}.svg`))}" alt="${subject(b).name}封面标识"><span class="book-term">${b.term === 1 ? "上册" : b.term === 2 ? "下册" : "待核对"}</span><span class="format-label">${b.format.toUpperCase()}</span></div><h3>${gradeName(b.grade)} · ${subject(b).name}</h3><p>${esc(b.version)}</p><small class="book-file-title">${esc(b.title)}</small><div class="book-mini-progress"><span>${r ? "读到第 " + r.page + " 页" : "打开真实内页"}</span>${b.kind === "answers" ? '<span class="pill blue">习题 / 答案</span>' : ""}</div></button>`;
  }
  function home() {
    const b = latest(),
      f = favorites(),
      d = day(),
      resume = window.BX_ARENA_LEARNING?.resumeCard();
    const tools = [
      ["scan", "camera", "拍题问爪爪", ""],
      ["homework", "check-check", "检查作业", ""],
      ["dictation", "headphones", "听写小站", ""],
      ["review", "notebook-pen", "错题再想想", ""],
    ];
    return `<div class="web-home"><section class="web-greeting">${img("brand/child-avatar", "web-avatar", "学习头像")}<div><h1>你好，${esc(state.childName)}小朋友</h1><p>今天，继续发现一点新知识。</p></div>${window.BX_VIP?.homeBadge() || ""}</section>${user.role === "child" ? window.BX_PERSONAL?.home({ api, esc, user: () => user, grade: () => state.grade, route, render, go, toast }) || "" : ""}<section class="web-stats" aria-label="我的学习成长"><div><strong>${streak()} 天</strong><span>连续学习</span></div><div><strong>${state.points}</strong><span>成长值</span></div><div><strong>${d.pages.length} 页</strong><span>今日阅读</span></div></section>${window.BX_HOME_EXPERIENCE?.page({ api, esc, user: () => user, route, render, modal }) || ""}<section class="web-tools" aria-label="学习小工具">${tools.map(([dest, icon, name, sub]) => `<button class="web-tool ${sub ? "major" : ""}" ${dest === "homework" ? 'data-action="homework"' : `data-go="${dest}"`}>${ico(icon)}<strong>${name}</strong>${sub ? `<small>${sub}</small>` : ""}</button>`).join("")}</section>${state.parentMessage ? `<details class="web-family-message"><summary>家人的悄悄话</summary><p>${esc(state.parentMessage)}</p></details>` : ""}<section class="web-resume"><strong>${resume ? "继续上次 · " + esc(resume.title) : "爪爪竞技场"}</strong><p>${resume ? esc(resume.detail) : "按教材章节练习，题目、草稿与提示一起保存。"}</p><button class="primary block" data-go="${resume ? "arena/question/" + resume.id : "arena"}">${resume ? "继续练习" : "开始章节练习"}</button></section><section class="web-mybooks"><div class="between"><h2>我的教材</h2><button class="text-action" data-go="library">全部教材 ${ico("chevron-right", "small")}</button></div>${f.map((item) => `<button class="web-book-row" data-read="${item.id}"><span><strong>${esc(gradeName(item.grade) + " · " + subject(item).name + " · " + (item.term === 2 ? "下册" : "上册"))}</strong><small>${esc(item.version)}${state.reading[item.id] ? " · 第 " + state.reading[item.id].page + " 页" : ""}</small></span>${ico("chevron-right", "small")}</button>`).join("") || '<button class="secondary block" data-go="library">选择你的教材</button>'}${b ? `<button class="text-action web-reading-resume" data-read="${b.id}">继续阅读 ${esc(subject(b).name)} · 第 ${state.reading[b.id].page} 页</button>` : ""}</section></div>`;
  }
  function library(answerOnly = false) {
    const kinds =
      user.role === "child"
        ? [["textbook", "课本"]]
        : answerOnly
          ? [["answers", "参考答案"]]
          : [
              ["textbook", "课本"],
              ["answers", "习题与答案"],
              ["all", "全部资料"],
            ];
    if (answerOnly) ui.kind = "answers";
    else if (user.role === "child") ui.kind = "textbook";
    const versions = [
      ...new Set(
        books
          .filter(
            (b) =>
              b.enabled &&
              (ui.allGrades || b.grade === state.grade) &&
              (ui.subject === "all" || b.subject === ui.subject),
          )
          .map((b) => b.version),
      ),
    ].sort();
    if (ui.version !== "all" && !versions.includes(ui.version))
      ui.version = "all";
    const items = books.filter(
      (b) =>
        b.enabled &&
        (ui.allGrades || b.grade === state.grade) &&
        (!b.term || b.term === state.term) &&
        (ui.subject === "all" || b.subject === ui.subject) &&
        (ui.version === "all" || b.version === ui.version) &&
        (ui.kind === "all" || b.kind === ui.kind) &&
        (!ui.search ||
          `${b.title} ${b.version} ${subject(b).name} ${gradeName(b.grade)}`
            .toLowerCase()
            .includes(ui.search.trim().toLowerCase())),
    );
    return `<div class="library-head"><div><h1>${answerOnly ? "教材参考答案" : "找到你的那本书"}</h1><p>${answerOnly ? "家长专属查看，可按年级、学科、册次和版本筛选。" : "阅读教材原文件，保留文字、插图与完整内页。"}</p></div><label class="search-field">${ico("search", "small")}<input id="book-search" type="search" value="${esc(ui.search)}" placeholder="搜索教材名称或版本" aria-label="搜索教材"></label></div><section class="filter-bar" aria-label="筛选教材"><div class="filter-line"><span class="filter-label">年级</span><div class="grade-segment"><button data-all-grades="true" class="${ui.allGrades ? "active" : ""}">全部</button>${C.GRADE_NAMES.map((n, i) => `<button data-grade="${i + 1}" class="${!ui.allGrades && state.grade === i + 1 ? "active" : ""}">${n}年级</button>`).join("")}</div></div><div class="filter-line"><span class="filter-label">学科</span><div class="subject-tabs">${[["all", { name: "全部", icon: "grid-2x2" }], ...Object.entries(C.SUBJECTS)].map(([id, s]) => `<button data-subject="${id}" class="${ui.subject === id ? "active" : ""}">${ico(s.icon, "small")}${s.name}</button>`).join("")}</div><div class="term-switch">${[1, 2].map((n) => `<button data-term="${n}" class="${state.term === n ? "active" : ""}">${n === 1 ? "上册" : "下册"}</button>`).join("")}</div></div><div class="filter-line"><span class="filter-label">版本</span><select id="library-version" aria-label="筛选教材版本"><option value="all">全部版本</option>${versions.map((v) => `<option ${ui.version === v ? "selected" : ""}>${esc(v)}</option>`).join("")}</select><div class="subject-tabs">${kinds.map(([id, n]) => `<button data-kind="${id}" class="${ui.kind === id ? "active" : ""}">${n}</button>`).join("")}</div></div></section><div class="between section-title"><h2>${ui.allGrades ? "所有年级" : gradeName(state.grade)} · ${ui.kind === "textbook" ? "真实课本" : ui.kind === "answers" ? "习题与参考答案" : "学习资料"}</h2><span class="library-count">${items.length} 份</span></div><div class="library-books">${items.map(card).join("")}</div>${!items.length ? empty("当前筛选下没有教材文件", "暂未提供的版本不会显示为可学习。可切换版本，或由管理员补充教材。", button("清除筛选", "clear-search")) : ""}<p class="source-notice">${ico("info", "small")}分类来自文件名与所在目录，可由管理员核对修正。封面为学科标识，阅读页显示原文件。</p>`;
  }
  function openBook(id, page) {
    if (!book(id)?.enabled) {
      toast("教材不存在或已下架");
      return;
    }
    go("reader/" + id + "/" + (page || state.reading[id]?.page || 1));
  }
  function markReading(id, page) {
    if (user.role === "parent" && book(id)?.kind === "answers") return;
    state.reading[id] = {
      bookmarks: [],
      ...state.reading[id],
      page,
      at: Date.now(),
    };
    const key = id + ":" + page;
    if (!day().pages.includes(key)) day().pages.push(key);
    persist();
  }
  async function loadMeta(id) {
    if (ui.loading === id) return;
    ui.loading = id;
    try {
      const meta = await api("/api/books/" + id);
      metadata.set(id, meta);
      if (route()[1] === id) {
        markReading(
          id,
          Math.min(meta.pageCount, Math.max(1, Number(route()[2]) || 1)),
        );
        render();
      }
    } catch (error) {
      if (route()[1] === id) {
        ui.error = error.message;
        $("#main").innerHTML =
          back("教材阅读") +
          empty("教材未能打开", error.message, button("返回教材", "library"));
      }
    } finally {
      if (ui.loading === id) ui.loading = "";
    }
  }
  function readerImageUrl(id, page) {
    return `/api/books/${id}/page?n=${page}&width=1800&clean=${state.settings.cleanReading ? 1 : 0}`;
  }
  let readerTurnToken = 0;
  function reader() {
    const id = route()[1],
      b = book(id);
    if (!b?.enabled)
      return (
        back("教材阅读") +
        empty(
          "这份教材不可用",
          "资料不存在或已下架。",
          button("返回教材", "library"),
        )
      );
    const meta = metadata.get(id);
    if (!meta) {
      queueMicrotask(() => loadMeta(id));
      return back(b.title) + empty("正在打开教材", "正在准备这一页，请稍等。");
    }
    const page = (ui.page = Math.min(
        meta.pageCount,
        Math.max(1, Number(route()[2]) || 1),
      )),
      r = state.reading[id] || { bookmarks: [] },
      marked = (r.bookmarks || []).includes(page),
      word = meta.pageFormats?.[page - 1] === "docx" || b.format === "docx",
      sourceUrl = readerImageUrl(id, page);
    window.BX_LEARNING?.enterReader(
      [
        user.id,
        user.role,
        ui.activeChildId || "",
        id,
        state.settings.cleanReading ? 1 : 0,
      ].join(":"),
    );
    window.BX_LEARNING?.pageCache.pin(sourceUrl);
    const url = word
      ? sourceUrl
      : window.BX_LEARNING?.pageCache.get(sourceUrl) || sourceUrl;
    return `<div class="reader-topline">${back(subject(b).name + " · " + gradeName(b.grade), user.role === "parent" ? (b.kind === "answers" ? "parent/answers" : "parent/library") : "library")}<span class="pill ${subject(b).tone}">${esc(b.version)}</span></div>
    <details class="reader-info"><summary>${esc(b.title)}</summary><p>${b.kind === "answers" ? "习题与参考答案" : "教材原文"} · 共 ${meta.pageCount} ${word ? "份文档" : "页"}</p>${b.kind !== "answers" ? `<button class="secondary" data-pin="${id}">${state.pins[b.subject] === id ? "已在我的书架" : "放入我的书架"}</button>` : ""}</details>
    <div class="real-reader-layout"><section>
    <div class="reader-toolbar ebook-toolbar" aria-label="教材翻页"><button class="secondary ebook-turn" data-page="${page - 1}" ${page === 1 ? "disabled" : ""} aria-label="上一页">${ico("chevron-left")}<span>上页</span></button><form id="page-form"><input id="page-number" type="number" min="1" max="${meta.pageCount}" value="${page}" aria-label="跳转页码"><span>/ ${meta.pageCount}</span><button type="submit" aria-label="跳到输入的页码">跳转</button></form><button class="primary ebook-turn" data-page="${page + 1}" ${page === meta.pageCount ? "disabled" : ""} aria-label="下一页"><span>下页</span>${ico("chevron-right")}</button></div>
    <details class="reader-tools"><summary>阅读设置 · ${ui.zoom}%</summary><div class="reader-controls"><button data-zoom="-20" aria-label="缩小教材">${ico("shrink", "small")}</button><span>${ui.zoom}%</span><button data-zoom="20" aria-label="放大教材">${ico("expand", "small")}</button><button data-action="page-bookmark" aria-label="${marked ? "取消本页书签" : "收藏本页"}">${ico(marked ? "bookmark-check" : "bookmark", "small")}</button><button data-action="page-note" aria-label="本页笔记">${ico("notebook-pen", "small")}</button><button data-action="toggle-clean" class="clean-toggle">${state.settings.cleanReading ? "清爽阅读 · 开" : "原始页面"}</button></div></details>
    <div class="textbook-sheet ebook-viewport ${ui.readerDirection === 1 ? "turn-forward" : ui.readerDirection === -1 ? "turn-back" : ""}" data-zoom="${ui.zoom}" aria-label="教材正文，可上下滚动，左右滑动翻页">${word ? `<iframe title="教材文档完整内容" src="${url}" sandbox="allow-same-origin"></iframe>` : `<img id="textbook-page" draggable="false" ${window.BX_MEDIA?.source(sourceUrl, url) || `src="${url}"`} style="width:${ui.zoom}%" alt="${esc(b.title)} 第 ${page} 页教材原文">`}</div>
    <p id="reader-page-status" class="reader-page-status" role="status" aria-live="polite"></p><p class="ebook-help">${ui.zoom > 100 ? "已放大，可拖动查看；使用顶部按钮翻页。" : "上下滑动阅读 · 左右轻扫翻页"} · 第 ${page} / ${meta.pageCount} 页</p>${state.notes[id + ":" + page] ? `<div class="note-created">本页笔记：${esc(state.notes[id + ":" + page])}</div>` : ""}</section>
    <aside class="reader-aside">${b.kind === "answers" ? "" : `<section class="lesson-note"><h3>${ico("sparkles", "small")}读懂，再练一练</h3><button class="primary block" data-action="ask-page" ${ui.busy ? "disabled" : ""}>这一页我有问题</button><button class="secondary block" data-action="explain-page" ${ui.busy ? "disabled" : ""}>带我一步步读懂</button><button class="secondary block" data-go="arena/book/${id}">爪爪竞技场 · 同步练习</button><small class="muted">AI 辅导会读取本页内容；不清楚的地方一起回到原文核对。</small></section>`}<details class="reader-directory"><summary>教材目录与书签</summary>${meta.toc?.length ? meta.toc.map((t) => `<button class="toc-row" style="padding-left:${10 + Math.min(t.level, 4) * 12}px" data-page="${t.page}">${esc(t.title)}<small>${t.page}</small></button>`).join("") : '<p class="muted tiny">原文件未嵌入电子目录，可查看开头印刷目录，再输入文件页码。</p>'}<button class="text-action" data-page="${Math.min(3, meta.pageCount)}">翻到开头查目录</button><h4>我的书签</h4>${(r.bookmarks || []).length ? r.bookmarks.map((n) => `<button class="toc-row" data-page="${n}">第 ${n} 页${ico("bookmark", "small")}</button>`).join("") : '<p class="muted tiny">点击书签按钮收藏本页。</p>'}</details><a class="secondary block" href="/api/books/${id}/original">${ico("download", "small")}${b.packed ? "下载阅读版 PDF" : "下载教材文件"}</a>${b.packed ? `<a class="secondary block" href="/api/books/${id}/offline">${ico("download", "small")}下载离线阅读版（HTML）</a>` : ""}</aside></div>`;
  }
  function conversation() {
    return (state.conversations[ui.chatId] ||= []);
  }
  function setChat(b, page = 1, context = "", image = "", imageId = "") {
    if (b) window.BX_STUDY?.prepare({ bookId: b.id, page, label: context });
    ui.chatArenaUnitId = "";
    ui.chatArenaTitle = "";
    ui.chatBook = b?.id || null;
    ui.chatPage = page;
    ui.chatId = b ? b.id + ":" + page : image ? "scan" : "free";
    ui.chatContext = context;
    ui.chatImage = image;
    ui.chatImageId = imageId;
    ui.aiError = "";
    ui.draft = "";
    try {
      sessionStorage.setItem(
        "banxuezhua-chat-context-" + user.id,
        JSON.stringify({
          materialRevision: b?.contentRevision || "",
          chatBook: ui.chatBook,
          chatPage: page,
          chatId: ui.chatId,
          chatContext: context,
          chatImageId: imageId,
        }),
      );
    } catch (_) {}
  }
  function aiPage() {
    if (window.BX_STUDY) return window.BX_STUDY.page();
    if (user.role === "parent")
      return empty(
        "家长答疑暂未打开",
        "请刷新页面，恢复家长自己的提问和历史记录。",
      );
    const messages = conversation(),
      b = book(ui.chatBook);
    return `${title("问问爪爪", "说说哪里不明白，我们从那里开始。")}<div class="ai-layout"><section class="chat-surface"><div class="chat-context">${ico(b ? "book-open" : "sparkles")}<div><strong>${esc(b ? b.title : ui.chatArenaTitle || (ui.chatId === "scan" ? "图片题目 / 作业" : "自由提问"))}</strong><small>${esc(b ? label(b) + " · 第 " + ui.chatPage + " 页" : gradeName(state.grade) + " · AI 答疑")}</small></div><button class="round-action" data-action="chat-reset" aria-label="重新开始对话">${ico("rotate-ccw", "small")}</button></div>${ui.chatId === "scan" ? (ui.chatImage ? `<button class="chat-image-attachment" data-action="chat-image"><img src="${esc(ui.chatImage)}" alt="本次提问的题目图片"><span>已附题目图片</span></button>` : `<div class="error-banner">这段对话没有可用原图，请重新上传题目图片。<button data-go="scan">重新上传</button></div>`) : ""}<div class="chat-messages" id="chat-messages" role="log" aria-live="polite" aria-label="与爪爪的对话">${!messages.length ? `<div class="chat-message">${img("brand/paw-logo", "chat-avatar", "爪爪")}<div class="chat-bubble">${b ? "这一页的哪个词、步骤或图画让你好奇？可以直接问，也可以让我从头讲解。" : "你好，我是爪爪。把题目和你的想法告诉我吧。"}</div></div>` : ""}${messages.map((m) => `<div class="chat-message ${m.role === "user" ? "user" : ""}">${m.role === "assistant" ? img("brand/paw-logo", "chat-avatar", "爪爪") : ""}<div class="chat-bubble">${m.role === "assistant" ? `<div class="chat-rich">${richText(m.content)}</div>` : esc(m.content).replace(/\n/g, "<br>")}</div></div>`).join("")}${ui.busy ? `<div class="chat-message">${img("brand/paw-logo", "chat-avatar", "爪爪")}<div class="chat-bubble"><div id="ai-stream-content" class="chat-rich">${richText(ui.streamDraft || "")}</div><div class="ai-working" id="ai-stream-status" role="status"><span class="working-dots"><i></i><i></i><i></i></span><span>${esc(ui.aiStatus || "正在认真看题，我们一步一步来。")}</span></div></div></div>` : ""}${ui.aiError ? `<div class="error-banner" role="alert">${esc(ui.aiError)}<button class="text-action" data-action="retry-chat">重试上一个问题</button></div>` : ""}<div class="chat-options"><button data-prompt="先不要给答案，给我一个小提示。" ${ui.busy ? "disabled" : ""}>给我一个小提示</button><button data-prompt="刚才这一步我还没理解，请换个简单例子，再问我一个能做的小问题。" ${ui.busy ? "disabled" : ""}>这一步我没懂</button></div></div><form class="chat-input-wrap" id="chat-form"><div class="chat-input"><input id="chat-input" maxlength="3000" placeholder="把你的想法告诉爪爪……" value="${esc(ui.draft)}" aria-label="你的问题或想法" autocomplete="off"><button class="send" type="submit" aria-label="发送" ${ui.busy ? "disabled" : ""}>${ico("send")}</button></div><div class="chat-footer">${ico("shield-check", "small")}${health.configured ? "已配置 AI · 回答请结合教材检查" : "AI 服务未配置，请联系管理员"}</div></form></section><aside class="chat-aside"><h3>本次学习</h3><p class="muted">${esc(ui.chatContext || gradeName(state.grade) + "自由问答")}</p>${ui.chatArenaUnitId ? `<button class="primary block" data-go="arena/unit/${ui.chatArenaUnitId}">回到这段练习</button>` : ""}${b ? `<button class="secondary block" data-read="${b.id}" data-read-page="${ui.chatPage}">回到教材第 ${ui.chatPage} 页</button>` : ""}<button class="secondary block" data-action="free-chat">开始自由提问</button><div class="care-note"><div><h3>每一步想法都很有用</h3><p>AI 可能出错。有不确定的地方，回到教材里找证据。</p></div></div></aside></div>`;
  }
  function richText(text) {
    return window.BX_CHAT
      ? window.BX_CHAT.markdown(text)
      : esc(text || "")
          .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
          .replace(/\n/g, "<br>");
  }
  function paintStream() {
    if (ui.paintPending) return;
    ui.paintPending = true;
    const draw = () => {
      ui.paintPending = false;
      if (!ui.busy || route()[0] !== "ai") return;
      const logBefore = $("#chat-messages"),
        follow =
          logBefore &&
          logBefore.scrollHeight -
            logBefore.scrollTop -
            logBefore.clientHeight <
            100;
      const content = $("#ai-stream-content"),
        status = $("#ai-stream-status");
      if (content) {
        content.innerHTML = richText(ui.streamDraft || "");
        window.BX_CHAT?.typeset([content]);
      }
      if (status) {
        const label = status.querySelector?.("span:last-child");
        if (label) label.textContent = ui.aiStatus || "正在整理讲解…";
      }
      const log = $("#chat-messages");
      if (log && follow) log.scrollTop = log.scrollHeight;
    };
    if (window.requestAnimationFrame) window.requestAnimationFrame(draw);
    else queueMicrotask(draw);
  }
  async function sendChat(prompt, retry = false) {
    if (window.BX_STUDY)
      return window.BX_STUDY.send(
        prompt,
        {
          bookId: ui.chatBook,
          page: ui.chatPage,
          arenaUnitId: ui.chatArenaUnitId,
          questionId: ui.chatQuestionId,
        },
        retry,
      );
    if (user.role === "parent") {
      toast("家长答疑暂未打开，请刷新页面后重试");
      return;
    }
    prompt = prompt.trim();
    if (!prompt || ui.busy) return;
    if (ui.chatId === "scan" && !ui.chatImage && !ui.chatImageId) {
      ui.aiError = "这段对话的原图未保存，请重新上传题目图片后再提问";
      render();
      return;
    }
    const messages = conversation(),
      id = ui.chatId,
      generation = chatGeneration;
    if (!retry) {
      messages.push({ role: "user", content: prompt });
      day().questions++;
      state.questionEvents.push({
        at: Date.now(),
        book: ui.chatBook,
        source: ui.chatArenaUnitId
          ? "arena"
          : ui.chatId === "scan"
            ? "scan"
            : "chat",
        text: prompt,
      });
    }
    ui.lastPrompt = prompt;
    ui.draft = "";
    ui.busy = true;
    ui.aiError = "";
    ui.streamDraft = "";
    ui.forceChatBottom = true;
    ui.aiStatus =
      ui.chatImageId || ui.chatBook
        ? "正在看清题目，我们一步一步来。"
        : "正在认真理解你的问题。";
    persist();
    render();
    const initialLog = $("#chat-messages");
    if (initialLog) initialLog.scrollTop = initialLog.scrollHeight;
    chatAbort = new AbortController();
    try {
      const body = {
        prompt,
        messages: messages.slice(0, -1).slice(-22),
        context: ui.chatContext || gradeName(state.grade),
        arenaUnitId: ui.chatArenaUnitId || undefined,
        bookId: ui.chatBook,
        page: ui.chatPage,
        clean: state.settings.cleanReading,
        imageId: ui.chatImageId || undefined,
        image: ui.chatImageId ? undefined : ui.chatImage || undefined,
      };
      const result = window.BX_CHAT
        ? await window.BX_CHAT.stream(body, {
            signal: chatAbort.signal,
            onEvent: (event) => {
              if (generation !== chatGeneration) return;
              if (event.type === "delta") {
                ui.streamDraft += event.text;
                ui.aiStatus = "正在写下讲解，你可以边看边想。";
              }
              if (event.type === "reset") ui.streamDraft = "";
              if (event.type === "status") ui.aiStatus = event.text;
              paintStream();
            },
          })
        : await api("/api/chat", body, { signal: chatAbort.signal });
      if (generation !== chatGeneration) return;
      messages.push({
        role: "assistant",
        content: result.reply,
        model: result.model,
      });
      persist();
    } catch (error) {
      if (error.name !== "AbortError" && generation === chatGeneration) {
        ui.aiError = error.message;
        if (error.status === 401) {
          connected = false;
          user = null;
        }
      }
    } finally {
      if (generation === chatGeneration) {
        ui.busy = false;
        ui.streamDraft = "";
        if (route()[0] === "ai" && ui.chatId === id) {
          render();
        }
      }
    }
  }

  function practicePage() {
    const p = ui.practice;
    if (!p)
      return (
        back("教材练习") +
        empty(
          "进入教材章节练习",
          "题目已按教材章节提前准备，选择章节即可开始。",
          '<button class="primary" data-go="arena">打开爪爪竞技场</button>',
        )
      );
    const b = book(p.book);
    if (!b) return empty("教材已不可用", "请重新选择教材。");
    if (p.done)
      return `${back("练习完成", "reader/" + p.book + "/" + p.page)}<section class="result-stage">${img("brand/paw-mascot", "", "爪爪为你加油")}<span class="pill orange">已保存本次练习</span><h2>${p.correct === p.questions.length ? "想明白的感觉，真好！" : "把小岔路，变成新发现"}</h2><p>答对 ${p.correct} / ${p.questions.length} 题 · 本次 +${p.reward || 0} 成长值</p><div class="result-actions"><button class="secondary" data-go="review">查看错题</button><button class="primary" data-read="${p.book}" data-read-page="${p.page}">回到教材</button></div></section>`;
    const q = p.questions[p.index];
    return `${back("教材随堂练习", "reader/" + p.book + "/" + p.page)}<div class="lesson-meta"><span class="pill blue">${subject(b).name} · 第 ${p.page} 页</span><span class="pill">${p.index + 1} / ${p.questions.length}</span><span class="pill">AI 生成，可对照原文核验</span></div><section class="exercise-stage">${progress((p.index / p.questions.length) * 100)}<h2 class="question-title">${esc(q.q)}</h2><div class="answer-options">${q.o.map((o, i) => `<button class="answer-option ${p.selected === i ? "selected" : ""} ${p.submitted && i === q.a ? "correct" : ""} ${p.submitted && p.selected === i && i !== q.a ? "wrong" : ""}" data-answer="${i}" ${p.submitted ? "disabled" : ""}><span class="answer-letter">${String.fromCharCode(65 + i)}</span><span>${esc(o)}</span>${p.submitted && i === q.a ? ico("circle-check") : ""}</button>`).join("")}</div>${p.submitted ? `<div class="feedback ${p.selected === q.a ? "" : "retry"}">${ico("lightbulb")}<div><strong>${p.selected === q.a ? "答对了，看看解释" : "看看这一步，再想一次"}</strong><p>${esc(q.why)}</p></div></div>` : ""}<div class="exercise-bottom"><button class="text-action" data-read="${p.book}" data-read-page="${p.page}">回原文找线索</button><button class="primary" data-action="${p.submitted ? "next-question" : "submit-answer"}" ${!p.submitted && p.selected === null ? "disabled" : ""}>${p.submitted ? (p.index === p.questions.length - 1 ? "完成练习" : "下一题") : "确认答案"}${ico("arrow-right", "small")}</button></div></section>`;
  }
  function mapBookPage(id, value) {
    const b = book(id),
      old = Math.max(1, Number(value) || 1);
    return Math.min(
      b?.cleanPageCount || Infinity,
      Math.max(
        1,
        old - (b?.removedAdPages || []).filter((n) => n < old).length,
      ),
    );
  }
  function savePractice() {
    if (ui.practice)
      ui.practice.materialRevision =
        book(ui.practice.book)?.contentRevision || "";
    try {
      sessionStorage.setItem(
        "banxuezhua-practice-" + user.id,
        JSON.stringify(ui.practice),
      );
    } catch (_) {}
    persist();
  }
  function submitAnswer() {
    const p = ui.practice;
    if (!p || p.done || p.submitted || p.selected === null) return;
    p.submitted = true;
    const q = p.questions[p.index],
      correct = p.selected === q.a;
    if (correct) p.correct++;
    if (p.reviewId && correct) {
      const m = state.mistakes.find((m) => m.id === p.reviewId);
      if (m) {
        m.resolved = true;
        m.resolvedAt = Date.now();
      }
    }
    if (!correct) {
      const id = p.reviewId || p.book + ":" + p.page + ":" + q.q;
      let m = state.mistakes.find((m) => m.id === id);
      if (!m) {
        m = {
          id,
          book: p.book,
          page: p.page,
          question: q,
          at: Date.now(),
          wrong: 0,
        };
        state.mistakes.push(m);
      }
      m.wrong++;
      m.resolved = false;
    }
    state.attempts.push({
      book: p.book,
      page: p.page,
      question: q.q,
      correct,
      answer: p.selected,
      at: Date.now(),
    });
    savePractice();
    render();
  }
  function nextQuestion() {
    const p = ui.practice;
    if (!p || p.done || !p.submitted) return;
    if (p.index < p.questions.length - 1) {
      p.index++;
      p.selected = null;
      p.submitted = false;
    } else {
      p.done = true;
      const key = p.book + ":" + p.page;
      if (!state.completed.includes(key) && !p.reviewId) {
        state.completed.push(key);
        p.reward = p.correct * 10 + 10;
        state.points += p.reward;
      } else p.reward = 0;
    }
    savePractice();
    render();
    window.scrollTo(0, 0);
  }
  function reviewPage() {
    const all = state.mistakes.filter((m) => !m.resolved),
      items = all.filter(
        (m) => ui.filter === "all" || book(m.book)?.subject === ui.filter,
      );
    return `${title("把不会的，变成会的", "保存原题、选项、解释和教材页码。复习答对后移入已掌握记录。")}<section class="review-summary"><div><h2>${all.length ? "还有 " + all.length + " 道题，值得再想一想" : "当前没有待复习错题"}</h2><p>真实教材练习答错的题会自动记在这里。</p></div>${img("brand/paw-mascot", "", "爪爪为你加油")}</section><div class="subject-tabs">${[["all", "全部"], ...Object.entries(C.SUBJECTS).map(([id, s]) => [id, s.name])].map(([id, n]) => `<button data-review-filter="${id}" class="${ui.filter === id ? "active" : ""}">${n}</button>`).join("")}</div><div class="review-list">${items
      .map((m) => {
        const b = book(m.book);
        return `<article class="review-item"><span class="review-icon tone-${subject(b).tone}">${ico(subject(b).icon)}</span><div class="review-info"><h3>${esc(m.question.q)}</h3><p>${esc(b ? bookTitle(b) : "教材已移除")} · 第 ${m.page} 页 · 错 ${m.wrong} 次</p></div><button class="secondary" data-review="${esc(m.id)}">再想一次</button></article>`;
      })
      .join(
        "",
      )}</div>${!items.length ? empty("这里暂时没有错题", "可以去教材阅读页完成一组练习。") : ""}<p class="source-notice">已掌握 ${state.mistakes.filter((m) => m.resolved).length} 题。历史作答保留在家长端。</p>`;
  }
  function growthPage() {
    const pages = Object.values(state.daily).reduce(
      (n, d) => n + (d.pages?.length || 0),
      0,
    );
    return `${title("每一小步，都算数", "成长数据来自你的实际学习记录。")}<section class="growth-summary"><div><span class="pill orange">我的成长足迹</span><h2>今天，又多懂了一点点。</h2><div class="growth-number">${state.points}<small>成长值</small></div><p>读过 ${pages} 页 · 完成 ${state.completed.length} 组练习 · 学习 ${minutes()} 分钟</p></div>${img("brand/paw-mascot", "", "开心的爪爪")}</section><div class="badge-grid section-title">${[
      ["sprout", "好奇心发芽", "阅读第一份教材", pages > 0],
      ["flame", "七日小坚持", "连续学习 7 天", streak() >= 7],
      ["lightbulb", "想明白了", "完成一组教材练习", state.completed.length > 0],
      [
        "trophy",
        "知识小探险家",
        "完成 6 组教材练习",
        state.completed.length >= 6,
      ],
    ]
      .map(
        ([i, h, p, on]) =>
          `<button class="badge-item ${on ? "" : "locked"}" data-badge="${h}" data-badge-detail="${p}">${ico(i, "large")}<h3>${h}</h3><p>${on ? "已收集 · " : ""}${p}</p></button>`,
      )
      .join(
        "",
      )}</div><div class="profile-actions"><button class="secondary" data-action="grade">我的年级</button><button class="secondary" data-action="notes-list">学习笔记（${Object.values(state.notes).filter(Boolean).length}）</button><button class="secondary" data-go="parent/today">和家人分享成长</button></div>`;
  }
  function scanPage() {
    if (window.BX_STUDY) return window.BX_STUDY.scanPage(ui.scanMode);
    if (user.role === "parent")
      return empty(
        "家长拍题暂未打开",
        "请刷新页面后重新上传，图片与提问会保存在家长自己的记录中。",
      );
    return `<div class="scan-stage">${title(ui.scanMode === "homework" ? "检查作业，看看思路" : "拍下问题，一起想想", "选择清楚的图片，核对题目，再交给爪爪分析。")}<section class="scan-preview">${ui.scanUrl ? `<img src="${esc(ui.scanUrl)}" alt="待识别的题目图片">` : `<div class="scan-empty">${ico("scan-line")}<h3>把题目放进来</h3><p>拍照，或选择一张图片</p></div>`}</section><div class="scan-toolbar"><button class="primary" data-action="camera">${ico("camera")}拍照</button><button class="secondary" data-action="upload">${ico("image")}相册上传</button></div>${ui.scanReading ? '<p role="status" class="scan-note">正在读取新图片…</p>' : ""}${ui.scanUrl ? `<section class="scan-recognized"><h3>核对题目内容</h3><button class="secondary" data-action="ocr" ${ui.scanBusy || ui.scanReading ? "disabled" : ""}>${ui.scanBusy ? "正在识别…" : "AI 识别图片文字"}</button><textarea id="scan-text" aria-label="确认题目文字" placeholder="可先识别，也可直接输入题目。确认后图片会一并交给 AI。">${esc(ui.scanText)}</textarea><button class="primary block" data-action="scan-confirm" ${ui.scanBusy || ui.scanReading ? "disabled" : ""}>${ui.scanMode === "homework" ? "检查作业思路" : "确认题目，问爪爪"}</button></section>` : ""}<p class="scan-note">JPG、PNG、WebP · 每张不超过 10 MB。点击识别或确认后，图片与题目会发送至配置的 AI 服务。</p></div>`;
  }
  const defaultWords = {
    1: ["高山", "日月", "朋友", "学校"],
    2: ["发现", "自然", "温暖", "眼睛"],
    3: ["观察", "旅行", "思考", "知识"],
    4: ["规律", "描写", "证据", "景象"],
    5: ["探索", "表达", "比较", "推理"],
    6: ["严谨", "理解", "总结", "判断"],
  };
  function words() {
    const entries = state.settings.dictationEntries;
    if (Array.isArray(entries) && entries.length)
      return entries.map((e) => e.text);
    return (state.settings.dictationWords || "")
      .split(/[\n,，、;；]+/)
      .map((w) => w.trim())
      .filter(Boolean);
  }
  function matchesDictationAnswer(answer, entry) {
    const clean = (value) => String(value).trim().replace(/\s+/g, " "),
      english = (value) =>
        clean(value)
          .replace(/[\u2018\u2019]/g, "'")
          .toLowerCase();
    return entry.language?.startsWith("en")
      ? [
          entry.text,
          ...(Array.isArray(entry.acceptedSpellings)
            ? entry.acceptedSpellings
                .filter((v) => typeof v === "string" && v.length <= 80)
                .slice(0, 8)
            : []),
        ].some((text) => english(answer) === english(text))
      : clean(answer) === clean(entry.text);
  }
  function dictationMeaning(entry) {
    const content =
      Array.isArray(entry.meaningTokens) &&
      entry.meaningTokens.length > 0 &&
      entry.meaningTokens.length <= 500 &&
      window.BX_CHARACTERS
        ? window.BX_CHARACTERS.ruby(entry.meaningTokens)
        : esc(entry.meaning || "");
    return (
      (entry.characterId && entry.targetCharacter
        ? `<small class="character-meaning-label">“${esc(entry.targetCharacter)}”的意思</small>`
        : "") + content
    );
  }
  function dictationEntry() {
    return (
      state.settings.dictationEntries?.[ui.dictation] || {
        text: words()[ui.dictation] || "",
        phonetic: "",
        meaning: "",
        language: /^[\x00-\x7f]+$/.test(words()[ui.dictation] || "")
          ? "en-GB"
          : "zh-CN",
      }
    );
  }
  async function refreshSelectedVocabulary() {
    const id = state.settings.dictationBookId,
      section = state.settings.dictationSection || "全册";
    if (
      !id ||
      ui.dictationSyncLoading ||
      ui.dictationVerifiedBook === id + ":" + section
    )
      return;
    const generation = (ui.dictationSyncGeneration =
      (ui.dictationSyncGeneration || 0) + 1);
    ui.dictationSyncLoading = true;
    try {
      const data = await api("/api/books/" + id + "/vocabulary");
      if (
        generation !== ui.dictationSyncGeneration ||
        state.settings.dictationBookId !== id ||
        (state.settings.dictationSection || "全册") !== section
      )
        return;
      const entries = data.items.filter(
        (e) => section === "全册" || e.section === section,
      );
      if (!entries.length) {
        ui.dictationVerifiedBook = id + ":" + section;
        toast("教材词表已更新，请在设置中重新选择单元。");
        return;
      }
      const before = JSON.stringify(state.settings.dictationEntries),
        after = JSON.stringify(entries),
        current = dictationEntry().text;
      if (before !== after) {
        clearDictationCharge();
        state.settings.dictationEntries = entries;
        state.settings.dictationWords = entries.map((e) => e.text).join("\n");
        state.settings.dictationVocabularyRevision = data.revision;
        ui.dictation = Math.max(
          0,
          entries.findIndex((e) => e.text === current),
        );
        ui.listenCorrect = false;
        ui.listenChoosing = false;
        ui.listenPlayed = false;
        ui.feedback = "";
        ui.answer = "";
        stopSpeech();
        persist();
      }
      ui.dictationVerifiedBook = id + ":" + section;
    } catch (error) {
      ui.dictationVerifiedBook = id + ":" + section;
      toast("暂时未能核对最新词表，可在设置中重新读取教材。");
    } finally {
      ui.dictationSyncLoading = false;
      if (route()[0] === "dictation") render();
    }
  }
  function dictationPage() {
    if (
      state.settings.dictationBookId &&
      !ui.dictationSyncLoading &&
      ui.dictationVerifiedBook !==
        state.settings.dictationBookId +
          ":" +
          (state.settings.dictationSection || "全册")
    )
      queueMicrotask(refreshSelectedVocabulary);
    const list = words();
    ui.dictation = Math.max(0, Math.min(ui.dictation, list.length - 1));
    const entry = dictationEntry(),
      sourceBook = book(state.settings.dictationBookId),
      sourceName = sourceBook
        ? `${sourceBook.title} · ${state.settings.dictationSection || "全册"}`
        : state.settings.dictationCharacterSource
          ? "生字总库 · 听词识字"
          : list.length
            ? "自定义词表"
            : "尚未选择教材词表",
      spelling = ui.dictationMode === "spelling";
    const options =
      window.BX_LEARNING?.wordChoices(
        list.map(
          (text, i) =>
            state.settings.dictationEntries?.[i] || {
              text,
              language: /^[\x00-\x7f]+$/.test(text) ? "en-GB" : "zh-CN",
            },
        ),
        ui.dictation,
      ) || [];
    return `${back("听写小站", "home")}<section class="dictation-source-card ${list.length ? "has-source" : ""}"><div><span class="pill mint">语文 · 英语</span><h2>听清楚，再认出这个词</h2><p>${esc(sourceName)}${list.length ? ` · ${list.length} 个词` : ""}</p></div><button class="primary dictation-setup block" data-action="dictation-edit">${ico("book-open")}<span>设置教材听写词语</span>${ico("chevron-right")}</button></section>
    ${
      list.length
        ? `<section class="dictation-stage listening-stage ${ui.listenCorrect ? "completed" : ""}"><div class="listening-top"><span class="pill mint">${ui.dictation + 1} / ${list.length}</span><div class="listening-modes"><button data-action="listen-mode" aria-pressed="${!spelling}">听音辨词</button><button data-action="spelling-mode" aria-pressed="${spelling}">拼写听写</button></div></div><h2>${spelling ? "听一听，试着写下来" : ui.listenCorrect ? "认出来了，再读一遍" : "先听读音，不用写字"}</h2><button class="speaker-large" data-action="dictation-play" aria-label="播放当前词语">${ico("volume-2", "large")}</button><p class="muted" id="speech-status">点击喇叭播放${entry.language.startsWith("en") ? "英语" : "普通话"}读音</p>
    ${spelling ? `<form id="dictation-form"><label class="field-label" for="dictation-input">你听到的词语</label><input id="dictation-input" value="${esc(ui.answer)}" aria-label="听写答案" placeholder="在这里写下来" autocomplete="off" required><div class="row"><button class="secondary" type="button" data-action="dictation-play">再听一遍</button><button class="primary" type="submit">检查一下</button></div></form>` : `<div class="listening-split"><button class="heard-choice" data-action="listen-heard">${ico("check")}<strong>听清楚了</strong></button><button class="repeat-choice" data-action="listen-again">${ico("rotate-ccw")}<strong>没有听清楚</strong></button></div>${ui.listenChoosing ? `<div class="listening-options" role="group" aria-label="选择听到的词语">${options.map((text) => `<button data-listen-choice="${esc(text)}" ${ui.listenCorrect ? "disabled" : ""}>${esc(text)}</button>`).join("")}</div>` : ""}`}
    ${ui.feedback ? `<div class="feedback" role="status"><p>${esc(ui.feedback)}</p>${ui.listenCorrect || spelling ? `<strong class="heard-word">${esc(entry.text)}</strong><span class="word-phonetic">${esc(entry.phonetic || "")}</span><p>${dictationMeaning(entry)}</p>` : ""}</div>${spelling || ui.listenCorrect ? `<button class="primary block" data-action="dictation-next">${ui.dictation === list.length - 1 ? "再听一轮" : "下一个词语"}</button>` : ""}` : ""}<button class="text-action" data-action="dictation-show">查看词语、读音与释义</button></section>`
        : empty(
            "先选择一本语文或英语教材",
            "按课文或单元载入词语，就可以听音辨词。",
          )
    }`;
  }
  function dictationBooks() {
    return books.filter(
      (b) =>
        b.enabled &&
        b.kind === "textbook" &&
        b.subject === ui.dSubject &&
        b.grade === ui.dGrade &&
        (!b.term || b.term === ui.dTerm),
    );
  }
  function openDictationSettings() {
    const current = book(state.settings.dictationBookId);
    ui.dSubject = current?.subject || "chinese";
    ui.dGrade = current?.grade || state.grade;
    ui.dTerm = current?.term || state.term;
    ui.dBookId = current?.id || "";
    ui.dVocabulary = null;
    ui.dError = "";
    ui.dBusy = false;
    ui.vocabGeneration = (ui.vocabGeneration || 0) + 1;
    renderDictationSettings();
  }
  function selectedVocabulary() {
    const data = ui.dVocabulary;
    return data
      ? ui.dSection === "all"
        ? data.items
        : data.items.filter((e) => e.section === ui.dSection)
      : [];
  }
  function renderDictationSettings() {
    const available = dictationBooks();
    if (!available.some((b) => b.id === ui.dBookId))
      ui.dBookId =
        available.find((b) => !b.version.includes("五四制"))?.id ||
        available[0]?.id ||
        "";
    const data = ui.dVocabulary,
      entries = selectedVocabulary();
    modal(
      "选择教材听写词表",
      `<div class="dictation-settings"><div class="dictation-select-grid"><label>学科<select id="dictation-subject"><option value="chinese" ${ui.dSubject === "chinese" ? "selected" : ""}>语文</option><option value="english" ${ui.dSubject === "english" ? "selected" : ""}>英语</option></select></label><label>年级<select id="dictation-grade">${C.GRADE_NAMES.map((n, i) => `<option value="${i + 1}" ${ui.dGrade === i + 1 ? "selected" : ""}>${n}年级</option>`).join("")}</select></label><label>册次<select id="dictation-term"><option value="1" ${ui.dTerm === 1 ? "selected" : ""}>上册</option><option value="2" ${ui.dTerm === 2 ? "selected" : ""}>下册</option></select></label></div><label class="field-label">教材 / 版本<select id="dictation-book">${available.map((b) => `<option value="${b.id}" ${b.id === ui.dBookId ? "selected" : ""}>${esc(b.title)} · ${esc(b.version)}</option>`).join("") || '<option value="">当前筛选下暂无课本</option>'}</select></label><button class="primary block" data-action="dictation-load-book" ${!ui.dBookId || ui.dBusy ? "disabled" : ""}>${ui.dBusy ? "正在读取教材词表…" : "读取这本教材的词语 / 单词表"}</button>${ui.dError ? `<p class="error-banner">${esc(ui.dError)}</p>` : ""}${data ? (data.available ? `<div class="vocabulary-summary"><strong>从教材中读取 ${data.items.length} 个词</strong><small>${esc(data.notice)}</small></div><label class="field-label">课文 / 单元<select id="dictation-section"><option value="all" ${ui.dSection === "all" ? "selected" : ""}>全册 · ${data.items.length} 个词</option>${data.groups.map((g) => `<option value="${esc(g.id)}" ${ui.dSection === g.id ? "selected" : ""}>${esc(g.title)} · ${g.count} 个词</option>`).join("")}</select></label><button class="primary block" data-action="dictation-use-book">使用${ui.dSection === "all" ? "全册" : esc(ui.dSection)} · ${entries.length} 个词开始听写</button><div class="vocabulary-list">${entries.map((e, i) => `<div class="vocabulary-row"><div><strong>${esc(e.text)}</strong>${e.phonetic ? `<span class="word-phonetic">${esc(e.phonetic)}</span>` : ""}${e.meaning ? `<small>${esc(e.meaning)}</small>` : ""}</div><div><button type="button" class="vocab-speak" data-vocab-speak="${i}" aria-label="朗读 ${esc(e.text)}">${ico("volume-2")}</button><button type="button" class="text-action" data-vocab-page="${e.sourcePage}">第${e.sourcePage}页</button></div></div>`).join("")}</div>` : `<p class="error-banner">${esc(data.notice)}</p>`) : ""}<details class="dictation-manual"><summary>手动补充或编辑词语</summary><form id="words-form"><label for="word-list">每行一个词语或短语，也可用逗号分隔。</label><textarea id="word-list" aria-label="听写词语" maxlength="6000">${esc(state.settings.dictationWords || "")}</textarea><button class="secondary block" type="submit">保存自定义词表</button></form></details></div>`,
    );
  }
  async function loadDictationVocabulary() {
    if (!ui.dBookId || ui.dBusy) return;
    const id = ui.dBookId,
      generation = ++ui.vocabGeneration;
    ui.dBusy = true;
    ui.dError = "";
    ui.dVocabulary = null;
    renderDictationSettings();
    try {
      const data = await api("/api/books/" + id + "/vocabulary");
      if (generation !== ui.vocabGeneration || ui.dBookId !== id) return;
      ui.dVocabulary = data;
      ui.dSection = data.groups[0]?.id || "all";
    } catch (error) {
      if (generation === ui.vocabGeneration) ui.dError = error.message;
    } finally {
      if (generation === ui.vocabGeneration) {
        ui.dBusy = false;
        renderDictationSettings();
      }
    }
  }
  function useDictationVocabulary() {
    clearDictationCharge();
    const entries = selectedVocabulary();
    if (!entries.length) {
      toast("请先读取并选择教材词表");
      return;
    }
    state.settings.dictationCharacterSource = false;
    state.settings.dictationEntries = entries;
    state.settings.dictationWords = entries.map((e) => e.text).join("\n");
    state.settings.dictationBookId = ui.dBookId;
    state.settings.dictationSection =
      ui.dSection === "all" ? "全册" : ui.dSection;
    ui.dictationVerifiedBook = "";
    ui.dictation = 0;
    ui.answer = "";
    ui.feedback = "";
    ui.listenCorrect = false;
    ui.listenChoosing = false;
    ui.listenPlayed = false;
    ui.speechStatus = "";
    stopSpeech();
    persist();
    closeModal();
    render();
    toast("教材词表已载入，可开始听写");
  }
  const parentArenaCache = new Map();
  const countValue = (value) =>
    Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
  const parentArenaKey = () =>
    user &&
    ["parent", "admin"].includes(user.role) &&
    (user.role !== "parent" || ui.activeChildId)
      ? user.id +
        ":" +
        user.role +
        ":" +
        (user.role === "parent" ? ui.activeChildId : user.id)
      : "";
  function arenaCounts(value = {}) {
    const correct = countValue(value?.correct),
      check = countValue(value?.check);
    return {
      ...value,
      attempted: countValue(value?.attempted),
      checked: countValue(value?.checked),
      correct,
      check,
      graded: correct + check,
      unverified: countValue(value?.unverified),
      drafts: countValue(value?.drafts),
    };
  }
  function normalizeArenaSummary(value) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value.date || "")
    )
      throw new Error("章节统计暂未准备好");
    return {
      ...value,
      date: String(value.date || ""),
      today: arenaCounts(value.today),
      total: arenaCounts(value.total),
      bySubject: Object.fromEntries(
        Object.entries(value.bySubject || {}).map(([id, row]) => [
          id,
          {
            ...arenaCounts(row),
            subjectLabel: String(row?.subjectLabel || "其他学科").slice(0, 40),
          },
        ]),
      ),
    };
  }
  function renderParentArena(key) {
    if (
      parentArenaKey() !== key ||
      !connected ||
      ui.parentStateLoading ||
      route()[0] !== "parent" ||
      !["today", "insight", ""].includes(route()[1] || "")
    )
      return;
    const field = $("#encouragement"),
      text = typeof field?.value === "string" ? field.value : null,
      focused = document.activeElement === field,
      start = field?.selectionStart,
      end = field?.selectionEnd,
      top = window.scrollY || 0;
    render();
    if (text !== null) {
      const restored = $("#encouragement");
      if (restored) {
        restored.value = text;
        if (focused) {
          restored.focus({ preventScroll: true });
          try {
            restored.setSelectionRange(start, end);
          } catch (_) {}
        }
      }
    }
    window.scrollTo?.(0, top);
  }
  async function loadParentArena(key, entry, force = false) {
    if (
      entry.pending ||
      key !== parentArenaKey() ||
      (!force && Date.now() < entry.retryAt)
    )
      return;
    entry.pending = true;
    entry.requestedDate = dateKey();
    renderParentArena(key);
    const child = user.role === "parent" ? ui.activeChildId : null;
    try {
      const result = await api(
        "/api/arena/summary" + (child ? "?childId=" + child : ""),
      );
      if (key !== parentArenaKey() || parentArenaCache.get(key) !== entry)
        return;
      entry.value = normalizeArenaSummary(result.summary);
      entry.at = Date.now();
      entry.error = "";
      entry.retryAt = 0;
    } catch (error) {
      if (key !== parentArenaKey() || parentArenaCache.get(key) !== entry)
        return;
      entry.error = "章节记录暂未同步";
      entry.retryAt = Date.now() + 15000;
      if ([401, 403].includes(error.status)) entry.value = null;
    } finally {
      entry.pending = false;
      renderParentArena(key);
    }
  }
  function parentArenaSummary() {
    const key = parentArenaKey();
    if (!key) return { value: null, error: "", pending: false };
    let entry = parentArenaCache.get(key);
    if (!entry) {
      entry = {
        value: null,
        error: "",
        pending: false,
        at: 0,
        retryAt: 0,
        requestedDate: "",
      };
      parentArenaCache.set(key, entry);
      if (parentArenaCache.size > 12)
        parentArenaCache.delete(parentArenaCache.keys().next().value);
    }
    if (
      !entry.pending &&
      (Date.now() - entry.at >= 15000 ||
        !entry.value ||
        (entry.value.date !== dateKey() &&
          entry.requestedDate !== dateKey())) &&
      Date.now() >= entry.retryAt
    )
      queueMicrotask(() => loadParentArena(key, entry));
    return entry;
  }
  function parentArenaNotice(entry) {
    const summary = entry.value,
      today = summary?.date === dateKey() ? summary.today : null;
    return `<div class="source-notice" data-parent-arena-summary><p>${entry.error ? `章节记录暂未同步${summary ? "，暂显示上次同步结果" : "，暂显示原有练习统计"}。` : !summary ? "正在同步章节作答记录…" : summary.date !== dateKey() ? "今日章节记录正在更新，暂保留原有练习统计。" : `今日章节草稿 ${today.drafts} 道 · 结果未确定 ${today.unverified} 道。草稿和未确定结果不计入答错。`}</p><button class="text-action" data-parent-summary-refresh ${entry.pending ? "disabled" : ""}>${entry.pending ? "正在同步…" : "刷新章节记录"}</button><button class="text-action" data-go="arena">章节作答记录</button></div>`;
  }
  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-parent-summary-refresh]");
    if (!button || button.disabled) return;
    const key = parentArenaKey();
    if (!key) return;
    const entry = parentArenaSummary();
    loadParentArena(key, entry, true);
  });
  function practiceReportLines() {
    const old = state.attempts.filter((a) => typeof a.correct === "boolean"),
      key = parentArenaKey(),
      entry = key && parentArenaCache.get(key),
      chapter = entry?.value?.total;
    return `原有练习：已核对 ${old.length} 次，答对 ${old.filter((a) => a.correct).length} 次（按作答记录）\n${chapter ? `章节练习：已核对 ${chapter.graded} 道，答对 ${chapter.correct} 道（每题当前状态去重）\n章节草稿 ${chapter.drafts} 道，结果未确定 ${chapter.unverified} 道；不计入答错。${entry.error ? "\n章节统计暂未同步，本报告使用上次同步结果。" : ""}` : "章节练习记录尚未同步，请先刷新家长概览。"}`;
  }
  function parentLoading() {
    return `${parentHeader("正在读取当前宝宝的学习记录")}${ui.parentStateError ? `<div class="error-banner" role="alert">${esc(ui.parentStateError)}<button class="secondary" data-parent-state-retry>重新读取宝宝记录</button></div>` : '<p class="source-notice" role="status">正在同步这位宝宝的教材、作答和章节记录…</p>'}`;
  }
  function parentHeader(text) {
    return `<div class="between parent-top"><h1>${text}</h1><span class="pill blue">家长中心</span></div><button class="child-select-bar block" data-action="grade"><span class="row">${img("brand/child-avatar", "avatar-small", "学习头像")}<span><strong>${esc(state.childName)}小朋友</strong><small>${gradeName(state.grade)} · ${state.term === 1 ? "上册" : "下册"}</small></span></span>${ico("chevron-down")}</button>${user.role === "parent" && family.children.length > 1 ? `<label class="parent-child-picker">当前宝宝<select id="parent-child" aria-label="切换宝宝">${family.children.map((c) => `<option value="${c.id}" ${c.id === ui.activeChildId ? "selected" : ""}>${esc(c.child_name)}小朋友</option>`).join("")}</select></label>` : ""}`;
  }
  function parentToday() {
    if (ui.parentStateLoading || ui.parentStateError) return parentLoading();
    const chapter = parentArenaSummary(),
      current =
        chapter.value?.date === dateKey() ? chapter.value.today : arenaCounts(),
      d = day(),
      attempts = state.attempts.filter(
        (a) =>
          dateKey(new Date(a.at)) === dateKey() &&
          typeof a.correct === "boolean",
      );
    const dates = Array.from({ length: 7 }, (_, i) => {
      const date = new Date(dateKey() + "T12:00:00+08:00");
      date.setDate(date.getDate() - 6 + i);
      const key = dateKey(date);
      return {
        key,
        minutes: Math.round((state.daily[key]?.seconds || 0) / 60),
      };
    });
    return `${parentHeader("今天的学习，轻轻看一眼")}<h2 class="report-headline">今天留下了 <em>${d.pages.length}</em> 页阅读记录。</h2><div class="parent-summary"><div class="metric-tile"><strong>${Math.round(d.seconds / 60)}<small>min</small></strong><span>活跃学习</span></div><div class="metric-tile"><strong>${d.questions}<small>次</small></strong><span>主动提问</span></div><div class="metric-tile"><strong>${attempts.filter((a) => a.correct).length + current.correct}/${attempts.length + current.graded}</strong><span>今日答对 / 已核对</span></div></div>${parentArenaNotice(chapter)}<div class="parent-report-layout"><section><details class="parent-quote"><summary>给孩子写一句鼓励</summary><div class="parent-encouragement-body"><form id="encouragement-form"><textarea id="encouragement" aria-label="给孩子的鼓励" maxlength="500" placeholder="今天哪个发现让你开心？我想听你讲一讲。">${esc(state.parentMessage)}</textarea><button class="primary" type="submit">保存到孩子首页</button></form></div></details><div class="between section-title"><h2>最近阅读</h2></div>${
      Object.entries(state.reading)
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, 12)
        .map(([id, r]) => {
          const b = book(id);
          return b
            ? `<button class="parent-list-row block" data-read="${id}">${ico("book-open")}<div>${esc(bookTitle(b))}<small>读到第 ${r.page} 页 · ${new Date(r.at).toLocaleString("zh-CN")}</small></div>${ico("chevron-right")}</button>`
            : "";
        })
        .join("") || '<p class="muted">暂无阅读记录。</p>'
    }<button class="parent-export block" data-action="data-export">${ico("download")}导出完整学习记录</button><button class="parent-export block" data-action="report-export">${ico("download")}保存学习报告</button></section><aside><section class="parent-chart"><h3>最近七天的学习节奏</h3><div class="bar-chart">${dates.map((d) => `<div class="bar-col"><span class="bar-value">${d.minutes}</span><div class="bar-fill" style="height:${d.minutes ? Math.min(d.minutes * 3 + 5, 110) : 3}px"></div><span class="bar-labels">${d.key.slice(5)}</span></div>`).join("")}</div></section><div class="care-note"><div><h3>记录来自实际操作</h3><p>活跃计时统计学习页可见且最近有操作的时间，不把长时间挂机算作学习。</p></div></div></aside></div>`;
  }
  function parentInsight() {
    if (ui.parentStateLoading || ui.parentStateError) return parentLoading();
    const chapter = parentArenaSummary(),
      subjects = {
        ...C.SUBJECTS,
        ...(chapter.value?.bySubject?.other
          ? { other: { name: "其他学科" } }
          : {}),
      },
      rows = Object.entries(subjects).map(([id, subject]) => {
        const old = state.attempts.filter(
            (a) =>
              book(a.book)?.subject === id && typeof a.correct === "boolean",
          ),
          current = arenaCounts(chapter.value?.bySubject?.[id]),
          correct = old.filter((a) => a.correct).length + current.correct,
          count = old.length + current.graded;
        return {
          id,
          ...subject,
          count,
          correct,
          rate: count ? Math.round((correct / count) * 100) : null,
          drafts: current.drafts,
          unverified: current.unverified,
        };
      });
    return `${parentHeader("看见思路，比盯着分数更有用")}${title("真实练习情况", "合并原有练习已判定作答和章节题当前有效核对结果。只反映已核对题目，不能代表全部知识掌握程度。")}${parentArenaNotice(chapter)}<section class="mastery-list">${rows.map((row) => `<div class="mastery-row"><span>${esc(row.name)}</span>${progress(row.rate || 0)}<span>${row.rate === null ? "待观察" : row.rate + "%"}</span><small>${row.correct} / ${row.count} 题答对 · 章节草稿 ${row.drafts} 道 · 结果未确定 ${row.unverified} 道</small></div>`).join("")}</section><p class="source-notice">原有练习按作答记录统计；章节练习按每题当前状态统计。同一题修改作答后会重新核对，草稿和未确定结果不计入正确率。</p><div class="between section-title"><h2>还值得陪着想的问题</h2><button class="text-action" data-go="review">打开错题本</button></div>${
      state.mistakes
        .filter((m) => !m.resolved)
        .map(
          (m) =>
            `<div class="detail-kp"><h3>${esc(m.question.q)}</h3><p>${esc(m.question.why)}</p><button class="text-action" data-read="${m.book}" data-read-page="${m.page}">回到教材第 ${m.page} 页</button></div>`,
        )
        .join("") ||
      empty("暂时没有待巩固问题", "继续阅读和练习，记录会自动更新。")
    }<details class="section-title"><summary>原有练习作答记录（${state.attempts.length}）</summary>${state.attempts
      .slice(-100)
      .reverse()
      .map(
        (a) =>
          `<p>${a.correct ? "✓" : "○"} ${esc(a.question)} · 第 ${a.page} 页 · ${new Date(a.at).toLocaleString("zh-CN")}</p>`,
      )
      .join("")}</details>`;
  }
  function parentBooks() {
    return `${parentHeader("学校用哪本，这里就选哪本")}${title("各学科独立选择教材", "选项只包含已提供、当前年级与册次对应的课本。")}<section class="settings-section">${Object.entries(
      C.SUBJECTS,
    )
      .map(([id, s]) => {
        const available = books.filter(
          (b) =>
            b.enabled &&
            b.subject === id &&
            b.grade === state.grade &&
            b.term === state.term &&
            b.kind === "textbook",
        );
        return `<div class="version-setting"><img src="assets/books/${id}.svg" alt="${s.name}封面标识"><div><h3>${s.name}</h3><small>${gradeName(state.grade)} · ${state.term === 1 ? "上册" : "下册"}</small></div><select data-parent-book="${id}" aria-label="选择${s.name}教材" ${!available.length ? "disabled" : ""}><option value="">${available.length ? "请选择教材" : "暂缺对应课本"}</option>${available.map((b) => `<option value="${b.id}" ${state.pins[id] === b.id ? "selected" : ""}>${esc(b.version + " · " + b.title)}</option>`).join("")}</select></div>`;
      })
      .join(
        "",
      )}<div class="settings-row"><strong>学习册次</strong><select id="parent-term" aria-label="学习册次"><option value="1" ${state.term === 1 ? "selected" : ""}>上册</option><option value="2" ${state.term === 2 ? "selected" : ""}>下册</option></select></div></section><button class="primary block" data-go="parent/answers">${ico("book-open", "small")}查看教材参考答案</button><button class="parent-export block" data-go="parent/library">查看全部教材</button>${user.role === "admin" ? '<button class="parent-export block" data-go="admin/coverage">检查教材版本覆盖与缺口</button>' : ""}`;
  }
  function toggle(key, text, detail) {
    return `<div class="settings-row"><div class="settings-label"><strong>${text}</strong><small>${detail}</small></div><button class="switch ${state.settings[key] ? "on" : ""}" role="switch" aria-checked="${!!state.settings[key]}" aria-label="${text}" data-toggle="${key}"><span></span></button></div>`;
  }
  function parentSettings() {
    return `${parentHeader("按孩子的节奏，安排陪伴")}<section class="settings-section"><div class="settings-row"><label class="settings-label" for="child-name"><strong>小朋友的名字</strong><small>显示在孩子首页，最多 30 字</small></label><input id="child-name" aria-label="小朋友名字" maxlength="30" value="${esc(state.childName)}"></div></section><section class="settings-section"><div class="settings-row"><div class="settings-label"><strong>每日学习目标</strong><small>达到目标时提醒活动眼睛</small></div><div class="settings-controls"><input id="time-limit" type="range" min="10" max="60" step="5" value="${state.settings.limit}" aria-label="每日学习目标分钟"><strong id="limit-label">${state.settings.limit} 分钟</strong></div></div><div class="settings-row"><div class="settings-label"><strong>晚间休息时间</strong><small>到点提醒，不强制锁定学习</small></div><input id="bedtime" type="time" aria-label="晚间休息时间" value="${state.settings.bedtime}"></div>${toggle("hints", "先引导，再看思路", "首次讲解先给线索，再逐步分析")}${toggle("reminders", "温柔的休息提醒", "学习目标和休息时间到点提醒")}${toggle("sound", "学习声音", "允许使用设备语音朗读")}</section><div class="care-note"><div><h3>学习记录与 AI 服务</h3><p>学习记录由平台保存，当前设备保留临时副本。主动使用 AI 时，相关问题、图片或当前教材页会发送至配置的 AI 服务。</p></div></div><button class="parent-export block" data-action="data-export">导出学习记录</button><label class="parent-export block file-label">导入备份记录（合并保留已有记录）<input id="data-import" type="file" accept="application/json,.json" hidden></label>${user.role === "admin" ? '<button class="text-action block" data-go="admin/books">进入管理员</button>' : ""}`;
  }
  function coverage() {
    const versions = [
      ...new Set(books.map((b) => b.subject + "|" + b.version)),
    ].sort();
    return `${title("各年级教材覆盖", "课本和答案分别计数。缺少原文件不能冒充完整教材。")}<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>学科 / 版本</th>${[1, 2, 3, 4, 5, 6].map((g) => `<th>${gradeName(g)}</th>`).join("")}</tr></thead><tbody>${versions
      .map((key) => {
        const [s, v] = key.split("|");
        return `<tr><td>${esc((C.SUBJECTS[s]?.name || "其他") + " / " + v)}</td>${[
          1, 2, 3, 4, 5, 6,
        ]
          .map(
            (g) =>
              `<td>${[1, 2]
                .map((t) => {
                  const set = books.filter(
                      (b) =>
                        b.enabled &&
                        b.subject === s &&
                        b.version === v &&
                        b.grade === g &&
                        b.term === t,
                    ),
                    count = set.filter((b) => b.kind === "textbook").length,
                    answers = set.filter((b) => b.kind === "answers").length;
                  return `<div class="coverage-cell ${count ? "ready" : "missing"}">${t === 1 ? "上" : "下"}：${count ? "课本 " + count + " 份" : "缺课本"}${answers ? " · 答案 " + answers : ""}</div>`;
                })
                .join("")}</td>`,
          )
          .join("")}</tr>`;
      })
      .join(
        "",
      )}</tbody></table></div><p class="source-notice">一年级起点、三年级起点、五四制与六三制按不同版本保留。无法确定的分类需管理员核对。</p>`;
  }
  function modelHealthPanel() {
    const records = ["text", "vision"].flatMap((kind) =>
      Object.entries(ui.modelHealth?.[kind] || {}).map(([model, value]) => ({
        kind,
        model,
        ...value,
      })),
    );
    return `<section class="settings-section model-health-panel"><h3>自动选择可用模型</h3><p class="muted">按文字与识图分别统计近期成功率，失败后自动换用其他模型。最近失败的模型会暂时避开。</p><div class="model-health-summary">${[
      "text",
      "vision",
    ]
      .map((kind) => {
        const group = records.filter((r) => r.kind === kind),
          ready = group.filter(
            (r) =>
              r.cooldown_until <= Date.now() / 1000 && r.recent?.some(Boolean),
          );
        return `<div><strong>${ready.length}</strong><span>${kind === "text" ? "文字" : "识图"}可用模型</span></div>`;
      })
      .join(
        "",
      )}</div><details><summary>查看近期检测记录</summary>${records.length ? `<table class="model-health-table"><thead><tr><th>用途 / 模型</th><th>近期成功</th><th>状态</th></tr></thead><tbody>${records.map((r) => `<tr><td>${r.kind === "text" ? "文字" : "识图"} · ${esc(r.model)}</td><td>${(r.recent || []).filter(Boolean).length}/${r.recent?.length || 0}</td><td>${r.cooldown_until > Date.now() / 1000 ? "暂缓调用" : "可参与选择"}</td></tr>`).join("")}</tbody></table>` : '<p class="muted">首次真实调用后会自动记录结果。</p>'}</details></section>`;
  }
  function adminPage() {
    const tab = route()[1] || "overview";
    if (tab === "membership" && window.BX_VIP) return window.BX_VIP.adminPage();
    if (tab === "questions")
      return window.BX_ARENA_REVIEW.page({
        api,
        esc,
        modal,
        modalClose: closeModal,
        route,
        render,
        toast,
        user: () => user,
      });
    if (tab === "notifications") return window.BX_NOTICES?.adminPage() || "";
    if (tab === "overview") return adminOverview();
    if (tab === "users") return adminUsers();
    if (tab === "cleaning") return cleaningPage();
    if (tab === "coverage") return coverage();
    if (tab === "ai" && window.BX_AI_ADMIN)
      return window.BX_AI_ADMIN.page({
        api,
        esc,
        toast,
        user: () => user,
        render,
        route,
      });
    if (tab === "ai")
      return `${title("AI 服务管理", "密钥仅保存在服务器配置，不会返回浏览器。")}<section class="settings-section"><div class="settings-row"><strong>配置状态</strong><span class="pill mint">${health.configured ? "已配置" : "未配置"}</span></div><div class="settings-row"><strong>当前模型</strong><span>${esc(health.model || "未选择")}</span></div><div class="settings-row"><button class="primary" data-action="check-ai" ${ui.modelsLoading ? "disabled" : ""}>${ui.modelsLoading ? "正在检测…" : "检测接口与可用模型"}</button></div>${ui.models.length ? `<div class="settings-row"><label for="ai-model">选择模型</label><select id="ai-model">${ui.models.map((m) => `<option ${health.model === m ? "selected" : ""}>${esc(m)}</option>`).join("")}</select></div>` : ""}<div class="settings-row"><button class="secondary" data-action="test-ai" ${ui.busy ? "disabled" : ""}>${ui.busy ? "正在测试…" : "发送一条测试问题"}</button></div></section>${ui.testReply ? `<div class="detail-kp"><h3>实际测试结果</h3><p>${esc(ui.testReply)}</p></div>` : ""}${modelHealthPanel()}<div class="between section-title"><h2>最近调用记录</h2></div><div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>时间</th><th>功能</th><th>模型</th><th>状态</th></tr></thead><tbody>${(ui.calls || []).map((c) => `<tr><td>${new Date(c.at * 1000).toLocaleString("zh-CN")}</td><td>${esc(c.kind)}</td><td>${esc(c.model)}</td><td>${c.ok ? "成功" : "失败"}</td></tr>`).join("")}</tbody></table></div>`;
    return adminBooks();
  }
  function adminBooks() {
    const filtered = books.filter(
      (b) =>
        (ui.adminStatus === "all" ||
          (ui.adminStatus === "on" ? b.enabled : !b.enabled)) &&
        (!ui.adminSearch ||
          `${b.title} ${b.version} ${b.source}`
            .toLowerCase()
            .includes(ui.adminSearch.toLowerCase())),
    );
    const pageSize = 4;
    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
    const page = Math.min(ui.resourcePage || 0, pageCount - 1);
    const visibleBooks = filtered.slice(page * pageSize, (page + 1) * pageSize);
    const stats = [
      [books.length, "资料总数"],
      [books.filter((b) => b.kind === "textbook").length, "课本"],
      [books.filter((b) => b.kind === "answers").length, "习题与答案"],
      [issues.length, "读取异常"],
    ];
    return `
      ${title("教材与资料管理", "文件放入「教材」目录后重新扫描。")}
      <div class="admin-summary">
        ${stats.map(([value, label]) => `<div><strong>${value}</strong><small>${label}</small></div>`).join("")}
      </div>
      <div class="admin-tools">
        <input id="admin-search" type="search" value="${esc(ui.adminSearch)}" placeholder="搜索教材" aria-label="按名称、版本或路径搜索教材">
        <select id="admin-status" aria-label="资料状态">
          <option value="all">全部状态</option>
          <option value="on" ${ui.adminStatus === "on" ? "selected" : ""}>已上架</option>
          <option value="off" ${ui.adminStatus === "off" ? "selected" : ""}>已下架</option>
        </select>
        <button class="primary" data-action="rescan">重新扫描教材</button>
      </div>
      ${ui.materialPacks?.length ? `
        <details class="admin-scan-issues admin-material-packs">
          <summary>已整理的 Markdown / PDF（${ui.materialPacks.length}）</summary>
          <ul>${ui.materialPacks.map(item => `<li><strong>${esc(item.title)}</strong>
            <small>${esc(item.kind)} · ${item.count} 项 · ${item.reviewed} 项已核对</small>
            <a class="text-action" href="/api/admin/material-packs/${esc(item.id)}/pdf" target="_blank" rel="noopener">预览 PDF</a>
            <a class="text-action" href="/api/admin/material-packs/${esc(item.id)}/bundle">下载 Markdown、图片和索引</a></li>`).join("")}</ul>
        </details>` : ""}
      ${issues.length ? `
        <details class="admin-scan-issues">
          <summary>查看 ${issues.length} 条扫描异常</summary>
          <ul>${issues.map((issue) => `<li>${esc(issue.title)}：${esc(issue.error)}</li>`).join("")}</ul>
        </details>` : ""}
      ${visibleBooks.length ? `
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead><tr><th>资料</th><th>分类</th><th>年级 / 册次</th><th>操作</th></tr></thead>
            <tbody>${visibleBooks.map(adminBookRow).join("")}</tbody>
          </table>
        </div>` : empty("没有匹配资料", "换个关键词或状态筛选。")}
      <p class="source-notice">教材分类、上架状态与清理规则会对所有学习账号生效。</p>
      <nav class="admin-book-pager" aria-label="教材分页">
        <button type="button" data-resource-page="${page - 1}" aria-label="上一页" title="上一页" ${page === 0 ? "disabled" : ""}>${ico("chevron-left")}</button>
        <span role="status">${page + 1} / ${pageCount} · ${filtered.length} 份</span>
        <button type="button" data-resource-page="${page + 1}" aria-label="下一页" title="下一页" ${page + 1 === pageCount ? "disabled" : ""}>${ico("chevron-right")}</button>
      </nav>`;
  }
  function adminBookRow(book) {
    return `<tr>
      <td><strong>${esc(book.title)}</strong><small title="${esc(book.source)}">${esc(book.source)}</small></td>
      <td>${subject(book).name} · ${esc(book.version)}
        <small>${book.kind === "answers" ? "习题 / 答案" : "课本"} · ${book.format.toUpperCase()} · ${(book.size / 1024 / 1024).toFixed(1)} MB</small></td>
      <td>${gradeName(book.grade)}<small>${book.term === 1 ? "上册" : book.term === 2 ? "下册" : "待核对"}</small></td>
      <td><div class="table-actions">
        <button class="text-action" data-edit-book="${book.id}">编辑分类</button>
        <button class="text-action" data-enable-book="${book.id}">${book.enabled ? "下架" : "上架"}</button>
        ${book.enabled ? `
          <button class="text-action" data-read="${book.id}">阅读</button>
          <button class="text-action" data-go="admin/cleaning/${book.id}/1">清理推广</button>` : ""}
      </div></td>
    </tr>`;
  }
  function modal(text, body) {
    modalReturn = document.activeElement;
    $("#modal-root").innerHTML =
      `<div class="modal-backdrop" data-action="close-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-head"><h2 id="modal-title">${esc(text)}</h2><button class="round-action" data-action="close-modal" aria-label="关闭">${ico("x")}</button></div>${body}</section></div>`;
    $("#app").inert = true;
    $("#modal-root input,#modal-root textarea,#modal-root button")?.focus();
  }
  function closeModal() {
    ui.vocabGeneration = (ui.vocabGeneration || 0) + 1;
    $("#modal-root").innerHTML = "";
    $("#app").inert = false;
    if (modalReturn?.isConnected) modalReturn.focus();
    modalReturn = null;
  }
  function gradeModal() {
    modal(
      "选择年级与册次",
      `<div class="grade-grid">${C.GRADE_NAMES.map((n, i) => `<button data-modal-grade="${i + 1}" class="${state.grade === i + 1 ? "active" : ""}">${n}年级</button>`).join("")}</div><div class="modal-row"><span>当前册次</span><div class="term-switch">${[1, 2].map((n) => `<button data-modal-term="${n}" class="${state.term === n ? "active" : ""}">${n === 1 ? "上册" : "下册"}</button>`).join("")}</div></div><button class="primary block" data-action="grade-finish">完成</button>`,
    );
  }
  function setGrade(g, t = state.term) {
    clearDictationCharge();
    state.grade = Math.max(1, Math.min(6, Number(g) || 3));
    state.term = Number(t) === 2 ? 2 : 1;
    ui.version = "all";
    ui.allGrades = false;
    ui.dictation = 0;
    ui.answer = "";
    ui.feedback = "";
    ui.listenCorrect = false;
    ui.listenChoosing = false;
    ui.listenPlayed = false;
    ui.speechStatus = "";
    stopSpeech();
    for (const [s, id] of Object.entries(state.pins)) {
      const b = book(id);
      if (b && (b.grade !== state.grade || b.term !== state.term))
        delete state.pins[s];
    }
    persist();
  }
  async function pageChange(page) {
    const id = route()[1],
      meta = metadata.get(id),
      current = Number(route()[2]) || 1;
    if (!meta || !Number.isInteger(page) || page < 1 || page > meta.pageCount) {
      toast("页码超出教材范围");
      return;
    }
    if (page === current) return;
    const token = ++readerTurnToken,
      scope = location.hash;
    const word =
      meta.pageFormats?.[page - 1] === "docx" || book(id)?.format === "docx";
    if (!word && window.BX_LEARNING?.pageCache) {
      const status = $("#reader-page-status"),
        url = readerImageUrl(id, page);
      if (!window.BX_LEARNING.pageCache.get(url) && status)
        status.textContent = "正在准备下一页…";
      try {
        if (!(await window.BX_LEARNING.pageCache.prepare(url)))
          throw new Error("页面尚未准备好");
      } catch (_) {
        if (token === readerTurnToken && location.hash === scope) {
          if (status) status.textContent = "页面未加载成功，请检查网络后重试。";
        }
        return;
      }
      if (token !== readerTurnToken || location.hash !== scope) return;
    }
    ui.readerDirection = page > current ? 1 : -1;
    ui.readerTurning = true;
    markReading(id, page);
    go("reader/" + id + "/" + page);
  }
  function editBook(id) {
    const b = book(id);
    if (!b) return;
    modal(
      "编辑资料分类",
      `<form id="book-edit-form" data-id="${id}" class="edit-book-form"><label>名称<input name="title" required maxlength="200" value="${esc(b.title)}"></label><label>学科<select name="subject">${[...Object.entries(C.SUBJECTS).map(([id, s]) => [id, s.name]), ["other", "其他"]].map(([id, n]) => `<option value="${id}" ${b.subject === id ? "selected" : ""}>${n}</option>`).join("")}</select></label><label>年级<select name="grade">${[0, 1, 2, 3, 4, 5, 6].map((g) => `<option value="${g}" ${b.grade === g ? "selected" : ""}>${gradeName(g)}</option>`).join("")}</select></label><label>册次<select name="term">${[
        [0, "待核对"],
        [1, "上册"],
        [2, "下册"],
      ]
        .map(
          ([t, n]) =>
            `<option value="${t}" ${b.term === t ? "selected" : ""}>${n}</option>`,
        )
        .join(
          "",
        )}</select></label><label>版本（区分起点与学制）<input name="version" required maxlength="200" value="${esc(b.version)}"></label><label>资料类型<select name="kind"><option value="textbook" ${b.kind === "textbook" ? "selected" : ""}>课本</option><option value="answers" ${b.kind === "answers" ? "selected" : ""}>习题与答案</option></select></label><button class="primary block" type="submit">保存分类</button></form>`,
    );
  }
  function download(data, mime, name) {
    const url = URL.createObjectURL(new Blob([data], { type: mime })),
      a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  let sharedSpeech = null;
  function speechStatus(text) {
    ui.speechStatus = text;
    for (const label of document.querySelectorAll(
      "#speech-status,.character-audio-status",
    ))
      label.textContent = text;
    const button = $(".speaker-large");
    button?.classList?.toggle("audio-loading", text === "正在准备读音…");
    button?.setAttribute?.(
      "aria-busy",
      text === "正在准备读音…" ? "true" : "false",
    );
  }
  function speech() {
    return (sharedSpeech ||= window.BX_AUDIO.create({
      owner: () => user?.id,
      status: speechStatus,
      heard: (value) => {
        ui.listenPlayed = value;
      },
      enabled: () => state.settings.sound,
    }));
  }
  function stopSpeech() {
    sharedSpeech?.stop();
    ui.listenPlayed = false;
  }
  function say(text, language, recording) {
    if (!text) {
      toast("请先选择教材词表");
      return;
    }
    try {
      speech().play(
        text,
        language || (/^[\x00-\x7f]+$/.test(text) ? "en-GB" : "zh-CN"),
        recording,
      );
    } catch (error) {
      speechStatus(error.message);
    }
  }
  function clearDictationCharge() {
    try {
      if (ui.dictationChargeOwner)
        sessionStorage.removeItem?.(
          "bx-dictation-charge-v2:" + ui.dictationChargeOwner,
        );
    } catch (_) {}
    ui.dictationChargeKey = "";
    ui.dictationCharged = false;
  }
  async function chargeDictation() {
    const owner = String(user?.id || "") + ":" + String(ui.activeChildId || "");
    if (ui.dictationChargeOwner !== owner) {
      clearDictationCharge();
      ui.dictationChargeOwner = owner;
    }
    if (user?.role === "admin") return true;
    const entry = dictationEntry(),
      language =
        entry.language ||
        (/^[\x00-\x7f]+$/.test(entry.text || "") ? "en-GB" : "zh-CN");
    if (!entry.text) throw new Error("请先选择听写词语");
    if (!ui.dictationChargeKey) {
      let saved;
      try {
        saved = JSON.parse(
          sessionStorage.getItem?.("bx-dictation-charge-v2:" + owner) || "null",
        );
      } catch (_) {}
      ui.dictationChargeKey =
        saved?.index === ui.dictation &&
        saved?.text === entry.text &&
        saved?.language === language &&
        saved?.key
          ? saved.key
          : globalThis.crypto?.randomUUID?.() ||
            Date.now().toString(36) + "_" + Math.random().toString(36).slice(2);
      try {
        sessionStorage.setItem(
          "bx-dictation-charge-v2:" + owner,
          JSON.stringify({
            index: ui.dictation,
            text: entry.text,
            language,
            key: ui.dictationChargeKey,
          }),
        );
      } catch (_) {}
    }
    if (ui.dictationChargePending) return false;
    ui.dictationChargePending = true;
    const requestId = ui.dictationChargeKey;
    try {
      const result = await api("/api/membership/dictation", {
        requestId,
        text: entry.text,
        language,
        childId: ui.activeChildId || null,
      });
      if (
        owner !==
          String(user?.id || "") + ":" + String(ui.activeChildId || "") ||
        requestId !== ui.dictationChargeKey
      )
        return false;
      window.BX_VIP?.update(result);
      ui.dictationCharged = true;
      return true;
    } finally {
      ui.dictationChargePending = false;
    }
  }
  function sayDictation() {
    const owner = String(user?.id || "") + ":" + String(ui.activeChildId || "");
    if (ui.dictationChargeOwner !== owner) {
      clearDictationCharge();
      ui.dictationChargeOwner = owner;
    }
    const entry = dictationEntry();
    if (!state.settings.sound) {
      speechStatus("学习声音已关闭，可在设置中开启");
      return;
    }
    const recording =
        entry.audio || (entry.characterId ? { required: true } : undefined),
      language =
        entry.language ||
        (/^[\x00-\x7f]+$/.test(entry.text || "") ? "en-GB" : "zh-CN");
    try {
      if (recording && !window.BX_AUDIO.validRecording(recording, language)) {
        speechStatus("这段读音还在核对，准备好后就可以听啦");
        return;
      }
    } catch (error) {
      speechStatus(error.message);
      return;
    }
    const play = () => say(entry.text, language, recording);
    if (user?.role === "admin" || ui.dictationCharged) {
      play();
      return;
    }
    return chargeDictation()
      .then((ok) => {
        if (ok) play();
      })
      .catch((error) => toast(error.message));
  }
  async function startCharacterDictation(entry) {
    clearDictationCharge();
    if (
      !entry?.characterId ||
      !entry.contentRevision ||
      entry.language !== "zh-CN"
    )
      throw new Error("生字词语尚未核对好");
    const previous =
        state.settings.dictationCharacterSource &&
        Array.isArray(state.settings.dictationEntries)
          ? state.settings.dictationEntries.filter(
              (v) => v?.characterId && v.language === "zh-CN",
            )
          : [],
      entries = [
        entry,
        ...previous.filter(
          (v) =>
            v.characterId !== entry.characterId ||
            v.readingIndex !== entry.readingIndex,
        ),
      ].slice(0, 100);
    state.settings.dictationEntries = entries;
    state.settings.dictationWords = entries.map((v) => v.text).join("\n");
    state.settings.dictationBookId = "";
    state.settings.dictationSection = "生字总库";
    state.settings.dictationCharacterSource = true;
    ui.dictation = 0;
    ui.dictationMode = "listen";
    ui.answer = "";
    ui.feedback = "";
    ui.listenCorrect = false;
    ui.listenChoosing = false;
    ui.speechStatus = "";
    stopSpeech();
    persist();
    go("dictation");
  }
  window.addEventListener("hashchange", stopSpeech);

  function captureChatView() {
    const log = $("#chat-messages");
    if (document.body.dataset.view !== "ai" || !log) return null;
    const input = document.activeElement;
    return {
      id: ui.renderedChatId,
      top: log.scrollTop,
      bottom: log.scrollHeight - log.scrollTop - log.clientHeight < 90,
      focused: ["chat-input", "study-chat-input"].includes(input?.id),
      inputId: input?.id,
      start: input?.selectionStart,
      end: input?.selectionEnd,
    };
  }
  function restoreChatView(saved) {
    if (route()[0] !== "ai") return;
    const log = $("#chat-messages");
    if (log) {
      const same = saved?.id === ui.chatId,
        stored = window.BX_STUDY?.position();
      log.scrollTop = ui.forceChatBottom
        ? log.scrollHeight
        : same
          ? saved.bottom
            ? log.scrollHeight
            : saved.top
          : stored && !stored.following
            ? stored.top
            : log.scrollHeight;
      ui.forceChatBottom = false;
      ui.renderedChatId = ui.chatId;
      log.addEventListener?.(
        "scroll",
        () => {
          ui.chatFollowing =
            log.scrollHeight - log.scrollTop - log.clientHeight < 90;
        },
        { passive: true },
      );
    }
    if (saved?.focused) {
      const input = $("#" + (saved.inputId || "chat-input"));
      input?.focus({ preventScroll: true });
      try {
        input?.setSelectionRange(saved.start, saved.end);
      } catch (_) {}
    }
  }
  function resizeChatViewport() {
    const viewport = window.visualViewport;
    document.documentElement?.style?.setProperty(
      "--learning-vh",
      (viewport && viewport.scale === 1
        ? viewport.height
        : window.innerHeight) + "px",
    );
    document.documentElement?.style?.setProperty(
      "--learning-bottom",
      (viewport && viewport.scale === 1
        ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
        : 0) + "px",
    );
    if (route()[0] === "ai" && ui.chatFollowing) {
      const log = $("#chat-messages");
      if (log) log.scrollTop = log.scrollHeight;
    }
  }
  window.visualViewport?.addEventListener("resize", resizeChatViewport);
  window.addEventListener("resize", resizeChatViewport);
  resizeChatViewport();

  async function refreshAdmin() {
    try {
      const [data, analytics, accounts, materialPacks] = await Promise.all([
        api("/api/admin"),
        api("/api/admin/analytics"),
        api("/api/admin/users"),
        api("/api/admin/material-packs"),
      ]);
      ui.calls = data.calls;
      ui.modelHealth = data.modelHealth || {};
      ui.analytics = analytics;
      ui.users = accounts.users;
      ui.resetRequests = accounts.requests;
      ui.materialPacks = materialPacks.items;
      ui.adminLoaded = true;
      if (route()[0] === "admin") render();
    } catch (error) {
      toast(error.message);
    }
  }

  async function scanFile(file) {
    if (window.BX_STUDY) return window.BX_STUDY.upload(file, ui.scanMode);
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
      throw new Error("请选择 JPG、PNG 或 WebP 图片");
    if (file.size > 10 * 1024 * 1024)
      throw new Error("图片超过 10 MB，请换一张更小的");
    const generation = (ui.scanGeneration = (ui.scanGeneration || 0) + 1);
    ui.scanReading = true;
    render();
    try {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("读取图片失败"));
        reader.readAsDataURL(file);
      });
      if (generation !== ui.scanGeneration) return;
      if (ui.scanUrl) URL.revokeObjectURL(ui.scanUrl);
      ui.scanUrl = URL.createObjectURL(file);
      ui.scanData = data;
      ui.scanImageId = "";
      ui.scanText = "";
    } finally {
      if (generation === ui.scanGeneration) {
        ui.scanReading = false;
        render();
      }
    }
  }
  async function ensureScanImage() {
    if (ui.scanReading) throw new Error("正在读取新图片，请稍等");
    const generation = ui.scanGeneration;
    if (ui.scanImageId) return ui.scanImageId;
    const data = ui.scanData;
    if (!data) throw new Error("请先选择题目图片");
    const result = await api("/api/scan-image", { image: data });
    if (ui.scanData !== data || ui.scanGeneration !== generation)
      throw new Error("图片已更换，请再次确认新图片");
    ui.scanImageId = result.imageId;
    return result.imageId;
  }
  async function restoreChatImage() {
    if (ui.chatId !== "scan" || !ui.chatImageId) return;
    try {
      const saved = await api(
        "/api/scan-image?id=" + encodeURIComponent(ui.chatImageId),
      );
      ui.chatImage = saved.image;
    } catch (_) {
      ui.chatImage = "";
      ui.chatImageId = "";
      ui.aiError = "原图已失效，请重新上传题目图片";
    }
  }

  const actions = {
    library: () => go("library"),
    grade: gradeModal,
    "grade-finish": () => {
      closeModal();
      render();
    },
    "close-modal": closeModal,
    "close-backdrop": closeModal,

    "clear-search": () => {
      ui.search = "";
      ui.subject = "all";
      ui.version = "all";
      ui.kind = "all";
      ui.allGrades = true;
      render();
    },

    homework: () => {
      ui.scanMode = "homework";
      go("scan");
    },

    "page-bookmark": () => {
      const id = route()[1],
        r = state.reading[id] || { page: ui.page };
      r.bookmarks ||= [];
      r.bookmarks = r.bookmarks.includes(ui.page)
        ? r.bookmarks.filter((n) => n !== ui.page)
        : [...r.bookmarks, ui.page].sort((a, b) => a - b);
      state.reading[id] = r;
      persist();
      render();
    },

    "page-note": () => {
      const key = route()[1] + ":" + ui.page;
      modal(
        "第 " + ui.page + " 页 · 我的笔记",
        `<form id="note-form" data-key="${key}"><textarea id="note-input" aria-label="本页笔记" maxlength="6000" placeholder="今天我发现……">${esc(state.notes[key] || "")}</textarea><button class="primary block" type="submit">保存笔记</button></form>`,
      );
    },

    "ask-page": () => {
      const b = book(route()[1]);
      if (ui.busy) return;
      setChat(b, ui.page, bookTitle(b) + "；文件第 " + ui.page + " 页");
      go("ai");
    },

    "explain-page": () => {
      const b = book(route()[1]);
      if (ui.busy) return;
      setChat(b, ui.page, bookTitle(b) + "；文件第 " + ui.page + " 页");
      go("ai");
      sendChat(
        state.settings.hints
          ? "请先指出这一页的核心知识，给我一个思考提示，再逐步讲解。"
          : "请清楚讲解这一页的实际内容，用适合我年级的例子帮助我理解。",
      );
    },

    "submit-answer": submitAnswer,
    "next-question": nextQuestion,

    "web-menu": () => window.BX_SITE_NAV?.open(),
    "free-chat": () => {
      if (ui.busy) {
        toast("请等待当前回答，或重新开始对话");
        return;
      }
      setChat(null);
      if (window.BX_STUDY) window.BX_STUDY.fresh();
      else go("ai");
    },

    "chat-reset": () => {
      chatAbort?.abort();
      chatGeneration++;
      ui.busy = false;
      state.conversations[ui.chatId] = [];
      ui.aiError = "";
      ui.draft = "";
      persist();
      render();
    },

    "retry-chat": () => sendChat(ui.lastPrompt || "", true),

    upload: () => {
      $("#image-input").removeAttribute("capture");
      $("#image-input").click();
    },

    camera: () => {
      $("#image-input").setAttribute("capture", "environment");
      $("#image-input").click();
    },

    ocr: async () => {
      if (!ui.scanData || ui.scanBusy || ui.scanReading) return;
      const generation = ui.scanGeneration;
      ui.scanBusy = true;
      render();
      try {
        const imageId = await ensureScanImage();
        const data = await api("/api/ocr", {
          imageId,
          context: gradeName(state.grade),
        });
        if (generation === ui.scanGeneration && imageId === ui.scanImageId)
          ui.scanText = data.reply;
      } catch (error) {
        toast(error.message);
      } finally {
        ui.scanBusy = false;
        render();
      }
    },

    "scan-confirm": async () => {
      if (!ui.scanData) {
        toast("请先选择题目图片");
        return;
      }
      if (ui.busy || ui.scanBusy || ui.scanReading) {
        toast("请等待当前处理完成");
        return;
      }
      ui.scanBusy = true;
      render();
      try {
        const imageId = await ensureScanImage();
        const text = ui.scanText.trim();
        setChat(
          null,
          1,
          gradeName(state.grade) +
            "；" +
            (ui.scanMode === "homework" ? "检查作业思路" : "图片题目"),
          ui.scanData,
          imageId,
        );
        state.conversations.scan = [];
        go("ai");
        sendChat(
          ui.scanMode === "homework"
            ? "请检查图片中的题目、学生答案与解题步骤，指出具体错误并给出正确答案。看不清的内容请明确指出。" +
                (text ? "已核对题目文字：" + text : "")
            : text ||
                "请先读出图片中的题目，再分步骤讲解并检查答案。看不清的内容请明确指出，不要猜测。",
        );
      } catch (error) {
        toast(error.message);
      } finally {
        ui.scanBusy = false;
        render();
      }
    },

    "dictation-play": () => say(words()[ui.dictation]),
    "dictation-next": () => {
      stopSpeech();
      clearDictationCharge();
      ui.dictation = (ui.dictation + 1) % words().length;
      ui.answer = "";
      ui.feedback = "";
      ui.listenChoosing = false;
      ui.listenCorrect = false;
      ui.listenPlayed = false;
      ui.speechStatus = "";
      render();
    },

    "dictation-show": () =>
      modal(
        "看词记忆",
        `<p class="memory-word">${esc(words()[ui.dictation])}</p><p>认真看一眼，关掉窗口后写下来。</p>`,
      ),

    "dictation-edit": () =>
      modal(
        "使用教材里的词语",
        `<form id="words-form"><label for="word-list">用逗号或换行分开，每个词不超过 20 字。</label><textarea id="word-list" aria-label="听写词语" maxlength="2000">${esc(state.settings.dictationWords || "")}</textarea><button class="primary block" type="submit">保存词表</button></form>`,
      ),

    "data-export": () =>
      download(
        JSON.stringify(
          {
            format: "banxuezhua-v4",
            exportedAt: new Date().toISOString(),
            state,
          },
          null,
          2,
        ),
        "application/json",
        "伴学爪-学习记录-" + dateKey() + ".json",
      ),

    "report-export": () => {
      const rows = Object.entries(state.reading)
        .map(([id, r]) =>
          book(id) ? bookTitle(book(id)) + " · 第 " + r.page + " 页" : "",
        )
        .filter(Boolean);
      download(
        `伴学爪学习报告\n导出日期：${dateKey()}\n累计活跃学习：${minutes()} 分钟\n${practiceReportLines()}\n待复习：${state.mistakes.filter((m) => !m.resolved).length} 道\n\n阅读记录\n${rows.join("\n")}\n\n家长留言：${state.parentMessage}`,
        "text/plain;charset=utf-8",
        "伴学爪-学习报告-" + dateKey() + ".txt",
      );
    },

    "notes-list": () => {
      const entries = Object.entries(state.notes).filter(([, v]) => v);
      modal(
        "我的学习笔记",
        entries.length
          ? entries
              .map(([key, text]) => {
                const [id, page] = key.split(":");
                return `<div class="detail-kp"><button class="text-action" data-read="${id}" data-read-page="${page}">${esc(book(id)?.title || "已移除教材")} · 第 ${page} 页</button><p>${esc(text)}</p></div>`;
              })
              .join("")
          : "<p>打开教材，在阅读器中记录第一份发现。</p>",
      );
    },

    rescan: async () => {
      toast("正在扫描教材文件…");
      const data = await api("/api/admin/rescan", {});
      books = data.books;
      issues = data.issues;
      metadata.clear();
      render();
      toast("已扫描 " + books.length + " 份资料");
    },

    "check-ai": async () => {
      if (ui.modelsLoading) return;
      ui.modelsLoading = true;
      render();
      try {
        const data = await api("/api/admin/models", {});
        ui.models = data.models;
        toast(
          "已加载 " +
            ui.models.length +
            " 个候选模型，实际调用时自动选择可用项",
        );
      } finally {
        ui.modelsLoading = false;
        render();
      }
    },

    "test-ai": async () => {
      if (ui.busy) return;
      ui.busy = true;
      render();
      try {
        const data = await api("/api/chat", {
          prompt: "请用一句简短中文确认你能帮助小学生理解教材。",
          context: "管理员接口测试",
        });
        ui.testReply = data.reply;
        toast("AI 实际对话测试成功");
      } catch (error) {
        ui.testReply = error.message;
        throw error;
      } finally {
        ui.busy = false;
        await refreshAdmin();
        render();
      }
    },
  };

  function parentReport() {
    return `<div class="between"><h1>${route()[2] === "questions" ? "孩子提问" : "孩子的学习报告"}</h1><button class="text-action" data-go="parent/today">孩子概览</button></div>${window.BX_PARENT_INSIGHTS?.page({ api, esc, user: () => user, childId: () => ui.activeChildId, render, focus: route()[2] === "questions" ? "questions" : "" }) || parentInsight()}`;
  }
  function render() {
    window.BX_MEDIA?.setScope(user ? stateStorageKey() + ":" + user.role : "");
    if (!user || route()[0] !== "reader") {
      readerTurnToken++;
      window.BX_LEARNING?.leaveReader();
    }
    const savedLessonView = window.BX_ARENA_LEARNING?.capture();
    const savedChatView = captureChatView();
    if (!user) {
      renderAuth();
      return;
    }
    if (
      user.role === "parent" &&
      ![
        "parent",
        "profile",
        "family",
        "reader",
        "arena",
        "ai",
        "scan",
        "vip",
      ].includes(route()[0])
    ) {
      go("parent/today");
      return;
    }
    const r = route();
    document.body.dataset.view = r[0];
    document.body.dataset.textSize = ["small", "standard", "large"].includes(
      state.settings.fontSize,
    )
      ? state.settings.fontSize
      : "small";
    document.body.dataset.adminTab = r[1] || "overview";
    if (r[0] === "admin" && user.role !== "admin") {
      $("#app").innerHTML = shell(
        empty(
          "需要管理员权限",
          "请使用管理员账号登录。",
          button("个人中心", "open-profile"),
        ),
        "权限提示",
      );
      return;
    }
    const pages = {
      home: [home, "今日学习"],
      learn: [
        () =>
          window.BX_PERSONAL?.page({
            api,
            esc,
            grade: () => state.grade,
            user: () => user,
            route,
            render,
            go,
            toast,
          }) || "",
        "一起学",
      ],
      library: [library, "教材书库"],
      reader: [reader, "教材阅读"],
      ai: [aiPage, "问问爪爪"],
      practice: [practicePage, "教材练习"],
      review: [reviewPage, "错题复习"],
      growth: [growthPage, "我的成长"],
      profile: [profilePage, "个人中心"],
      vip: [
        () =>
          window.BX_VIP?.page() ||
          empty("会员服务暂不可用", "请刷新页面重试。"),
        "爪爪会员",
      ],
      family: [familyPage, "家庭绑定"],
      chinese: [
        () =>
          window.BX_CHINESE.page({
            api,
            esc,
            user: () => user,
            route,
            render,
            modal,
            close: closeModal,
            go,
            ico,
            play: say,
            stopAudio: stopSpeech,
            startDictation: startCharacterDictation,
            toast,
          }),
        "语文乐园",
      ],
      leaderboard: [
        () => window.BX_COMMUNITY.page({ api, esc, user: () => user, render }),
        "爪爪排行榜",
      ],
      scan: [scanPage, "拍题答疑"],
      dictation: [
        () => window.BX_VIP?.gate("dictation") || dictationPage(),
        "听写小站",
      ],
      arena: [
        () =>
          window.BX_VIP?.gate("arena") ||
          window.BX_ARENA?.page(route()) ||
          empty("练习模块暂未打开", "请刷新页面重试。"),
        "爪爪竞技场",
      ],
    };
    let content, name;
    if (r[0] === "admin") {
      content = adminPage();
      name = "管理员";
      if (!ui.adminLoaded) queueMicrotask(refreshAdmin);
    } else if (r[0] === "parent" && user.role === "child") {
      content = familyPage();
      name = "家庭绑定";
    } else if (
      r[0] === "parent" &&
      user.role === "parent" &&
      !ui.activeChildId
    ) {
      content = familyPage();
      name = "家庭绑定";
    } else if (r[0] === "parent") {
      const p = {
        today: parentToday,
        insight: () => parentReport(),
        report: () => parentReport(),
        books: parentBooks,
        answers: () => library(true),
        library: () => library(),
        settings: parentSettings,
      };
      content = (p[r[1]] || parentToday)();
      name = "家长中心";
    } else {
      const p = pages[r[0]] || pages.home;
      content = p[0]();
      name = p[1];
    }
    document.title = name + " · 伴学爪";
    $("#app").innerHTML = shell(content, name);
    window.BX_LIQUID_NAV?.mount();
    window.BX_NOTICES?.sync();
    window.BX_CHAT?.typeset(document.querySelectorAll?.(".chat-rich") || []);
    restoreChatView(savedChatView);
    window.BX_ARENA_LEARNING?.restore(savedLessonView);
    const pageImage = $("#textbook-page");
    if (!window.BX_MEDIA)
      pageImage?.addEventListener(
        "error",
        () => {
          const error = document.createElement("p");
          error.className = "error-banner";
          error.textContent = "本页未能打开，请刷新重试。";
          pageImage.replaceWith(error);
        },
        { once: true },
      );
    if (pageImage && r[0] === "reader") {
      const id = r[1],
        meta = metadata.get(id),
        page = Number(r[2]) || 1,
        clean = state.settings.cleanReading;
      const prefetch = () => {
        if (
          route()[0] !== "reader" ||
          route()[1] !== id ||
          (Number(route()[2]) || 1) !== page ||
          state.settings.cleanReading !== clean
        )
          return;
        const candidates = [page + 1, page - 1, page + 2].filter(
          (n) =>
            n >= 1 &&
            n <= meta.pageCount &&
            meta.pageFormats?.[n - 1] !== "docx",
        );
        window.BX_LEARNING?.prefetchPages(
          candidates.map((n) => readerImageUrl(id, n)),
        );
      };
      if (pageImage.complete && pageImage.naturalWidth)
        queueMicrotask(prefetch);
      else pageImage.addEventListener("load", prefetch, { once: true });
    }
  }
  document.addEventListener("click", (event) => {
    lastActive = Date.now();
    const el = event.target.closest("button,a,[data-action]");
    if (!el || el.disabled) return;
    if (el.classList.contains("skip-link")) {
      event.preventDefault();
      $("#main")?.focus();
      return;
    }
    if (el.dataset.action === "close-backdrop" && event.target !== el) return;
    const d = el.dataset;
    const run = async () => {
      if (d.go) {
        if (d.go === "ai" && route()[0] !== "ai" && !ui.busy) setChat(null);
        if (d.go === "scan") ui.scanMode = "question";
        go(d.go);
        return;
      }
      if (d.action) {
        await actions[d.action]?.();
        return;
      }
      if (d.read) {
        openBook(d.read, Number(d.readPage) || undefined);
        return;
      }
      if (d.subject) {
        ui.subject = d.subject;
        ui.version = "all";
        ui.search = "";
        if (route()[0] === "library") render();
        else go("library");
        return;
      }
      if (d.grade) {
        setGrade(d.grade);
        render();
        return;
      }
      if (d.modalGrade) {
        setGrade(d.modalGrade);
        render();
        gradeModal();
        return;
      }
      if (d.modalTerm) {
        setGrade(state.grade, d.modalTerm);
        render();
        gradeModal();
        return;
      }
      if (d.term) {
        setGrade(state.grade, d.term);
        render();
        return;
      }
      if (d.allGrades) {
        ui.allGrades = true;
        render();
        return;
      }
      if (d.kind) {
        ui.kind = d.kind;
        render();
        return;
      }
      if (d.page !== undefined) {
        pageChange(Number(d.page));
        return;
      }
      if (d.zoom) {
        ui.zoom = Math.min(220, Math.max(60, ui.zoom + Number(d.zoom)));
        render();
        return;
      }
      if (d.pin) {
        const b = book(d.pin);
        state.pins[b.subject] = b.id;
        state.grade = b.grade || state.grade;
        state.term = b.term || state.term;
        persist();
        render();
        toast("已放入首页书架");
        return;
      }
      if (d.answer !== undefined) {
        const p = ui.practice;
        if (p && !p.submitted && !p.done) {
          p.selected = Number(d.answer);
          savePractice();
          render();
        }
        return;
      }
      if (d.review) {
        const m = state.mistakes.find((m) => m.id === d.review);
        if (m) {
          ui.practice = {
            id: Date.now().toString(36),
            book: m.book,
            page: m.page,
            questions: [m.question],
            index: 0,
            selected: null,
            submitted: false,
            correct: 0,
            done: false,
            reviewId: m.id,
          };
          savePractice();
          go("practice");
        }
        return;
      }
      if (d.reviewFilter) {
        ui.filter = d.reviewFilter;
        render();
        return;
      }
      if (d.prompt) {
        await sendChat(d.prompt);
        return;
      }
      if (d.badge) {
        modal(
          d.badge,
          `<p>${esc(d.badgeDetail)}${el.classList.contains("locked") ? "，完成后即可点亮。" : "，你已经做到了。"}</p>`,
        );
        return;
      }
      if (d.toggle) {
        if (["hints", "reminders", "sound"].includes(d.toggle)) {
          state.settings[d.toggle] = !state.settings[d.toggle];
          persist();
          render();
          toast("设置已保存");
        }
        return;
      }
      if (d.editBook) {
        editBook(d.editBook);
        return;
      }
      if (d.resourcePage !== undefined) {
        ui.resourcePage = Math.max(0, Number(d.resourcePage));
        render();
        return;
      }
      if (d.enableBook) {
        const b = book(d.enableBook);
        await api("/api/admin/book", { id: b.id, enabled: !b.enabled });
        b.enabled = !b.enabled;
        render();
        toast(b.enabled ? "资料已上架" : "资料已下架，原文件保留");
      }
    };
    run().catch((error) => toast(error.message));
  });
  document.addEventListener("input", (event) => {
    lastActive = Date.now();
    const el = event.target;
    if (el.id === "captcha-answer") {
      el.value = el.value
        .normalize("NFKC")
        .replace(/[^0-9]/g, "")
        .slice(0, 4);
      return;
    }
    if (el.id === "book-search" || el.id === "admin-search") {
      const start = el.selectionStart,
        end = el.selectionEnd;
      if (el.id === "book-search") ui.search = el.value;
      else {
        ui.adminSearch = el.value;
        ui.resourcePage = 0;
      }
      render();
      const next = $("#" + el.id);
      next.focus();
      try {
        next.setSelectionRange(start, end);
      } catch (_) {}
      return;
    }
    if (el.id === "chat-input") ui.draft = el.value;
    if (el.id === "scan-text") ui.scanText = el.value;
    if (el.id === "dictation-input") ui.answer = el.value;
    if (el.id === "time-limit") {
      state.settings.limit = Number(el.value);
      $("#limit-label").textContent = el.value + " 分钟";
      persist();
    }
  });
  function importState(incoming) {
    const next = normalize(incoming);
    state.notes = { ...next.notes, ...state.notes };
    for (const [id, r] of Object.entries(next.reading))
      if (!state.reading[id] || r.at > state.reading[id].at)
        state.reading[id] = r;
    state.mistakes = Array.from(
      new Map(
        [...next.mistakes, ...state.mistakes]
          .filter((m) => m?.id && m.question && Array.isArray(m.question.o))
          .map((m) => [m.id, m]),
      ).values(),
    );
    state.attempts = Array.from(
      new Map(
        [...next.attempts, ...state.attempts].map((a) => [
          JSON.stringify(a),
          a,
        ]),
      ).values(),
    );
    state.questionEvents = Array.from(
      new Map(
        [...next.questionEvents, ...state.questionEvents].map((e) => [
          e.at + ":" + e.text,
          e,
        ]),
      ).values(),
    );
    state.completed = [...new Set([...next.completed, ...state.completed])];
    for (const [date, d] of Object.entries(next.daily)) {
      if (!state.daily[date]) state.daily[date] = d;
      else {
        state.daily[date].seconds = Math.max(
          state.daily[date].seconds || 0,
          d.seconds || 0,
        );
        state.daily[date].pages = [
          ...new Set([...(state.daily[date].pages || []), ...(d.pages || [])]),
        ];
        state.daily[date].questions = Math.max(
          state.daily[date].questions || 0,
          d.questions || 0,
        );
      }
    }
    state.points = Math.max(state.points, next.points);
    persist();
  }
  document.addEventListener("change", (event) => {
    const el = event.target;
    const run = async () => {
      if (
        el.id === "profile-font-size" &&
        ["small", "standard", "large"].includes(el.value)
      ) {
        state.settings.fontSize = el.value;
        persist();
        render();
      }
      if (el.id === "library-version") {
        ui.version = el.value;
        render();
      }
      if (el.id === "admin-status") {
        ui.adminStatus = el.value;
        ui.resourcePage = 0;
        render();
      }
      if (el.id === "parent-term") {
        setGrade(state.grade, Number(el.value));
        render();
      }
      if (el.id === "child-name") {
        const result = await api("/api/profile/name", { child_name: el.value });
        if (user.role !== "parent") state.childName = result.child_name;
        user.child_name = result.child_name;
        persist();
        toast("小朋友名字已保存");
      }
      if (el.id === "bedtime" && el.value) {
        state.settings.bedtime = el.value;
        persist();
        toast("休息时间已保存");
      }
      if (el.dataset.parentBook) {
        if (el.value) state.pins[el.dataset.parentBook] = el.value;
        else delete state.pins[el.dataset.parentBook];
        persist();
        toast("该学科教材已保存");
      }
      if (el.id === "image-input") {
        await scanFile(el.files[0]);
        el.value = "";
      }
      if (el.id === "ai-model") {
        await api("/api/admin/model", { model: el.value });
        health.model = el.value;
        toast("模型已切换");
      }
      if (el.id === "data-import") {
        const f = el.files[0];
        if (!f) return;
        if (f.size > 3 * 1024 * 1024) throw new Error("备份超过 3 MB");
        const data = JSON.parse(await f.text());
        if (data.format !== "banxuezhua-v4" || !data.state)
          throw new Error("不是伴学爪 v4 备份");
        ui.restoreToken = Date.now();
        importState(data.state);
        render();
        toast("备份已合并，已有笔记与记录保留");
      }
    };
    run().catch((error) => toast(error.message));
  });
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (
      ![
        "page-form",
        "chat-form",
        "note-form",
        "dictation-form",
        "words-form",
        "encouragement-form",
        "book-edit-form",
      ].includes(form.id)
    )
      return;
    event.preventDefault();
    lastActive = Date.now();
    const run = async () => {
      if (form.id === "page-form") {
        pageChange(Number($("#page-number").value));
        return;
      }
      if (form.id === "chat-form") {
        await sendChat($("#chat-input").value);
        return;
      }
      if (form.id === "note-form") {
        state.notes[form.dataset.key] = $("#note-input").value.trim();
        persist();
        closeModal();
        render();
        toast("笔记已保存");
        return;
      }
      if (form.id === "dictation-form") {
        if (!ui.dictationCharged && user.role !== "admin")
          throw new Error("请先播放当前词语");
        const answer = $("#dictation-input").value.trim();
        if (!answer) return;
        ui.answer = answer;
        ui.feedback = matchesDictationAnswer(answer, dictationEntry())
          ? "写对了！再读一遍，加深印象。"
          : `刚才听到的是“${words()[ui.dictation]}”。看看容易混淆的字。`;
        day().dictation++;
        persist();
        render();
        return;
      }
      if (form.id === "words-form") {
        clearDictationCharge();
        const list = $("#word-list")
          .value.split(/[\n,，、;；]+/)
          .map((w) => w.trim())
          .filter(Boolean);
        if (!list.length) throw new Error("请至少填写一个词语");
        if (list.some((w) => w.length > 20))
          throw new Error("每个词最多 20 字");
        state.settings.dictationWords = list.join("\n");
        state.settings.dictationEntries = list.map((text) => ({
          text,
          phonetic: "",
          meaning: "",
          language: /^[\x00-\x7f]+$/.test(text) ? "en-GB" : "zh-CN",
        }));
        delete state.settings.dictationBookId;
        state.settings.dictationCharacterSource = false;
        state.settings.dictationSection = "自定义";
        ui.dictation = 0;
        ui.answer = "";
        ui.feedback = "";
        ui.listenCorrect = false;
        ui.listenChoosing = false;
        ui.listenPlayed = false;
        ui.speechStatus = "";
        stopSpeech();
        persist();
        closeModal();
        render();
        toast("教材词表已保存");
        return;
      }
      if (form.id === "encouragement-form") {
        state.parentMessage = $("#encouragement").value.trim();
        persist();
        toast("鼓励已保存到孩子首页");
        return;
      }
      if (form.id === "book-edit-form") {
        const data = Object.fromEntries(new FormData(form));
        data.id = form.dataset.id;
        data.grade = Number(data.grade);
        data.term = Number(data.term);
        await api("/api/admin/book", data);
        Object.assign(book(data.id), data);
        closeModal();
        render();
        toast("资料分类已保存");
      }
    };
    run().catch((error) => toast(error.message));
  });
  document.addEventListener("keydown", (event) => {
    lastActive = Date.now();
    const dlg = $('#modal-root [role="dialog"]');
    if (!dlg) return;
    if (event.key === "Escape") {
      closeModal();
      return;
    }
    if (event.key === "Tab") {
      const items = Array.from(
          dlg.querySelectorAll("button,input,textarea,select,a[href]"),
        ).filter((x) => !x.disabled),
        first = items[0],
        last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  window.addEventListener("hashchange", () => {
    stopSpeech();
    closeModal();
    ui.error = "";
    if (route()[0] === "reader") {
      const id = route()[1],
        meta = metadata.get(id);
      if (meta)
        markReading(
          id,
          Math.max(1, Math.min(meta.pageCount, Number(route()[2]) || 1)),
        );
    }
    render();
    if (route()[0] === "reader" && ui.readerTurning) {
      ui.readerTurning = false;
      document
        .querySelector(".ebook-toolbar")
        ?.scrollIntoView?.({ block: "start", behavior: "instant" });
    } else if (route()[0] === "arena" && route()[1] === "question")
      window.BX_ARENA_LEARNING?.restore(null);
    else window.scrollTo(0, 0);
  });
  document.addEventListener("visibilitychange", () => {
    lastTick = Date.now();
    if (document.visibilityState === "hidden") sync();
  });
  setInterval(() => {
    const now = Date.now(),
      seconds = Math.min(16, Math.max(0, (now - lastTick) / 1000));
    lastTick = now;
    if (
      !user ||
      user.role === "parent" ||
      document.visibilityState !== "visible" ||
      now - lastActive > 60000 ||
      !["reader", "ai", "practice", "dictation"].includes(route()[0])
    )
      return;
    const d = day();
    d.seconds += seconds;
    persist();
    if (state.settings.reminders) {
      const clock = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Asia/Shanghai",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date());
      if (d.seconds >= state.settings.limit * 60 && !d.goalReminded) {
        d.goalReminded = true;
        toast("今天学习目标已达到，眺望远处、休息一下眼睛吧");
      }
      if (clock >= state.settings.bedtime && !d.bedtimeReminded) {
        d.bedtimeReminded = true;
        toast("到了设定的休息时间，可以收好教材准备休息啦");
      }
    }
  }, 15000);
  async function loadApplication() {
    const loadId = ++applicationLoadGeneration,
      loadActor = user?.id,
      loadRole = user?.role;
    try {
      ui.parentStateLoading = loadRole === "parent";
      ui.parentStateError = "";
      connected = false;
      conflict = false;
      dirty = false;
      metadata.clear();
      ui.adminLoaded = false;
      state = defaults();
      revision = 0;
      if (
        loadRole === "parent" &&
        family.children.some((c) => c.id === ui.activeChildId)
      ) {
        state.childName = family.children.find(
          (c) => c.id === ui.activeChildId,
        ).child_name;
        render();
      }
      const currentFamily = await api("/api/family");
      if (
        loadId !== applicationLoadGeneration ||
        user?.id !== loadActor ||
        user?.role !== loadRole
      )
        return;
      family = currentFamily;
      if (user.role === "parent") {
        ui.activeChildId = family.children.some(
          (c) => c.id === Number(ui.activeChildId),
        )
          ? Number(ui.activeChildId)
          : family.children[0]?.id;
        if (!ui.activeChildId) {
          ui.parentStateLoading = false;
          state = defaults();
          render();
          return;
        }
      }
      const loadChildId = ui.activeChildId;
      if (loadRole === "parent") {
        state.childName =
          family.children.find((c) => c.id === loadChildId)?.child_name ||
          user.child_name;
        render();
      }
      const [catalog, saved, status] = await Promise.all([
        api("/api/library?admin=1"),
        api(
          "/api/state" +
            (loadRole === "parent" ? "?childId=" + loadChildId : ""),
        ),
        api("/api/health"),
      ]);
      if (
        loadId !== applicationLoadGeneration ||
        user?.id !== loadActor ||
        user?.role !== loadRole ||
        (loadRole === "parent" && ui.activeChildId !== loadChildId)
      )
        return;
      ui.restrictedBooks = new Set([
        ...(catalog.restrictedBookIds || []),
        ...catalog.books.filter((b) => b.kind === "answers").map((b) => b.id),
      ]);
      books = catalog.books.filter(
        (b) => user.role !== "child" || b.kind !== "answers",
      );
      issues = catalog.issues;
      health = status;
      revision = saved.revision;
      state = normalize(saved.state);
      state.materialRevision =
        catalog.materialRevision || state.materialRevision || "";
      ui.cacheRecoveryBlocked = false;
      try {
        const local = JSON.parse(
          localStorage.getItem(stateStorageKey()) || "null",
        );
        if (local?.dirty && local.revision === revision) {
          state = normalize(local.state);
          dirty = true;
          if (local.restore) ui.restoreToken = Date.now();
        } else if (local?.dirty && local.revision !== revision) {
          const kept = keepRecovery(local);
          ui.cacheRecoveryBlocked = !kept;
          toast(
            kept
              ? "旧的未同步副本已单独保留，可在个人中心下载恢复备份。"
              : "本机空间不足，旧副本暂不能单独备份，请先导出后再继续学习。",
          );
        }
      } catch (_) {}
      if (user.role === "child") {
        for (const k of Object.keys(state.conversations))
          if (/^[a-f0-9]{20}:/.test(k) && !book(k.split(":")[0]))
            delete state.conversations[k];
      }
      state.childName = saved.owner?.child_name || user.child_name;
      connected = true;
      if (dirty) syncTimer = setTimeout(sync, 350);
      ui.chatId = "free";
      ui.chatBook = null;
      ui.chatImage = "";
      ui.chatImageId = "";
      ui.practice = null;
      try {
        const p = JSON.parse(
          sessionStorage.getItem("banxuezhua-practice-" + user.id) || "null",
        );
        if (p?.questions?.length && book(p.book)) {
          const b = book(p.book);
          if (b?.contentRevision && p.materialRevision !== b.contentRevision) {
            p.page = mapBookPage(p.book, p.page);
            if (p.reviewId) {
              const parts = p.reviewId.split(":");
              if (parts[0] === p.book) {
                parts[1] = mapBookPage(p.book, parts[1]);
                p.reviewId = parts.join(":");
              }
            }
            p.materialRevision = b.contentRevision;
          }
          ui.practice = p;
        }
        const context = JSON.parse(
          sessionStorage.getItem("banxuezhua-chat-context-" + user.id) ||
            "null",
        );
        if (context && route()[0] === "ai") {
          const b = book(context.chatBook);
          if (
            b?.contentRevision &&
            context.materialRevision !== b.contentRevision
          ) {
            context.chatPage = mapBookPage(b.id, context.chatPage);
            context.chatId = b.id + ":" + context.chatPage;
            context.chatContext = (context.chatContext || "").replace(
              /文件第\s*\d+\s*页/,
              "文件第 " + context.chatPage + " 页",
            );
            context.materialRevision = b.contentRevision;
          }
          if (!context.chatBook || b) Object.assign(ui, context);
        }
      } catch (_) {}
      await restoreChatImage();
      if (
        loadId !== applicationLoadGeneration ||
        user?.id !== loadActor ||
        user?.role !== loadRole ||
        (loadRole === "parent" && ui.activeChildId !== loadChildId)
      )
        return;
      ui.parentStateLoading = false;
      if (
        user.role === "parent" &&
        ![
          "parent",
          "profile",
          "family",
          "reader",
          "arena",
          "ai",
          "scan",
          "vip",
        ].includes(route()[0])
      ) {
        go("parent/today");
        return;
      }
      if (
        route()[0] === "login" ||
        route()[0] === "register" ||
        route()[0] === "forgot"
      )
        location.hash = "#/home";
      else render();
    } catch (error) {
      if (
        loadId !== applicationLoadGeneration ||
        user?.id !== loadActor ||
        user?.role !== loadRole
      )
        return;
      if (loadRole === "parent") {
        ui.parentStateLoading = false;
        ui.parentStateError = "当前宝宝的学习记录尚未同步，请重新读取。";
        render();
      }
      throw error;
    }
  }
  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-parent-state-retry]");
    if (!button || button.disabled || user?.role !== "parent") return;
    button.disabled = true;
    loadApplication()
      .catch((error) => toast(error.message))
      .finally(() => (button.disabled = false));
  });
  async function start() {
    $("#app").innerHTML =
      '<main class="page">' +
      empty("正在打开伴学爪", "连接账号与学习记录…") +
      "</main>";
    try {
      const auth = await api("/api/auth/status");
      user = auth.user;
      ui.emailAvailable = !!auth.emailAvailable;
      ui.registrationMode = auth.registrationMode || (ui.emailAvailable ? "email" : "paused");
      if (!user) {
        renderAuth();
        return;
      }
      await loadApplication();
    } catch (error) {
      $("#app").innerHTML =
        '<main class="page">' +
        empty("学习服务暂未连接", "请检查网络连接后刷新重试。") +
        `<div class="error-banner">${esc(error.message)}</div></main>`;
    }
  }
  function setAuthMessage(text, state = "error") {
    ui.authMessage = text;
    ui.authMessageState = text ? state : "";
    const message = $("#auth-feedback");
    if (message) {
      message.textContent = text;
      message.dataset.state = ui.authMessageState;
    }
  }
  function loginFieldError(username, password) {
    if (!username) return ["username", "请输入用户名。"];
    if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) {
      return ["username", "用户名需为 3 到 32 位字母、数字或下划线。"];
    }
    if (!password) return ["password", "请输入密码。"];
    if (password.length < 8 || password.length > 128) {
      return ["password", "密码需为 8 到 128 个字符。"];
    }
    return null;
  }
  function captchaExpired() {
    return ui.captcha && performance.now() >= ui.captcha.expiresAt;
  }
  const expiredCaptchaMessage = "图片验证码已过期。请填写新验证码，再验证账号和密码。";
  async function newCaptcha(reason = "") {
    const form = $("#auth-form");
    if (!form) return false;
    const generation = (ui.captchaGeneration = (ui.captchaGeneration || 0) + 1);
    const startedAt = performance.now();
    const status = form.querySelector("#captcha-feedback");
    status.textContent = reason;
    status.dataset.state = "info";
    ui.captchaLoading = true;
    ui.captcha = null;
    form.elements.captchaId.value = "";
    form.elements.captcha.value = "";
    syncAuthButton();
    try {
      const data = await api("/api/captcha", undefined, { cache: "no-store" });
      if (generation !== ui.captchaGeneration || !form.isConnected) return false;
      const image = form.querySelector("#captcha-image");
      image.src = data.image;
      if (typeof image.decode === "function") await image.decode();
      if (generation !== ui.captchaGeneration || !form.isConnected) return false;
      ui.captcha = { ...data, expiresAt: startedAt + data.expiresIn * 1000 };
      form.elements.captchaId.value = data.id;
      return true;
    } catch {
      if (generation === ui.captchaGeneration && form.isConnected) {
        status.textContent = "图片验证码加载失败，请点击图片重试。";
        status.dataset.state = "error";
      }
      return false;
    } finally {
      if (generation === ui.captchaGeneration) {
        ui.captchaLoading = false;
        syncAuthButton();
      }
    }
  }
  function syncAuthButton() {
    const form = $("#auth-form");
    if (!form) return;
    const button = form.querySelector("button[type=submit]");
    const mode = ui.authMode || "login";
    form.elements.captcha.readOnly = !ui.captcha;
    form.querySelector('[data-account-action="captcha"]').disabled = !!(ui.authBusy || ui.captchaLoading);
    button.disabled = !!(ui.authBusy || ui.captchaLoading || !ui.captcha);
    button.textContent = ui.authBusy
      ? mode === "register"
        ? "正在注册…"
        : mode === "forgot"
          ? "正在提交…"
          : "正在登录…"
      : ui.captchaLoading
        ? "正在准备验证码…"
        : mode === "register"
          ? "注册宝宝账号"
          : mode === "forgot"
            ? "提交重置申请"
            : "登录";
    document.querySelectorAll?.("[data-auth-mode]").forEach((el) => {
      el.disabled = !!ui.authBusy;
    });
  }
  function renderAuth() {
    window.BX_MEDIA?.setScope("");
    window.BX_LIQUID_NAV?.destroy();
    document.body.classList.remove(
      "has-liquid-navigation",
      "liquid-focus-lesson",
    );
    readerTurnToken++;
    window.BX_LEARNING?.leaveReader();
    document.body.dataset.view = "auth";
    document.body.classList.remove("parent-mode");
    const mode = ui.authMode || "login",
      register = mode === "register",
      forgot = mode === "forgot";
    window.BX_NOTICES?.sync();
    const emailModes = { "email-register":"register", "email-register-parent":"register-parent", "email-reset":"reset" };
    if (emailModes[mode] && window.BX_EMAIL_AUTH) {
      document.title = "邮箱验证 · 伴学爪";
      $("#app").innerHTML = window.BX_EMAIL_AUTH.page(emailModes[mode], emailModes[mode] === "reset" ? ui.authUsername || "" : "", ui.emailAvailable, ui.registrationMode);
      window.BX_EMAIL_AUTH.mount();
      return;
    }
    document.title =
      (register ? "注册" : forgot ? "重置密码" : "登录") + " · 伴学爪";
    $("#app").innerHTML =
      `<main class="auth-page"><section class="auth-welcome">${img("brand/paw-mascot", "", "爪爪")}<h1>伴学爪</h1><p>把好奇，读成自己的发现。</p></section><section class="auth-card"><div class="auth-brand">${img("brand/paw-logo")}<strong>伴学爪</strong></div><h1>${register ? "欢迎新的小朋友" : forgot ? "联系管理员重置密码" : "欢迎回来"}</h1><p class="muted">${register ? "默认创建宝宝账号。登录后可在个人中心注册并绑定家长账号。" : forgot ? "提交申请后，请联系管理员核实并领取临时密码。" : "登录后继续你的学习与发现。"}</p><form id="auth-form" class="account-form" ${mode === "login" ? "novalidate" : ""}><label>用户名<input name="username" value="${esc(ui.authUsername || "")}" autocomplete="username" minlength="3" maxlength="32" pattern="[A-Za-z0-9_]{3,32}" placeholder="3–32 位字母、数字或下划线" required></label>${register ? '<label>小朋友名字<input name="child_name" maxlength="30" placeholder="例如：张三三" autocomplete="off" required></label>' : ""}${!forgot ? `<label>密码<input name="password" type="password" minlength="8" maxlength="128" autocomplete="${register ? "new-password" : "current-password"}" placeholder="至少 8 位" required></label>${register ? '<label>确认密码<input name="confirmPassword" type="password" minlength="8" maxlength="128" autocomplete="new-password" required></label>' : ""}` : '<label>申请说明<textarea name="message" maxlength="500" placeholder="请填写便于管理员核实的说明，不要填写旧密码。"></textarea></label>'}<p id="auth-feedback" class="auth-message" role="alert" data-state="${ui.authMessageState || ""}">${esc(ui.authMessage || "")}</p><input id="captcha-id" name="captchaId" type="hidden" value="${esc(ui.captcha?.id || "")}"><label>验证码<div class="captcha-row"><input id="captcha-answer" name="captcha" aria-label="图片验证码" aria-describedby="captcha-feedback" inputmode="numeric" maxlength="16" placeholder="输入验证码" autocomplete="off" required><button type="button" data-account-action="captcha" aria-label="更换验证码"><img id="captcha-image" src="${ui.captcha?.image || ""}" alt="验证码，点击更换"></button></div></label><p id="captcha-feedback" class="auth-message" role="status"></p><button class="primary block" type="submit" ${ui.authBusy || ui.captchaLoading || !ui.captcha ? "disabled" : ""}>${ui.authBusy ? "正在处理…" : register ? "注册宝宝账号" : forgot ? "提交重置申请" : "登录"}</button></form><div class="auth-links"><button data-auth-mode="${register || forgot ? "login" : "email-register"}">${register || forgot ? "已有账号，返回登录" : "注册新账号"}</button>${!forgot ? '<button data-auth-mode="email-reset">忘记密码？</button>' : ""}</div></section></main>`;
    syncAuthButton();
    if (!ui.captcha) queueMicrotask(newCaptcha);
  }
  function profilePage() {
    const isParent = user.role === "parent",
      name = user.child_name;
    return `${title(isParent ? "家长个人中心" : "宝宝个人中心", "账号资料和家庭绑定可以在这里管理。")}<section class="profile-header">${img("brand/child-avatar", "greeting-avatar", "头像")}<div><h2>${esc(name)}${user.role === "child" ? "小朋友" : ""}</h2><p>${esc(user.username)} · ${user.role === "admin" ? "管理员" : isParent ? "家长账号" : "宝宝账号"}</p></div></section>${window.BX_VIP?.profile() || ""}<div class="profile-actions"><button class="primary" data-go="family">${isParent ? "查看已绑定宝宝" : "注册 / 绑定家长账号"}</button>${user.role === "child" ? '<button class="secondary" data-go="growth">我的成长足迹</button>' : ""}${user.role === "parent" || user.role === "admin" ? '<button class="secondary" data-go="parent/today">家长中心</button>' : ""}${user.role === "admin" ? '<button class="secondary" data-go="admin/overview">进入管理后台</button>' : ""}</div><div class="profile-grid"><section class="settings-section"><details class="profile-edit-details"><summary><span>修改名字</span><small>更新小朋友的称呼</small></summary><form id="profile-name-form" class="account-form"><label>${isParent ? "家长称呼" : "小朋友名字"}<input name="child_name" value="${esc(name)}" maxlength="30" required></label><button class="primary" type="submit">保存名字</button></form></details></section><section class="settings-section"><details class="profile-edit-details"><summary><span>修改密码</span><small>修改账户登录密码</small></summary><form id="profile-password-form" class="account-form"><label>原密码<input name="oldPassword" type="password" autocomplete="current-password" required></label><label>新密码<input name="newPassword" type="password" minlength="8" maxlength="128" autocomplete="new-password" required></label><label>再次输入新密码<input name="confirmPassword" type="password" minlength="8" autocomplete="new-password" required></label><button class="primary" type="submit">修改密码并重新登录</button></form></details></section></div><section class="settings-section"><label for="profile-font-size">文字大小</label> <select id="profile-font-size" aria-label="文字大小"><option value="small" ${!state.settings.fontSize || state.settings.fontSize === "small" ? "selected" : ""}>紧凑</option><option value="standard" ${state.settings.fontSize === "standard" ? "selected" : ""}>标准</option><option value="large" ${state.settings.fontSize === "large" ? "selected" : ""}>较大</option></select></section>${recoveryPanel()}<button class="secondary block" data-account-action="logout">退出登录</button>`;
  }
  function familyPage() {
    const child = user.role === "child",
      list = child ? family.parents : family.children;
    return `${title(child ? "让家人一起陪伴" : "我绑定的宝宝", child ? "宝宝学习记录独立保存，只有绑定的家长可查看和设置陪伴偏好。" : "选择宝宝查看学习记录；新增绑定请在对应宝宝账号的个人中心操作。")}${child ? '<div class="family-actions"><button class="primary" data-family-action="register">注册新的家长账号</button><button class="secondary" data-family-action="bind">绑定已有家长账号</button></div>' : ""}<div class="user-cards">${list.map((person) => `<article class="user-card"><div class="user-card-head">${img("brand/child-avatar", "avatar-small", "头像")}<div><h3>${esc(person.child_name)}${child ? "" : "小朋友"}</h3><p>${esc(person.username)} · ${person.enabled ? "已绑定" : "账号已停用"}</p></div></div><div class="user-card-actions">${!child ? `<button data-select-child="${person.id}">查看学习情况</button>` : ""}<button data-unlink-family="${person.id}">解除绑定</button></div></article>`).join("") || empty(child ? "还没有绑定家长" : "还没有绑定宝宝", child ? "可以先注册一位家长账号，再让家长独立登录。" : "请先由宝宝登录，在个人中心绑定此家长账号。")}</div>`;
  }
  function bars(rows, total) {
    return rows.length
      ? rows
          .map(
            (row, i) =>
              `<div class="analytics-bar"><span>${esc(row.name)}</span><div><i style="width:${Math.max(3, Math.round((row.value / Math.max(1, total)) * 100))}%;background:${["#efa34e", "#7ebda1", "#80b6da", "#aaa0cd"][i % 4]}"></i></div><strong>${row.value}</strong></div>`,
          )
          .join("")
      : '<div class="chart-empty">暂无学习数据</div>';
  }
  function adminChapterActivity(value) {
    if (!value?.chapterActivity) return "";
    const chapter = value.chapterActivity,
      rows = Object.entries(chapter.bySubject || {}).map(([name, n]) => ({
        name,
        value: countValue(n),
      }));
    return `<section class="analytics-card"><h2>章节练习当前状态</h2><div class="parent-summary">${[
      [chapter.users, "有作答的章节学习用户"],
      [chapter.questions, "当前有作答的章节题"],
      [chapter.generatedQuestions, "AI原创题库数"],
    ]
      .map(
        ([n, label]) =>
          `<div class="metric-tile"><strong>${countValue(n)}</strong><span>${label}</span></div>`,
      )
      .join(
        "",
      )}</div><details><summary>按学科查看当前章节作答</summary>${bars(rows, Math.max(1, ...rows.map((row) => row.value)))}</details><p class="source-notice">章节统计按当前状态去重，不与上方累计提问次数相加。</p></section>`;
  }
  function adminOverview() {
    const a = ui.analytics;
    if (!a)
      return (
        title("管理数据概览") +
        empty("正在汇总数据", "读取账号、教材与提问记录…")
      );
    const distribution = Object.entries(a.questionDistribution).map(
      ([name, value]) => ({ name, value }),
    );
    return `${title("管理数据概览", "实际账号与学习记录汇总")}<section class="admin-kpis">${[
      [a.userCount, "用户总数", "users"],
      [a.todayActive, "今日活跃", "flame"],
      [a.readingUsers, "教材阅读人数", "book-open"],
      [a.totalQuestions, "累计提问", "messages-square"],
    ]
      .map(
        ([n, t, i]) =>
          `<div>${ico(i)}<strong>${n}</strong><span>${t}</span></div>`,
      )
      .join(
        "",
      )}</section>${adminChapterActivity(a)}<div class="analytics-grid"><section class="analytics-card"><h2>教材使用分布 <small>阅读人数</small></h2>${bars(
      a.popularBooks.map((b) => ({
        name: b.subject + " · " + b.title,
        value: b.users,
      })),
      Math.max(1, ...a.popularBooks.map((b) => b.users)),
    )}</section><section class="analytics-card"><h2>提问分布 <small>按学科 / 入口</small></h2>${bars(distribution, a.totalQuestions)}<div class="analytics-note">${a.studyMinutes} 分钟学习记录 · ${a.bookCount} 份教材资料</div></section><section class="analytics-card"><h2>高频问题</h2>${
      a.frequentQuestions.length
        ? a.frequentQuestions
            .slice(0, 5)
            .map(
              (q, i) =>
                `<div class="frequent-question"><span>${i + 1}</span><p>${esc(q.question)}</p><strong>${q.count} 次</strong></div>`,
            )
            .join("")
        : '<div class="chart-empty">有提问后将在这里显示</div>'
    }</section><section class="analytics-card"><h2>年级分布</h2>${bars(
      Object.entries(a.gradeDistribution).map(([grade, count]) => ({
        name: gradeName(Number(grade)),
        value: count,
      })),
      a.userCount,
    )}<button class="text-action" data-go="admin/users">查看用户管理${ico("chevron-right", "small")}</button></section></div><details class="analytics-details"><summary>最近提问明细</summary>${a.recentQuestions.map((q) => `<p><span class="pill">${esc(q.category)}</span> 用户 #${q.user_id}：${esc(q.question)}</p>`).join("") || "<p>暂无提问。</p>"}</details>`;
  }
  function adminUsers() {
    const list = (ui.users || []).filter(
      (u) =>
        !ui.userSearch ||
        `${u.username} ${u.child_name} ${u.id}`
          .toLowerCase()
          .includes(ui.userSearch.toLowerCase()),
    );
    const page = Math.min(
        ui.userPage || 0,
        Math.max(0, Math.ceil(list.length / 4) - 1),
      ),
      paged = list.slice(page * 4, page * 4 + 4);
    return `${title("用户管理", "新增、查询、编辑、停用、恢复与密码重置")}<div class="admin-tools"><input id="user-search" type="search" aria-label="搜索用户" placeholder="搜索用户名或小朋友名字" value="${esc(ui.userSearch || "")}"><button class="primary" data-account-action="create-user">新增用户</button><button class="secondary" data-account-action="refresh-admin">刷新数据</button></div><div class="user-cards">${paged.map((u) => `<article class="user-card"><div class="user-card-head">${img("brand/child-avatar", "avatar-small", "头像")}<div><h3>${esc(u.child_name)}${u.role === "child" ? "小朋友" : ""}</h3><p>${esc(u.username)} · #${u.id}</p></div><span class="pill ${u.enabled ? "mint" : "coral"}">${u.enabled ? (u.role === "admin" ? "管理员" : u.role === "parent" ? "家长账号" : "宝宝账号") : "已停用"}</span></div><div class="user-card-actions"><button data-edit-user="${u.id}">编辑</button><button data-reset-user="${u.id}" ${u.id === user.id ? "disabled" : ""}>重置密码</button><button data-toggle-user="${u.id}" ${u.id === user.id ? "disabled" : ""}>${u.enabled ? "停用账号" : "恢复账号"}</button></div></article>`).join("") || empty("没有匹配用户", "换个关键词试试。")}</div><div class="list-pagination"><button class="secondary" data-user-page="${page - 1}" ${page === 0 ? "disabled" : ""}>上一页</button><span>${page + 1} / ${Math.max(1, Math.ceil(list.length / 4))} · ${list.length} 位用户</span><button class="secondary" data-user-page="${page + 1}" ${page >= Math.ceil(list.length / 4) - 1 ? "disabled" : ""}>下一页</button></div><details class="section-title"><summary>密码重置申请（${(ui.resetRequests || []).filter((r) => r.status === "pending").length} 条待处理）</summary>${(ui.resetRequests || []).map((r) => `<div class="reset-request"><strong>${esc(r.username)}</strong><span class="pill">${r.status === "pending" ? "待核实" : "已处理"}</span><p>${esc(r.message || "未填写说明")}</p>${r.status === "pending" ? `<button class="text-action" data-reset-username="${esc(r.username)}">核实后重置密码</button>` : ""}</div>`).join("") || '<p class="muted">暂无重置申请。</p>'}</details><p class="source-notice">停用后，该账号会退出登录。学习记录保留，账号可以恢复。</p>`;
  }
  function userForm(id) {
    const u = (ui.users || []).find((u) => u.id === id);
    modal(
      u ? "编辑用户" : "新增用户",
      `<form id="admin-user-form" class="account-form" data-user-id="${id || ""}"><label>用户名<input name="username" value="${esc(u?.username || "")}" pattern="[A-Za-z0-9_]{3,32}" required></label><label>小朋友名字<input name="child_name" value="${esc(u?.child_name || "")}" maxlength="30" required></label>${!u ? '<label>初始密码<input name="password" type="password" minlength="8" maxlength="128" autocomplete="new-password" required></label>' : ""}<label>角色<select name="role"><option value="child" ${!u || u.role === "child" ? "selected" : ""}>学习账号</option><option value="parent" ${u?.role === "parent" ? "selected" : ""}>家长账号</option><option value="admin" ${u?.role === "admin" ? "selected" : ""}>管理员</option></select></label><button class="primary" type="submit">保存用户</button></form>`,
    );
  }
  document.addEventListener("click", (event) => {
    const el = event.target.closest("button");
    if (!el || el.disabled) return;
    const d = el.dataset;
    const run = async () => {
      if (d.authMode) {
        if (ui.authBusy) return;
        ui.authMode = d.authMode === "register" && ui.registrationMode !== "local"
          ? "email-register" : d.authMode;
        setAuthMessage("");
        ui.captcha = null;
        renderAuth();
        return;
      }
      if (d.accountAction === "captcha") {
        await newCaptcha();
        return;
      }
      if (d.accountAction === "logout") {
        stopSpeech();
        await sync();
        await api("/api/auth/logout", {});
        clearTimeout(syncTimer);
        connected = false;
        user = null;
        state = defaults();
        chatAbort?.abort();
        ui.authMode = "login";
        setAuthMessage("");
        ui.captcha = null;
        renderAuth();
        return;
      }
      if (d.accountAction === "create-user") {
        userForm();
        return;
      }
      if (d.accountAction === "refresh-admin") {
        ui.adminLoaded = false;
        await refreshAdmin();
        return;
      }
      if (d.userPage !== undefined) {
        ui.userPage = Math.max(0, Number(d.userPage));
        render();
        return;
      }
      if (d.editUser) {
        userForm(Number(d.editUser));
        return;
      }
      if (d.toggleUser) {
        const u = ui.users.find((u) => u.id === Number(d.toggleUser));
        if (!u || (u.enabled && !window.confirm("停用后，该账号会退出登录。确定停用？"))) return;
        el.disabled = true;
        try {
          await api("/api/admin/users/update", { id: u.id, enabled: !u.enabled });
        } finally {
          el.disabled = false;
        }
        await refreshAdmin();
        return;
      }
      if (d.resetUser || d.resetUsername) {
        const u = ui.users.find((u) =>
          d.resetUser
            ? u.id === Number(d.resetUser)
            : u.username.toLowerCase() === d.resetUsername.toLowerCase(),
        );
        if (!u) throw new Error("未找到该用户名，请先核实申请信息");
        modal(
          "核实身份后重置密码",
          `<p>为 ${esc(u.username)} 重置后，所有旧登录将失效。临时密码仅显示一次。</p><button class="primary block" data-confirm-reset="${u.id}">已核实身份，生成临时密码</button>`,
        );
        return;
      }
      if (d.confirmReset) {
        const result = await api("/api/admin/users/reset", {
          id: Number(d.confirmReset),
        });
        await refreshAdmin();
        modal(
          "密码已重置",
          `<p>用户名：${esc(result.username)}</p><p>临时密码：<strong class="temporary-password">${esc(result.temporaryPassword)}</strong></p><p>请当面交给账号使用者，并让对方登录后修改密码。</p>`,
        );
      }
    };
    run().catch((error) => toast(error.message));
  });
  document.addEventListener("input", (event) => {
    if (event.target.form?.id === "auth-form" && event.target.getAttribute("aria-invalid") === "true") {
      event.target.removeAttribute("aria-invalid");
      setAuthMessage("");
    }
    if (event.target.id === "user-search") {
      const value = event.target.value,
        pos = event.target.selectionStart;
      ui.userSearch = value;
      ui.userPage = 0;
      render();
      const next = $("#user-search");
      next.focus();
      try {
        next.setSelectionRange(pos, pos);
      } catch (_) {}
    }
  });
  document.addEventListener("focusin", (event) => {
    if (event.target.id === "captcha-answer" && !ui.authBusy && captchaExpired()) {
      void newCaptcha(expiredCaptchaMessage);
    }
  });
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (
      ![
        "auth-form",
        "profile-name-form",
        "profile-password-form",
        "admin-user-form",
      ].includes(form.id)
    )
      return;
    event.preventDefault();
    const run = async () => {
      const data = Object.fromEntries(new FormData(form));
      if (form.id === "auth-form") {
        if (ui.authBusy) return;
        const mode = ui.authMode || "login";
        if (mode === "login") {
          data.username = data.username.trim();
          const error = loginFieldError(data.username, data.password);
          if (error) {
            const [field, message] = error;
            form.elements[field].setAttribute("aria-invalid", "true");
            setAuthMessage(message);
            form.elements[field].focus();
            return;
          }
        }
        if (mode === "register" && data.password !== data.confirmPassword) {
          setAuthMessage("两次输入的密码不一致。");
          return;
        }
        ui.authUsername = data.username;
        if (ui.captchaLoading || !ui.captcha) {
          toast("验证码正在加载，请稍后");
          return;
        }
        if (captchaExpired()) {
          if (await newCaptcha(expiredCaptchaMessage)) {
            form.elements.captcha.focus();
          }
          return;
        }
        const answer = String(data.captcha || "")
          .normalize("NFKC")
          .replace(/\s+/g, "");
        if (!/^[0-9]{4}$/.test(answer)) {
          setAuthMessage("请输入图片上的 4 位数字。");
          form.elements.captcha.setAttribute("aria-invalid", "true");
          form.elements.captcha.focus();
          return;
        }
        data.captcha = answer;
        data.captchaId = ui.captcha.id;
        setAuthMessage("");
        ui.authBusy = true;
        syncAuthButton();
        try {
          const result = await api(
            "/api/auth/" + (mode === "forgot" ? "reset-request" : mode),
            data,
          );
          if (mode === "login") {
            user = result.user;
            await loadApplication();
          } else {
            ui.authMode = "login";
            setAuthMessage(
              mode === "register"
                ? "宝宝账号注册成功，请登录。"
                : result.message,
              "success",
            );
            ui.captcha = null;
            renderAuth();
          }
        } catch (error) {
          setAuthMessage(error.message);
          await newCaptcha();
        } finally {
          ui.authBusy = false;
          syncAuthButton();
        }
        return;
      }
      if (form.id === "profile-name-form") {
        const result = await api("/api/profile/name", data);
        user.child_name = result.child_name;
        if (user.role !== "parent") state.childName = result.child_name;
        persist();
        render();
        toast("名字已更新");
        return;
      }
      if (form.id === "profile-password-form") {
        if (data.newPassword !== data.confirmPassword)
          throw new Error("两次输入的新密码不一致");
        await sync();
        await api("/api/profile/password", data);
        connected = false;
        user = null;
        state = defaults();
        clearTimeout(syncTimer);
        setAuthMessage("密码已修改，请使用新密码重新登录。", "success");
        ui.captcha = null;
        renderAuth();
        return;
      }
      if (form.id === "admin-user-form") {
        if (form.dataset.userId) data.id = Number(form.dataset.userId);
        await api("/api/admin/users/" + (data.id ? "update" : "create"), data);
        closeModal();
        await refreshAdmin();
        toast("用户信息已保存");
      }
    };
    run().catch((error) => toast(error.message));
  });
  async function loadCleaning(id, page) {
    const key = id + ":" + page;
    if (ui.cleanLoading === key) return;
    ui.cleanLoading = key;
    try {
      const [rules, meta] = await Promise.all([
        api(`/api/books/${id}/cleaning?n=${page}`),
        api("/api/books/" + id),
      ]);
      ui.cleaning = {
        id,
        page,
        meta,
        regions: [...rules.shared, ...rules.page].map((r) => ({
          ...r,
          label: "已保存遮除区域",
          selected: true,
        })),
        notice: "",
      };
      render();
    } catch (error) {
      ui.error = error.message;
      toast(error.message);
    } finally {
      ui.cleanLoading = "";
    }
  }
  function cleaningPage() {
    const id = route()[2],
      page = Math.max(1, Number(route()[3]) || 1),
      b = book(id);
    if (!b) return empty("教材不存在", "请从教材管理进入。");
    const c = ui.cleaning;
    if (!c || c.id !== id || c.page !== page) {
      queueMicrotask(() => loadCleaning(id, page));
      return (
        title("清理推广内容") + empty("读取清理规则", "原始教材不会修改。")
      );
    }
    return `${back("清爽阅读 · 推广清理", "admin/books")}<div class="cleanup-heading"><div><h2>${esc(b.title)}</h2><p>第 ${page} / ${c.meta.pageCount} 页 · 拖动框选推广区域，保存后在清爽阅读中生效。</p></div><form id="clean-page-form"><input name="page" aria-label="清理页码" type="number" min="1" max="${c.meta.pageCount}" value="${page}"><button class="secondary" type="submit">换页</button></form></div><div class="cleanup-layout"><div class="cleanup-canvas" id="cleanup-canvas"><img id="cleanup-image" draggable="false" src="/api/books/${id}/page?n=${page}&width=1500" alt="原始教材页面，可拖动框选广告">${c.regions.map((r, i) => `<div class="cleanup-region ${r.selected ? "selected" : ""}" style="left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%"><span>${i + 1}</span></div>`).join("")}<div id="cleanup-selection"></div></div><section class="cleanup-controls"><h3>推广区域核对</h3><button class="primary block" data-account-action="analyze-page" ${ui.cleanBusy ? "disabled" : ""}>${ui.cleanBusy ? "正在识别二维码与推广文字…" : "智能识别本页"}</button><p class="muted">教材配套音频码默认保留；其他二维码需要核对。可在左侧拖动补充框选。</p>${c.notice ? `<p class="error-banner">${esc(c.notice)}</p>` : ""}<div class="cleanup-options">${c.regions.map((r, i) => `<label><input type="checkbox" data-clean-region="${i}" ${r.selected ? "checked" : ""}><span>${i + 1}. ${esc(r.label || "手动框选")}</span><button type="button" data-remove-region="${i}" aria-label="移除区域${i + 1}">${ico("x", "small")}</button></label>`).join("") || '<p class="muted">尚无区域，可自动识别或拖动框选。</p>'}</div><button class="primary block" data-save-clean="page">保存本页清理规则</button><button class="secondary block" data-save-clean="all">应用到全书相同位置</button><button class="secondary block" data-account-action="clear-clean">清除此书及本页规则</button><button class="secondary block" data-read="${id}" data-read-page="${page}">返回教材看清爽效果</button><p class="muted">整页推广可框选整页。全书应用前请确认该区域没有正文；关闭清爽阅读可随时查看原文。</p></section></div>`;
  }
  actions["toggle-clean"] = () => {
    state.settings.cleanReading = !state.settings.cleanReading;
    persist();
    render();
  };
  document.addEventListener("change", (event) => {
    if (event.target.dataset.cleanRegion !== undefined) {
      ui.cleaning.regions[Number(event.target.dataset.cleanRegion)].selected =
        event.target.checked;
      render();
    }
  });
  document.addEventListener("click", (event) => {
    const el = event.target.closest("button");
    if (!el) return;
    const d = el.dataset;
    const run = async () => {
      if (d.removeRegion !== undefined) {
        ui.cleaning.regions.splice(Number(d.removeRegion), 1);
        render();
        return;
      }
      if (d.accountAction === "analyze-page") {
        if (ui.cleanBusy) return;
        const c = ui.cleaning;
        ui.cleanBusy = true;
        render();
        try {
          const data = await api("/api/admin/cleaning/analyze", {
            bookId: c.id,
            page: c.page,
          });
          c.regions.push(...data.regions);
          c.notice = data.notice || "";
          if (!data.regions.length)
            c.notice = "未识别到明确推广区域。请核对原文，可拖动手动框选。";
        } finally {
          ui.cleanBusy = false;
          render();
        }
        return;
      }
      if (d.saveClean) {
        const c = ui.cleaning;
        await api("/api/admin/cleaning/save", {
          bookId: c.id,
          page: c.page,
          scope: d.saveClean,
          regions: c.regions.filter((r) => r.selected),
        });
        toast("清理规则已保存，原始教材保留");
        return;
      }
      if (d.accountAction === "clear-clean") {
        const c = ui.cleaning;
        await api("/api/admin/cleaning/save", {
          bookId: c.id,
          page: c.page,
          scope: "all",
          regions: [],
        });
        await api("/api/admin/cleaning/save", {
          bookId: c.id,
          page: c.page,
          scope: "page",
          regions: [],
        });
        c.regions = [];
        render();
        toast("已恢复原始页面显示");
      }
    };
    run().catch((error) => toast(error.message));
  });
  document.addEventListener("submit", (event) => {
    if (event.target.id !== "clean-page-form") return;
    event.preventDefault();
    const page = Number(new FormData(event.target).get("page"));
    if (page >= 1 && page <= ui.cleaning.meta.pageCount)
      go("admin/cleaning/" + ui.cleaning.id + "/" + page);
  });
  document.addEventListener("pointerdown", (event) => {
    const canvas = event.target.closest("#cleanup-canvas");
    if (!canvas || !ui.cleaning) return;
    const image = $("#cleanup-image"),
      rect = image.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      return;
    ui.cleanStart = {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
      rect,
    };
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  document.addEventListener("pointermove", (event) => {
    if (!ui.cleanStart) return;
    const a = ui.cleanStart,
      b = {
        x: Math.max(
          0,
          Math.min(1, (event.clientX - a.rect.left) / a.rect.width),
        ),
        y: Math.max(
          0,
          Math.min(1, (event.clientY - a.rect.top) / a.rect.height),
        ),
      },
      el = $("#cleanup-selection");
    if (el)
      Object.assign(el.style, {
        display: "block",
        left: Math.min(a.x, b.x) * 100 + "%",
        top: Math.min(a.y, b.y) * 100 + "%",
        width: Math.abs(a.x - b.x) * 100 + "%",
        height: Math.abs(a.y - b.y) * 100 + "%",
      });
  });
  document.addEventListener("pointerup", (event) => {
    if (!ui.cleanStart) return;
    const a = ui.cleanStart,
      b = {
        x: Math.max(
          0,
          Math.min(1, (event.clientX - a.rect.left) / a.rect.width),
        ),
        y: Math.max(
          0,
          Math.min(1, (event.clientY - a.rect.top) / a.rect.height),
        ),
      };
    ui.cleanStart = null;
    if (Math.abs(a.x - b.x) > 0.005 && Math.abs(a.y - b.y) > 0.005) {
      ui.cleaning.regions.push({
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        w: Math.abs(a.x - b.x),
        h: Math.abs(a.y - b.y),
        label: "手动框选",
        selected: true,
      });
      render();
    }
  });
  function familyForm(mode) {
    if (mode === "register" && ui.registrationMode === "paused") {
      modal("注册已暂停", '<p class="muted">邮件服务暂未配置，请联系管理员。</p>');
      return;
    }
    if (mode === "register" && ui.emailAvailable && window.BX_EMAIL_AUTH) {
      modal("注册并绑定家长账号", window.BX_EMAIL_AUTH.fields("family"));
      window.BX_EMAIL_AUTH.mount();
      return;
    }
    modal(
      mode === "register" ? "注册并绑定家长账号" : "绑定已有家长账号",
      `<form id="family-form" class="account-form" data-mode="${mode}"><label>家长用户名<input name="username" pattern="[A-Za-z0-9_]{3,32}" autocomplete="off" required></label>${mode === "register" ? '<label>家长称呼<input name="display_name" maxlength="30" placeholder="例如：三三妈妈" required></label>' : ""}<label>${mode === "register" ? "设置家长密码" : "家长账号密码"}<input name="password" type="password" minlength="8" maxlength="128" autocomplete="${mode === "register" ? "new-password" : "current-password"}" required></label>${mode === "register" ? '<label>确认密码<input name="confirmPassword" type="password" minlength="8" autocomplete="new-password" required></label>' : ""}<p class="muted">${mode === "register" ? "创建独立家长账号并绑定当前宝宝。当前宝宝登录会保留。" : "只有正确核验家长密码后，才会授予该家长查看此宝宝记录的权限。"}</p><button class="primary" type="submit">${mode === "register" ? "注册并绑定" : "核验并绑定"}</button></form>`,
    );
  }
  document.addEventListener("click", (event) => {
    const el = event.target.closest("button");
    if (!el || el.disabled) return;
    const d = el.dataset;
    const run = async () => {
      if (d.familyAction) {
        familyForm(d.familyAction);
        return;
      }
      if (d.selectChild) {
        await sync();
        ui.activeChildId = Number(d.selectChild);
        await loadApplication();
        go("parent/today");
        return;
      }
      if (d.unlinkFamily) {
        modal(
          "解除家庭绑定",
          `<p>解除后，该家长不能再读取此宝宝的学习记录。已有学习记录会保留。</p><button class="primary block" data-confirm-unlink="${d.unlinkFamily}">确认解除绑定</button>`,
        );
        return;
      }
      if (d.confirmUnlink) {
        await api("/api/family/unlink", { id: Number(d.confirmUnlink) });
        closeModal();
        await loadApplication();
        go("family");
        toast("绑定已解除");
      }
    };
    run().catch((error) => toast(error.message));
  });
  document.addEventListener("change", (event) => {
    if (event.target.id !== "parent-child") return;
    const id = Number(event.target.value);
    (async () => {
      await sync();
      ui.activeChildId = id;
      await loadApplication();
    })().catch((error) => toast(error.message));
  });
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (form.id !== "family-form") return;
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (
      form.dataset.mode === "register" &&
      data.password !== data.confirmPassword
    ) {
      toast("两次输入的密码不一致");
      return;
    }
    const submit = form.querySelector("button[type=submit]");
    if (submit.disabled) return;
    submit.disabled = true;
    (async () => {
      await api(
        "/api/family/" +
          (form.dataset.mode === "register"
            ? "register-parent"
            : "bind-parent"),
        data,
      );
      family = await api("/api/family");
      closeModal();
      go("family");
      toast("家长账号已绑定，可独立登录查看宝宝学习情况");
    })()
      .catch((error) => toast(error.message))
      .finally(() => {
        submit.disabled = false;
      });
  });
  actions["open-profile"] = () => go("profile");

  actions["chat-image"] = () => {
    if (ui.chatImage)
      modal(
        "本次题目图片",
        `<img src="${esc(ui.chatImage)}" alt="本次题目图片" style="display:block;width:100%;height:auto">`,
      );
  };
  actions["dictation-edit"] = openDictationSettings;
  actions["dictation-load-book"] = loadDictationVocabulary;
  actions["dictation-use-book"] = useDictationVocabulary;
  actions["dictation-play"] = sayDictation;
  actions["listen-mode"] = () => {
    stopSpeech();
    ui.dictationMode = "listen";
    ui.feedback = "";
    ui.listenChoosing = false;
    ui.listenCorrect = false;
    render();
  };
  actions["spelling-mode"] = () => {
    stopSpeech();
    ui.dictationMode = "spelling";
    ui.feedback = "";
    ui.answer = "";
    render();
  };
  actions["listen-heard"] = () => {
    if (!ui.listenPlayed) {
      sayDictation();
      toast("先听一遍读音，再来选一选");
      return;
    }
    ui.listenChoosing = true;
    render();
  };
  actions["listen-again"] = () => {
    ui.feedback = "";
    sayDictation();
  };
  document.addEventListener("click", (event) => {
    const el = event.target.closest("button[data-listen-choice]");
    if (!el || el.disabled || !ui.listenChoosing || ui.listenCorrect) return;
    const correct = el.dataset.listenChoice === dictationEntry().text;
    ui.listenCorrect = correct;
    ui.feedback = correct
      ? "认出来了！读音和词语对上了。"
      : "这次还没对上。再听一遍，留意开头和结尾的声音。";
    if (correct) {
      day().dictation++;
      persist();
    }
    render();
    if (!correct) sayDictation();
  });
  actions["dictation-show"] = async () => {
    try {
      if (!(await chargeDictation())) return;
    } catch (error) {
      toast(error.message);
      return;
    }
    const e = dictationEntry();
    modal(
      "词语与读音",
      `<h2 class="word-preview">${esc(e.text)}</h2><p class="word-phonetic">${esc(e.phonetic || "")}</p><p>${dictationMeaning(e)}</p><button class="primary block" data-action="dictation-play">播放读音</button>`,
    );
  };
  document.addEventListener("change", (event) => {
    const el = event.target;
    const ids = [
      "dictation-grade",
      "dictation-term",
      "dictation-subject",
      "dictation-book",
      "dictation-section",
    ];
    if (!ids.includes(el.id)) return;
    if (el.id === "dictation-section") {
      ui.dSection = el.value;
      renderDictationSettings();
      return;
    }
    if (el.id === "dictation-grade") ui.dGrade = Number(el.value);
    if (el.id === "dictation-term") ui.dTerm = Number(el.value);
    if (el.id === "dictation-subject") ui.dSubject = el.value;
    if (el.id === "dictation-book") ui.dBookId = el.value;
    else ui.dBookId = "";
    ui.vocabGeneration = (ui.vocabGeneration || 0) + 1;
    ui.dBusy = false;
    ui.dVocabulary = null;
    ui.dError = "";
    renderDictationSettings();
  });
  document.addEventListener("click", (event) => {
    const el = event.target.closest("button");
    if (!el) return;
    if (el.dataset.vocabSpeak !== undefined) {
      const e = selectedVocabulary()[Number(el.dataset.vocabSpeak)];
      if (e) say(e.text, e.language);
    }
    if (el.dataset.vocabPage) {
      closeModal();
      go("reader/" + ui.dBookId + "/" + el.dataset.vocabPage);
    }
  });

  window.BX_ARENA?.connect({
    api,
    esc,
    ico,
    back,
    empty,
    modal,
    render,
    route,
    toast,
    go,
    user: () => user,
    selection: () => state,
    childId: () => ui.activeChildId,
    books: () => books,
    modalClose: closeModal,
    updateSelection: (value) => {
      const chosen = book(value.bookId);
      if (
        !chosen ||
        chosen.kind !== "textbook" ||
        chosen.grade !== value.grade ||
        chosen.term !== value.term
      )
        return;
      state.grade = value.grade;
      state.term = value.term;
      for (const subject of Object.keys(state.pins)) {
        const pinned = book(state.pins[subject]);
        if (
          !pinned ||
          pinned.grade !== value.grade ||
          pinned.term !== value.term
        )
          delete state.pins[subject];
      }
      state.pins[value.subject] = value.bookId;
      persist();
    },
    tutor: (unit, work) => {
      if (ui.busy) {
        toast("爪爪正在回复上一条问题，请等回复完成再开始新题。");
        return;
      }
      const prompt =
        (work.question
          ? "我想做这段练习的" + work.question + "。"
          : "我想做这段练习，请先帮我确认要做的题目。") +
        (work.answer ? "我的想法是：" + work.answer : "我还没有思路。") +
        "请先说清这道题的题目，再给我一个能开始的小提示，一次只引导一步。";
      if (window.BX_STUDY?.resumeContext)
        return window.BX_STUDY.resumeContext({ arenaUnitId: unit.id }, prompt);
      setChat(
        null,
        1,
        unit.chapterTitle +
          " · " +
          unit.sourceName +
          " · 文件第" +
          unit.sourcePage +
          "页",
      );
      ui.chatArenaUnitId = unit.id;
      ui.chatArenaTitle = "爪爪竞技场 · " + unit.chapterTitle;
      ui.chatId = "arena:" + unit.id + ":" + (work.question || "page");
      try {
        sessionStorage.setItem(
          "banxuezhua-chat-context-" + user.id,
          JSON.stringify({
            chatBook: null,
            chatId: ui.chatId,
            chatPage: 1,
            chatContext: ui.chatContext,
            chatArenaUnitId: unit.id,
            chatArenaTitle: ui.chatArenaTitle,
          }),
        );
      } catch (_) {}
      go("ai");
      queueMicrotask(() => sendChat(prompt));
    },
  });
  window.BX_LIQUID_NAV?.connect({
    go,
    route,
    openMenu: () => window.BX_SITE_NAV?.open(),
  });
  window.BX_LEARNING?.connect({
    turn: (direction) => {
      const meta = metadata.get(route()[1]),
        page = Number(route()[2]) || 1;
      if (
        route()[0] === "reader" &&
        meta &&
        page + direction >= 1 &&
        page + direction <= meta.pageCount
      )
        pageChange(page + direction);
    },
  });
  window.BX_VIP?.connect({
    api,
    esc,
    render,
    go,
    modal,
    close: closeModal,
    toast,
    user: () => user,
    childId: () => ui.activeChildId,
    children: () => family.children,
  });
  window.BX_STUDY?.connect({
    api,
    esc,
    ico,
    render,
    go,
    route,
    modal,
    toast,
    user: () => user,
    childId: () => ui.activeChildId,
    grade: () => state.grade,
    onSession: (value) => {
      ui.chatId = "study:" + value.id;
      ui.chatBook = value.context.bookId || null;
      ui.chatPage = value.context.page || 1;
      ui.chatArenaUnitId = value.context.arenaUnitId || "";
      ui.chatQuestionId = value.context.questionId || "";
      ui.chatContext = value.context.label || "";
    },
    onQuestion: (prompt, value) => {
      if (user?.role === "parent") return;
      day().questions++;
      state.questionEvents.push({
        at: Date.now(),
        book: value.context.bookId || null,
        source:
          value.kind === "photo" || value.kind === "homework"
            ? "scan"
            : value.kind === "arena"
              ? "arena"
              : "chat",
        text: prompt,
      });
      persist();
    },
  });
  window.BX_SITE_NAV?.connect({
    api,
    esc,
    ico,
    user: () => user,
    route,
    modal,
    close: closeModal,
    go,
    toast,
    resume: () => window.BX_ARENA_LEARNING?.resumeCard(),
    capture: () => window.BX_ARENA_LEARNING?.capture(),
    finish: async () => {
      window.BX_ARENA_LEARNING?.capture();
      const saved = await window.BX_ARENA_LEARNING?.finish?.();
      await sync();
      return saved !== false && !dirty && !conflict && !syncing;
    },
  });
  window.BX_NOTICES?.connect({api, esc, ico, render, route, toast, user: () => user});
  window.BX_EMAIL_AUTH?.connect({
    api, esc,
    async finished(purpose, username) {
      if (purpose === "family") {
        family = await api("/api/family");
        closeModal();
        go("family");
        toast("家长账号已注册并绑定。");
        return;
      }
      ui.authUsername = username;
      ui.authMode = "login";
      setAuthMessage(purpose === "reset" ? "密码已更新，请用新密码登录。" : "账号已创建，请登录。", "success");
      ui.captcha = null;
      renderAuth();
    },
  });
  start();
})();
