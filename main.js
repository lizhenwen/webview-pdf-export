const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, net, session, shell, webContents } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { classifyDownload } = require('./lib/classify');
const { safePdfFilename, safeDownloadFilename, filenameFromDisposition } = require('./lib/filenames');
const { fileIsPdf } = require('./lib/sniff');

const PARTITION = 'persist:pdf-webview';
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

app.setName('网页 PDF');

const hostWindows = new Set();
const activeDownloads = new Map();
const remotePdfs = new Map();
let nextDownloadWaiter = null;
let currentInline = null;
let publishTimer = null;
let pdfStore = null;
let historyStore = null;
let captureDir = '';

function captureSession() {
  return session.fromPartition(PARTITION);
}

function broadcast(channel, payload) {
  for (const win of hostWindows) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function publicItem(item) {
  return {
    id: item.id,
    filename: item.filename,
    url: item.url,
    mime: item.mime || '',
    size: item.size || 0,
    receivedBytes: item.receivedBytes || 0,
    totalBytes: item.totalBytes || 0,
    state: item.state,
    paused: Boolean(item.paused),
    receivedAt: item.receivedAt || Date.now(),
    referrer: item.referrer || '',
  };
}

function canonicalUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return String(url || '');
  }
}

function snapshot() {
  const active = [...activeDownloads.values()];
  const activeIds = new Set(active.map((item) => item.id));
  const activeUrls = new Set(active.map((item) => canonicalUrl(item.url)));
  const saved = (pdfStore ? pdfStore.items : []).filter((item) => !activeIds.has(item.id));
  const savedUrls = new Set(saved.map((item) => canonicalUrl(item.url)));
  const savedNames = new Set(saved.map((item) => item.filename));
  const remote = [...remotePdfs.values()].filter((item) => {
    const key = canonicalUrl(item.url);
    return !savedUrls.has(key) && !activeUrls.has(key) && !savedNames.has(item.filename);
  });
  return [...active, ...remote, ...saved];
}

function publish(immediate = false) {
  const send = () => broadcast('pdf-list', snapshot().map(publicItem));
  if (immediate) {
    clearTimeout(publishTimer);
    publishTimer = null;
    send();
    return;
  }
  if (publishTimer) return;
  publishTimer = setTimeout(() => {
    publishTimer = null;
    send();
  }, 120);
}

function toast(message) {
  broadcast('toast', { message });
}

function setInline(next) {
  const referrer = typeof next.referrer === 'string' ? next.referrer : '';
  if (
    currentInline
    && currentInline.url === next.url
    && currentInline.filename === next.filename
    && currentInline.referrer === referrer
  ) return;
  currentInline = { url: next.url, filename: next.filename, referrer };
  broadcast('inline-pdf', currentInline);
}

function clearInline() {
  if (!currentInline) return;
  currentInline = null;
  broadcast('inline-pdf', null);
}

function headerValue(headers, name) {
  if (!headers) return '';
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name);
  if (!key) return '';
  const value = headers[key];
  return Array.isArray(value) ? value.join(', ') : String(value);
}

function responseStatus(details) {
  if (typeof details.statusCode === 'number') return details.statusCode;
  const match = /\s(\d{3})(?:\s|$)/.exec(details.statusLine || '');
  return match ? Number(match[1]) : 0;
}

function isPdfUrl(url) {
  try {
    return decodeURIComponent(new URL(url).pathname).toLowerCase().endsWith('.pdf');
  } catch {
    return false;
  }
}

function responseSize(headers) {
  const range = headerValue(headers, 'content-range');
  const total = /\/(\d+)\s*$/.exec(range || '');
  if (total) return Number(total[1]);
  const length = Number(headerValue(headers, 'content-length'));
  return Number.isFinite(length) && length > 0 ? length : 0;
}

