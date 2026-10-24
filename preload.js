const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = new Set(['pdf-list', 'toast', 'inline-pdf', 'nav-command']);

contextBridge.exposeInMainWorld('pdfApp', {
  listPdfs: () => ipcRenderer.invoke('list-pdfs'),
  getInlinePdf: () => ipcRenderer.invoke('get-inline-pdf'),
  getSampleUrl: () => ipcRenderer.invoke('get-sample-url'),
  exportPdf: (id) => ipcRenderer.invoke('export-pdf', id),
  exportAll: () => ipcRenderer.invoke('export-all'),
  exportInline: (payload) => ipcRenderer.invoke('export-inline', payload),
  revealPdf: (id) => ipcRenderer.invoke('reveal-pdf', id),
  openPdf: (id) => ipcRenderer.invoke('open-pdf', id),
  removePdf: (id) => ipcRenderer.invoke('remove-pdf', id),
  clearPdfs: () => ipcRenderer.invoke('clear-pdfs'),
  showContextMenu: (params) => ipcRenderer.send('show-context-menu', {
    linkURL: typeof params?.linkURL === 'string' ? params.linkURL.slice(0, 2000) : '',
    srcURL: typeof params?.srcURL === 'string' ? params.srcURL.slice(0, 2000) : '',
    pageURL: typeof params?.pageURL === 'string' ? params.pageURL.slice(0, 2000) : '',
  }),
  on(channel, callback) {
    if (!CHANNELS.has(channel)) throw new Error('不允许的事件');
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
