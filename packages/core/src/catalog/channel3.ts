export interface Channel3Offer {
  domain: string;
  price: { price: number; compare_at_price?: number; currency: string };
  availability?: string;
  condition?: string;
  url?: string;
}

export interface Channel3Product {
  id: string;
  title: string;
  description?: string;
  materials?: string[];
  key_features?: string[];
  structured_attributes?: Record<string, string[] | string>;
  offers?: Channel3Offer[];
  category?: { slug?: string };
}

export interface Channel3SearchResponse {
  products?: Channel3Product[];
  next_page_token?: string;
}

export interface Channel3Options {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
}

export async function searchChannel3(
  query: string,
  options: Channel3Options,
): Promise<Channel3Product[]> {
  const baseUrl = options.baseUrl ?? 'https://api.trychannel3.com/v1';
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxRetries = options.maxRetries ?? 1;

  let attempt = 0;
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}/search`, {
        method: 'POST',
        headers: { 'x-api-key': options.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ query, limit: 10 }),
        signal: controller.signal,
      });
      if (response.status === 429 && attempt < maxRetries) {
        attempt += 1;
        const retryAfter = Number(response.headers.get('retry-after') ?? '1');
        await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(retryAfter, 1), 10) * 1000));
        continue;
      }
      if (!response.ok) {
        throw new Error(`CHANNEL3_${response.status}`);
      }
      const body = (await response.json()) as Channel3SearchResponse;
      return body.products ?? [];
    } finally {
      clearTimeout(timer);
    }
  }
}
