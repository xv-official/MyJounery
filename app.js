'use strict';
/* ==========================================================
   日程管理 · 逻辑
   功能：
   1. 主页面：今日 ToDoList（按时间排序）+ 汇总目标子任务
   2. 子页面：周/月/学期/年目标，子任务与进度增删改
   3. 每条待办/子任务/目标提供复制按钮
   4. 到点弹出通知（系统通知 + 页面内提示）
   5. 每条条目蓝色圆形按钮 → 右侧弹出 Markdown/纯文本笔记
   ========================================================== */

/* ---------------- 工具 ---------------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const STORAGE_KEY = 'myScheduleApp_v1';
const NOTIFY_KEY  = 'myScheduleNotified_v1';
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const GOAL_TYPES = ['年目标', '学期目标', '月目标', '周目标'];

const pad = n => String(n).padStart(2, '0');
const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => fmtDate(new Date());
const dateLine = d => `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · 星期${WEEK[d.getDay()]}`;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const escapeHtml = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

/* ---------------- 数据存取 ---------------- */
let store = loadStore();
let notified = {};
try { notified = JSON.parse(localStorage.getItem(NOTIFY_KEY)) || {}; } catch (e) { notified = {}; }
// 只保留今天的提醒记录
const _t = todayStr();
Object.keys(notified).forEach(k => { if (k !== _t) delete notified[k]; });

let expandedGoals = new Set();

function loadStore() {
  let d = null;
  try {
    d = JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch (e) { d = null; }
  if (!d || !Array.isArray(d.todos) || !Array.isArray(d.goals)) d = { todos: [], goals: [] };
  // 兼容旧数据：补齐 AI 拆解相关字段；进度改为全自动（小目标勾选 / 子任务完成度）
  d.goals.forEach(g => {
    g.subtasks = g.subtasks || [];
    g.actions  = g.actions  || [];   // AI 生成的行动
    g.subgoals = g.subgoals || [];   // AI 生成的阶段小目标（勾选完成）
    g.notes    = g.notes    || [];   // AI 生成的注意事项
    g.progress = calcGoalProgress(g);
  });
  return d;
}
function saveStore() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  scheduleNativeNotifySync();
}

/* ---------------- 图标 ---------------- */
const icons = {
  copy: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  doc:  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></svg>',
  trash:'<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  down: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M6 11l6 6 6-6M4 21h16"/></svg>',
  chevron:'<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>'
};

/* ---------------- 轻提示 ---------------- */
let toastTimer = null;
function toast(msg, duration) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), duration || 2200);
}

/* ---------------- 复制（功能4） ---------------- */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('已复制到剪贴板');
}

/* ---------------- Markdown 渲染 ---------------- */
function mdToHtml(src) {
  const lines = escapeHtml(src || '').split(/\r?\n/);
  const inline = s => s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  let html = '', ul = false, ol = false;
  const closeLists = () => {
    if (ul) { html += '</ul>'; ul = false; }
    if (ol) { html += '</ol>'; ol = false; }
  };
  lines.forEach(raw => {
    const line = raw.replace(/\s+$/, '');
    if (/^\s*$/.test(line)) { closeLists(); return; }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) {
      closeLists();
      const n = m[1].length;
      html += `<h${n}>${inline(m[2])}</h${n}>`;
      return;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { closeLists(); html += '<hr>'; return; }
    if ((m = line.match(/^\s*[-*+]\s+(.*)/))) {
      if (!ul) { closeLists(); html += '<ul>'; ul = true; }
      html += `<li>${inline(m[1])}</li>`;
      return;
    }
    if ((m = line.match(/^\s*\d+[.、]\s+(.*)/))) {
      if (!ol) { closeLists(); html += '<ol>'; ol = true; }
      html += `<li>${inline(m[1])}</li>`;
      return;
    }
    if ((m = line.match(/^&gt;\s?(.*)/))) { closeLists(); html += `<blockquote>${inline(m[1])}</blockquote>`; return; }
    closeLists();
    html += `<p>${inline(line)}</p>`;
  });
  closeLists();
  return html;
}

/* ==========================================================
   笔记弹层（功能6）：蓝色圆形按钮，悬停/点击在条目右侧弹出
   ========================================================== */
const popup = $('#notePopup');
const noteEdit = $('#noteEdit');
const noteView = $('#noteView');

let noteRef = null;      // { get, set, title }
let noteAnchor = null;   // 触发按钮
let notePinned = false;  // 点击后固定，不随鼠标离开关闭
let openTimer = null, closeTimer = null, saveTimer = null, savedTimer = null;
let noteDirty = false;

function attachNoteBtn(btn, ref) {
  btn.addEventListener('mouseenter', () => {
    clearTimeout(closeTimer);
    clearTimeout(openTimer);
    openTimer = setTimeout(() => openNote(ref, btn, false), 300);
  });
  btn.addEventListener('mouseleave', () => {
    clearTimeout(openTimer);
    if (!notePinned) {
      closeTimer = setTimeout(() => closeNote(), 380);
    }
  });
  btn.addEventListener('click', e => {
    e.stopPropagation();
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    if (notePinned && noteRef === ref) closeNote();
    else openNote(ref, btn, true);
  });
}

function noteIsOpen() { return !popup.classList.contains('hidden'); }

function openNote(ref, btn, pin) {
  flushNote(); // 若此前有未保存内容，先保存
  noteRef = ref;
  noteAnchor = btn;
  notePinned = pin;
  $('#noteTitle').textContent = '📝 ' + (ref.title || '笔记');
  noteEdit.value = ref.get();
  switchNoteTab('edit');
  popup.classList.remove('hidden');
  positionNote();
}

function closeNote() {
  if (!noteIsOpen()) return;
  flushNote();
  popup.classList.add('hidden');
  notePinned = false;
  noteRef = null;
  noteAnchor = null;
}

function positionNote() {
  if (!noteAnchor) return;
  const r = noteAnchor.getBoundingClientRect();
  const w = popup.offsetWidth || 330;
  const h = popup.offsetHeight || 300;
  // 始终弹出在条目右方；空间不足时向视口内钳制
  let left = r.right + 12;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  let top = Math.round(r.top + r.height / 2 - h / 2);
  top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
  popup.style.left = left + 'px';
  popup.style.top = top + 'px';
}

function switchNoteTab(tab) {
  const isEdit = tab === 'edit';
  $('#noteTabEdit').classList.toggle('active', isEdit);
  $('#noteTabView').classList.toggle('active', !isEdit);
  noteEdit.classList.toggle('hidden', !isEdit);
  noteView.classList.toggle('hidden', isEdit);
  if (!isEdit) noteView.innerHTML = mdToHtml(noteEdit.value) || '<p style="color:var(--muted)">（暂无内容）</p>';
}

function commitNote() {
  if (!noteRef) return;
  noteRef.set(noteEdit.value);
  saveStore();
  noteDirty = false;
  const s = $('#noteSave');
  s.textContent = '已保存 ✓';
  s.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => s.classList.remove('show'), 1500);
}

