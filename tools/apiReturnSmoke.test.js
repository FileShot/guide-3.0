'use strict';

const fs = require('fs');
const path = require('path');

const mainPath = path.join(__dirname, '..', 'electron-main.js');
const src = fs.readFileSync(mainPath, 'utf8');

const helperMatch = src.match(/const apiReturn = \(result\) => \{[\s\S]*?\n  \};/);
if (!helperMatch) {
  console.error('apiReturnSmoke.test.js FAIL: apiReturn helper not found');
  process.exit(1);
}

if (/return\s+apiReturn\s*\(/.test(helperMatch[0])) {
  console.error('apiReturnSmoke.test.js FAIL: apiReturn helper must not call itself');
  process.exit(1);
}

if (!/return\s+result\s*;/.test(helperMatch[0])) {
  console.error('apiReturnSmoke.test.js FAIL: apiReturn helper must return result');
  process.exit(1);
}

console.log('apiReturnSmoke.test.js OK');
