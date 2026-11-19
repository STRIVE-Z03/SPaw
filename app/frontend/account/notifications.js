(function () {
  "use strict";

  let app, owner = null, unread = 0, open = false, detail = null;
  let page = 0, list = [], more = false, request = 0, loading = false;
  let revision = 0, statusLoading = false, checkedAt = 0;
  let adminItems = null, adminEdit = null, adminPageIndex = 0, adminHasMore = false;
  let adminRequestId = null, adminBusy = false;
  let previewUrl = "";
  const panel = () => document.querySelector("#notification-panel");
  const displayDate = (at) => new Date(at * 1000).toLocaleString("zh-CN", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });

  function forUser() {
    const current = app.user()?.id ?? null;
    if (owner === current) return !!owner;
    owner = current;
    open = false; unread = 0; checkedAt = 0; request++;
    revision++; statusLoading = false; loading = false;
    detail = null; list = []; adminItems = adminEdit = null; adminPageIndex = 0; adminHasMore = false;
    adminRequestId = null; adminBusy = false;
    clearPreviewImage();
    renderPanel();
    return !!owner;
  }

  function badgeMarkup(count) {
    return count > 99 ? "99+" : String(count);
  }

  function trigger() {
    return [
      '<button type="button" class="round-action notice-trigger" data-notice-toggle aria-label="通知中心" aria-expanded="false" aria-controls="notification-panel">',
      app.ico("bell"), '<span class="notice-badge" data-notice-badge hidden></span></button>',
    ].join("");
  }

  function badges() {
    document.querySelectorAll("[data-notice-toggle]").forEach((button) => {
      const badge = button.querySelector("[data-notice-badge]");
      badge.hidden = unread === 0;
      badge.textContent = unread ? badgeMarkup(unread) : "";
      button.setAttribute("aria-label", unread ? "通知中心，" + unread + " 条未读" : "通知中心");
      button.setAttribute("aria-expanded", String(open));
    });
  }

  async function sync(force = false) {
    if (!forUser()) return;
    badges();
    if (statusLoading || (!force && Date.now() - checkedAt < 30000)) return;
    const account = owner, version = revision;
    checkedAt = Date.now();
    statusLoading = true;
    try {
      const count = await app.api("/api/notifications/unread");
      if (owner === account && revision === version) unread = count.unread;
    } catch {
      // Leave the count visible during a brief network interruption.
    } finally {
      if (owner === account) { statusLoading = false; badges(); }
    }
  }

  function article(title, date, parts, picture) {
    return [
      '<article class="notice-article"><h3>', app.esc(title || "通知标题"), '</h3>',
      date ? '<time>' + app.esc(displayDate(date)) + '</time>' : '',
      picture ? '<img alt="通知配图" src="' + app.esc(picture) + '">' : '',
      parts.map((part) => '<p>' + app.esc(part) + '</p>').join(""),
      '</article>',
    ].join("");
  }

  function renderPanel(problem = "") {
    const element = panel();
    if (!element) return;
    element.hidden = !open;
    badges();
    if (!open) { element.innerHTML = ""; return; }

    const header = '<header><h2 id="notifications-heading">通知</h2><button type="button" data-notice-close aria-label="关闭通知">'+app.ico("x")+'</button></header>';
    const content = detail
      ? '<button class="notice-back" type="button" data-notice-back>‹ 返回列表</button>' +
        article(detail.title, detail.published_at, detail.paragraphs, detail.imageUrl)
      : [
          list.map((item) => [
            '<button type="button" class="notice-row" data-notice-id="', app.esc(item.id), '">',
            item.unread ? '<span class="notice-row-dot" aria-label="未读"></span>' : '',
            '<span class="notice-row-text"><strong>', app.esc(item.title), '</strong><small>',
            app.esc(item.preview), '</small></span><time>', app.esc(displayDate(item.published_at)), '</time></button>',
          ].join("")).join(""),
          !list.length && !loading && !problem ? '<p class="notice-empty">暂时没有通知。</p>' : '',
          more && !loading ? '<button type="button" class="notice-back" data-notice-more>查看更多</button>' : '',
        ].join("");
    element.innerHTML = header + '<div class="notice-scroll">' +
      (problem ? '<p class="notice-empty" role="alert">' + app.esc(problem) + '</p><button class="notice-back" data-notice-retry>重试</button>' : '') +
      content + (loading ? '<p class="notice-empty" role="status">正在加载…</p>' : '') + '</div>';
  }

  async function fetchList(append = false) {
    const account = owner, serial = ++request, target = append ? page + 1 : 0;
    loading = true; detail = null;
    if (!append) { page = 0; list = []; more = false; }
    renderPanel();
    try {
      const data = await app.api("/api/notifications?page=" + target);
      if (serial !== request || owner !== account || !open) return;
      page = target;
      list = append ? [...list, ...data.items] : data.items;
      more = data.more;
      unread = data.unread; revision++;
      loading = false;
      renderPanel();
    } catch {
      if (serial === request && open) { loading = false; renderPanel("通知暂时没能加载。"); }
    }
  }

  async function showNotice(identity) {
    const serial = ++request, account = owner;
    loading = true;
    renderPanel();
    try {
      const data = await app.api("/api/notifications/" + identity + "/read", {});
      if (owner !== account) return;
      unread = data.unread; revision++;
      const item = list.find((entry) => entry.id === identity);
      if (item) item.unread = false;
      if (serial !== request || !open) return badges();
      loading = false; detail = data;
      renderPanel();
      panel().querySelector("[data-notice-back]")?.focus();
    } catch {
      if (serial === request && open) { loading = false; renderPanel("暂时打不开这条通知。"); }
    }
  }

  function close(restore = false) {
    if (!open) return;
    open = false; request++; loading = false; renderPanel();
    if (restore) {
      [...document.querySelectorAll("[data-notice-toggle]")]
        .find((el) => el.getClientRects().length)?.focus();
    }
  }

  function toggle() {
    if (open) { close(true); return; }
    if (!forUser()) return;
    open = true;
    fetchList();
    panel().querySelector("[data-notice-close]")?.focus();
  }

  function adminPage() {
    const item = adminEdit;
    const showPreview = !window.matchMedia("(max-width: 640px)").matches;
    if (!adminItems && !adminBusy) queueMicrotask(loadAdmin);
    return [
      '<section class="notice-admin"><h1>通知管理</h1><p>发布后，通知会出现在所有账号的通知中心。</p>',
      '<div class="notice-admin-grid"><form id="notice-admin-form" class="account-form notice-admin-card">',
      '<div class="notice-admin-title"><h2>', item ? "编辑通知" : "发布新通知", '</h2>',
      item ? '<button type="button" data-notice-admin-cancel>取消编辑</button>' : '', '</div>',
      '<label>标题<input name="title" maxlength="90" required value="', app.esc(item?.title || ""), '"></label>',
      '<label>正文<textarea name="body" maxlength="12000" rows="4" required placeholder="每段之间留一行。">', app.esc(item?.body || ""), '</textarea></label>',
      '<label>配图（可选）<input type="file" name="image" accept="image/jpeg,image/png,image/webp"></label>',
      item?.imageUrl ? '<label class="notice-remove"><input type="checkbox" name="removeImage">移除原配图</label>' : '',
      '<p class="notice-admin-hint">JPG、PNG 或 WebP，不超过 2 MB。</p><p data-notice-admin-status role="status"></p>',
      '<button class="primary" type="submit">', item ? "保存修改" : "发布通知", '</button></form>',
      '<details class="notice-admin-card notice-preview"', showPreview ? ' open' : '', '><summary>用户端预览</summary><div data-notice-preview>',
      article(item?.title, null, item?.body ? previewParagraphs(item.body) : ["正文和图片会显示在这里。"], item?.imageUrl),
      '</div></details></div>',
      '<section class="notice-admin-card notice-admin-list"><h2>已发布</h2><div data-notice-admin-list>',
      historyMarkup(), '</div></section></section>',
    ].join("");
  }

  function historyMarkup() {
    if (!adminItems) return '<p>正在读取…</p>';
    if (!adminItems.length) return '<p>暂无已发布通知。</p>';
    return adminItems.map((item) => [
      '<div class="notice-history-row"><div><strong>', app.esc(item.title), '</strong><time>',
      app.esc(displayDate(item.published_at)), item.hasImage ? ' · 有配图' : '', '</time></div>',
      '<button type="button" data-notice-edit="', item.id, '">编辑</button>',
      '<button type="button" data-notice-delete="', item.id, '">删除</button></div>',
    ].join("")).join("") + (adminHasMore ? '<button type="button" data-notice-admin-more>查看更多</button>' : '');
  }

  async function loadAdmin(append = false) {
    if (app.user()?.role !== "admin" || adminBusy) return;
    const account = owner, target = append ? adminPageIndex + 1 : 0;
    adminBusy = true;
    const node = document.querySelector("[data-notice-admin-list]");
    try {
      const data = await app.api("/api/notifications?page=" + target);
      if (owner === account) {
        adminPageIndex = target;
        adminItems = append ? [...adminItems, ...data.items] : data.items;
        adminHasMore = data.more;
        if (node?.isConnected) node.innerHTML = historyMarkup();
      }
    } catch {
      if (node?.isConnected) node.innerHTML = '<p>通知暂未加载。<button type="button" data-notice-admin-retry>重试</button></p>';
    } finally {
      if (owner === account) adminBusy = false;
    }
  }

  function previewParagraphs(body) {
    return body.split(/\n\s*\n/).flatMap((block) => {
      let remaining = Array.from(block.trim());
      const parts = [];
      while (remaining.length > 210) {
        const first = remaining.slice(0, 210);
        const boundary = first.findLastIndex((character) => "。！？；!?;，, \n".includes(character));
        const end = boundary >= 75 ? boundary + 1 : 210;
        parts.push(first.slice(0, end).join("").trim());
        remaining = Array.from(remaining.slice(end).join("").trimStart());
      }
      if (remaining.length) parts.push(remaining.join(""));
      return parts;
    });
  }

  function clearPreviewImage() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = "";
  }

  function updatePreview(form) {
    const output = document.querySelector("[data-notice-preview]");
    const photo = previewUrl || (form.elements.removeImage?.checked ? null : adminEdit?.imageUrl);
    if (output) output.innerHTML = article(form.elements.title.value, null,
      previewParagraphs(form.elements.body.value || "正文和图片会显示在这里。"), photo);
  }

  function fileData(file) {
    if (file.size > 2 * 1024 * 1024) throw new Error("请选择不超过 2 MB 的图片。");
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(reader.result), {once:true});
      reader.addEventListener("error", () => reject(new Error("图片读取失败。")), {once:true});
      reader.readAsDataURL(file);
    });
  }

  async function saveAdmin(form) {
    const submit = form.querySelector('[type="submit"]');
    if (submit.disabled) return;
    submit.disabled = true;
    const message = form.querySelector("[data-notice-admin-status]");
    const title = form.elements.title.value.trim(), body = form.elements.body.value.trim();
    const edit = adminEdit, data = {title, body};
    if (!edit) { adminRequestId ||= crypto.randomUUID().replaceAll("-", ""); data.requestId = adminRequestId; }
    try {
      const file = form.elements.image.files[0];
      if (file) data.image = await fileData(file);
      else if (form.elements.removeImage?.checked) data.image = null;
      const path = "/api/admin/notifications" + (edit ? "/" + edit.id + "/edit" : "");
      await app.api(path, data);
      if (!form.isConnected) return;
      clearPreviewImage();
      adminEdit = null; adminRequestId = null;
      app.render();
      await loadAdmin();
      sync(true);
      app.toast(edit ? "已保存通知。" : "通知已发布。");
    } catch (error) {
      message.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  }

  async function manage(action, identity) {
    try {
      const account = owner;
      if (action === "edit") {
        const item = await app.api("/api/admin/notifications/" + identity);
        if (owner !== account || app.route()[1] !== "notifications") return;
        clearPreviewImage();
        adminEdit = item;
        app.render();
        document.querySelector("#notice-admin-form input")?.focus();
      } else {
        if (!window.confirm("删除后，用户将无法再看到这条通知。")) return;
        await app.api("/api/admin/notifications/" + identity + "/delete", {});
        if (adminEdit?.id === identity) { adminEdit = null; app.render(); }
        await loadAdmin();
        sync(true);
        app.toast("已删除通知。");
      }
    } catch (error) {
      app.toast(error.message);
    }
  }

  document.addEventListener("click", (event) => {
    if (!app) return;
    const button = event.target.closest?.("button");
    if (button?.disabled) return;
    const data = button?.dataset || {};
    if ("noticeToggle" in data) return toggle();
    if ("noticeClose" in data) return close(true);
    if ("noticeBack" in data || "noticeRetry" in data) return fetchList();
    if ("noticeMore" in data) return fetchList(true);
    if (data.noticeId) return showNotice(data.noticeId);
    if (data.noticeEdit) return manage("edit", data.noticeEdit);
    if (data.noticeDelete) return manage("delete", data.noticeDelete);
    if ("noticeAdminRetry" in data) return loadAdmin();
    if ("noticeAdminMore" in data) return loadAdmin(true);
    if ("noticeAdminCancel" in data) {
      clearPreviewImage();
      adminEdit = null;
      return app.render();
    }
    if (open && !event.target.closest?.("#notification-panel")) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && open) close(true);
  });
  document.addEventListener("submit", (event) => {
    if (event.target.id !== "notice-admin-form") return;
    event.preventDefault();
    saveAdmin(event.target);
  });
  document.addEventListener("input", (event) => {
    const form = event.target.form;
    if (form?.id === "notice-admin-form" && event.target.name !== "image") updatePreview(form);
  });
  document.addEventListener("change", (event) => {
    const form = event.target.form;
    if (form?.id !== "notice-admin-form" || event.target.name !== "image") return;
    clearPreviewImage();
    const file = form.elements.image.files[0];
    if (file && file.size <= 2 * 1024 * 1024) previewUrl = URL.createObjectURL(file);
    updatePreview(form);
  });
  window.addEventListener("hashchange", () => { close(); clearPreviewImage(); });
  window.addEventListener("focus", () => { if (app) sync(true); });

  window.BX_NOTICES = {
    connect(value) {
      app = value;
      setInterval(() => { if (!document.hidden && app.user()) sync(); }, 30000);
    },
    trigger, sync, close, adminPage,
  };
})();