function flushNote() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    commitNote();
  }
}

noteEdit.addEventListener('input', () => {
  noteDirty = true;
  const s = $('#noteSave');
  s.textContent = '输入中…';
  s.classList.add('show');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; commitNote(); }, 600);
});
popup.addEventListener('mouseenter', () => clearTimeout(closeTimer));
popup.addEventListener('mouseleave', () => { if (!notePinned) closeTimer = setTimeout(() => closeNote(), 380); });
$('#noteClose').addEventListener('click', () => closeNote());
$('#noteTabEdit').addEventListener('click', () => switchNoteTab('edit'));
$('#noteTabView').addEventListener('click', () => switchNoteTab('view'));
document.addEventListener('click', e => {
  if (!noteIsOpen()) return;
  if (popup.contains(e.target)) return;
  if (noteAnchor && noteAnchor.contains(e.target)) return;
  closeNote();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeNote(); });
window.addEventListener('resize', () => { if (noteIsOpen()) positionNote(); });
window.addEventListener('scroll', () => {
  if (!noteIsOpen()) return;
  if (noteAnchor && document.contains(noteAnchor)) positionNote();
  else closeNote();
}, true);

/* ---------------- 通用小组件 ---------------- */
function opsWrap(buttons) {
  const ops = el('div', 'ops');
  buttons.forEach(b => ops.appendChild(b));
  return ops;
}
function iconBtn(cls, title, icon) {
  const b = el('button', 'op ' + cls, icon);
  b.type = 'button';
  b.title = title;
  return b;
}
function noteBtn(ref) {
  const b = iconBtn('note', '笔记 / Markdown（悬停或点击查看）', icons.doc);
  attachNoteBtn(b, ref);
  return b;
}
function copyBtn(getText) {
  const b = iconBtn('copy', '复制内容', icons.copy);
  b.addEventListener('click', () => copyText(getText()));
  return b;
}
function delBtn(fn, confirmMsg) {
  const b = iconBtn('del', '删除', icons.trash);
  b.addEventListener('click', e => {
    e.stopPropagation();
    if (confirmMsg && !confirm(confirmMsg)) return;
    fn();
  });
  return b;
}
function makeEditable(target, val, onSave) {
  const input = el('input', 'inline-edit');
  input.value = val;
  target.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const commit = () => {
    if (finished) return;
    finished = true;
    const v = input.value.trim();
    onSave(v || val);
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { finished = true; renderAll(); }
  });
}

/* ==========================================================
   主页面渲染
   ========================================================== */
function byTime(a, b) {
  const ta = a.time ? a.time.replace(':', '') : '9999';
  const tb = b.time ? b.time.replace(':', '') : '9999';
  return ta.localeCompare(tb);
}

function renderMain() {
  const today = todayStr();
  $('#todayDate').textContent = dateLine(new Date());

  /* 置顶：目标 → 阶段小目标 横向树（只展示已拆分小目标的目标） */
  renderGoalTree();

  /* 主体：今日所有待办 = 手动待办 + 目标的今日计划，按时间合并排序 */
  const todos = store.todos.filter(t => t.date === today);
  const plans = [];
  store.goals.forEach(g => g.subtasks.forEach(s => { if (s.date === today) plans.push({ s, g }); }));

  const items = [
    ...todos.map(t => ({ kind: 'todo', time: t.time, done: t.done, node: t })),
    ...plans.map(p => ({ kind: 'plan', time: p.s.time, done: p.s.done, node: p.s, goal: p.g }))
  ].sort((a, b) => byTime({ time: a.time }, { time: b.time }));

  const doneN = items.filter(i => i.done).length;
  $('#todoCount').textContent = items.length ? `${doneN}/${items.length} 已完成` : '';

  const list = $('#todoList');
  list.innerHTML = '';
  if (!items.length) {
    list.appendChild(el('li', 'empty', '今天还没有待办，在上方添加一条，或到「🎯 目标管理」给子任务设置今日日期 ☀️'));
  } else {
    items.forEach(i => list.appendChild(i.kind === 'todo' ? buildTodoRow(i.node) : buildPlanRow(i.node, i.goal)));
  }
}

/* ---------------- 置顶横向目标树 ---------------- */
function renderGoalTree() {
  const box = $('#goalTree');
  box.innerHTML = '';
  const goals = store.goals.filter(g => g.subgoals.length);
  const head = $('#treeCount');
  if (!goals.length) {
    head.textContent = '';
    box.appendChild(el('div', 'gtree-empty', '还没有拆分小目标的目标，到「🎯 目标管理」点「✨ AI 拆解」生成'));
    return;
  }
  const totalSub = goals.reduce((n, g) => n + g.subgoals.length, 0);
  const doneSub = goals.reduce((n, g) => n + g.subgoals.filter(s => (+s.progress || 0) >= 100).length, 0);
  head.textContent = `${doneSub}/${totalSub} 小目标`;

  goals.forEach(goal => {
    const row = el('div', 'gtree-row');

    // 根节点：目标（点击跳转目标管理并展开）
    const root = el('button', 'gtree-root' + (goal.progress >= 100 ? ' all-done' : ''));
    root.type = 'button';
    root.title = '点击查看目标详情';
    root.appendChild(el('span', 'gtree-root-type', goal.type));
    root.appendChild(el('span', 'gtree-root-name', goal.name));
    const rbar = el('span', 'gtree-root-bar');
    const rfill = el('i'); rfill.style.width = goal.progress + '%';
    rbar.appendChild(rfill);
    root.appendChild(rbar);
    root.appendChild(el('span', 'gtree-root-pct', goal.progress + '%'));
    root.addEventListener('click', () => {
      expandedGoals.add(goal.id);
      saveStore();
      switchPage('goal');
    });
    row.appendChild(root);

    // 子节点链：阶段小目标（横向，点击勾选）
    goal.subgoals.forEach((s, idx) => {
      const done = (+s.progress || 0) >= 100;
      const firstUndone = !done && goal.subgoals.slice(0, idx).every(x => (+x.progress || 0) >= 100);
      row.appendChild(el('span', 'gtree-arrow', '→'));
      const node = el('button', 'gtree-node' + (done ? ' done' : firstUndone ? ' current' : ''));
      node.type = 'button';
      node.title = done ? '点击标记为未完成' : '点击标记为已完成';
      node.appendChild(el('span', 'gtree-node-mark', done ? '✓' : String(idx + 1)));
      node.appendChild(el('span', 'gtree-node-text', s.text));
      node.addEventListener('click', () => {
        s.progress = done ? 0 : 100;
        recalcGoal(goal);
        renderAll();
      });
      row.appendChild(node);
    });

    box.appendChild(row);
  });
}

