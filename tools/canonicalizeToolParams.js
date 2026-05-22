'use strict';

/**
 * Single source of truth for tool parameter names (69 tools in mcpToolServer).
 * Used by prose JSON recovery (toolParser) and executeTool (mcpToolServer).
 */

const FILE_PATH_TOOLS = new Set([
  'read_file', 'write_file', 'edit_file', 'append_to_file', 'delete_file',
  'get_file_info', 'open_file_in_editor', 'search_in_file', 'git_diff',
]);

/** Canonical param for path-like regex recovery when JSON parse fails */
const PATH_LIKE_PARAM_BY_TOOL = {
  create_directory: 'path',
  list_directory: 'dirPath',
  replace_in_files: 'path',
};

function getCanonicalPathParamForRecovery(toolName) {
  if (PATH_LIKE_PARAM_BY_TOOL[toolName]) return PATH_LIKE_PARAM_BY_TOOL[toolName];
  if (FILE_PATH_TOOLS.has(toolName)) return 'filePath';
  return null;
}

function applyParserAliases(toolName, params) {
  if (!params || typeof params !== 'object') return params;
  if (params.file_path && !params.filePath) { params.filePath = params.file_path; delete params.file_path; }
  if (params.file && !params.filePath) { params.filePath = params.file; delete params.file; }
  if (params.filename && !params.filePath) { params.filePath = params.filename; delete params.filename; }
  if (params.old_text && !params.oldText) { params.oldText = params.old_text; delete params.old_text; }
  if (params.new_text && !params.newText) { params.newText = params.new_text; delete params.new_text; }
  if (params.old_string && !params.oldText) { params.oldText = params.old_string; delete params.old_string; }
  if (params.new_string && !params.newText) { params.newText = params.new_string; delete params.new_string; }
  if (params.dir_path && !params.dirPath) { params.dirPath = params.dir_path; delete params.dir_path; }
  if (params.directory && !params.dirPath) { params.dirPath = params.directory; delete params.directory; }
  if (params.path && !params.dirPath && !params.filePath && toolName === 'list_directory') {
    params.dirPath = params.path;
    delete params.path;
  }
  if (toolName.startsWith('browser_')) {
    if (params.selector && !params.ref) { params.ref = params.selector; delete params.selector; }
    if (params.value && !params.text && toolName === 'browser_type') { params.text = params.value; delete params.value; }
    if (params.href && !params.url) { params.url = params.href; delete params.href; }
  }
  return params;
}

