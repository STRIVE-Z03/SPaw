(function () {
  "use strict";
  let app,
    actor = "",
    session = null,
    loading = false,
    error = "",
    draft = "",
    sending = false,
    uploading = false,
    generation = 0,
    controller = null,
    requestId = "",
    lastContext = null,
    history = null,
    historyError = "",
    historyPending = false,
    search = "",
    lastRoute = "",
    contextOpening = null;
  const key = () => "bx-study-" + actor,
    uid = () => String(app.user()?.id || ""),
    escape = (value) => app.esc(value),
    rich = (value) =>
      window.BX_CHAT?.markdown(value) || escape(value).replace(/\n/g, "<br>");
  const kinds = {
    free: "问爪爪",
    photo: "拍照提问",
    homework: "检查作业",
    book: "教材答疑",
    arena: "竞技场答疑",
    practice: "专项练习答疑",
  };
  const token = () =>
    typeof crypto?.randomUUID === "function"
      ? crypto.randomUUID()
      : Date.now().toString(36) + "_" + Math.random().toString(36).slice(2);
  function read(name, fallback = "") {
    try {
      return localStorage.getItem(key() + ":" + name) || fallback;
    } catch (_) {
      return fallback;
    }
  }
  function write(name, value) {
    try {
      localStorage.setItem(key() + ":" + name, value);
    } catch (_) {}
  }
  function changed() {
    if (["ai", "scan"].includes(app.route()[0])) app.render();
    else if (embeddedContext()) refreshPracticePanel();
  }
  function resetActor() {
    const next = uid();
    if (actor === next) return;
    actor = next;
    practiceError = "";
    generation++;
    controller?.abort();
    session = null;
    lastContext = null;
    history = null;
    draft = read("draft:new");
    error = "";
    loading = false;
    sending = false;
    uploading = false;
    historyPending = false;
    requestId = "";
    contextOpening = null;
  }
  function remember() {
    if (session) {
      write("last", session.id);
      write("draft:" + session.id, draft);
    } else write("draft:new", draft);
  }
  function currentContext(raw = {}) {
    return {
      grade: app.grade(),
      ...(app.user()?.role === "parent" && app.childId?.()
        ? { childId: app.childId() }
        : {}),
      ...(raw.bookId ? { bookId: raw.bookId, page: raw.page || 1 } : {}),
      ...(raw.arenaUnitId ? { arenaUnitId: raw.arenaUnitId } : {}),
      ...(raw.questionId ? { questionId: raw.questionId } : {}),
      ...(raw.practiceSetId ? { practiceSetId: raw.practiceSetId, practiceItemId: raw.practiceItemId } : {}),
    };
  }
  const signature = (raw) =>
    JSON.stringify([
      String(raw?.childId || ""),
      ...(raw?.practiceSetId
        ? ["practice", raw.practiceSetId, raw.practiceItemId, raw.bookId || ""]
        : raw?.questionId
        ? ["question", raw.questionId]
        : raw?.arenaUnitId
          ? ["unit", raw.arenaUnitId]
          : raw?.bookId
            ? ["book", raw.bookId, raw.page || 1]
            : ["free"]),
    ]);
  const contextOwner = () =>
    uid() +
    ":" +
    String(app.user()?.role || "") +
    ":" +
    String(app.childId?.() || "");
  const contextName = (raw) =>
    "context:" +
    String(app.user()?.role || "") +
    ":" +
    String(app.childId?.() || "") +
    ":" +
    signature(raw);
  function rememberContext(value) {
    if (
      value?.id &&
      value.context &&
      (value.context.questionId ||
        value.context.arenaUnitId ||
        value.context.bookId || value.context.practiceSetId)
    )
      write(contextName(value.context), value.id);
  }
  function setSession(value) {
    session = value;
    rememberContext(value);
    draft = read("draft:" + session.id);
    remember();
    app.onSession?.(value);
  }
  function open(id) {
    remember();
    contextOpening = null;
    generation++;
    controller?.abort();
    session = null;
    loading = false;
    error = "";
    sending = false;
    requestId = "";
    lastContext = null;
    app.go("ai/" + id);
  }
  async function load(id) {
    if (loading) return;
    loading = true;
    const turn = ++generation,
      owner = actor;
    error = "";
    try {
      const value = await app.api("/api/study/sessions/" + id);
      if (turn !== generation || owner !== uid()) return;
      setSession(value);
      lastContext = value.context;
      if (value.job && ["queued", "running"].includes(value.job.status))
        watch(value.job.id);
    } catch (problem) {
      if (turn === generation) error = problem.message;
    } finally {
      if (turn === generation) {
        loading = false;
        changed();
      }
    }
  }
  async function loadHistory(more = false) {
    if (historyPending) return;
    historyPending = true;
    const owner = actor,
      filter = app.route()[2] || "",
      stamp = filter + ":" + search,
      offset = more ? history?.items.length || 0 : 0;
    historyError = "";
    try {
      const value = await app.api(
        "/api/study/sessions?kind=" +
          encodeURIComponent(filter) +
          "&search=" +
          encodeURIComponent(search) +
          "&offset=" +
          offset,
      );
      if (owner !== uid() || stamp !== (app.route()[2] || "") + ":" + search)
        return;
      history = more
        ? { ...value, items: [...history.items, ...value.items] }
        : value;
    } catch (problem) {
      if (owner === actor && stamp === (app.route()[2] || "") + ":" + search)
        historyError = problem.message;
    } finally {
      if (owner === actor) {
        historyPending = false;
        changed();
      }
    }
  }
  function historyPage() {
    const filter = app.route()[2] || "",
      stamp = filter + ":" + search;
    if (lastRoute !== stamp) {
      lastRoute = stamp;
      history = null;
      historyError = "";
    }
    if (!history && !historyPending && !historyError)
      queueMicrotask(() => loadHistory());
    return `<div class="study-title"><button class="secondary" data-study-back>返回提问</button><h1>提问历史</h1><button class="primary" data-study-new>新提问</button></div><p class="study-retention">自动保存近30天内更新的提问，可查看原图、结果并继续交流。</p><div class="study-history-tabs">${[
      ["", "全部"],
      ["pictures", "拍题与作业"],
      ["free", "问爪爪"],
      ["book", "教材"],
      ["arena", "竞技场"],
    ]
      .map(
        ([value, label]) =>
          `<button class="${filter === value ? "active" : ""}" data-study-filter="${value}">${label}</button>`,
      )
      .join(
        "",
      )}</div><form id="study-history-search"><input name="search" aria-label="搜索提问历史" placeholder="搜索题目或提问" maxlength="100" value="${escape(search)}"><button class="secondary" type="submit">搜索</button></form>${historyError ? `<div class="error-banner">${escape(historyError)}<button data-study-history-retry>重试</button></div>` : ""}<div class="study-history-list">${history?.items.map((item) => `<button class="study-history-item" data-study-open="${item.id}"><span class="study-history-icon">${app.ico(item.hasImage ? "camera" : "messages-square")}</span><span><strong>${escape(item.title)}</strong><small>${kinds[item.kind] || "提问"} · ${new Date(item.updated * 1000).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</small></span>${app.ico("chevron-right", "small")}</button>`).join("") || `<div class="empty-state"><h2>${historyPending ? "正在读取提问记录" : "还没有最近的提问记录"}</h2><p>${historyPending ? "请稍等片刻。" : "拍题、检查作业和问爪爪的提问都会保存在这里。"}</p></div>`}</div>${history?.hasMore ? '<button class="secondary block" data-study-more>加载更早记录</button>' : ""}`;
  }
  const verdicts = {
    correct: ["已看懂这一步", "good"],
    check: ["这里再检查一下", "check"],
    blank: ["还没有作答", "blank"],
    unclear: ["需要补充清晰图片", "unclear"],
    unverified: ["还需要核对", "unclear"],
  };
  function cards(analysis) {
    return `<div class="study-analysis">${analysis.items
      .map((item, index) => {
        const [label, tone] = verdicts[item.verdict] || verdicts.unverified;
        return `<section class="study-question-card" data-study-card="${index}"><div class="between"><strong>第 ${escape(item.number)} 题</strong><span class="study-verdict ${tone}">${label}</span></div><div class="study-question-stem chat-rich" data-hint-stem>${rich(item.stem)}</div>${item.options?.length ? `<div class="study-source-options">${item.options.map((option) => `<div data-hint-option="${option.id}"><b>${option.id}</b> ${escape(option.text)}</div>`).join("")}</div>` : ""}${item.work ? `<div class="study-own-work"><small>识别到的作答</small><p>${escape(item.work)}</p></div>` : ""}${item.feedback ? `<div class="chat-rich">${rich(item.feedback)}</div>` : ""}${item.hints?.length ? `<button class="secondary" data-study-hint="${index}">${app.ico("lightbulb", "small")}给我一步提示</button>` : ""}<button class="text-action" data-study-discuss="${index}">继续讨论这一题</button></section>`;
      })
      .join(
        "",
      )}<p class="study-retention">${escape(analysis.note || "AI初步核对，请结合原题检查。")}</p></div>`;
  }
  function textbookLinks(references) {
    const links = (references || []).filter(
      (ref) =>
        typeof ref.url === "string" &&
        /^\/#\/reader\/[a-f0-9]{20}\/[1-9][0-9]*$/.test(ref.url),
    );
    if (!links.length) return "";
    return (
      '<nav class="study-textbook-links" aria-label="相关教材页">' +
      links
        .map(
          (ref) =>
            '<a href="' +
            escape(ref.url) +
            '">' +
            escape(ref.title) +
            " · 第 " +
            escape(ref.page) +
            " 页 →</a>",
        )
        .join("") +
      "</nav>"
    );
  }
  function answerBody(text) {
    return (
      window.BX_CHAT?.markdown(text, { allowLinks: false }) ||
      escape(text).replace(/\n/g, "<br>")
    );
  }
  function returnLink() {
    const context = session?.context || lastContext || {};
    return context.practiceSetId
      ? `<button class="secondary" data-go="learn/practice/${context.practiceSetId}">回到当前练习</button>`
      : context.questionId
      ? `<button class="secondary" data-go="arena/question/${context.questionId}">回到当前题</button>`
      : context.arenaUnitId
        ? `<button class="secondary" data-go="arena/unit/${context.arenaUnitId}">回到练习</button>`
        : context.bookId
          ? `<button class="secondary" data-go="reader/${context.bookId}/${context.page}">回到教材</button>`
          : "";
  }
  function page() {
    resetActor();
    const route = app.route();
    if (route[1] === "history") return historyPage();
    const explicit = /^[a-f0-9]{32}$/.test(route[1] || "") ? route[1] : "";
    if (
      explicit &&
      session?.id !== explicit &&
      !loading &&
      !sending &&
      !contextOpening &&
      !error
    )
      queueMicrotask(() => {
        if (!contextOpening && !sending && app.route()[1] === explicit)
          load(explicit);
      });
    if (
      !explicit &&
      !session &&
      !loading &&
      !sending &&
      !contextOpening &&
      !error &&
      read("last")
    )
      queueMicrotask(() => {
        if (!contextOpening && !sending && !session) load(read("last"));
      });
    const context = session?.context || lastContext || {},
      lessonNav =
        context.questionId || context.arenaUnitId
          ? window.BX_ARENA_LEARNING?.navigation(context, { mode: "ai" })
          : "";
    return `${lessonNav || ""}<div class="study-title ${lessonNav ? "study-lesson-title" : ""}"><h1>问爪爪</h1><div><button class="secondary" data-study-history>历史记录</button><button class="secondary" data-study-new>新提问</button><button class="text-action" data-go="home">首页</button></div></div>${lessonNav ? "" : `<div class="study-context-bar"><span>${escape(session?.context?.label || lastContext?.label || kinds[session?.kind] || "从你的问题开始，一起想明白")}</span>${returnLink()}</div>`}${chatSurface()}`;
  }
  function chatSurface(compact = false) {
    const job = session?.job,
      active = job && ["queued", "running"].includes(job.status),
      messages = session?.messages || [];
    return `<section class="study-chat-surface${compact ? " practice-chat-surface" : ""}">${session?.imageUrl ? `<button class="study-attachment" data-study-image><img ${window.BX_MEDIA?.source(session.imageUrl) || `src="${escape(session.imageUrl)}"`} alt="这次提问的原图"><span>${session.kind === "homework" ? "作业原图" : "题目原图"}</span></button>` : ""}<div id="chat-messages" class="study-messages" role="log" aria-live="polite" aria-label="提问与答疑记录">${loading ? '<p class="study-working">正在恢复提问和原图…</p>' : ""}${!messages.length && !loading && !compact ? '<div class="study-welcome">把题目或你的想法告诉爪爪，我们从一个小步骤开始。<div><button class="secondary" data-go="scan">拍照提问</button></div></div>' : ""}${messages.map((message) => `<article class="study-message ${message.role}"><small>${message.role === "user" ? "我的提问" : compact && message.data?.supportMode === "model" ? "爪爪 · AI 讲解" : "爪爪"}</small>${message.data?.items ? cards(message.data) : `<div class="chat-rich">${message.role === "assistant" ? answerBody(message.content) : escape(message.content).replace(/\n/g, "<br>")}</div>${textbookLinks(message.data?.references)}`}</article>`).join("")}<div id="study-live">${active ? (job.analysis?.items ? cards(job.analysis) : `<article class="study-message assistant"><div class="chat-rich">${answerBody(job.partial || "")}</div>${textbookLinks(job.analysis?.references)}</article>`) : ""}</div>${active ? `<p id="study-working" class="study-working" role="status"><span class="working-dots"><i></i><i></i><i></i></span>${escape(job.stage || "正在认真看题…")}<small>离开后可在历史记录继续查看</small></p>` : ""}${error || job?.status === "error" ? `<div class="error-banner" role="alert">${escape(error || job.error)}<button class="secondary" data-study-retry>保留题目重试</button></div>` : ""}</div><form id="study-chat-form" class="study-composer"><textarea id="study-chat-input" maxlength="3000" rows="1" aria-label="你的问题或想法" placeholder="说说你的想法，或继续问这一步…">${escape(draft)}</textarea><button class="primary" type="submit" ${sending || active || loading ? "disabled" : ""}>${sending ? "正在发送…" : "发送"}</button></form><p class="study-save-note">${draft ? "草稿已保存在本机 · " : ""}${session ? "提问记录自动保存近30天" : "发送后自动保存到历史记录"}</p></section>`;
  }
  function embeddedContext() {
    const host = document.querySelector("#practice-conversation");
    if (!host) return null;
    return { practiceSetId: host.dataset.set, practiceItemId: host.dataset.item, bookId: host.dataset.book };
  }
  function matchesPractice(target) {
    return session?.kind === "practice" && signature(session.context) === signature(target);
  }
  function practicePanel(raw) {
    resetActor();
    const target = currentContext(raw);
    if (matchesPractice(target)) return chatSurface(true);
    if (practiceError === signature(target)) {
      return '<p class="error-banner" role="alert">暂时打不开答疑。<button data-practice-chat-retry type="button">重试</button></p>';
    }
    if (!contextOpening && !sending && !uploading) {
      queueMicrotask(() => {
        const active = embeddedContext();
        if (active && signature(currentContext(active)) === signature(target) && !contextOpening && !matchesPractice(target)) {
          resumeContext(raw);
        }
      });
    }
    return '<p class="study-working" role="status">正在准备答疑…</p>';
  }
  let practiceError = "";
  function refreshPracticePanel() {
    const host = document.querySelector("#practice-conversation");
    if (!host) return;
    const previous = host.querySelector("#chat-messages");
    const follow = !previous || previous.scrollHeight - previous.scrollTop - previous.clientHeight < 90;
    const scroll = previous?.scrollTop || 0;
    const editing = document.activeElement?.id === "study-chat-input";
    const selection = editing ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    host.innerHTML = practicePanel(embeddedContext());
    const log = host.querySelector("#chat-messages");
    if (log) log.scrollTop = follow ? log.scrollHeight : scroll;
    if (selection) {
      const input = host.querySelector("#study-chat-input");
      input?.focus({preventScroll: true});
      input?.setSelectionRange(...selection);
    }
  }
  async function askPractice(raw, prompt) {
    const target = currentContext(raw);
    if (!matchesPractice(target)) await resumeContext(raw);
    if (matchesPractice(target)) await send(prompt, raw);
  }
  function scanPage(mode = "question") {
    resetActor();
    return `<div class="study-title"><h1>${mode === "homework" ? "检查作业" : "拍题问爪爪"}</h1><button class="secondary" data-study-picture-history>拍题历史</button></div><section class="study-upload"><div class="study-upload-illustration">${app.ico("camera", "large")}</div><h2>${uploading ? "正在上传清楚的题图…" : "拍清楚，接下来交给爪爪"}</h2><p>${mode === "homework" ? "自动读出题目和已写答案，逐题核对并给出提示。" : "上传后自动读题并开始讲解，看不清时会请你补拍。"}</p><div class="study-upload-actions"><button class="primary" data-action="camera" ${uploading ? "disabled" : ""}>拍照</button><button class="secondary" data-action="upload" ${uploading ? "disabled" : ""}>相册上传</button></div>${error ? `<p class="error-banner">${escape(error)}</p>` : ""}<small>支持 JPG、PNG、WebP，每张不超过10MB。图片会交给已配置的AI服务分析。</small></section>`;
  }
  async function create(raw = {}) {
    const context = currentContext(raw),
      kind =
        context.practiceSetId
          ? "practice"
          : context.questionId || context.arenaUnitId
          ? "arena"
          : context.bookId
            ? "book"
            : "free";
    const owner = contextOwner(),
      turn = generation,
      value = await app.api("/api/study/sessions", {
        clientId: kind === "practice" ? `practice_${context.practiceItemId}_${context.bookId || ""}` : token(),
        kind,
        context,
      });
    if (owner !== contextOwner() || turn !== generation) return null;
    setSession(value);
    lastContext = value.context || context;
    return value;
  }
  async function resumeContext(raw = {}, initialPrompt = "") {
    resetActor();
    const target = currentContext(raw),
      targetSignature = signature(target),
      owner = contextOwner();
    if (!(target.questionId || target.arenaUnitId || target.bookId || target.practiceSetId))
      return send(initialPrompt, raw);
    if (contextOpening) {
      if (contextOpening.owner !== owner) return;
      app.toast("正在恢复这道题的提问，请稍等一下");
      return contextOpening.promise;
    }
    if (sending || uploading) {
      app.toast("正在保存上一条提问，请稍等一下");
      return;
    }
    remember();
    const turn = ++generation,
      slot = { owner, signature: targetSignature, promise: null };
    contextOpening = slot;
    slot.promise = (async () => {
      try {
        let value = null,
          candidate =
            read(contextName(target)) ||
            (session && signature(session.context) === targetSignature
              ? session.id
              : read("last"));
        if (/^[a-f0-9]{32}$/.test(candidate)) {
          try {
            const saved = await app.api("/api/study/sessions/" + candidate);
            if (owner !== contextOwner() || turn !== generation) return;
            if (
              signature(saved.context) === targetSignature &&
              ["arena", "book", "practice"].includes(saved.kind)
            )
              value = saved;
            else if (read(contextName(target)) === candidate)
              write(contextName(target), "");
          } catch (problem) {
            if (owner !== contextOwner() || turn !== generation) return;
            if ([403, 404].includes(problem.status)) {
              if (read(contextName(target)) === candidate)
                write(contextName(target), "");
            } else throw problem;
          }
        }
        if (owner !== contextOwner() || turn !== generation) return;
        if (!value) value = await create(target);
        if (!value || owner !== contextOwner() || turn !== generation) return;
        controller?.abort();
        setSession(value);
        lastContext = value.context || target;
        error = "";
        loading = false;
        requestId = "";
        if (value.kind !== "practice") app.go("ai/" + value.id);
        if (value.messages?.length || value.job) {
          if (value.job && ["queued", "running"].includes(value.job.status))
            watch(value.job.id);
          changed();
          return value;
        }
        await send(initialPrompt, value.context || target);
        return session;
      } catch (problem) {
        if (owner === contextOwner() && turn === generation) {
          if (target.practiceSetId) practiceError = targetSignature;
          else app.toast("原来的提问暂时未能恢复，记录已保留，请稍后再试。");
        }
      } finally {
        if (contextOpening === slot) contextOpening = null;
        if (target.practiceSetId) changed();
      }
    })();
    return slot.promise;
  }
  async function send(prompt, raw = {}, retry = false) {
    resetActor();
    prompt = String(prompt || "").trim();
    if (!prompt || sending) return;
    const owner = actor,
      scope = contextOwner(),
      turn = generation;
    const context = currentContext(raw);
    const practiceForm = context.practiceSetId && !retry ? document.querySelector("#personal-answer-form") : null;
    const work = practiceForm?.dataset.item === context.practiceItemId && practiceForm
      ? { answers: new FormData(practiceForm).getAll("answer"), scratch: practiceForm.elements.scratch?.value || "" }
      : null;
    if (session?.job && ["queued", "running"].includes(session.job.status)) {
      app.toast("爪爪正在回复，想法已保留，请等本次回复完成");
      return;
    }
    sending = true;
    error = "";
    draft = prompt;
    remember();
    changed();
    try {
      if (
        !session ||
        signature(context) !== signature(lastContext || session.context)
      )
        await create(raw);
      if (
        owner !== uid() ||
        scope !== contextOwner() ||
        turn !== generation ||
        !session
      )
        return;
      draft = prompt;
      remember();
      requestId = retry
        ? session.job?.request_id || requestId || token()
        : token();
      write("request:" + session.id, requestId);
      const job = await app.api("/api/study/sessions/" + session.id + "/jobs", {
        requestId,
        prompt,
        ...(work ? { practiceWork: work } : {}),
      });
      if (owner !== uid() || scope !== contextOwner() || turn !== generation)
        return;
      const saved = await app.api("/api/study/sessions/" + session.id);
      if (owner !== uid() || scope !== contextOwner() || turn !== generation)
        return;
      setSession(saved);
      draft = "";
      remember();
      write("draft:new", "");
      if (!retry) app.onQuestion?.(prompt, session);
      if (session.kind !== "practice" || app.route()[0] === "ai") app.go("ai/" + session.id);
      watch(job.id);
    } catch (problem) {
      if (owner === uid() && scope === contextOwner() && turn === generation)
        error = problem.message;
    } finally {
      if (owner === uid() && scope === contextOwner() && turn === generation) {
        sending = false;
        changed();
      }
    }
  }
  let paintedJob = "",
    paintedText = "";
  function illuminateNewText(container, count) {
    if (
      count <= 0 ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT),
      nodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (
        node.nodeValue &&
        !node.parentElement?.closest(".katex,.bx-math,code,pre")
      )
        nodes.push(node);
    }
    let remaining = Math.min(count, 40);
    for (let index = nodes.length - 1; index >= 0 && remaining > 0; index--) {
      const node = nodes[index],
        length = node.nodeValue.length,
        take = Math.min(remaining, length);
      const fresh = node.splitText(length - take),
        span = document.createElement("span");
      span.className = "study-fresh-text";
      fresh.parentNode.insertBefore(span, fresh);
      span.appendChild(fresh);
      remaining -= take;
    }
  }
  function paint() {
    const live = document.querySelector("#study-live"),
      working = document.querySelector("#study-working"),
      log = document.querySelector("#chat-messages");
    if (!live || !session) return;
    const following =
        !log || log.scrollHeight - log.scrollTop - log.clientHeight < 100,
      job = session.job;
    const text = job.partial || "",
      previous = paintedJob === job.id ? paintedText : "";
    const added = text.startsWith(previous) ? text.length - previous.length : 0;
    paintedJob = job.id;
    paintedText = text;
    live.innerHTML = job.analysis?.items
      ? cards(job.analysis)
      : `<article class="study-message assistant"><div class="chat-rich">${answerBody(text)}</div>${textbookLinks(job.analysis?.references)}</article>`;
    if (working)
      working.innerHTML =
        '<span class="working-dots"><i></i><i></i><i></i></span>' +
        escape(job.stage || "正在讲解…") +
        "<small>离开后可在历史记录继续查看</small>";
    window.BX_CHAT?.typeset(live.querySelectorAll(".chat-rich"));
    if (!job.analysis?.items && added)
      illuminateNewText(live.querySelector(".chat-rich"), added);
    if (following && log) log.scrollTop = log.scrollHeight;
  }
  async function watch(id) {
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal,
      owner = actor,
      identity = session?.id;
    let failures = 0;
    try {
      while (!signal.aborted && owner === uid() && session?.id === identity) {
        try {
          const response = await fetch("/api/study/jobs/" + id + "/events", {
            credentials: "same-origin",
            signal,
          });
          if (!response.ok) throw new Error("答疑连接暂时中断，正在恢复记录");
          let buffer = "";
          const consume = (frame) => {
            const line = frame
              .split(/\r?\n/)
              .find((v) => v.startsWith("data: "));
            if (!line) return;
            const value = JSON.parse(line.slice(6));
            if (
              value.type === "snapshot" &&
              owner === uid() &&
              session?.id === identity
            ) {
              session.job = value.job;
              paint();
            }
          };
          if (response.body?.getReader) {
            const reader = response.body.getReader(),
              decoder = new TextDecoder();
            try {
              while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                buffer += decoder.decode(chunk.value, { stream: true });
                let match;
                while ((match = /\r?\n\r?\n/.exec(buffer))) {
                  consume(buffer.slice(0, match.index));
                  buffer = buffer.slice(match.index + match[0].length);
                }
              }
              if (buffer.trim()) consume(buffer);
            } finally {
              await reader.cancel().catch(() => {});
              reader.releaseLock?.();
            }
          } else
            for (const frame of (await response.text()).split(/\r?\n\r?\n/))
              consume(frame);
          failures = 0;
        } catch (problem) {
          if (signal.aborted) return;
          if (++failures > 2) throw problem;
          await new Promise((resolve) => setTimeout(resolve, 800));
          const job = await app.api("/api/study/jobs/" + id);
          if (session?.id === identity) session.job = job;
        }
        if (owner !== uid() || session?.id !== identity) return;
        if (["done", "error"].includes(session.job?.status)) {
          session = await app.api("/api/study/sessions/" + identity);
          history = null;
          changed();
          return;
        }
      }
    } catch (problem) {
      if (!signal.aborted && owner === uid()) {
        error = "连接暂时中断，任务仍会保存到历史记录。请点重试恢复查看。";
        changed();
      }
    }
  }
  async function upload(file, mode = "question") {
    if (!file) return;
    resetActor();
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
      throw new Error("请选择JPG、PNG或WebP图片");
    if (file.size > 10 * 1024 * 1024)
      throw new Error("图片超过10MB，请换一张更小的");
    contextOpening = null;
    const turn = ++generation,
      owner = actor;
    uploading = true;
    error = "";
    changed();
    try {
      const image = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("读取图片失败，请重新选择"));
        reader.readAsDataURL(file);
      });
      if (turn !== generation || owner !== uid()) return;
      const value = await app.api("/api/study/sessions", {
        clientId: token(),
        kind: mode === "homework" ? "homework" : "photo",
        context: { grade: app.grade() },
        image,
      });
      if (turn !== generation || owner !== uid()) return;
      controller?.abort();
      setSession(value);
      lastContext = value.context;
      history = null;
      app.onQuestion?.(value.messages?.[0]?.content || "拍照提问", value);
      app.go("ai/" + value.id);
      if (value.job && ["queued", "running"].includes(value.job.status))
        watch(value.job.id);
    } catch (problem) {
      if (turn === generation) error = problem.message;
    } finally {
      if (turn === generation) {
        uploading = false;
        changed();
      }
    }
  }
  function fresh() {
    remember();
    contextOpening = null;
    generation++;
    controller?.abort();
    session = null;
    loading = false;
    error = "";
    draft = "";
    sending = false;
    lastContext = null;
    write("last", "");
    app.go("ai");
  }
  function currentRaw() {
    return embeddedContext() || session?.context || lastContext || {};
  }
  function prepare(raw) {
    resetActor();
    remember();
    contextOpening = null;
    generation++;
    controller?.abort();
    session = null;
    loading = false;
    error = "";
    draft = "";
    sending = false;
    lastContext = currentContext(raw);
    lastContext.label = raw.label || "";
    write("last", "");
  }
  document.addEventListener("input", (event) => {
    if (!app) return;
    if (event.target.id === "study-chat-input") {
      draft = event.target.value;
      remember();
    }
  });
  document.addEventListener(
    "scroll",
    (event) => {
      if (
        !app ||
        actor !== uid() ||
        !session ||
        event.target.id !== "chat-messages"
      )
        return;
      const log = event.target;
      write(
        "position:" + session.id,
        JSON.stringify({
          top: log.scrollTop,
          following: log.scrollHeight - log.scrollTop - log.clientHeight < 90,
        }),
      );
    },
    true,
  );
  document.addEventListener("submit", (event) => {
    if (!app) return;
    if (event.target.id === "study-chat-form") {
      event.preventDefault();
      send(draft, currentRaw());
    }
    if (event.target.id === "study-history-search") {
      event.preventDefault();
      search = event.target.elements.search.value.trim();
      history = null;
      loadHistory();
    }
  });
  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || !app || button.disabled) return;
    const d = button.dataset;
    if ("practiceChatRetry" in d) {
      practiceError = "";
      changed();
      return;
    }
    if ("studyNew" in d) {
      fresh();
      return;
    }
    if ("studyHistory" in d || "studyPictureHistory" in d) {
      remember();
      history = null;
      lastRoute = "";
      app.go("ai/history" + ("studyPictureHistory" in d ? "/pictures" : ""));
      return;
    }
    if ("studyBack" in d) {
      app.go("ai" + (session ? "/" + session.id : ""));
      return;
    }
    if (d.studyOpen) {
      open(d.studyOpen);
      return;
    }
    if ("studyFilter" in d) {
      history = null;
      lastRoute = "";
      app.go("ai/history" + (d.studyFilter ? "/" + d.studyFilter : ""));
      return;
    }
    if ("studyMore" in d) {
      loadHistory(true);
      return;
    }
    if ("studyHistoryRetry" in d) {
      loadHistory();
      return;
    }
    if ("studyRetry" in d) {
      if (embeddedContext() && !matchesPractice(currentContext(embeddedContext()))) {
        error = "";
        changed();
      } else if (session?.job?.status === "error")
        send(session.job.prompt, currentRaw(), true);
      else if (session?.job) watch(session.job.id);
      else if (draft) send(draft, currentRaw());
      else if (session) load(session.id);
      return;
    }
    if ("studyImage" in d && session?.imageUrl) {
      window.BX_IMAGES.open(app, session.imageUrl, "题目原图");
      return;
    }
    if ("studyZoom" in d) {
      button.closest(".study-image-viewer")?.classList.toggle("zoomed");
      return;
    }
    const latest =
      session?.messages.filter((m) => m.data?.items).at(-1)?.data ||
      session?.job?.analysis;
    if (d.studyHint !== undefined && latest?.items?.[Number(d.studyHint)]) {
      const item = latest.items[Number(d.studyHint)],
        card = button.closest("[data-study-card]");
      window.BX_HINTS?.show(card, item.hints, {
        key: session.id + ":" + d.studyHint,
      });
      return;
    }
    if (
      d.studyDiscuss !== undefined &&
      latest?.items?.[Number(d.studyDiscuss)]
    ) {
      const item = latest.items[Number(d.studyDiscuss)];
      draft = "我想继续做第" + item.number + "题：" + item.stem + "。";
      remember();
      changed();
      document.querySelector("#study-chat-input")?.focus();
    }
  });
  window.BX_STUDY = {
    connect(value) {
      app = value;
    },
    page,
    scanPage,
    send,
    resumeContext,
    practicePanel,
    askPractice,
    upload,
    fresh,
    open,
    prepare,
    current: () => session,
    context: currentRaw,
    position() {
      try {
        return session
          ? JSON.parse(read("position:" + session.id, "null"))
          : null;
      } catch (_) {
        return null;
      }
    },
  };
})();
