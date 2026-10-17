// One place to build the Claude client. A key that is not scoped to a workspace has to name one on every
// request: put the id in ANTHROPIC_WORKSPACE_ID (console.anthropic.com → Settings → Workspaces) and it is
// sent as the `anthropic-workspace-id` header.
import Anthropic from '@anthropic-ai/sdk';

export function anthropicClient(apiKey = process.env.ANTHROPIC_API_KEY): Anthropic {
  const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
  const defaultHeaders = workspace ? { 'anthropic-workspace-id': workspace } : undefined;
  return new Anthropic({ apiKey, defaultHeaders });
}

/** Concatenated text blocks of a response. */
export function responseText(res: { content: { type: string; text?: string }[] }): string {
  return res.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}