function noteRemotePdf({ url, filename, size, referrer }) {
  const key = canonicalUrl(url);
  if (!/^https?:/i.test(key) && !key.startsWith('file:')) return;
  const safeReferrer = typeof referrer === 'string' && /^https?:\/\//i.test(referrer) ? referrer : '';
  const existing = remotePdfs.get(key);
  if (existing) {
    if (size && !existing.size) {
      existing.size = size;
      publish(false);
    }
    if (safeReferrer && !existing.referrer) existing.referrer = safeReferrer;
    return;
  }
  const alreadySaved = (pdfStore ? pdfStore.items : []).some((item) => canonicalUrl(item.url) === key);
  const alreadyActive = [...activeDownloads.values()].some((item) => canonicalUrl(item.url) === key);
  if (alreadySaved || alreadyActive) return;
  if (remotePdfs.size >= 40) {
    const oldest = [...remotePdfs.entries()].sort((a, b) => a[1].receivedAt - b[1].receivedAt)[0];
    if (oldest) remotePdfs.delete(oldest[0]);
  }
  remotePdfs.set(key, {
    id: crypto.randomUUID(),
    filename,
    url: key,
    referrer: safeReferrer,
    mime: 'application/pdf',
    size: size || 0,
    state: 'remote',
    receivedAt: Date.now(),
  });
  publish(true);
}

function forgetRemote(id) {
  for (const [key, item] of remotePdfs) {
    if (item.id === id) remotePdfs.delete(key);
  }
}

function onGuestNavigate(url) {
  if (!url || url === 'about:blank') {
    clearInline();
    return;
  }
  if (isPdfUrl(url)) {
    const filename = filenameFromDisposition('', url);
    setInline({ url, filename });
    noteRemotePdf({ url, filename, size: 0, referrer: '' });
    return;
  }
  if (currentInline && currentInline.url === url) return;
  clearInline();
}

function onHeaders(details, callback) {
  try {
    const status = responseStatus(details);
    const contentType = headerValue(details.responseHeaders, 'content-type').toLowerCase();
    const disposition = headerValue(details.responseHeaders, 'content-disposition');
    const isPdf = contentType.includes('pdf') || isPdfUrl(details.url);
    const attachment = /attachment/i.test(disposition);
    if (details.resourceType === 'mainFrame' && (status < 300 || status >= 400)) {
      if (isPdf && !attachment) {
        setInline({
          url: details.url,
          filename: filenameFromDisposition(disposition, details.url),
          referrer: details.referrer,
        });
      } else if (contentType && !isPdf) {
        clearInline();
      }
    }
    if (isPdf && !attachment && status >= 200 && status < 300) {
      noteRemotePdf({
        url: details.url,
        filename: filenameFromDisposition(disposition, details.url),
        size: responseSize(details.responseHeaders),
        referrer: details.referrer,
      });
    }
  } catch (error) {
    console.error(error);
  }
  callback({ responseHeaders: details.responseHeaders });
}

function popupOptions() {
  return {
    width: 960,
    height: 720,
    title: '网页 PDF',
    backgroundColor: '#f3efe6',
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
    },
  };
}

function isHistoryUrl(url) {
  if (typeof url !== 'string' || !url || url.length > 16000) return false;
  if (url === 'about:blank') return false;
  return /^(https?:\/\/|file:)/i.test(url);
}

function cleanTitle(title, url) {
  const text = String(title || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text || text === url) return '';
  return text.slice(0, 180);
}

function attachGuestBehavior(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (url && !/^(https?:\/\/|about:blank$)/i.test(url)) return { action: 'deny' };
    return { action: 'allow', overrideBrowserWindowOptions: popupOptions() };
  });
  contents.on('did-navigate', (_event, url) => {
    onGuestNavigate(url);
    if (historyStore) historyStore.visit(url, contents.getTitle());
  });
  contents.on('page-title-updated', (_event, title) => {
    if (historyStore) historyStore.rename(contents.getURL(), title);
  });
}

