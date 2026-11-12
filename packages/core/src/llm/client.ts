export interface ChatJsonRequest {
  apiKey: string;
  baseUrl: string;
  model: string;
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  timeoutMs?: number;
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  fetchImpl?: typeof fetch;
}

export async function chatJson(request: ChatJsonRequest): Promise<unknown> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const timeoutMs = request.timeoutMs ?? 12_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${request.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${request.apiKey}`,
        'content-type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: request.model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: request.schemaName, schema: request.schema, strict: true },
        },
        temperature: 0,
        max_tokens: 700,
        reasoning_effort: request.reasoningEffort ?? 'none',
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LLM_${response.status}: ${body.slice(0, 200)}`);
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM_EMPTY');
    return JSON.parse(content);
  } finally {
    clearTimeout(timer);
  }
}
