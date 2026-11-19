(function () {
  "use strict";
  const axes = [
    ["math", "数学"],
    ["english", "英语"],
    ["chinese", "语文"],
    ["reading", "阅读"],
    ["observation", "观察"],
    ["habit", "习惯"],
  ];
  let app,
    owner = "",
    epoch = 0,
    request = 0,
    data = null,
    error = "",
    loading = false,
    updated = 0,
    selected = "";
  const allowed = () =>
    app?.user()?.role === "child" &&
    app.user().enabled !== false &&
    app.user().enabled !== 0;
  const actor = () => (allowed() ? String(app.user().id) : ""),
    esc = (value) => app.esc(value);
  const number = (value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : 0;
  function reset(next) {
    owner = next;
    epoch++;
    request++;
    data = null;
    error = "";
    loading = false;
    updated = 0;
    selected = "";
  }
  function refresh() {
    if (owner === actor() && allowed()) app.render();
  }
  async function load(force = false) {
    if (loading || !owner || owner !== actor()) return;
    loading = true;
    error = "";
    const stamp = epoch,
      turn = ++request,
      identity = owner;
    refresh();
    try {
      const response = await app.api(
        "/api/community" + (force ? "?refresh=1" : ""),
      );
      if (stamp !== epoch || turn !== request || identity !== actor()) return;
      const value = response?.community?.rows ? response.community : response;
      if (!Array.isArray(value?.rows) || !value?.self) throw new Error();
      data = value;
      updated = Date.now();
      if (
        !selected ||
        ![value.self, ...value.rows].some((row) => row.id === selected)
      )
        selected = value.self.id;
    } catch (_) {
      if (stamp === epoch && turn === request && identity === actor())
        error = "排行榜暂时没有同步，学习记录会保留。稍后可以重新读取。";
    } finally {
      if (stamp === epoch && turn === request && identity === actor()) {
        loading = false;
        refresh();
      }
    }
  }
  function dimension(row, name) {
    const item = row.dimensions?.[name] || {},
      samples = number(item.samples),
      value = item.value;
    return {
      value:
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= 100 &&
        item.sufficient === true &&
        samples >= number(data?.policy?.minDimensionSamples || 5) &&
        name !== "habit"
          ? value
          : null,
      samples,
    };
  }
  const point = (index, value, radius = 74) => {
    const angle = -Math.PI / 2 + (index * Math.PI) / 3;
    return [
      120 + (Math.cos(angle) * radius * value) / 100,
      108 + (Math.sin(angle) * radius * value) / 100,
    ];
  };
  function radar(row) {
    const values = axes.map(([id]) => dimension(row, id)),
      points = values.map((value, i) =>
        value.value === null ? null : point(i, value.value),
      );
    const grid = [25, 50, 75, 100]
      .map(
        (level) =>
          `<polygon points="${axes.map((_, i) => point(i, level).join(",")).join(" ")}" fill="none" stroke="#e7ebf0" stroke-width="1"></polygon>`,
      )
      .join("");
    const lines = axes
      .map((_, i) => {
        const p = point(i, 100);
        return `<line x1="120" y1="108" x2="${p[0]}" y2="${p[1]}" stroke="#e7ebf0"></line>`;
      })
      .join("");
    const segments = points
      .map((p, i) => {
        const next = points[(i + 1) % 6];
        return p && next
          ? `<line x1="${p[0]}" y1="${p[1]}" x2="${next[0]}" y2="${next[1]}" stroke="#3b82f6" stroke-width="2"></line>`
          : "";
      })
      .join("");
    const nodes = points
      .map((p, i) =>
        p
          ? `<circle cx="${p[0]}" cy="${p[1]}" r="3.5" fill="#3b82f6"><title>${axes[i][1]} ${values[i].value}% · ${values[i].samples}道样本</title></circle>`
          : "",
      )
      .join("");
    const labels = axes
      .map(([, label], i) => {
        const p = point(i, 100, 97),
          anchor = p[0] < 105 ? "end" : p[0] > 135 ? "start" : "middle";
        return `<text x="${p[0]}" y="${p[1]}" text-anchor="${anchor}" class="community-axis">${label}<tspan x="${p[0]}" dy="14" class="community-axis-value">${values[i].value === null ? "样本不足" : values[i].value + "%"}</tspan></text>`;
      })
      .join("");
    return `<section class="community-radar-section"><div class="community-section-title"><h3>${row.isSelf ? "我的学习记录" : esc(row.alias) + "的记录"}</h3>${!row.isSelf ? '<button class="text-action" data-community-self>看我的</button>' : ""}</div><svg class="community-radar" viewBox="0 0 240 230" role="img" aria-label="六个维度的已核对题目一致率，空白表示样本不足">${grid}${lines}${segments}${nodes}${labels}</svg><p>空白表示样本不足或暂无对应测评。比例仅反映已经核对的题目。</p></section>`;
  }
  const styles = `<style>.learning-community{max-width:880px;margin:auto;min-width:0}.community-heading{display:flex;align-items:center;gap:8px}.community-heading img{width:25px;height:25px;object-fit:contain}.community-heading h2{font-size:20px;margin:0;flex:1}.community-heading>button{font-size:12px;min-height:40px}.community-period{font-size:11px;color:#687180;margin:3px 0 14px;line-height:1.8}.community-self{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-top:1px solid #e9edf3;border-bottom:1px solid #e9edf3;margin-bottom:12px}.community-self>div{min-width:0}.community-self strong{display:block;font-size:14px;font-weight:500}.community-self small{display:block;font-size:11px;color:#687180;line-height:1.8}.community-self>b{font-size:22px;font-weight:600;white-space:nowrap}.community-self>b small{display:inline;font-size:11px;margin-left:3px;font-weight:400}.community-content{display:grid;grid-template-columns:minmax(260px,340px) minmax(0,1fr);gap:24px;align-items:start}.community-section-title{display:flex;align-items:center;justify-content:space-between;gap:8px}.community-section-title h3,.community-board h3{font-size:15px;margin:0 0 8px}.community-section-title button{min-height:36px;font-size:11px}.community-radar{display:block;width:100%;max-width:320px;height:auto;margin:auto}.community-axis{fill:#4b5563;font-size:11px}.community-axis-value{fill:#8b94a2;font-size:8px}.community-radar-section>p{font-size:11px;line-height:1.8;color:#687180;margin:0 0 12px}.community-board-head{font-size:11px;color:#687180;display:flex;justify-content:space-between;padding:4px 0 8px;border-bottom:1px solid #eef1f5}.community-board-rows{max-height:370px;overflow:auto;overscroll-behavior:contain}.community-board-row{display:flex;align-items:center;gap:10px;min-height:48px;padding:9px 5px;width:100%;border:0;border-bottom:1px solid #f0f3f6;border-radius:0;background:#fff;text-align:left;color:#20242c}.community-board-row.active{background:#f3f7fc}.community-board-row>small{width:26px;flex-shrink:0;font-size:12px;color:#687180;text-align:center}.community-board-row>span{flex:1;min-width:0;font-size:13px;overflow-wrap:anywhere}.community-board-row>span>i{font-style:normal;font-size:10px;color:#2563eb;margin-left:6px}.community-board-row>b{font-size:13px;font-weight:500;white-space:nowrap}.community-board-row>em{font-style:normal;font-size:11px;color:#8b94a2;white-space:nowrap}.community-empty{font-size:13px;color:#687180;line-height:1.9;padding:20px 0}.community-policy{margin-top:12px;border-top:1px solid #eef1f5;padding-top:8px}.community-policy>summary{font-size:12px;color:#687180;min-height:40px;display:flex;align-items:center;cursor:pointer}.community-policy p{font-size:11px;line-height:1.9;color:#687180}.learning-community .error-banner{font-size:12px;line-height:1.8}@media(max-width:700px){.community-content{grid-template-columns:1fr;gap:10px}.community-heading h2{font-size:18px}.community-period{margin-bottom:10px}.community-self{padding:9px 0;margin-bottom:9px}.community-self>b{font-size:20px}.community-radar{max-width:250px}.community-radar-section>p{font-size:10px;margin-bottom:0}.community-board-rows{max-height:250px}.community-board-row{min-height:44px;padding:8px 4px}.community-board h3{margin-bottom:4px}.community-policy{margin-top:8px}}</style>`;
  function page(value) {
    app = value;
    const next = actor();
    if (next !== owner) reset(next);
    if (!allowed())
      return app.user()?.role === "child"
        ? '<div class="empty-state"><h2>账号暂不可参与</h2><p>请联系家长或管理员核对账号状态。</p></div>'
        : '<div class="empty-state"><h2>学习洞察</h2><p>家长可查看自家宝宝的学习记录。</p><button class="secondary" data-go="parent/insight">查看宝宝学习洞察</button></div>';
    if (
      (!data && !loading && !error) ||
      (data && !loading && !error && Date.now() - updated >= 15000)
    )
      queueMicrotask(() => load());
    if (!data)
      return `${styles}<section class="learning-community"><div class="community-heading"><img src="assets/brand/paw-logo.png" alt=""><h2>爪爪排行榜</h2><button class="text-action" data-community-refresh ${loading ? "disabled" : ""}>重新读取</button></div><p class="community-empty" role="status">${esc(error || "正在读取真实的练习记录…")}</p></section>`;
    const own = data.self,
      row = [own, ...data.rows].find((item) => item.id === selected) || own,
      minimum = number(data.policy?.minQuestions) || 5;
    return `${styles}<section class="learning-community"><div class="community-heading"><img src="assets/brand/paw-logo.png" alt=""><h2>爪爪排行榜</h2><button class="text-action" data-community-refresh ${loading ? "disabled" : ""}>${loading ? "同步中…" : "刷新"}</button></div><p class="community-period">近30天 · ${esc(data.period?.fromDate || "")} 至 ${esc(data.period?.toDate || "")} · ${number(data.participants)}位伙伴已留下足够记录</p>${error ? `<p class="error-banner">${esc(error)}</p>` : ""}<div class="community-self"><div><strong>我的练习记录</strong><small>${!own.available ? "记录暂未同步" : own.eligible ? "当前" + (data.rows.some((r) => r.rank === own.rank && !r.isSelf) ? "并列" : "") + "第" + number(own.rank) + "名" : `先积累${minimum}道有核对结果的不同题目，再来看看。`}</small></div><b>${own.available ? number(own.uniqueQuestions) : "—"}<small>道独立题</small></b></div><div class="community-content">${radar(row)}<section class="community-board"><h3>练习积累榜</h3><div class="community-board-head"><span>匿名伙伴 · 点击查看六维记录</span><span>已核对独立题数</span></div><div class="community-board-rows">${data.rows.map((r) => `<button class="community-board-row ${selected === r.id ? "active" : ""}" data-community-select="${esc(r.id)}" aria-pressed="${selected === r.id}"><small>${number(r.rank)}</small><span>${esc(r.alias)}${r.isSelf ? "<i>我</i>" : ""}</span><b>${number(r.uniqueQuestions)}题</b><em>查看</em></button>`).join("") || `<p class="community-empty">还没有达到${minimum}道样本的排行记录。认真完成一步，也值得留下。</p>`}</div></section></div><details class="community-policy"><summary>排名和图表依据</summary><p>${esc(data.policy?.note || "同一道题重复核对不会增加排名。")}</p><p>${esc(data.policy?.radarNote || "样本不足的维度保持空缺。")}</p></details></section>`;
  }
  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled || !app || !allowed() || owner !== actor())
      return;
    const d = button.dataset;
    if ("communityRefresh" in d) {
      load(true);
      return;
    }
    if ("communitySelf" in d) {
      selected = data?.self.id || "";
      refresh();
      return;
    }
    if (
      d.communitySelect &&
      data &&
      [data.self, ...data.rows].some((row) => row.id === d.communitySelect)
    ) {
      selected = d.communitySelect;
      refresh();
    }
  });
  window.BX_COMMUNITY = { page };
})();
