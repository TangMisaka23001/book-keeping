// 轻量前端脚本：页面在构建时已渲染好倒计时，这里按访问当天再校正一次，
// 避免 GitHub Pages 静态页面放久了「N 天后」不准（不发起任何网络请求）。
(function () {
  "use strict";

  var DAY = 86400000;

  function todayInShanghai() {
    // en-CA 输出 YYYY-MM-DD，直接可用
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }

  function daysBetween(fromISO, toISO) {
    return Math.round((Date.parse(toISO + "T00:00:00Z") - Date.parse(fromISO + "T00:00:00Z")) / DAY);
  }

  function relLabel(days) {
    if (days < -1) return Math.abs(days) + " 天前";
    if (days === -1) return "昨天";
    if (days === 0) return "今天";
    if (days === 1) return "明天";
    return days + " 天后";
  }

  var today = todayInShanghai();

  document.querySelectorAll("[data-countdown]").forEach(function (el) {
    var iso = el.getAttribute("data-countdown");
    if (!iso) return;
    var days = daysBetween(today, iso);
    el.textContent = relLabel(days);
    el.setAttribute("title", iso + "（按 Asia/Shanghai 计算）");
  });

  document.querySelectorAll("[data-days-since]").forEach(function (el) {
    var iso = el.getAttribute("data-days-since");
    if (!iso) return;
    var days = Math.max(0, daysBetween(iso, today));
    el.textContent = String(days);
    el.setAttribute("title", iso + " 起算，按 Asia/Shanghai 计算");
  });
})();
