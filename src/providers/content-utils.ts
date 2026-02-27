import type { ContentPart } from './LLMProvider';

/**
 * Coerce provider message content to plain text.
 * Preserves text parts when content is multimodal.
 */
export function contentToString(content: string | ContentPart[] | null): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map(part => part.text)
    .join('\n');
}