function buildTodoRow(todo) {
  const li = el('li', 'item' + (todo.done ? ' done' : ''));
  const cb = el('input', 'check');
  cb.type = 'checkbox';
  cb.checked = todo.done;
  cb.addEventListener('change', () => { todo.done = cb.checked; saveStore(); renderMain(); });
  li.appendChild(cb);

  if (todo.time) li.appendChild(el('span', 'time-chip', todo.time));

  const txt = el('span', 'item-text', escapeHtml(todo.text));
  txt.title = '双击编辑';
  txt.addEventListener('dblclick', () => makeEditable(txt, todo.text, v => { todo.text = v; saveStore(); renderMain(); }));
  li.appendChild(txt);

  li.appendChild(opsWrap([
    copyBtn(() => (todo.time ? todo.time + ' ' : '') + todo.text),
    noteBtn({ get: () => todo.note, set: v => { todo.note = v; }, title: (todo.time ? todo.time + ' ' : '') + todo.text }),
    delBtn(() => { store.todos = store.todos.filter(t => t.id !== todo.id); saveStore(); renderMain(); toast('已删除'); })
  ]));
  return li;
}

function buildPlanRow(sub, goal) {
  const li = el('li', 'item' + (sub.done ? ' done' : ''));
  const cb = el('input', 'check');
  cb.type = 'checkbox';
  cb.checked = sub.done;
  cb.addEventListener('change', () => { sub.done = cb.checked; recalcGoal(goal); renderAll(); }); // 与目标页同步
  li.appendChild(cb);

  if (sub.time) li.appendChild(el('span', 'time-chip', sub.time));

  const tag = el('span', 'tag', escapeHtml(goal.type + '—' + goal.name));
  tag.title = goal.type + '—' + goal.name;
  li.appendChild(tag);

  const txt = el('span', 'item-text', escapeHtml(sub.text));
  txt.title = '双击编辑';
  txt.addEventListener('dblclick', () => makeEditable(txt, sub.text, v => { sub.text = v; saveStore(); renderAll(); }));
  li.appendChild(txt);

  li.appendChild(opsWrap([
    copyBtn(() => (sub.time ? sub.time + ' ' : '') + sub.text),
    noteBtn({ get: () => sub.note, set: v => { sub.note = v; }, title: goal.type + '—' + goal.name + ' · ' + sub.text }),
    delBtn(() => {
      goal.subtasks = goal.subtasks.filter(s => s.id !== sub.id);
      recalcGoal(goal); renderAll(); toast('已删除');
    })
  ]));
  return li;
}

/* ==========================================================
   目标子页面渲染
   ========================================================== */

/* 目标总进度：完全自动——优先按阶段小目标完成度，其次按计划子任务完成度 */
function calcGoalProgress(goal) {
  if (goal.subgoals.length) {
    // 勾选制下 progress 仅为 0/100；保留中间值兼容历史数据
    return Math.round(goal.subgoals.reduce((a, s) => a + Math.max(0, Math.min(100, (+s.progress) || 0)), 0) / goal.subgoals.length);
  }
  if (goal.subtasks.length) {
    return Math.round(goal.subtasks.filter(s => s.done).length / goal.subtasks.length * 100);
  }
  return 0;
}
function recalcGoal(goal) { goal.progress = calcGoalProgress(goal); saveStore(); }

function renderGoals() {
  const wrap = $('#goalGroups');
  wrap.innerHTML = '';
  let any = false;
  GOAL_TYPES.forEach(type => {
    const gs = store.goals.filter(g => g.type === type);
    if (!gs.length) return;
    any = true;
    const group = el('div', 'goal-group');
    group.appendChild(el('div', 'section-head',
      `<h2>${type}</h2><span class="count">${gs.length} 个</span>`));
    gs.forEach(g => group.appendChild(buildGoalCard(g)));
    wrap.appendChild(group);
  });
  if (!any) wrap.appendChild(el('div', 'empty', '还没有目标，创建第一个吧 🎯'));
}

function goalCopyText(goal) {
  const lines = [`【${goal.type}—${goal.name}】 进度 ${goal.progress}%`];
  if (goal.actions.length) {
    lines.push('需要的行动：');
    goal.actions.forEach(a => lines.push(`- [${a.done ? 'x' : ' '}] ${a.text}`));
  }
  if (goal.subgoals.length) {
    lines.push('阶段小目标：');
    goal.subgoals.forEach(s => lines.push(`- [${(+s.progress || 0) >= 100 ? 'x' : ' '}] ${s.text}`));
  }
  if (goal.notes.length) {
    lines.push('注意事项：');
    goal.notes.forEach(n => lines.push(`· ${n.text}`));
  }
  if (goal.subtasks.length) {
    lines.push('计划子任务：');
    goal.subtasks.forEach(s => {
      const when = [s.date, s.time].filter(Boolean).join(' ');
      lines.push(`- [${s.done ? 'x' : ' '}] ${when ? when + ' ' : ''}${s.text}`);
    });
  }
  return lines.join('\n');
}

