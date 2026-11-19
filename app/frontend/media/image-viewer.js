(function () {
  "use strict";
  function open(app, url, title = "完整题图") {
    app.modal(
      title,
      `<div class="bx-image-tools" role="group" aria-label="题图缩放"><button class="secondary" data-image-action="out" aria-label="缩小">−</button><output aria-live="polite">100%</output><button class="secondary" data-image-action="in" aria-label="放大">＋</button><button class="secondary" data-image-action="fit">适屏</button><button class="text-action" data-image-action="retry">重新加载</button></div><p class="bx-image-status" role="status">正在加载原图…</p><div class="bx-image-stage" tabindex="0" aria-label="完整题图，可上下左右滑动查看"><img alt="完整题目文字与图示"></div><p class="study-save-note">放大后可上下、左右滑动。关闭后回到原来的作答位置。</p>`,
    );
    const stage = document.querySelector(".bx-image-stage"),
      image = stage.querySelector("img"),
      tools = document.querySelector(".bx-image-tools"),
      status = document.querySelector(".bx-image-status");
    let scale = 1,
      ready = false;
    const update = () => {
      image.style.width = Math.round(scale * 100) + "%";
      tools.querySelector("output").textContent = Math.round(scale * 100) + "%";
      tools.querySelector('[data-image-action="out"]').disabled =
        !ready || scale <= 0.5;
      tools.querySelector('[data-image-action="in"]').disabled =
        !ready || scale >= 4;
    };
    image.onload = () => {
      ready = true;
      status.textContent = "原图已加载";
      image.hidden = false;
      update();
    };
    const failed = () => {
      ready = false;
      image.hidden = true;
      status.textContent = "原图暂未加载成功，请点击“重新加载”。";
      update();
    };
    image.onerror = failed;
    image.addEventListener("bx-media-error", failed);
    const load = (force = false) => {
      ready = false;
      image.hidden = true;
      status.textContent = "正在加载原图…";
      update();
      if (window.BX_MEDIA) window.BX_MEDIA.load(image, url, force);
      else image.src = url;
    };
    tools.addEventListener("click", (event) => {
      const action = event.target.closest("button")?.dataset.imageAction;
      if (!action) return;
      if (action === "retry") {
        image.removeAttribute("src");
        load(true);
        return;
      }
      if (!ready) return;
      if (action === "fit") {
        scale = 1;
        stage.scrollTop = stage.scrollLeft = 0;
      } else
        scale = Math.max(
          0.5,
          Math.min(
            4,
            Math.round((scale + (action === "in" ? 0.25 : -0.25)) * 100) / 100,
          ),
        );
      update();
    });
    load();
  }
  window.BX_IMAGES = { open };
})();
