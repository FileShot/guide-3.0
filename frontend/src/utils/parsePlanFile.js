/**
 * Parse .guide/plans/*.plan.md frontmatter for PlanCard UI.
 */
export function parsePlanFileContent(content) {
  const text = String(content || '');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return {
      title: 'Implementation Plan',
      overview: text.split('\n').find((l) => l.trim() && !l.startsWith('#')) || '',
      todos: [],
      body: text,
    };
  }

  const frontmatter = match[1];
  const body = match[2];
  let title = 'Implementation Plan';
  let overview = '';
  const todos = [];

  const titleMatch = frontmatter.match(/^title:\s*(.+)$/m);
  if (titleMatch) title = titleMatch[1].replace(/^["']|["']$/g, '').trim();

  const overviewMatch = frontmatter.match(/^overview:\s*(.+)$/m);
  if (overviewMatch) overview = overviewMatch[1].replace(/^["']|["']$/g, '').trim();

  const todosBlock = frontmatter.match(/todos:\s*\n([\s\S]*?)(?:\n[a-zA-Z_]+:|$)/);
  if (todosBlock) {
    let current = null;
    for (const line of todosBlock[1].split('\n')) {
      const idMatch = line.match(/^\s*-\s*id:\s*(.+)$/);
      const contentMatch = line.match(/^\s*content:\s*(.+)$/);
      const statusMatch = line.match(/^\s*status:\s*(.+)$/);
      if (idMatch) {
        if (current) todos.push(current);
        current = { id: idMatch[1].trim(), content: '', status: 'pending' };
      } else if (contentMatch && current) {
        current.content = contentMatch[1].replace(/^["']|["']$/g, '').trim();
      } else if (statusMatch && current) {
        current.status = statusMatch[1].trim();
      }
    }
    if (current) todos.push(current);
  }

  if (!overview) {
    const overviewSection = body.match(/##\s*Overview\s*\n([\s\S]*?)(?:\n##|$)/i);
    overview = overviewSection
      ? overviewSection[1].trim().split('\n')[0]
      : body.split('\n').find((l) => l.trim() && !l.startsWith('#')) || '';
  }

  return { title, overview, todos, body };
}