function exportGoal(goal) {
  const lines = [
    `# ${goal.type}—${goal.name}`,
    '',
    `> 进度：${goal.progress}%`,
    ''
  ];
  if (goal.note) lines.push(goal.note, '');
  if (goal.actions.length) {
    lines.push('## 需要的行动', '');
    goal.actions.forEach(a => lines.push(`- [${a.done ? 'x' : ' '}] ${a.text}`));
    lines.push('');
  }
  if (goal.subgoals.length) {
    lines.push('## 阶段小目标', '');
    goal.subgoals.forEach(s => lines.push(`- [${(+s.progress || 0) >= 100 ? 'x' : ' '}] ${s.text}`));
    lines.push('');
  }
  if (goal.notes.length) {
    lines.push('## 注意事项', '');
    goal.notes.forEach(n => lines.push(`- ${n.text}`));
    lines.push('');
  }
  lines.push('## 计划子任务', '');
  if (!goal.subtasks.length) lines.push('（暂无子任务）');
  goal.subtasks.forEach(s => {
    const when = [s.date, s.time].filter(Boolean).join(' ');
    lines.push(`- [${s.done ? 'x' : ' '}] ${when ? when + ' ' : ''}${s.text}`);
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${goal.type}—${goal.name}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('已导出 Markdown 文件');
}

function buildGoalCard(goal) {
  const card = el('div', 'goal-card');
  const expanded = expandedGoals.has(goal.id);
  const doneN = goal.subtasks.filter(s => s.done).length;

  /* ---- 卡片头部 ---- */
  const head = el('div', 'goal-head');
  const info = el('div', 'goal-info');
  const title = el('div', 'goal-title', escapeHtml(goal.type + '—' + goal.name));
  title.title = '双击重命名';
  title.addEventListener('dblclick', e => {
    e.stopPropagation();
    makeEditable(title, goal.name, v => { goal.name = v; saveStore(); renderGoals(); });
  });
  const meta = el('div', 'goal-meta', `子任务 ${goal.subtasks.length} · 已完成 ${doneN} · 进度 ${goal.progress}%`);
  info.append(title, meta);

  const bar = el('div', 'bar');
  const fill = el('i');
  fill.style.width = goal.progress + '%';
  bar.appendChild(fill);
  const mini = el('div', 'goal-progress-mini');
  mini.appendChild(bar);

  const expBtn = iconBtn('exp', expanded ? '收起' : '展开', icons.chevron);
  expBtn.addEventListener('click', e => { e.stopPropagation(); toggleExpand(goal.id); });

  const ops = opsWrap([
    (() => {
      const b = el('button', 'ai-btn', '✨ AI 拆解');
      b.type = 'button';
      b.addEventListener('click', e => { e.stopPropagation(); aiGenerate(goal, b); });
      return b;
    })(),
    noteBtn({ get: () => goal.note, set: v => { goal.note = v; }, title: goal.type + '—' + goal.name }),
    copyBtn(() => goalCopyText(goal)),
    (() => { const b = iconBtn('exp', '导出为 Markdown 文件', icons.down); b.addEventListener('click', e => { e.stopPropagation(); exportGoal(goal); }); return b; })(),
    expBtn,
    delBtn(() => {
      store.goals = store.goals.filter(g => g.id !== goal.id);
      expandedGoals.delete(goal.id);
      saveStore(); renderGoals(); toast('目标已删除');
    }, `确定删除目标「${goal.type}—${goal.name}」及其全部内容吗？`)
  ]);
  ops.addEventListener('click', e => e.stopPropagation());

  head.append(info, mini, ops);
  head.addEventListener('click', () => toggleExpand(goal.id));
  card.appendChild(head);

  /* ---- 展开区 ---- */
  const body = el('div', 'goal-body' + (expanded ? '' : ' hidden'));

  // 进度（自动计算，不可手动拖动）
  const prow = el('div', 'progress-row readonly');
  prow.appendChild(el('label', null, '目标进度（自动）'));
  const pbar = el('div', 'bar pbar');
  const pfill = el('i');
  pfill.style.width = goal.progress + '%';
  pbar.appendChild(pfill);
  prow.appendChild(pbar);
  prow.appendChild(el('span', 'pval', goal.progress + '%'));
  const basis = goal.subgoals.length
    ? '按已勾选的阶段小目标计算'
    : goal.subtasks.length ? '按已完成的计划子任务计算' : '添加小目标或子任务后自动计算';
  prow.appendChild(el('span', 'auto-hint', basis));
  body.appendChild(prow);

  /* ---- AI 拆解三区（用户可见可改，可手动增删） ---- */
  body.appendChild(buildActionsBlock(goal));
  body.appendChild(buildSubgoalsBlock(goal));
  body.appendChild(buildNotesBlock(goal));

  /* ---- 手动计划子任务（设日期后进入今日待办） ---- */
  const planBlock = el('div', 'ai-block');
  planBlock.appendChild(el('div', 'block-title', '🗓 计划子任务（设置日期后进入今日待办）'));

  // 子任务列表
  const ul = el('ul', 'subtask-list');
  if (!goal.subtasks.length) {
    ul.appendChild(el('li', 'empty small', '还没有子任务，在下方添加第一个计划吧'));
  } else {
    goal.subtasks.forEach(s => ul.appendChild(buildSubtaskRow(goal, s)));
  }
  planBlock.appendChild(ul);

  // 添加子任务
  const form = el('form', 'subtask-form');
  const d = el('input'); d.type = 'date'; d.value = todayStr(); d.title = '计划日期（默认今天，出现在主页面"今日计划"中）';
  const t = el('input'); t.type = 'time'; t.title = '计划时间（可选）';
  const ti = el('input'); ti.type = 'text'; ti.required = true; ti.placeholder = '输入子任务 / 计划拆分…';
  const add = el('button', 'btn primary tiny', '＋ 添加'); add.type = 'submit';
  form.append(d, t, ti, add);
  form.addEventListener('submit', e => {
    e.preventDefault();
    goal.subtasks.push({ id: uid(), text: ti.value.trim(), date: d.value || null, time: t.value || null, done: false, note: '' });
    recalcGoal(goal);
    renderGoals();
  });
  planBlock.appendChild(form);
  body.appendChild(planBlock);

  card.appendChild(body);
  return card;
}

function toggleExpand(id) {
  if (expandedGoals.has(id)) expandedGoals.delete(id);
  else expandedGoals.add(id);
  renderGoals();
}

function buildSubtaskRow(goal, sub) {
  const li = el('li', 'item' + (sub.done ? ' done' : ''));
  const cb = el('input', 'check');
  cb.type = 'checkbox';
  cb.checked = sub.done;
  cb.addEventListener('change', () => { sub.done = cb.checked; recalcGoal(goal); renderAll(); });
  li.appendChild(cb);

  if (sub.date) li.appendChild(el('span', 'date-chip', sub.date.slice(5)));
  if (sub.time) li.appendChild(el('span', 'time-chip', sub.time));

  const txt = el('span', 'item-text', escapeHtml(sub.text));
  txt.title = '双击编辑';
  txt.addEventListener('dblclick', () => makeEditable(txt, sub.text, v => { sub.text = v; saveStore(); renderAll(); }));
  li.appendChild(txt);

  li.appendChild(opsWrap([
    copyBtn(() => {
      const when = [sub.date, sub.time].filter(Boolean).join(' ');
      return (when ? when + ' ' : '') + sub.text;
    }),
    noteBtn({ get: () => sub.note, set: v => { sub.note = v; }, title: goal.type + '—' + goal.name + ' · ' + sub.text }),
    delBtn(() => {
      goal.subtasks = goal.subtasks.filter(s => s.id !== sub.id);
      recalcGoal(goal); renderAll(); toast('已删除');
    })
  ]));
  return li;
}

/* ==========================================================
   AI 拆解三区：需要的行动 / 阶段小目标（进度条） / 注意事项
   ========================================================== */
function blockHeader(title, count) {
  const h = el('div', 'block-title', escapeHtml(title) + ' ');
  h.appendChild(el('span', 'count', String(count)));
  return h;
}

function inlineAdd(placeholder, onAdd) {
  const form = el('form', 'inline-add');
  const input = el('input');
  input.type = 'text';
  input.placeholder = placeholder;
  const btn = el('button', 'btn ghost tiny', '＋ 添加');
  btn.type = 'submit';
  form.append(input, btn);
  form.addEventListener('submit', e => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return;
    onAdd(v);
  });
  return form;
}

/* 需要的行动：可勾选清单 */
function buildActionsBlock(goal) {
  const wrap = el('div', 'ai-block');
  wrap.appendChild(blockHeader('⚡ 需要的行动', goal.actions.length));
  const ul = el('ul', 'subtask-list');
  if (!goal.actions.length) {
    ul.appendChild(el('li', 'ai-empty', '暂无内容，点击卡片右上角「✨ AI 拆解」自动生成，也可在下方手动添加'));
  } else {
    goal.actions.forEach(a => {
      const li = el('li', 'item' + (a.done ? ' done' : ''));
      const cb = el('input', 'check');
      cb.type = 'checkbox';
      cb.checked = !!a.done;
      cb.addEventListener('change', () => { a.done = cb.checked; saveStore(); renderGoals(); });
      li.appendChild(cb);

      const txt = el('span', 'item-text', escapeHtml(a.text));
      txt.title = '双击编辑';
      txt.addEventListener('dblclick', () => makeEditable(txt, a.text, v => { a.text = v; saveStore(); renderGoals(); }));
      li.appendChild(txt);

      li.appendChild(opsWrap([
        copyBtn(() => a.text),
        noteBtn({ get: () => a.note, set: v => { a.note = v; }, title: '行动 · ' + a.text }),
        delBtn(() => { goal.actions = goal.actions.filter(x => x.id !== a.id); saveStore(); renderGoals(); toast('已删除'); })
      ]));
      ul.appendChild(li);
    });
  }
  wrap.appendChild(ul);
  wrap.appendChild(inlineAdd('手动添加行动…', v => {
    goal.actions.push({ id: uid(), text: v, done: false, note: '' });
    saveStore(); renderGoals();
  }));
  return wrap;
}

/* 阶段小目标：勾选完成（与"行动"一致的划掉交互），总进度据此自动计算 */
function buildSubgoalsBlock(goal) {
  const wrap = el('div', 'ai-block');
  wrap.appendChild(blockHeader('🎯 阶段小目标', goal.subgoals.length));
  const ul = el('ul', 'subtask-list');
  if (!goal.subgoals.length) {
    ul.appendChild(el('li', 'ai-empty', '暂无内容，点击「✨ AI 拆解」自动拆分阶段小目标'));
  } else {
    goal.subgoals.forEach(s => {
      const done = (+s.progress || 0) >= 100;
      const li = el('li', 'item' + (done ? ' done' : ''));
      const cb = el('input', 'check');
      cb.type = 'checkbox';
      cb.checked = done;
      cb.title = '勾选即完成（自动更新目标进度）';
      cb.addEventListener('change', () => {
        s.progress = cb.checked ? 100 : 0;
        recalcGoal(goal);
        renderGoals();
      });
      li.appendChild(cb);

      const txt = el('span', 'item-text', escapeHtml(s.text));
      txt.title = '双击编辑';
      txt.addEventListener('dblclick', () => makeEditable(txt, s.text, v => { s.text = v; saveStore(); renderGoals(); }));
      li.appendChild(txt);

      li.appendChild(opsWrap([
        copyBtn(() => s.text + (s.progress >= 100 ? '（已完成）' : '')),
        noteBtn({ get: () => s.note, set: v => { s.note = v; }, title: '小目标 · ' + s.text }),
        delBtn(() => {
          goal.subgoals = goal.subgoals.filter(x => x.id !== s.id);
          recalcGoal(goal);
          renderGoals();
          toast('已删除');
        })
      ]));
      ul.appendChild(li);
    });
  }
  wrap.appendChild(ul);
  wrap.appendChild(inlineAdd('手动添加小目标…', v => {
    goal.subgoals.push({ id: uid(), text: v, progress: 0, note: '' });
    recalcGoal(goal);
    renderGoals();
  }));
  return wrap;
}

/* 注意事项：可编辑文本条目 */
function buildNotesBlock(goal) {
  const wrap = el('div', 'ai-block');
  wrap.appendChild(blockHeader('⚠️ 注意事项', goal.notes.length));
  const ul = el('ul', 'subtask-list');
  if (!goal.notes.length) {
    ul.appendChild(el('li', 'ai-empty', '暂无内容，点击「✨ AI 拆解」生成风险提醒与注意事项'));
  } else {
    goal.notes.forEach(n => {
      const li = el('li', 'item');
      const txt = el('span', 'item-text', escapeHtml(n.text));
      txt.title = '双击编辑';
      txt.addEventListener('dblclick', () => makeEditable(txt, n.text, v => { n.text = v; saveStore(); renderGoals(); }));
      li.appendChild(el('span', null, '💡'));
      li.appendChild(txt);
      li.appendChild(opsWrap([
        copyBtn(() => n.text),
        delBtn(() => { goal.notes = goal.notes.filter(x => x.id !== n.id); saveStore(); renderGoals(); toast('已删除'); })
      ]));
      ul.appendChild(li);
    });
  }
  wrap.appendChild(ul);
  wrap.appendChild(inlineAdd('手动添加注意事项…', v => {
    goal.notes.push({ id: uid(), text: v });
    saveStore(); renderGoals();
  }));
  return wrap;
}

/* ==========================================================
   大模型调用（多厂商 · 零后端：浏览器直连，Key 仅存本机）
   ========================================================== */
/* 厂商配置：均为 OpenAI 兼容接口、且已验证支持浏览器跨域直连
   （Kimi/月之暗面不返回 CORS 头，纯前端无法直连，故不纳入） */
const AI_PROVIDERS = [
  {
    id: 'deepseek', name: 'DeepSeek（deepseek-chat，低价）',
    url: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys', keyPrefix: 'sk-', jsonMode: true
  },
  {
    id: 'zhipu', name: '智谱 GLM-4-Flash（免费额度）',
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4-flash',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys', keyPrefix: '', jsonMode: false
  },
  {
    id: 'qwen', name: '通义千问 Qwen-Turbo（低价）',
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-turbo',
    keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1#/api-key', keyPrefix: 'sk-', jsonMode: false
  }
];
const AI_CFG_STORE = 'myScheduleAIConfig_v2';

let aiConfig = loadAIConfig();

function loadAIConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(AI_CFG_STORE));
    if (c && c.provider && AI_PROVIDERS.some(p => p.id === c.provider)) {
      return { provider: c.provider, keys: c.keys || {} };
    }
  } catch (e) { /* 忽略 */ }
  // 兼容旧版本：单一 DeepSeek Key
  const oldKey = (localStorage.getItem('myScheduleAIKey_v1') || '').trim();
  return { provider: 'deepseek', keys: oldKey ? { deepseek: oldKey } : {} };
}
function saveAIConfig() { localStorage.setItem(AI_CFG_STORE, JSON.stringify(aiConfig)); }
function currentProvider() { return AI_PROVIDERS.find(p => p.id === aiConfig.provider) || AI_PROVIDERS[0]; }
function getAIKey() { return (aiConfig.keys[aiConfig.provider] || '').trim(); }

