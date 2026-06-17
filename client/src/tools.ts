/** Built-in tool agents — pinned at the top of the gallery, each with its own UI. */
export interface PinnedTool {
  slug: string;
  title: string;
  description: string;
  route: string;
  emoji: string;
}

export const PINNED_TOOLS: PinnedTool[] = [
  {
    slug: 'translator',
    title: 'Localizer',
    description:
      'Translate one or many lines into multiple languages at once — with character limits and a glossary that learns from your corrections.',
    route: '/tools/translator',
    emoji: '🌐',
  },
];
