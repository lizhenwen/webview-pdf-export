const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyDownload } = require('./classify');

test('按类型、文件名和地址识别 PDF', () => {
  assert.equal(classifyDownload({
    filename: 'download',
    mime: 'application/pdf',
    url: 'https://example.com/get',
  }), 'pdf');
  assert.equal(classifyDownload({
    filename: '报告.pdf',
    mime: 'application/octet-stream',
    url: 'https://example.com/get',
  }), 'pdf');
  assert.equal(classifyDownload({
    filename: 'download',
    mime: 'application/octet-stream',
    url: 'https://example.com/a/file.PDF?token=1',
  }), 'pdf');
});

test('明确的非 PDF 不拦截', () => {
  assert.equal(classifyDownload({
    filename: 'photo.png',
    mime: 'image/png',
    url: 'https://example.com/photo.png',
  }), 'other');
  assert.equal(classifyDownload({
    filename: 'table.xlsx',
    mime: 'application/octet-stream',
    url: 'https://example.com/export',
  }), 'other');
});

test('无法判断时留给内容嗅探', () => {
  assert.equal(classifyDownload({
    filename: 'download',
    mime: 'application/octet-stream',
    url: 'https://example.com/export',
  }), 'unknown');
});