function openAISettings() {
  // 首次打开时填充厂商下拉
  const sel = $('#aiProvider');
  if (!sel.options.length) {
    AI_PROVIDERS.forEach(p => {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = p.name;
      sel.appendChild(o);
    });
  }
  sel.value = aiConfig.provider;
  syncProviderFields();
  $('#aiModal').classList.remove('hidden');
}

function syncProviderFields() {
  const p = currentProvider();
  $('#aiKeyInput').value = getAIKey();
  $('#aiKeyHint').textContent = p.keyPrefix || '该厂商格式';
  $('#aiKeyLink').href = p.keyUrl;
  $('#aiEndpointInfo').textContent = `调用模型：${p.model}`;
  updateKeyStatus();
}

function updateKeyStatus() {
  const st = $('#aiKeyStatus');
  const k = getAIKey();
  const p = currentProvider();
  if (!k) { st.textContent = `${p.name.split('（')[0]}：当前未配置 Key`; st.className = 'key-status bad'; }
  else { st.textContent = `${p.name.split('（')[0]} Key 已配置：${'*'.repeat(6)}…${k.slice(-4)}`; st.className = 'key-status ok'; }
}

const AI_SYS_PROMPT = [
  '你是一名严格的目标规划助手。根据用户给出的目标，输出严格的 JSON 对象，包含以下字段：',
  '1) "actions"：字符串数组，3-6 条实现该目标所需的、可立即执行的行动。要求严格：每条必须以明确动作动词开头，并包含可检验的数量、频率或时间（如"每周一、三、五各跑步30分钟""每天精读1篇并写100字摘要"）；禁止"加强""提升""注意""尽量"等无法衡量、无法判断是否完成的空泛表述；',
  '2) "subgoals"：数组，每项为 {"text": string, "progress": number}，按时间先后把目标拆成 3-6 个阶段性小目标，progress 一律填 0。要求严格：每个小目标必须描述一个可判断是否达成的具体结果（如"能连续不停跑完3公里""模拟测试达到80分"），不要写成动作口号或模糊愿望；',
  '3) "notes"：字符串数组，2-5 条注意事项。请面向零基础新手撰写：用通俗的大白话讲清楚刚起步时最容易踩的坑、常见误区和正确的起步做法，必要时举一个简单例子；避免专业术语和说教，语气鼓励、让新手有信心开始。',
  '输出格式示例（仅示意结构，不要照抄内容）：',
  '{"actions":["行动1","行动2"],"subgoals":[{"text":"第一阶段小目标","progress":0}],"notes":["注意事项1"]}',
  '要求：贴合目标类型的时间尺度（周目标按天、月目标按周、学期目标按月、年目标按季度）；行动和小目标必须具体可衡量，每条不超过 40 字；只输出 JSON 对象，不要输出解释或 Markdown 代码块。'
].join('\n');

