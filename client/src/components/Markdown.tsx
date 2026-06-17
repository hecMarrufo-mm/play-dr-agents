import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

/**
 * Renders assistant replies as Markdown.
 *
 * Safe by default: react-markdown does NOT render raw HTML (no rehype-raw), so
 * even though this thread is shared and rendered for other users, model output
 * cannot inject markup/scripts. GFM adds tables/strikethrough/task-lists;
 * remark-breaks keeps single newlines as line breaks for a chat-like feel.
 */
export function Markdown({ content }: { content: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
