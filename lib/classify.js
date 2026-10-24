const path = require('path');

const NON_PDF_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
  '.zip', '.rar', '.7z', '.gz', '.tar',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.txt', '.csv', '.mp3', '.mp4', '.mov', '.avi', '.wav',
  '.html', '.htm', '.css', '.js', '.json', '.xml',
  '.dmg', '.pkg', '.exe', '.apk',
]);

function pathnameOf(url) {
  try {
    return decodeURIComponent(new URL(url).pathname).toLowerCase();
  } catch {
    return '';
  }
}

function classifyDownload({ filename = '', mime = '', url = '' } = {}) {
  const mimeLower = String(mime).toLowerCase();
  const nameLower = String(filename).toLowerCase();
  const pathname = pathnameOf(url);

  if (mimeLower.includes('pdf') || nameLower.endsWith('.pdf') || pathname.endsWith('.pdf')) {
    return 'pdf';
  }

  const ext = path.extname(nameLower.split('?')[0]);
  if (NON_PDF_EXT.has(ext)) return 'other';

  if (
    mimeLower.startsWith('image/')
    || mimeLower.startsWith('video/')
    || mimeLower.startsWith('audio/')
    || mimeLower.startsWith('text/')
    || mimeLower.includes('application/zip')
    || mimeLower.includes('application/json')
    || mimeLower.includes('application/javascript')
    || mimeLower.includes('application/vnd.')
    || mimeLower.includes('application/msword')
  ) {
    return 'other';
  }

  return 'unknown';
}

module.exports = { classifyDownload };
