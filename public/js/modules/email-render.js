/**
 * 邮件渲染公共模块
 *
 * 统一三处邮件正文渲染（首页 app / 单个邮箱页 / 已发送页）：
 * 1. renderEmailFrame —— 用 sandbox iframe 承载原始 HTML
 * 2. extractLinks / renderLinksSection —— 提取并列出邮件里的链接，方便复制
 *
 * 为什么需要「提取链接」：
 * 邮件正文在 sandbox iframe 里渲染，按钮上的链接在手机上很难点中；
 * 而且像 Claude 的 magic-link 这类一次性凭据链接，必须复制出来在浏览器里打开，
 * 不能在聊天软件里转发（部分 App 会预取链接导致凭据失效）。
 *
 * @module modules/email-render
 */

import { escapeAttr, escapeHtml } from './app/ui-helpers.js';

/**
 * 给邮件 HTML 注入 <base target="_blank">。
 *
 * 邮件里的 <a> 大多没有 target，在 iframe 中点击会尝试在 iframe 内部跳转，
 * 而目标站点通常带 X-Frame-Options: DENY，结果就是「点了没反应」。
 * 注入 base 之后，点击一律开新标签页。
 *
 * 注意：不设置 base 的 href，所以不会影响邮件里相对路径的解析。
 *
 * @param {string} html
 * @returns {string}
 */
function withBaseTarget(html) {
  const tag = '<base target="_blank">';
  const s = String(html || '');
  if (/<head[^>]*>/i.test(s)) {
    return s.replace(/<head[^>]*>/i, (m) => m + tag);
  }
  if (/<html[^>]*>/i.test(s)) {
    return s.replace(/<html[^>]*>/i, (m) => m + '<head>' + tag + '</head>');
  }
  return '<!DOCTYPE html><html><head>' + tag + '</head><body>' + s + '</body></html>';
}

/**
 * 渲染邮件正文容器（sandbox iframe）。
 *
 * sandbox 说明：
 * - `allow-popups` 允许邮件里的 target=_blank 链接开新标签页
 * - `allow-popups-to-escape-sandbox` 让新标签页不受 sandbox 限制，
 *   否则目标站点（如 claude.ai）的 JS 跑不起来，链接等于废掉
 * - **不含 allow-scripts**，邮件自身的脚本一律不执行
 * - 不含 allow-same-origin，iframe 处于不透明源
 *
 * @param {string} html - 邮件 HTML 正文
 * @returns {string}
 */
export function renderEmailFrame(html) {
  const srcdoc = escapeAttr(withBaseTarget(html));
  return `<div class="email-content-area"><iframe srcdoc="${srcdoc}" sandbox="allow-popups allow-popups-to-escape-sandbox" style="width:100%;min-height:400px;border:none;display:block"></iframe></div>`;
}

/** 跟踪像素 / 回执类链接，列出来没有意义 */
const TRACKING_PATTERNS = [
  /\/wf\/open/i,        // Mailjet 阅读回执
  /\/o\/[a-z0-9]+$/i,   // 常见 open-tracking
  /\/open\?/i,
  /\/beacon/i,
  /\/pixel/i,
];

