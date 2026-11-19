(function () {
  "use strict";
  let bubble = null,
    target = null,
    pin = null,
    root = null,
    hints = [],
    index = 0,
    onClose = null,
    panelKey = "";
  const panels = new Map(),
    esc = (value) =>
      String(value ?? "").replace(
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
  let config = { owner: () => "", onChange: () => {} };
  const storageKey = (key) => "bx-hint-step:" + config.owner() + ":" + key;
  function stored(key) {
    try {
      return JSON.parse(localStorage.getItem(storageKey(key)) || "null");
    } catch (_) {
      return null;
    }
  }
  function remember(key) {
    const value = panels.get(key);
    if (!value || value.owner !== config.owner() + ":" + key) return;
    const state = { key, index: value.index, collapsed: value.collapsed };
    try {
      localStorage.setItem(storageKey(key), JSON.stringify(state));
    } catch (_) {}
    config.onChange?.(key, state);
  }
  const cat =
    '<span class="lesson-cat" aria-hidden="true"><img src="assets/figma/lower-paw.svg" class="lower" alt=""><img src="assets/figma/kitten-head.svg" class="head" alt=""><img src="assets/figma/raised-paw.svg" class="raised" alt=""></span>';
  function panelBody(key) {
    const value = panels.get(key),
      step = value.steps[value.index];
    return `<header>${cat}<strong>提示 ${value.index + 1} / ${value.steps.length} · ${step.target === "option" ? "比较选项" : step.target === "figure" ? "读清图示" : "找出条件"}</strong><button class="text-action" data-hint-toggle="${esc(key)}">${value.collapsed ? "展开" : "收起"}</button></header>${value.collapsed ? "" : `${value.index ? '<p class="lesson-coach-seen">已看过前面的提示，试着把这一步接上。</p>' : ""}<div class="lesson-coach-step"><small>我们再检查一下这里。</small><p>${esc(step.text)}</p></div><footer>${value.index ? `<button class="text-action" data-hint-prev="${esc(key)}">上一步</button>` : ""}<button class="text-action" data-hint-locate="${esc(key)}">在题目中找一找</button>${value.index + 1 < value.steps.length ? `<button class="text-action" data-hint-next="${esc(key)}">再给我一步</button>` : ""}<button class="text-action" data-hint-attempt="${esc(key)}">我来试试</button></footer>`}`;
  }
  function panel(steps, key) {
    const owned = config.owner() + ":" + key;
    if (panels.get(key)?.owner !== owned) {
      const old = stored(key);
      panels.set(key, {
        steps,
        index: Math.max(0, Math.min(steps.length - 1, Number(old?.index) || 0)),
        collapsed: !!old?.collapsed,
        owner: owned,
      });
    }
    if (panels.size > 100) panels.delete(panels.keys().next().value);
    return `<aside class="lesson-coach" data-hint-panel="${esc(key)}" aria-label="爪爪分步提示" aria-live="polite">${panelBody(key)}</aside>`;
  }
  function paintPanel() {
    if (!panelKey) return;
    const element = root?.querySelector("[data-hint-panel]"),
      value = panels.get(panelKey);
    if (value) {
      value.index = index;
      remember(panelKey);
      if (element) element.innerHTML = panelBody(panelKey);
    }
  }
  function close() {
    bubble?.remove();
    pin?.remove();
    if (root) {
      root
        .querySelectorAll(".hint-target-active")
        .forEach((node) => node.classList.remove("hint-target-active"));
      root
        .querySelectorAll("mark.bx-hint-keyword")
        .forEach((mark) =>
          mark.replaceWith(document.createTextNode(mark.textContent)),
        );
    }
    bubble = null;
    pin = null;
    target = null;
    root = null;
    onClose?.();
    onClose = null;
  }
  function place() {
    if (!root || !target?.isConnected) {
      close();
      return;
    }
    const rect = target.getBoundingClientRect();
    if (pin) {
      const point = hints[index]?.point || [0.5, 0.5];
      pin.style.left = rect.left + rect.width * point[0] + "px";
      pin.style.top = rect.top + rect.height * point[1] + "px";
    }
    // Hints participate in normal document flow. They never occupy a fixed
    // rectangle over an option, writing area, or the action toolbar.
    if (bubble) {
      bubble.style.width = "100%";
      bubble.style.maxHeight = "none";
    }
  }
  function markQuote(stem, quote) {
    if (!stem || !quote) return null;
    const walker = document.createTreeWalker(stem, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest(".katex,button,mark")) continue;
      const at = node.textContent.indexOf(quote);
      if (at < 0) continue;
      const word = node.splitText(at);
      word.splitText(quote.length);
      const mark = document.createElement("mark");
      mark.className = "bx-hint-keyword";
      word.replaceWith(mark);
      mark.append(word);
      return mark;
    }
    return null;
  }
  function step() {
    root
      .querySelectorAll(".hint-target-active")
      .forEach((node) => node.classList.remove("hint-target-active"));
    root
      .querySelectorAll("mark.bx-hint-keyword")
      .forEach((mark) =>
        mark.replaceWith(document.createTextNode(mark.textContent)),
      );
    pin?.remove();
    pin = null;
    const hint = hints[index],
      stem = root.querySelector("[data-hint-stem]") || root;
    const details = stem.closest("details");
    if (details && !details.open && hint.target === "stem" && hint.quote)
      details.open = true;
    target =
      hint.target === "option"
        ? root.querySelector(
            '[data-hint-option="' +
              String(hint.option).replace(/[^A-F]/g, "") +
              '"]',
          )
        : hint.target === "figure"
          ? root.querySelector("[data-hint-figure]")
          : null;
    target =
      target ||
      markQuote(stem, hint.quote) ||
      (details && !details.open
        ? root.querySelector("[data-hint-figure]")
        : stem) ||
      stem;
    target.classList.add("hint-target-active");
    if (hint.target === "figure" && Array.isArray(hint.point)) {
      const rect = target.getBoundingClientRect();
      pin = document.createElement("span");
      pin.className = "bx-hint-pin";
      pin.style.left = rect.left + rect.width * hint.point[0] + "px";
      pin.style.top = rect.top + rect.height * hint.point[1] + "px";
      pin.setAttribute("aria-hidden", "true");
      document.body.append(pin);
    }
    if (bubble) {
      bubble.replaceChildren();
      const label = document.createElement("small");
      label.textContent = "爪爪的小提示 " + (index + 1) + " / " + hints.length;
      const content = document.createElement("p");
      content.textContent = hint.text;
      const actions = document.createElement("div");
      actions.className = "bx-hint-actions";
      const attempt = document.createElement("button");
      attempt.className = "primary";
      attempt.textContent = "我来试试";
      attempt.addEventListener("click", close);
      actions.append(attempt);
      if (index + 1 < hints.length) {
        const next = document.createElement("button");
        next.className = "text-action";
        next.textContent = "再给我一步";
        next.addEventListener("click", () => {
          index++;
          step();
        });
        actions.append(next);
      }
      const dismiss = document.createElement("button");
      dismiss.className = "bx-hint-close";
      dismiss.setAttribute("aria-label", "关闭提示");
      dismiss.textContent = "×";
      dismiss.addEventListener("click", close);
      bubble.append(label, content, actions, dismiss);
    }
    paintPanel();
    place();
    const visibleHint = bubble || root.querySelector("[data-hint-panel]");
    if (visibleHint) {
      visibleHint.style.animation = "none";
      void visibleHint.offsetWidth;
      visibleHint.style.animation = "";
      const rect = visibleHint.getBoundingClientRect(),
        toolbar = document.querySelector(".lesson-toolbar"),
        top = Math.max(12, toolbar?.getBoundingClientRect().bottom || 0),
        bottom =
          window.innerHeight -
          (document.querySelector(".lesson-fixed-actions")?.offsetHeight || 0) -
          12;
      if (rect.top < top || rect.bottom > bottom)
        visibleHint.scrollIntoView?.({
          block: "nearest",
          behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)")
            .matches
            ? "auto"
            : "smooth",
        });
    }
  }
  function show(element, steps, options = {}) {
    close();
    if (!element || !Array.isArray(steps) || !steps.length) return;
    root = element;
    hints = steps.filter((h) => h && typeof h.text === "string").slice(0, 4);
    if (!hints.length) return;
    panelKey =
      root.querySelector("[data-hint-panel]")?.dataset.hintPanel ||
      options.key ||
      "";
    if (panelKey && !panels.has(panelKey)) panel(hints, panelKey);
    index = Math.min(hints.length - 1, panels.get(panelKey)?.index || 0);
    if (panels.has(panelKey)) panels.get(panelKey).collapsed = false;
    onClose = options.onClose || null;
    // Chapter exercises already have a persistent step card; reuse it instead
    // of layering a second copy over the answer controls. Photo cards get an
    // equivalent inline bubble inside their own card.
    if (!root.querySelector("[data-hint-panel]")) {
      bubble = document.createElement("aside");
      bubble.className = "bx-hint-bubble bx-hint-inline";
      bubble.setAttribute("role", "note");
      bubble.setAttribute("aria-label", "一步一步提示");
      bubble.setAttribute("aria-live", "polite");
      root.append(bubble);
    }
    step();
  }
  function dismissForAttempt(event) {
    const control = event.target.closest?.(
      "[data-lesson-option],#lesson-answer,.study-composer textarea,.study-composer button,[data-study-discuss]",
    );
    if (!control) return;
    const question = control.closest?.("[data-lesson-question]"),
      element = question?.querySelector("[data-hint-panel]"),
      key = element?.dataset.hintPanel,
      value = key && panels.get(key);
    if (value && !value.collapsed) {
      value.collapsed = true;
      element.innerHTML = panelBody(key);
      remember(key);
    }
    // A capture-phase click keeps its original target even after the hint card
    // folds. Do not prevent or redispatch it: the answer handler must receive it.
    close();
  }
  // Pointer focus happens between pointerdown and pointerup. Folding here can
  // move the original option away from the release coordinate, losing the click.
  // Wait for the established click target, or for actual text input instead.
  document.addEventListener("click", dismissForAttempt, true);
  document.addEventListener("input", dismissForAttempt, true);
  window.addEventListener("resize", place);
  document.addEventListener("scroll", place, true);
  window.addEventListener("hashchange", close);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("button");
    if (!button) return;
    const d = button.dataset,
      key =
        d.hintToggle ||
        d.hintNext ||
        d.hintPrev ||
        d.hintLocate ||
        d.hintAttempt;
    if (!key || !panels.has(key)) return;
    const value = panels.get(key),
      element = button.closest("[data-hint-panel]"),
      question = button.closest("[data-lesson-question]");
    if (d.hintToggle) {
      value.collapsed = !value.collapsed;
      close();
      element.innerHTML = panelBody(key);
      return;
    }
    if (d.hintAttempt) {
      value.collapsed = true;
      close();
      element.innerHTML = panelBody(key);
      question?.querySelector("textarea")?.focus({ preventScroll: true });
      return;
    }
    value.index = Math.max(
      0,
      Math.min(
        value.steps.length - 1,
        value.index + (d.hintNext ? 1 : d.hintPrev ? -1 : 0),
      ),
    );
    show(question, value.steps);
  });
  document.addEventListener("click", () => {
    if (panelKey) remember(panelKey);
  });
  window.BX_HINTS = {
    show,
    close,
    panel,
    connect(value) {
      config = value;
    },
    restore(key, state) {
      if (!key || !state) return;
      try {
        localStorage.setItem(storageKey(key), JSON.stringify(state));
      } catch (_) {}
      panels.delete(key);
    },
  };
})();
