const test = require('node:test');
const assert = require('node:assert/strict');
const { safePdfFilename, filenameFromDisposition } = require('./filenames');

test('补上 pdf 后缀并去掉路径', () => {
  assert.equal(safePdfFilename('文件夹/报告'), '报告.pdf');
  assert.equal(safePdfFilename('已有.pdf'), '已有.pdf');
  assert.equal(safePdfFilename('a<b>.pdf'), 'a_b_.pdf');
});

test('从 Content-Disposition 解析文件名', () => {
  assert.equal(
    filenameFromDisposition('attachment; filename="季度报告.pdf"', 'https://example.com/download'),
    '季度报告.pdf',
  );
  assert.equal(
    filenameFromDisposition("inline; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf", 'https://example.com/x'),
    '报告.pdf',
  );
  assert.equal(
    filenameFromDisposition('', 'https://example.com/files/statement.pdf'),
    'statement.pdf',
  );
  assert.equal(
    filenameFromDisposition('', 'https://cdn.example.com/files/%E6%8A%A5%E5%91%8A.pdf'),
    '报告.pdf',
  );
});
