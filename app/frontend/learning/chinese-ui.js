(function () {
  "use strict";
  let app,
    actor = "",
    generation = 0,
    kind = "characters",
    search = "",
    page = 1,
    result = null,
    detail = null,
    loading = false,
    error = "",
    size = 22,
    readyKey = "";
  const esc = (x) => app.esc(x),
    identity = () => String(app.user()?.id || ""),
    key = () => [actor, kind, search, page, app.route()[1] || ""].join(":");
  function update() {
    if (identity() === actor && app.route()[0] === "chinese") app.render();
  }
  function reset() {
    const next = identity();
    if (next === actor) return;
    actor = next;
    generation++;
    result = null;
    detail = null;
    loading = false;
    error = "";
    search = "";
    page = 1;
    readyKey = "";
    try {
      size = Number(localStorage.getItem("bx-chinese-font:" + actor)) || 22;
    } catch (_) {}
    if (![18, 20, 22, 24, 28].includes(size)) size = 22;
  }
  async function load() {
    if (loading) return;
    loading = true;
    error = "";
    const owner = actor,
      turn = ++generation,
      stamp = key(),
      id = app.route()[1];
    try {
      const data = await app.api(
        id
          ? "/api/chinese/items/" + encodeURIComponent(id)
          : "/api/chinese/items?kind=" +
              kind +
              "&q=" +
              encodeURIComponent(search) +
              "&page=" +
              page,
      );
      if (owner !== identity() || turn !== generation || stamp !== key())
        return;
      if (id) detail = data;
      else result = data;
      readyKey = stamp;
    } catch (_) {
      if (owner === identity() && turn === generation && stamp === key()) {
        error = "这份内容暂时没有打开，请再试一次。";
        readyKey = stamp;
      }
    } finally {
      if (owner === identity() && turn === generation) {
        loading = false;
        update();
      }
    }
  }
  function pageView(value) {
    app = value;
    reset();
    const stamp = key();
    if (readyKey !== stamp && !loading) queueMicrotask(load);
    const id = app.route()[1],
      item = id && readyKey === stamp ? detail : null,
      rows = !id && readyKey === stamp ? result : null;
    const toolbar = `<header class="chinese-toolbar"><button class="text-action" data-chinese-back>${id ? "‹ 总目录" : "我的教材"}</button><strong>语文乐园</strong><button class="text-action" data-chinese-font aria-label="调整阅读字号">Aa 字号</button></header>`;
    if (id)
      return `${toolbar}<section class="chinese-reading ${item?.kind === "poems" ? "is-poem" : ""}" style="--chinese-font:${size}px">${item?.kind === "characters" ? (item.learning ? window.BX_CHARACTERS.view(item.learning, app) : `<section class="character-learning"><header class="character-title"><h1>${esc(item.title)}</h1><strong>${esc((item.pinyin || "").split(" / ")[0])}</strong></header><p class="character-preview-note">这个字的辞书释义和词中读音尚未核对完成。</p></section>`) : item ? `<article class="chat-rich">${window.BX_CHAT?.markdown(item.markdown) || esc(item.markdown)}</article><details class="chinese-sources"><summary>教材来源与读音说明</summary>${item.sources.map((s) => `<p>${esc(s.title || s.version || "原教材")} · ${esc(s.kind || "原文")}${s.page ? " · 阅读第" + esc(s.page) + "页" : ""}</p>`).join("")}<p>多音字列出可能的读音，请结合所在词语和教材原句辨认。</p></details>` : error ? errorView() : '<p role="status">正在打开正文…</p>'}</section>`;
    return `${toolbar}<div class="chinese-home"><div class="chinese-tabs" role="group" aria-label="语文内容"><button class="${kind === "characters" ? "active" : ""}" data-chinese-kind="characters"><img src="assets/brand/chinese-characters.svg" alt="" aria-hidden="true"><strong>生字总库</strong></button><button class="${kind === "poems" ? "active" : ""}" data-chinese-kind="poems"><img src="assets/brand/chinese-poems.svg" alt="" aria-hidden="true"><strong>古诗文</strong></button></div><form id="chinese-search"><input name="search" maxlength="60" value="${esc(search)}" placeholder="查一个字、拼音、诗名或作者" aria-label="搜索语文内容"><button class="secondary" type="submit">搜索</button></form>${error ? errorView() : rows ? `<p class="chinese-count">${search ? "找到" : "已整理"} ${rows.total} ${kind === "characters" ? "个字" : "篇"} · ${page}/${rows.pages}页</p><div class="chinese-${kind === "characters" ? "character-grid" : "poem-list"}">${rows.items.map((v) => `<button data-go="chinese/${v.id}">${kind === "characters" ? `<small>${esc((v.pinyin || "").split(" / ")[0])}</small><strong>${esc(v.title)}</strong>` : `<strong>${esc(v.title)}</strong><small>${esc([v.era, v.author].filter(Boolean).join(" · "))}</small>`}</button>`).join("") || '<p class="chinese-empty">还没有符合的已核对内容，可以换个词再查。</p>'}</div>${rows.pages > 1 ? `<nav class="chinese-pagination" aria-label="内容分页"><button class="secondary" data-chinese-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>上一页</button><span>${page}/${rows.pages}</span><button class="secondary" data-chinese-page="${page + 1}" ${page >= rows.pages ? "disabled" : ""}>下一页</button></nav>` : ""}` : '<p role="status">正在整理目录…</p>'}</div>`;
  }
  function errorView() {
    return `<p class="error-banner">${esc(error)} <button data-chinese-retry>重新打开</button></p>`;
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest?.("button");
    if (!app || !b || b.disabled || app.route()[0] !== "chinese") return;
    if (identity() !== actor) {
      app.close?.();
      return;
    }
    const d = b.dataset;
    if ("chineseBack" in d) {
      generation++;
      loading = false;
      app.go(app.route()[1] ? "chinese" : "library");
    }
    if ("chineseKind" in d) {
      generation++;
      loading = false;
      kind = d.chineseKind === "poems" ? "poems" : "characters";
      page = 1;
      error = "";
      update();
    }
    if ("chinesePage" in d) {
      page = Math.max(1, Number(d.chinesePage) || 1);
      error = "";
      update();
    }
    if ("chineseRetry" in d) {
      readyKey = "";
      error = "";
      update();
    }
    if ("chineseFont" in d)
      app.modal(
        "阅读字号",
        `<div class="chinese-font-options">${[18, 20, 22, 24, 28].map((v) => `<button class="${v === size ? "primary" : "secondary"}" data-chinese-size="${v}" aria-pressed="${v === size}">${v}号</button>`).join("")}</div>`,
      );
    if ("chineseSize" in d) {
      const next = Number(d.chineseSize);
      if (![18, 20, 22, 24, 28].includes(next)) return;
      size = next;
      try {
        localStorage.setItem("bx-chinese-font:" + actor, String(size));
      } catch (_) {}
      app.close?.();
      update();
    }
  });
  document.addEventListener("submit", (e) => {
    if (e.target.id !== "chinese-search" || !app) return;
    e.preventDefault();
    search = String(new FormData(e.target).get("search") || "")
      .trim()
      .slice(0, 60);
    page = 1;
    generation++;
    loading = false;
    error = "";
    update();
  });
  window.BX_CHINESE = { page: pageView };
})();
