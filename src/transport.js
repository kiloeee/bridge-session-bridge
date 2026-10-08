// Bridge 原生传输（content script，isolated world）。
// 把迁移稿作为 DeepSeek composer 的正常文本状态写入：React 原生 value setter + InputEvent，
// 再触发真实发送控件。禁止 navigator.clipboard / paste 事件 / File / Blob / DataTransfer。
// 逻辑与 lab/native-transport.js（真机验证过）同源，这里做了生产化收敛。
// 注意：与 recorder-bridge.js / content.js 共享 isolated world 全局，必须包 IIFE。
(() => {
  if (window.__bridgeTransportInstalled) return;
  window.__bridgeTransportInstalled = true;

  const wait = ms => new Promise(r => setTimeout(r, ms));
  const raf2 = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  const visible = el => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const isTextInput = el => el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT');
  const isEnabled = b => !(b.disabled === true || b.getAttribute('aria-disabled') === 'true');

  function pickComposer() {
    const sel = 'textarea, input[type="text"], [contenteditable="true"], [contenteditable=""]';
    const live = [...document.querySelectorAll(sel)].filter(visible);
    live.sort((a, b) => (b.getBoundingClientRect().y - a.getBoundingClientRect().y)
      || (b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height));
    return live[0] || null;
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  }

  const readComposer = el => (isTextInput(el)
    ? String(el.value || '')
    : String(el.innerText || el.textContent || ''));

  function setComposerText(el, text) {
    el.focus();
    if (isTextInput(el)) {
      // React 受控输入忽略直接赋值；必须走原型上的原生 setter 再补 InputEvent。
      setNativeValue(el, text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      if (!document.execCommand('insertText', false, text)) {
        el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
    }
    return readComposer(el);
  }

  // 发送控件发现：① composer 右下主色圆形按钮（真机实测签名）② 空→非空状态翻转
  // ③ 具名 send ④ 右下角可用按钮兜底。全都不依赖页面文案。
  function sendCandidates(composer) {
    const cr = composer.getBoundingClientRect();
    return [...document.querySelectorAll('button, [role="button"]')].filter(visible)
      .filter(b => {
        const r = b.getBoundingClientRect();
        return r.bottom > cr.top - 300 && r.top < cr.bottom + 300;
      });
  }

  function armSendDetection() {
    const composer = pickComposer();
    if (!composer) return { armed: false, count: 0 };
    window.__bridgeArmedButtons = sendCandidates(composer)
      .map(b => ({ enabled: isEnabled(b) }));
    return { armed: true, count: window.__bridgeArmedButtons.length };
  }

  function findSendButton() {
    const composer = pickComposer();
    if (!composer) return { button: null, how: 'no-composer' };
    const btns = sendCandidates(composer);
    const nameOf = b => [b.getAttribute('aria-label'), b.getAttribute('data-testid'), b.getAttribute('title')]
      .filter(Boolean).join(' ');
    let pick = null, how = null;
    pick = btns.find(b => /ds-button--primary/.test(String(b.className)) && /ds-button--circle/.test(String(b.className)));
    if (pick) how = 'ds-primary-circle';
    if (!pick && window.__bridgeArmedButtons) {
      const flips = [];
      btns.forEach((b, i) => {
        const was = window.__bridgeArmedButtons[i];
        if (was && !was.enabled && isEnabled(b)) flips.push(b);
      });
      if (flips.length === 1) { pick = flips[0]; how = 'state-flip'; }
      else if (flips.length > 1) {
        pick = flips.find(b => /send|发送/i.test(nameOf(b)))
          || flips.map(b => ({ b, r: b.getBoundingClientRect() }))
            .sort((a, b) => (b.r.bottom + b.r.right) - (a.r.bottom + a.r.right))[0].b;
        how = 'state-flip-multi';
      }
    }
    if (!pick) {
      pick = btns.find(b => /send|发送/i.test(nameOf(b)) && isEnabled(b));
      if (pick) how = 'named';
    }
    if (!pick) {
      const cand = btns.filter(isEnabled).map(b => ({ b, r: b.getBoundingClientRect() }))
        .sort((a, b) => (b.r.bottom + b.r.right) - (a.r.bottom + a.r.right));
      if (cand.length) { pick = cand[0].b; how = 'right-most-enabled'; }
    }
    return { button: pick, how, composerRect: composer.getBoundingClientRect() };
  }

  function clickSend() {
    const { button, how } = findSendButton();
    if (!button) return { clicked: false, reason: 'no send candidate' };
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
      button.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    return { clicked: true, how };
  }

  // 注入 + 完整性验证：长度相等 + 首尾一致（防止渲染层截断只看开头漏掉的问题）。
  async function injectAndVerify(text) {
    const composer = pickComposer();
    if (!composer) return { ok: false, reason: 'no composer' };
    const t0 = performance.now();
    let rendered;
    try {
      rendered = setComposerText(composer, text);
    } catch (err) {
      return { ok: false, reason: `setComposerText threw: ${String(err).slice(0, 120)}` };
    }
    await wait(150);
    await raf2();
    const after = readComposer(composer);
    return {
      ok: true,
      composerTag: composer.tagName.toLowerCase(),
      contenteditable: composer.getAttribute('contenteditable'),
      inputChars: text.length,
      renderedChars: after.length,
      renderedMatches: after === text,
      headOk: after.slice(0, 60) === text.slice(0, 60),
      tailOk: after.slice(-40) === text.slice(-40),
      tookMs: Math.round(performance.now() - t0),
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (!msg || typeof msg !== 'object') return false;

    if (msg.type === 'BRIDGE_PING') {
      respond({ ok: true, ready: true, sessionId: (location.pathname.match(/\/a\/chat\/s\/([0-9a-f-]{36})/) || [])[1] || null, transport: true });
      return true;
    }

    if (msg.type === 'TRANSPORT_INJECT') {
      if (typeof msg.text !== 'string' || !msg.text) { respond({ ok: false, reason: 'empty text' }); return true; }
      armSendDetection();
      injectAndVerify(msg.text).then(respond).catch(err => respond({ ok: false, reason: String(err).slice(0, 160) }));
      return true;
    }

    if (msg.type === 'TRANSPORT_SEND') {
      respond(clickSend());
      return true;
    }

    return false;
  });
})();
