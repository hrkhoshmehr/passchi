/**
 * مسیر OpenRouter — برای اجرای واقعی خط لوله بدون هزینه.
 *
 * مسیر تولید، SDK آنتروپیک است. این ماژول هست تا بشود کل زنجیره را با مدل‌های
 * رایگان یا ارزان از سر تا ته اجرا کرد و به‌جای تخمین، *اندازه‌گیری* داشت:
 * «یک سخنرانی فارسی واقعاً چند توکن است» و «مدل ارزان‌تر برای فارسی کافی است یا نه».
 *
 * یک تفاوت ذاتی هست و پنهان نمی‌شود:
 * • **بدون Batch API** — تخفیف ۵۰٪ اینجا نیست؛ توکن را اندازه بگیر، نه قیمت را.
 *
 * **کشِ پرامپت از ۲۰۲۶-۰۹-۰۱ اینجا هم هست.** پیش‌تر نبود، و این یعنی قیدِ
 * «system و بلوک رونوشت باید بایت‌به‌بایت یکسان بمانند» که کل ساختار
 * `prompts.ts` را شکل داده — و یک بار باگِ «جزوهٔ لاغر» را ساخت — هزینه‌اش
 * پرداخت می‌شد ولی سودش گرفته نمی‌شد. با `cached()` رونوشت در پاس دوم به
 * نرخ خواندنِ کش حساب می‌شود (حدود یک‌دهمِ ورودی معمولی).
 *
 * انتظار زیادی از این صرفه‌جویی نداشته باش: در این کار **خروجی گران‌تر از
 * ورودی است** (جزوهٔ بلند)، پس کش حدود ده تا پانزده درصد از هزینهٔ مدل کم
 * می‌کند، نه بیشتر.
 */

import { config } from "../config.js";
import { logger } from "../util/logger.js";

const BASE_URL = "https://openrouter.ai/api/v1";
const MAX_ATTEMPTS = 4;
const BACKOFF_MS = 3_000;

/**
 * محتوای پیام — یا رشتهٔ ساده، یا بلوک‌هایی که یکی‌شان می‌تواند کش شود.
 *
 * شکل بلوکی فقط وقتی لازم است که بخواهیم `cache_control` بگذاریم؛ برای بقیهٔ
 * فراخوانی‌ها رشتهٔ ساده هم کار می‌کند و خواناتر است.
 */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "text"; text: string; cache_control: { type: "ephemeral" } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentBlock[];
}

/**
 * همان بلوک، با علامتِ «این را کش کن».
 *
 * OpenRouter برای Gemini همان نحو آنتروپیک را می‌پذیرد، ولی `cache_control`
 * باید **داخل بلوک محتوا** بنشیند نه در سطح پیام.
 */
export function cached(text: string): ContentBlock {
  return { type: "text", text, cache_control: { type: "ephemeral" } };
}

export interface ChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  /** هزینهٔ واقعی این فراخوانی به دلار، طبق گزارش خود OpenRouter */
  costUsd: number;
  /** چند توکن از کش خوانده شد — صفر یعنی کش نخورده. */
  cachedTokens: number;
}

interface CompletionResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  model?: string;
  error?: { message?: string; code?: number };
}

export class OpenRouterError extends Error {}

async function post(payload: Record<string, unknown>): Promise<CompletionResponse> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      // OpenRouter برای انتساب این دو را می‌خواهد
      "HTTP-Referer": "https://github.com/local/kharkhoon",
      "X-Title": "Kharkhoon",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15 * 60_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new OpenRouterError(`${res.status}: ${body.slice(0, 300)}`);
    if (res.status !== 408 && res.status !== 409 && res.status !== 429 && res.status < 500) throw err;
    throw Object.assign(err, { retryable: true });
  }
  return (await res.json()) as CompletionResponse;
}

