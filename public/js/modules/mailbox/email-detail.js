/**
 * 邮件详情模块
 * @module modules/mailbox/email-detail
 */

import { escapeHtml, escapeAttr } from '../app/ui-helpers.js';
import { formatTime } from './email-list.js';

/**
 * 渲染邮件正文。
 *
 * 统一改用 sandbox iframe 承载原始 HTML，与首页（modules/app/email-viewer.js）保持一致：
 * - `srcdoc` 经过 escapeAttr 转义，无法突破属性边界
 * - `sandbox` **不含 allow-scripts**，邮件内的脚本一律不执行
 * - 不做白名单裁剪，完整保留邮件原始排版（表格、样式、按钮都不会走样）
 *
 * @param {object} email - 邮件数据
 * @returns {string} 正文 HTML 片段
 */
function renderEmailBody(email) {
  if (email.html_content) {
    return `<div class="email-content-area"><iframe srcdoc="${escapeAttr(email.html_content)}" sandbox="allow-popups" style="width:100%;min-height:400px;border:none;display:block"></iframe></div>`;
  }
  return `<pre style="white-space: pre-wrap; word-break: break-word;">${escapeHtml(email.content || '')}</pre>`;
}

/**
 * 渲染邮件详情
 * @param {object} email - 邮件数据
 * @returns {string}
 */
export function renderEmailDetail(email) {
  if (!email) {
    return '<div class="empty-detail">请选择一封邮件</div>';
  }

  const sender = escapeHtml(email.sender || '未知发件人');
  const to = escapeHtml(email.to_addrs || '');
  const subject = escapeHtml(email.subject || '(无主题)');
  const receivedAt = formatTime(email.received_at);
  const verificationCode = email.verification_code || '';

  const content = renderEmailBody(email);

  let metaHtml = `<div class="email-meta-inline">`;
  metaHtml += `<span>发件人：${sender}</span>`;
  if (to) metaHtml += `<span>收件人：${to}</span>`;
  metaHtml += `<span>${receivedAt}</span>`;
  metaHtml += `</div>`;

  let codeHtml = '';
  if (verificationCode) {
    codeHtml = `<div class="code-highlight" onclick="navigator.clipboard.writeText('${escapeAttr(verificationCode)}')" title="点击复制" style="cursor:pointer">${escapeHtml(verificationCode)}</div>`;
  }

  return `
    <div class="email-detail-container">
      <h2 style="font-size:18px;font-weight:700;color:var(--text);word-break:break-all;padding:0 4px">${subject}</h2>
      ${metaHtml}
      ${codeHtml}
      ${content}
    </div>
  `;
}

/**
 * 使用白名单方式净化 HTML（保留以兼容既有导入）。
 *
 * ⚠️ 邮件正文渲染已统一改为 sandbox iframe，不再依赖本函数。
 * 若将来仍要使用，请注意它只能处理"标签/属性"层面的风险，
 * 无法防御 CSS 覆盖类攻击（如 position:fixed 伪造界面）。
 *
 * @param {string} html - 原始 HTML
 * @returns {string}
 */
