/**
 * FileIcon — Shared file icon component used in sidebar file explorer and editor tabs.
 * Maps file extensions to lucide-react icons with VS Code-style colors.
 */
import {
  File, FileText, FileCode, FileJson, FileType, FileCog,
  Image, Film, Music, Archive, Database, Lock, Terminal,
  Folder, FolderOpen
} from 'lucide-react';

// Extension aliases — map variants to a canonical extension
const EXTENSION_ALIASES = {
  htm: 'html', mjs: 'js', cjs: 'js', mts: 'ts', cts: 'ts',
  tsx: 'jsx', pyw: 'py', pyx: 'py',
  jsonc: 'json', json5: 'json',
  dockerfile: 'docker',
  gitattributes: 'gitignore', gitmodules: 'gitignore',
  mdx: 'md', markdown: 'md', rst: 'txt',
  phtml: 'php', erb: 'rb', rake: 'rb',
  cc: 'cpp', cxx: 'cpp', hpp: 'h', hxx: 'h',
  zsh: 'sh', fish: 'sh', bash: 'sh',
  sqlite: 'sql', sqlite3: 'sql', db: 'sql',
  jpeg: 'jpg', webp: 'png', bmp: 'png', ico: 'png', gif: 'png',
  mkv: 'mp4', avi: 'mp4', mov: 'mp4', wmv: 'mp4', webm: 'mp4', flv: 'mp4',
  wav: 'mp3', flac: 'mp3', aac: 'mp3', ogg: 'mp3', m4a: 'mp3',
  tar: 'gz', bz2: 'gz', '7z': 'zip', rar: 'zip', xz: 'gz',
  ps1: 'bat', cmd: 'bat',
  jar: 'java', class: 'java',
  svelte: 'vue',
};

// Icon + color mapping for resolved extensions
const ICON_MAP = {
  // Code files
  js: { Icon: FileCode, color: 'text-yellow-400' },
  jsx: { Icon: FileCode, color: 'text-blue-400' },
  ts: { Icon: FileCode, color: 'text-blue-500' },
  py: { Icon: FileCode, color: 'text-green-400' },
  rs: { Icon: FileCode, color: 'text-orange-500' },
  go: { Icon: FileCode, color: 'text-cyan-400' },
  java: { Icon: FileCode, color: 'text-red-400' },
  rb: { Icon: FileCode, color: 'text-red-500' },
  php: { Icon: FileCode, color: 'text-purple-400' },
  swift: { Icon: FileCode, color: 'text-orange-300' },
  kt: { Icon: FileCode, color: 'text-purple-500' },
  c: { Icon: FileCode, color: 'text-blue-400' },
  cpp: { Icon: FileCode, color: 'text-blue-500' },
  h: { Icon: FileCode, color: 'text-blue-300' },
  cs: { Icon: FileCode, color: 'text-green-500' },
  dart: { Icon: FileCode, color: 'text-cyan-400' },
  lua: { Icon: FileCode, color: 'text-blue-300' },
  r: { Icon: FileCode, color: 'text-blue-400' },
  scala: { Icon: FileCode, color: 'text-red-400' },
  elixir: { Icon: FileCode, color: 'text-purple-400' },
  ex: { Icon: FileCode, color: 'text-purple-400' },
  exs: { Icon: FileCode, color: 'text-purple-300' },
  erl: { Icon: FileCode, color: 'text-red-300' },
  zig: { Icon: FileCode, color: 'text-yellow-500' },
  nim: { Icon: FileCode, color: 'text-yellow-300' },
  vue: { Icon: FileCode, color: 'text-green-400' },
  // Shell/scripts
  sh: { Icon: Terminal, color: 'text-green-300' },
  bat: { Icon: Terminal, color: 'text-green-300' },
  // Markup
  html: { Icon: FileCode, color: 'text-orange-400' },
  xml: { Icon: FileCode, color: 'text-orange-300' },
  svg: { Icon: FileCode, color: 'text-yellow-400' },
  // Styles
  css: { Icon: FileType, color: 'text-blue-300' },
  scss: { Icon: FileType, color: 'text-pink-400' },
  sass: { Icon: FileType, color: 'text-pink-400' },
  less: { Icon: FileType, color: 'text-blue-300' },
  // Data
  json: { Icon: FileJson, color: 'text-yellow-300' },
  csv: { Icon: FileJson, color: 'text-green-300' },
  tsv: { Icon: FileJson, color: 'text-green-300' },
  sql: { Icon: Database, color: 'text-yellow-200' },
  // Text/docs
  md: { Icon: FileText, color: 'text-blue-200' },
  txt: { Icon: FileText, color: 'text-vsc-text-dim' },
  log: { Icon: FileText, color: 'text-vsc-text-dim' },
  // Config
  yaml: { Icon: FileCog, color: 'text-red-300' },
  yml: { Icon: FileCog, color: 'text-red-300' },
  toml: { Icon: FileCog, color: 'text-gray-400' },
  ini: { Icon: FileCog, color: 'text-gray-400' },
  cfg: { Icon: FileCog, color: 'text-gray-400' },
  env: { Icon: FileCog, color: 'text-yellow-500' },
  gitignore: { Icon: FileCog, color: 'text-gray-500' },
  dockerignore: { Icon: FileCog, color: 'text-gray-500' },
  docker: { Icon: FileCog, color: 'text-blue-400' },
  lock: { Icon: Lock, color: 'text-gray-500' },
  // Media
  png: { Icon: Image, color: 'text-green-300' },
  jpg: { Icon: Image, color: 'text-green-300' },
  mp4: { Icon: Film, color: 'text-purple-300' },
  mp3: { Icon: Music, color: 'text-pink-300' },
  // Archives
  zip: { Icon: Archive, color: 'text-yellow-500' },
  gz: { Icon: Archive, color: 'text-yellow-500' },
};

export default function FileIcon({ extension, name, isDirectory, isOpen, size = 16 }) {
  // Directory icons
  if (isDirectory) {
    return isOpen
      ? <FolderOpen size={size} className="text-yellow-600 flex-shrink-0" />
      : <Folder size={size} className="text-yellow-600 flex-shrink-0" />;
  }

  // Resolve extension from prop or from name
  let ext = (extension || '').toLowerCase();
  if (!ext && name) {
    const parts = name.split('.');
    if (parts.length > 1) ext = parts.pop().toLowerCase();
    // Dotfiles like .gitignore — use the name after the dot
    else if (name.startsWith('.')) ext = name.slice(1).toLowerCase();
  }

  // Special filenames
  const lowerName = (name || '').toLowerCase();
  if (lowerName === 'dockerfile' || lowerName === 'docker-compose.yml' || lowerName === 'docker-compose.yaml') {
    return <FileCog size={size} className="text-blue-400 flex-shrink-0" />;
  }
  if (lowerName === 'makefile' || lowerName === 'cmakelists.txt') {
    return <FileCog size={size} className="text-green-400 flex-shrink-0" />;
  }

  // Apply aliases
  const resolved = EXTENSION_ALIASES[ext] || ext;
  const entry = ICON_MAP[resolved];
  if (entry) {
    const { Icon, color } = entry;
    return <Icon size={size} className={`${color} flex-shrink-0`} />;
  }

  return <File size={size} className="text-vsc-text-dim flex-shrink-0" />;
}