function clampProgress(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/* 鲁棒 JSON 提取：兼容个别厂商不支持强制 JSON 模式、返回带解释文字的情况 */
function extractJSON(raw) {
  let t = String(raw || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch (e) { /* 继续做花括号匹配 */ }
  const start = t.indexOf('{');
  if (start === -1) throw new Error('返回内容中未找到 JSON');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(t.slice(start, i + 1));
    }
  }
  throw new Error('返回的 JSON 不完整');
}

function parseAIResult(raw) {
  const o = extractJSON(raw);
  const toArr = v => Array.isArray(v) ? v : [];
  const textOf = x => typeof x === 'string' ? x.trim() : (x && (x.text || x.name || x.content) ? String(x.text || x.name || x.content).trim() : '');
  return {
    actions: toArr(o.actions).map(textOf).filter(Boolean),
    subgoals: toArr(o.subgoals).map(x => typeof x === 'string'
      ? { text: x.trim(), progress: 0 }
      : { text: textOf(x), progress: clampProgress(x.progress) })
      .filter(x => x.text),
    notes: toArr(o.notes).map(textOf).filter(Boolean)
  };
}

async function aiGenerate(goal, btn) {
  const provider = currentProvider();
  const key = getAIKey();
  if (!key) { toast('请先在「⚙️ AI 设置」中填写 API Key'); openAISettings(); return; }

  const hasOld = goal.actions.length || goal.subgoals.length || goal.notes.length;
  let overwrite = true;
  if (hasOld) {
    overwrite = confirm('该目标已有 AI 生成内容：\n\n【确定】= 覆盖并重新生成\n【取消】= 追加到现有内容之后');
  }

  const oldLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = '✨ 生成中…';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    const now = new Date();
    const todayStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 星期${'日一二三四五六'[now.getDay()]}`;
    let userContent = `今天日期：${todayStr}\n目标类型：${goal.type}\n目标名称：${goal.name}` +
      (goal.note ? `\n目标备注：\n${goal.note}` : '');
    // 追加模式：把已有内容告知模型，避免生成重复或高度雷同的条目
    if (!overwrite) {
      userContent += '\n\n以下为已有内容，请勿重复或高度雷同，只需补充新的条目：';
      if (goal.actions.length) userContent += '\n已有行动：' + goal.actions.map(a => a.text).join('；');
      if (goal.subgoals.length) userContent += '\n已有小目标：' + goal.subgoals.map(s => s.text).join('；');
      if (goal.notes.length) userContent += '\n已有注意事项：' + goal.notes.map(n => n.text).join('；');
    }
    const reqBody = {
      model: provider.model,
      messages: [
        { role: 'system', content: AI_SYS_PROMPT },
        { role: 'user', content: userContent }
      ],
      temperature: 0.5,
      max_tokens: 2000
    };
    if (provider.jsonMode) reqBody.response_format = { type: 'json_object' };
    const res = await fetch(provider.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify(reqBody),
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const providerName = provider.name.split('（')[0];
      if (res.status === 401) throw new Error('API Key 无效，请在「⚙️ AI 设置」中检查当前厂商的 Key');
      if (res.status === 402) throw new Error(`${providerName} 账户余额 / 额度不足`);
      if (res.status === 429) throw new Error('请求过于频繁或额度受限，请稍后再试');
      throw new Error(`${providerName} 接口错误 ${res.status}${detail ? '：' + detail.slice(0, 100) : ''}`);
    }

    const data = await res.json();
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    const r = parseAIResult(content);
    if (!r.actions.length && !r.subgoals.length && !r.notes.length) {
      throw new Error('模型未返回有效内容，请重试');
    }

    const newActions  = r.actions.map(text => ({ id: uid(), text, done: false, note: '' }));
    const newSubgoals = r.subgoals.map(s => ({ id: uid(), text: s.text, progress: s.progress, note: '' }));
    const newNotes    = r.notes.map(text => ({ id: uid(), text }));

    if (overwrite) {
      goal.actions = newActions;
      goal.subgoals = newSubgoals;
      goal.notes = newNotes;
    } else {
      goal.actions.push(...newActions);
      goal.subgoals.push(...newSubgoals);
      goal.notes.push(...newNotes);
    }
    // 目标总进度随小目标 / 子任务完成情况自动计算
    goal.progress = calcGoalProgress(goal);
    expandedGoals.add(goal.id);
    saveStore();
    renderGoals();
    toast(`✨ 已生成 ${newActions.length} 条行动、${newSubgoals.length} 个小目标、${newNotes.length} 条注意事项`);
  } catch (e) {
    if (e.name === 'AbortError') toast('请求超时，请检查网络后重试');
    else toast('AI 生成失败：' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = oldLabel;
  }
}

/* ==========================================================
   页面切换 / 表单事件
   ========================================================== */
function switchPage(p) {
  document.body.classList.remove('page-main', 'page-goal', 'page-settings');
  document.body.classList.add('page-' + p);
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.page === p));
  $('#page-main').classList.toggle('hidden', p !== 'main');
  $('#page-goal').classList.toggle('hidden', p !== 'goal');
  $('#page-settings').classList.toggle('hidden', p !== 'settings');
  if (p === 'main') renderMain(); else if (p === 'goal') renderGoals();
}

function renderAll() {
  closeNote();
  renderMain();
  renderGoals();
}

function init() {
  $('#todayDate').textContent = dateLine(new Date());
  $$('.nav-btn').forEach(b => b.addEventListener('click', () => switchPage(b.dataset.page)));

  /* 添加今日待办 */
  $('#todoForm').addEventListener('submit', e => {
    e.preventDefault();
    const time = $('#todoTime').value || null;
    const text = $('#todoText').value.trim();
    if (!text) return;
    store.todos.push({ id: uid(), date: todayStr(), time, text, done: false, note: '' });
    saveStore(); renderMain();
    $('#todoText').value = '';
    toast(time ? `已添加 ${time} 的待办` : '已添加待办');
  });

  /* 清除已完成 */
  $('#clearDone').addEventListener('click', () => {
    const today = todayStr();
    const n = store.todos.filter(t => t.date === today && t.done).length;
    if (!n) { toast('没有已完成的待办'); return; }
    store.todos = store.todos.filter(t => !(t.date === today && t.done));
    saveStore(); renderMain(); toast(`已清除 ${n} 条已完成待办`);
  });

  /* 创建目标 */
  $('#goalForm').addEventListener('submit', e => {
    e.preventDefault();
    const name = $('#goalName').value.trim();
    if (!name) return;
    const g = { id: uid(), type: $('#goalType').value, name, progress: 0, note: '', subtasks: [], actions: [], subgoals: [], notes: [] };
    store.goals.push(g);
    expandedGoals.add(g.id);
    saveStore(); renderGoals();
    $('#goalName').value = '';
    toast(`目标「${g.type}—${g.name}」已创建`);
  });

  /* 提醒开关 */
  updateNotifyBtn();
  $('#notifyBtn').addEventListener('click', async () => {
    if (isNative()) {
      const ok = await requestNativeNotifyPermission();
      if (ok) { toast('系统提醒已开启，到点自动通知，App 关闭也能提醒'); syncNativeNotifications(); }
      else toast('未获得通知权限，请在系统设置中允许通知');
      updateNotifyBtn();
      return;
    }
    if (!('Notification' in window)) { toast('当前浏览器不支持系统通知，仍会页面内提醒'); return; }
    if (Notification.permission === 'default') {
      Notification.requestPermission().then(p => {
        updateNotifyBtn();
        if (p === 'granted') toast('提醒已开启，到点将弹出通知');
      });
    } else if (Notification.permission === 'granted') {
      toast('提醒已开启，到点将弹出通知');
    } else {
      toast('通知被浏览器禁用，仍会进行页面内提醒');
    }
  });

  /* 数据备份 / 恢复 */
  $('#exportData').addEventListener('click', exportBackup);
  $('#importData').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if (f) importBackup(f);
    e.target.value = '';
  });

  /* AI 设置弹窗 */
  $('#aiSettingsBtn').addEventListener('click', openAISettings);
  $('#aiModalClose').addEventListener('click', () => $('#aiModal').classList.add('hidden'));
  $('#aiModal').addEventListener('click', e => { if (e.target.id === 'aiModal') $('#aiModal').classList.add('hidden'); });
  $('#aiProvider').addEventListener('change', e => {
    aiConfig.provider = e.target.value;
    saveAIConfig();
    syncProviderFields();
  });
  $('#aiKeySave').addEventListener('click', () => {
    const k = $('#aiKeyInput').value.trim();
    if (!k) { toast('请输入 API Key'); return; }
    aiConfig.keys[aiConfig.provider] = k;
    saveAIConfig();
    updateKeyStatus();
    toast(`${currentProvider().name.split('（')[0]} Key 已保存到本机浏览器`);
    $('#aiModal').classList.add('hidden');
  });
  $('#aiKeyClear').addEventListener('click', () => {
    delete aiConfig.keys[aiConfig.provider];
    saveAIConfig();
    $('#aiKeyInput').value = '';
    updateKeyStatus();
    toast('已清除当前厂商的 Key');
  });

  renderMain();
  renderGoals();

  /* 到点提醒检查 */
  checkDue();
  setInterval(checkDue, 25000);

  /* 原生 App：系统通知排期 + 安卓返回键 */
  initNative();
}

/* ==========================================================
   到点通知（功能5）
   ========================================================== */
function checkDue() {
  const now = new Date();
  const today = todayStr();
  notified[today] = notified[today] || {};
  const cur = now.getHours() * 60 + now.getMinutes();

  const items = [];
  store.todos.forEach(t => {
    if (t.date === today && t.time && !t.done) items.push({ id: 't' + t.id, time: t.time, text: t.text });
  });
  store.goals.forEach(g => g.subtasks.forEach(s => {
    if (s.date === today && s.time && !s.done) items.push({ id: 's' + s.id, time: s.time, text: s.text, from: g.type + '—' + g.name });
  }));

  let changed = false;
  items.forEach(it => {
    const [h, m] = it.time.split(':').map(Number);
    const diff = cur - (h * 60 + m);
    // 到点即提醒；若页面晚开，10 分钟内补提醒一次
    if (diff >= 0 && diff <= 10 && !notified[today][it.id]) {
      notified[today][it.id] = true;
      changed = true;
      const body = (it.from ? `【${it.from}】` : '') + it.text;
      toast('⏰ 提醒：' + body);
      if (!isNative() && 'Notification' in window && Notification.permission === 'granted') {
        try { new Notification('⏰ 待办提醒', { body }); } catch (e) { /* 忽略 */ }
      }
    }
  });
  if (changed) localStorage.setItem(NOTIFY_KEY, JSON.stringify(notified));
}

function updateNotifyBtn() {
  const nb = $('#notifyBtn');
  if (isNative()) { nb.textContent = '🔔 系统提醒'; return; }
  if (!('Notification' in window)) { nb.textContent = '🔔 通知不支持'; return; }
  const p = Notification.permission;
  nb.textContent = p === 'granted' ? '🔔 提醒已开启' : p === 'denied' ? '🔔 通知已被禁用' : '🔔 开启提醒';
}

/* ==========================================================
   原生 App（Capacitor）：系统级本地通知 / 返回键
   网页环境下这些函数全部安全空转，不影响双击 index.html 使用
   ========================================================== */
function isNative() {
  return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
}

let _notifPlugin = null;
function notifPlugin() {
  if (!isNative()) return null;
  if (!_notifPlugin) _notifPlugin = window.Capacitor.registerPlugin('LocalNotifications');
  return _notifPlugin;
}

/* 字符串 id → 稳定的 32 位正整数通知 id（同一待办重排时覆盖旧通知） */
function hashNotifId(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 2147483000;
}

async function requestNativeNotifyPermission() {
  const P = notifPlugin();
  if (!P) return false;
  try {
    // 创建通知渠道（Android 8+ 必须，否则通知不显示）
    try {
      await P.createChannel({
        id: 'schedule-notify',
        name: '待办提醒',
        description: '到点提醒今日待办和目标子任务',
        importance: 5,          // IMPORTANCE_HIGH：弹出+声音+震动
        visibility: 1,          // PUBLIC
        vibration: true,
        lights: true,
        sound: 'default_ringtone'
      });
    } catch (e) { /* 渠道已存在或创建失败，忽略 */ }

    const r = await P.requestPermissions();
    if (r.display === 'granted') {
      // 引导用户关闭电池优化（国产 ROM 默认杀后台，不关则 App 关闭后通知可能被拦截）
      guideBatteryOptimization();
    }
    return r.display === 'granted';
  } catch (e) { return false; }
}

/* 引导用户关闭电池优化（国产手机必须手动加白名单，否则关闭 App 后通知不弹） */
function guideBatteryOptimization() {
  // 检测手机品牌，给出对应的设置路径
  const ua = (navigator.userAgent || '').toLowerCase();
  let brand = '';
  if (ua.includes('mi') || ua.includes('redmi')) brand = '小米/红米';
  else if (ua.includes('huawei') || ua.includes('honor')) brand = '华为/荣耀';
  else if (ua.includes('oppo') || ua.includes('oneplus')) brand = 'OPPO/一加';
  else if (ua.includes('vivo')) brand = 'vivo';
  else if (ua.includes('samsung')) brand = '三星';
  else brand = '你的手机';

  const tips = brand ? `\n\n【${brand} 用户注意】\n请到系统设置 → 电池 → 找到"日程管理" → 允许后台运行/自启动` : '';

  // 用 toast 提示，不阻断流程
  setTimeout(() => {
    toast('✅ 通知权限已开启' + (tips ? '，建议同时关闭电池优化' : ''), 5000);
    if (tips) setTimeout(() => toast(tips, 6000), 2500);
  }, 500);
}

/* 全量重排：取消所有挂起通知 → 按当前数据重新注册未来时刻的未完成项 */
let _nsyncTimer = null;
function scheduleNativeNotifySync() {
  if (!isNative()) return;
  clearTimeout(_nsyncTimer);
  _nsyncTimer = setTimeout(syncNativeNotifications, 400);
}

async function syncNativeNotifications() {
  const P = notifPlugin();
  if (!P) return;
  try {
    const perm = await P.checkPermissions();
    if (perm.display !== 'granted') return;

    const pend = await P.getPending();
    if (pend.notifications && pend.notifications.length) {
      await P.cancel({ notifications: pend.notifications.map(n => ({ id: n.id })) });
    }

    const now = Date.now();
    const list = [];
    const pushItem = (item, from) => {
      if (item.done || !item.date || !item.time) return;
      const ts = new Date(item.date + 'T' + item.time + ':00').getTime();
      if (!Number.isFinite(ts) || ts <= now) return;
      list.push({
        id: hashNotifId((from ? 's' : 't') + item.id),
        title: '⏰ 待办提醒',
        body: ((from ? '【' + from + '】 ' : '') + item.time + ' ' + item.text).slice(0, 150),
        channelId: 'schedule-notify',
        schedule: { at: new Date(ts) }
      });
    };
    store.todos.forEach(t => pushItem(t, ''));
    store.goals.forEach(g => g.subtasks.forEach(s => pushItem(s, g.type + '—' + g.name)));

    if (list.length) await P.schedule({ notifications: list });
  } catch (e) { /* 排期失败静默，不影响主流程 */ }
}

async function initNative() {
  if (!isNative()) return;

  // 启动时创建通知渠道（Android 8+ 没有渠道通知不显示）
  try {
    const P = notifPlugin();
    if (P && P.createChannel) {
      await P.createChannel({
        id: 'schedule-notify',
        name: '待办提醒',
        description: '到点提醒今日待办和目标子任务',
        importance: 5,
        visibility: 1,
        vibration: true,
        lights: true,
        sound: 'default_ringtone'
      });
    }
  } catch (e) { /* 已存在则忽略 */ }

  // 回前台时校准一次（系统时间/数据可能已过期）
  document.addEventListener('resume', syncNativeNotifications);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNativeNotifications(); });
  syncNativeNotifications();

  // 安卓返回键：笔记弹层 → 目标页 → 退出
  try {
    const App = window.Capacitor.registerPlugin('App');
    await App.addListener('backButton', () => {
      const notePopup = $('#notePopup');
      const aiModal = $('#aiModal');
      if (notePopup && !notePopup.classList.contains('hidden')) closeNote();
      else if (aiModal && !aiModal.classList.contains('hidden')) aiModal.classList.add('hidden');
      else if (!$('#page-goal').classList.contains('hidden')) switchPage('main');
      else App.exitApp();
    });
  } catch (e) { /* 返回键不可用时忽略 */ }
}

/* ==========================================================
   数据备份 / 恢复（JSON）
   ========================================================== */
function buildBackupJSON() {
  return JSON.stringify({
    app: 'my-schedule',
    version: 2,
    exportedAt: new Date().toISOString(),
    data: store
  }, null, 2);
}

async function exportBackup() {
  const json = buildBackupJSON();
  const filename = `日程管理备份-${todayStr()}.json`;
  try {
    if (isNative()) {
      // App 内：写入缓存目录后调起系统分享（可存到下载/网盘/发送给自己）
      const Filesystem = window.Capacitor.registerPlugin('Filesystem');
      const Share = window.Capacitor.registerPlugin('Share');
      const b64 = btoa(unescape(encodeURIComponent(json)));
      const r = await Filesystem.writeFile({ path: filename, data: b64, directory: 'CACHE' });
      await Share.share({ title: '日程管理数据备份', url: r.uri });
    } else {
      const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    }
    toast('已导出全部数据备份（不含 API Key）');
  } catch (e) {
    toast('导出失败：' + e.message);
  }
}

function importBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      let payload = JSON.parse(reader.result);
      if (payload && payload.data) payload = payload.data; // 兼容包壳格式
      if (!payload || !Array.isArray(payload.todos) || !Array.isArray(payload.goals)) {
        throw new Error('格式不符');
      }
      if (!confirm('恢复备份将覆盖当前全部待办与目标，确定继续吗？')) return;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      toast('数据已恢复，正在刷新…');
      setTimeout(() => location.reload(), 600);
    } catch (e) {
      toast('恢复失败：备份文件格式不正确');
    }
  };
  reader.readAsText(file);
}

init();