export function sanitizeHtml(html) {
  if (!html) return '';

  // 白名单标签
  const ALLOWED_TAGS = new Set([
    'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'cite', 'code', 'col',
    'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em',
    'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
    'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q',
    's', 'samp', 'small', 'span', 'strong', 'sub', 'summary', 'sup',
    'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u',
    'ul', 'var', 'wbr'
  ]);

  // 白名单属性
  const ALLOWED_ATTRS = new Set([
    'align', 'bgcolor', 'border', 'cellpadding', 'cellspacing',
    'cite', 'colspan', 'datetime', 'headers', 'height', 'href',
    'hreflang', 'lang', 'rel', 'rowspan', 'scope', 'src',
    'style', 'target', 'title', 'valign', 'width'
  ]);

  // URI 协议白名单
  const SAFE_PROTOCOLS = ['http:', 'https:', 'mailto:', 'tel:'];

  // 禁止的 CSS 属性模式
  const DANGEROUS_CSS = /(expression|javascript|vbscript|url\s*\()/i;

  const temp = document.createElement('div');
  temp.innerHTML = html;

  // 递归清理节点
  function sanitizeNode(node) {
    if (node.nodeType === 1) { // Element node
      const tag = node.tagName.toLowerCase();

      if (!ALLOWED_TAGS.has(tag)) {
        // 移除不允许的标签，保留其文本内容。
        //
        // ⚠️ 关键：子节点被搬到父节点之后就离开了本节点的遍历范围，
        //    必须在这里主动递归净化，否则攻击者可以绕过白名单，例如
        //    <center><img src=x onerror="..."></center> —— center 被拆掉后，
        //    带 onerror 的 img 会原样留在结果里并执行脚本。
        const moved = Array.from(node.childNodes);
        const fragment = document.createDocumentFragment();
        for (const child of moved) {
          fragment.appendChild(child);
        }
        node.parentNode.replaceChild(fragment, node);
        for (const child of moved) {
          sanitizeNode(child);
        }
        return;
      }

      // 处理 href/src 属性
      for (const attr of ['href', 'src']) {
        if (node.hasAttribute(attr)) {
          const val = node.getAttribute(attr).trim().toLowerCase();
          if (!SAFE_PROTOCOLS.some(p => val.startsWith(p)) && !val.startsWith('/') && !val.startsWith('#') && !val.startsWith('data:image/')) {
            node.removeAttribute(attr);
          }
        }
      }

      // 移除不在白名单中的属性
      const attrsToRemove = [];
      for (let i = 0; i < node.attributes.length; i++) {
        const attr = node.attributes[i].name;
        if (!ALLOWED_ATTRS.has(attr)) {
          attrsToRemove.push(attr);
        }
      }
      for (const attr of attrsToRemove) {
        node.removeAttribute(attr);
      }

      // 净化 style 属性
      if (node.hasAttribute('style')) {
        const style = node.getAttribute('style');
        if (DANGEROUS_CSS.test(style)) {
          node.removeAttribute('style');
        }
      }

      // 递归处理子节点
      for (let i = node.childNodes.length - 1; i >= 0; i--) {
        sanitizeNode(node.childNodes[i]);
      }
    } else if (node.nodeType === 3) { // Text node
      // 文本节点安全，无需处理
    }
  }

  sanitizeNode(temp);
  return temp.innerHTML;
}

/**
 * 渲染邮件模态框内容
 * @param {object} email - 邮件数据
 * @returns {string}
 */
export function renderEmailModal(email) {
  if (!email) return '';

  const subject = escapeHtml(email.subject || '(无主题)');
  const sender = escapeHtml(email.sender || '未知发件人');
  const to = escapeHtml(email.to_addrs || '');
  const receivedAt = formatTime(email.received_at);
  const verificationCode = email.verification_code || '';

  const content = renderEmailBody(email);

  return `
    <div class="modal-header">
      <h3 class="modal-title">${subject}</h3>
      <button class="modal-close" data-action="close">&times;</button>
    </div>
    <div class="email-meta-inline">
      <span>发件人：${sender}</span>
      ${to ? `<span>收件人：${to}</span>` : ''}
      <span>${receivedAt}</span>
      ${verificationCode ? `<span class="code-highlight" data-code="${escapeAttr(verificationCode)}" title="点击复制" style="cursor:pointer">验证码：${escapeHtml(verificationCode)}</span>` : ''}
    </div>
    <div class="modal-body">
      ${content}
    </div>
    <div class="modal-footer">
      <button class="btn btn-danger" data-action="delete" data-email-id="${email.id}">删除邮件</button>
      <button class="btn btn-secondary" data-action="close">关闭</button>
    </div>
  `;
}

/**
 * 提取邮件中的验证码
 * @param {string} text - 邮件内容
 * @returns {string}
 */
export function extractVerificationCode(text) {
  if (!text) return '';

  const keywords = '(?:验证码|校验码|激活码|verification\\s+code|security\\s+code|otp|code)';

  // 关键词后的 4-8 位数字
  let m = text.match(new RegExp(keywords + '[^0-9]{0,20}(\\d{4,8})', 'i'));
  if (m) return m[1];

  // 全局 6 位数字
  m = text.match(/(?<!\d)(\d{6})(?!\d)/);
  if (m) return m[1];

  return '';
}

// 导出默认对象
export default {
  renderEmailDetail,
  sanitizeHtml,
  renderEmailModal,
  extractVerificationCode
};
