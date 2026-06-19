/**
 * guIDE — Centralized Logger
 * 
 * Leveled logging (debug/info/warn/error) with persistent file output.
 * All info+ entries written to rotating log file at:
 *   %APPDATA%/guide-ide/logs/guide-main.log (10MB max, 1 backup)
 *
 * Usage:
 *   const log = require('./main/logger');
 *   log.info('IDE', 'Service initialized');
 *   log.error('LLM', 'Failed to load', err.message);
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let level = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.debug;
let consoleInterceptsInstalled = false;

// Log file path — derived from app name in package.json
const LOG_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), '.config'),
  'guide-ide', 'logs'
);
const LOG_FILE = path.join(LOG_DIR, 'guide-main.log');
const MAX_SIZE = 10 * 1024 * 1024;

let stream = null;
let bytesWritten = 0;
let startupPathLogged = false;

function reportInternalLoggerError(context, err) {
  try {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[Logger:${context}] ${msg}\n`);
  } catch (_) {}
}

function ensureDir() {
  try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); }
  catch (err) { reportInternalLoggerError('ensureDir', err); }
}

function getStream() {
  if (stream) return stream;
  try {
    ensureDir();
    try { bytesWritten = fs.statSync(LOG_FILE).size; } catch (_) { bytesWritten = 0; }
    stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    stream.on('error', (err) => {
      reportInternalLoggerError('stream', err);
      stream = null;
    });
    if (!startupPathLogged) {
      startupPathLogged = true;
      try {
        stream.write(`${new Date().toISOString()} INFO  [Logger] Log file path: ${LOG_FILE}\n`);
      } catch (err) {
        reportInternalLoggerError('startup-write', err);
      }
    }
    return stream;
  } catch (err) {
    reportInternalLoggerError('getStream', err);
    return null;
  }
}

function rotate() {
  if (bytesWritten < MAX_SIZE) return;
  try {
    if (stream) { stream.end(); stream = null; }
    const backup = LOG_FILE + '.1';
    try { fs.unlinkSync(backup); } catch (_) {}
    fs.renameSync(LOG_FILE, backup);
    bytesWritten = 0;
  } catch (err) {
    reportInternalLoggerError('rotate', err);
  }
}

function writeLine(line) {
  rotate();
  const s = getStream();
  if (s) {
    try {
      s.write(line + '\n');
      bytesWritten += line.length + 1;
      return;
    } catch (err) {
      reportInternalLoggerError('writeLine', err);
    }
  }
  try { process.stderr.write(line + '\n'); } catch (_) {}
}

function fmtConsole(tag, args) {
  const ts = new Date().toISOString().substring(11, 23);
  return [`${ts} [${tag}]`, ...args];
}

function fmtFile(lvl, tag, args) {
  const ts = new Date().toISOString();
  const parts = args.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch (_) { return String(a); } }
    return String(a);
  });
  return `${ts} ${lvl.toUpperCase().padEnd(5)} [${tag}] ${parts.join(' ')}`;
}

const logger = {
  setLevel(l) { level = LEVELS[l] ?? LEVELS.info; },
  getLevel() { return Object.keys(LEVELS).find(k => LEVELS[k] === level) || 'info'; },
  getLogPath() { return LOG_FILE; },

  debug(tag, ...args) {
    if (level <= LEVELS.debug) {
      console.log(...fmtConsole(tag, args));
      writeLine(fmtFile('debug', tag, args));
    }
  },
  info(tag, ...args) {
    if (level <= LEVELS.info) console.log(...fmtConsole(tag, args));
    writeLine(fmtFile('info', tag, args));
  },
  warn(tag, ...args) {
    if (level <= LEVELS.warn) console.warn(...fmtConsole(tag, args));
    writeLine(fmtFile('warn', tag, args));
  },
  error(tag, ...args) {
    if (level <= LEVELS.error) console.error(...fmtConsole(tag, args));
    writeLine(fmtFile('error', tag, args));
  },

  close() { if (stream) { stream.end(); stream = null; } },

  clearAll() {
    if (stream) {
      try { stream.end(); } catch (_) {}
      stream = null;
    }
    bytesWritten = 0;
    ensureDir();
    for (const f of [LOG_FILE, `${LOG_FILE}.1`]) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
    let version = '2.0.0';
    try { version = require('./package.json').version || version; } catch (_) {}
    writeLine(`\n${'='.repeat(80)}\n${new Date().toISOString()} SESSION START — guIDE v${version} (logs cleared)\n${'='.repeat(80)}`);
  },

  /**
   * Intercept all console.log/warn/error so every module's output goes to
   * the persistent log file. Call once at startup from electron-main.js.
   */
  installConsoleIntercepts() {
    if (consoleInterceptsInstalled) return;
    consoleInterceptsInstalled = true;
    const origLog = console.log.bind(console);
    const origWarn = console.warn.bind(console);
    const origError = console.error.bind(console);

    const stringify = (a) => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'object') { try { return JSON.stringify(a); } catch (_) { return String(a); } }
      return String(a);
    };

    console.log = (...args) => {
      origLog(...args);
      writeLine(`${new Date().toISOString()} LOG   ${args.map(stringify).join(' ')}`);
    };
    console.warn = (...args) => {
      origWarn(...args);
      writeLine(`${new Date().toISOString()} WARN  ${args.map(stringify).join(' ')}`);
    };
    console.error = (...args) => {
      origError(...args);
      writeLine(`${new Date().toISOString()} ERROR ${args.map(stringify).join(' ')}`);
    };

    process.on('uncaughtException', (err) => {
      writeLine(`${new Date().toISOString()} FATAL [UncaughtException] ${err.stack || err.message || err}`);
    });
    process.on('unhandledRejection', (reason) => {
      const msg = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
      writeLine(`${new Date().toISOString()} ERROR [UnhandledRejection] ${msg}`);
    });
  },

  uninstallConsoleIntercepts() {
    consoleInterceptsInstalled = false;
  },
};

// Session start marker — load version from package.json with safe fallback
let _guideVersion = '2.0.0';
try { _guideVersion = require('./package.json').version || _guideVersion; } catch (_) {}
writeLine(`\n${'='.repeat(80)}\n${new Date().toISOString()} SESSION START — guIDE v${_guideVersion}\n${'='.repeat(80)}`);

module.exports = logger;
