const path = require('path');

function safePdfFilename(name) {
  let base = path.basename(String(name || '未命名'))
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (base.toLowerCase().endsWith('.pdf')) base = base.slice(0, -4);
  base = base.replace(/[. ]+$/g, '').trim();
  if (!base) base = '未命名';
  if (base.length > 120) base = base.slice(0, 120).trim();
  return `${base}.pdf`;
}

function safeDownloadFilename(name) {
  const base = path.basename(String(name || 'download'))
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim();
  const cleaned = (base || 'download').replace(/[. ]+$/g, '');
  return (cleaned || 'download').slice(0, 120);
}

function filenameFromDisposition(disposition, url) {
  const header = disposition || '';
  const encoded = /filename\*\s*=\s*([^']*)''([^;]+)/i.exec(header);
  if (encoded) {
    const raw = encoded[2].trim().replace(/^"(.*)"$/, '$1');
    try {
      return safePdfFilename(decodeURIComponent(raw));
    } catch {
      return safePdfFilename(raw);
    }
  }

  const quoted = /filename\s*=\s*"([^"]+)"/i.exec(header);
  if (quoted) return safePdfFilename(quoted[1]);

  const plain = /filename\s*=\s*([^;]+)/i.exec(header);
  if (plain) return safePdfFilename(plain[1].trim());

  try {
    const base = path.basename(new URL(url).pathname);
    if (base) {
      try {
        return safePdfFilename(decodeURIComponent(base));
      } catch {
        return safePdfFilename(base);
      }
    }
  } catch {
    // 地址无法解析时使用默认文件名。
  }
  return '未命名.pdf';
}

module.exports = {
  safePdfFilename,
  safeDownloadFilename,
  filenameFromDisposition,
};
