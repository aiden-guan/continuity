// One place to build the Claude client. A key that is not scoped to a workspace has to name one on every
// request: put the id in ANTHROPIC_WORKSPACE_ID (console.anthropic.com → Settings → Workspaces) and it is
// sent as the `anthropic-workspace-id` header.
//
// The SDK default is a 10-minute timeout per attempt with 2 retries (~30 min worst case). Nothing here
// should wait that long, so the client gets a tighter default; call sites set their own per-request
// timeout, and the engine an overall AbortSignal deadline, on top.
import Anthropic from '@anthropic-ai/sdk';

export function anthropicClient(apiKey = process.env.ANTHROPIC_API_KEY): Anthropic {
  const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
  const defaultHeaders = workspace ? { 'anthropic-workspace-id': workspace } : undefined;
  return new Anthropic({ apiKey, defaultHeaders, timeout: 120_000, maxRetries: 1 });
}

/** Concatenated text blocks of a response. */
export function responseText(res: { content: { type: string; text?: string }[] }): string {
  return res.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}
