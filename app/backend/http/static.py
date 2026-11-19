"""Public file manifest. Browser URLs remain stable across source moves."""

from pathlib import Path

PUBLIC_FILES = {
    "/account-notices.css": "frontend/styles/account-notices.css",
    "/email-account.js": "frontend/account/email-account.js",
    "/notifications.js": "frontend/account/notifications.js",
    "/ai-admin.js": "frontend/account/ai-admin.js",
    "/app.js": "frontend/shell/app.js",
    "/arena-learning.js": "frontend/learning/arena-learning.js",
    "/arena-review.js": "frontend/learning/arena-review.js",
    "/arena-ui.js": "frontend/learning/arena-ui.js",
    "/assets.html": "frontend/assets.html",
    "/audio-player.js": "frontend/media/audio-player.js",
    "/character-learning.css": "frontend/styles/character-learning.css",
    "/character-learning.js": "frontend/learning/character-learning.js",
    "/chat-render.js": "frontend/study/chat-render.js",
    "/chinese-ui.js": "frontend/learning/chinese-ui.js",
    "/community-ui.js": "frontend/learning/community-ui.js",
    "/curriculum.js": "frontend/shell/curriculum.js",
    "/hint-ui.js": "frontend/study/hint-ui.js",
    "/home-experience.js": "frontend/learning/home-experience.js",
    "/icons.js": "frontend/shell/icons.js",
    "/image-viewer.js": "frontend/media/image-viewer.js",
    "/index.html": "frontend/index.html",
    "/learning-ui.js": "frontend/learning/learning-ui.js",
    "/media-loader.css": "frontend/styles/media-loader.css",
    "/media-loader.js": "frontend/media/media-loader.js",
    "/parent-insights.js": "frontend/account/parent-insights.js",
    "/personal-learning.css": "frontend/styles/personal-learning.css",
    "/personal-learning.js": "frontend/learning/personal-learning.js",
    "/site-layout.css": "frontend/styles/site-layout.css",
    "/site-navigation.js": "frontend/shell/site-navigation.js",
    "/study-ui.css": "frontend/styles/study-ui.css",
    "/study-ui.js": "frontend/study/study-ui.js",
    "/styles.css": "frontend/styles/styles.css",
    "/ui-layout.css": "frontend/styles/ui-layout.css",
    "/vip-ui.css": "frontend/styles/vip-ui.css",
    "/vip-ui.js": "frontend/account/vip-ui.js",
    "/welcome-motion.css": "frontend/styles/welcome-motion.css",
}


def find_public_file(root: Path, path: str):
    if path in ("/", "/伴学爪_独立体验版.html"):
        path = "/index.html"
    if path in PUBLIC_FILES:
        return root / PUBLIC_FILES[path]
    if path.startswith("/assets/"):
        target = (root / path.lstrip("/")).resolve()
        if target.is_relative_to((root / "assets").resolve()):
            return target
    return None