async function callWithRetry(payload: Record<string, unknown>): Promise<CompletionResponse> {
  let last: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const body = await post(payload);
      // مدل‌های رایگان گاهی به‌جای خطای HTTP، بدنهٔ خطا با ۲۰۰ برمی‌گردانند
      if (body.error && !body.choices?.length) {
        last = new OpenRouterError(String(body.error.message ?? body.error).slice(0, 300));
      } else {
        return body;
      }
    } catch (e) {
      last = e;
      if (e instanceof OpenRouterError && !("retryable" in e)) throw e;
    }
    await new Promise((r) => setTimeout(r, BACKOFF_MS * (attempt + 1)));
  }
  throw new OpenRouterError(`پس از ${MAX_ATTEMPTS} تلاش ناموفق: ${String(last).slice(0, 300)}`);
}

/**
 * لایهٔ رایگان شکننده است: یک مدل ممکن است ۴۲۹ بدهد، مدل دیگر ۴۰۴، و اسلاگ‌ها
 * بدون اطلاع قبلی عوض می‌شوند (`deepseek-chat-v3-0324:free` وسط همین کار از
 * رایگان درآمد). پس `model` می‌تواند فهرستی جداشده با کاما باشد و به ترتیب
 * امتحان می‌شود.
 */
export async function chat(
  messages: ChatMessage[],
  opts: { model?: string; maxTokens?: number; jsonSchema?: unknown; schemaName?: string } = {},
): Promise<ChatResult> {
  const candidates = (opts.model ?? config.OPENROUTER_MODEL)
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  if (candidates.length === 0) throw new OpenRouterError("هیچ مدلی مشخص نشده است.");

  let last: unknown;
  for (const model of candidates) {
    const payload: Record<string, unknown> = {
      model,
      messages,
      max_tokens: opts.maxTokens ?? 16_000,
      // بدون این، فیلد usage.cost در پاسخ نمی‌آید
      usage: { include: true },
    };
    if (opts.jsonSchema) {
      payload.response_format = {
        type: "json_schema",
        json_schema: { name: opts.schemaName ?? "result", strict: true, schema: opts.jsonSchema },
      };
    }

    try {
      const body = await callWithRetry(payload);
      const text = body.choices?.[0]?.message?.content ?? "";
      if (!text.trim()) throw new OpenRouterError("مدل پاسخ خالی برگرداند.");

      const result: ChatResult = {
        text,
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
        model: body.model ?? model,
        // OpenRouter هزینهٔ واقعی را در usage.cost برمی‌گرداند. تخمین نزن —
        // مسیریابی به ارائه‌دهنده‌های مختلف قیمت را عوض می‌کند.
        costUsd: Number(body.usage?.cost ?? 0),
        cachedTokens: body.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      };
      logger.debug(
        {
          model: result.model,
          in: result.inputTokens,
          out: result.outputTokens,
          cached: result.cachedTokens,
          usd: result.costUsd,
        },
        "openrouter call",
      );
      return result;
    } catch (e) {
      last = e;
      if (candidates.length > 1) {
        logger.warn({ model, err: String(e).slice(0, 200) }, "openrouter model failed — trying next");
      }
    }
  }
  throw new OpenRouterError(
    `همهٔ مدل‌ها شکست خوردند (${candidates.join("، ")}): ${String(last).slice(0, 300)}`,
  );
}

/**
 * JSON را از پاسخ بیرون می‌کشد.
 *
 * مدل‌های رایگان اغلب `response_format` را نادیده می‌گیرند و خروجی را داخل
 * بلوک کد یا با یک جملهٔ مقدمه می‌فرستند. به‌جای شکست‌خوردن، اولین شیء JSON
 * متوازن را از متن استخراج می‌کنیم.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* ادامه با استخراج */
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const source = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(source);
  } catch {
    /* ادامه با شمارش آکولاد */
  }

  const start = source.indexOf("{");
  if (start < 0) throw new OpenRouterError("خروجی مدل JSON نبود.");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      return JSON.parse(source.slice(start, i + 1));
    }
  }
  throw new OpenRouterError("خروجی مدل JSON کامل نبود.");
}
