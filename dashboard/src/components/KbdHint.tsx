import React from 'react';

export type CSSLength = `${number}px` | `${number}rem` | `${number}%`;

interface KbdHintProps {
  icon: '↵' | string;
  text: string;
  top: CSSLength;
  right: CSSLength;
  transform?: string;
}

/**
 * A reusable component to render keyboard hints (e.g. "↵ Enter").
 *
 * Used primarily inside search inputs to visually indicate an action requirement.
 */
export const KbdHint: React.FC<KbdHintProps> = ({ icon, text, top, right, transform }) => {
  return (
    <div className="search-kbd-hint-wrapper" style={{ right, top, transform }} aria-hidden="true">
      <kbd className="search-kbd-hint">
        <span className="search-kbd-hint-icon">{icon}</span> {text}
      </kbd>
    </div>
  );
};
