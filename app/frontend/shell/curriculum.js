(function () {
  "use strict";
  const SUBJECTS = {
    chinese: {
      name: "语文",
      short: "语",
      icon: "book-open",
      color: "#dc705f",
      tone: "coral",
      hint: "读文字，也读世界",
    },
    math: {
      name: "数学",
      short: "数",
      icon: "calculator",
      color: "#338fe3",
      tone: "blue",
      hint: "把问题想明白",
    },
    english: {
      name: "英语",
      short: "英",
      icon: "languages",
      color: "#2e9c7a",
      tone: "mint",
      hint: "Say hello to the world",
    },
  };
  window.BX_CURRICULUM = {
    SUBJECTS,
    GRADE_NAMES: ["一", "二", "三", "四", "五", "六"],
  };
})();