/** 静态资源：图片 / 字体 / 脚本，不是"可点的操作链接" */
const ASSET_EXT = /\.(png|jpe?g|gif|webp|svg|ico|bmp|css|js|mjs|woff2?|ttf|eot|otf|mp4|webm|mp3)(\?|#|$)/i;
const ASSET_HOSTS = /^(fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|unpkg\.com)$/i;

function isTracking(url) {
  if (TRACKING_PATTERNS.some((re) => re.test(url))) return true;
  if (ASSET_EXT.test(url)) return true;
  try {
    if (ASSET_HOSTS.test(new URL(url).host)) return true;
  } catch (_) { /* ignore */ }
  return false;
}

function normalizeUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) return '';
  // HTML 实体还原
  u = u.replace(/&amp;/gi, '&')
       .replace(/&#0*38;/g, '&')
       .replace(/&quot;/gi, '"')
       .replace(/&#0*39;/g, "'");
  if (!/^https?:\/\//i.test(u)) return '';
  // 去掉包裹/尾随标点
  u = u.replace(/^[<("']+/, '').replace(/[)\]}>.,;:'"]+$/, '');
  if (u.length > 4000) return '';
  if (isTracking(u)) return '';
  return u;
}

/**
 * 从邮件 HTML / 纯文本中提取所有 http(s) 链接（去重、保序）。
 *
 * @param {string} html - 邮件 HTML
 * @param {string} text - 邮件纯文本
 * @returns {string[]}
 */
export function extractLinks(html = '', text = '') {
  const seen = new Map();

  const push = (raw) => {
    const u = normalizeUrl(raw);
    if (u && !seen.has(u)) seen.set(u, true);
  };

  // ① href 属性（邮件里最关键的一类）
  const hrefRe = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m;
  while ((m = hrefRe.exec(html)) !== null) {
    push(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]));
  }

  // ② 纯文本里裸露的链接
  const urlRe = /https?:\/\/[^\s<>"'`)\]]+/gi;
  while ((m = urlRe.exec(text || '')) !== null) push(m[0]);

  // ③ HTML 里裸露的链接（有些邮件把 URL 直接写在文字里）
  while ((m = urlRe.exec(html || '')) !== null) push(m[0]);

  return Array.from(seen.keys());
}

/**
 * 生成用于显示的短路径。
 *
 * ⚠️ 只显示 pathname；**查询串和 # 片段一律隐藏**。
 * 因为一次性凭据常常就藏在这两处（例如 Claude 的 magic-link 把 token 放在 # 里），
 * 简单的"截断前 N 个字符"会把完整凭据显示出来。
 *
 * @param {string} url
 * @returns {string}
 */
function shortPath(url) {
  try {
    const u = new URL(url);
    let p = u.pathname || '/';
    if (p.length > 40) p = p.slice(0, 40) + '…';
    if (u.search) p += ' ?…';
    if (u.hash) p += ' #…';
    return p;
  } catch (_) {
    return '(无法解析)';
  }
}

function hostOf(url) {
  try { return new URL(url).host; } catch (_) { return url; }
}

/**
 * 渲染「邮件中的链接」区块。
 *
 * 出于安全考虑：
 * - 默认只显示域名 + 截断后的路径，**不展示完整 URL**
 * - 完整链接仅在点击「复制」时写入剪贴板
 * - 提示用户这类链接可能是一次性凭据，勿转发
 *
 * @param {string[]} links
 * @returns {string} 无链接时返回空字符串
 */
export function renderLinksSection(links) {
  if (!Array.isArray(links) || links.length === 0) return '';

  const rows = links.map((url, i) => `
    <div class="email-link-row">
      <div class="email-link-info">
        <div class="email-link-host">${escapeHtml(hostOf(url))}</div>
        <div class="email-link-path" title="完整链接已隐藏">${escapeHtml(shortPath(url))}</div>
      </div>
      <button type="button" class="email-link-copy" data-copy-url="${escapeAttr(url)}" data-copy-idx="${i}">复制</button>
    </div>`).join('');

  return `
    <details class="email-links">
      <summary>🔗 邮件中的链接（${links.length}）</summary>
      <div class="email-links-body">
        ${rows}
        <p class="email-links-tip">
          出于安全考虑，链接的查询参数与 # 片段默认隐藏（<code>?…</code> / <code>#…</code> 位置），
          点「复制」才会把<strong>完整链接</strong>写入剪贴板。<br>
          此类链接可能是一次性凭据，请直接粘贴到浏览器打开，<strong>不要转发到聊天软件</strong>
          （部分 App 会预取链接导致失效）。
        </p>
      </div>
    </details>`;
}

/**
 * 全局委托：处理「复制」按钮。
 *
 * 用 data 属性 + 事件委托，而不是内联 onclick ——
 * URL 里可能含有引号/反斜杠，塞进内联 onclick 的字符串里会破坏语法。
 */
if (typeof document !== 'undefined') {
  document.addEventListener('click', async (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest('[data-copy-url]') : null;
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();

    const url = btn.getAttribute('data-copy-url') || '';
    const original = btn.textContent;
    const flash = (txt) => {
      btn.textContent = txt;
      setTimeout(() => { btn.textContent = original; }, 1500);
    };

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url);
      } else {
        // 回退方案：老浏览器 / 非安全上下文
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      flash('已复制 ✓');
    } catch (_) {
      flash('复制失败');
    }
  });
}
