const webview = document.getElementById('browser');
const form = document.getElementById('nav-form');
const urlInput = document.getElementById('url');
const backBtn = document.getElementById('back');
const forwardBtn = document.getElementById('forward');
const reloadBtn = document.getElementById('reload');
const historyToggle = document.getElementById('history-toggle');
const historyPanel = document.getElementById('history');
const historyWrap = document.querySelector('.history-wrap');
const status = document.getElementById('status');
const list = document.getElementById('list');
const inlineBox = document.getElementById('inline');
const exportAllBtn = document.getElementById('export-all');
const clearBtn = document.getElementById('clear');
const toast = document.getElementById('toast');

let historyItems = [];
let currentItems = [];
let inlinePdf = null;
let inlineBusy = false;
let toastTimer = 0;
let webviewReady = false;

function withWebview(action) {
  if (webviewReady) {
    action();
    return;
  }
  const runOnce = () => {
    if (runOnce.done) return;
    runOnce.done = true;
    action();
  };
  webview.addEventListener('dom-ready', runOnce, { once: true });
  if (webviewReady) runOnce();
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}

async function run(action) {
  try {
    await action();
  } catch (error) {
    showToast(error && error.message ? error.message : '操作失败');
  }
}

function normalizeUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    return /^https?:\/\//i.test(text) ? text : '';
  }
  return `https://${text}`;
}

function navigate(raw) {
  const url = normalizeUrl(raw);
  if (!url) {
    showToast('请输入 http 或 https 网址');
    return;
  }
  openRecordedPage(url);
}

function openRecordedPage(url) {
  if (typeof url !== 'string' || !/^(https?:\/\/|file:)/i.test(url)) {
    showToast('这条记录无法打开');
    return;
  }
  withWebview(() => webview.loadURL(url));
  setHistoryOpen(false);
}

function setHistoryOpen(open) {
  historyPanel.classList.toggle('hidden', !open);
  historyPanel.hidden = !open;
  historyToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function renderHistory(items) {
  historyPanel.replaceChildren();
  const head = document.createElement('div');
  head.className = 'history-head';
  const title = document.createElement('strong');
  title.textContent = '打开过的网页';
  head.appendChild(title);
  historyPanel.appendChild(head);

  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'history-empty';
    empty.textContent = '还没有记录。打开一个网页后，会出现在这里。';
    historyPanel.appendChild(empty);
    return;
  }

  const listBox = document.createElement('div');
  listBox.className = 'history-list';
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'history-item';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'history-open';
    const name = document.createElement('strong');
    name.textContent = item.title || hostOf(item.url) || item.url;
    const meta = document.createElement('span');
    meta.textContent = `${hostOf(item.url)} · ${formatTime(item.visitedAt)}`;
    open.append(name, meta);
    open.addEventListener('click', () => openRecordedPage(item.url));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'history-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', '删除这条记录');
    remove.addEventListener('click', () => run(() => pdfApp.removeHistory(item.id)));
    row.append(open, remove);
    listBox.appendChild(row);
  }
  historyPanel.appendChild(listBox);

  const foot = document.createElement('div');
  foot.className = 'history-foot';
  foot.appendChild(actionButton('清空历史', '', async () => {
    if (!window.confirm('清空打开过的网页记录？')) return;
    await pdfApp.clearHistory();
  }));
  historyPanel.appendChild(foot);
}

function formatSize(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function hostOf(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'blob:') return '页面生成';
    return parsed.host || '本地文件';
  } catch {
    return '';
  }
}

function progressText(item) {
  if (item.paused) return '已暂停';
  if (item.totalBytes > 0) {
    const percent = Math.min(100, Math.round((item.receivedBytes / item.totalBytes) * 100));
    return `正在下载 ${percent}% · ${formatSize(item.receivedBytes)} / ${formatSize(item.totalBytes)}`;
  }
  return `正在下载 · 已接收 ${formatSize(item.receivedBytes)}`;
}

function syncNav() {
  try {
    backBtn.disabled = !webview.canGoBack();
    forwardBtn.disabled = !webview.canGoForward();
  } catch {
    backBtn.disabled = true;
    forwardBtn.disabled = true;
  }
}

function actionButton(label, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  if (className) button.className = className;
  button.addEventListener('click', () => run(onClick));
  return button;
}

