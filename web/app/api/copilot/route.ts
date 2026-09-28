import { randomUUID } from 'node:crypto';
import { query } from '@/lib/db';
import { runCopilot, type ChatTurn } from '@/lib/copilot/agent';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let history: ChatTurn[];
  try {
    const body = (await req.json()) as { messages?: ChatTurn[] };
    history = Array.isArray(body.messages) ? body.messages : [];
  } catch {
    return Response.json({ error: 'Invalid request' }, { status: 400 });
  }
  if (!history.some((t) => t.role === 'user' && t.content?.trim())) return Response.json({ error: 'Ask a question first' }, { status: 400 });
  try {
    return Response.json(await runCopilot(query, history, randomUUID()));
  } catch (e) {
    console.error('copilot failed:', (e as Error).message);
    return Response.json({ error: 'The copilot is unavailable right now. The dashboard data is still accurate.' }, { status: 502 });
  }
}
