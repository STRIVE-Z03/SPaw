(function () {
  "use strict";
  const IDS = ["primary", "secondary", "fallback"],
    NAMES = { primary: "主线路", secondary: "备用线路", fallback: "最终兜底" },
    ALL_FAIL = "可能爪爪太累睡着了，晚一会儿再试试吧。题目已保留。";
  let app,
    owner = "",
    epoch = 0,
    loadNumber = 0,
    snapshot = null,
    tavily = null,
    error = "",
    notice = "",
    loading = false,
    saving = false;
  const drafts = new Map(),
    operations = new Map(),
    expanded = new Set(["primary"]);
  const admin = () => app?.user()?.role === "admin";
  const current = () => (admin() ? String(app.user().id) : "");
  const esc = (value) => app.esc(value);
  function reset(next) {
    owner = next;
    epoch++;
    loadNumber++;
    snapshot = null;
    tavily = null;
    error = "";
    notice = "";
    loading = false;
    saving = false;
    drafts.clear();
    operations.clear();
    expanded.clear();
    expanded.add("primary");
  }
  function guard(stamp, actor) {
    return epoch === stamp && actor === owner && actor === current();
  }
  function refresh() {
    if (admin() && app.route?.()[0] === "admin" && app.route?.()[1] === "ai") {
      const field = document.activeElement,
        identity = field?.dataset?.aiProvider,
        key = field?.dataset?.aiField,
        start = field?.selectionStart,
        end = field?.selectionEnd;
      app.render();
      if (IDS.includes(identity) && ["baseUrl", "apiKey"].includes(key)) {
        const next = document.querySelector(
          '[data-ai-provider="' + identity + '"][data-ai-field="' + key + '"]',
        );
        next?.focus?.({ preventScroll: true });
        try {
          next?.setSelectionRange(start, end);
        } catch (_) {}
      }
    }
  }
  function health(value) {
    if (!value || typeof value !== "object") return null;
    const recent = Array.isArray(value.recent)
      ? value.recent
          .filter((v) => typeof v === "boolean" || v === 0 || v === 1)
          .slice(-50)
      : [];
    const cooldown = Number(value.cooldown_until ?? value.cooldownUntil ?? 0);
    return { recent, cooldown: Number.isFinite(cooldown) ? cooldown : 0 };
  }
  function model(value) {
    if (!value || typeof value.id !== "string" || !value.id.trim()) return null;
    return {
      id: value.id,
      enabled: value.enabled !== false,
      vision: ["supported", "unsupported", "unknown"].includes(value.vision)
        ? value.vision
        : "unknown",
      textHealth: health(value.textHealth || value.health?.text),
      visionHealth: health(value.visionHealth || value.health?.vision),
    };
  }
  function provider(value) {
    if (!value || !IDS.includes(value.id)) return null;
    return {
      id: value.id,
      name: typeof value.name === "string" ? value.name : NAMES[value.id],
      baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : "",
      enabled: value.enabled === true,
      hasKey: value.hasKey === true,
      fallbackOnly: value.id === "fallback" || value.fallbackOnly === true,
      textModel: typeof value.textModel === "string" ? value.textModel : "",
      visionModel:
        typeof value.visionModel === "string" ? value.visionModel : "",
      models: (Array.isArray(value.models) ? value.models : [])
        .map(model)
        .filter(Boolean)
        .slice(0, 500),
      status: health(value.status),
      textHealth: health(value.textHealth || value.health?.text),
      visionHealth: health(value.visionHealth || value.health?.vision),
    };
  }
  function configured(value) {
    return {
      id: value.id,
      enabled: !!value.enabled,
      baseUrl: value.baseUrl.trim(),
      textModel: value.textModel,
      visionModel: value.visionModel,
      models: value.models
        .map((m) => ({ id: m.id, enabled: m.enabled !== false }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    };
  }
  function dirty(id) {
    const draft = drafts.get(id),
      saved = snapshot?.providers.find((p) => p.id === id);
    return (
      !!draft &&
      (!saved ||
        !!draft.apiKey.trim() ||
        JSON.stringify(configured(draft)) !== JSON.stringify(configured(saved)))
    );
  }
  function anyDirty() {
    return IDS.some(dirty);
  }
  function install(value, preserve = true) {
    const incoming = (
      Array.isArray(value?.providers)
        ? value.providers
        : value?.provider
          ? [value.provider]
          : value?.id
            ? [value]
            : []
    )
      .map(provider)
      .filter(Boolean);
    const previous = snapshot?.providers || [];
    const providers = IDS.map(
      (id) =>
        incoming.find((p) => p.id === id) ||
        previous.find((p) => p.id === id) ||
        provider({ id, enabled: false }),
    );
    for (const saved of providers) {
      const old = drafts.get(saved.id),
        keep = preserve && old && dirty(saved.id);
      if (keep) {
        const flags = new Map(old.models.map((m) => [m.id, m.enabled]));
        old.models = saved.models.map((m) => ({
          ...m,
          enabled: flags.has(m.id) ? flags.get(m.id) : m.enabled,
        }));
      } else
        drafts.set(saved.id, {
          ...saved,
          models: saved.models.map((m) => ({ ...m })),
          apiKey: "",
          revision: old?.revision || 0,
        });
    }
    snapshot = { providers, policy: value?.policy || snapshot?.policy || {} };
  }
  async function load() {
    if (loading || saving || operations.size || !admin() || owner !== current())
      return;
    loading = true;
    error = "";
    const stamp = epoch,
      actor = owner,
      number = ++loadNumber;
    refresh();
    try {
      const [result, search] = await Promise.all([
        app.api("/api/admin/ai/providers"),
        app.api("/api/admin/ai/tavily"),
      ]);
      if (!guard(stamp, actor) || number !== loadNumber) return;
      install(result, true);
      tavily = search;
    } catch (_) {
      if (guard(stamp, actor) && number === loadNumber)
        error = "线路状态暂时没有同步，请重新读取。";
    } finally {
      if (guard(stamp, actor) && number === loadNumber) {
        loading = false;
        refresh();
      }
    }
  }
  function evidence(value) {
    if (!value?.recent?.length) return "未有检测记录";
    const yes = value.recent.filter((v) => v === true || v === 1).length;
    return (
      Math.round((yes / value.recent.length) * 100) +
      "%（" +
      yes +
      "/" +
      value.recent.length +
      "）"
    );
  }
  function status(saved) {
    if (!saved.enabled) return "未启用";
    if (!saved.hasKey) return "待配置密钥";
    const rows = [
        saved.status,
        saved.textHealth,
        saved.visionHealth,
        ...saved.models.flatMap((m) => [m.textHealth, m.visionHealth]),
      ].filter(Boolean),
      now = Date.now() / 1000;
    if (saved.status?.cooldown > now) return "失败冷却中";
    if (rows.some((h) => h.recent.some(Boolean) && h.cooldown <= now))
      return "最近可用";
    if (rows.some((h) => h.cooldown > now)) return "失败冷却中";
    if (rows.some((h) => h.recent.length)) return "最近调用失败";
    return "待检测";
  }
  function cooldown(value) {
    if (!value || value.cooldown <= Date.now() / 1000) return "";
    return (
      " · 冷却剩余约" +
      Math.max(1, Math.ceil((value.cooldown - Date.now() / 1000) / 60)) +
      "分钟"
    );
  }
  function healthLine(label, value) {
    return `<span>${label} ${esc(evidence(value))}${esc(cooldown(value))}</span>`;
  }
  function choices(draft, vision) {
    const selected = vision ? draft.visionModel : draft.textModel,
      list = draft.models;
    return `<option value="">自动选择可用模型</option>${selected && !list.some((m) => m.id === selected) ? `<option value="${esc(selected)}" selected>${esc(selected)}（待更新列表）</option>` : ""}${list.map((m) => `<option value="${esc(m.id)}" ${selected === m.id ? "selected" : ""} ${m.enabled === false || (vision && m.vision === "unsupported") ? "disabled" : ""}>${esc(m.id)}${vision && m.vision === "unsupported" ? "（不支持图片）" : ""}${m.enabled === false ? "（已停用）" : ""}</option>`).join("")}`;
  }
  function card(id) {
    const saved = snapshot.providers.find((p) => p.id === id),
      draft = drafts.get(id),
      busy = operations.get(id),
      changed = dirty(id),
      disabled = saving || !!busy;
    return `<details class="ai-provider-card" data-ai-provider-card="${id}" ${expanded.has(id) ? "open" : ""}><summary><span><strong>${NAMES[id]}</strong><small>${esc(status(saved))}${changed ? " · 未保存" : ""}${saved.models.length ? " · " + saved.models.length + "个模型" : ""}</small></span><span class="ai-provider-summary-mark">${id === "fallback" ? "最后使用" : id === "secondary" ? "自动切换" : "优先使用"}</span></summary><div class="ai-provider-body"><label class="ai-provider-enable"><input type="checkbox" data-ai-provider="${id}" data-ai-field="enabled" ${draft.enabled ? "checked" : ""}>启用这条线路</label><div class="ai-provider-fields"><label>接口地址<input type="url" data-ai-provider="${id}" data-ai-field="baseUrl" value="${esc(draft.baseUrl)}" placeholder="https://api.example.com/v1" autocomplete="off" maxlength="500"></label><label>新密钥${saved.hasKey ? " <small>已保存，留空沿用</small>" : ""}<input type="password" data-ai-provider="${id}" data-ai-field="apiKey" value="${esc(draft.apiKey)}" placeholder="${saved.hasKey ? "已有密钥不会返回浏览器" : "填写这条线路的密钥"}" autocomplete="new-password" spellcheck="false" maxlength="1000"></label><label>默认文字模型<select data-ai-provider="${id}" data-ai-field="textModel">${choices(draft, false)}</select></label><label>默认识图模型<select data-ai-provider="${id}" data-ai-field="visionModel">${choices(draft, true)}</select></label></div><div class="ai-provider-health">${saved.status ? healthLine("接口", saved.status) : ""}${healthLine("文字", saved.textHealth)}${healthLine("识图", saved.visionHealth)}</div><div class="ai-provider-tools"><button type="button" class="secondary" data-ai-refresh-models="${id}" ${disabled ? "disabled" : ""}>${busy === "refresh" ? "正在读取…" : "更新模型列表"}</button><button type="button" class="text-action" data-ai-probe="${id}" data-vision="false" ${disabled ? "disabled" : ""}>${busy === "text" ? "正在测试…" : "测试文字"}</button><button type="button" class="text-action" data-ai-probe="${id}" data-vision="true" ${disabled ? "disabled" : ""}>${busy === "vision" ? "正在测试…" : "测试识图"}</button><button type="button" class="secondary" data-ai-vision-all="${id}" ${disabled ? "disabled" : ""}>${busy === "vision-all" ? "正在逐批检测…" : "一键检测识图模型"}</button></div>${draft.models.length ? `<details class="ai-provider-models"><summary>模型可用状态与近期成功率</summary>${draft.models.map((m) => `<div class="ai-provider-model"><label><input type="checkbox" data-ai-provider="${id}" data-ai-model="${esc(m.id)}" ${m.enabled ? "checked" : ""}><span>${esc(m.id)}</span></label><div>${healthLine("文字", m.textHealth)}${healthLine("识图", m.visionHealth)}</div></div>`).join("")}</details>` : '<p class="ai-provider-note">保存接口和密钥后，更新模型列表。</p>'}</div></details>`;
  }
  const styles = `<style>.ai-provider-admin{max-width:900px;margin:auto;min-width:0}.ai-provider-admin>p{font-size:12px;line-height:1.7;color:var(--bx-muted,#687180)}.ai-provider-card{background:#fff;border:1px solid var(--bx-line,#e5e8ee);border-radius:10px;margin:10px 0;overflow:hidden}.ai-provider-card>summary{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:13px 16px;min-height:56px;cursor:pointer;list-style:none}.ai-provider-card>summary strong,.ai-provider-card>summary small{display:block}.ai-provider-card>summary strong{font-size:15px}.ai-provider-card>summary small{font-size:11px;font-weight:400;line-height:1.7;color:var(--bx-muted,#687180)}.ai-provider-summary-mark{font-size:11px;color:var(--bx-muted,#687180);white-space:nowrap}.ai-provider-body{padding:0 16px 14px;border-top:1px solid #f1f3f6}.ai-provider-enable{display:flex!important;align-items:center;gap:8px;font-size:13px;margin:12px 0!important}.ai-provider-admin input[type=checkbox]{width:16px;min-width:16px;height:16px;min-height:0;margin:0;accent-color:#2563eb}.ai-provider-fields{display:grid;grid-template-columns:1fr 1fr;gap:12px;min-width:0}.ai-provider-fields label{display:grid;gap:5px;font-size:12px;min-width:0}.ai-provider-fields label small{font-size:11px;font-weight:400;color:var(--bx-muted,#687180)}.ai-provider-fields input,.ai-provider-fields select{width:100%;min-width:0;min-height:42px;border:1px solid var(--bx-line,#e5e8ee);border-radius:8px;padding:8px 10px;font-size:13px;background:#fff}.ai-provider-health{display:flex;flex-wrap:wrap;gap:5px 16px;font-size:11px;color:var(--bx-muted,#687180);line-height:1.8;margin:10px 0}.ai-provider-tools{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.ai-provider-tools button{min-height:40px;font-size:12px;padding:7px 10px;border-radius:8px}.ai-provider-models{margin-top:8px;font-size:12px}.ai-provider-models>summary{min-height:40px;display:flex;align-items:center;cursor:pointer;color:var(--bx-muted,#687180)}.ai-provider-model{padding:10px 0;border-top:1px solid #f1f3f6;min-width:0}.ai-provider-model>label{display:flex;gap:8px;align-items:center;font-size:12px;line-height:1.7;overflow-wrap:anywhere}.ai-provider-model>label>span{min-width:0;overflow-wrap:anywhere}.ai-provider-model small,.ai-provider-model>div{font-size:11px;color:var(--bx-muted,#687180);line-height:1.8;margin-left:24px}.ai-provider-model>div{display:flex;flex-wrap:wrap;gap:3px 12px}.ai-provider-note{font-size:11px;color:var(--bx-muted,#687180)}.ai-provider-actions{position:sticky;bottom:0;background:#fff;display:flex;align-items:center;gap:10px;padding:12px 0 max(12px,env(safe-area-inset-bottom));border-top:1px solid var(--bx-line,#e5e8ee);z-index:20}.ai-provider-actions>.primary{min-height:44px;border-radius:10px;font-size:13px}.ai-provider-actions>.text-action{font-size:12px}.ai-provider-actions>small{margin-left:auto;font-size:11px;color:var(--bx-muted,#687180)}.ai-provider-admin [role=status]{font-size:12px;line-height:1.7;overflow-wrap:anywhere}.ai-provider-admin .error-banner{font-size:13px;line-height:1.7}@media(max-width:600px){.ai-provider-fields{grid-template-columns:1fr;gap:10px}.ai-provider-card>summary{padding:11px 12px}.ai-provider-body{padding:0 12px 12px}.ai-provider-actions>small{display:none}.ai-provider-admin h2{font-size:18px}.ai-provider-fields input,.ai-provider-fields select{font-size:14px}}</style>`;
  function tavilyCard() {
    if (!tavily) return "";
    const blocked = saving || loading || operations.size;
    return `<form id="tavily-settings" class="ai-provider-card"><div class="ai-provider-body">
      <div><strong>Tavily 公开资料检索</strong> <small>${tavily.configured ? "已配置" : "未配置"}</small></div>
      ${tavily.readOnly ? '<small>此项由启动环境配置。</small>' :
        '<label>更新密钥<input type="password" name="apiKey" placeholder="填写新的 Tavily API Key" autocomplete="new-password" spellcheck="false" maxlength="185" required></label>'}
      <div class="ai-provider-tools">
        ${tavily.readOnly ? "" : `<button class="primary" type="submit" ${blocked ? "disabled" : ""}>保存到环境配置</button>`}
        <button class="secondary" type="button" data-tavily-test ${blocked || !tavily.configured ? "disabled" : ""}>测试检索</button>
      </div>
    </div></form>`;
  }

  async function updateTavily(action, apiKey) {
    if (!admin() || saving || loading || operations.size) return;
    const stamp = epoch, actor = owner;
    error = notice = "";
    operations.set("tavily", action);
    refresh();
    try {
      const result = await app.api("/api/admin/ai/tavily", action === "test" ? {action} : {action, apiKey});
      if (!guard(stamp, actor)) return;
      tavily = result;
      notice = action === "save" ? "Tavily 已更新。" :
        result.ok ? `Tavily 已连通，找到 ${result.sources} 条合规资料。` : "Tavily 暂未连通，请检查服务端配置。";
    } catch (problem) {
      if (guard(stamp, actor)) error = problem.message;
    } finally {
      if (guard(stamp, actor)) {
        operations.delete("tavily");
        refresh();
      }
    }
  }

  function page(value) {
    app = value;
    const next = current();
    if (next !== owner) reset(next);
    if (!next) {
      reset("");
      return '<p class="empty-state">需要管理员权限才能配置AI线路。</p>';
    }
    if (!snapshot && !loading && !error) queueMicrotask(load);
    return `${styles}<section class="ai-provider-admin"><h2>AI线路配置</h2><p>线路设置保存在服务端环境文件。文字和识图分别记录检测结果。</p>${loading && !snapshot ? '<p role="status">正在读取线路设置…</p>' : ""}${error ? `<p class="error-banner" role="alert">${esc(error)}</p>` : ""}${notice ? `<p role="status">${esc(notice)}</p>` : ""}<form id="ai-providers-form">${snapshot ? IDS.map(card).join("") : ""}<div class="ai-provider-tools"><button type="button" class="secondary" data-ai-ocr-probe ${saving || loading || operations.size ? "disabled" : ""}>${operations.has("ocr") ? "正在测试…" : "测试本地 PaddleOCR 兜底"}</button></div><div class="ai-provider-actions"><button type="submit" class="primary" ${saving || loading || operations.size || !snapshot || !anyDirty() ? "disabled" : ""}>${saving ? "正在保存…" : "保存线路设置"}</button><button type="button" class="text-action" data-ai-admin-reload ${saving || loading || operations.size ? "disabled" : ""}>${loading ? "正在读取…" : "刷新状态"}</button><small data-ai-unsaved-status>${anyDirty() ? "有未保存的设置" : "设置已同步"}</small></div></form>${tavilyCard()}</section>`;
  }
  function changed(target) {
    const id = target.dataset?.aiProvider;
    if (!IDS.includes(id) || !drafts.has(id)) return;
    const draft = drafts.get(id),
      field = target.dataset.aiField;
    if (target.dataset.aiModel) {
      const row = draft.models.find((m) => m.id === target.dataset.aiModel);
      if (!row) return;
      row.enabled = !!target.checked;
      if (!row.enabled) {
        if (draft.textModel === row.id) draft.textModel = "";
        if (draft.visionModel === row.id) draft.visionModel = "";
      }
    } else if (
      ["enabled", "baseUrl", "apiKey", "textModel", "visionModel"].includes(
        field,
      )
    )
      draft[field] =
        field === "enabled" ? !!target.checked : String(target.value || "");
    else return;
    draft.revision++;
    notice = "";
    error = "";
    // Update only the save affordance while typing, retaining caret and native
    // keyboard. Model/checkbox changes need a full redraw of dependent choices.
    if (["baseUrl", "apiKey"].includes(field)) {
      const button = document.querySelector(
        '#ai-providers-form button[type="submit"]',
      );
      if (button)
        button.disabled = saving || loading || !!operations.size || !anyDirty();
      const message = document.querySelector("[data-ai-unsaved-status]");
      if (message)
        message.textContent = anyDirty() ? "有未保存的设置" : "设置已同步";
    } else refresh();
  }
  async function save() {
    if (
      saving ||
      loading ||
      operations.size ||
      !snapshot ||
      !admin() ||
      owner !== current() ||
      !anyDirty()
    )
      return;
    for (const id of IDS) {
      const d = drafts.get(id),
        saved = snapshot.providers.find((p) => p.id === id);
      if (d.enabled || d.baseUrl.trim()) {
        try {
          const url = new URL(d.baseUrl.trim());
          if (
            !["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.hash
          )
            throw new Error();
          if (
            saved.hasKey &&
            saved.baseUrl &&
            new URL(saved.baseUrl).origin !== url.origin &&
            !d.apiKey.trim()
          ) {
            error = NAMES[id] + "更换接口主机时，请同时填写这条线路的新密钥。";
            refresh();
            return;
          }
        } catch (_) {
          error = NAMES[id] + "需要填写完整的HTTP或HTTPS接口地址。";
          refresh();
          return;
        }
      }
      if (d.enabled && !saved.hasKey && !d.apiKey.trim()) {
        error = NAMES[id] + "还未填写密钥。";
        refresh();
        return;
      }
    }
    const submitted = new Map(
      IDS.map((id) => {
        const d = drafts.get(id);
        return [
          id,
          { revision: d.revision, apiKey: d.apiKey, config: configured(d) },
        ];
      }),
    );
    const payload = {
      providers: IDS.map((id) => {
        const d = drafts.get(id),
          value = { ...configured(d) };
        if (d.apiKey.trim()) value.apiKey = d.apiKey.trim();
        return value;
      }),
    };
    saving = true;
    error = "";
    notice = "";
    const stamp = epoch,
      actor = owner;
    refresh();
    try {
      const result = await app.api("/api/admin/ai/providers", payload);
      if (!guard(stamp, actor)) return;
      const changedRows = new Map();
      for (const id of IDS) {
        const d = drafts.get(id),
          sent = submitted.get(id);
        if (d.revision !== sent.revision)
          changedRows.set(id, {
            ...d,
            models: d.models.map((m) => ({ ...m })),
          });
        if (d.apiKey === sent.apiKey) d.apiKey = "";
      }
      const response = Array.isArray(result?.providers)
        ? result
        : {
            providers: IDS.map((id) => ({
              ...snapshot.providers.find((p) => p.id === id),
              ...submitted.get(id).config,
              hasKey:
                snapshot.providers.find((p) => p.id === id).hasKey ||
                !!submitted.get(id).apiKey.trim(),
            })),
          };
      install(response, false);
      for (const [id, d] of changedRows) {
        if (d.apiKey === submitted.get(id).apiKey) d.apiKey = "";
        drafts.set(id, d);
      }
      notice = anyDirty()
        ? "设置已保存，刚修改的内容仍待保存。"
        : "线路设置已保存。";
      app.toast(notice);
    } catch (_) {
      if (guard(stamp, actor))
        error = "未能保存线路设置，输入内容已保留，请重试。";
    } finally {
      if (guard(stamp, actor)) {
        saving = false;
        refresh();
      }
    }
  }
  async function operate(id, operation) {
    if (
      !IDS.includes(id) ||
      operations.has(id) ||
      saving ||
      loading ||
      !snapshot ||
      !admin() ||
      owner !== current()
    )
      return;
    if (dirty(id)) {
      app.toast("请先保存这条线路，再更新模型或测试。");
      return;
    }
    if (!snapshot.providers.find((p) => p.id === id).hasKey) {
      app.toast("请先填写并保存这条线路的密钥。");
      return;
    }
    operations.set(id, operation);
    notice = "";
    error = "";
    const stamp = epoch,
      actor = owner;
    refresh();
    try {
      if (operation === "vision-all") {
        const models = snapshot.providers
          .find((p) => p.id === id)
          .models.filter((m) => m.enabled)
          .map((m) => m.id);
        if (!models.length) {
          notice = "请先更新模型列表并启用需要检测的模型。";
          return;
        }
        const results = [];
        for (let index = 0; index < models.length; index += 4) {
          const result = await app.api(
            "/api/admin/ai/providers/" + id + "/probe-vision",
            { models: models.slice(index, index + 4) },
          );
          if (!guard(stamp, actor)) return;
          install(result, true);
          results.push(...result.results);
          notice =
            "已检测 " + results.length + " / " + models.length + " 个模型。";
          refresh();
        }
        const passed = results
          .filter((item) => item.visionVerified)
          .map((item) => item.model.split("::")[1]);
        const failures = results
          .filter((item) => !item.visionVerified)
          .map(
            (item) => item.model.split("::")[1] + "（" + item.errorCode + "）",
          );
        notice =
          "识图通过 " +
          passed.length +
          " / " +
          results.length +
          (passed.length ? " · " + passed.join("、") : "") +
          (failures.length ? "。未通过：" + failures.join("、") : "。");
        return;
      }
      const result = await app.api(
        "/api/admin/ai/providers/" +
          id +
          "/" +
          (operation === "refresh" ? "refresh" : "probe"),
        operation === "refresh" ? {} : { vision: operation === "vision" },
      );
      if (!guard(stamp, actor)) return;
      if (result?.providers || result?.provider || IDS.includes(result?.id))
        install(result, true);
      if (operation === "refresh") {
        if (result?.ok === true) notice = "模型列表已更新。";
        else error = "未能更新模型列表，已有设置和可用模型仍然保留。";
      } else
        notice =
          (result?.ok !== true && result?.success !== true) ||
          (operation === "vision" && result?.visionVerified !== true)
            ? ALL_FAIL
            : (operation === "vision" ? "识图" : "文字") +
              "测试通过" +
              (result?.model ? " · " + result.model : "") +
              "。";
    } catch (_) {
      if (guard(stamp, actor))
        error =
          operation === "refresh"
            ? "未能读取模型列表，请检查已保存的接口地址和密钥后重试。"
            : ALL_FAIL;
    } finally {
      if (guard(stamp, actor)) {
        operations.delete(id);
        refresh();
      }
    }
  }
  async function probeOcr() {
    if (operations.size || saving || loading) return;
    const stamp = epoch,
      actor = owner;
    operations.set("ocr", true);
    notice = "";
    error = "";
    refresh();
    try {
      const result = await app.api("/api/admin/ai/ocr/probe", {});
      if (guard(stamp, actor))
        notice = result.ok
          ? "PaddleOCR 测试通过 · 可在识图服务失败时提取文字。"
          : result.enabled
            ? "PaddleOCR 未通过测试，请检查新服务器的 OCR 服务。"
            : "本地 PaddleOCR 未启用。";
    } catch (_) {
      if (guard(stamp, actor)) error = "无法完成本地 OCR 测试。";
    } finally {
      if (guard(stamp, actor)) {
        operations.delete("ocr");
        refresh();
      }
    }
  }
  document.addEventListener("input", (event) => {
    if (
      app &&
      admin() &&
      owner === current() &&
      ["baseUrl", "apiKey"].includes(event.target.dataset?.aiField)
    )
      changed(event.target);
  });
  document.addEventListener("change", (event) => {
    if (
      app &&
      admin() &&
      owner === current() &&
      (event.target.dataset?.aiField || event.target.dataset?.aiModel) &&
      !["baseUrl", "apiKey"].includes(event.target.dataset?.aiField)
    )
      changed(event.target);
  });
  document.addEventListener(
    "toggle",
    (event) => {
      const id = event.target.dataset?.aiProviderCard;
      if (!app || !admin() || owner !== current() || !IDS.includes(id)) return;
      if (event.target.open) expanded.add(id);
      else expanded.delete(id);
    },
    true,
  );
  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled || !app || !admin() || owner !== current())
      return;
    const d = button.dataset;
    if ("tavilyTest" in d) {
      updateTavily("test");
      return;
    }
    if ("aiAdminReload" in d) {
      load();
      return;
    }
    if (d.aiRefreshModels) {
      operate(d.aiRefreshModels, "refresh");
      return;
    }
    if ("aiOcrProbe" in d) {
      probeOcr();
      return;
    }
    if (d.aiVisionAll) {
      operate(d.aiVisionAll, "vision-all");
      return;
    }
    if (d.aiProbe) operate(d.aiProbe, d.vision === "true" ? "vision" : "text");
  });
  document.addEventListener("submit", (event) => {
    if (event.target.id !== "tavily-settings") return;
    event.preventDefault();
    const key = new FormData(event.target).get("apiKey");
    if (typeof key === "string" && key.trim()) updateTavily("save", key.trim());
  });
  document.addEventListener("submit", (event) => {
    if (
      event.target.id !== "ai-providers-form" ||
      !app ||
      !admin() ||
      owner !== current()
    )
      return;
    event.preventDefault();
    save();
  });
  window.BX_AI_ADMIN = { page };
})();