function metaText(item) {
  if (item.state === 'remote') {
    const size = item.size ? `${formatSize(item.size)} · ` : '';
    return `${size}页面中的 PDF · ${hostOf(item.url)}`;
  }
  if (item.state === 'completed') {
    return `${formatSize(item.size)} · ${formatTime(item.receivedAt)} · ${hostOf(item.url)}`;
  }
  return progressText(item);
}

function renderItem(item) {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.id = item.id;

  const title = document.createElement('h2');
  title.textContent = item.filename;
  card.appendChild(title);

  const meta = document.createElement('p');
  meta.className = 'meta';
  meta.textContent = metaText(item);
  card.appendChild(meta);

  if (item.state === 'progressing' || item.state === 'interrupted') {
    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('span');
    fill.className = 'fill';
    if (item.totalBytes > 0) {
      fill.style.width = `${Math.min(100, Math.round((item.receivedBytes / item.totalBytes) * 100))}%`;
    } else {
      fill.classList.add('indeterminate');
    }
    bar.appendChild(fill);
    card.appendChild(bar);
    card.appendChild(actionButton('取消', '', () => pdfApp.removePdf(item.id)));
    return card;
  }

  const row = document.createElement('div');
  row.className = 'row';
  if (item.state === 'remote') {
    row.append(
      actionButton('另存为', 'primary', async () => {
        const result = await pdfApp.exportInline({
          url: item.url,
          filename: item.filename,
          referrer: item.referrer,
        });
        if (!result.canceled) showToast(`已另存 ${item.filename}`);
      }),
      actionButton('移除', '', () => pdfApp.removePdf(item.id)),
    );
  } else {
    row.append(
      actionButton('另存为', 'primary', async () => {
        const result = await pdfApp.exportPdf(item.id);
        if (!result.canceled) showToast(`已另存 ${item.filename}`);
      }),
      actionButton('打开', '', () => pdfApp.openPdf(item.id)),
      actionButton('显示', '', () => pdfApp.revealPdf(item.id)),
      actionButton('移除', '', () => pdfApp.removePdf(item.id)),
    );
  }
  card.appendChild(row);
  return card;
}

function updateExportAll(items) {
  const count = items.filter((item) => item.state === 'completed').length;
  exportAllBtn.disabled = count === 0;
  exportAllBtn.textContent = count ? `全部导出 (${count})` : '全部导出';
}

function renderList(items) {
  const scroll = list.scrollTop;
  list.replaceChildren();
  updateExportAll(items);
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '还没有 PDF。在左侧打开会下载 PDF 的网页后，文件会出现在这里。';
    list.appendChild(empty);
    return;
  }
  for (const item of items) list.appendChild(renderItem(item));
  list.scrollTop = scroll;
}

function updateDynamic(items) {
  updateExportAll(items);
  for (const item of items) {
    const card = list.querySelector(`[data-id="${CSS.escape(item.id)}"]`);
    if (!card) return false;
    const meta = card.querySelector('.meta');
    if (meta) {
      meta.textContent = metaText(item);
    }
    const fill = card.querySelector('.fill');
    if (fill && item.state !== 'completed') {
      if (item.totalBytes > 0) {
        fill.classList.remove('indeterminate');
        fill.style.width = `${Math.min(100, Math.round((item.receivedBytes / item.totalBytes) * 100))}%`;
      } else if (!fill.classList.contains('indeterminate')) {
        fill.classList.add('indeterminate');
        fill.style.width = '';
      }
    }
  }
  return true;
}

function sameStructure(next, prev) {
  if (next.length !== prev.length) return false;
  return next.every((item, index) => item.id === prev[index].id && item.state === prev[index].state);
}

function renderInline(inline) {
  inlineBox.replaceChildren();
  if (!inline) {
    inlineBox.classList.add('hidden');
    return;
  }
  inlineBox.classList.remove('hidden');
  const title = document.createElement('strong');
  title.textContent = '当前页面是 PDF';
  const name = document.createElement('p');
  name.textContent = inline.filename;
  const row = document.createElement('div');
  row.className = 'row';
  const save = actionButton('另存为', 'primary', async () => {
    if (inlineBusy) return;
    inlineBusy = true;
    try {
      const result = await pdfApp.exportInline(inline);
      if (!result.canceled) showToast(`已另存 ${inline.filename}`);
    } finally {
      inlineBusy = false;
    }
  });
  const capture = actionButton('捕获到列表', '', () => {
    withWebview(() => webview.downloadURL(inline.url));
  });
  row.append(save, capture);
  inlineBox.append(title, name, row);
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  navigate(urlInput.value);
});

