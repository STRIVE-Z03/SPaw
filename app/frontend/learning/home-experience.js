(function () {
  "use strict";
  let app,
    actor = "",
    data = null,
    pending = false,
    failed = false,
    welcoming = false;
  const seen = new Set();
  function owner() {
    return String(app.user()?.id || "");
  }
  function active() {
    return app.route()[0] === "home" && app.user()?.role === "child";
  }
  function page(value) {
    app = value;
    const next = owner();
    if (next !== actor) {
      actor = next;
      data = null;
      pending = false;
      failed = false;
      welcoming = false;
    }
    if (
      data?.date !==
      new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
    ) {
      data = null;
    }
    if (!data && !pending && !failed) queueMicrotask(load);
    if (
      data &&
      active() &&
      !data.welcomeSeen &&
      !welcoming &&
      !seen.has(actor + ":" + data.date)
    )
      queueMicrotask(welcome);
    return data
      ? `<section class="home-daily-quote" aria-label="每日名句"><p>${app.esc(data.quote.text)}</p><small>${app.esc(data.quote.source)} · 每日一句</small></section>`
      : "";
  }
  async function load() {
    if (pending) return;
    pending = true;
    const identity = actor;
    try {
      const result = await app.api("/api/daily");
      if (identity !== owner()) return;
      data = result;
      if (active()) app.render();
    } catch (_) {
      if (identity === owner()) failed = true;
    } finally {
      if (identity === owner()) pending = false;
    }
  }
  async function welcome() {
    if (welcoming || !active() || !data) return;
    const identity = actor,
      key = actor + ":" + data.date;
    welcoming = true;
    seen.add(key);
    try {
      const result = await app.api("/api/daily/welcome", {});
      if (identity !== owner() || !active() || !result.show) return;
      data.welcomeSeen = true;
      const name = app.esc(app.user().child_name || "小朋友");
      app.modal(
        "今天的小小开始",
        `<div class="daily-welcome"><button class="text-action daily-welcome-skip" data-action="close-modal">跳过</button><img src="assets/brand/paw-mascot.png" alt="爪爪向你招手"><h2>欢迎${name}${name.endsWith("小朋友") ? "" : "小朋友"}</h2><h3>来到爪爪乐园学习</h3><p>${app.esc(data.quote.meaning)}</p><button class="primary block" data-action="close-modal">开始学习</button></div>`,
      );
      document
        .querySelector("#modal-root .modal")
        ?.classList.add("daily-welcome-modal");
    } catch (_) {
      /* A greeting must never block a child's lesson. */
    } finally {
      if (identity === owner()) welcoming = false;
    }
  }
  window.BX_HOME_EXPERIENCE = { page };
})();