function normalizeBrowserParams(toolName, params) {
  if (!params || typeof params !== 'object') return params;
  const normalized = { ...params };

  if (toolName === 'browser_click' || toolName === 'browser_type' || toolName === 'browser_hover' || toolName === 'browser_select_option') {
    if (normalized.ref == null && normalized.selector != null) {
      normalized.ref = normalized.selector;
      delete normalized.selector;
    }
    if (normalized.ref == null && normalized.element_ref != null) {
      normalized.ref = normalized.element_ref;
      delete normalized.element_ref;
    }
    if (normalized.ref == null && normalized.elementRef != null) {
      normalized.ref = normalized.elementRef;
      delete normalized.elementRef;
    }
    if (normalized.ref == null && normalized.elementId != null) {
      normalized.ref = normalized.elementId;
      delete normalized.elementId;
    }
    if (normalized.ref == null && normalized.id != null) {
      normalized.ref = normalized.id;
      delete normalized.id;
    }
    if (normalized.ref == null && normalized.input != null) {
      normalized.ref = normalized.input;
      delete normalized.input;
    }
    if (normalized.ref == null && normalized.field != null) {
      normalized.ref = normalized.field;
      delete normalized.field;
    }
    if (normalized.ref == null && normalized.element != null) {
      normalized.ref = normalized.element;
      delete normalized.element;
    }
    if (normalized.ref == null && normalized.index != null) {
      normalized.ref = String(normalized.index);
      delete normalized.index;
    }
    if (normalized.ref == null && normalized.elementIndex != null) {
      normalized.ref = String(normalized.elementIndex);
      delete normalized.elementIndex;
    }
    if (normalized.ref == null && normalized.element_idx != null) {
      normalized.ref = String(normalized.element_idx);
      delete normalized.element_idx;
    }
    if (normalized.ref == null && normalized.elemIndex != null) {
      normalized.ref = String(normalized.elemIndex);
      delete normalized.elemIndex;
    }
    if (normalized.ref == null && normalized.target != null) {
      normalized.ref = String(normalized.target);
      delete normalized.target;
    }
    if (normalized.ref == null && normalized.locator != null) {
      normalized.ref = String(normalized.locator);
      delete normalized.locator;
    }
    if (normalized.ref == null && normalized.num != null) {
      normalized.ref = String(normalized.num);
      delete normalized.num;
    }
    if (toolName === 'browser_click' && normalized.ref == null && typeof normalized.element_text === 'string') {
      normalized.ref = normalized.element_text;
      delete normalized.element_text;
    }
    if (toolName === 'browser_click' && normalized.ref == null && typeof normalized.elementText === 'string') {
      normalized.ref = normalized.elementText;
      delete normalized.elementText;
    }
    if (typeof normalized.ref === 'number') normalized.ref = String(normalized.ref);
    if (typeof normalized.ref === 'string') {
      const r = normalized.ref.trim();
      let m;
      m = r.match(/^\[ref\s*=\s*(\d+)\]$/i);
      if (!m) m = r.match(/^\[ref\s*=\s*["'](\d+)["']\]$/i);
      if (!m) m = r.match(/^\[(\d+)\]$/);
      if (!m) m = r.match(/^ref=(\d+)$/i);
      if (!m) m = r.match(/^element\[(\d+)\]$/i);
      if (!m) m = r.match(/^#ref-(\d+)$/i);
      if (!m) m = r.match(/^#(\d+)$/);
      if (m) normalized.ref = m[1];
    }
  }

  if (toolName === 'browser_type') {
    if (normalized.text == null && normalized.value != null) {
      normalized.text = normalized.value;
      delete normalized.value;
    }
    if (normalized.text == null && normalized.input != null) {
      normalized.text = normalized.input;
      delete normalized.input;
    }
    if (normalized.text == null && normalized.content != null) {
      normalized.text = normalized.content;
      delete normalized.content;
    }
    if (normalized.text == null && normalized.data != null) {
      normalized.text = normalized.data;
      delete normalized.data;
    }
    if (normalized.text == null && normalized.string != null) {
      normalized.text = normalized.string;
      delete normalized.string;
    }
  }

  if (toolName === 'browser_navigate') {
    if (normalized.url == null && typeof normalized.href === 'string') normalized.url = normalized.href;
    if (normalized.url == null && typeof normalized.link === 'string') normalized.url = normalized.link;
    if (normalized.url == null && typeof normalized.ref === 'string' && normalized.ref.includes('.')) normalized.url = normalized.ref;
    if (normalized.url == null && typeof normalized.src === 'string') normalized.url = normalized.src;
    if (normalized.url == null && typeof normalized.page === 'string') normalized.url = normalized.page;
    if (normalized.url == null && typeof normalized.target === 'string') normalized.url = normalized.target;
    if (normalized.url == null && typeof normalized.address === 'string') normalized.url = normalized.address;
    if (normalized.url == null && typeof normalized.site === 'string') normalized.url = normalized.site;
    if (normalized.url == null && typeof normalized.page_url === 'string') normalized.url = normalized.page_url;
    if (normalized.url == null && typeof normalized.location === 'string') normalized.url = normalized.location;
    if (normalized.url == null && typeof normalized.goto === 'string') normalized.url = normalized.goto;
  }

  return normalized;
}

function normalizeFsParams(toolName, params) {
  if (!params || typeof params !== 'object') return params;
  const normalized = { ...params };

  if (FILE_PATH_TOOLS.has(toolName)) {
    if (normalized.filePath == null && typeof normalized.path === 'string') {
      normalized.filePath = normalized.path;
      delete normalized.path;
    }
    if (normalized.filePath == null && typeof normalized.file_path === 'string') {
      normalized.filePath = normalized.file_path;
      delete normalized.file_path;
    }
    if (normalized.filePath == null && typeof normalized.filename === 'string') {
      normalized.filePath = normalized.filename;
      delete normalized.filename;
    }
    if (normalized.filePath == null && typeof normalized.file_name === 'string') {
      normalized.filePath = normalized.file_name;
      delete normalized.file_name;
    }
    if (normalized.filePath == null && typeof normalized.file === 'string') {
      normalized.filePath = normalized.file;
      delete normalized.file;
    }
    if (normalized.filePath == null && typeof normalized.key === 'string') {
      normalized.filePath = normalized.key;
      delete normalized.key;
      delete normalized.value;
    }
  }

  if (toolName === 'list_directory') {
    if (normalized.dirPath == null) {
      if (typeof normalized.filePath === 'string') {
        normalized.dirPath = normalized.filePath;
        delete normalized.filePath;
      } else if (typeof normalized.path === 'string') {
        normalized.dirPath = normalized.path;
        delete normalized.path;
      } else if (typeof normalized.dir === 'string') {
        normalized.dirPath = normalized.dir;
        delete normalized.dir;
      } else if (typeof normalized.directory === 'string') {
        normalized.dirPath = normalized.directory;
        delete normalized.directory;
      } else if (typeof normalized.key === 'string') {
        normalized.dirPath = normalized.key;
        delete normalized.key;
        delete normalized.value;
      }
    }
  }

  if (toolName === 'create_directory') {
    if (normalized.path == null && typeof normalized.dirPath === 'string') {
      normalized.path = normalized.dirPath;
      delete normalized.dirPath;
    }
    if (normalized.path == null && typeof normalized.filePath === 'string') {
      normalized.path = normalized.filePath;
      delete normalized.filePath;
    }
  }

  if (toolName === 'find_files') {
    if (normalized.pattern == null && typeof normalized.query === 'string') {
      normalized.pattern = normalized.query;
      delete normalized.query;
    }
  }

  if (toolName === 'rename_file') {
    if (normalized.oldPath == null) {
      if (typeof normalized.sourcePath === 'string') {
        normalized.oldPath = normalized.sourcePath;
        delete normalized.sourcePath;
      } else if (typeof normalized.src === 'string') {
        normalized.oldPath = normalized.src;
        delete normalized.src;
      } else if (typeof normalized.source === 'string') {
        normalized.oldPath = normalized.source;
        delete normalized.source;
      } else if (typeof normalized.from === 'string') {
        normalized.oldPath = normalized.from;
        delete normalized.from;
      }
    }
    if (normalized.newPath == null) {
      if (typeof normalized.destinationPath === 'string') {
        normalized.newPath = normalized.destinationPath;
        delete normalized.destinationPath;
      } else if (typeof normalized.dst === 'string') {
        normalized.newPath = normalized.dst;
        delete normalized.dst;
      } else if (typeof normalized.destination === 'string') {
        normalized.newPath = normalized.destination;
        delete normalized.destination;
      } else if (typeof normalized.to === 'string') {
        normalized.newPath = normalized.to;
        delete normalized.to;
      }
    }
  }

  if (toolName === 'copy_file') {
    if (normalized.source == null) {
      if (typeof normalized.sourcePath === 'string') {
        normalized.source = normalized.sourcePath;
        delete normalized.sourcePath;
      } else if (typeof normalized.src === 'string') {
        normalized.source = normalized.src;
        delete normalized.src;
      } else if (typeof normalized.from === 'string') {
        normalized.source = normalized.from;
        delete normalized.from;
      } else if (typeof normalized.origin === 'string') {
        normalized.source = normalized.origin;
        delete normalized.origin;
      }
    }
    if (normalized.destination == null) {
      if (typeof normalized.destinationPath === 'string') {
        normalized.destination = normalized.destinationPath;
        delete normalized.destinationPath;
      } else if (typeof normalized.dst === 'string') {
        normalized.destination = normalized.dst;
        delete normalized.dst;
      } else if (typeof normalized.to === 'string') {
        normalized.destination = normalized.to;
        delete normalized.to;
      } else if (typeof normalized.target === 'string') {
        normalized.destination = normalized.target;
        delete normalized.target;
      }
    }
  }

  if (toolName === 'diff_files') {
    if (normalized.fileA == null) {
      if (typeof normalized.file1 === 'string') {
        normalized.fileA = normalized.file1;
        delete normalized.file1;
      } else if (typeof normalized.pathA === 'string') {
        normalized.fileA = normalized.pathA;
        delete normalized.pathA;
      } else if (typeof normalized.first === 'string') {
        normalized.fileA = normalized.first;
        delete normalized.first;
      } else if (typeof normalized.source === 'string') {
        normalized.fileA = normalized.source;
        delete normalized.source;
      }
    }
    if (normalized.fileB == null) {
      if (typeof normalized.file2 === 'string') {
        normalized.fileB = normalized.file2;
        delete normalized.file2;
      } else if (typeof normalized.pathB === 'string') {
        normalized.fileB = normalized.pathB;
        delete normalized.pathB;
      } else if (typeof normalized.second === 'string') {
        normalized.fileB = normalized.second;
        delete normalized.second;
      } else if (typeof normalized.destination === 'string') {
        normalized.fileB = normalized.destination;
        delete normalized.destination;
      }
    }
  }

  if (toolName === 'replace_in_files') {
    if (normalized.searchText == null) {
      if (typeof normalized.find === 'string') {
        normalized.searchText = normalized.find;
        delete normalized.find;
      } else if (typeof normalized.query === 'string') {
        normalized.searchText = normalized.query;
        delete normalized.query;
      } else if (typeof normalized.search === 'string') {
        normalized.searchText = normalized.search;
        delete normalized.search;
      } else if (typeof normalized.pattern === 'string') {
        normalized.searchText = normalized.pattern;
        delete normalized.pattern;
      }
    }
    if (normalized.replaceText == null) {
      if (typeof normalized.replace === 'string') {
        normalized.replaceText = normalized.replace;
        delete normalized.replace;
      } else if (typeof normalized.replacement === 'string') {
        normalized.replaceText = normalized.replacement;
        delete normalized.replacement;
      }
    }
    if (normalized.path == null && typeof normalized.dirPath === 'string') {
      normalized.path = normalized.dirPath;
      delete normalized.dirPath;
    }
    if (normalized.path == null && typeof normalized.filePath === 'string') {
      normalized.path = normalized.filePath;
      delete normalized.filePath;
    }
  }

  if (toolName === 'write_scratchpad' || toolName === 'read_scratchpad') {
    if (normalized.name == null && typeof normalized.key === 'string') {
      normalized.name = normalized.key;
      delete normalized.key;
    }
  }

  if (toolName === 'edit_file') {
    if (normalized.oldText == null && typeof normalized.old_string === 'string') {
      normalized.oldText = normalized.old_string;
      delete normalized.old_string;
    }
    if (normalized.newText == null && typeof normalized.new_string === 'string') {
      normalized.newText = normalized.new_string;
      delete normalized.new_string;
    }
  }

  if (toolName === 'grep_search') {
    if (normalized.pattern == null) {
      if (typeof normalized.query === 'string') {
        normalized.pattern = normalized.query;
        delete normalized.query;
      } else if (typeof normalized.search === 'string') {
        normalized.pattern = normalized.search;
        delete normalized.search;
      } else if (typeof normalized.regex === 'string') {
        normalized.pattern = normalized.regex;
        delete normalized.regex;
      }
    }
    if (normalized.filePattern == null) {
      if (typeof normalized.glob === 'string') {
        normalized.filePattern = normalized.glob;
        delete normalized.glob;
      } else if (typeof normalized.filter === 'string') {
        normalized.filePattern = normalized.filter;
        delete normalized.filter;
      } else if (typeof normalized.include === 'string') {
        normalized.filePattern = normalized.include;
        delete normalized.include;
      }
    }
  }

  if (toolName === 'search_in_file') {
    if (normalized.filePath == null) {
      if (typeof normalized.path === 'string') {
        normalized.filePath = normalized.path;
        delete normalized.path;
      } else if (typeof normalized.file === 'string') {
        normalized.filePath = normalized.file;
        delete normalized.file;
      } else if (typeof normalized.file_path === 'string') {
        normalized.filePath = normalized.file_path;
        delete normalized.file_path;
      }
    }
    if (normalized.pattern == null) {
      if (typeof normalized.query === 'string') {
        normalized.pattern = normalized.query;
        delete normalized.query;
      } else if (typeof normalized.search === 'string') {
        normalized.pattern = normalized.search;
        delete normalized.search;
      } else if (typeof normalized.regex === 'string') {
        normalized.pattern = normalized.regex;
        delete normalized.regex;
      }
    }
  }

  return normalized;
}

/**
 * Canonicalize tool params for prose JSON and native functionCalls before executeTool.
 */
function canonicalizeToolParams(toolName, params) {
  if (!params || typeof params !== 'object') return params || {};
  let p = applyParserAliases(toolName, { ...params });
  if (toolName && toolName.startsWith('browser_')) {
    p = normalizeBrowserParams(toolName, p);
  } else {
    p = normalizeFsParams(toolName, p);
  }
  return p;
}

module.exports = {
  canonicalizeToolParams,
  getCanonicalPathParamForRecovery,
  FILE_PATH_TOOLS,
  PATH_LIKE_PARAM_BY_TOOL,
};
