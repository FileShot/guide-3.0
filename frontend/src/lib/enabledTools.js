/**
 * Settings tool toggles — shared by Sidebar UI and cloud chat params.
 */

export const DEFAULT_ENABLED_TOOLS = new Set([
  'read_file', 'write_file', 'edit_file', 'append_to_file', 'create_file',
  'delete_file', 'rename_file', 'list_directory', 'find_files',
  'get_project_structure', 'get_file_info', 'open_file_in_editor', 'diff_files',
  'copy_file', 'create_directory',
  'grep_search', 'search_in_file', 'search_codebase', 'replace_in_files',
  'run_command', 'check_port', 'install_packages',
  'web_search', 'fetch_webpage', 'http_request',
  'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type',
  'browser_fill_form', 'browser_evaluate', 'browser_scroll', 'browser_back',
  'browser_screenshot', 'browser_get_content', 'browser_select_option',
  'browser_wait', 'browser_wait_for', 'browser_press_key', 'browser_hover',
  'browser_drag', 'browser_tabs', 'browser_handle_dialog', 'browser_console_messages',
  'browser_file_upload', 'browser_resize', 'browser_get_url', 'browser_get_links',
  'browser_close',
  'git_status', 'git_commit', 'git_diff', 'git_log', 'git_branch',
  'analyze_error',
  'undo_edit', 'list_undoable',
  'save_memory', 'get_memory', 'list_memories',
  'write_todos', 'update_todo',
  'ask_question',
  'write_scratchpad', 'read_scratchpad',
  'save_rule', 'list_rules',
]);

/** Every toggleable tool name known to the Settings UI + defaults. */
export const ALL_TOOL_NAMES = [
  ...DEFAULT_ENABLED_TOOLS,
  'git_stash', 'git_reset', 'generate_image',
];

export function isToolEnabled(name, enabledTools) {
  if (enabledTools && Object.prototype.hasOwnProperty.call(enabledTools, name)) {
    return !!enabledTools[name];
  }
  return DEFAULT_ENABLED_TOOLS.has(name);
}

export function resolveEnabledToolMap(enabledTools) {
  const map = {};
  for (const name of ALL_TOOL_NAMES) {
    map[name] = isToolEnabled(name, enabledTools);
  }
  return map;
}