backBtn.addEventListener('click', () => withWebview(() => webview.goBack()));
forwardBtn.addEventListener('click', () => withWebview(() => webview.goForward()));
reloadBtn.addEventListener('click', () => withWebview(() => webview.reload()));

historyToggle.addEventListener('click', () => {
  setHistoryOpen(historyPanel.hidden);
});

document.addEventListener('click', (event) => {
  if (!historyWrap.contains(event.target)) setHistoryOpen(false);
});

exportAllBtn.addEventListener('click', () => run(async () => {
  const result = await pdfApp.exportAll();
  if (!result.canceled) showToast(`已导出 ${result.count} 个 PDF`);
}));

clearBtn.addEventListener('click', () => run(async () => {
  if (!currentItems.length) return;
  if (!window.confirm('清空已捕获的 PDF？已另存到其他位置的副本不会删除。')) return;
  await pdfApp.clearPdfs();
}));

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setHistoryOpen(false);
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') {
    event.preventDefault();
    urlInput.focus();
    urlInput.select();
  }
});

webview.addEventListener('dom-ready', () => {
  webviewReady = true;
  syncNav();
});
webview.addEventListener('did-start-loading', () => {
  status.textContent = '正在打开…';
});
webview.addEventListener('did-stop-loading', () => {
  status.textContent = '';
  syncNav();
});
webview.addEventListener('did-navigate', (event) => {
  if (document.activeElement !== urlInput) urlInput.value = event.url || '';
  syncNav();
});
webview.addEventListener('did-navigate-in-page', (event) => {
  if (document.activeElement !== urlInput) urlInput.value = event.url || '';
  syncNav();
});
webview.addEventListener('page-title-updated', (event) => {
  document.title = event.title ? `${event.title} · 网页 PDF` : '网页 PDF';
});
webview.addEventListener('did-fail-load', (event) => {
  if (event.errorCode === -3 || event.isMainFrame === false) return;
  status.textContent = '';
  showToast(event.errorDescription || '页面打开失败');
});
webview.addEventListener('context-menu', (event) => {
  event.preventDefault();
  const params = event.params || {};
  pdfApp.showContextMenu({
    linkURL: params.linkURL || '',
    srcURL: params.srcURL || '',
    pageURL: params.pageURL || '',
  });
});

pdfApp.on('history-list', (items) => {
  historyItems = Array.isArray(items) ? items : [];
  renderHistory(historyItems);
});

pdfApp.on('pdf-list', (items) => {
  const next = Array.isArray(items) ? items : [];
  if (sameStructure(next, currentItems) && updateDynamic(next)) {
    currentItems = next;
    return;
  }
  currentItems = next;
  renderList(next);
});

pdfApp.on('toast', (payload) => {
  if (payload && payload.message) showToast(payload.message);
});

pdfApp.on('inline-pdf', (payload) => {
  inlinePdf = payload || null;
  renderInline(inlinePdf);
});

pdfApp.on('nav-command', (command) => {
  if (!command) return;
  if (command.action === 'back') withWebview(() => webview.goBack());
  if (command.action === 'forward') withWebview(() => webview.goForward());
  if (command.action === 'reload') withWebview(() => webview.reload());
  if (command.action === 'open') navigate(command.url);
  if (command.action === 'download' && /^https?:\/\//i.test(command.url || '')) {
    withWebview(() => webview.downloadURL(command.url));
  }
});

renderList([]);
renderHistory([]);
run(async () => {
  const [items, inline, history] = await Promise.all([
    pdfApp.listPdfs(),
    pdfApp.getInlinePdf(),
    pdfApp.listHistory(),
  ]);
  currentItems = Array.isArray(items) ? items : [];
  renderList(currentItems);
  inlinePdf = inline || null;
  renderInline(inlinePdf);
  historyItems = Array.isArray(history) ? history : [];
  renderHistory(historyItems);
});
syncNav();
urlInput.focus();
