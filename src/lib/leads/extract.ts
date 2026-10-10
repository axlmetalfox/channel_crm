import { AiError, type AiConfig, type AiUsage, type ChatMessage } from '@/lib/ai/types'
import { aiRequestTimeoutMs } from '@/lib/ai/defaults'
import { generateOpenAiJson } from '@/lib/ai/providers/openai'
import {
  LEAD_EXTRACTION_PROMPT,
  LEAD_EXTRACTION_SCHEMA,
  parseLead,
  type Lead,
} from './schema'

export interface ExtractLeadResult {
  lead: Lead
  usage: AiUsage | null
}

/**
 * Ask the account's model to pull the lead out of an interview
 * transcript. Needs a provider that supports strict JSON-schema output;
 * today that is the OpenAI-compatible one (which includes gateways such
 * as the Hostinger AI router). Throws `AiError` when the call fails or
 * the answer is not a usable lead.
 */
export async function extractLead(
  config: AiConfig,
  transcript: ChatMessage[],
): Promise<ExtractLeadResult> {
  if (config.provider !== 'openai') {
    throw new AiError('Lead capture needs the OpenAI-compatible provider.', {
      code: 'unsupported_provider',
      status: 400,
    })
  }

  // One user turn holding the whole conversation, so the model reads it
  // as material to analyse rather than a chat to continue.
  const text = transcript
    .map((m) => `${m.role === 'user' ? 'CUSTOMER' : 'ASSISTANT'}: ${m.content}`)
    .join('\n')

  const result = await generateOpenAiJson({
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt: LEAD_EXTRACTION_PROMPT,
    messages: [{ role: 'user', content: text }],
    timeoutMs: aiRequestTimeoutMs(),
    schemaName: 'lead',
    schema: LEAD_EXTRACTION_SCHEMA,
  })

  let json: unknown
  try {
    json = JSON.parse(result.text)
  } catch {
    throw new AiError('The model did not return valid JSON for the lead.', {
      code: 'invalid_lead_json',
    })
  }
  const lead = parseLead(json)
  if (!lead) {
    throw new AiError('The model returned a lead without a usable request.', {
      code: 'invalid_lead',
    })
  }
  return { lead, usage: result.usage }
}