function uniquePath(dir, filename) {
  const safe = path.basename(filename);
  const ext = path.extname(safe);
  const stem = path.basename(safe, ext);
  let candidate = path.join(dir, safe);
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem} (${index})${ext}`);
    index += 1;
  }
  return candidate;
}

async function moveFile(from, to) {
  try {
    await fs.promises.rename(from, to);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await fs.promises.copyFile(from, to);
    await fs.promises.unlink(from);
  }
}

async function resolveInside(root, target) {
  const base = await fs.promises.realpath(root);
  const resolved = await fs.promises.realpath(target);
  const prefix = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
  if (resolved !== base && !resolved.startsWith(prefix)) throw new Error('文件路径无效');
  return resolved;
}

function assertId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('无效的 PDF');
  }
}

function onWillDownload(_event, item) {
  const originalName = item.getFilename() || 'download';
  const mime = item.getMimeType() || '';
  const url = item.getURL();
  const kind = classifyDownload({ filename: originalName, mime, url });
  if (kind === 'other') return;

  const id = crypto.randomUUID();
  const savePath = path.join(captureDir, `${id}.pdf`);
  fs.mkdirSync(captureDir, { recursive: true });
  item.setSavePath(savePath);

  const record = {
    id,
    filename: safePdfFilename(originalName),
    fallbackName: safeDownloadFilename(originalName),
    url,
    mime,
    receivedBytes: 0,
    totalBytes: item.getTotalBytes(),
    state: 'progressing',
    paused: false,
    savePath,
    receivedAt: Date.now(),
    item,
  };
  activeDownloads.set(id, record);
  publish(true);

  let lastEmit = 0;
  item.on('updated', (_updateEvent, state) => {
    if (state !== 'progressing') return;
    const current = activeDownloads.get(id);
    if (!current) return;
    current.paused = item.isPaused();
    current.receivedBytes = item.getReceivedBytes();
    current.totalBytes = item.getTotalBytes();
    const now = Date.now();
    if (now - lastEmit > 120) {
      lastEmit = now;
      publish(false);
    }
  });

  item.once('done', async (_doneEvent, state) => {
    const current = activeDownloads.get(id);
    try {
      if (state !== 'completed') {
        activeDownloads.delete(id);
        await fs.promises.unlink(savePath).catch(() => {});
        publish(true);
        if (state !== 'cancelled') toast(`下载中断：${record.filename}`);
        nextDownloadWaiter?.reject(new Error(state === 'cancelled' ? '下载已取消' : '下载中断'));
        nextDownloadWaiter = null;
        return;
      }

      const pdf = await fileIsPdf(savePath);
      if (!pdf) {
        activeDownloads.delete(id);
        const dest = uniquePath(app.getPath('downloads'), current?.fallbackName || safeDownloadFilename(originalName));
        await moveFile(savePath, dest);
        publish(true);
        toast(`「${originalName}」不是 PDF，已保存到下载文件夹`);
        nextDownloadWaiter?.reject(new Error('这个地址返回的不是 PDF'));
        nextDownloadWaiter = null;
        return;
      }

      const stat = await fs.promises.stat(savePath);
      const saved = {
        id,
        filename: safePdfFilename(originalName),
        url,
        mime: mime || 'application/pdf',
        size: stat.size,
        savePath,
        state: 'completed',
        receivedAt: Date.now(),
      };
      activeDownloads.delete(id);
      pdfStore.add(saved);
      publish(true);
      toast(`已捕获 ${saved.filename}`);
      nextDownloadWaiter?.resolve(saved);
      nextDownloadWaiter = null;
    } catch (error) {
      console.error(error);
      activeDownloads.delete(id);
      publish(true);
      toast(error instanceof Error ? error.message : '保存 PDF 失败');
      nextDownloadWaiter?.reject(error instanceof Error ? error : new Error('保存 PDF 失败'));
      nextDownloadWaiter = null;
    }
  });
}

function viewerScript(filename, download) {
  const downloadLine = download
    ? `const blob = new Blob([data], { type: 'application/pdf' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = ${JSON.stringify(filename)};
      document.body.appendChild(link);
      link.click();
      link.remove();
      return true;`
    : 'return true;';
  return `(async () => {
    const app = window.PDFViewerApplication;
    if (!app) return false;
    try {
      if (!app.pdfDocument && app.pdfLoadingTask) await app.pdfLoadingTask.promise;
    } catch {
      return false;
    }
    if (!app.pdfDocument || typeof app.pdfDocument.getData !== 'function') return false;
    if (!${download ? 'true' : 'false'}) return true;
    const data = await app.pdfDocument.getData();
    ${downloadLine}
  })()`;
}

function guestContentsList() {
  return webContents.getAllWebContents().filter((contents) => {
    if (contents.isDestroyed()) return false;
    if (contents.getType() === 'webview') return true;
    return contents.getType() === 'window' && contents.session === captureSession();
  });
}

async function runInGuestFrames(script) {
  for (const contents of guestContentsList()) {
    const root = contents.mainFrame;
    if (!root) continue;
    const frames = [root, ...root.framesInSubtree];
    for (const frame of frames) {
      if (frame.isDestroyed()) continue;
      try {
        if (await frame.executeJavaScript(script, true)) return true;
      } catch (error) {
        console.error(error);
      }
    }
  }
  return false;
}

async function saveOpenViewerPdf(filename) {
  if (!await runInGuestFrames(viewerScript(filename, false))) return null;
  toast('正在从当前页面提取 PDF…');

  let timer = null;
  const done = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      nextDownloadWaiter = null;
      reject(new Error('读取页面中的 PDF 超时'));
    }, 180000);
    nextDownloadWaiter = {
      resolve: (record) => {
        clearTimeout(timer);
        resolve(record);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    };
  });

  const started = await runInGuestFrames(viewerScript(filename, true));
  if (!started) {
    clearTimeout(timer);
    nextDownloadWaiter = null;
    throw new Error('当前页面的 PDF 还没加载完，请等阅读器打开后再另存为');
  }
  return done;
}

function downloadUrlToFile(url, dest, options = {}) {
  return new Promise((resolve, reject) => {
    const request = net.request({
      url,
      session: captureSession(),
      credentials: 'include',
    });
    request.setHeader('User-Agent', CHROME_UA);
    request.setHeader('Accept', 'application/pdf,application/octet-stream,*/*;q=0.8');
    if (options.referrer) request.setHeader('Referer', options.referrer);
    if (options.onRequest) options.onRequest(request);
    let settled = false;
    let timer = null;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { request.abort(); } catch { /* 请求可能已经结束 */ }
      fs.promises.unlink(dest).catch(() => {});
      reject(error instanceof Error ? error : new Error('下载失败'));
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const bumpTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(new Error('下载超时')), 120000);
    };
    bumpTimeout();

    request.on('response', (response) => {
      const status = response.statusCode || 0;
      if (status === 206) {
        response.on('data', () => {});
        response.on('end', () => fail(new Error('服务器只返回了 PDF 的一部分')));
        return;
      }
      if (status === 401 || status === 403) {
        response.on('data', () => {});
        response.on('end', () => fail(new Error('下载被拒绝，请确认网页仍处于登录状态后重试')));
        return;
      }
      if (status >= 400 || status === 304) {
        response.on('data', () => {});
        response.on('end', () => fail(new Error(`下载失败：HTTP ${status}`)));
        return;
      }
      const total = responseSize(response.headers || {});
      let received = 0;
      const file = fs.createWriteStream(dest);
      response.on('data', (chunk) => {
        received += chunk.length;
        bumpTimeout();
        if (options.onProgress) options.onProgress(received, total);
        if (!file.write(chunk)) {
          response.pause();
          file.once('drain', () => response.resume());
        }
      });
      response.on('end', () => file.end(() => succeed()));
      response.on('error', fail);
      response.on('aborted', () => fail(new Error('下载已中断')));
      file.on('error', fail);
    });
    request.on('error', fail);
    request.end();
  });
}

function assertExportUrl(url) {
  if (typeof url !== 'string' || url.length > 16000 || !/^https?:\/\//i.test(url)) {
    throw new Error('这个地址不能导出');
  }
}

function savedById(id) {
  assertId(id);
  const record = pdfStore.items.find((item) => item.id === id);
  if (!record) throw new Error('找不到这个 PDF，可能还在下载');
  return record;
}

function hookSession() {
  const ses = captureSession();
  ses.setUserAgent(CHROME_UA);
  ses.on('will-download', onWillDownload);
  ses.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, onHeaders);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: '网页 PDF',
    backgroundColor: '#f3efe6',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // webview 标签不能跑在沙箱渲染进程里。
      sandbox: false,
      webviewTag: true,
    },
  });

  hostWindows.add(win);
  win.on('closed', () => hostWindows.delete(win));
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const src = params.src || '';
    const allowed = !src || src === 'about:blank' || /^(https?:|file:)/i.test(src);
    if (!allowed) {
      event.preventDefault();
      return;
    }
    params.partition = PARTITION;
    webPreferences.partition = PARTITION;
    delete webPreferences.preload;
    delete webPreferences.preloadURL;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInWorker = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
  });
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('pdf-list', snapshot().map(publicItem));
    win.webContents.send('inline-pdf', currentInline);
    win.webContents.send('history-list', historyStore.list());
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function registerIpc() {
  ipcMain.handle('list-history', () => historyStore.list());
  ipcMain.handle('remove-history', (_event, id) => {
    historyStore.remove(id);
    return historyStore.list();
  });
  ipcMain.handle('clear-history', () => {
    historyStore.clear();
    return historyStore.list();
  });

  ipcMain.handle('list-pdfs', () => snapshot().map(publicItem));
  ipcMain.handle('get-inline-pdf', () => currentInline);
  ipcMain.handle('export-pdf', async (event, id) => {
    const record = savedById(id);
    await resolveInside(captureDir, record.savePath);
    const win = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'PDF 另存为',
      defaultPath: path.join(app.getPath('downloads'), record.filename),
      buttonLabel: '另存为',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return { canceled: true };
    await fs.promises.copyFile(record.savePath, filePath);
    return { canceled: false, filePath };
  });

  ipcMain.handle('export-all', async (event) => {
    const records = pdfStore.items.filter((item) => item.state === 'completed' && fs.existsSync(item.savePath));
    if (!records.length) throw new Error('还没有可导出的 PDF');
    const win = BrowserWindow.fromWebContents(event.sender);
    const picked = await dialog.showOpenDialog(win, {
      title: '选择导出文件夹',
      buttonLabel: '导出到这里',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true };
    const directory = picked.filePaths[0];
    let count = 0;
    for (const record of records) {
      await resolveInside(captureDir, record.savePath);
      const dest = uniquePath(directory, record.filename);
      await fs.promises.copyFile(record.savePath, dest);
      count += 1;
    }
    return { canceled: false, count, directory };
  });

  ipcMain.handle('export-inline', async (event, payload) => {
    const url = payload && payload.url;
    const filename = safePdfFilename(payload && payload.filename);
    const referrer = payload && typeof payload.referrer === 'string' && /^https?:\/\//i.test(payload.referrer)
      ? payload.referrer
      : '';
    assertExportUrl(url);
    const win = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'PDF 另存为',
      defaultPath: path.join(app.getPath('downloads'), filename),
      buttonLabel: '另存为',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return { canceled: true };

    const viewed = await saveOpenViewerPdf(filename);
    if (viewed) {
      await fs.promises.copyFile(viewed.savePath, filePath);
      remotePdfs.delete(canonicalUrl(url));
      publish(true);
      return { canceled: false, filePath };
    }

    const id = crypto.randomUUID();
    const savePath = path.join(captureDir, `${id}.pdf`);
    fs.mkdirSync(captureDir, { recursive: true });
    const record = {
      id,
      filename,
      url,
      referrer,
      mime: 'application/pdf',
      receivedBytes: 0,
      totalBytes: 0,
      state: 'progressing',
      savePath,
      receivedAt: Date.now(),
      item: { cancel() {} },
    };
    activeDownloads.set(id, record);
    remotePdfs.delete(canonicalUrl(url));
    publish(true);
    try {
      await downloadUrlToFile(url, savePath, {
        referrer,
        onRequest(request) {
          record.item = {
            cancel() {
              try { request.abort(); } catch { /* 请求可能已经结束 */ }
            },
          };
        },
        onProgress(received, total) {
          record.receivedBytes = received;
          record.totalBytes = total || record.totalBytes;
          publish(false);
        },
      });
      if (!await fileIsPdf(savePath)) throw new Error('这个地址返回的不是 PDF');
      await fs.promises.copyFile(savePath, filePath);
    } catch (error) {
      activeDownloads.delete(id);
      await fs.promises.unlink(savePath).catch(() => {});
      noteRemotePdf({ url, filename, size: record.totalBytes, referrer });
      publish(true);
      throw error;
    }

    const stat = await fs.promises.stat(savePath);
    activeDownloads.delete(id);
    pdfStore.add({
      id,
      filename,
      url,
      mime: 'application/pdf',
      size: stat.size,
      savePath,
      state: 'completed',
      receivedAt: Date.now(),
    });
    publish(true);
    return { canceled: false, filePath };
  });

  ipcMain.handle('reveal-pdf', async (_event, id) => {
    const record = savedById(id);
    const filePath = await resolveInside(captureDir, record.savePath);
    shell.showItemInFolder(filePath);
  });

  ipcMain.handle('open-pdf', async (_event, id) => {
    const record = savedById(id);
    const filePath = await resolveInside(captureDir, record.savePath);
    const error = await shell.openPath(filePath);
    if (error) throw new Error(error);
  });

  ipcMain.handle('remove-pdf', async (_event, id) => {
    assertId(id);
    const active = activeDownloads.get(id);
    if (active) {
      try { active.item?.cancel(); } catch { /* 下载可能已经结束 */ }
      activeDownloads.delete(id);
      await fs.promises.unlink(active.savePath).catch(() => {});
    }
    forgetRemote(id);
    const removed = pdfStore.remove(id);
    if (removed?.savePath) await fs.promises.unlink(removed.savePath).catch(() => {});
    publish(true);
  });

  ipcMain.handle('clear-pdfs', async () => {
    for (const active of activeDownloads.values()) {
      try { active.item?.cancel(); } catch { /* 下载可能已经结束 */ }
      await fs.promises.unlink(active.savePath).catch(() => {});
    }
    activeDownloads.clear();
    remotePdfs.clear();
    const old = pdfStore.clear();
    await Promise.all(old.map((item) => fs.promises.unlink(item.savePath).catch(() => {})));
    publish(true);
  });

  ipcMain.on('show-context-menu', (event, params) => {
    const link = typeof params?.linkURL === 'string' && params.linkURL
      ? params.linkURL
      : (typeof params?.srcURL === 'string' ? params.srcURL : '');
    const template = [
      { label: '后退', click: () => event.sender.send('nav-command', { action: 'back' }) },
      { label: '前进', click: () => event.sender.send('nav-command', { action: 'forward' }) },
      { label: '重新加载', click: () => event.sender.send('nav-command', { action: 'reload' }) },
    ];
    if (/^https?:\/\//i.test(link)) {
      template.push({ type: 'separator' });
      template.push({
        label: '打开链接',
        click: () => event.sender.send('nav-command', { action: 'open', url: link }),
      });
      template.push({
        label: '下载链接',
        click: () => event.sender.send('nav-command', { action: 'download', url: link }),
      });
      template.push({
        label: '复制链接',
        click: () => clipboard.writeText(link),
      });
    }
    Menu.buildFromTemplate(template).popup({ window: BrowserWindow.fromWebContents(event.sender) });
  });
}

class HistoryStore {
  constructor(file) {
    this.file = file;
    this.items = [];
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const items = Array.isArray(parsed.items) ? parsed.items : [];
      this.items = items.filter((item) => item && isHistoryUrl(item.url)).slice(0, 100);
    } catch {
      this.items = [];
    }
  }

  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ items: this.items }, null, 2));
    fs.renameSync(temp, this.file);
  }

  list() {
    return this.items.map((item) => ({
      id: item.id,
      url: item.url,
      title: item.title,
      visitedAt: item.visitedAt,
    }));
  }

  publish() {
    broadcast('history-list', this.list());
  }

  visit(url, title) {
    if (!isHistoryUrl(url)) return;
    const id = crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
    const previous = this.items.find((item) => item.id === id);
    const nextTitle = cleanTitle(title, url) || previous?.title || '';
    const entry = {
      id,
      url,
      title: nextTitle,
      visitedAt: Date.now(),
    };
    this.items = [entry, ...this.items.filter((item) => item.id !== id)].slice(0, 100);
    this.persist();
    this.publish();
  }

  rename(url, title) {
    if (!isHistoryUrl(url)) return;
    const id = crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
    const entry = this.items.find((item) => item.id === id);
    const nextTitle = cleanTitle(title, url);
    if (!entry || !nextTitle || entry.title === nextTitle) return;
    entry.title = nextTitle;
    this.persist();
    this.publish();
  }

  remove(id) {
    if (typeof id !== 'string' || !/^[0-9a-f]{16}$/i.test(id)) throw new Error('无效的历史记录');
    this.items = this.items.filter((item) => item.id !== id);
    this.persist();
    this.publish();
  }

  clear() {
    this.items = [];
    this.persist();
    this.publish();
  }
}

class PdfStore {
  constructor(file) {
    this.file = file;
    this.items = [];
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const items = Array.isArray(parsed.items) ? parsed.items : [];
      this.items = items.filter((item) => item && item.id && item.savePath && fs.existsSync(item.savePath));
    } catch {
      this.items = [];
    }
  }

  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ items: this.items }, null, 2));
    fs.renameSync(temp, this.file);
  }

  add(item) {
    this.items = [item, ...this.items.filter((row) => row.id !== item.id)];
    this.persist();
  }

  remove(id) {
    const found = this.items.find((row) => row.id === id) || null;
    this.items = this.items.filter((row) => row.id !== id);
    this.persist();
    return found;
  }

  clear() {
    const old = this.items;
    this.items = [];
    this.persist();
    return old;
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = [...hostWindows][0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.on('web-contents-created', (_event, contents) => {
    const type = contents.getType();
    if (type === 'webview') {
      contents.setUserAgent(CHROME_UA);
      attachGuestBehavior(contents);
      return;
    }
    if (type === 'window' && contents.session === captureSession()) {
      contents.setUserAgent(CHROME_UA);
      attachGuestBehavior(contents);
    }
  });

  app.whenReady().then(() => {
    captureDir = path.join(app.getPath('userData'), 'captured-pdfs');
    fs.mkdirSync(captureDir, { recursive: true });
    pdfStore = new PdfStore(path.join(app.getPath('userData'), 'captured-pdfs.json'));
    pdfStore.load();
    historyStore = new HistoryStore(path.join(app.getPath('userData'), 'history.json'));
    historyStore.load();
    hookSession();
    registerIpc();
    createWindow();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
