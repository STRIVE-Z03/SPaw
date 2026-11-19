(function () {
  "use strict";

  let app;
  const labels = {
    register: ["邮箱注册宝宝账号", "创建宝宝账号"],
    "register-parent": ["邮箱注册家长账号", "创建家长账号"],
    reset: ["邮箱找回密码", "设置新密码"],
    family: ["注册并绑定家长账号", "注册并绑定"],
  };
  const usernamePattern = "[A-Za-z0-9_]{3,32}";
  const forms = new WeakMap();

  function fields(purpose, username = "") {
    const isReset = purpose === "reset";
    const child = purpose === "register";
    return [
      '<form class="account-form email-account-form" data-email-purpose="' + purpose + '">',
      '<p class="email-help">家长和宝宝可以使用同一个邮箱。用户名需要不同。</p>',
      '<label>用户名<input name="username" value="' + app.esc(username) +
        '" autocomplete="username" maxlength="32" pattern="' + usernamePattern + '" required></label>',
      '<label>收件邮箱<input name="email" type="email" maxlength="254" autocomplete="email" required></label>',
      '<label data-email-captcha>图片验证码<span class="captcha-row"><input name="captcha" aria-label="图片验证码" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="off" required><button type="button" data-email-refresh aria-label="更换图片验证码"><img alt="图片验证码"></button></span></label>',
      '<button class="secondary" type="button" data-email-code>发送邮箱验证码</button>',
      '<p class="auth-message" data-email-status role="status"></p>',
      '<fieldset data-email-completion disabled hidden>',
      '<label>邮箱验证码<input name="emailCode" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label>',
      isReset ? "" : '<label>' + (child ? '宝宝称呼' : '家长称呼') +
        '<input name="child_name" maxlength="30" required></label>',
      '<label>' + (isReset ? '新密码' : '设置密码') +
        '<input name="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required></label>',
      '<label>确认密码<input name="confirmPassword" type="password" autocomplete="new-password" minlength="8" maxlength="128" required></label>',
      '<button class="primary" type="submit">' + labels[purpose][1] + '</button>',
      '</fieldset></form>',
    ].join("");
  }

  function page(purpose, username, available) {
    return [
      '<main class="auth-page"><section class="auth-welcome"><img src="assets/brand/paw-mascot.png" alt="爪爪"><h1>伴学爪</h1></section>',
      '<section class="auth-card"><div class="auth-brand"><img src="assets/brand/paw-logo.png" alt=""><strong>伴学爪</strong></div><h1>',
      labels[purpose][0], '</h1>',
      available ? '' : '<p class="email-help">本机尚未开启邮件服务。</p>',
      fields(purpose, username),
      '<div class="auth-links"><button data-auth-mode="login">返回登录</button>',
      purpose === "register" ? '<button data-auth-mode="email-register-parent">注册家长账号</button>' : '',
      purpose === "register-parent" ? '<button data-auth-mode="email-register">注册宝宝账号</button>' : '',
      purpose === "reset" ? '<button data-auth-mode="forgot">旧账号未绑定邮箱</button>' : '',
      !available && purpose === "register" ? '<button data-auth-mode="register">本机测试注册</button>' : '',
      '</div></section></main>',
    ].join("");
  }

  function status(form, text, kind = "info") {
    const el = form.querySelector("[data-email-status]");
    el.textContent = text;
    el.dataset.state = kind;
  }

  async function captcha(form) {
    const state = forms.get(form);
    if (!state || state.loading) return;
    state.loading = true;
    const button = form.querySelector("[data-email-code]");
    button.disabled = true;
    form.elements.captcha.value = "";
    try {
      state.challenge = await app.api("/api/captcha");
      form.querySelector("[data-email-refresh] img").src = state.challenge.image;
    } catch (error) {
      state.challenge = null;
      status(form, "图片验证码加载失败，请点图片重试。", "error");
    } finally {
      state.loading = false;
      button.disabled = !state.challenge;
    }
  }

  function mount() {
    document.querySelectorAll("[data-email-purpose]").forEach((form) => {
      if (forms.has(form)) return;
      forms.set(form, {});
      captcha(form);
    });
  }

  async function send(form, button) {
    const state = forms.get(form);
    if (!state?.challenge || state.sending) return;
    const checked = ["username", "email"].every((name) =>
      form.elements[name].reportValidity()
    );
    if (!checked) return;
    if (!/^[0-9]{4}$/.test(form.elements.captcha.value)) {
      status(form, "请输入图片上的 4 位数字。", "error");
      return form.elements.captcha.focus();
    }
    state.sending = true;
    button.disabled = true;
    const data = {
      purpose: form.dataset.emailPurpose,
      username: form.elements.username.value,
      email: form.elements.email.value,
      captcha: form.elements.captcha.value,
      captchaId: state.challenge.id,
    };
    try {
      const result = await app.api("/api/auth/email-code", data);
      if (!form.isConnected || data.email !== form.elements.email.value ||
          data.username !== form.elements.username.value) return;
      status(form, result.message, "success");
      const section = form.querySelector("[data-email-completion]");
      form.elements.captcha.required = false;
      section.disabled = false;
      section.hidden = false;
      form.elements.emailCode.value = "";
      form.elements.emailCode.focus();
    } catch (error) {
      status(form, error.message, "error");
    } finally {
      state.challenge = null;
      state.sending = false;
      if (form.isConnected) await captcha(form);
    }
  }

  async function complete(form) {
    if (form.querySelector("[data-email-completion]").disabled) return;
    const data = Object.fromEntries(new FormData(form));
    if (data.password !== data.confirmPassword) {
      status(form, "两次输入的密码不一致。", "error");
      return;
    }
    const button = form.querySelector('[type="submit"]');
    if (button.disabled) return;
    button.disabled = true;
    try {
      const purpose = form.dataset.emailPurpose;
      const result = await app.api("/api/auth/email-complete", {
        purpose, username: data.username, email: data.email, emailCode: data.emailCode,
        password: data.password, child_name: data.child_name,
      });
      if (form.isConnected) await app.finished(purpose, result.username);
    } catch (error) {
      status(form, error.message, "error");
    } finally {
      button.disabled = false;
    }
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-email-code],[data-email-refresh]");
    if (!button || button.disabled) return;
    const form = button.closest("[data-email-purpose]");
    if (button.hasAttribute("data-email-code")) send(form, button);
    else captcha(form);
  });
  document.addEventListener("submit", (event) => {
    if (!event.target.matches("[data-email-purpose]")) return;
    event.preventDefault();
    complete(event.target);
  });
  document.addEventListener("input", (event) => {
    if (!["email", "username"].includes(event.target.name)) return;
    const form = event.target.closest("[data-email-purpose]");
    if (!form) return;
    const section = form.querySelector("[data-email-completion]");
    section.hidden = section.disabled = true;
    status(form, "");
  });

  window.BX_EMAIL_AUTH = { connect(value) { app = value; }, fields, page, mount };
})();
