#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const url = require('url');
const readline = require('readline');

const APP_DEST = process.env.TRIM_APPDEST || path.resolve(__dirname, '..');
const WWW_ROOT = path.join(APP_DEST, 'www');
const PORT = Number(process.env.TRIM_SERVICE_PORT || process.env.PORT || 8080);

const TARGET_DIR = '/usr/trim/www';
const INDEX_FILE = path.join(TARGET_DIR, 'index.html');
const BACKUP_DIR = '/usr/cqshbak';
const BACKUP_FILE = path.join(BACKUP_DIR, 'index.html.original');
const LOG_FILE = process.env.TRIM_PKGVAR ? path.join(process.env.TRIM_PKGVAR, 'info.log') : null;

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  if (LOG_FILE) {
    try {
      fs.appendFileSync(LOG_FILE, line, 'utf8');
    } catch (err) {
      // fallback to stderr
      process.stderr.write(line);
    }
  } else {
    process.stderr.write(line);
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
    case '.htm':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.txt':
      return 'text/plain; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

async function ensureBackup() {
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
  try {
    await fsp.access(BACKUP_FILE, fs.constants.F_OK);
    return { created: false };
  } catch (_) {
    try {
      await fsp.access(INDEX_FILE, fs.constants.F_OK);
    } catch (err) {
      throw new Error(`未找到系统文件: ${INDEX_FILE}`);
    }
    await fsp.copyFile(INDEX_FILE, BACKUP_FILE);
    return { created: true };
  }
}

async function restoreOriginal() {
  try {
    await fsp.access(BACKUP_FILE, fs.constants.F_OK);
  } catch (err) {
    throw new Error('未找到备份文件');
  }
  await fsp.copyFile(BACKUP_FILE, INDEX_FILE);
  await fsp.chmod(INDEX_FILE, 0o644);
}

async function readTextFromPath(filePath) {
  const stats = await fsp.stat(filePath);
  if (!stats.isFile()) {
    throw new Error(`路径不是文件: ${filePath}`);
  }
  return fsp.readFile(filePath, 'utf8');
}

async function injectBlock(inputPath, marker, blockLines) {
  const tempFile = path.join(os.tmpdir(), `fnos-ui-mods-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  const reader = readline.createInterface({
    input: fs.createReadStream(inputPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  const writer = fs.createWriteStream(tempFile, { encoding: 'utf8' });

  let inserted = false;

  for await (const line of reader) {
    if (!inserted && line.includes(marker)) {
      const idx = line.indexOf(marker);
      const before = line.slice(0, idx);
      const after = line.slice(idx);

      if (before.length > 0) {
        writer.write(before + '\n');
      }
      writer.write(blockLines.join('\n') + '\n');
      writer.write(after + '\n');

      inserted = true;
      continue;
    }

    writer.write(line + '\n');
  }

  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
    reader.on('error', reject);
    writer.end();
  });

  if (!inserted) {
    await fsp.unlink(tempFile).catch(() => {});
    throw new Error(`未找到插入位置: ${marker}`);
  }

  await fsp.copyFile(tempFile, inputPath);
  await fsp.unlink(tempFile).catch(() => {});
}

async function injectCode({ cssText, jsText, cssPath, jsPath }) {
  await ensureBackup();
  await fsp.copyFile(BACKUP_FILE, INDEX_FILE);

  let finalCss = null;
  let finalJs = null;

  if (cssPath) {
    finalCss = await readTextFromPath(cssPath);
  } else if (cssText) {
    finalCss = cssText;
  }

  if (jsPath) {
    finalJs = await readTextFromPath(jsPath);
  } else if (jsText) {
    finalJs = jsText;
  }

  if (!finalCss && !finalJs) {
    return { injected: false, message: '未提供任何 CSS/JS 内容' };
  }

  if (finalCss) {
    await injectBlock(INDEX_FILE, '</head>', [
      '<style>',
      '/* Injected CSS */',
      finalCss,
      '</style>',
    ]);
  }

  if (finalJs) {
    await injectBlock(INDEX_FILE, '</body>', [
      '<script>',
      '// Injected JS',
      finalJs,
      '</script>',
    ]);
  }

  await fsp.chmod(INDEX_FILE, 0o644);
  return { injected: true, message: '注入成功，请强制刷新浏览器 (Ctrl+F5) 查看效果。' };
}

async function getStatus() {
  const result = {
    indexPath: INDEX_FILE,
    backupPath: BACKUP_FILE,
    indexExists: false,
    backupExists: false,
    indexMtime: null,
    backupMtime: null,
  };

  try {
    const stat = await fsp.stat(INDEX_FILE);
    result.indexExists = true;
    result.indexMtime = stat.mtime.toISOString();
  } catch (_) {}

  try {
    const stat = await fsp.stat(BACKUP_FILE);
    result.backupExists = true;
    result.backupMtime = stat.mtime.toISOString();
  } catch (_) {}

  return result;
}

async function readJsonBody(req, limitBytes = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

function safeJoin(root, requestPath) {
  const cleanPath = decodeURIComponent(requestPath.split('?')[0]);
  const safePath = cleanPath.replace(/\0/g, '');
  const resolvedPath = path.normalize(path.join(root, safePath));
  if (!resolvedPath.startsWith(root)) {
    return null;
  }
  return resolvedPath;
}

async function handleStatic(req, res, pathname) {
  let filePath = safeJoin(WWW_ROOT, pathname);
  if (!filePath) {
    return sendText(res, 400, 'Bad Request');
  }

  if (pathname === '/' || pathname === '') {
    filePath = path.join(WWW_ROOT, 'index.html');
  }

  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
  } catch (err) {
    return sendText(res, 404, 'Not Found');
  }

  try {
    const data = await fsp.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': mimeFor(filePath),
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch (err) {
    return sendText(res, 500, 'Internal Server Error');
  }
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url || '/', true);
  const pathname = parsedUrl.pathname || '/';

  if (pathname.startsWith('/api/')) {
    try {
      if (req.method === 'GET' && pathname === '/api/status') {
        const status = await getStatus();
        return sendJson(res, 200, { ok: true, data: status });
      }

      if (req.method === 'POST' && pathname === '/api/restore') {
        await restoreOriginal();
        return sendJson(res, 200, { ok: true, message: '已还原至官方默认状态' });
      }

      if (req.method === 'POST' && pathname === '/api/inject') {
        const body = await readJsonBody(req);
        const cssText = typeof body.cssText === 'string' ? body.cssText.trim() : '';
        const jsText = typeof body.jsText === 'string' ? body.jsText.trim() : '';
        const cssPath = typeof body.cssPath === 'string' ? body.cssPath.trim() : '';
        const jsPath = typeof body.jsPath === 'string' ? body.jsPath.trim() : '';

        const result = await injectCode({
          cssText: cssText || null,
          jsText: jsText || null,
          cssPath: cssPath || null,
          jsPath: jsPath || null,
        });

        if (!result.injected) {
          return sendJson(res, 400, { ok: false, message: result.message });
        }

        return sendJson(res, 200, { ok: true, message: result.message });
      }

      return sendJson(res, 404, { ok: false, message: 'Not Found' });
    } catch (err) {
      log(`API error: ${err.message}`);
      return sendJson(res, 500, { ok: false, message: err.message });
    }
  }

  if (req.method !== 'GET') {
    return sendText(res, 405, 'Method Not Allowed');
  }

  return handleStatic(req, res, pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  log(`FnOS UI Mods server listening on ${PORT}`);
});
