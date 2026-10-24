const fs = require('fs');

const PDF_MAGIC = Buffer.from('%PDF-');

async function fileIsPdf(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(PDF_MAGIC);
  } finally {
    await handle.close();
  }
}

module.exports = { fileIsPdf };
