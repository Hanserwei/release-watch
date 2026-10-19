import { z } from 'zod';

const entityBase = z.object({ offset: z.number().int().nonnegative(), length: z.number().int().positive() });
export const telegramEntitiesSchema = z.array(z.discriminatedUnion('type', [
  entityBase.extend({ type: z.enum(['bold', 'italic', 'strikethrough', 'code', 'blockquote']) }),
  entityBase.extend({ type: z.literal('pre'), language: z.string().optional() }),
  entityBase.extend({ type: z.literal('text_link'), url: z.url().refine(value => /^https?:\/\//i.test(value)) }),
]));
export type TelegramEntity = z.infer<typeof telegramEntitiesSchema>[number];
export interface TelegramText { text: string; entities: TelegramEntity[]; }
type EntityStyle = { type: 'bold' | 'italic' | 'strikethrough' | 'code' | 'blockquote' }
  | { type: 'pre'; language?: string } | { type: 'text_link'; url: string };

/** Offsets always refer to visible UTF-16 text, never Markdown source or escaped bytes. */
export class TelegramTextBuilder {
  text = '';
  entities: TelegramEntity[] = [];

  append(value: string | TelegramText, style?: EntityStyle): this {
    const item = typeof value === 'string' ? { text: value, entities: [] } : value;
    const start = this.text.length;
    this.text += item.text;
    const children = style?.type === 'blockquote' ? item.entities.filter(entity => entity.type !== 'blockquote') : item.entities;
    this.entities.push(...children.map(entity => ({ ...entity, offset: entity.offset + start })));
    if (style && item.text.length) {
      // Telegram forbids code/pre nesting with inline styles. Leave those spans independent.
      const isolated = style.type === 'blockquote' ? [] : children.filter(entity => entity.type === 'code' || entity.type === 'pre')
        .sort((a, b) => a.offset - b.offset);
      let from = 0;
      for (const entity of isolated) {
        if (entity.offset > from) this.entities.push({ ...style, offset: start + from, length: entity.offset - from });
        from = Math.max(from, entity.offset + entity.length);
      }
      if (from < item.text.length) this.entities.push({ ...style, offset: start + from, length: item.text.length - from });
    }
    return this;
  }

  build(): TelegramText {
    return { text: this.text, entities: [...this.entities].sort((a, b) => a.offset - b.offset || b.length - a.length) };
  }
}

export function safeTelegramLink(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

/** Clip and reopen styles on each part; never split an emoji's UTF-16 surrogate pair. */
export function sliceTelegramText(value: string | TelegramText, start: number, limit: number): TelegramText {
  const doc = typeof value === 'string' ? { text: value, entities: [] } : value;
  let end = Math.min(doc.text.length, start + limit);
  if (end < doc.text.length && /[\uD800-\uDBFF]/.test(doc.text[end - 1] ?? '')) end--;
  const entities: TelegramEntity[] = [];
  for (const entity of doc.entities) {
    const from = Math.max(start, entity.offset);
    const to = Math.min(end, entity.offset + entity.length);
    if (to > from) entities.push({ ...entity, offset: from - start, length: to - from });
  }
  // Very dense source Markdown must not prevent delivery; preserve all text if styles exceed the cap.
  return { text: doc.text.slice(start, end), entities: entities.slice(0, 90) };
}
