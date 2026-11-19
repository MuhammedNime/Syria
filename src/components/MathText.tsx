import katex from 'katex';
import React from 'react';

function renderKatexToHtml(latex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(latex.trim(), {
      displayMode,
      throwOnError: false,
      strict: false,
    });
  } catch {
    return latex;
  }
}

export function FormulaBlock({
  expression,
  display = true,
  className = '',
}: {
  expression: string;
  display?: boolean;
  className?: string;
}) {
  const html = renderKatexToHtml(expression, display);
  return (
    <span
      dir="ltr"
      className={`inline-block max-w-full overflow-x-auto align-middle ${display ? 'w-full text-center' : ''} ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * Renders mixed Arabic text + **bold** + inline $...$ and block $$...$$ LaTeX safely in RTL.
 */
export function MathText({
  text,
  className = '',
}: {
  text: string;
  className?: string;
}) {
  if (!text) return null;

  // Split by block math $$...$$ first
  const blocks = text.split(/(\$\$[\s\S]*?\$\$)/g);

  return (
    <div className={`min-w-0 space-y-2 break-words leading-relaxed ${className}`}>
      {blocks.map((block, bIdx) => {
        if (block.startsWith('$$') && block.endsWith('$$')) {
          const expr = block.slice(2, -2);
          return (
            <div
              key={bIdx}
              dir="ltr"
              className="my-2 max-w-full overflow-x-auto rounded-xl bg-slate-50 px-3 py-3 text-center sm:px-4 dark:bg-slate-800/60"
              dangerouslySetInnerHTML={{ __html: renderKatexToHtml(expr, true) }}
            />
          );
        }

        const lines = block.split('\n');
        return (
          <React.Fragment key={bIdx}>
            {lines.map((line, lIdx) => {
              const trimmed = line.trim();
              if (!trimmed) return <div key={lIdx} className="h-1" />;

              // Simple Markdown heading support
              if (trimmed.startsWith('### ')) {
                return (
                  <h4 key={lIdx} className="pt-2 font-display text-base font-bold text-slate-900 dark:text-white">
                    {renderInlineSegments(trimmed.slice(4))}
                  </h4>
                );
              }
              if (trimmed.startsWith('## ')) {
                return (
                  <h3 key={lIdx} className="pt-2 font-display text-lg font-bold text-blue-900 dark:text-blue-200">
                    {renderInlineSegments(trimmed.slice(3))}
                  </h3>
                );
              }

              return (
                <p key={lIdx} className="text-[15px] leading-7">
                  {renderInlineSegments(line)}
                </p>
              );
            })}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function renderInlineSegments(line: string): React.ReactNode[] {
  // Split by inline math $...$
  const parts = line.split(/(\$[^$]+\$)/g);
  return parts.map((part, idx) => {
    if (part.startsWith('$') && part.endsWith('$') && part.length >= 2) {
      const expr = part.slice(1, -1);
      return (
        <span
          key={idx}
          dir="ltr"
          className="mx-1 inline-block align-baseline text-slate-900 dark:text-slate-100"
          dangerouslySetInnerHTML={{ __html: renderKatexToHtml(expr, false) }}
        />
      );
    }

    // Handle **bold**
    const boldParts = part.split(/(\*\*[^*]+\*\*)/g);
    return (
      <React.Fragment key={idx}>
        {boldParts.map((bp, bpIdx) => {
          if (bp.startsWith('**') && bp.endsWith('**')) {
            return (
              <strong key={bpIdx} className="font-semibold text-slate-900 dark:text-white">
                {bp.slice(2, -2)}
              </strong>
            );
          }
          return <React.Fragment key={bpIdx}>{bp}</React.Fragment>;
        })}
      </React.Fragment>
    );
  });
}
