(function () {
  "use strict";
  let app,
    owner = "";
  const learning = [
    ["library", "book-open", "我的教材"],
    ["arena", "pencil", "爪爪竞技场"],
    ["chinese", "book-open", "语文乐园"],
    ["dictation", "headphones", "听写小站"],
  ];
  function replaceRoute(path) {
    if (
      !window.history?.replaceState ||
      typeof window.dispatchEvent !== "function" ||
      typeof Event !== "function"
    )
      return false;
    app?.capture?.();
    const previous = window.history.state;
    window.history.replaceState(
      {
        ...(previous && typeof previous === "object" ? previous : {}),
        banxuepaw: true,
        route: path,
      },
      "",
      "#/" + path,
    );
    window.dispatchEvent(new Event("hashchange"));
    return true;
  }
  function open() {
    if (!app?.user()) return;
    const user = app.user();
    owner = String(user.id);
    const parent = user.role === "parent",
      admin = user.role === "admin" && app.route()[0] === "admin";
    const top = parent
      ? [
          ["parent/today", "users", "孩子概览"],
          ["parent/report", "chart", "学习报告"],
          ["parent/report/questions", "messages-square", "孩子提问"],
          ["parent/books", "book-open", "教材与答案"],
        ]
      : admin
        ? [
            ["admin/overview", "chart", "数据概览"],
            ["admin/users", "users", "用户管理"],
            ["admin/notifications", "bell", "通知管理"],
            ["admin/books", "book-open", "教材与资料"],
            ["admin/questions", "pencil", "题目核对"],
            ["admin/ai", "settings", "AI自动路由"],
          ]
        : learning;
    const resume = !parent && !admin ? app.resume?.() : null;
    const records = parent
      ? [
          ["ai/history", "messages-square", "我的答疑记录"],
          ["profile", "user-round", "个人中心"],
        ]
      : admin
        ? [
            ["admin/membership", "shield-check", "会员与兑换码"],
            ["arena", "pencil", "查看爪爪竞技场"],
            ["home", "home", "回到学习页"],
          ]
        : [
            ["ai/history", "messages-square", "提问历史"],
            ["growth", "chart-column", "学习足迹"],
            ["leaderboard", "users", "爪爪排行榜"],
            ["vip", "shield-check", "会员中心"],
          ];
    const tiles = top
      .map(
        ([path, icon, label]) =>
          `<button class="nav-feature" data-site-go="${path}"><span class="nav-feature-icon">${app.ico(icon)}</span><strong>${app.esc(label)}</strong></button>`,
      )
      .join("");
    const rows = records
      .map(
        ([path, icon, label]) =>
          `<button class="nav-record" data-site-go="${path}">${app.ico(icon, "small")}<span>${app.esc(label)}</span>${app.ico("chevron-right", "small")}</button>`,
      )
      .join("");
    app.modal(
      "学习导航",
      `<div class="site-nav-sheet"><p class="nav-greeting">${parent ? "陪孩子，把每一步看清楚" : admin ? "教材、账号和服务管理" : app.esc(user.child_name || "小朋友") + "，今天想学什么？"}</p>${resume?.id ? `<button class="nav-resume" data-site-go="arena/question/${resume.id}"><span><strong>继续上次</strong><small>${app.esc(resume.title || "章节练习")}</small></span>${app.ico("arrow-right", "small")}</button>` : ""}<section aria-label="常用学习功能"><h3>${admin ? "管理功能" : "去学习"}</h3><div class="nav-feature-grid">${tiles}</div></section><section aria-label="学习记录"><h3>${admin ? "快捷入口" : "我的记录"}</h3>${rows}</section><div class="nav-account">${!parent && !admin ? '<button data-site-go="profile">个人中心</button><button data-site-go="family">家庭绑定</button>' : ""}${user.role === "admin" && !admin ? '<button data-site-go="admin/overview">管理后台</button>' : ""}</div><footer class="nav-footer"><button data-site-go="${parent ? "parent/today" : "home"}">${app.ico("home", "small")}返回首页</button><button data-site-end>${app.ico("log-out", "small")}结束学习</button></footer></div>`,
    );
    document
      .querySelector("#modal-root .modal")
      ?.classList.add("site-nav-modal");
  }
  document.addEventListener("click", (event) => {
    const b = event.target.closest?.("button");
    if (!app || !b) return;
    const d = b.dataset;
    if (!("siteGo" in d) && !("siteEnd" in d)) return;
    if (String(app.user()?.id || "") !== owner) {
      app.close?.();
      return;
    }
    if ("siteGo" in d) {
      app.go(d.siteGo);
      return;
    }
    if ("siteEnd" in d) {
      b.disabled = true;
      Promise.resolve(app.finish?.())
        .then((synced) => {
          app.go(app.user()?.role === "parent" ? "parent/today" : "home");
          app.toast(
            synced === false
              ? "进度已保存在本机，联网后会继续同步。可以直接关闭网页。"
              : "学习进度已保存，可以直接关闭网页。",
          );
        })
        .finally(() => {
          b.disabled = false;
        });
    }
  });
  window.BX_SITE_NAV = {
    connect(value) {
      app = value;
    },
    open,
    replaceRoute,
  };
})();
