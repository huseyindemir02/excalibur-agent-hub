/* Local operator decision inbox. Question text is always rendered as text, never HTML. */
window.mountApprovalInbox = function ({ host, api, language, operator, projectTitle, openQuestion }) {
  const words = {
    tr: ['Onaylarım','Bekleyen onaylarım','Bekleyen onay yok.','Onayla','Reddet','Yazarak cevapla','Yanıtın','Yanıtı gönder','İptal','Kapat','İlgili mesaja git','24 saati geçti','Yüklenemedi. Yeniden dene.','Yenile','Yanıt kaydedilemedi. Yeniden dene.'],
    en: ['Approvals','My pending approvals','No approvals pending.','Approve','Reject','Write a reply','Your reply','Send reply','Cancel','Close','Go to message','Over 24 hours','Could not load. Try again.','Refresh','Could not save your reply. Try again.'],
    ja: ['承認待ち','自分の承認待ち','承認待ちはありません。','承認','却下','返信を書く','返信','返信を送信','キャンセル','閉じる','メッセージへ','24時間以上経過','読み込めませんでした。再試行してください。','更新','返信を保存できませんでした。再試行してください。'],
    ar: ['الموافقات','الموافقات المعلقة','لا توجد موافقات معلقة.','موافقة','رفض','كتابة رد','ردك','إرسال الرد','إلغاء','إغلاق','عرض الرسالة','أكثر من 24 ساعة','تعذر التحميل. حاول مجدداً.','تحديث','تعذر حفظ الرد. حاول مجدداً.'],
    zh: ['待审批','我的待审批事项','暂无待审批事项。','批准','拒绝','撰写回复','你的回复','发送回复','取消','关闭','查看消息','已超过24小时','加载失败，请重试。','刷新','回复保存失败，请重试。'],
  };
  const t = n => (words[language()] || words.en)[n];
  const node = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const style = node('style');
  style.textContent = `
    .approval-toggle {position:relative;flex:none;min-height:44px;padding:8px 12px;border:1px solid var(--line);border-radius:9px;background:var(--panel);color:var(--ink);cursor:pointer;font-weight:600}
    .approval-count {margin-inline-start:6px;border-radius:12px;padding:1px 7px;background:var(--accent);color:white;font-variant-numeric:tabular-nums}
    .approval-dialog {width:min(760px,96vw);max-height:86dvh;padding:0;border:1px solid var(--line);border-radius:14px;background:var(--panel);color:var(--ink);overflow:auto}
    .approval-dialog:not([open]){display:none}.approval-dialog::backdrop{background:rgba(11,20,26,.58)}
    .approval-head {position:sticky;top:0;background:var(--panel);z-index:1;display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid var(--line)}
    .approval-head h2{font-size:19px;margin:0;flex:1}.approval-dialog button{min-height:44px;cursor:pointer;border-radius:8px;padding:8px 12px;border:1px solid var(--line);background:var(--chip);color:var(--ink);font:inherit}
    .approval-list {padding:0 20px}.approval-item {padding:20px 0;border-bottom:1px solid var(--line)}
    .approval-meta{display:flex;flex-wrap:wrap;gap:6px 12px;font-size:12px;color:var(--muted)}.approval-overdue{color:#b65313;font-weight:700}
    .approval-question {font-size:15px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto;margin:12px 0}
    .approval-actions{display:flex;flex-wrap:wrap;gap:8px}.approval-dialog .approval-approve{background:#146b50;color:white;border-color:#146b50}.approval-dialog .approval-reject{color:#bf3540}
    .approval-error{color:#bf3540;white-space:pre-wrap}.approval-reply{display:grid;gap:8px;margin-top:12px}.approval-reply textarea{width:100%;min-height:100px;max-height:240px;resize:vertical;border:1px solid var(--line);border-radius:8px;padding:12px;background:var(--bg);color:var(--ink);font:inherit}
    .approval-empty{padding:28px 0;color:var(--muted)}.approval-dialog button:disabled{opacity:.6;cursor:wait}
    @media(max-width:480px){.approval-head{padding:12px}.approval-list{padding:0 14px}.approval-actions{display:grid;grid-template-columns:1fr 1fr}.approval-actions button:last-child{grid-column:1/-1}.approval-head h2{font-size:17px}}
  `;
  document.head.append(style);
  const toggle = node('button', null, 'approval-toggle'); toggle.type = 'button'; toggle.id = 'approvalInboxToggle';
  const label = node('span'); const badge = node('span', '0', 'approval-count'); const icon = node('span', '✓'); icon.setAttribute('aria-hidden', 'true'); icon.style.fontSize = '20px'; label.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)'; toggle.append(icon, label, badge); host.prepend(toggle);
  const dialog = node('dialog', null, 'approval-dialog'); dialog.id = 'approvalInbox'; dialog.setAttribute('aria-labelledby', 'approvalInboxTitle');
  const head = node('div', null, 'approval-head'); const title = node('h2'); title.id = 'approvalInboxTitle';
  const close = node('button'); close.type = 'button'; close.onclick = () => dialog.close(); head.append(title, close);
  const list = node('div', null, 'approval-list'); list.setAttribute('aria-live', 'polite'); dialog.append(head, list); document.body.append(dialog);
  let rows = [], loadFailed = false, loaded = false, version = 0;
  const busy = new Set(), drafts = new Map(), errors = new Map();
  function translated() { label.textContent = t(0); title.textContent = t(1); close.textContent = t(9); toggle.setAttribute('aria-label', `${t(1)}: ${loaded ? rows.length : '…'}`); toggle.title = t(1); }
  function render() {
    translated(); list.replaceChildren();
    if (loadFailed) {
      const p = node('p', t(12), 'approval-error'); p.setAttribute('role', 'alert'); list.append(p);
      const retry = node('button', t(13)); retry.type = 'button'; retry.onclick = refresh; list.append(retry); return;
    }
    if (!rows.length) { list.append(node('p', loaded ? t(2) : '…', 'approval-empty')); return; }
    for (const row of rows) {
      const item = node('article', null, 'approval-item'); item.dataset.approvalId = row.id;
      const meta = node('div', null, 'approval-meta'); meta.append(node('strong', projectTitle(row.project)), node('span', row.author));
      const date = node('time', new Intl.DateTimeFormat(language(), {dateStyle:'medium', timeStyle:'short'}).format(new Date(row.created_at))); date.dateTime = row.created_at; meta.append(date);
      if (Date.now() - Date.parse(row.created_at) >= 86400000) meta.append(node('span', t(11), 'approval-overdue'));
      const question = node('p', row.text, 'approval-question');
      const jump = node('button', t(10)); jump.type = 'button'; jump.onclick = async () => { try { await openQuestion(row); dialog.close(); } catch { errors.set(row.id, t(12)); render(); } };
      const actions = node('div', null, 'approval-actions');
      const act = (n, decision, cls) => { const b = node('button', t(n), cls); b.type = 'button'; b.disabled = busy.has(row.id); b.onclick = () => decision === 'reply' ? (drafts.set(row.id, drafts.get(row.id) || ''), render(), list.querySelector(`[data-approval-id="${row.id}"] textarea`)?.focus()) : answer(row.id, decision); actions.append(b); };
      act(3, 'approve', 'approval-approve'); act(4, 'reject', 'approval-reject'); act(5, 'reply');
      item.append(meta, question, jump, actions);
      if (errors.has(row.id)) { const err = node('p', errors.get(row.id), 'approval-error'); err.setAttribute('role', 'alert'); item.append(err); }
      if (drafts.has(row.id)) {
        const form = node('form', null, 'approval-reply'); const inputLabel = node('label', t(6));
        const input = node('textarea'); input.id = `approvalReply-${row.id}`; inputLabel.htmlFor = input.id; input.value = drafts.get(row.id); input.required = true; input.maxLength = 8000; input.disabled = busy.has(row.id); input.oninput = () => drafts.set(row.id, input.value);
        const submit = node('button', t(7)); submit.type = 'submit'; submit.disabled = busy.has(row.id);
        const cancel = node('button', t(8)); cancel.type = 'button'; cancel.disabled = busy.has(row.id); cancel.onclick = () => { drafts.delete(row.id); render(); };
        form.onsubmit = e => { e.preventDefault(); if (!input.value.trim()) return; input.blur(); answer(row.id, 'reply', input.value.trim()); };
        form.append(inputLabel, input, submit, cancel); item.append(form);
      }
      list.append(item);
    }
  }
  async function refresh() {
    const requestVersion = ++version;
    try {
      const result = await api('/api/approvals');
      if (requestVersion !== version) return;
      rows = result; loaded = true; loadFailed = false; badge.textContent = String(rows.length); badge.hidden = rows.length === 0;
    } catch { if (requestVersion !== version) return; loadFailed = true; badge.textContent = '!'; badge.hidden = false; }
    translated(); if (dialog.open && document.activeElement?.tagName !== 'TEXTAREA') render();
  }
  async function answer(id, decision, text) {
    if (busy.has(id)) return;
    busy.add(id); errors.delete(id); render();
    try {
      const actor = await operator();
      if (typeof actor !== 'string' || !actor.trim()) throw new Error('operator unavailable');
      await api('/api/approvals/resolve', {method:'POST', body:JSON.stringify({id, decision, text, as:actor, lang:language()})}); drafts.delete(id);
    }
    catch { errors.set(id, t(14)); }
    finally {
      busy.delete(id); await refresh();
      if (dialog.open) {
        render();
        const current = list.querySelector(`[data-approval-id="${id}"]`);
        (current?.querySelector('textarea, .approval-actions button') || list.querySelector('.approval-actions button') || close).focus();
      }
    }
  }
  toggle.onclick = () => { render(); dialog.showModal(); refresh(); };
  dialog.addEventListener('close', () => toggle.focus());
  translated(); refresh();
  return { refresh, translate: () => { translated(); if (dialog.open) render(); } };
};
