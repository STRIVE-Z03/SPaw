(function () {
  "use strict";
  let app,
    owner = "",
    status = null,
    loading = false,
    error = "",
    admin = null,
    codes = [],
    adminLoading = false,
    codeFilter = "",
    codeSearch = "",
    codeOffset = 0,
    codeHasMore = false,
    userSearch = "",
    userOffset = 0,
    generated = [],
    generatedBatch = "";
  const e = (v) => app.esc(v),
    actor = () => app.user(),
    child = () =>
      actor()?.role === "parent"
        ? app.childId() ||
          (app.children().length === 1 ? app.children()[0].id : null)
        : null;
  const key = () => String(actor()?.id || "") + ":" + String(child() || "");
  function reset() {
    if (owner === key()) return;
    owner = key();
    status = null;
    admin = null;
    codes = [];
    error = "";
    loading = false;
    adminLoading = false;
    generated = [];
  }
  const date = (n) =>
    n
      ? new Intl.DateTimeFormat("zh-CN", {
          timeZone: "Asia/Shanghai",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(n * 1000))
      : "—";
  const dateTime = (n) =>
    n
      ? new Intl.DateTimeFormat("zh-CN", {
          timeZone: "Asia/Shanghai",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(new Date(n * 1000))
      : "—";
  const level = (t) =>
    ({ free: "免费用户", vip: "VIP", svip: "SVIP" })[t] || "免费用户";
  async function refresh() {
    reset();
    if (loading) return;
    const current = owner;
    loading = true;
    error = "";
    try {
      if (actor()?.role === "parent" && !child())
        throw new Error("请先在家长中心选择已绑定的宝宝。");
      let suffix = child() ? "?childId=" + encodeURIComponent(child()) : "";
      let result = await app.api("/api/membership" + suffix);
      if (owner === current) status = result;
    } catch (err) {
      if (owner === current) error = err.message;
    } finally {
      if (owner === current) {
        loading = false;
        app.render();
      }
    }
  }
  async function refreshAdmin() {
    reset();
    if (adminLoading) return;
    adminLoading = true;
    const current = owner;
    try {
      const [info, list] = await Promise.all([
        app.api(
          "/api/admin/membership?search=" +
            encodeURIComponent(userSearch) +
            "&offset=" +
            userOffset,
        ),
        app.api(
          "/api/admin/membership/codes?status=" +
            encodeURIComponent(codeFilter) +
            "&search=" +
            encodeURIComponent(codeSearch) +
            "&offset=" +
            codeOffset,
        ),
      ]);
      if (owner === current) {
        admin = info;
        codes = list.codes;
        codeHasMore = list.hasMore;
        error = "";
      }
    } catch (err) {
      if (owner === current) error = err.message;
    } finally {
      if (owner === current) {
        adminLoading = false;
        app.render();
      }
    }
  }
  function ensure() {
    reset();
    if (!status && !loading && !error) queueMicrotask(refresh);
  }
  function gate(feature) {
    if (actor()?.role === "admin") return "";
    ensure();
    if (error)
      return `<div class="vip-page"><h1>会员状态暂不可用</h1><p>${e(error)}</p><button class="vip-outline" data-vip-refresh>重试</button></div>`;
    if (!status)
      return '<div class="vip-page"><h1>正在读取会员状态…</h1></div>';
    if (status.tier === "free")
      return `<div class="vip-page"><section class="vip-card vip-current"><strong>${feature === "arena" ? "竞技场" : "听写小站"}为会员专享</strong><p>教材阅读始终免费。兑换 VIP 或 SVIP 后即可使用。</p><button class="vip-primary" data-go="vip">查看会员</button><button class="vip-outline" data-go="home">返回学习</button></section></div>`;
    return "";
  }
  function homeBadge() {
    if (actor()?.role === "child") ensure();
    const tier = status?.tier || "free";
    const name = status ? level(tier) : "会员中心";
    return `<button type="button" class="vip-home-entry" data-go="vip" aria-label="${e(name)}，进入会员中心"><span class="vip-badge vip-badge-${tier}" aria-hidden="true"><svg viewBox="0 0 100 78" xmlns="http://www.w3.org/2000/svg"><path class="vip-badge-outer" d="M10 31Q7 9 14 6Q23 3 37 15Q50 8 63 15Q77 3 86 6Q93 9 90 31Q97 40 95 51Q93 72 75 74H25Q7 72 5 51Q3 40 10 31Z"/><path class="vip-badge-inner" d="M11 47Q14 29 31 25Q50 16 69 25Q86 29 89 47Q89 66 72 68H28Q11 66 11 47Z"/><g class="vip-badge-paw"><ellipse cx="40" cy="19" rx="3.5" ry="4.2"/><ellipse cx="48" cy="15" rx="3.5" ry="4.2"/><ellipse cx="56" cy="15" rx="3.5" ry="4.2"/><ellipse cx="64" cy="19" rx="3.5" ry="4.2"/><path d="M43 26Q47 20 52 21Q57 20 61 26Q64 33 57 32Q52 30 47 32Q40 33 43 26Z"/></g><text class="vip-badge-word" x="50" y="56" text-anchor="middle">${tier === "svip" ? "SVIP" : "VIP"}</text></svg></span><span>会员中心</span></button>`;
  }
  function profile() {
    ensure();
    let label = status
      ? status.expired
        ? "会员已到期"
        : level(status.tier)
      : error
        ? "状态不可用"
        : "正在读取";
    let message =
      error ||
      (status?.expires
        ? "有效期至 " + date(status.expires)
        : "教材免费，更多学习功能等你探索");
    return `<section class="vip-profile-card"><div class="vip-heading"><strong>✦ 爪爪会员</strong><span>${e(label)}</span></div><p>${e(message)}</p><button class="vip-outline" data-go="vip">查看会员与额度</button></section>`;
  }
  function benefit(name, value = "") {
    return `<div class="vip-benefit"><span aria-hidden="true">✓</span><strong>${e(name)}</strong>${value ? `<small>${e(value)}</small>` : ""}</div>`;
  }
  function plan(tier) {
    let paid = tier !== "free",
      v = tier === "vip",
      active = status?.tier === tier,
      config = status?.purchases?.find((p) => p.tier === tier && p.enabled);
    return `<section class="vip-plan vip-plan-${tier}"><div class="vip-plan-head"><strong>${tier === "free" ? "Free" : tier.toUpperCase()}</strong><small>${paid ? "价格待定 · 兑换码开通" : "免费使用"}</small>${active ? "<span>当前方案</span>" : v ? "<span>推荐</span>" : ""}</div>${benefit("教材免费阅读")}${paid ? benefit("普通 AI / 搜题", "每月共 " + (v ? 300 : 800) + " 次") + benefit("听写词语", "每月 " + (v ? 500 : 1500) + " 个词") + benefit("竞技场与竞技场 AI", "AI 每月 " + (v ? 300 : 500) + " 次") : benefit("拍题 / 检查作业", "每天共 5 次") + benefit("普通 AI", "每月 15 次") + benefit("听写与竞技场", "会员专享")}${paid ? `<button class="vip-primary" data-vip-buy="${tier}" ${config ? "" : "disabled"}>${config ? "购买兑换码" : "购买渠道暂未开放"}</button>` : ""}</section>`;
  }
  function quotas() {
    if (!status) return "";
    const labels = {
      scan: "今日拍题 / 检查作业",
      ai: "本月普通 AI",
      general: "普通 AI / 搜题",
      dictation: "听写词语",
      arena: "竞技场 AI",
    };
    return `<section class="vip-card vip-quota">${Object.entries(
      status.quotas || {},
    )
      .map(
        ([name, q]) =>
          `<div><span><strong>${e(labels[name] || name)}</strong><small>${name === "scan" ? "每天零点" : "每月 1 日"}重置</small></span><b>${q.remaining} / ${q.limit} ${name === "dictation" ? "个" : "次"}</b></div>`,
      )
      .join("")}</section>`;
  }
  function page() {
    ensure();
    if (error && !status)
      return `<div class="vip-page"><h1>爪爪会员</h1><p class="error-banner">${e(error)}</p><button class="vip-outline" data-vip-refresh>重试</button></div>`;
    return `<div class="vip-page"><header class="vip-page-title"><h1>爪爪会员</h1><p>选择适合自己的学习额度</p></header><div class="vip-plans">${["free", "vip", "svip"].map(plan).join("")}</div><button class="vip-outline" data-vip-redeem>我有兑换码</button><p class="vip-note">购买后返回此页面，使用兑换码开通。</p>${status ? `<section class="vip-card vip-current"><strong>${e(level(status.tier))}${status.expires ? " · 有效期至 " + date(status.expires) : status.expired ? " · 会员已到期" : ""}</strong><p>以下为当前账号的真实剩余额度</p></section>${quotas()}` : ""}</div>`;
  }
  const statusLabel = (s) =>
    ({
      used: "已使用",
      unused: "未使用",
      expired: "已过期",
      disabled: "已停用",
    })[s] || s;
  const auditLabel = (s) =>
    ({
      generate: "生成兑换码",
      redeem: "兑换会员",
      disable: "停用兑换码",
      enable: "恢复兑换码",
      delete: "删除兑换码",
      edit: "编辑兑换码",
      purchase_config: "修改购买配置",
      set_membership: "设置用户会员",
      export: "导出兑换码",
    })[s] || s;
  function adminPage() {
    reset();
    if (!admin && !adminLoading && !error) queueMicrotask(refreshAdmin);
    if (!admin)
      return `<div class="vip-page"><h1>会员与兑换码</h1><p>${e(error || "正在读取…")}</p><button data-vip-admin-refresh>重新读取</button></div>`;
    const entries = codes
      .map(
        (c) =>
          `<article class="vip-admin-item"><div class="vip-heading"><strong>${e(c.batch)}</strong><span>${e(statusLabel(c.status))}</span></div><p>兑换码 · ••••${e(c.suffix)}　${e(c.tier.toUpperCase())} · ${c.days} 天</p><small>截止：${e(dateTime(c.expires))}　${c.used_by ? "使用账号：" + e(c.username || c.used_by) + " · " + e(dateTime(c.used_at)) : "尚未使用"}</small><div class="vip-inline-actions"><button data-vip-detail="${c.id}">查看详情</button>${c.status !== "used" ? `<button data-vip-edit="${c.id}">编辑</button><button data-vip-toggle="${c.id}" data-value="${c.disabled ? "enable" : "disable"}">${c.disabled ? "恢复" : "停用"}</button><button data-vip-delete="${c.id}">删除</button>` : ""}</div></article>`,
      )
      .join("");
    return `<div class="vip-page vip-admin"><header class="vip-page-title"><h1>会员与兑换码</h1><p>会员管理 · 兑换码 · 购买配置 · 操作记录</p></header><section class="vip-card"><h2>会员管理</h2><p class="vip-note">宝宝账号与本月用量</p><form id="vip-user-filter" class="vip-filters"><input name="search" aria-label="搜索宝宝账号" placeholder="搜索宝宝账号或名字" value="${e(userSearch)}"><button>搜索</button></form>${
      admin.users
        .map(
          (u) =>
            `<article class="vip-admin-item"><div class="vip-heading"><strong>${e(u.child_name)} · ${e(u.username)}</strong><span>${e(u.membership.expired ? "已到期 · " + level(u.membership.lastTier) : level(u.membership.tier))}</span></div><small>到期：${e(date(u.membership.expires || u.membership.lastExpires))}</small><p>${Object.entries(
              u.membership.quotas,
            )
              .map(
                ([k, q]) =>
                  e(
                    {
                      scan: "今日拍题",
                      ai: "普通 AI",
                      general: "普通 AI / 搜题",
                      dictation: "听写",
                      arena: "竞技场 AI",
                    }[k] || k,
                  ) +
                  " " +
                  q.used +
                  "/" +
                  q.limit,
              )
              .join(
                "　",
              )}</p><button type="button" data-vip-set-user="${u.id}">设置会员</button></article>`,
        )
        .join("") || "<p>暂无宝宝账号</p>"
    }<div class="vip-inline-actions"><button data-vip-user-page="previous" ${userOffset === 0 ? "disabled" : ""}>上一页</button><button data-vip-user-page="next" ${admin.usersHasMore ? "" : "disabled"}>下一页</button></div></section><section class="vip-card"><div class="vip-heading"><h2>兑换码列表</h2><button class="vip-small-primary" data-vip-generate>批量生成</button></div><form id="vip-code-filter" class="vip-filters"><input name="search" aria-label="搜索兑换码批次或账号" placeholder="搜索批次或账号" value="${e(codeSearch)}"><select name="status" aria-label="兑换码状态">${[
      ["", "全部状态"],
      ["unused", "未使用"],
      ["used", "已使用"],
      ["expired", "已过期"],
      ["disabled", "已停用"],
    ]
      .map(
        ([v, t]) =>
          `<option value="${v}" ${v === codeFilter ? "selected" : ""}>${t}</option>`,
      )
      .join(
        "",
      )}</select><button>搜索</button></form><div class="vip-code-list">${entries || '<p class="vip-note">没有符合条件的兑换码</p>'}</div><div class="vip-inline-actions"><button data-vip-code-page="previous" ${codeOffset === 0 ? "disabled" : ""}>上一页</button><button data-vip-code-page="next" ${codeHasMore ? "" : "disabled"}>下一页</button></div></section><section class="vip-card"><div class="vip-heading"><h2>第三方购买配置</h2><button data-vip-config>编辑配置</button></div>${[
      "vip",
      "svip",
    ]
      .map((t) => {
        let p = admin.purchases.find((x) => x.tier === t);
        return `<article class="vip-admin-item"><strong>${t.toUpperCase()}</strong><p>${e(p?.platform || "平台未配置")} · ${p?.enabled ? "已启用" : "未启用"}</p><small>${e(p?.url || "尚未设置购买地址")}</small><p>${e(p?.instructions || "尚未设置取码说明")}</p></article>`;
      })
      .join(
        "",
      )}</section><section class="vip-card"><h2>操作记录</h2>${admin.audit.map((a) => `<div class="vip-audit"><small>${e(dateTime(a.at))} · ${e(a.username || "管理员")}</small><span>${e(auditLabel(a.action))} · ${e(a.target)}</span></div>`).join("") || "<p>暂无记录</p>"}</section></div>`;
  }
  function redeemModal() {
    let target =
      child() && app.children().find((c) => String(c.id) === String(child()));
    app.modal(
      "兑换码兑换",
      `<form id="vip-redeem-form" class="vip-form"><p>目标账号：<strong>${e(target?.child_name || actor().child_name)} · ${e(target?.username || actor().username)}</strong></p><label>兑换码<input name="code" autocomplete="off" maxlength="40" required placeholder="请输入兑换码"></label><p>兑换前请核对宝宝账号；不同等级的会员请在当前会员到期后兑换。</p><button class="vip-primary" type="submit">确认兑换</button></form>`,
    );
  }
  function setUserModal(u) {
    const current = u.membership,
      local = current.expires
        ? new Date(current.expires * 1000 + 8 * 3600000)
            .toISOString()
            .slice(0, 16)
        : "";
    app.modal(
      "设置宝宝会员",
      `<form id="vip-set-user-form" class="vip-form"><input type="hidden" name="id" value="${u.id}"><p>宝宝：<strong>${e(u.child_name)} · ${e(u.username)}</strong></p><label>会员等级<select name="tier"><option value="free" ${current.tier === "free" ? "selected" : ""}>免费（取消会员）</option><option value="vip" ${current.tier === "vip" ? "selected" : ""}>VIP</option><option value="svip" ${current.tier === "svip" ? "selected" : ""}>SVIP</option></select></label><label>到期时间（北京时间）<input name="expires" type="datetime-local" value="${e(local)}"></label><p>选择免费或勾选下方“取消会员”立即恢复免费版；会员额度按当前等级计算，已有用量不会清空。</p><label class="vip-check"><input type="checkbox" name="cancel">取消会员（到期时间设为 0）</label><button class="vip-primary" type="submit">保存设置</button></form>`,
    );
  }
  function generateModal() {
    app.modal(
      "批量生成兑换码",
      `<form id="vip-generate-form" class="vip-form"><label>批次名称<input name="batch" maxlength="80" required></label><label>会员类型<select name="tier"><option value="vip">VIP</option><option value="svip">SVIP</option></select></label><label>会员时长（天）<input name="days" type="number" min="1" max="3660" value="30" required></label><label>生成数量<input name="quantity" type="number" min="1" max="1000" value="1" required></label><label>兑换截止时间（北京时间，可选）<input name="expires" type="datetime-local"></label><label>备注<input name="note" maxlength="200"></label><p>兑换成功后开始计算会员时长。</p><button class="vip-primary" type="submit">确认并生成</button></form>`,
    );
  }
  function configModal() {
    app.modal(
      "第三方购买配置",
      `<div class="vip-config-list">${["vip", "svip"]
        .map((t) => {
          const p = admin.purchases.find((x) => x.tier === t) || {};
          return `<form class="vip-form" data-vip-config-form="${t}"><h3>${t.toUpperCase()}</h3><label>平台名称<input name="platform" value="${e(p.platform || "")}" maxlength="80"></label><label>HTTPS 购买地址<input name="url" type="url" value="${e(p.url || "")}" maxlength="1000"></label><label>购买后取码说明<textarea name="instructions" maxlength="1000">${e(p.instructions || "")}</textarea></label><label class="vip-check"><input name="enabled" type="checkbox" ${p.enabled ? "checked" : ""}>启用购买入口</label><button class="vip-primary" type="submit">保存 ${t.toUpperCase()} 配置</button></form>`;
        })
        .join("")}</div>`,
    );
  }
  function editModal(c) {
    const local = c.expires
      ? new Date(c.expires * 1000 + 8 * 3600000).toISOString().slice(0, 16)
      : "";
    app.modal(
      "编辑兑换码",
      `<form id="vip-edit-form" class="vip-form"><input type="hidden" name="id" value="${c.id}"><p>${e(c.batch)} · ••••${e(c.suffix)}</p><label>兑换截止时间（北京时间，可选）<input type="datetime-local" name="expires" value="${e(local)}"></label><label>备注<input name="note" maxlength="200" value="${e(c.note)}"></label><button class="vip-primary">保存</button></form>`,
    );
  }
  function beijing(value) {
    if (!value) return null;
    const result = Date.parse(value + ":00+08:00");
    if (!Number.isFinite(result)) throw new Error("兑换截止时间不正确");
    return Math.floor(result / 1000);
  }
  document.addEventListener("click", async (event) => {
    if (!app) return;
    const b = event.target.closest("button");
    if (!b || b.disabled) return;
    let d = b.dataset;
    try {
      if ("vipRefresh" in d) {
        error = "";
        await refresh();
      }
      if ("vipAdminRefresh" in d) {
        error = "";
        await refreshAdmin();
      }
      if ("vipRedeem" in d) redeemModal();
      if (d.vipBuy) {
        const p = status?.purchases?.find(
          (x) => x.tier === d.vipBuy && x.enabled,
        );
        if (!p) return;
        if (
          !window.confirm(
            `即将前往${p.platform || "第三方平台"}购买兑换码。购买后请返回个人中心 → 爪爪会员 → 兑换码兑换。\n${p.instructions || ""}`,
          )
        )
          return;
        let u = new URL(p.url);
        if (u.protocol !== "https:") throw new Error("购买地址不可用");
        window.open(u.href, "_blank", "noopener,noreferrer");
      }
      if (d.vipCodePage) {
        codeOffset = Math.max(
          0,
          codeOffset + (d.vipCodePage === "next" ? 50 : -50),
        );
        await refreshAdmin();
      }
      if (d.vipUserPage) {
        userOffset = Math.max(
          0,
          userOffset + (d.vipUserPage === "next" ? 50 : -50),
        );
        await refreshAdmin();
      }
      if (d.vipSetUser) {
        const u = admin?.users.find((x) => x.id === Number(d.vipSetUser));
        if (u) setUserModal(u);
      }
      if ("vipGenerate" in d) generateModal();
      if ("vipConfig" in d) configModal();
      if (d.vipDetail) {
        const c = codes.find((x) => x.id === Number(d.vipDetail));
        if (c)
          app.modal(
            "兑换码详情",
            `<div class="vip-form"><p>批次：${e(c.batch)}</p><p>兑换码：••••${e(c.suffix)}</p><p>会员：${e(c.tier.toUpperCase())} · ${c.days} 天</p><p>状态：${e(statusLabel(c.status))}</p><p>使用账号：${e(c.username || "尚未使用")}</p><p>兑换时间：${e(dateTime(c.used_at))}</p><p>备注：${e(c.note || "—")}</p></div>`,
          );
      }
      if (d.vipEdit) {
        let c = codes.find((x) => x.id === Number(d.vipEdit));
        if (c) editModal(c);
      }
      if (d.vipToggle || d.vipDelete) {
        let id = Number(d.vipToggle || d.vipDelete),
          action = d.vipDelete ? "delete" : d.value;
        if (
          !window.confirm(
            action === "delete"
              ? "删除后此兑换码将不能兑换，确定删除？"
              : action === "disable"
                ? "确定停用此兑换码？"
                : "确定恢复此兑换码？",
          )
        )
          return;
        await app.api("/api/admin/membership/code", { id, action });
        app.toast("操作成功");
        await refreshAdmin();
      }
      if ("vipDownload" in d) {
        if (!generated.length) return;
        await app.api("/api/admin/membership/export", {
          batch: generatedBatch,
        });
        let blob = new Blob(["\ufeff" + generated.join("\r\n")], {
            type: "text/plain;charset=utf-8",
          }),
          url = URL.createObjectURL(blob),
          a = document.createElement("a");
        a.href = url;
        a.download = "兑换码.txt";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (err) {
      app.toast(err.message);
    }
  });
  document.addEventListener("submit", async (event) => {
    if (!app) return;
    const form = event.target;
    if (
      ![
        "vip-redeem-form",
        "vip-generate-form",
        "vip-code-filter",
        "vip-user-filter",
        "vip-edit-form",
        "vip-set-user-form",
      ].includes(form.id) &&
      !form.dataset.vipConfigForm
    )
      return;
    event.preventDefault();
    let button = form.querySelector('button[type="submit"],button:not([type])');
    if (button?.disabled) return;
    if (button) button.disabled = true;
    try {
      let data = Object.fromEntries(new FormData(form));
      if (form.id === "vip-redeem-form") {
        if (
          !window.confirm(
            "请确认兑换到当前显示的宝宝账号。兑换后不可转移，确定继续？",
          )
        )
          return;
        status = await app.api("/api/membership/redeem", {
          code: data.code,
          childId: child(),
        });
        app.close();
        app.modal(
          "兑换成功",
          `<div class="vip-form"><h3>${e(level(status.tier))} 已开通</h3><p>有效期至 ${e(date(status.expires))}</p><button class="vip-outline" data-go="vip">查看会员额度</button></div>`,
        );
        app.render();
      }
      if (form.id === "vip-generate-form") {
        let payload = {
          batch: data.batch,
          tier: data.tier,
          days: Number(data.days),
          quantity: Number(data.quantity),
          expires: beijing(data.expires),
          note: data.note,
        };
        if (
          !window.confirm(
            `确认生成 ${payload.quantity} 个 ${payload.tier.toUpperCase()} 兑换码，每个有效 ${payload.days} 天？`,
          )
        )
          return;
        let res = await app.api("/api/admin/membership/generate", payload);
        generated = res.codes;
        generatedBatch = payload.batch;
        app.modal(
          "生成成功",
          `<div class="vip-form"><p>已生成 ${generated.length} 个兑换码。完整兑换码仅在本次显示，请立即安全保存。</p><textarea rows="8" readonly aria-label="新生成的兑换码">${e(generated.join("\n"))}</textarea><button class="vip-primary" data-vip-download>下载兑换码</button></div>`,
        );
        await refreshAdmin();
      }
      if (form.id === "vip-code-filter") {
        codeFilter = data.status;
        codeSearch = data.search.trim();
        codeOffset = 0;
        await refreshAdmin();
      }
      if (form.id === "vip-user-filter") {
        userSearch = data.search.trim();
        userOffset = 0;
        await refreshAdmin();
      }
      if (form.id === "vip-set-user-form") {
        const cancel = !!form.elements.cancel.checked || data.tier === "free";
        const expires = cancel ? 0 : beijing(data.expires);
        if (!cancel && !expires) throw new Error("请选择会员到期时间");
        if (
          !window.confirm(
            cancel
              ? "确认取消该宝宝的会员？"
              : "确认更改该宝宝的会员等级与到期时间？",
          )
        )
          return;
        await app.api("/api/admin/membership/set", {
          userId: Number(data.id),
          tier: cancel ? "free" : data.tier,
          expires,
        });
        app.close();
        app.toast("会员设置已保存");
        await refreshAdmin();
      }
      if (form.id === "vip-edit-form") {
        await app.api("/api/admin/membership/code", {
          id: Number(data.id),
          action: "edit",
          note: data.note,
          expires: beijing(data.expires),
        });
        app.close();
        app.toast("已保存");
        await refreshAdmin();
      }
      if (form.dataset.vipConfigForm) {
        await app.api("/api/admin/membership/purchase", {
          tier: form.dataset.vipConfigForm,
          platform: data.platform,
          url: data.url,
          instructions: data.instructions,
          enabled: !!form.elements.enabled.checked,
        });
        app.close();
        app.toast("购买配置已保存");
        await refreshAdmin();
      }
    } catch (err) {
      app.toast(err.message);
    } finally {
      if (button) button.disabled = false;
    }
  });
  window.addEventListener("hashchange", () => {
    status = null;
    error = "";
  });
  window.BX_VIP = {
    connect(value) {
      app = value;
    },
    homeBadge,
    profile,
    page,
    adminPage,
    refresh,
    gate,
    status: () => status,
    update: (value) => {
      status = value;
    },
  };
})();
